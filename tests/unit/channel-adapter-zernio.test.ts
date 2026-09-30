import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Adapter do canal intermediado — o transporte.
 *
 * O contrato aqui não foi lido da doc: foi MEDIDO contra a API real antes de o
 * adapter existir. As formas abaixo são as respostas que ela devolveu:
 *
 *   POST /v1/inbox/conversations              → 201 { success, data:{ messageId, conversationId } }
 *   POST /v1/inbox/conversations/{id}/messages → 200 { success, data:{ messageId, conversationId } }
 *
 * O `messageId` é um **wamid da Meta**, não um id do intermediário — mesmo
 * espaço de identificador do canal oficial, então o eco do webhook casa direto.
 *
 * O que se prova: que o adapter endereça pela THREAD e não pelo telefone (a
 * diferença que morde quem copia o adapter do canal oficial), que falha alto
 * quando não há thread, e que continua sendo só um tradutor de formato.
 */

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));

// A régua de destino da organização resolve o nome antes de julgar; aqui só o DNS
// é simulado (e o `env`, que o guarda lê para a lista de destinos da instalação).
const DNS: Record<string, string[]> = {
  "zernio.com": ["93.184.216.34"],
  "cdn.exemplo": ["93.184.216.35"],
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

const credsRef: { current: unknown } = { current: null };
vi.mock("@/lib/channels/zernio/credentials", () => ({
  resolveZernioCreds: async () => credsRef.current,
  zernioCredsFromEnv: () => credsRef.current,
}));

import { zernioAdapter } from "@/lib/channels/adapters/zernio";
import { MAX_MEDIA_BYTES, MediaTooLargeError } from "@/lib/messaging/media/types";

const CREDS = {
  accountId: "6a3572a15f7d1751ab117832",
  apiKey: "sk_test",
  baseUrl: "https://zernio.com/api",
  source: "session" as const,
};
const WAMID = "wamid.HBgMNTk1OTkxNzMzNjg1FQIAERgSNDBFOTkzMUMxMEY4RjVERDZFAA==";
const THREAD = "6a3580f68fcd5b3a5b946bf8";

/**
 * A organização atravessa o seam de canal desde a issue #236: `sessionRef` é
 * identificador do PROVIDER e não identifica linha sozinho.
 */
const ORG = "00000000-0000-4000-8000-000000000236";

function respondeOk(status = 200) {
  fetchMock.mockResolvedValueOnce({
    ok: true,
    status,
    json: async () => ({ success: true, data: { messageId: WAMID, conversationId: THREAD } }),
  });
}

const ultimaChamada = () => ({
  url: String(fetchMock.mock.calls.at(-1)?.[0] ?? ""),
  init: (fetchMock.mock.calls.at(-1)?.[1] ?? {}) as { headers?: Record<string, string>; body?: string },
});
const corpo = () => JSON.parse(ultimaChamada().init.body ?? "{}") as Record<string, unknown>;

beforeEach(() => {
  fetchMock.mockReset();
  credsRef.current = CREDS;
});

describe("resolveRecipient", () => {
  it("devolve o telefone em dígitos — é o participantId da API", () => {
    expect(
      zernioAdapter.resolveRecipient({
        isGroup: false,
        groupChatId: null,
        phoneNumber: "+595 (99) 173-3685",
        waIdentity: null,
      }),
    ).toBe("595991733685");
  });

  it("prefere o wa_identity de telefone quando existe", () => {
    expect(
      zernioAdapter.resolveRecipient({
        isGroup: false,
        groupChatId: null,
        phoneNumber: "000",
        waIdentity: "phone:+595991733685",
      }),
    ).toBe("595991733685");
  });

  it("grupo devolve null — a API de grupos é outro recurso, com id próprio", () => {
    expect(
      zernioAdapter.resolveRecipient({
        isGroup: true,
        groupChatId: "123@g.us",
        phoneNumber: null,
        waIdentity: null,
      }),
    ).toBeNull();
  });

  it("sem telefone devolve o id OPACO — dizer null é afirmar que não dá para falar com quem acabou de escrever", () => {
    // Medido em produção: contato do rollout novo (BSUID, sem telefone) fazia o
    // envio parar em `missing_phone_number`. Para este canal o telefone não
    // endereça nada — quem endereça é a thread.
    expect(
      zernioAdapter.resolveRecipient({
        isGroup: false,
        groupChatId: null,
        phoneNumber: null,
        waIdentity: "lid:PY.853283837822954",
      }),
    ).toBe("PY.853283837822954");
  });

  it("sem telefone E sem identidade devolve null — aí sim não há destinatário", () => {
    expect(
      zernioAdapter.resolveRecipient({
        isGroup: false,
        groupChatId: null,
        phoneNumber: null,
        waIdentity: null,
      }),
    ).toBeNull();
  });
});

describe("send — endereça pela THREAD, não pelo telefone", () => {
  it("põe a thread na URL e o accountId no corpo", async () => {
    respondeOk(200);
    await zernioAdapter.send({
      organizationId: ORG,
      sessionRef: CREDS.accountId,
      to: "595991733685",
      providerConversationId: THREAD,
      kind: "text",
      body: "olá",
    });

    expect(ultimaChamada().url).toBe(
      `https://zernio.com/api/v1/inbox/conversations/${THREAD}/messages`,
    );
    expect(corpo()).toMatchObject({ accountId: CREDS.accountId, message: "olá" });
    // O telefone NÃO endereça este envio — se aparecer na URL, alguém copiou o
    // adapter do canal oficial sem ler a diferença.
    expect(ultimaChamada().url).not.toContain("595991733685");
  });

  it("autentica com Bearer", async () => {
    respondeOk();
    await zernioAdapter.send({
      organizationId: ORG,
      sessionRef: CREDS.accountId,
      to: "595991733685",
      providerConversationId: THREAD,
      kind: "text",
      body: "x",
    });
    expect(ultimaChamada().init.headers?.Authorization).toBe("Bearer sk_test");
  });

  it("devolve o wamid como externalId", async () => {
    respondeOk();
    const r = await zernioAdapter.send({
      organizationId: ORG,
      sessionRef: CREDS.accountId,
      to: "5959",
      providerConversationId: THREAD,
      kind: "text",
      body: "x",
    });
    expect(r.externalId).toBe(WAMID);
  });

  it("aceita 201 tanto quanto 200 — abrir conversa e responder devolvem códigos diferentes", async () => {
    respondeOk(201);
    const r = await zernioAdapter.send({
      organizationId: ORG,
      sessionRef: CREDS.accountId,
      to: "5959",
      providerConversationId: THREAD,
      kind: "text",
      body: "x",
    });
    expect(r.externalId).toBe(WAMID);
  });

  it("SEM thread lança com motivo nomeado, em vez de montar URL com undefined", async () => {
    await expect(
      zernioAdapter.send({
        organizationId: ORG,
        sessionRef: CREDS.accountId,
        to: "595991733685",
        kind: "text",
        body: "x",
      }),
    ).rejects.toThrow(/zernio_no_conversation/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sem credencial LANÇA — um `sent` sem id diria enviado para o que nunca saiu", async () => {
    credsRef.current = null;
    await expect(
      zernioAdapter.send({
        organizationId: ORG,
        sessionRef: "x",
        to: "y",
        providerConversationId: THREAD,
        kind: "text",
        body: "z",
      }),
    ).rejects.toThrow(/zernio_not_configured/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("isConfigured é SEMPRE true — a credencial vive na sessão, e isto é síncrono", async () => {
    // Medido em produção: olhar só o env respondia "não configurado" para toda
    // instalação que conectou pela tela, e o handler gravava `queued` sem nunca
    // chamar `send`. A mensagem ficava parada, sem erro, com o canal ligado.
    credsRef.current = null;
    expect(zernioAdapter.isConfigured()).toBe(true);
    credsRef.current = CREDS;
    expect(zernioAdapter.isConfigured()).toBe(true);
  });
});

describe("send — mídia", () => {
  const media = { url: "https://s/x.jpg", mime: "image/jpeg", filename: "x.jpg", caption: "olha" };

  it("imagem vira attachmentType image com a legenda em message", async () => {
    respondeOk();
    await zernioAdapter.send({
      organizationId: ORG,
      sessionRef: CREDS.accountId,
      to: "5959",
      providerConversationId: THREAD,
      kind: "image",
      media,
    });
    expect(corpo()).toMatchObject({
      attachmentType: "image",
      attachmentUrl: media.url,
      attachmentName: "x.jpg",
      message: "olha",
    });
  });

  it("áudio pede voiceNote — sem a flag chega como anexo de música", async () => {
    respondeOk();
    await zernioAdapter.send({
      organizationId: ORG,
      sessionRef: CREDS.accountId,
      to: "5959",
      providerConversationId: THREAD,
      kind: "audio",
      media: { ...media, mime: "audio/ogg", filename: "a.ogg", caption: null },
    });
    expect(corpo()).toMatchObject({ attachmentType: "audio", voiceNote: true });
  });

  it("documento cai em file, não em image", async () => {
    respondeOk();
    await zernioAdapter.send({
      organizationId: ORG,
      sessionRef: CREDS.accountId,
      to: "5959",
      providerConversationId: THREAD,
      kind: "document",
      media: { ...media, mime: "application/pdf", filename: "d.pdf", caption: null },
    });
    expect(corpo().attachmentType).toBe("file");
  });
});

describe("erros", () => {
  it("erro do provider carrega o CODE — é o que distingue fora-da-janela de bloqueado", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      json: async () => ({ error: "24h window closed", code: "PLATFORM_LIMITATION" }),
    });
    await expect(
      zernioAdapter.send({
        organizationId: ORG,
        sessionRef: CREDS.accountId,
        to: "5959",
        providerConversationId: THREAD,
        kind: "text",
        body: "x",
      }),
    ).rejects.toThrow(/PLATFORM_LIMITATION/);
  });

  it("success:false com HTTP 200 também é falha", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ success: false, error: "nope" }),
    });
    await expect(
      zernioAdapter.send({
        organizationId: ORG,
        sessionRef: CREDS.accountId,
        to: "5959",
        providerConversationId: THREAD,
        kind: "text",
        body: "x",
      }),
    ).rejects.toThrow(/zernio_send_failed/);
  });
});

describe("códigos que o handler grava", () => {
  it("nomeiam o canal, para o operador saber qual falhou", () => {
    expect(zernioAdapter.codes).toEqual({
      notConfigured: "zernio_not_configured",
      sendFailed: "zernio_error",
      unknownError: "zernio_unknown",
    });
  });
});

/**
 * A MÍDIA RECEBIDA NÃO PODE LEVAR A CREDENCIAL PARA ONDE O PAYLOAD MANDAR.
 *
 * `fetchInboundMedia` busca o anexo pela URL que veio no payload do webhook, e
 * manda a API key do tenant no `Authorization`. Sem guarda, isso é pior que o
 * SSRF comum: além de fazer o servidor bater num endereço interno
 * (`169.254.169.254` é o metadado de nuvem), ele ENTREGA a credencial ao host
 * que o payload escolheu.
 *
 * O irmão WAHA resolve por construção — `lib/messaging/media/waha-source.ts`
 * descarta host e porta do payload e reconstrói sobre `WAHA_API_BASE_URL`.
 * Aqui não dá para fixar a base (o provedor pode servir mídia de outro host),
 * então vale o par que o repo já usa em `lib/automation/actions/call-webhook.ts`.
 *
 * O que estes casos guardam é COMPORTAMENTO, não a presença do import: o
 * critério é `fetch` NÃO ter sido chamado. Um guard que lance depois do fetch
 * deixaria a credencial sair na mesma e ainda assim "passaria" num teste que
 * só checasse a exceção.
 */
describe("fetchInboundMedia não busca onde o payload mandar", () => {
  const PROIBIDAS = [
    ["metadado de nuvem", "http://169.254.169.254/latest/meta-data/"],
    ["loopback", "http://127.0.0.1:9000/interno"],
    ["localhost por nome", "http://localhost:3000/interno"],
    ["rede privada", "http://10.0.0.5/interno"],
    ["literal IPv6", "http://[::1]:9000/interno"],
    ["esquema que não é http(s)", "file:///etc/passwd"],
  ] as const;

  for (const [rotulo, url] of PROIBIDAS) {
    it(`recusa ${rotulo} — e sem chamar fetch`, async () => {
      credsRef.current = CREDS;
      fetchMock.mockClear();
      await expect(
        zernioAdapter.fetchInboundMedia!({ organizationId: ORG, sessionRef: CREDS.accountId, url }),
      ).rejects.toThrow();
      expect(
        fetchMock,
        "a credencial não pode sair: o guard tem de barrar ANTES do fetch",
      ).not.toHaveBeenCalled();
    });
  }

  it("deixa passar uma URL pública do provedor (guarda de vacuidade)", async () => {
    // Sem este caso, um guard que recusasse TUDO deixaria os de cima verdes e
    // quebraria a feature em silêncio.
    credsRef.current = CREDS;
    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      arrayBuffer: async () => new ArrayBuffer(4),
      headers: new Headers({ "content-type": "image/png" }),
    });
    const r = await zernioAdapter.fetchInboundMedia!({
      organizationId: ORG,
      sessionRef: CREDS.accountId,
      url: "https://zernio.com/api/v1/media/abc123",
    });
    expect(r.mime).toBe("image/png");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * D-084 (B2): o download da mídia recebida não segue redirect com a chave, manda
 * a chave só ao host do provedor, exige https e tem teto de bytes.
 *
 * O critério é o que SAIU pelo `fetch` (URL, cabeçalho, quantas vezes), e não a
 * exceção: um redirect seguido com o Bearer já teria entregue a credencial.
 */
describe("fetchInboundMedia: redirect, chave e teto (D-084, B2)", () => {
  const DO_PROVEDOR = "https://zernio.com/api/v1/media/abc123";
  const DE_CDN = "https://cdn.exemplo/arquivo.png";
  const busca = (url: string) => zernioAdapter.fetchInboundMedia!({ organizationId: ORG, sessionRef: CREDS.accountId, url });
  const cabecalhoDaChamada = (i: number) =>
    ((fetchMock.mock.calls[i]?.[1] ?? {}) as { headers?: Record<string, string> }).headers ?? {};

  beforeEach(() => {
    credsRef.current = CREDS;
  });

  it("URL do provedor que responde 302: recusa, sai UMA vez, sem redirect automático e sem seguir o Location", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: "https://169.254.169.254/latest/meta-data/" } }),
    );

    await expect(busca(DO_PROVEDOR)).rejects.toThrow(/unsafe_url:redirect_not_followed/);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(DO_PROVEDOR);
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).redirect).toBe("manual");
  });

  it("URL do provedor: leva o Bearer da chave", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { "content-type": "image/png" } }),
    );

    const r = await busca(DO_PROVEDOR);

    expect(cabecalhoDaChamada(0)).toMatchObject({ Authorization: "Bearer sk_test" });
    expect(r.buffer.byteLength).toBe(4);
    expect(r.mime).toBe("image/png");
  });

  it("URL de OUTRO host (CDN): baixa SEM a chave", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(new Uint8Array([9, 9]), { status: 200, headers: { "content-type": "image/png" } }),
    );

    const r = await busca(DE_CDN);

    expect(r.buffer.byteLength).toBe(2);
    const enviados = JSON.stringify(cabecalhoDaChamada(0));
    expect(enviados).not.toMatch(/sk_test|authorization/i);
  });

  it("host parecido com o do provedor (subdomínio de terceiro, outra porta) não ganha a chave", async () => {
    DNS["zernio.com.atacante.exemplo"] = ["93.184.216.40"];
    fetchMock.mockImplementation(
      async () => new Response(new Uint8Array([1]), { status: 200, headers: { "content-type": "image/png" } }),
    );
    const parecidas = [
      "https://zernio.com.atacante.exemplo/api/v1/media/abc",
      "https://zernio.com:8443/api/v1/media/abc",
    ];
    for (const url of parecidas) await busca(url);

    expect(fetchMock).toHaveBeenCalledTimes(parecidas.length);
    for (let i = 0; i < parecidas.length; i += 1) {
      expect(JSON.stringify(cabecalhoDaChamada(i))).not.toMatch(/sk_test/);
    }
    delete DNS["zernio.com.atacante.exemplo"];
  });

  it("exige https: http de nome público não chega ao fetch (o guarda antigo só exigia em produção)", async () => {
    await expect(busca("http://cdn.exemplo/arquivo.png")).rejects.toThrow(/unsafe_url:https_required/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("nome público que resolve para IP interno: nada sai", async () => {
    DNS["rebinding.exemplo"] = ["10.0.0.5"];
    await expect(busca("https://rebinding.exemplo/x.png")).rejects.toThrow(/unsafe_url:/);
    expect(fetchMock).not.toHaveBeenCalled();
    delete DNS["rebinding.exemplo"];
  });

  it("fluxo sem fim: falha a mídia no teto, sem ler tudo, e cancela o fluxo", async () => {
    const UM_MB = 1024 * 1024;
    const bloco = new Uint8Array(UM_MB);
    let puxadas = 0;
    let cancelado = false;
    const corpo = new ReadableStream<Uint8Array>({
      pull(controle) {
        puxadas += 1;
        controle.enqueue(bloco);
      },
      cancel() {
        cancelado = true;
      },
    });
    fetchMock.mockResolvedValueOnce(new Response(corpo, { status: 200, headers: { "content-type": "video/mp4" } }));

    await expect(busca(DO_PROVEDOR)).rejects.toBeInstanceOf(MediaTooLargeError);

    expect(puxadas).toBeGreaterThan(MAX_MEDIA_BYTES / UM_MB - 1);
    expect(puxadas).toBeLessThan(MAX_MEDIA_BYTES / UM_MB + 10);
    expect(cancelado, "o fluxo ficou aberto depois de estourar o teto").toBe(true);
  });
});
