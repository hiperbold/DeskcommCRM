import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * D-042: `messages_update` e `connection` da UAZAPI não repetem o token da
 * instância: a prova deles é só o número dono, dentro do próprio corpo. Sem
 * nonce nem janela de tempo, um corpo capturado válido pode ser reenviado pela
 * mesma URL quantas vezes quiser. Aqui: o helper puro (`replay-guard.ts`) e a
 * integração com `handleInboundWebhook`, para os dois eventos que o achado
 * cobre; `messages` fica de fora de propósito (tem token próprio no corpo, e
 * `external_id` único já cobre a reentrega dele).
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
import { handleInboundWebhook, type InboundWebhookInput } from "@/lib/channels/inbound";
import {
  chaveDoEventoUazapi,
  esquecerEventosUazapiVistos,
  eventoUazapiRepetido,
  JANELA_DE_REPLAY_MS,
} from "@/lib/channels/uazapi/replay-guard";

const TOKEN = "0a1b2c3d-aa11-4b2c-bbbb-a123b4c5d6e7";

function corpoDeAtualizacao(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    EventType: "messages_update",
    BaseUrl: "https://empresa.uazapi.com",
    instanceName: "comercial",
    owner: "553599990000",
    state: "Delivered",
    type: "ReadReceipt",
    event: { MessageIDs: ["3EB0AAAA1111"], Chat: "553591234567@s.whatsapp.net", IsFromMe: true },
    ...extra,
  });
}

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
    session_ref: "3f9a1c2e4b7d",
    ...extra,
  };
}

/** Dublê mínimo para `aplicarStatusUazapi` (`messages.update().eq()...select()`). */
function adminDeStatus() {
  const chain: Record<string, unknown> = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "select") return () => Promise.resolve({ data: [{ id: "m1" }], error: null });
        return () => chain;
      },
    },
  );
  return { from: () => chain } as never;
}

/** Dublê mínimo para `sincronizarSaudeDaConexao`: sem episódio aberto, sem escrita a conferir aqui. */
function adminDeSaude() {
  const chain: Record<string, unknown> = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "maybeSingle" || prop === "single") return async () => ({ data: null, error: null });
        if (prop === "then") return (ok: (v: unknown) => unknown) => ok({ data: [], error: null });
        return () => chain;
      },
    },
  );
  return { from: () => chain } as never;
}

describe("replay-guard puro", () => {
  beforeEach(() => esquecerEventosUazapiVistos());

  it("primeira vez que vê a chave: não é repetido, e passa a valer", () => {
    const chave = chaveDoEventoUazapi("sess-1", "connection", "corpo-a");
    expect(eventoUazapiRepetido(chave, 1_000)).toBe(false);
  });

  it("mesma chave dentro da janela: repetido", () => {
    const chave = chaveDoEventoUazapi("sess-1", "connection", "corpo-a");
    expect(eventoUazapiRepetido(chave, 1_000)).toBe(false);
    expect(eventoUazapiRepetido(chave, 1_000 + JANELA_DE_REPLAY_MS - 1)).toBe(true);
  });

  it("mesma chave depois que a janela vence: processa de novo", () => {
    const chave = chaveDoEventoUazapi("sess-1", "connection", "corpo-a");
    expect(eventoUazapiRepetido(chave, 1_000)).toBe(false);
    expect(eventoUazapiRepetido(chave, 1_000 + JANELA_DE_REPLAY_MS + 1)).toBe(false);
  });

  it("corpo diferente (1 byte que seja) gera chave diferente", () => {
    const a = chaveDoEventoUazapi("sess-1", "connection", "corpo-a");
    const b = chaveDoEventoUazapi("sess-1", "connection", "corpo-b");
    expect(a).not.toBe(b);
  });

  it("mesmo corpo, sessão diferente: chaves diferentes, uma não bloqueia a outra", () => {
    const a = chaveDoEventoUazapi("sess-1", "connection", "corpo-a");
    const b = chaveDoEventoUazapi("sess-2", "connection", "corpo-a");
    expect(eventoUazapiRepetido(a, 1_000)).toBe(false);
    expect(eventoUazapiRepetido(b, 1_000)).toBe(false);
  });
});

describe("D-042 na integração: handleInboundWebhook recusa o corpo repetido", () => {
  beforeEach(() => {
    esquecerEventosUazapiVistos();
    ingestUazapiMensagem.mockClear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-25T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("messages_update: mesmo corpo reenviado é ignorado como repetido, sem reaplicar o status", async () => {
    const raw = corpoDeAtualizacao();
    const primeira = await handleInboundWebhook(adminDeStatus(), {
      session: sessao(),
      rawBody: raw,
      headers: new Headers(),
      secret: TOKEN,
    });
    expect(primeira).toMatchObject({ ok: true, body: { status: "status" } });

    const segunda = await handleInboundWebhook(adminDeStatus(), {
      session: sessao(),
      rawBody: raw,
      headers: new Headers(),
      secret: TOKEN,
    });
    expect(segunda).toEqual({ ok: true, body: { status: "ignored", reason: "evento_repetido" } });
  });

  it("messages_update: corpo diferente (outro MessageID) processa normalmente mesmo logo em seguida", async () => {
    const primeira = await handleInboundWebhook(adminDeStatus(), {
      session: sessao(),
      rawBody: corpoDeAtualizacao(),
      headers: new Headers(),
      secret: TOKEN,
    });
    expect(primeira).toMatchObject({ ok: true, body: { status: "status" } });

    const segunda = await handleInboundWebhook(adminDeStatus(), {
      session: sessao(),
      rawBody: corpoDeAtualizacao({ event: { MessageIDs: ["OUTRO-ID"], Chat: "x" } }),
      headers: new Headers(),
      secret: TOKEN,
    });
    expect(segunda).toMatchObject({ ok: true, body: { status: "status" } });
  });

  it("connection: mesmo corpo reenviado é ignorado como repetido", async () => {
    const raw = corpoDeConexao();
    const primeira = await handleInboundWebhook(adminDeSaude(), {
      session: sessao(),
      rawBody: raw,
      headers: new Headers(),
      secret: TOKEN,
    });
    expect(primeira).toMatchObject({ ok: true, body: { status: "saude" } });

    const segunda = await handleInboundWebhook(adminDeSaude(), {
      session: sessao(),
      rawBody: raw,
      headers: new Headers(),
      secret: TOKEN,
    });
    expect(segunda).toEqual({ ok: true, body: { status: "ignored", reason: "evento_repetido" } });
  });

  it("connection: mesmo corpo, sessão diferente, processa (a chave é por sessão)", async () => {
    const raw = corpoDeConexao();
    await handleInboundWebhook(adminDeSaude(), {
      session: sessao({ id: "sess-1" }),
      rawBody: raw,
      headers: new Headers(),
      secret: TOKEN,
    });
    const outraSessao = await handleInboundWebhook(adminDeSaude(), {
      session: sessao({ id: "sess-2" }),
      rawBody: raw,
      headers: new Headers(),
      secret: TOKEN,
    });
    expect(outraSessao).toMatchObject({ ok: true, body: { status: "saude" } });
  });

  it("connection: depois que a janela de replay vence, o mesmo corpo processa de novo", async () => {
    const raw = corpoDeConexao();
    await handleInboundWebhook(adminDeSaude(), {
      session: sessao(),
      rawBody: raw,
      headers: new Headers(),
      secret: TOKEN,
    });

    vi.setSystemTime(new Date(Date.now() + JANELA_DE_REPLAY_MS + 1_000));

    const depoisDaJanela = await handleInboundWebhook(adminDeSaude(), {
      session: sessao(),
      rawBody: raw,
      headers: new Headers(),
      secret: TOKEN,
    });
    expect(depoisDaJanela).toMatchObject({ ok: true, body: { status: "saude" } });
  });

  it("messages (com token) não passa por este portão: reenviar o mesmo corpo continua sendo ingerido", async () => {
    const raw = JSON.stringify({
      EventType: "messages",
      BaseUrl: "https://empresa.uazapi.com",
      instanceName: "comercial",
      owner: "553599990000",
      token: TOKEN,
      chat: { wa_chatid: "553591234567@s.whatsapp.net", wa_name: "Cliente" },
      message: {
        messageid: "3EB0AAAA1111",
        chatid: "553591234567@s.whatsapp.net",
        isGroup: false,
        fromMe: false,
        wasSentByApi: false,
        messageType: "Conversation",
        messageTimestamp: 1_789_500_000_000,
        senderName: "Maria",
        text: "oi",
      },
    });

    await handleInboundWebhook({} as never, { session: sessao(), rawBody: raw, headers: new Headers(), secret: TOKEN });
    await handleInboundWebhook({} as never, { session: sessao(), rawBody: raw, headers: new Headers(), secret: TOKEN });

    // Não é este guard que decide a idempotência de `messages`: a ingestão foi
    // chamada as duas vezes; quem resolve duplicata é `external_id`, alhures.
    expect(ingestUazapiMensagem).toHaveBeenCalledTimes(2);
  });
});
