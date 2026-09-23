/**
 * O painel de margem da carteira de tokens de IA (fase F2-B, decisão 17):
 * SÓ para a plataforma, nunca para a organização (a mesma régua de "livro-
 * caixa e adicionais: privilégio nenhum para authenticated", decisão 19).
 *
 * Por organização e ciclo ATUAL, tudo calculado NO BANCO por
 * `fn_billing_margem_do_ciclo` (Parte 6, item 1c da revisão de 23/09/2026):
 *
 *   receita = preço mensal do plano contratado (`billing_contracts` →
 *             `billing_plans.price_monthly_cents`) + `valor_cents` dos
 *             adicionais ATIVOS (`billing_token_adicionais`) + `valor_cents`
 *             dos créditos avulsos DO CICLO (linhas `credito:` do livro-caixa
 *             no ciclo), tudo em CENTAVOS DE REAL.
 *
 *   custo   = soma de `cost_cents` CONHECIDO de `llm_calls` do ciclo (o que a
 *             Hiperbold paga de verdade), mais uma ESTIMATIVA pelo catálogo
 *             `ai_models` para as chamadas com `cost_cents` nulo, mais a
 *             contagem das que nem o catálogo sabe precificar.
 *
 * A versão anterior deste módulo trazia `billing_token_consumo_diario` linha
 * a linha e somava no Node (mesmo defeito do extrato e do livro-caixa: corte
 * de `max_rows = 1000` do PostgREST) e filtrava os créditos avulsos com o
 * mesmo offset `-03:00` fixo de `livro-caixa-do-ciclo.ts`. A RPC também é
 * quem agora estima o custo das chamadas sem preço, que antes este painel só
 * contava sem nunca somar.
 *
 * ─── A unidade do custo: CENTAVOS DE DÓLAR, nunca convertidos ───────────────
 *
 * `custo_conhecido_cents`/`custo_estimado_cents` somam `llm_calls.cost_cents`
 * (real) e `ai_models.*_price_per_million_cents` (estimado), que
 * `lib/agent-engine/edge/llm/pricing.ts` e o catálogo gravam em CENTAVOS DE
 * DÓLAR, não de real (a mesma unidade que `formatCentsUSD`, em
 * `lib/money.ts`, já existe para formatar). Este painel NUNCA converte
 * câmbio (D-050/fora de escopo da fase, e câmbio não se inventa): a receita
 * sai em centavos de REAL e o custo em centavos de DÓLAR, sempre como
 * números SEPARADOS. Quem lê decide a taxa do dia, se quiser comparar.
 *
 * ─── Por que a receita do plano nunca lança preço em `llm_calls` (D-050) ────
 *
 * O preço do plano vem só de `billing_plans.price_monthly_cents`: este
 * módulo nunca escreve nem lê preço de volta em `llm_calls`.
 *
 * ─── Estimado é estimativa, não gasto medido ────────────────────────────────
 *
 * `custoEstimadoCentsUsd` casa o modelo da chamada com o catálogo
 * `ai_models` (mesma ordem de busca da correção do item 10,
 * `lib/ai/runtime/cost.ts`): é o preço de LISTA do provedor, não o que a
 * Hiperbold de fato pagou (que só `cost_cents` sabe). `chamadasSemPreco` é o
 * que nem essa estimativa cobre: nem o custo real, nem uma lista de preço
 * casou.
 *
 * Nunca lança, mesma regra das irmãs desta pasta: qualquer leitura que falhar
 * vira `leitura_falhou`, nunca um número zerado ou inventado (perderia
 * exatamente o "custo incompleto" que este painel existe para sinalizar).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Logger } from "@/lib/agent-engine/obs/logger";

import { primeiroDiaDoCicloAtual } from "./extrato-do-ciclo";

export interface PainelDeMargem {
  ciclo: string;
  /** Preço mensal do plano contratado, em CENTAVOS DE REAL. 0 sem contrato gravado. */
  receitaPlanoCents: number;
  /** Soma de `valor_cents` dos adicionais ATIVOS agora, em CENTAVOS DE REAL. */
  receitaAdicionaisCents: number;
  /** Soma de `valor_cents` dos créditos avulsos lançados DENTRO do ciclo, em CENTAVOS DE REAL. */
  receitaCreditosCents: number;
  /** Soma das três receitas acima, em CENTAVOS DE REAL. */
  receitaTotalCents: number;
  /** Soma de `cost_cents` CONHECIDO do ciclo, em CENTAVOS DE DÓLAR (nunca convertidos para real). */
  custoConhecidoCentsUsd: number;
  /** Soma ESTIMADA pelo catálogo `ai_models` para as chamadas do ciclo com `cost_cents` nulo, em CENTAVOS DE DÓLAR: preço de lista, não gasto medido. */
  custoEstimadoCentsUsd: number;
  /** Quantas chamadas do ciclo tiveram o custo estimado pelo catálogo (não o real). */
  chamadasEstimadas: number;
  /** Quantas chamadas do ciclo não têm `cost_cents` nem preço no catálogo: nem o real, nem a estimativa cobre. */
  chamadasSemPreco: number;
  /** Verdadeiro quando `chamadasSemPreco > 0`: mesmo com a estimativa, o custo do ciclo está incompleto, nunca "é isso". */
  custoIncompleto: boolean;
}

export type ResultadoPainelDeMargem =
  | { status: "ok"; margem: PainelDeMargem }
  | { status: "leitura_falhou" };

/** O formato exato de `fn_billing_margem_do_ciclo` (Parte 6, item 1c da revisão). */
const esquemaDaMargemRpc = z
  .object({
    receita_plano_cents: z.coerce.number().int(),
    receita_adicionais_cents: z.coerce.number().int(),
    receita_creditos_cents: z.coerce.number().int(),
    receita_total_cents: z.coerce.number().int(),
    custo_conhecido_cents: z.coerce.number(),
    custo_estimado_cents: z.coerce.number(),
    chamadas_estimadas: z.coerce.number().int(),
    chamadas_sem_preco: z.coerce.number().int(),
  })
  .strict();

/** O painel de margem do ciclo (por padrão, o atual) da organização. Nunca lança. */
export async function painelDeMargem(
  admin: SupabaseClient,
  organizationId: string,
  ciclo?: string,
  log?: Logger,
): Promise<ResultadoPainelDeMargem> {
  const inicioDoCiclo = ciclo ?? primeiroDiaDoCicloAtual();

  try {
    const { data, error } = await admin.rpc("fn_billing_margem_do_ciclo", {
      p_org: organizationId,
      p_ciclo: inicioDoCiclo,
    });

    if (error) {
      throw new Error(`ler painel de margem: ${error.message}`);
    }

    const parsed = esquemaDaMargemRpc.safeParse(data);
    if (!parsed.success) {
      throw new Error(`painel de margem fora do esquema: ${parsed.error.message}`);
    }
    const d = parsed.data;

    return {
      status: "ok",
      margem: {
        ciclo: inicioDoCiclo,
        receitaPlanoCents: d.receita_plano_cents,
        receitaAdicionaisCents: d.receita_adicionais_cents,
        receitaCreditosCents: d.receita_creditos_cents,
        receitaTotalCents: d.receita_total_cents,
        custoConhecidoCentsUsd: d.custo_conhecido_cents,
        custoEstimadoCentsUsd: d.custo_estimado_cents,
        chamadasEstimadas: d.chamadas_estimadas,
        chamadasSemPreco: d.chamadas_sem_preco,
        custoIncompleto: d.chamadas_sem_preco > 0,
      },
    };
  } catch (err) {
    log?.error("alarme_planos_leitura", {
      organization_id: organizationId,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
    });
    return { status: "leitura_falhou" };
  }
}
