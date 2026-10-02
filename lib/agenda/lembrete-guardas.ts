/**
 * As guardas do cron de lembrete de agenda (D-115).
 *
 * `cron/agenda-reminder` roda a cada 5 minutos, mas o curl do agendador corta em
 * 45 s e a ROTA CONTINUA: com cerca de 200 compromissos e o espaçamento de 1,2 a 2 s
 * entre envios, uma rodada passa de 5 minutos, e a seguinte lê os mesmos
 * compromissos, ainda sem carimbo. O carimbo só era gravado DEPOIS do envio, e o
 * erro do update nem era conferido: o cliente recebia o mesmo lembrete a cada 5
 * minutos até a hora do compromisso.
 *
 * O conserto é reservar o degrau ANTES de enviar, com compare-and-swap sobre o
 * valor lido: quem perde a corrida não manda nada. É mais forte que um lock por
 * rodada, porque vale por compromisso e também cobre duas instâncias do app.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { sessaoProntaParaEnvio } from "@/lib/automation/start-conversation";
import { transportaMensagem } from "@/lib/channels/capabilities";
import { logger } from "@/lib/logger";

/** Literal de array do Postgres (`{1440,180}`) na ordem em que o valor está gravado. */
function literalDeArray(valores: number[]): string {
  return `{${valores.join(",")}}`;
}

export interface ReservaDoLembrete {
  appointmentId: string;
  organizationId: string;
  /** O que a linha tinha quando a rodada a leu: é a condição do compare-and-swap. */
  lidos: number[] | null;
  /** Os degraus vencidos que esta rodada vai cumprir com UMA mensagem. */
  pendentes: number[];
}

/**
 * Reserva os degraus vencidos antes do envio.
 *
 * `true` = esta rodada ganhou e pode enviar. `false` = outra rodada chegou
 * primeiro (ou o update falhou): NÃO enviar. Falhar fechado é o lado barato: o
 * degrau não reservado volta na rodada seguinte, e lembrete repetido é o que
 * faz o cliente bloquear o número.
 */
export async function reservarDegraus(
  admin: SupabaseClient,
  reserva: ReservaDoLembrete,
): Promise<{ reservado: boolean; gravados: number[] }> {
  const gravados = [...new Set([...(reserva.lidos ?? []), ...reserva.pendentes])];
  let q = admin
    .from("calendar_appointments")
    .update({
      reminder_sent_at: new Date().toISOString(),
      reminder_sent_offsets_minutes: gravados,
    })
    .eq("id", reserva.appointmentId)
    .eq("organization_id", reserva.organizationId);
  q =
    reserva.lidos === null
      ? q.is("reminder_sent_offsets_minutes", null)
      : q.eq("reminder_sent_offsets_minutes", literalDeArray(reserva.lidos));
  const { data, error } = await q.select("id");
  if (error) {
    logger.error("[agenda-reminder] não foi possível reservar o degrau do lembrete", {
      appointmentId: reserva.appointmentId,
      error: error.message,
    });
    return { reservado: false, gravados };
  }
  return { reservado: (data ?? []).length > 0, gravados };
}

/**
 * Devolve a reserva quando o envio nem chegou a ser tentado (exceção antes de
 * `sendMessageHandler` devolver). Só desfaz se a linha ainda está como esta
 * rodada a deixou: não pisa em rodada que veio depois.
 */
export async function liberarReserva(
  admin: SupabaseClient,
  reserva: ReservaDoLembrete,
  gravados: number[],
): Promise<void> {
  const { error } = await admin
    .from("calendar_appointments")
    .update({ reminder_sent_offsets_minutes: reserva.lidos })
    .eq("id", reserva.appointmentId)
    .eq("organization_id", reserva.organizationId)
    .eq("reminder_sent_offsets_minutes", literalDeArray(gravados));
  if (error) {
    logger.error("[agenda-reminder] não foi possível devolver a reserva do lembrete", {
      appointmentId: reserva.appointmentId,
      error: error.message,
    });
  }
}

/**
 * Por qual canal o lembrete sai.
 *
 * O número em que o contato JÁ conversa (a conversa mais recente dele, com o
 * canal vivo e de mensagem) e, sem conversa, a sessão pronta da organização.
 * O `.limit(1)` sem ordem e sem filtro de provider que havia aqui podia escolher
 * a linha de VOZ, ou um número diferente do da conversa, abrindo conversa nova
 * ou falhando o envio.
 */
export async function canalDoLembrete(
  admin: SupabaseClient,
  organizationId: string,
  contactId: string,
): Promise<string | null> {
  const { data: conversas } = await admin
    .from("conversations")
    .select("channel_session_id")
    .eq("organization_id", organizationId)
    .eq("contact_id", contactId)
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(10);

  const candidatas: string[] = [];
  for (const c of (conversas ?? []) as Array<{ channel_session_id: string | null }>) {
    if (c.channel_session_id && !candidatas.includes(c.channel_session_id)) {
      candidatas.push(c.channel_session_id);
    }
  }
  const fallback = await sessaoProntaParaEnvio(admin, organizationId);
  if (fallback && !candidatas.includes(fallback)) candidatas.push(fallback);
  if (candidatas.length === 0) return null;

  const { data: sessoes } = await admin
    .from("channel_sessions")
    .select("id, provider, status")
    .eq("organization_id", organizationId)
    .in("id", candidatas);
  const vivas = new Set(
    ((sessoes ?? []) as Array<{ id: string; provider: string | null; status: string | null }>)
      .filter((s) => s.status === "WORKING" && transportaMensagem(s.provider))
      .map((s) => s.id),
  );
  return candidatas.find((id) => vivas.has(id)) ?? null;
}

/**
 * O fuso em que a hora do lembrete é escrita: o do COMPROMISSO (gravado com o
 * fuso da jornada), e só na falta dele o da organização. Com o da organização, o
 * cliente de outro fuso recebia "amanhã às 15:00" para uma consulta às 14:00.
 */
export function fusoDoLembrete(
  fusoDoCompromisso: string | null | undefined,
  fusoDaOrganizacao: string | null | undefined,
): string {
  const valido = (tz: string | null | undefined): tz is string => {
    if (!tz) return false;
    try {
      new Intl.DateTimeFormat(undefined, { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  };
  if (valido(fusoDoCompromisso)) return fusoDoCompromisso;
  if (valido(fusoDaOrganizacao)) return fusoDaOrganizacao;
  return "America/Sao_Paulo";
}

/** Organização que pode receber produtor automático (`organizations.status`). */
export function organizacaoPodeReceberLembrete(status: string | null | undefined): boolean {
  return status === "active";
}
