import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Os quatro achados da auditoria de segurança do canal UAZAPI (2026-09-22).
 *
 * ACHADO 1: o corpo cru do webhook traz o token da instância em claro, e
 * `webhook_events_log` era legível por qualquer membro da organização. Aqui
 * se vigia a REDAÇÃO (código) e o PISO de papel na policy nova (banco).
 *
 * ACHADO 2: o portão e o seam aceitavam evento `messages` sem token e evento
 * sem `owner`, porque só recusavam quando o campo VINHA e divergia. Omitir
 * os dois passava direto.
 *
 * ACHADO 3: `inboundPayloadBelongsToSession` devolvia `true` sem olhar nada
 * para a UAZAPI, então um evento de OUTRA instância da mesma organização
 * entrava na conexão errada.
 *
 * ACHADO 4: `verifyInboundWebhookSignature` devolvia `true` para a UAZAPI sem
 * conferir nada. O portão virou decorativo para este canal.
 */

const ingestUazapiMensagem = vi.fn(async () => ({
  status: "ingested",
  conversationId: "conv-1",
  messageId: "msg-1",
}));

vi.mock("@/lib/channels/uazapi/ingest", () => ({
  ingestUazapiMensagem: (...args: unknown[]) => ingestUazapiMensagem(...(args as [])),
}));

import { CHANNEL_PROVIDER_UAZAPI } from "@/lib/channels/capabilities";
import {
  handleInboundWebhook,
  inboundPayloadBelongsToSession,
  verifyInboundWebhookSignature,
  type InboundWebhookInput,
} from "@/lib/channels/inbound";

const TOKEN = "0a1b2c3d-aa11-4b2c-bbbb-a123b4c5d6e7";

/** Corpo do evento `messages`, na forma medida nos webhooks reais. */
function corpoDeMensagem(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    EventType: "messages",
    BaseUrl: "https://empresa.uazapi.com",
    instanceName: "comercial",
    owner: "553599990000",
    token: TOKEN,
    chat: { wa_chatid: "553591234567@s.whatsapp.net", wa_name: "Cliente Teste" },
    message: {
      messageid: "3EB0AAAA1111",
      chatid: "553591234567@s.whatsapp.net",
      isGroup: false,
      fromMe: false,
      wasSentByApi: false,
      messageType: "Conversation",
      messageTimestamp: 1_789_500_000_000,
      senderName: "Maria",
      text: "quero um orçamento",
    },
    ...extra,
  });
}

/** Corpo de um evento que não repete o token (medido: `connection`). */
function corpoDeConexao(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    EventType: "connection",
    BaseUrl: "https://empresa.uazapi.com",
    instanceName: "comercial",
    owner: "553599990000",
    instance: { status: "connected" },
    ...extra,
  });
}

function sessao(extra: Partial<InboundWebhookInput["session"]> = {}): InboundWebhookInput["session"] {
  return {
    id: "sess-1",
    organization_id: "org-1",
    provider: CHANNEL_PROVIDER_UAZAPI,
    display_name: "Comercial",
    phone_number: "+553599990000",
    // O `instance.id` do servidor, opaco — NÃO o nome "comercial" do painel.
    session_ref: "3f9a1c2e4b7d",
    ...extra,
  };
}

describe("achados 2 e 4: o portão exige token no evento de mensagem", () => {
  it("token ausente num evento de mensagem é recusado", () => {
    const raw = corpoDeMensagem({ token: null });
    expect(verifyInboundWebhookSignature(CHANNEL_PROVIDER_UAZAPI, raw, new Headers(), TOKEN)).toBe(false);
  });

  it("token errado é recusado", () => {
    const raw = corpoDeMensagem({ token: TOKEN.replace(/a/g, "b") });
    expect(verifyInboundWebhookSignature(CHANNEL_PROVIDER_UAZAPI, raw, new Headers(), TOKEN)).toBe(false);
  });

  it("token certo passa no portão", () => {
    const raw = corpoDeMensagem();
    expect(verifyInboundWebhookSignature(CHANNEL_PROVIDER_UAZAPI, raw, new Headers(), TOKEN)).toBe(true);
  });

  it("sem segredo utilizável, nada passa, mesmo com token certo no corpo", () => {
    const raw = corpoDeMensagem();
    expect(verifyInboundWebhookSignature(CHANNEL_PROVIDER_UAZAPI, raw, new Headers(), null)).toBe(false);
    expect(verifyInboundWebhookSignature(CHANNEL_PROVIDER_UAZAPI, raw, new Headers(), "curto")).toBe(false);
  });

  it("evento malformado não recusa no portão: quem monta o motivo certo é o seam", () => {
    expect(verifyInboundWebhookSignature(CHANNEL_PROVIDER_UAZAPI, "{nao e json", new Headers(), TOKEN)).toBe(true);
  });
});

/**
 * Dublê mínimo para `sincronizarSaudeDaConexao` (evento `connection`, estado
 * saudável): só `.select().eq().eq().maybeSingle()` é alcançado, e devolve
 * "sem episódio aberto": não há escrita nesse caminho para conferir aqui,
 * que já é coberto pelos testes do vigia de conexão.
 */
function adminDeSaude(): never {
  const chain: Record<string, unknown> = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "maybeSingle" || prop === "single") {
          return async () => ({ data: null, error: null });
        }
        if (prop === "then") {
          return (ok: (v: unknown) => unknown) => ok({ data: [], error: null });
        }
        return () => chain;
      },
    },
  );
  return { from: () => chain } as never;
}

describe("achado 2: a segunda camada, dentro do seam, repete a conferência", () => {
  beforeEach(() => {
    ingestUazapiMensagem.mockClear();
  });

  it("token certo chega até a ingestão", async () => {
    const r = await handleInboundWebhook({} as never, {
      session: sessao(),
      rawBody: corpoDeMensagem(),
      headers: new Headers(),
      secret: TOKEN,
    });
    expect(r).toMatchObject({ ok: true, body: { status: "ingested" } });
    expect(ingestUazapiMensagem).toHaveBeenCalledTimes(1);
  });

  it("token ausente também é recusado por uazapiInbound, não só pelo portão", async () => {
    const r = await handleInboundWebhook({} as never, {
      session: sessao(),
      rawBody: corpoDeMensagem({ token: null }),
      headers: new Headers(),
      secret: TOKEN,
    });
    expect(r).toMatchObject({ ok: false, code: "unauthorized" });
    expect(ingestUazapiMensagem).not.toHaveBeenCalled();
  });

  it("evento sem token E sem owner (o buraco do achado) é recusado, não mais aceito", async () => {
    const r = await handleInboundWebhook({} as never, {
      session: sessao(),
      rawBody: corpoDeConexao({ owner: null }),
      headers: new Headers(),
      secret: TOKEN,
    });
    expect(r).toMatchObject({ ok: false, code: "unauthorized", message: "dono_ausente" });
  });

  it("evento sem token, com owner batendo o número da conexão, passa", async () => {
    const r = await handleInboundWebhook(adminDeSaude(), {
      session: sessao({ phone_number: "+553599990000" }),
      rawBody: corpoDeConexao(),
      headers: new Headers(),
      secret: TOKEN,
    });
    expect(r.ok).toBe(true);
  });
});

describe("achado 3: evento de outra instância da mesma organização é recusado", () => {
  it("owner divergente não pertence a esta sessão", async () => {
    const pertence = await inboundPayloadBelongsToSession({} as never, {
      session: sessao(),
      rawBody: corpoDeMensagem({ owner: "553500001111" }),
      headers: new Headers(),
      secret: TOKEN,
    });
    expect(pertence).toBe(false);
  });

  it("owner divergente recusa mesmo sem o nome da instância no evento", async () => {
    const pertence = await inboundPayloadBelongsToSession({} as never, {
      session: sessao({ session_ref: null }),
      rawBody: corpoDeMensagem({ instanceName: null, owner: "553500001111" }),
      headers: new Headers(),
      secret: TOKEN,
    });
    expect(pertence).toBe(false);
  });

  it("owner batendo pertence à sessão", async () => {
    const pertence = await inboundPayloadBelongsToSession({} as never, {
      session: sessao(),
      rawBody: corpoDeMensagem(),
      headers: new Headers(),
      secret: TOKEN,
    });
    expect(pertence).toBe(true);
  });

  /**
   * A REGRESSÃO QUE ESTE ARQUIVO JÁ CAUSOU UMA VEZ.
   *
   * A primeira versão da conferência comparava `instanceName` (o NOME que o
   * operador digita no painel) contra `session_ref` (que para este canal é o
   * `instance.id`, opaco). Como os dois quase nunca são iguais, TODO evento
   * legítimo virava "evento de outra conta" — com resposta 200, que a UAZAPI
   * não reentrega: o canal pararia de receber mensagem em silêncio. A fixture
   * de então escondia o defeito porque usava o mesmo texto nos dois campos.
   */
  it("nome da instância diferente do id da sessão NÃO recusa: os dois campos não são a mesma coisa", async () => {
    const pertence = await inboundPayloadBelongsToSession({} as never, {
      session: sessao({ session_ref: "3f9a1c2e4b7d" }),
      rawBody: corpoDeMensagem({ instanceName: "comercial" }),
      headers: new Headers(),
      secret: TOKEN,
    });
    expect(pertence).toBe(true);
  });
});

describe("achado 1: o arquivo do webhook redige segredos antes de gravar", () => {
  let inserido: Record<string, unknown> | null = null;
  const admin = {
    from() {
      return {
        insert(payload: Record<string, unknown>) {
          inserido = payload;
          return { select: () => ({ maybeSingle: async () => ({ data: { id: "log-1" }, error: null }) }) };
        },
      };
    },
  } as never;

  it("o token some do payload_parsed e do raw_body, os dois com [redigido]", async () => {
    const { abrirArquivoDoWebhook } = await import("@/lib/channels/arquivo-de-webhook");
    const raw = corpoDeMensagem();
    await abrirArquivoDoWebhook(admin, {
      organizationId: "org-1",
      channelSessionId: "sess-1",
      provider: "uazapi",
      rawBody: raw,
      headers: new Headers(),
    });

    expect(inserido?.raw_body).not.toContain(TOKEN);
    expect(inserido?.raw_body).toContain("[redigido]");
    const parsed = inserido?.payload_parsed as Record<string, unknown>;
    expect(parsed.token).toBe("[redigido]");
    // O resto do corpo segue legível: só o VALOR da chave sensível some.
    expect(parsed.instanceName).toBe("comercial");
  });

  it("corpo cru que NÃO é JSON válido também redige, por regex", async () => {
    const { abrirArquivoDoWebhook } = await import("@/lib/channels/arquivo-de-webhook");
    const raw = `nao e json valido "token":"${TOKEN}" resto do corpo`;
    await abrirArquivoDoWebhook(admin, {
      organizationId: "org-1",
      channelSessionId: "sess-1",
      provider: "uazapi",
      rawBody: raw,
      headers: new Headers(),
    });

    expect(inserido?.raw_body).not.toContain(TOKEN);
    expect(inserido?.raw_body).toContain("[redigido]");
    expect(inserido?.payload_parsed).toBeNull();
  });
});

describe("achado 1b: a migration 0902 entra no baseline antes da varredura anon", () => {
  it("o bloco existe e vem ANTES do marcador da varredura", () => {
    const sql = readFileSync("supabase/baseline.sql", "utf8");
    const bloco = sql.indexOf("migration 0902");
    const varredura = sql.indexOf("-- ---- VARREDURA anon:");
    expect(bloco, "bloco da migration 0902 não encontrado no baseline").toBeGreaterThan(-1);
    expect(varredura).toBeGreaterThan(-1);
    expect(bloco, "o bloco da 0902 ficou depois da varredura de anon").toBeLessThan(varredura);
  });

  it("a migration versionada exige o mesmo piso de papel, e o manifesto a registra", () => {
    const mig = readFileSync(
      "supabase/migrations/20260922193000_0902_webhook_events_log_exige_manager.sql",
      "utf8",
    );
    expect(mig).toContain("fn_role_at_least(organization_id, 'manager')");
    expect(readFileSync("supabase/migrations/MANIFEST.md", "utf8")).toContain(
      "0902_webhook_events_log_exige_manager",
    );
  });
});
