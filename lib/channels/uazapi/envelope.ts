/**
 * O CONTRATO do que a instância UAZAPI manda — declarado, e não presumido.
 *
 * Medido nos webhooks reais da instalação (evento `messages`): o corpo traz
 * `EventType`, `BaseUrl`, `instanceName`, `owner` (o número da instância),
 * `token` (o token da INSTÂNCIA, em claro), `chat` (o retrato da conversa) e
 * `message`. O `token` é o que autentica a entrega: a UAZAPI não assina o corpo,
 * mas repete o token da instância, e quem não o tem não forja o evento.
 *
 * A REGRA deste arquivo é a mesma do contrato do canal intermediado: um campo
 * ganha tipo quando o código o consome sem guarda própria. `content` fica
 * `unknown` porque é texto numa mensagem de texto e objeto numa de mídia, e
 * quem lê já trata as duas formas. O objeto é `loose` em todo nível: campo que
 * ninguém catalogou passa intacto em vez de derrubar a mensagem.
 */
import { z } from "zod";

import { lerEnvelope, type LeituraDeEnvelope } from "@/lib/webhooks/contrato";

const texto = z.string().nullish();
const logico = z.boolean().nullish();
/** Carimbo chega como número; aceitar texto numérico não custa e evita recusa por formato. */
const numero = z.union([z.number(), z.string()]).nullish();

export const uazapiMessageSchema = z.looseObject({
  /** `owner:messageid` — interno do servidor. */
  id: texto,
  /** Id da mensagem no WhatsApp: a chave de idempotência e o que o envio devolve. */
  messageid: texto,
  chatid: texto,
  chatlid: texto,
  sender: texto,
  senderName: texto,
  sender_pn: texto,
  sender_lid: texto,
  isGroup: logico,
  fromMe: logico,
  wasSentByApi: logico,
  messageType: texto,
  mediaType: texto,
  type: texto,
  messageTimestamp: numero,
  text: texto,
  quoted: texto,
  status: texto,
  /** Ver a regra no cabeçalho. `.optional()` é obrigatório no Zod 4 para `unknown` solto. */
  content: z.unknown().optional(),
  fileURL: texto,
});

export const uazapiChatSchema = z.looseObject({
  wa_chatid: texto,
  wa_chatlid: texto,
  wa_name: texto,
  wa_contactName: texto,
  name: texto,
  phone: texto,
});

export const uazapiEnvelopeSchema = z.looseObject({
  EventType: texto,
  BaseUrl: texto,
  instanceName: texto,
  owner: texto,
  token: texto,
  message: uazapiMessageSchema.nullish(),
  chat: uazapiChatSchema.nullish(),
});

export type UazapiEnvelope = z.infer<typeof uazapiEnvelopeSchema>;
export type UazapiMessage = z.infer<typeof uazapiMessageSchema>;

export function lerEnvelopeUazapi(rawBody: string): LeituraDeEnvelope<UazapiEnvelope> {
  return lerEnvelope(rawBody, uazapiEnvelopeSchema);
}
