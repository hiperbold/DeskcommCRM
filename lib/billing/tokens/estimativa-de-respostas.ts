/**
 * Quantas respostas de IA cabem no saldo restante (fase F2-B, decisão 18):
 * consumo ponderado TOTAL da organização nos últimos 30 dias (as conferências
 * internas, embedding e visão entram no custo por resposta, de propósito,
 * porque são custo real de operar o agente, mesmo sem `agent_id` próprio) dividido
 * pelo número de RESPOSTAS do agente no mesmo período.
 *
 * Os dois números vêm de `fn_billing_consumo_para_estimativa` (Parte 6, item
 * 1d da revisão de 23/09/2026), agregados NO BANCO: a versão anterior deste
 * módulo trazia `billing_token_consumo_diario` linha a linha e somava no Node,
 * e o PostgREST corta em `max_rows = 1000` (mesmo defeito do extrato,
 * `extrato-do-ciclo.ts`). A RPC também conta "resposta" pela mesma regra de
 * `job_id` descrita abaixo, e não só por `count` de `llm_calls`.
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
 * contato nunca recebeu aquela resposta. Uma resposta pode gerar VÁRIAS
 * chamadas (uso de ferramenta no meio do turno, mesmo `job_id`): a RPC conta
 * uma por `job_id` quando houver, uma por linha quando `job_id` for nulo.
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

/**
 * Janela de dias que `fn_billing_consumo_para_estimativa` (Parte 6, item 1d)
 * usa para o `p_dias`: a RPC filtra `purpose = 'agent_turn'` por conta
 * própria, não este módulo (ver comentário do arquivo).
 */
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

/** O formato exato de `fn_billing_consumo_para_estimativa` (Parte 6, item 1d da revisão). */
const esquemaDoConsumoParaEstimativa = z
  .object({ tokens_ponderados: z.coerce.number().int(), respostas: z.coerce.number().int() })
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
    const { data, error } = await admin.rpc("fn_billing_consumo_para_estimativa", {
      p_org: organizationId,
      p_dias: JANELA_EM_DIAS,
    });

    if (error) {
      throw new Error(`ler consumo para estimativa de respostas: ${error.message}`);
    }

    const parsed = esquemaDoConsumoParaEstimativa.safeParse(data);
    if (!parsed.success) {
      throw new Error(`consumo para estimativa de respostas fora do esquema: ${parsed.error.message}`);
    }

    const consumoTotal = parsed.data.tokens_ponderados;
    const respostas = parsed.data.respostas;

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
