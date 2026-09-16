import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Adapter da instância UAZAPI — o transporte.
 *
 * O contrato vem da especificação publicada (uazapiGO 2.1.1) e da conexão real
 * da instalação: autenticação pelo header `token`, envio em `/send/text` e
 * `/send/media`, e a resposta do envio é o registro da mensagem, onde o id que
 * casa com o webhook é `messageid` (o `id` é interno do servidor).
 *
 * O que se prova: endereço por telefone, grupo e `@lid`; o corpo certo de cada
 * envio; mídia do NOSSO storage vira base64 e a de outro host passa como veio
 * (o processo não busca URL de terceiros); falha alto sem credencial e quando o
 * servidor recusa; e o mapa de estados da saúde.
 */

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/automation/outbound-url", () => ({ assertSafeOutboundUrl: () => undefined }));
vi.mock("@/lib/automation/outbound-ip", () => ({ assertDestinoResolvidoSeguro: async () => undefined }));

const credsRef: { current: unknown } = { current: null };
vi.mock("@/lib/channels/uazapi/credentials", () => ({
  resolveUazapiCreds: async () => credsRef.current,
}));

import { UAZAPI_REFERENCIA_DE_MIDIA, uazapiAdapter } from "@/lib/channels/adapters/uazapi";

const ORG = "00000000-0000-4000-8000-000000000261";
const INSTANCIA = "r1a2b3c4";
const CREDS = { instanceId: INSTANCIA, baseUrl: "https://empresa.uazapi.com", token: "tok_instancia" };
const STORAGE = "https://abcdefgh.supabase.co";

function resposta(status: number, json: unknown, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: async () => json,
    arrayBuffer: async () => new TextEncoder().encode("bytes-da-midia").buffer,
  };
}

const chamada = (i: number) => ({
  url: String(fetchMock.mock.calls[i]?.[0] ?? ""),
  init: (fetchMock.mock.calls[i]?.[1] ?? {}) as { method?: string; headers?: Record<string, string>; body?: string },
});
const corpoDa = (i: number) => JSON.parse(chamada(i).init.body ?? "{}") as Record<string, unknown>;

const envelope = (extra: Record<string, unknown>) =>
  ({ organizationId: ORG, sessionRef: INSTANCIA, to: "553591485627", kind: "text", body: "oi", ...extra }) as never;

beforeEach(() => {
  fetchMock.mockReset();
  credsRef.current = CREDS;
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", STORAGE);
});

describe("resolveRecipient", () => {
  it("telefone em dígitos, preferindo o wa_identity", () => {
    expect(
      uazapiAdapter.resolveRecipient({ isGroup: false, groupChatId: null, phoneNumber: "000", waIdentity: "phone:+55 35 9148-5627" }),
    ).toBe("553591485627");
    expect(
      uazapiAdapter.resolveRecipient({ isGroup: false, groupChatId: null, phoneNumber: "+55 (35) 9148-5627", waIdentity: null }),
    ).toBe("553591485627");
  });

  it("grupo usa o chatid, e só se for chatid de grupo", () => {
    expect(
      uazapiAdapter.resolveRecipient({ isGroup: true, groupChatId: "120363123456789012@g.us", phoneNumber: null, waIdentity: null }),
    ).toBe("120363123456789012@g.us");
    expect(uazapiAdapter.resolveRecipient({ isGroup: true, groupChatId: "5535@c.us", phoneNumber: null, waIdentity: null })).toBeNull();
  });

  it("sem telefone, endereça pelo @lid em vez de desistir", () => {
    expect(
      uazapiAdapter.resolveRecipient({ isGroup: false, groupChatId: null, phoneNumber: null, waIdentity: "lid:123456789012345" }),
    ).toBe("123456789012345@lid");
    expect(uazapiAdapter.resolveRecipient({ isGroup: false, groupChatId: null, phoneNumber: null, waIdentity: null })).toBeNull();
  });
});

describe("send", () => {
  it("texto vai em /send/text com o token da instância no header", async () => {
    fetchMock.mockResolvedValueOnce(resposta(200, { id: "r0000001", messageid: "3EB0ABC123", response: { status: "success" } }));

    const r = await uazapiAdapter.send(envelope({ replyToExternalId: "3EB0CITADA" }));

    expect(chamada(0).url).toBe("https://empresa.uazapi.com/send/text");
    expect(chamada(0).init.headers?.token).toBe("tok_instancia");
    expect(corpoDa(0)).toEqual({ number: "553591485627", text: "oi", replyid: "3EB0CITADA" });
    // `messageid` e não `id`: é o que o webhook devolve e o que casa o eco.
    expect(r.externalId).toBe("3EB0ABC123");
  });

  it("áudio sai como mensagem de voz e URL de outro host passa como veio", async () => {
    fetchMock.mockResolvedValueOnce(resposta(200, { messageid: "3EB0AUDIO" }));

    await uazapiAdapter.send(
      envelope({ kind: "audio", body: undefined, media: { url: "https://cdn.exemplo.com/a.ogg", mime: "audio/ogg" } }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(chamada(0).url).toBe("https://empresa.uazapi.com/send/media");
    expect(corpoDa(0)).toMatchObject({ type: "ptt", file: "https://cdn.exemplo.com/a.ogg" });
  });

  it("mídia do nosso storage é lida aqui e vai em base64, com o nome do documento", async () => {
    fetchMock
      .mockResolvedValueOnce(resposta(200, null, { "content-type": "application/pdf" }))
      .mockResolvedValueOnce(resposta(200, { messageid: "3EB0DOC" }));

    await uazapiAdapter.send(
      envelope({
        kind: "document",
        body: undefined,
        media: { url: `${STORAGE}/storage/v1/object/sign/x.pdf?token=t`, mime: "application/pdf", filename: "proposta.pdf", caption: "segue" },
      }),
    );

    expect(chamada(0).url.startsWith(STORAGE)).toBe(true);
    expect(corpoDa(1)).toMatchObject({ type: "document", docName: "proposta.pdf", text: "segue" });
    expect(String(corpoDa(1).file)).toMatch(/^data:application\/pdf;base64,/);
  });

  it("sem credencial na sessão LANÇA em vez de fingir que enviou", async () => {
    credsRef.current = null;
    await expect(uazapiAdapter.send(envelope({}))).rejects.toThrow(/uazapi_not_configured/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("recusa do servidor vira erro com o status e o motivo", async () => {
    fetchMock.mockResolvedValueOnce(resposta(401, { error: "invalid token" }));
    await expect(uazapiAdapter.send(envelope({}))).rejects.toThrow(/uazapi_send_failed: 401 invalid token/);
  });

  it("tipo sem tradução falha alto", async () => {
    await expect(uazapiAdapter.send(envelope({ kind: "location" }))).rejects.toThrow(/uazapi_kind_not_supported/);
  });
});

describe("checkHealth", () => {
  const saude = () => uazapiAdapter.checkHealth!({ organizationId: ORG, sessionRef: INSTANCIA });

  it.each([
    ["connected", "WORKING"],
    ["connecting", "SCAN_QR_CODE"],
    ["disconnected", "SCAN_QR_CODE"],
    ["hibernated", "STOPPED"],
  ])("estado %s vira %s", async (estado, esperado) => {
    fetchMock.mockResolvedValueOnce(resposta(200, { instance: { status: estado }, status: { connected: estado === "connected" } }));
    expect((await saude()).status).toBe(esperado);
  });

  it("token recusado é FAILED; rede caída é inalcançável, não queda", async () => {
    fetchMock.mockResolvedValueOnce(resposta(401, { error: "unauthorized" }));
    expect(await saude()).toMatchObject({ reachable: true, status: "FAILED" });

    fetchMock.mockRejectedValueOnce(new Error("ECONNRESET"));
    expect(await saude()).toMatchObject({ reachable: false, status: null });
  });
});

describe("fetchInboundMedia", () => {
  it("referência de mensagem pede o link ao servidor e baixa o arquivo", async () => {
    fetchMock
      .mockResolvedValueOnce(resposta(200, { fileURL: "https://empresa.uazapi.com/files/abc.ogg", mimetype: "audio/ogg" }))
      .mockResolvedValueOnce(resposta(200, null, { "content-type": "audio/ogg; codecs=opus" }));

    const midia = await uazapiAdapter.fetchInboundMedia!({
      organizationId: ORG,
      sessionRef: INSTANCIA,
      url: `${UAZAPI_REFERENCIA_DE_MIDIA}3EB0MIDIA`,
    });

    expect(chamada(0).url).toBe("https://empresa.uazapi.com/message/download");
    expect(corpoDa(0)).toMatchObject({ id: "3EB0MIDIA", return_link: true });
    expect(chamada(1).url).toBe("https://empresa.uazapi.com/files/abc.ogg");
    expect(midia.mime).toBe("audio/ogg");
    expect(midia.buffer.byteLength).toBeGreaterThan(0);
  });
});
