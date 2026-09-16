/**
 * O DESFECHO de uma mensagem já enviada — evento `messages_update`.
 *
 * ─── Por que é um módulo separado do `webhook.ts` ───────────────────────────
 *
 * Porque o payload é OUTRO, medido nos eventos reais da instalação. O evento de
 * mensagem traz `message` com `messageid`, `chatid` e `content`; este traz um
 * objeto `event` com `MessageIDs` (uma LISTA), `state` e `type`:
 *
 *   { EventType: "messages_update", state: "Delivered", type: "ReadReceipt",
 *     event: { MessageIDs: ["3EB0…"], Chat: "…@s.whatsapp.net", IsFromMe: true } }
 *
 * Ler os dois com o mesmo parser obrigaria um `if` no meio do caminho e faria a
 * confirmação de entrega cair no ramo de "mensagem sem identificador".
 *
 * ─── E por que ele NÃO cria linha ───────────────────────────────────────────
 *
 * A mensagem já existe: isto só move o estado dela. Inserir aqui produziria uma
 * segunda linha por transição — uma para "entregue", outra para "lida".
 */
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";

import { lerEnvelope, type LeituraDeEnvelope } from "@/lib/webhooks/contrato";

const texto = z.string().nullish();

export const uazapiAtualizacaoSchema = z.looseObject({
  EventType: texto,
  BaseUrl: texto,
  instanceName: texto,
  owner: texto,
  /** Presente nos eventos de mensagem; AUSENTE neste — ver `inbound.ts`. */
  token: texto,
  /** "Delivered", "Read", "FileDownloaded"… O vocabulário é aberto. */
  state: texto,
  /** "ReadReceipt", "FileDownloadedMessage"… */
  type: texto,
  event: z
    .looseObject({
      /** LISTA: um recibo pode confirmar várias mensagens de uma vez. */
      MessageIDs: z.array(z.string()).nullish(),
      Chat: texto,
      Sender: texto,
      Type: texto,
      IsFromMe: z.boolean().nullish(),
      IsGroup: z.boolean().nullish(),
      /** Só no evento de mídia baixada pelo servidor. */
      FileURL: texto,
      MimeType: texto,
    })
    .nullish(),
});

export type UazapiAtualizacao = z.infer<typeof uazapiAtualizacaoSchema>;

export function lerAtualizacaoUazapi(rawBody: string): LeituraDeEnvelope<UazapiAtualizacao> {
  return lerEnvelope(rawBody, uazapiAtualizacaoSchema);
}

/** O que o CRM grava em `messages.status`. */
export type DesfechoDeEntrega = "delivered" | "read";

export interface AtualizacaoLida {
  externalIds: string[];
  status: DesfechoDeEntrega;
}

export type LeituraDaAtualizacao =
  | { ok: true; atualizacao: AtualizacaoLida }
  /** O motivo vai para o arquivo do webhook: é o que se lê quando "não atualizou". */
  | { ok: false; motivo: string };

/**
 * Traduz o evento. Não lança: evento que não muda desfecho devolve o motivo, e a
 * rota responde 200 para o servidor não reentregar para sempre.
 *
 * `Played` entra como leitura: para áudio, ouvir É o equivalente de ler, e o
 * tique da tela é o mesmo. `FileDownloaded` não é desfecho de ENTREGA (é o
 * servidor avisando que guardou a mídia) e fica de fora, nomeado.
 */
export function parseUazapiAtualizacao(env: UazapiAtualizacao): LeituraDaAtualizacao {
  if ((env.EventType ?? "") !== "messages_update") return { ok: false, motivo: "evento_sem_interesse" };

  const estado = (env.state ?? "").toLowerCase();
  const status: DesfechoDeEntrega | null =
    estado === "delivered" ? "delivered" : estado === "read" || estado === "played" ? "read" : null;
  if (!status) return { ok: false, motivo: `estado_sem_interesse:${env.state ?? "vazio"}` };

  const ids = [...new Set((env.event?.MessageIDs ?? []).filter((id) => typeof id === "string" && id.length > 0))];
  if (ids.length === 0) return { ok: false, motivo: "atualizacao_sem_mensagem" };

  return { ok: true, atualizacao: { externalIds: ids, status } };
}

/**
 * Move o desfecho das mensagens que já existem.
 *
 * NÃO REBAIXA: um `delivered` atrasado depois de um `read` voltaria o tique para
 * trás, e a ordem de entrega do webhook não é garantida. Mesma regra do canal
 * intermediado.
 *
 * `atualizadas: 0` não é erro: pode ser o recibo de uma mensagem que não é
 * nossa (o número conversa por fora do CRM) ou de uma que já estava lida.
 */
export async function aplicarStatusUazapi(
  admin: SupabaseClient,
  input: { organizationId: string; externalIds: string[]; status: DesfechoDeEntrega },
): Promise<{ atualizadas: number }> {
  const { data } = await admin
    .from("messages")
    .update({ status: input.status })
    .eq("organization_id", input.organizationId)
    .in("external_id", input.externalIds)
    .not("status", "in", "(read)")
    .select("id");

  return { atualizadas: (data ?? []).length };
}
