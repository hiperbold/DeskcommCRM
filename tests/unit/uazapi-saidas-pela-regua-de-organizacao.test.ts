import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as Credenciais from "@/lib/channels/uazapi/credentials";

/**
 * D-083, achados 2 e 4: toda saída do processo para um endereço que a
 * ORGANIZAÇÃO escolheu (o servidor da conexão UAZAPI e os links de mídia que ele
 * devolve) passa pela régua de destino de organização a cada requisição, sem
 * seguir redirect.
 *
 *   - achado 2: baixar a mídia de um link público que responde 302 para o
 *     interno transformava a rede interna em mídia visível para a organização;
 *   - achado 4: `channel_sessions.uazapi_base_url` era conferido só no cadastro,
 *     e as funções `chamar` mandavam o TOKEN da instância ao endereço gravado,
 *     seguindo redirect.
 *
 * Diferente de `channel-adapter-uazapi.test.ts` e `canal-uazapi-conexao.test.ts`
 * (que trocam o guarda por um no-op para provar o transporte), aqui a régua
 * roda DE VERDADE. Só o DNS e a rede são simulados.
 */

const fetchCalls: { url: string; init: RequestInit | undefined }[] = [];
let respostas: Record<string, () => Response> = {};
const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  fetchCalls.push({ url, init });
  const resposta = respostas[url];
  if (!resposta) throw new Error(`rede: ninguém atende ${url}`);
  return resposta();
});
vi.stubGlobal("fetch", fetchMock);

const DNS: Record<string, string[]> = {
  "empresa.uazapi.com": ["93.184.216.34"],
  "cdn.publico.exemplo": ["93.184.216.35"],
  "rebinding.exemplo": ["10.0.0.5"],
};
vi.mock("node:dns/promises", () => {
  const lookup = async (host: string) => {
    const enderecos = DNS[host];
    if (!enderecos) throw new Error("ENOTFOUND");
    return enderecos.map((address) => ({ address, family: 4 }));
  };
  // O default é obrigatório: sem ele o vitest recusa o mock na coleta.
  return { lookup, default: { lookup } };
});

vi.mock("@/lib/env", () => ({ env: { IA_DESTINOS_INTERNOS_PERMITIDOS: "" } }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/ai/elegibilidade/pre-go-live", () => ({ metadataInicialDoCanal: () => ({}) }));

const credsRef: { current: unknown } = { current: null };
vi.mock("@/lib/channels/uazapi/credentials", async (original) => ({
  ...(await original<typeof Credenciais>()),
  resolveUazapiCreds: async () => credsRef.current,
}));

import { uazapiAdapter } from "@/lib/channels/adapters/uazapi";
import { MAX_MEDIA_BYTES, MediaTooLargeError } from "@/lib/messaging/media/types";
import {
  registrarWebhookUazapi,
  removerWebhookUazapi,
  validarInstanciaUazapi,
} from "@/lib/channels/uazapi/conexao";

const ORG = "00000000-0000-4000-8000-000000000261";
const INSTANCIA = "r1a2b3c4";
const PUBLICO = "https://empresa.uazapi.com";
const NUVEM = "https://169.254.169.254/latest/meta-data/";
const escopo = { organizationId: ORG, sessionRef: INSTANCIA };

const credsCom = (baseUrl: string) => ({ instanceId: INSTANCIA, baseUrl, token: "tok_instancia" });
const json = (status: number, corpo: unknown) =>
  new Response(JSON.stringify(corpo), { status, headers: { "content-type": "application/json" } });
const redireciona = (para: string) => new Response(null, { status: 302, headers: { location: para } });

beforeEach(() => {
  fetchCalls.length = 0;
  respostas = {};
  credsRef.current = credsCom(PUBLICO);
});

describe("achado 2: download de mídia do link que o servidor devolveu", () => {
  it("link público que responde 302 para o interno: recusado, sai uma vez e não segue", async () => {
    const link = "https://cdn.publico.exemplo/arquivo.ogg";
    respostas[link] = () => redireciona(NUVEM);
    respostas[NUVEM] = () => new Response("segredo-interno", { status: 200 });

    await expect(
      uazapiAdapter.fetchInboundMedia!({ ...escopo, url: link, hintMime: "audio/ogg" }),
    ).rejects.toThrow(/unsafe_url:redirect_not_followed/);

    expect(fetchCalls.map((c) => c.url)).toEqual([link]);
    expect(fetchCalls[0]?.init?.redirect).toBe("manual");
  });

  it("link direto para o interno (metadata de nuvem, IP privado, rebinding): nada sai", async () => {
    for (const link of [NUVEM, "https://10.0.0.7:8000/x", "https://rebinding.exemplo/x"]) {
      respostas[link] = () => new Response("segredo-interno", { status: 200 });
      await expect(uazapiAdapter.fetchInboundMedia!({ ...escopo, url: link })).rejects.toThrow(/unsafe_url:/);
    }
    expect(fetchCalls).toEqual([]);
  });

  it("pela referência da mensagem: o link devolvido pelo servidor também passa pela régua", async () => {
    respostas[`${PUBLICO}/message/download`] = () => json(200, { fileURL: NUVEM, mimetype: "audio/ogg" });
    respostas[NUVEM] = () => new Response("segredo-interno", { status: 200 });

    await expect(
      uazapiAdapter.fetchInboundMedia!({ ...escopo, url: "uazapi-mensagem:3EB0MIDIA" }),
    ).rejects.toThrow(/unsafe_url:private_host/);

    expect(fetchCalls.map((c) => c.url)).toEqual([`${PUBLICO}/message/download`]);
  });

  it("controle positivo: link público que responde 200 baixa a mídia", async () => {
    const link = "https://cdn.publico.exemplo/arquivo.ogg";
    respostas[link] = () =>
      new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "audio/ogg; codecs=opus" } });

    const midia = await uazapiAdapter.fetchInboundMedia!({ ...escopo, url: link });

    expect(midia.mime).toBe("audio/ogg");
    expect(midia.buffer.byteLength).toBe(3);
    expect(fetchCalls).toHaveLength(1);
  });
});

describe("D-084 (M4): o download da mídia tem teto de bytes", () => {
  const LINK = "https://cdn.publico.exemplo/enorme.bin";
  const UM_MB = 1024 * 1024;

  /** Um corpo que nunca acaba: 1 MB por puxada, e conta quantas vezes foi puxado. */
  function fluxoSemFim() {
    const contagem = { puxadas: 0, cancelado: false };
    const bloco = new Uint8Array(UM_MB);
    const corpo = new ReadableStream<Uint8Array>({
      pull(controle) {
        contagem.puxadas += 1;
        controle.enqueue(bloco);
      },
      cancel() {
        contagem.cancelado = true;
      },
    });
    return { contagem, corpo };
  }

  it("fluxo sem fim e sem content-length: falha a mídia, para de ler no teto e cancela o fluxo", async () => {
    const { contagem, corpo } = fluxoSemFim();
    respostas[LINK] = () => new Response(corpo, { status: 200, headers: { "content-type": "video/mp4" } });

    await expect(uazapiAdapter.fetchInboundMedia!({ ...escopo, url: LINK })).rejects.toBeInstanceOf(
      MediaTooLargeError,
    );

    // 50 MB de teto: bastam ~51 puxadas de 1 MB (mais a folga da fila interna). Sem teto,
    // este teste nunca terminaria; um limite frouxo demais também o reprovaria.
    expect(contagem.puxadas).toBeGreaterThan(MAX_MEDIA_BYTES / UM_MB - 1);
    expect(contagem.puxadas).toBeLessThan(MAX_MEDIA_BYTES / UM_MB + 10);
    expect(contagem.cancelado, "o fluxo ficou aberto depois de estourar o teto").toBe(true);
  });

  it("content-length declarado acima do teto: falha sem ler o corpo", async () => {
    const { contagem, corpo } = fluxoSemFim();
    respostas[LINK] = () =>
      new Response(corpo, {
        status: 200,
        headers: { "content-length": String(MAX_MEDIA_BYTES + 1), "content-type": "video/mp4" },
      });

    await expect(uazapiAdapter.fetchInboundMedia!({ ...escopo, url: LINK })).rejects.toBeInstanceOf(
      MediaTooLargeError,
    );
    expect(contagem.puxadas, "leu o corpo de uma resposta que já se declarou grande demais").toBeLessThanOrEqual(1);
  });

  it("controle positivo: mídia dentro do teto continua sendo baixada inteira, em pedaços", async () => {
    const pedaco = new Uint8Array(UM_MB).fill(7);
    const corpo = new ReadableStream<Uint8Array>({
      start(controle) {
        for (let i = 0; i < 3; i += 1) controle.enqueue(pedaco);
        controle.close();
      },
    });
    respostas[LINK] = () => new Response(corpo, { status: 200, headers: { "content-type": "video/mp4" } });

    const midia = await uazapiAdapter.fetchInboundMedia!({ ...escopo, url: LINK, hintMime: "video/mp4" });

    expect(midia.buffer.byteLength).toBe(3 * UM_MB);
    expect(midia.mime).toBe("video/mp4");
  });
});

describe("achado 4: o servidor da conexão (uazapi_base_url) no adapter", () => {
  it.each([
    ["metadata de nuvem", "https://169.254.169.254"],
    ["IP privado", "https://10.0.0.7:8080"],
    ["localhost", "https://localhost:3000"],
    ["nome público que resolve para IP interno", "https://rebinding.exemplo"],
  ])("send com base_url em %s: o token NÃO sai", async (_nome, base) => {
    credsRef.current = credsCom(base);
    respostas[`${base}/send/text`] = () => json(200, { messageid: "x" });

    await expect(
      uazapiAdapter.send({ ...escopo, to: "553591485627", kind: "text", body: "oi" } as never),
    ).rejects.toThrow(/unsafe_url:/);

    expect(fetchCalls).toEqual([]);
  });

  it("send com servidor público que responde 302: recusa, não segue e não manda o token adiante", async () => {
    respostas[`${PUBLICO}/send/text`] = () => redireciona(`${NUVEM}send/text`);
    respostas[`${NUVEM}send/text`] = () => json(200, { messageid: "x" });

    await expect(
      uazapiAdapter.send({ ...escopo, to: "553591485627", kind: "text", body: "oi" } as never),
    ).rejects.toThrow(/unsafe_url:redirect_not_followed/);

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toBe(`${PUBLICO}/send/text`);
    expect(fetchCalls[0]?.init?.redirect).toBe("manual");
  });

  it("base_url em http (sem TLS), mesmo público: o token não sai em claro", async () => {
    credsRef.current = credsCom("http://empresa.uazapi.com");
    respostas["http://empresa.uazapi.com/send/text"] = () => json(200, { messageid: "x" });

    await expect(
      uazapiAdapter.send({ ...escopo, to: "553591485627", kind: "text", body: "oi" } as never),
    ).rejects.toThrow(/unsafe_url:https_required/);

    expect(fetchCalls).toEqual([]);
  });

  it("checkHealth e foto de perfil com base_url interno: nada sai", async () => {
    credsRef.current = credsCom("https://169.254.169.254");

    const saude = await uazapiAdapter.checkHealth!(escopo);
    expect(saude).toMatchObject({ reachable: false, status: null });

    await expect(
      uazapiAdapter.fetchProfilePictureUrl!({ ...escopo, recipient: "553591485627" }),
    ).rejects.toThrow(/unsafe_url:/);

    expect(fetchCalls).toEqual([]);
  });

  it("controle positivo: servidor público recebe o token e responde", async () => {
    respostas[`${PUBLICO}/send/text`] = () => json(200, { messageid: "3EB0OK" });

    const r = await uazapiAdapter.send({ ...escopo, to: "553591485627", kind: "text", body: "oi" } as never);

    expect(r.externalId).toBe("3EB0OK");
    expect(fetchCalls).toHaveLength(1);
    expect((fetchCalls[0]?.init?.headers as Record<string, string>).token).toBe("tok_instancia");
  });
});

describe("achado 4: o servidor da conexão em conexao.ts", () => {
  it("registrar e remover webhook com base_url interno: nada sai, com o token", async () => {
    const registro = await registrarWebhookUazapi({
      baseUrl: "https://169.254.169.254",
      token: "tok",
      url: "https://crm.exemplo.com.br/api/v1/webhooks/channel/abc",
    });
    expect(registro.ok).toBe(false);

    const removido = await removerWebhookUazapi({ baseUrl: "https://10.0.0.7:8080", token: "tok", webhookId: "w1" });
    expect(removido).toBe(false);

    expect(fetchCalls).toEqual([]);
  });

  it("registrar webhook em servidor público que responde 302: não segue e falha sem ecoar a causa", async () => {
    respostas[`${PUBLICO}/webhook`] = () => redireciona(`${NUVEM}webhook`);
    respostas[`${NUVEM}webhook`] = () => json(200, []);

    const r = await registrarWebhookUazapi({
      baseUrl: PUBLICO,
      token: "tok",
      url: "https://crm.exemplo.com.br/api/v1/webhooks/channel/abc",
    });

    expect(r).toEqual({ ok: false, reason: "Não foi possível registrar o webhook no servidor." });
    expect(fetchCalls.map((c) => c.url)).toEqual([`${PUBLICO}/webhook`]);
  });

  it("validar com destino interno: recusa antes de sair, com mensagem fixa (sem IP nem status)", async () => {
    for (const servidor of ["169.254.169.254", "https://10.0.0.7:8080", "https://rebinding.exemplo"]) {
      const v = await validarInstanciaUazapi({ servidor, token: "tok" });
      expect(v).toEqual({ ok: false, reason: "Este endereço de servidor não é permitido." });
    }
    expect(fetchCalls).toEqual([]);
  });

  it("validar com http (sem TLS): recusa antes de sair, com a mesma mensagem fixa", async () => {
    const v = await validarInstanciaUazapi({ servidor: "http://empresa.uazapi.com", token: "tok" });
    expect(v).toEqual({ ok: false, reason: "Este endereço de servidor não é permitido." });
    expect(fetchCalls).toEqual([]);
  });

  it("validar com servidor público que redireciona para o interno: não sonda o destino nem devolve status", async () => {
    respostas[`${PUBLICO}/instance/status`] = () => redireciona(`${NUVEM}`);
    respostas[NUVEM] = () => json(200, { instance: { id: "x" } });

    const v = await validarInstanciaUazapi({ servidor: PUBLICO, token: "tok" });

    expect(v).toEqual({
      ok: false,
      reason: "Não foi possível falar com o servidor. Confira o endereço e tente de novo.",
    });
    expect(fetchCalls.map((c) => c.url)).toEqual([`${PUBLICO}/instance/status`]);
  });

  it("controle positivo: servidor público válido conecta", async () => {
    respostas[`${PUBLICO}/instance/status`] = () =>
      json(200, { instance: { id: "r1a2b3c4", name: "comercial", owner: "553591485627", status: "connected" } });

    const v = await validarInstanciaUazapi({ servidor: PUBLICO, token: "tok" });

    expect(v).toMatchObject({ ok: true, baseUrl: PUBLICO, instanceId: "r1a2b3c4", status: "WORKING" });
  });
});
