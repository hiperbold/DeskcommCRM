/**
 * Ingestão da instância UAZAPI: mensagem lida → contato, conversa, mensagem.
 *
 * A leitura do payload é do módulo puro ao lado (`./webhook.ts`); aqui moram os
 * EFEITOS, pelo mesmo motivo do irmão intermediado: o que decide dá para provar
 * sem banco, e o que escreve fica pequeno.
 *
 * ─── Idempotência ───────────────────────────────────────────────────────────
 *
 * O servidor reentrega quando não recebe 200, e reentrega o MESMO evento. A
 * chave é `(organization_id, external_id)` no INSERT, com captura do `23505`,
 * exatamente como os outros canais: sem isso, uma retentativa duplica a
 * mensagem no inbox.
 *
 * ─── O eco do nosso envio ───────────────────────────────────────────────────
 *
 * O webhook NÃO filtra o que saiu pela API (ver `registrarWebhookUazapi`), então
 * três saídas chegam por aqui e parecem iguais: a digitada no aparelho, a que
 * outro sistema mandou pelo mesmo número, e o eco do nosso próprio envio.
 *
 * GRAVAR a linha é tolerante nas três: o eco que chega antes de o envio saber o
 * id vira linha que o próprio envio apaga por id exato, e o que chega depois
 * bate no unique. PAUSAR a IA é estrito, na direção oposta: só não pausa quando
 * a saída veio pela API E há um envio nosso em voo que a explica. Calar a IA
 * porque ela mesma falou é o defeito que o canal por QR já pagou (#519).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";
import { encontrarContatoPorTelefone } from "@/lib/channels/contato-por-telefone";
import { canonicalPhoneBR } from "@/lib/channels/phone-variants";
import { marcarConversaComMensagem } from "@/lib/channels/marcar-conversa";
import { pausarIaPorAtendimentoManual } from "@/lib/escalacao/atendimento-manual";

import { UAZAPI_REFERENCIA_DE_MIDIA } from "../adapters/uazapi";
import { aplicarEfeitosPosEntrada } from "../pos-entrada";

import type { UazapiMensagemLida, UazapiTipoDeMensagem } from "./webhook";

export interface UazapiIngestResult {
  status: "ingested" | "duplicate" | "ignored";
  conversationId?: string;
  messageId?: string;
  /** Por que foi ignorado — vai para o arquivo do webhook, e é o que se lê quando "sumiu". */
  reason?: string;
}

const CANAL = "uazapi";

/** O que a lista de conversas mostra quando a mensagem não tem texto. */
const ROTULO: Record<Exclude<UazapiTipoDeMensagem, "text">, string> = {
  image: "Imagem",
  video: "Vídeo",
  audio: "Áudio",
  document: "Documento",
  sticker: "Figurinha",
};

export async function ingestUazapiMensagem(
  admin: SupabaseClient,
  input: {
    organizationId: string;
    channelSessionId: string;
    msg: UazapiMensagemLida;
    requestId?: string;
  },
): Promise<UazapiIngestResult> {
  const { msg } = input;

  const contactId = await upsertContact(admin, input.organizationId, msg);
  if (contactId === "sem_identidade") return { status: "ignored", reason: "sem_identidade_utilizavel" };
  if (!contactId) return { status: "ignored", reason: "contato_nao_resolvido" };

  const { data: conversa, error: erroConversa } = await admin.rpc("fn_upsert_wa_conversation", {
    p_org: input.organizationId,
    p_contact: contactId,
    p_session: input.channelSessionId,
  });
  if (erroConversa || !conversa) return { status: "ignored", reason: "conversa_nao_resolvida" };
  const conversationId = conversa as string;

  const inserted = await insertMessage(admin, {
    organizationId: input.organizationId,
    conversationId,
    contactId,
    channelSessionId: input.channelSessionId,
    msg,
  });
  if (inserted === "duplicate") return { status: "duplicate", conversationId };

  // Não carimba no `duplicate`: a reentrega é a MESMA mensagem, e somar de novo
  // inflaria o contador de não lidas a cada retentativa do servidor.
  await marcarConversaComMensagem(admin, {
    organizationId: input.organizationId,
    conversationId,
    direction: msg.direction,
    preview: (msg.text ?? (msg.tipo === "text" ? "" : ROTULO[msg.tipo])).slice(0, 200),
    // A hora em que a mensagem foi ESCRITA, não a da entrega do webhook: a ordem
    // da lista e a janela usam este campo, e numa reentrega atrasada divergem.
    at: msg.sentAt ?? new Date().toISOString(),
    canal: CANAL,
  });

  if (msg.tipo !== "text") {
    await pedirPersistenciaDaMidia(admin, input.organizationId, conversationId, inserted);
  }

  if (msg.direction === "inbound") {
    // Opt-out, nascimento do lead e despacho do agente são regra do PRODUTO, não
    // deste transporte: o passo compartilhado decide, igual para todo canal.
    await aplicarEfeitosPosEntrada(admin, {
      organizationId: input.organizationId,
      contactId,
      conversationId,
      messageId: inserted,
      channelSessionId: input.channelSessionId,
      texto: msg.text,
      nomeDoContato: msg.displayName,
      requestId: input.requestId,
      origem: "uazapi_webhook",
    });
  } else if (!(msg.viaApi && (await ehEcoDeEnvioNosso(admin, input.organizationId, conversationId, msg)))) {
    // Alguém de FORA do CRM respondeu este cliente: uma pessoa no aparelho ou
    // outro sistema pelo mesmo número. Nos dois casos a IA responder junto é
    // o cliente recebendo duas respostas.
    await pausarIaPorAtendimentoManual(admin, {
      organizationId: input.organizationId,
      conversationId,
      canal: CANAL,
    });
  }

  return { status: "ingested", conversationId, messageId: inserted };
}

/** Quanto tempo um envio nosso pode estar em voo e ainda explicar um eco. */
const JANELA_DO_ECO_MS = 60_000;

/**
 * Há um envio do CRM em voo nesta conversa que explica esta saída?
 *
 * Em voo = nasceu aqui (`ai`/`user`), ainda sem `external_id` e em
 * `queued`/`sending`: é exatamente a janela em que o eco não casa por id. Texto
 * compara o corpo; mídia só tem a existência do envio de mídia como prova, que
 * é mais fraca e fica escrita para ninguém supor o contrário.
 *
 * Erro de leitura responde `false`: na dúvida a IA pausa, que é o desfecho de
 * quando há um humano.
 */
async function ehEcoDeEnvioNosso(
  admin: SupabaseClient,
  organizationId: string,
  conversationId: string,
  msg: UazapiMensagemLida,
): Promise<boolean> {
  const { data, error } = await admin
    .from("messages")
    .select("body, type")
    .eq("organization_id", organizationId)
    .eq("conversation_id", conversationId)
    .eq("direction", "outbound")
    .in("sent_via", ["ai", "user"])
    .is("external_id", null)
    .in("status", ["queued", "sending"])
    .gte("created_at", new Date(Date.now() - JANELA_DO_ECO_MS).toISOString())
    .limit(20);
  if (error) {
    logger.warn("[uazapi] checagem de eco falhou", { conversationId, detail: error.message });
    return false;
  }

  const corpo = (msg.text ?? "").trim();
  return ((data ?? []) as Array<{ body: string | null; type: string | null }>).some((linha) =>
    msg.tipo === "text"
      ? corpo.length > 0 && (linha.body ?? "").trim() === corpo
      : (linha.type ?? "text") !== "text",
  );
}

/**
 * Resolve o contato pela âncora que o evento trouxe: telefone quando há, `@lid`
 * quando só existe identidade opaca. Reusa a RPC do canal por QR, que já resolve
 * a corrida de dois webhooks simultâneos numa transação.
 */
async function upsertContact(
  admin: SupabaseClient,
  organizationId: string,
  msg: UazapiMensagemLida,
): Promise<string | "sem_identidade" | null> {
  const kind = msg.phone ? "phone" : msg.lid ? "lid" : null;
  if (!kind) return "sem_identidade";

  const existente = msg.phone ? await encontrarContatoPorTelefone(admin, organizationId, msg.phone) : null;
  const phone = existente?.phone_number
    ? canonicalPhoneBR(existente.phone_number)
    : msg.phone
      ? canonicalPhoneBR(msg.phone)
      : null;

  const { data, error } = await admin.rpc("fn_upsert_wa_contact", {
    p_org: organizationId,
    p_kind: kind,
    p_phone: phone,
    p_lid: kind === "lid" ? msg.lid : null,
    p_chat_id: msg.chatId,
    p_notify: msg.displayName,
  });
  if (error || !data) return null;
  const contactId = data as string;

  // O telefone entra mesmo quando a âncora foi o `@lid`. `is null` no filtro:
  // não sobrescreve uma correção feita à mão na tela.
  if (msg.phone) {
    await admin
      .from("contacts")
      .update({ phone_number: canonicalPhoneBR(msg.phone) })
      .eq("id", contactId)
      .is("phone_number", null);
  }

  return contactId;
}

async function insertMessage(
  admin: SupabaseClient,
  input: {
    organizationId: string;
    conversationId: string;
    contactId: string;
    channelSessionId: string;
    msg: UazapiMensagemLida;
  },
): Promise<string | "duplicate"> {
  const { msg } = input;
  const temMidia = msg.tipo !== "text";

  const { data, error } = await admin
    .from("messages")
    .insert({
      organization_id: input.organizationId,
      conversation_id: input.conversationId,
      contact_id: input.contactId,
      channel_session_id: input.channelSessionId,
      external_id: msg.externalId,
      direction: msg.direction,
      // Toda linha nascida do webhook veio de FORA do CRM. O default da coluna é
      // `'crm'`, e as funções de fricção contam só `external_device`.
      sent_via: "external_device",
      status: msg.direction === "outbound" ? "sent" : "delivered",
      type: msg.tipo,
      body: msg.text,
      // O evento não traz o arquivo, só a mensagem: a referência é o id, e quem
      // sabe transformá-la em bytes é o `fetchInboundMedia` do adapter, chamado
      // pelo worker de persistência.
      ...(temMidia
        ? { media_url: `${UAZAPI_REFERENCIA_DE_MIDIA}${msg.externalId}`, media_mime: msg.mime }
        : {}),
      // `via_api` separa, depois, o que outro sistema mandou do que foi digitado
      // no aparelho: os dois são `external_device`, porque é esse o valor que o
      // envio procura para apagar o próprio eco.
      metadata: msg.viaApi ? { via_api: true } : {},
      ...(msg.sentAt ? { sent_at: msg.sentAt } : {}),
    })
    .select("id")
    .maybeSingle();

  // 23505 = unique (organization_id, external_id): desfecho ESPERADO de uma
  // reentrega. Tratar como falha faria a rota devolver 500 e o servidor reenviar
  // para sempre.
  if (error?.code === "23505") return "duplicate";
  if (error || !data) throw new Error(`uazapi_ingest_insert_failed: ${error?.message ?? "sem id"}`);
  return (data as { id: string }).id;
}

/**
 * Pede a persistência dos bytes. Mesmo evento e mesmo payload dos outros canais:
 * o consumidor é um só (`workers/media-persist-worker.ts`).
 *
 * Best-effort: a mensagem já está gravada e visível, e derrubar a ingestão aqui
 * trocaria uma mídia faltando por uma tempestade de reentregas.
 */
async function pedirPersistenciaDaMidia(
  admin: SupabaseClient,
  organizationId: string,
  conversationId: string,
  messageId: string,
): Promise<void> {
  const { error } = await admin.rpc("emit_event" as never, {
    p_event_type: "media.persist_requested",
    p_entity_kind: "message",
    p_entity_id: messageId,
    p_payload: { message_id: messageId, conversation_id: conversationId },
    p_metadata: { source: "uazapi_webhook" },
    p_organization_id: organizationId,
  } as never);
  if (error) {
    logger.warn("[uazapi] emit media.persist_requested falhou", { messageId, detail: error.message });
  }
}
