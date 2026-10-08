import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as EnviarReal from "@/lib/email/conta-e-cobranca/enviar";
import type * as CartaoReal from "@/lib/email/conta-e-cobranca/renovacao-no-cartao";

/**
 * A rota do envio dos e-mails de conta e de cobrança (esvazia a fila `billing_emails_enviados`): mesmo contrato
 * dos crons irmãos. Sem segredo, 403 e nada roda; com segredo, devolve o resumo; pendência (nova tentativa ou
 * falha definitiva) sai como warn; erro devolve frase fixa, com o texto do banco só no log. O orçamento interno
 * de 40 s para o teto de 55 s do curl está provado no teste do envio e na agenda (cron-routes-scheduled).
 */
const SEGREDO = "segredo-do-envio";

const enviarFila = vi.fn();
const info = vi.fn();
const warn = vi.fn();
const error = vi.fn();

vi.mock("@/lib/env", () => ({
  env: { INTERNAL_CRON_SECRET: "segredo-do-envio", INTERNAL_SECRET: "" },
}));
vi.mock("@/lib/logger", () => ({
  logger: {
    info: (...a: unknown[]) => info(...a),
    warn: (...a: unknown[]) => warn(...a),
    error: (...a: unknown[]) => error(...a),
    debug: vi.fn(),
  },
}));
vi.mock("@/lib/email/conta-e-cobranca/enviar", () => ({
  enviarFilaDeEmails: (...a: unknown[]) => enviarFila(...a),
}));

import { GET, POST } from "@/app/api/v1/cron/enviar-emails-de-conta/route";

const LIMPO = {
  reservados: 3,
  enviados: 3,
  repetir: 0,
  falhados: 0,
  semDestinatario: 0,
  devolvidos: 0,
  naoConfigurado: false,
};

const chamar = (segredo = SEGREDO, metodo: typeof GET = GET) =>
  metodo(
    new NextRequest("http://local/api/v1/cron/enviar-emails-de-conta", {
      headers: segredo ? { authorization: `Bearer ${segredo}` } : {},
    }),
  );

beforeEach(() => {
  enviarFila.mockReset();
  info.mockReset();
  warn.mockReset();
  error.mockReset();
});

describe("GET/POST /api/v1/cron/enviar-emails-de-conta", () => {
  it("sem o segredo: 403 e a fila nem é tocada", async () => {
    expect((await chamar("")).status).toBe(403);
    expect(enviarFila).not.toHaveBeenCalled();
  });

  it("segredo errado: 403", async () => {
    expect((await chamar("outro")).status).toBe(403);
    expect(enviarFila).not.toHaveBeenCalled();
  });

  it("aceita o cabeçalho x-cron-secret, como os demais crons", async () => {
    enviarFila.mockResolvedValue(LIMPO);
    const res = await GET(
      new NextRequest("http://local/api/v1/cron/enviar-emails-de-conta", { headers: { "x-cron-secret": SEGREDO } }),
    );
    expect(res.status).toBe(200);
  });

  it("rodada que enviou: 200 com o resumo, log info e sem warn (GET e POST)", async () => {
    enviarFila.mockResolvedValue(LIMPO);
    for (const metodo of [GET, POST]) {
      const res = await chamar(SEGREDO, metodo);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { data: typeof LIMPO }).data).toEqual(LIMPO);
    }
    expect(info).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalled();
  });

  it("rodada vazia: 200 e nenhum log (a cada minuto, o silêncio é o normal)", async () => {
    enviarFila.mockResolvedValue({ ...LIMPO, reservados: 0, enviados: 0 });
    const res = await chamar();
    expect(res.status).toBe(200);
    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("e-mail que voltou à fila ou falhou de vez: sai como warn, com o resumo", async () => {
    enviarFila.mockResolvedValue({ ...LIMPO, enviados: 1, repetir: 1, falhados: 1 });
    const res = await chamar();
    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toMatchObject({ repetir: 1, falhados: 1 });
  });

  it("erro: frase fixa na resposta, texto do banco só no log", async () => {
    enviarFila.mockRejectedValue(new Error("fn_billing_emails_reservar_lote: permission denied for table x"));
    const res = await chamar();
    expect(res.status).toBe(500);
    const corpo = JSON.stringify(await res.json());
    expect(corpo).not.toContain("billing_emails");
    expect(corpo).not.toContain("permission denied");
    expect(corpo).toContain("Falha ao enviar os e-mails de conta.");
    expect(error.mock.calls[0]?.[1]).toMatchObject({ error: expect.stringContaining("fn_billing_emails_reservar_lote") });
  });
});

describe("a agenda no scheduler", () => {
  const entrypoint = readFileSync(join(__dirname, "..", "..", "docker", "scheduler", "entrypoint.sh"), "utf8");

  it("roda a cada minuto, com teto do curl maior que o orçamento interno da rodada", async () => {
    const linha = entrypoint.match(/^\* \* \* \* \*\|(\d+)\|api\/v1\/cron\/enviar-emails-de-conta$/m);
    expect(linha, "linha do cron no entrypoint").not.toBeNull();
    const tetoDoCurlMs = Number(linha![1]) * 1000;
    const real = await vi.importActual<typeof EnviarReal>(
      "@/lib/email/conta-e-cobranca/enviar",
    );
    expect(real.ORCAMENTO_DA_RODADA_MS).toBe(40_000);
    expect(tetoDoCurlMs).toBe(55_000);
    expect(real.ORCAMENTO_DA_RODADA_MS).toBeLessThan(tetoDoCurlMs);
    expect(real.TAMANHO_DO_LOTE).toBe(20);
  });

  it("o aviso de renovação no cartão tem orçamento interno menor que o teto do curl da própria linha", async () => {
    const linha = entrypoint.match(/^5 11 \* \* \*\|(\d+)\|api\/v1\/cron\/avisar-renovacao-no-cartao$/m);
    expect(linha).not.toBeNull();
    const real = await vi.importActual<typeof CartaoReal>(
      "@/lib/email/conta-e-cobranca/renovacao-no-cartao",
    );
    expect(real.ORCAMENTO_DA_RODADA_MS).toBeLessThan(Number(linha![1]) * 1000);
  });
});
