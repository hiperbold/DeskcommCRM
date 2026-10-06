/**
 * Ler o estado de elegibilidade de uma conversa via pool `pg` (o transporte do
 * agent-engine). Uma query, três tabelas: o modo do gate do canal, as travas do
 * contato, o silêncio da conversa.
 *
 * O drain (decide ENFILEIRAR) e o turno (decide RODAR) chamam isto e passam o
 * resultado para `decidirElegibilidade` — a MESMA regra pura.
 */
import type pg from "pg";

import {
  decidirElegibilidade,
  montarEstadoDeElegibilidade,
  type DecisaoDeElegibilidade,
} from "./gate";
import {
  avisarDisjuntorDeTurnosAberto,
  contarTurnosDeIaDoContato,
  numeroEhDeCanalDaInstalacao,
} from "./laco-de-robos";

interface LinhaDeElegibilidade {
  contact_id: string;
  channel_metadata: Record<string, unknown> | null;
  force_human: boolean | null;
  assignee_kind: string | null;
  bot_silenced_until: Date | string | null;
  ai_authorized_at: Date | string | null;
  phone_number: string | null;
}

/**
 * Roda a query e a regra. `null` = conversa não encontrada (deixe o chamador
 * decidir; o drain trata como "sem gate", segue o fluxo antigo).
 *
 * `tetoDeTurnosPorHora` liga o disjuntor de dois robôs (D-158): ausente ou 0 =
 * desligado. O remetente que é número de canal da instalação NÃO depende dele,
 * vale sempre. Quando o disjuntor decide o veto, o aviso na Central abre aqui
 * mesmo, porque o drain e o turno chegam por esta mesma porta.
 */
export async function decidirElegibilidadeDaConversa(
  pool: pg.Pool,
  input: {
    organizationId: string;
    conversationId: string;
    agora: Date;
    ttlMs: number;
    tetoDeTurnosPorHora?: number;
  },
): Promise<DecisaoDeElegibilidade | null> {
  const { rows } = await pool.query<LinhaDeElegibilidade>(
    `select
       cv.contact_id                as contact_id,
       cs.metadata                  as channel_metadata,
       ct.force_human               as force_human,
       cv.assignee_kind             as assignee_kind,
       cv.bot_silenced_until        as bot_silenced_until,
       ct.ai_authorized_at          as ai_authorized_at,
       ct.phone_number              as phone_number
     from conversations cv
     join contacts ct
       on ct.id = cv.contact_id and ct.organization_id = cv.organization_id
     join channel_sessions cs
       on cs.id = cv.channel_session_id and cs.organization_id = cv.organization_id
     where cv.organization_id = $1 and cv.id = $2`,
    [input.organizationId, input.conversationId],
  );
  const r = rows[0];
  if (r === undefined) return null;

  // As leituras do D-158 só valem a pena quando os vetos baratos ainda deixariam
  // a IA responder; o canal é lido antes porque não depende de contagem.
  const remetenteEhCanal = await numeroEhDeCanalDaInstalacao(pool, r.phone_number);
  const teto = input.tetoDeTurnosPorHora ?? 0;
  const turnos =
    teto > 0 && !remetenteEhCanal
      ? await contarTurnosDeIaDoContato(pool, {
          organizationId: input.organizationId,
          contactId: r.contact_id,
          agora: input.agora,
        })
      : undefined;

  const decisao = decidirElegibilidade(
    montarEstadoDeElegibilidade({
      aiGate: r.channel_metadata?.ai_gate,
      aiGateMode: r.channel_metadata?.ai_gate_mode,
      aiTestPhoneNumbers: r.channel_metadata?.ai_test_phone_numbers,
      contactPhoneNumber: r.phone_number,
      forceHuman: r.force_human,
      assigneeKind: r.assignee_kind,
      botSilencedUntil: r.bot_silenced_until,
      aiAuthorizedAt: r.ai_authorized_at,
      agora: input.agora,
      ttlMs: input.ttlMs,
      remetenteEhCanalDaInstalacao: remetenteEhCanal,
      ...(turnos !== undefined ? { turnosDeIaNaUltimaHora: turnos, tetoDeTurnosPorHora: teto } : {}),
    }),
  );

  if (decisao.motivo === "disjuntor_de_turnos" && turnos !== undefined) {
    await avisarDisjuntorDeTurnosAberto(pool, {
      organizationId: input.organizationId,
      conversationId: input.conversationId,
      turnos,
      teto,
    });
  }
  return decisao;
}
