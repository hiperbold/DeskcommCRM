/**
 * Travas do motor de regras contra laço e contra evento velho (D-114).
 *
 * ─── O laço ────────────────────────────────────────────────────────────────
 *
 * Regra `message.failed` → `send_whatsapp_message` (ou `send_ai_message`): a
 * mensagem da regra falha (131047 da Meta, `send_timeout`), a falha assíncrona
 * emite `message.failed` SEM `caused_by_rule` (quem emite é o webhook da Meta ou
 * o cron de mensagens presas, que não sabem de regra nenhuma), e o motor roda a
 * regra de novo, para sempre. Com IA, cada volta é uma chamada paga.
 *
 * Duas travas, de natureza diferente:
 *  - a ORIGEM: falha de mensagem que a própria automação mandou não é gatilho
 *    (`sent_via = 'automation'` já vem no payload do evento);
 *  - o TETO: mesmo que uma origem escape da primeira, o mesmo contato não passa
 *    de N falhas processadas por hora.
 *
 * ─── O evento velho ────────────────────────────────────────────────────────
 *
 * O drain reprocessa evento antigo (backlog depois de deploy, evento preso em
 * `processing`) e o motor não lia `created_at`: a regra disparava com dias de
 * atraso. Cada gatilho tem a sua idade máxima.
 */

const HORA_MS = 60 * 60 * 1000;

/** Falhas de mensagem do mesmo contato aceitas por hora antes do disjuntor abrir. */
export const TETO_FALHAS_POR_CONTATO_POR_HORA = 5;

/** `message.failed` perde o sentido horas depois: responder a uma falha de ontem é ruído. */
const IDADE_MAXIMA_POR_GATILHO_MS: Record<string, number> = {
  "message.failed": 12 * HORA_MS,
};

/**
 * Padrão dos demais: cobre a espera da janela de envio (o evento adiado volta
 * com o `created_at` original) e um fim de semana de fila parada, mas não uma
 * semana de backlog.
 */
const IDADE_MAXIMA_PADRAO_MS = 72 * HORA_MS;

export function idadeMaximaDoEventoMs(eventType: string): number {
  return IDADE_MAXIMA_POR_GATILHO_MS[eventType] ?? IDADE_MAXIMA_PADRAO_MS;
}

/**
 * Evento velho demais para disparar regra.
 *
 * Falha ABERTO sem `created_at` ou com data ilegível: sem a idade não dá para
 * afirmar que o evento é velho, e descartar na dúvida perderia um evento bom.
 */
export function eventoVelhoDemais(eventType: string, createdAt: string | undefined, agora = Date.now()): boolean {
  if (!createdAt) return false;
  const criado = Date.parse(createdAt);
  if (!Number.isFinite(criado)) return false;
  return agora - criado > idadeMaximaDoEventoMs(eventType);
}

/** Origem das mensagens que o próprio motor manda (`messages.sent_via`). */
export function falhaDeMensagemDaAutomacao(eventType: string, payload: Record<string, unknown> | null | undefined): boolean {
  return eventType === "message.failed" && payload?.sent_via === "automation";
}
