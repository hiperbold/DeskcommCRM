import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Ingestão da instância: mensagem lida → contato, conversa, mensagem.
 *
 * ─── O que esta suíte vigia, e por quê ──────────────────────────────────────
 *
 * Os quatro caminhos que, quando quebram, quebram em SILÊNCIO:
 *
 * 1. A reentrega. O servidor reenvia o mesmo evento até receber 200. Sem a
 *    captura do `23505`, cada reentrega vira uma bolha repetida no inbox — e o
 *    contador de não lidas sobe junto.
 * 2. A mídia. O evento não traz bytes, só a mensagem. Se a linha nascer sem a
 *    REFERÊNCIA, o worker de persistência não tem como buscar o arquivo e a
 *    conversa fica com um anexo que nunca chega.
 * 3. A saída que CHEGA. Digitada no aparelho ou mandada por outro sistema, a IA
 *    tem que pausar, senão responde por cima de quem já atendeu. Só o eco de um
 *    envio NOSSO em voo não pausa: calar a IA porque ela mesma falou.
 * 4. A identidade. Evento sem telefone e sem `@lid` não vira contato de ninguém;
 *    inserir assim escreve lixo no banco de quem instalou.
 *
 * As formas vêm dos eventos REAIS capturados na instalação; os números são
 * inventados: nenhum dado de cliente entra no repositório.
 */

const efeitosPosEntrada = vi.fn(async (..._args: unknown[]) => undefined);
const pausarIa = vi.fn(async (..._args: unknown[]) => undefined);
const marcarConversa = vi.fn(async (..._args: unknown[]) => undefined);

vi.mock("@/lib/channels/pos-entrada", () => ({
  aplicarEfeitosPosEntrada: (...a: unknown[]) => efeitosPosEntrada(...(a as [])),
}));
vi.mock("@/lib/escalacao/atendimento-manual", () => ({
  pausarIaPorAtendimentoManual: (...a: unknown[]) => pausarIa(...(a as [])),
}));
vi.mock("@/lib/channels/marcar-conversa", () => ({
  marcarConversaComMensagem: (...a: unknown[]) => marcarConversa(...(a as [])),
}));
vi.mock("@/lib/channels/contato-por-telefone", () => ({
  encontrarContatoPorTelefone: async () => contatoExistente,
}));

import { ingestUazapiMensagem } from "@/lib/channels/uazapi/ingest";
import type { UazapiMensagemLida } from "@/lib/channels/uazapi/webhook";

let contatoExistente: { phone_number: string } | null = null;

/** Chamadas de RPC, na ordem — é por elas que se lê o que a ingestão decidiu. */
let rpcs: Array<{ nome: string; args: Record<string, unknown> }> = [];
/** O payload do INSERT em `messages`, que é onde a referência de mídia mora. */
let mensagemInserida: Record<string, unknown> | null = null;
/** `23505` quando o teste quer encenar uma reentrega. */
let erroDoInsert: { code?: string; message: string } | null = null;
/** Linhas que a checagem de eco enxerga: envios do CRM ainda sem id do canal. */
let enviosEmVoo: Array<{ body: string | null; type: string | null }> = [];

function admin(): never {
  const builder = (tabela: string): Record<string, unknown> => {
    const proxy: Record<string, unknown> = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "insert") {
            return (payload: Record<string, unknown>) => {
              if (tabela === "messages") mensagemInserida = payload;
              return proxy;
            };
          }
          if (prop === "maybeSingle" || prop === "single") {
            return async () =>
              erroDoInsert ? { data: null, error: erroDoInsert } : { data: { id: "msg-1" }, error: null };
          }
          if (prop === "then") {
            return (ok: (v: unknown) => unknown) =>
              ok({ data: tabela === "messages" ? enviosEmVoo : [], error: null });
          }
          return () => proxy;
        },
      },
    ) as Record<string, unknown>;
    return proxy;
  };

  return {
    from: (tabela: string) => builder(tabela),
    rpc: async (nome: string, args: Record<string, unknown>) => {
      rpcs.push({ nome, args });
      if (nome === "fn_upsert_wa_contact") return { data: "contact-1", error: null };
      if (nome === "fn_upsert_wa_conversation") return { data: "conv-1", error: null };
      return { data: null, error: null };
    },
  } as never;
}

const base: UazapiMensagemLida = {
  direction: "inbound",
  viaApi: false,
  externalId: "3EB0AAAA1111",
  chatId: "553591234567@s.whatsapp.net",
  phone: "+553591234567",
  lid: null,
  displayName: "Maria",
  text: "oi",
  tipo: "text",
  mime: null,
  sentAt: "2026-09-15T12:00:00.000Z",
  quotedExternalId: null,
};

const entrada = { organizationId: "org-1", channelSessionId: "sess-1" };

beforeEach(() => {
  rpcs = [];
  mensagemInserida = null;
  erroDoInsert = null;
  contatoExistente = null;
  enviosEmVoo = [];
  efeitosPosEntrada.mockClear();
  pausarIa.mockClear();
  marcarConversa.mockClear();
});

describe("mensagem que entra", () => {
  it("resolve contato e conversa antes de gravar a mensagem", async () => {
    const r = await ingestUazapiMensagem(admin(), { ...entrada, msg: base });

    expect(r).toEqual({ status: "ingested", conversationId: "conv-1", messageId: "msg-1" });
    expect(rpcs.map((c) => c.nome)).toEqual([
      "fn_upsert_wa_contact",
      "fn_upsert_wa_conversation",
      // A ordem não é estética: sem contato não há conversa, e sem conversa a
      // mensagem não tem onde aparecer.
    ]);
    // O telefone entra CANÔNICO (E.164 com o nono dígito), não como o evento o
    // escreveu: é a mesma forma que os outros canais gravam, e é ela que faz o
    // mesmo cliente cair no mesmo contato venha ele por onde vier.
    expect(rpcs[0]!.args).toMatchObject({ p_kind: "phone", p_phone: "+5535991234567", p_notify: "Maria" });
  });

  it("toda linha nascida do webhook é `external_device` — é o que as funções de fricção contam", async () => {
    await ingestUazapiMensagem(admin(), { ...entrada, msg: base });
    expect(mensagemInserida).toMatchObject({
      external_id: "3EB0AAAA1111",
      direction: "inbound",
      sent_via: "external_device",
      status: "delivered",
      type: "text",
      body: "oi",
      sent_at: "2026-09-15T12:00:00.000Z",
    });
    // Texto não pede persistência de mídia: não há arquivo.
    expect(mensagemInserida).not.toHaveProperty("media_url");
  });

  it("entrada dispara os efeitos de produto e NÃO pausa a IA", async () => {
    await ingestUazapiMensagem(admin(), { ...entrada, msg: base });
    expect(efeitosPosEntrada).toHaveBeenCalledTimes(1);
    expect(efeitosPosEntrada.mock.calls[0]![1]).toMatchObject({ origem: "uazapi_webhook", texto: "oi" });
    expect(pausarIa).not.toHaveBeenCalled();
  });
});

describe("a mesma mensagem chegando duas vezes", () => {
  it("reentrega vira `duplicate` e NÃO carimba a conversa de novo", async () => {
    // Carimbar de novo somaria uma não lida por retentativa do servidor: o
    // contador da lista sobe sozinho e o operador vê conversa "nova" que não é.
    erroDoInsert = { code: "23505", message: "duplicate key value" };
    const r = await ingestUazapiMensagem(admin(), { ...entrada, msg: base });

    expect(r).toEqual({ status: "duplicate", conversationId: "conv-1" });
    expect(marcarConversa).not.toHaveBeenCalled();
    expect(efeitosPosEntrada).not.toHaveBeenCalled();
  });

  it("erro que NÃO é duplicidade sobe — 500 faz o servidor reentregar, que é o certo", async () => {
    erroDoInsert = { code: "42703", message: "column does not exist" };
    await expect(ingestUazapiMensagem(admin(), { ...entrada, msg: base })).rejects.toThrow(
      /uazapi_ingest_insert_failed/,
    );
  });
});

describe("mídia", () => {
  it("a linha guarda a REFERÊNCIA da mensagem, não uma URL — o evento não traz bytes", async () => {
    const msg: UazapiMensagemLida = {
      ...base,
      tipo: "image",
      mime: "image/jpeg",
      text: "olha isto",
      externalId: "3EB0BBBB2222",
    };
    await ingestUazapiMensagem(admin(), { ...entrada, msg });

    expect(mensagemInserida).toMatchObject({
      type: "image",
      media_url: "uazapi-mensagem:3EB0BBBB2222",
      media_mime: "image/jpeg",
    });
  });

  it("pede a persistência dos bytes pelo MESMO evento dos outros canais", async () => {
    // O consumidor é um só (`workers/media-persist-worker.ts`). Inventar um nome
    // de evento aqui deixaria a mídia parada sem ninguém reclamar.
    await ingestUazapiMensagem(admin(), { ...entrada, msg: { ...base, tipo: "audio", mime: "audio/ogg", text: null } });

    const evento = rpcs.find((c) => c.nome === "emit_event");
    expect(evento, "nenhum pedido de persistência foi emitido").toBeTruthy();
    expect(evento!.args).toMatchObject({
      p_event_type: "media.persist_requested",
      p_entity_kind: "message",
      p_entity_id: "msg-1",
    });
  });

  it("mídia sem legenda mostra o rótulo do tipo na lista, não uma linha vazia", async () => {
    await ingestUazapiMensagem(admin(), { ...entrada, msg: { ...base, tipo: "document", text: null } });
    expect(marcarConversa.mock.calls[0]![1]).toMatchObject({ preview: "Documento" });
  });
});

describe("saída que chega pelo webhook", () => {
  it("foi digitada no APARELHO: pausa a IA e não dispara os efeitos de entrada", async () => {
    // Saída que NÃO veio pela API foi digitada no celular: é um humano
    // atendendo, e a IA respondendo por cima é exatamente o que o cliente vê
    // como "o bot atropelou a atendente".
    await ingestUazapiMensagem(admin(), { ...entrada, msg: { ...base, direction: "outbound" } });

    expect(pausarIa).toHaveBeenCalledTimes(1);
    expect(pausarIa.mock.calls[0]![1]).toMatchObject({ conversationId: "conv-1", canal: "uazapi" });
    expect(efeitosPosEntrada).not.toHaveBeenCalled();
    expect(mensagemInserida).toMatchObject({ direction: "outbound", status: "sent" });
  });
});

describe("saída mandada pela API (D-023)", () => {
  it("de OUTRO sistema: entra na conversa, marcada via_api, e pausa a IA", async () => {
    // Um n8n respondendo pelo mesmo número: o cliente já recebeu uma resposta,
    // e a IA do CRM respondendo junto seria a segunda.
    const r = await ingestUazapiMensagem(admin(), {
      ...entrada,
      msg: { ...base, direction: "outbound", viaApi: true, text: "seu boleto" },
    });
    expect(r.status).toBe("ingested");
    expect(mensagemInserida).toMatchObject({ sent_via: "external_device", metadata: { via_api: true } });
    expect(pausarIa).toHaveBeenCalledTimes(1);
  });

  it("eco do NOSSO envio em voo (mesmo texto): grava, mas NÃO cala a IA", async () => {
    // A linha gravada aqui o próprio envio apaga pelo id exato; calar a IA
    // porque ela mesma falou não teria quem desfizesse.
    enviosEmVoo = [{ body: "seu boleto", type: "text" }];
    await ingestUazapiMensagem(admin(), {
      ...entrada,
      msg: { ...base, direction: "outbound", viaApi: true, text: "seu boleto" },
    });
    expect(mensagemInserida).toMatchObject({ sent_via: "external_device" });
    expect(pausarIa).not.toHaveBeenCalled();
  });

  it("envio em voo com OUTRO texto não serve de álibi", async () => {
    enviosEmVoo = [{ body: "outra frase", type: "text" }];
    await ingestUazapiMensagem(admin(), {
      ...entrada,
      msg: { ...base, direction: "outbound", viaApi: true, text: "seu boleto" },
    });
    expect(pausarIa).toHaveBeenCalledTimes(1);
  });

  it("digitada no aparelho pausa mesmo com envio em voo igual: só a API pode ser eco", async () => {
    enviosEmVoo = [{ body: "seu boleto", type: "text" }];
    await ingestUazapiMensagem(admin(), {
      ...entrada,
      msg: { ...base, direction: "outbound", viaApi: false, text: "seu boleto" },
    });
    expect(pausarIa).toHaveBeenCalledTimes(1);
    expect(mensagemInserida).toMatchObject({ metadata: {} });
  });
});

describe("identidade do contato", () => {
  it("sem telefone e sem lid não vira contato — nem chega a chamar o banco", async () => {
    const r = await ingestUazapiMensagem(admin(), {
      ...entrada,
      msg: { ...base, phone: null, lid: null },
    });
    expect(r).toEqual({ status: "ignored", reason: "sem_identidade_utilizavel" });
    expect(rpcs).toHaveLength(0);
  });

  it("só com `@lid` a âncora é o lid, e o telefone vai nulo", async () => {
    const r = await ingestUazapiMensagem(admin(), {
      ...entrada,
      msg: { ...base, phone: null, lid: "123456789012345", chatId: "123456789012345@lid" },
    });
    expect(r.status).toBe("ingested");
    expect(rpcs[0]!.args).toMatchObject({ p_kind: "lid", p_lid: "123456789012345", p_phone: null });
  });

  it("contato já existente manda o telefone DELE — não o do evento", async () => {
    // O número gravado é a verdade: ele pode ter sido corrigido à mão na tela, e
    // reescrever com o que o evento trouxe desfaria a correção — ou, pior,
    // abriria um segundo contato para a mesma pessoa.
    contatoExistente = { phone_number: "+5535988887777" };
    await ingestUazapiMensagem(admin(), { ...entrada, msg: base });
    expect(rpcs[0]!.args.p_phone).toBe("+5535988887777");
  });
});
