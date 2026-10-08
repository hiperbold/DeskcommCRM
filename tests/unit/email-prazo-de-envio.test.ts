// @vitest-environment node
import { createServer as createHttp, type Server as HttpServer } from "node:http";
import { createServer, type Server, type Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SmtpConfig } from "@/lib/email/config";
import type * as PrazoReal from "@/lib/email/prazo";

/**
 * Os prazos de qualquer envio de e-mail. Servidor que não atende (não cumprimenta, ou cala no meio) falha dentro
 * do prazo; servidor que atendeu e só está LENTO não vira falha (o prazo de silêncio do socket é longo, 60 s no
 * produto), porque a nova tentativa mandaria o mesmo e-mail em dobro. Aqui os prazos são encurtados (300 ms para
 * conectar/cumprimentar e para a Resend, 900 ms de silêncio) e o Nodemailer e o SDK da Resend são os REAIS,
 * falando com servidores locais. A falha por prazo vira `send_failed`, como as outras. Os valores de produção
 * (10 s, 60 s e 30 s) são conferidos no primeiro bloco.
 */

const estado = vi.hoisted(() => ({
  env: { NEXT_PUBLIC_APP_URL: "https://crm.example.com" },
  config: {} as SmtpConfig,
}));
vi.mock("@/lib/env", () => ({ env: estado.env }));
vi.mock("@/lib/email/config", () => ({ getSmtpConfig: async () => estado.config }));
vi.mock("@/lib/email/prazo", () => ({
  PRAZO_DE_CONEXAO_SMTP_MS: 300,
  PRAZO_DE_SILENCIO_SMTP_MS: 900,
  PRAZO_DO_ENVIO_RESEND_MS: 300,
}));
vi.mock("@/lib/instalacao/config", () => ({
  valorDaInstalacao: async (chave: string) => ({
    valor: chave === "RESEND_API_KEY" ? "re_chave_valida_de_teste" : "nao-responda@exemplo.com.br",
    fonte: "env",
  }),
}));

const mensagem = { to: "pessoa@example.net", subject: "Teste de prazo", html: "<p>oi</p>" };
const LIMITE_DO_TESTE_MS = 3000;

describe("os prazos de produção", () => {
  it("conexão e saudação em 10 s, silêncio do socket em 60 s, Resend em 30 s", async () => {
    const real = await vi.importActual<typeof PrazoReal>("@/lib/email/prazo");
    expect(real.PRAZO_DE_CONEXAO_SMTP_MS).toBe(10_000);
    expect(real.PRAZO_DE_SILENCIO_SMTP_MS).toBe(60_000);
    expect(real.PRAZO_DO_ENVIO_RESEND_MS).toBe(30_000);
    // servidor lento que já aceitou não pode virar falha antes de o curto prazo de conexão
    expect(real.PRAZO_DE_SILENCIO_SMTP_MS).toBeGreaterThan(real.PRAZO_DE_CONEXAO_SMTP_MS);
  });
});

describe("SMTP com prazo", () => {
  let servidor: Server;
  let sockets: Set<Socket>;

  async function subir(comportamento: (socket: Socket) => void) {
    sockets = new Set();
    servidor = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => undefined);
      comportamento(socket);
    });
    await new Promise<void>((resolve) => servidor.listen(0, "127.0.0.1", resolve));
    const porta = (servidor.address() as { port: number }).port;
    estado.config = {
      host: "127.0.0.1",
      port: porta,
      security: "none",
      username: "",
      password: "",
      fromEmail: "convites@example.com",
      fromName: "CRM de teste",
      source: "database",
    };
  }

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => servidor.close(() => resolve()));
  });

  it("servidor que aceita a conexão e nunca cumprimenta: send_failed dentro do prazo (não rate_limited)", async () => {
    await subir(() => {
      /* mudo */
    });
    const { sendEmail } = await import("@/lib/email/smtp");
    const t0 = Date.now();
    const r = await sendEmail(mensagem);
    expect(Date.now() - t0).toBeLessThan(LIMITE_DO_TESTE_MS);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("send_failed");
  });

  it("servidor que cumprimenta e depois fica em silêncio no meio da conversa: send_failed dentro do prazo", async () => {
    await subir((socket) => {
      socket.setEncoding("utf8");
      socket.write("220 smtp.example.test ESMTP\r\n");
      socket.on("data", (chunk: string) => {
        if (/^(EHLO|HELO) /m.test(chunk)) socket.write("250 smtp.example.test\r\n");
        // MAIL FROM e adiante: sem resposta
      });
    });
    const { sendEmail } = await import("@/lib/email/smtp");
    const t0 = Date.now();
    const r = await sendEmail(mensagem);
    expect(Date.now() - t0).toBeLessThan(LIMITE_DO_TESTE_MS);
    expect(r).toMatchObject({ ok: false, error: "send_failed" });
  });

  it("servidor LENTO que responde dentro do prazo de silêncio entrega: a conversa toda passa do prazo de conexão e não vira falha", async () => {
    // Cada resposta demora 250 ms: menos que o silêncio tolerado (900 ms), mas a conversa de 5 respostas passa
    // bem do prazo de conexão (300 ms). Com o `socketTimeout` igual ao prazo curto, isto falharia.
    const ATRASO_MS = 250;
    const recebidas: string[] = [];
    await subir((socket) => {
      socket.setEncoding("utf8");
      let emDados = false;
      let corpo = "";
      const responder = (texto: string) => setTimeout(() => socket.write(texto), ATRASO_MS);
      socket.write("220 smtp.example.test ESMTP\r\n");
      socket.on("data", (chunk: string) => {
        if (emDados) {
          corpo += chunk;
          if (corpo.includes("\r\n.\r\n")) {
            emDados = false;
            recebidas.push("mensagem");
            responder("250 2.0.0 aceito\r\n");
          }
          return;
        }
        for (const linha of chunk.split("\r\n").filter(Boolean)) {
          if (/^(EHLO|HELO) /i.test(linha)) responder("250 smtp.example.test\r\n");
          else if (/^MAIL FROM/i.test(linha)) responder("250 2.1.0 ok\r\n");
          else if (/^RCPT TO/i.test(linha)) responder("250 2.1.5 ok\r\n");
          else if (/^DATA/i.test(linha)) {
            emDados = true;
            responder("354 pode enviar\r\n");
          } else if (/^QUIT/i.test(linha)) responder("221 tchau\r\n");
        }
      });
    });
    const { sendEmail } = await import("@/lib/email/smtp");
    const t0 = Date.now();
    const r = await sendEmail(mensagem);
    const levou = Date.now() - t0;
    expect(r.ok).toBe(true);
    expect(recebidas).toEqual(["mensagem"]);
    // 5 respostas de 250 ms: a conversa inteira levou bem mais que o prazo de conexão (300 ms)
    expect(levou).toBeGreaterThan(1000);
  });
});

describe("Resend com prazo", () => {
  let servidor: HttpServer;
  let sockets: Set<Socket>;
  const ORIGINAL = process.env.RESEND_BASE_URL;

  beforeEach(async () => {
    vi.resetModules();
    sockets = new Set();
    servidor = createHttp(() => {
      /* recebe a requisição e nunca responde */
    });
    servidor.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => undefined);
    });
    await new Promise<void>((resolve) => servidor.listen(0, "127.0.0.1", resolve));
    process.env.RESEND_BASE_URL = `http://127.0.0.1:${(servidor.address() as { port: number }).port}`;
  });

  afterEach(async () => {
    if (ORIGINAL === undefined) delete process.env.RESEND_BASE_URL;
    else process.env.RESEND_BASE_URL = ORIGINAL;
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => servidor.close(() => resolve()));
  });

  it("API que recebe e não responde: send_failed dentro do prazo, sem lançar", async () => {
    const { sendEmail } = await import("@/lib/email/resend");
    const t0 = Date.now();
    const r = await sendEmail(mensagem);
    expect(Date.now() - t0).toBeLessThan(LIMITE_DO_TESTE_MS);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("send_failed");
  });
});
