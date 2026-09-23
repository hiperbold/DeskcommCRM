/**
 * Quantas respostas de IA cabem no saldo restante (fase F2-B, decisão 18):
 * consumo ponderado TOTAL da organização nos últimos 30 dias (as conferências
 * internas, embedding e visão entram no custo por resposta, de propósito,
 * porque são custo real de operar o agente, mesmo sem `agent_id` próprio) dividido
 * pelo número de RESPOSTAS do agente no mesmo período.
 *
 * ─── O que conta como "resposta do agente" ──────────────────────────────────
 *
 * `purpose = 'agent_turn'`: é o valor que `runModelCall` grava por padrão
 * (`lib/agent-engine/edge/llm/run-model-call.ts:512`,
 * `const purpose = input.purpose ?? 'agent_turn';`) e o mesmo que
 * `inbound-turn.ts:4050` passa explicitamente
 * (`purpose: preview ? 'agent_preview' : 'agent_turn'`) para toda resposta
 * REAL que o agente manda a um contato. `agent_preview` é o "Testar como
 * cliente" da tela de configuração do agente e fica fora da conta: o
 * contato nunca recebeu aquela resposta.
 *
 * ─── Sem amostra ────────────────────────────────────────────────────────────
 *
 * Zero respostas no período (organização nova, ou 30 dias sem nenhum
 * `agent_turn`): usa a mediana de referência do plano da fase (32 mil tokens
 * ponderados por resposta) e marca `baseadoEmAmostra: false`, para a tela
 * dizer "pela média de referência" em vez de fingir uma precisão que os
 * dados não sustentam.
 *
 * Nunca lança, mesma regra das irmãs desta pasta.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Logger } from "@/lib/agent-engine/obs/logger";

/** Mediana de referência quando a organização ainda não tem amostra própria (decisão 18). */
export const TOKENS_POR_RESPOSTA_PADRAO = 32_000;

/** O `purpose` gravado para toda resposta real de agente enviada a um contato. */
const PURPOSE_DA_RESPOSTA_DO_AGENTE = "agent_turn";

const JANELA_EM_DIAS = 30;

export interface EstimativaDeRespostas {
  tokensPorResposta: number;
  /** `null` quando não há saldo restante para medir contra (sem teto, ou saldo não lido). */
  respostasQueCabem: number | null;
  baseadoEmAmostra: boolean;
}

export type ResultadoEstimativaDeRespostas =
  | { status: "ok"; estimativa: EstimativaDeRespostas }
  | { status: "leitura_falhou" };

const esquemaDaLinhaDeConsumo = z
  .object({ tokens_ponderados: z.coerce.number().int() })
  .strict();

/**
 * A estimativa de respostas da organização. `saldoRestante` é
 * `totalDisponivel - totalConsumido` do saldo já lido (ver
 * `saldo-da-organizacao.ts`); `null` quando a organização não tem teto
 * (Ilimitado) ou o saldo não pôde ser lido; nesses casos `respostasQueCabem`
 * sai `null` também, nunca um número inventado. Nunca lança.
 */
export async function estimativaDeRespostas(
  admin: SupabaseClient,
  organizationId: string,
  saldoRestante: number | null,
  log?: Logger,
): Promise<ResultadoEstimativaDeRespostas> {
  try {
    const desdeTimestamp = new Date(Date.now() - JANELA_EM_DIAS * 24 * 60 * 60 * 1000);
    // O agregado é por DIA (fuso America/Sao_Paulo, o mesmo da carteira);
    // `llm_calls` não tem coluna de dia, só `created_at` (timestamptz), por
    // isso os dois filtros usam formatos diferentes do mesmo corte de 30 dias.
    const desdeDia = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Sao_Paulo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(desdeTimestamp);

    const [consumoRes, respostasRes] = await Promise.all([
      admin
        .from("billing_token_consumo_diario")
        .select("tokens_ponderados")
        .eq("organization_id", organizationId)
        .gte("dia", desdeDia),
      admin
        .from("llm_calls")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", organizationId)
        .eq("purpose", PURPOSE_DA_RESPOSTA_DO_AGENTE)
        .gte("created_at", desdeTimestamp.toISOString()),
    ]);

    if (consumoRes.error) {
      throw new Error(`ler consumo dos últimos 30 dias: ${consumoRes.error.message}`);
    }
    if (respostasRes.error) {
      throw new Error(`contar respostas do agente: ${respostasRes.error.message}`);
    }

    const linhasParseadas = z.array(esquemaDaLinhaDeConsumo).safeParse(consumoRes.data);
    if (!linhasParseadas.success) {
      throw new Error(`consumo dos últimos 30 dias fora do esquema: ${linhasParseadas.error.message}`);
    }

    const consumoTotal = linhasParseadas.data.reduce((acc, l) => acc + l.tokens_ponderados, 0);
    const respostas = respostasRes.count ?? 0;

    let tokensPorResposta: number;
    let baseadoEmAmostra: boolean;
    if (respostas > 0 && consumoTotal > 0) {
      tokensPorResposta = Math.ceil(consumoTotal / respostas);
      baseadoEmAmostra = true;
    } else {
      tokensPorResposta = TOKENS_POR_RESPOSTA_PADRAO;
      baseadoEmAmostra = false;
    }

    const respostasQueCabem =
      saldoRestante === null ? null : Math.max(0, Math.floor(saldoRestante / tokensPorResposta));

    return { status: "ok", estimativa: { tokensPorResposta, respostasQueCabem, baseadoEmAmostra } };
  } catch (err) {
    log?.error("alarme_planos_leitura", {
      organization_id: organizationId,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
    });
    return { status: "leitura_falhou" };
  }
}
