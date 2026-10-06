/**
 * O GATE DE ELEGIBILIDADE DA IA — "deny by default" por canal.
 *
 * ─── Por que este arquivo existe ────────────────────────────────────────────
 *
 * O DeskcommCRM responde `allow by default`: publicou um agente para a sessão de
 * WhatsApp, a IA atende TODO mundo que mandar mensagem. Isso é o certo para o
 * lojista cujo número existe só para vender. É o ERRADO para quem usa o mesmo
 * número para falar com cliente atual, fornecedor e contato pessoal — a IA
 * assume conversa que era de gente.
 *
 * Canais existentes preservam o gate opt-in. Novos canais criados pelo produto
 * nascem no modo de teste (issue #573), configurável na Central de Conexões.
 * Fonte: `channel_sessions.metadata.ai_gate`.
 *
 *   'open' (ausente / default)  → comportamento de hoje, nenhuma checagem nova.
 *   'allowlist'                 → a IA só responde quando há uma condição
 *                                 POSITIVA de elegibilidade no contato.
 *
 * ─── A regra é pura ─────────────────────────────────────────────────────────
 *
 * `decidirElegibilidade` não toca banco: recebe o estado já lido (gate do canal,
 * flags do contato, silêncio da conversa) e devolve `permite` + `motivo`. Os
 * dois consumidores — o drain (`lib/agent-engine/edge/crm/drain.ts`, que decide
 * ENFILEIRAR) e o turno (`lib/agent-engine/agent/inbound-turn.ts`, que decide
 * RODAR) — chamam a MESMA função. Regra duplicada nos dois lados divergiria na
 * primeira vez que alguém acrescentasse um motivo.
 *
 * ─── O que NÃO torna um contato elegível ────────────────────────────────────
 *
 * Mensagem nova sozinha. Conversa aberta. Conversa sem responsável. Conversa
 * aguardando resposta. Histórico. Cliente antigo. `channel_session` existir.
 * Nada disso. No modo de teste, somente a lista de números do canal. No
 * allowlist por origem, `contacts.ai_authorized_at` — carimbado por uma origem
 * elegível (webhook do Respondi, match de campanha, ação de automação, retomada
 * manual pela tela) e dentro da janela de validade.
 */
import {
  AI_GATE_PRE_GO_LIVE,
  lerNumerosDeTeste,
  numeroPodeTestar,
} from "./pre-go-live";

/** Valores aceitos em `channel_sessions.metadata.ai_gate`. */
export const AI_GATE_MODES = ["open", "allowlist"] as const;
export type AiGateMode = (typeof AI_GATE_MODES)[number];

/**
 * Normaliza o valor cru do jsonb para um modo conhecido. Ausente, `null`,
 * string desconhecida → `'open'` (o padrão seguro: não muda o comportamento de
 * quem nunca configurou nada).
 */
export function lerModoDoGate(raw: unknown): AiGateMode {
  return raw === "allowlist" ? "allowlist" : "open";
}

export interface EstadoDeElegibilidade {
  /** `channel_sessions.metadata.ai_gate` já normalizado. */
  modo: AiGateMode;
  /** `contacts.force_human` — a trava irrevogável pelo agente (regra dura 2). */
  forceHuman: boolean;
  /** `conversations.bot_silenced_until` (ou o da conversa em questão). `'infinity'` do Postgres vira `Infinity`. */
  botSilencedUntil: Date | number | null;
  /** `conversations.assignee_kind` — `'user'` = uma pessoa é a dona do thread. */
  assigneeKind: string | null;
  /** `contacts.ai_authorized_at`. `null` = nunca autorizado. */
  aiAuthorizedAt: Date | null;
  /** O allowlist representa o período de teste deste canal. */
  preGoLiveAtivo: boolean;
  /** O telefone da conversa está na lista durável de testadores do canal. */
  numeroDeTesteAutorizado: boolean;
  /** Agora, injetável para teste. */
  agora: Date;
  /** Janela de validade da autorização (`AI_ALLOWLIST_TTL_DAYS` em ms). */
  ttlMs: number;
  /**
   * O telefone do contato é o número de um canal da instalação (desta
   * organização ou de outra): quem escreve é o OUTRO robô, e responder abre o
   * laço de dois agentes (D-158). Ausente = não sabe, trata como `false`
   * (consumidores que não leem o canal, como a entrega do Meet, seguem como
   * antes).
   */
  remetenteEhCanalDaInstalacao?: boolean;
  /** Turnos de IA do contato na última hora (D-158). Ausente = não contado. */
  turnosDeIaNaUltimaHora?: number;
  /** Teto de turnos por contato por hora. Ausente ou 0 = disjuntor desligado. */
  tetoDeTurnosPorHora?: number;
}

export type MotivoDeElegibilidade =
  | "gate_aberto"
  | "force_human"
  | "conversa_silenciada"
  | "conversa_de_humano"
  | "remetente_e_canal_da_instalacao"
  | "disjuntor_de_turnos"
  | "fora_da_lista_de_teste"
  | "numero_de_teste"
  | "sem_autorizacao"
  | "autorizacao_expirada"
  | "autorizado";

export interface DecisaoDeElegibilidade {
  permite: boolean;
  motivo: MotivoDeElegibilidade;
  /**
   * `true` quando o motivo do NÃO é específico do gate 'allowlist'
   * (sem_autorizacao / autorizacao_expirada). O drain usa isto para não gastar
   * um job; o turno, para logar como "conversa não autorizada" e não como erro.
   */
  bloqueioPorAllowlist: boolean;
}

function silenciadoAgora(until: Date | number | null, agora: Date): boolean {
  if (until === null) return false;
  const t = typeof until === "number" ? until : until.getTime();
  return t > agora.getTime();
}

/**
 * O disjuntor de turnos de IA por contato por hora (D-158). Só abre com a
 * contagem E o teto informados: quem não leu o histórico não derruba a IA.
 */
function disjuntorDeTurnosAberto(e: EstadoDeElegibilidade): boolean {
  const teto = e.tetoDeTurnosPorHora;
  const turnos = e.turnosDeIaNaUltimaHora;
  if (teto === undefined || teto <= 0 || turnos === undefined) return false;
  return turnos >= teto;
}

/**
 * A decisão. Vetos que valem SEMPRE (mesmo com o gate aberto) vêm primeiro —
 * eles já eram lidos pelo motor (`isLeadInHandoff`, `skip("assigned_to_human")`)
 * e continuam valendo. O gate 'allowlist' só ACRESCENTA a exigência de
 * autorização positiva.
 */
export function decidirElegibilidade(e: EstadoDeElegibilidade): DecisaoDeElegibilidade {
  if (e.forceHuman) {
    return { permite: false, motivo: "force_human", bloqueioPorAllowlist: false };
  }
  if (silenciadoAgora(e.botSilencedUntil, e.agora)) {
    return { permite: false, motivo: "conversa_silenciada", bloqueioPorAllowlist: false };
  }
  if (e.assigneeKind === "user") {
    return { permite: false, motivo: "conversa_de_humano", bloqueioPorAllowlist: false };
  }
  // Dois robôs conversando (D-158): vale em QUALQUER modo do gate, como os
  // vetos acima. O primeiro é a causa (o remetente é um canal nosso); o
  // segundo é a rede para o laço que a primeira checagem não enxerga (a
  // resposta automática de outra empresa).
  if (e.remetenteEhCanalDaInstalacao === true) {
    return { permite: false, motivo: "remetente_e_canal_da_instalacao", bloqueioPorAllowlist: false };
  }
  if (disjuntorDeTurnosAberto(e)) {
    return { permite: false, motivo: "disjuntor_de_turnos", bloqueioPorAllowlist: false };
  }

  if (e.modo === "open") {
    return { permite: true, motivo: "gate_aberto", bloqueioPorAllowlist: false };
  }

  // No pré-go-live, a lista do canal é a ÚNICA autorização positiva. O carimbo
  // global do contato pode ter vindo de campanha/automação e não pode furar a
  // promessa de que o número ainda está fechado ao público.
  if (e.preGoLiveAtivo) {
    return e.numeroDeTesteAutorizado
      ? { permite: true, motivo: "numero_de_teste", bloqueioPorAllowlist: false }
      : { permite: false, motivo: "fora_da_lista_de_teste", bloqueioPorAllowlist: true };
  }

  // modo 'allowlist': exige condição positiva.
  if (e.aiAuthorizedAt === null) {
    return { permite: false, motivo: "sem_autorizacao", bloqueioPorAllowlist: true };
  }
  const idadeMs = e.agora.getTime() - e.aiAuthorizedAt.getTime();
  if (idadeMs > e.ttlMs) {
    return { permite: false, motivo: "autorizacao_expirada", bloqueioPorAllowlist: true };
  }
  return { permite: true, motivo: "autorizado", bloqueioPorAllowlist: false };
}

/** Default da janela de validade da autorização, em dias. Knob: `AI_ALLOWLIST_TTL_DAYS`. */
export const AI_ALLOWLIST_TTL_DAYS_DEFAULT = 21;

/** Lê o knob do ambiente (dias → ms). Valor ausente/inválido → default. */
export function ttlDaAutorizacaoMs(env: Record<string, string | undefined>): number {
  const raw = env.AI_ALLOWLIST_TTL_DAYS;
  const dias = raw !== undefined && raw !== "" ? Number(raw) : NaN;
  const efetivo = Number.isFinite(dias) && dias > 0 ? dias : AI_ALLOWLIST_TTL_DAYS_DEFAULT;
  return efetivo * 24 * 60 * 60 * 1000;
}

/**
 * Normaliza um instante cru de qualquer transporte para o que `silenciadoAgora`
 * entende: `Date`, `Infinity` (o `'infinity'` do Postgres, que o `pg` devolve
 * como string e o supabase-js também) ou `null`. String de data inválida → `null`.
 */
export function normalizarInstante(v: Date | string | number | null | undefined): Date | number | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v === "number") return v;
  if (v === "infinity") return Number.POSITIVE_INFINITY;
  if (v === "-infinity") return Number.NEGATIVE_INFINITY;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Monta o `EstadoDeElegibilidade` a partir dos campos crus lidos do banco — a
 * MESMA normalização para os dois transportes (`consulta-pg.ts` via pool `pg` e
 * `consulta-supabase.ts` via supabase-js). Uma cópia por transporte divergiria
 * na primeira vez que alguém tratasse `'infinity'` num lado e esquecesse do
 * outro. Não roda a regra — só normaliza; quem decide é `decidirElegibilidade`.
 */
export function montarEstadoDeElegibilidade(raw: {
  aiGate: unknown;
  aiGateMode?: unknown;
  aiTestPhoneNumbers?: unknown;
  contactPhoneNumber?: string | null;
  forceHuman: unknown;
  assigneeKind: string | null;
  botSilencedUntil: Date | string | number | null | undefined;
  aiAuthorizedAt: Date | string | null | undefined;
  agora: Date;
  ttlMs: number;
  remetenteEhCanalDaInstalacao?: boolean;
  turnosDeIaNaUltimaHora?: number;
  tetoDeTurnosPorHora?: number;
}): EstadoDeElegibilidade {
  const autorizadoEm = normalizarInstante(raw.aiAuthorizedAt);
  const modo = lerModoDoGate(raw.aiGate);
  const preGoLive = modo === "allowlist" && raw.aiGateMode === AI_GATE_PRE_GO_LIVE;
  const numerosDeTeste = lerNumerosDeTeste({ ai_test_phone_numbers: raw.aiTestPhoneNumbers });
  return {
    modo,
    forceHuman: raw.forceHuman === true,
    botSilencedUntil: normalizarInstante(raw.botSilencedUntil),
    assigneeKind: raw.assigneeKind,
    aiAuthorizedAt: autorizadoEm instanceof Date ? autorizadoEm : null,
    preGoLiveAtivo: preGoLive,
    numeroDeTesteAutorizado:
      preGoLive && numeroPodeTestar(raw.contactPhoneNumber, numerosDeTeste),
    agora: raw.agora,
    ttlMs: raw.ttlMs,
    ...(raw.remetenteEhCanalDaInstalacao !== undefined
      ? { remetenteEhCanalDaInstalacao: raw.remetenteEhCanalDaInstalacao }
      : {}),
    ...(raw.turnosDeIaNaUltimaHora !== undefined
      ? { turnosDeIaNaUltimaHora: raw.turnosDeIaNaUltimaHora }
      : {}),
    ...(raw.tetoDeTurnosPorHora !== undefined ? { tetoDeTurnosPorHora: raw.tetoDeTurnosPorHora } : {}),
  };
}
