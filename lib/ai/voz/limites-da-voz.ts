/**
 * Teto, carteira, orçamento e registro de custo da voz em tempo real (D-117).
 *
 * ─── O defeito ─────────────────────────────────────────────────────────────
 *
 * `workers/voice-agent` abre uma sessão Realtime da OpenAI para cada ligação.
 * Quando a organização não cadastrou chave própria, quem paga é a Hiperbold (a
 * chave do `.env` da instalação), e nada disso passava por `llm_calls`,
 * `ai_budgets` ou carteira: qualquer pessoa podia ligar e ficar horas na linha,
 * sem timer de encerramento e sem uma linha de custo em lugar nenhum.
 *
 * ─── O que este módulo faz ─────────────────────────────────────────────────
 *
 *  1. TETO DE DURAÇÃO por chamada, e por organização em 24 h quando a chave é da
 *     instalação (a chave própria já é paga por quem a cadastrou);
 *  2. a CARTEIRA de tokens e o ORÇAMENTO em dólar são consultados ANTES de
 *     atender, com a mesma decisão pura do caminho de texto
 *     (`decidirOrcamento`, `deveConsultarCarteira`): uma régua só;
 *  3. cada ligação grava uma linha em `llm_calls` com a ORIGEM DA CHAVE e a
 *     duração. `cost_cents` fica nulo: o catálogo não precifica por minuto de
 *     áudio, e nulo é "preço desconhecido", nunca "de graça".
 *
 * Toda leitura que falha SEGUE a ligação (fail-open, como o resto da cobrança):
 * a causa vai para o log, e o teto de duração, que não depende de banco,
 * continua valendo.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { VeredictoDaCarteira } from "@/lib/agent-engine/edge/llm/carteira";
import type { Veredito } from "@/lib/agent-engine/edge/llm/orcamento";
import { veredictoDaCarteira, veredictoDoOrcamento } from "@/lib/ai/gate-de-custo";
import { logger } from "@/lib/logger";

export const PURPOSE_VOZ = "voz_em_tempo_real";

/** O `reason` de `onCallEnded` quando o teto de duração derruba a ligação. */
export const MOTIVO_LIMITE_DE_DURACAO = "limite de duração";

export type OrigemDaChaveDaVoz = "chave_da_instalacao" | "credencial_da_organizacao";

/** 15 minutos: ligação de atendimento que passa disso quase sempre é linha esquecida aberta. */
const TETO_DA_CHAMADA_PADRAO_S = 15 * 60;
/** 2 horas de voz por organização em 24 h na chave da instalação. */
const TETO_DO_DIA_PADRAO_MIN = 120;
const DIA_MS = 24 * 60 * 60 * 1000;

function inteiroPositivo(bruto: string | undefined, padrao: number): number {
  const n = Number(bruto);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : padrao;
}

/** `VOICE_MAX_CALL_SECONDS`, em ms. Valor ausente, zero ou lixo cai no padrão: sem teto nunca é uma opção. */
export function tetoDaChamadaMs(env: Record<string, string | undefined> = process.env): number {
  return inteiroPositivo(env.VOICE_MAX_CALL_SECONDS, TETO_DA_CHAMADA_PADRAO_S) * 1000;
}

/** `VOICE_MAX_ORG_MINUTES_PER_DAY`, em ms. */
export function tetoDoDiaMs(env: Record<string, string | undefined> = process.env): number {
  return inteiroPositivo(env.VOICE_MAX_ORG_MINUTES_PER_DAY, TETO_DO_DIA_PADRAO_MIN) * 60_000;
}

export type MotivoDaRecusaDaVoz = "teto_diario_de_voz" | "carteira_de_tokens_zerada" | "orcamento_de_ia_atingido";

export type DecisaoDaVoz =
  | { atender: true; maxMs: number }
  | { atender: false; motivo: MotivoDaRecusaDaVoz };

export interface EntradaDaVoz {
  origemDaChave: OrigemDaChaveDaVoz;
  /** Soma das ligações com IA da organização nas últimas 24 h. */
  usadoNoDiaMs: number;
  tetoDoDiaMs: number;
  tetoDaChamadaMs: number;
  /** `null` = a carteira não foi consultada (não se aplica, ou a leitura falhou). */
  carteira: VeredictoDaCarteira | null;
  /** `null` = o orçamento não foi consultado ou a leitura falhou. */
  orcamento: Veredito | null;
}

/**
 * A decisão, pura. Recusa só nos vetos explícitos; senão atende com o tempo que
 * resta: o teto da chamada, e na chave da instalação também o que sobra do dia.
 */
export function decidirAtendimentoDaVoz(e: EntradaDaVoz): DecisaoDaVoz {
  const daInstalacao = e.origemDaChave === "chave_da_instalacao";
  const restanteDoDia = e.tetoDoDiaMs - e.usadoNoDiaMs;

  if (daInstalacao && restanteDoDia <= 0) return { atender: false, motivo: "teto_diario_de_voz" };
  if (e.carteira?.acao === "bloquear") return { atender: false, motivo: "carteira_de_tokens_zerada" };
  if (e.orcamento?.acao === "bloquear") return { atender: false, motivo: "orcamento_de_ia_atingido" };

  return {
    atender: true,
    maxMs: daInstalacao ? Math.min(e.tetoDaChamadaMs, restanteDoDia) : e.tetoDaChamadaMs,
  };
}

async function usadoNoDiaMs(admin: SupabaseClient, organizationId: string, agora: Date): Promise<number> {
  const { data, error } = await admin
    .from("voice_calls")
    .select("duration_ms")
    .eq("organization_id", organizationId)
    .eq("handled_by", "ai")
    .gte("started_at", new Date(agora.getTime() - DIA_MS).toISOString())
    .limit(1000);
  if (error) throw new Error(`ler voice_calls: ${error.message}`);
  return ((data ?? []) as Array<{ duration_ms: number | null }>).reduce(
    (soma, l) => soma + (l.duration_ms ?? 0),
    0,
  );
}

/**
 * Pode atender esta ligação com IA, e por quanto tempo? Chamada ANTES de abrir a
 * sessão Realtime. Leitura que falha segue (fail-open) com o teto de duração.
 */
export async function verificarAtendimentoDaVoz(
  admin: SupabaseClient,
  d: { organizationId: string; origemDaChave: OrigemDaChaveDaVoz; agora?: Date },
): Promise<DecisaoDaVoz> {
  const agora = d.agora ?? new Date();
  const base = {
    origemDaChave: d.origemDaChave,
    usadoNoDiaMs: 0,
    tetoDoDiaMs: tetoDoDiaMs(),
    tetoDaChamadaMs: tetoDaChamadaMs(),
    carteira: null as VeredictoDaCarteira | null,
    orcamento: null as Veredito | null,
  };
  const tentar = async <T>(etapa: string, fn: () => Promise<T>, padrao: T): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      logger.warn("[voice-agent] leitura de limite da voz falhou: a ligação SEGUE", {
        organization_id: d.organizationId,
        etapa,
        error: err instanceof Error ? err.message : String(err),
      });
      return padrao;
    }
  };
  base.usadoNoDiaMs = await tentar("minutos_do_dia", () => usadoNoDiaMs(admin, d.organizationId, agora), 0);
  base.carteira = await tentar("carteira", () => veredictoDaCarteira(admin, d.organizationId, d.origemDaChave, PURPOSE_VOZ), null);
  base.orcamento = await tentar("orcamento", () => veredictoDoOrcamento(admin, d.organizationId, PURPOSE_VOZ, agora), null);
  return decidirAtendimentoDaVoz(base);
}

/**
 * Registra a ligação em `llm_calls`: origem da chave e duração, sem custo (ver o
 * cabeçalho). Nunca lança: perder a linha não pode derrubar o fechamento da
 * chamada, mas a falha vai para o log.
 */
export async function registrarUsoDaVoz(
  admin: SupabaseClient,
  d: {
    organizationId: string;
    model: string;
    origemDaChave: OrigemDaChaveDaVoz;
    duracaoMs: number;
  },
): Promise<void> {
  try {
    const { error } = await admin.from("llm_calls").insert({
      organization_id: d.organizationId,
      purpose: PURPOSE_VOZ,
      provider: "openai",
      model: d.model || "desconhecido",
      input_tokens: 0,
      output_tokens: 0,
      cost_cents: null,
      latency_ms: Math.max(0, Math.round(d.duracaoMs)),
      origem_da_chave: d.origemDaChave,
    });
    if (error) {
      logger.warn("[voice-agent] não foi possível registrar o uso da voz", {
        organization_id: d.organizationId,
        error: error.message,
      });
    }
  } catch (err) {
    logger.warn("[voice-agent] registrar o uso da voz lançou", {
      organization_id: d.organizationId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
