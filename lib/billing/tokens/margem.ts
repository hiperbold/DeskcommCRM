/**
 * O painel de margem da carteira de tokens de IA (fase F2-B, decisão 17):
 * SÓ para a plataforma, nunca para a organização (a mesma régua de "livro-
 * caixa e adicionais: privilégio nenhum para authenticated", decisão 19).
 *
 * Por organização e ciclo ATUAL:
 *
 *   receita = preço mensal do plano contratado (`billing_contracts` →
 *             `billing_plans.price_monthly_cents`) + `valor_cents` dos
 *             adicionais ATIVOS (`billing_token_adicionais`) + `valor_cents`
 *             dos créditos avulsos DO CICLO (linhas `credito:` do livro-caixa
 *             com `created_at` no ciclo) — tudo em CENTAVOS DE REAL.
 *
 *   custo   = soma de `cost_cents_conhecido` do agregado
 *             `billing_token_consumo_diario` do ciclo, mais
 *             `chamadas_custo_nulo` (quantas chamadas do ciclo tinham custo
 *             desconhecido).
 *
 * ─── A unidade do custo: CENTAVOS DE DÓLAR, nunca convertidos ───────────────
 *
 * `cost_cents_conhecido` é a soma de `llm_calls.cost_cents`, que
 * `lib/agent-engine/edge/llm/pricing.ts` grava como `(uso em USD) * 100` — ou
 * seja, CENTAVOS DE DÓLAR, não de real (a mesma unidade que `formatCentsUSD`,
 * em `lib/money.ts`, já existe para formatar). Este painel NUNCA converte
 * câmbio (D-050/fora de escopo da fase, e câmbio não se inventa): a receita
 * sai em centavos de REAL e o custo em centavos de DÓLAR, sempre como dois
 * números SEPARADOS. Quem lê decide a taxa do dia, se quiser comparar.
 *
 * ─── Por que a receita do plano nunca lança preço em `llm_calls` (D-050) ────
 *
 * O preço do plano vem só de `billing_plans.price_monthly_cents`, lido por
 * uma leitura própria: este módulo nunca escreve nem lê preço de volta em
 * `llm_calls`.
 *
 * ─── Por que os créditos avulsos filtram por CHAVE, não por fonte ───────────
 *
 * A fonte "avulso" no livro-caixa também recebe linhas de CONSUMO
 * (`consumo:<llm_call_id>:avulso`) e de AJUSTE. Só a chave `credito:<uuid>`
 * identifica um crédito de verdade (decisão 6/7); filtrar por
 * `fonte = 'avulso'` contaria consumo e ajuste como se fossem receita.
 *
 * Nunca lança, mesma regra das irmãs desta pasta: qualquer leitura que falhar
 * vira `leitura_falhou`, nunca um número zerado ou inventado (perderia
 * exatamente o "custo incompleto" que este painel existe para sinalizar).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Logger } from "@/lib/agent-engine/obs/logger";

import { primeiroDiaDoCicloAtual } from "./extrato-do-ciclo";
import { inicioDoCicloEmUtc } from "./livro-caixa-do-ciclo";

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
  /** Soma de `cost_cents_conhecido` do ciclo, em CENTAVOS DE DÓLAR (nunca convertidos para real). */
  custoConhecidoCentsUsd: number;
  /** Quantas chamadas do ciclo tinham custo desconhecido (`cost_cents` nulo). */
  chamadasCustoNulo: number;
  /** Verdadeiro quando `chamadasCustoNulo > 0`: o custo em dólar está incompleto, nunca "é isso". */
  custoIncompleto: boolean;
}

export type ResultadoPainelDeMargem =
  | { status: "ok"; margem: PainelDeMargem }
  | { status: "leitura_falhou" };

const esquemaDoContrato = z
  .object({
    billing_plans: z.object({ price_monthly_cents: z.coerce.number().int() }).nullable(),
  })
  .strict();

const esquemaDoAdicional = z.object({ valor_cents: z.coerce.number().int().nullable() }).strict();

const esquemaDoCredito = z.object({ valor_cents: z.coerce.number().int().nullable() }).strict();

const esquemaDoConsumoDiario = z
  .object({
    cost_cents_conhecido: z.coerce.number(),
    chamadas_custo_nulo: z.coerce.number().int(),
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
    const [contratoRes, adicionaisRes, creditosRes, consumoRes] = await Promise.all([
      admin
        .from("billing_contracts")
        .select("billing_plans(price_monthly_cents)")
        .eq("organization_id", organizationId)
        .maybeSingle(),
      admin
        .from("billing_token_adicionais")
        .select("valor_cents")
        .eq("organization_id", organizationId)
        .eq("ativo", true),
      admin
        .from("billing_token_ledger")
        .select("valor_cents")
        .eq("organization_id", organizationId)
        .like("chave", "credito:%")
        .gte("created_at", inicioDoCicloEmUtc(inicioDoCiclo)),
      admin
        .from("billing_token_consumo_diario")
        .select("cost_cents_conhecido, chamadas_custo_nulo")
        .eq("organization_id", organizationId)
        .gte("dia", inicioDoCiclo),
    ]);

    if (contratoRes.error) throw new Error(`ler contrato do painel de margem: ${contratoRes.error.message}`);
    if (adicionaisRes.error) throw new Error(`ler adicionais do painel de margem: ${adicionaisRes.error.message}`);
    if (creditosRes.error) throw new Error(`ler créditos do painel de margem: ${creditosRes.error.message}`);
    if (consumoRes.error) throw new Error(`ler consumo do painel de margem: ${consumoRes.error.message}`);

    // Sem contrato gravado (organização anterior ao gatilho, mesmo caso de
    // `planoDaOrganizacao`): receita do plano fica 0, nunca inventa preço.
    let receitaPlanoCents = 0;
    if (contratoRes.data !== null) {
      const contratoParseado = esquemaDoContrato.safeParse(contratoRes.data);
      if (!contratoParseado.success) {
        throw new Error(`contrato do painel de margem fora do esquema: ${contratoParseado.error.message}`);
      }
      receitaPlanoCents = contratoParseado.data.billing_plans?.price_monthly_cents ?? 0;
    }

    const adicionaisParseados = z.array(esquemaDoAdicional).safeParse(adicionaisRes.data);
    if (!adicionaisParseados.success) {
      throw new Error(`adicionais do painel de margem fora do esquema: ${adicionaisParseados.error.message}`);
    }
    const receitaAdicionaisCents = adicionaisParseados.data.reduce((acc, l) => acc + (l.valor_cents ?? 0), 0);

    const creditosParseados = z.array(esquemaDoCredito).safeParse(creditosRes.data);
    if (!creditosParseados.success) {
      throw new Error(`créditos do painel de margem fora do esquema: ${creditosParseados.error.message}`);
    }
    const receitaCreditosCents = creditosParseados.data.reduce((acc, l) => acc + (l.valor_cents ?? 0), 0);

    const consumoParseado = z.array(esquemaDoConsumoDiario).safeParse(consumoRes.data);
    if (!consumoParseado.success) {
      throw new Error(`consumo do painel de margem fora do esquema: ${consumoParseado.error.message}`);
    }
    const custoConhecidoCentsUsd = consumoParseado.data.reduce((acc, l) => acc + l.cost_cents_conhecido, 0);
    const chamadasCustoNulo = consumoParseado.data.reduce((acc, l) => acc + l.chamadas_custo_nulo, 0);

    return {
      status: "ok",
      margem: {
        ciclo: inicioDoCiclo,
        receitaPlanoCents,
        receitaAdicionaisCents,
        receitaCreditosCents,
        receitaTotalCents: receitaPlanoCents + receitaAdicionaisCents + receitaCreditosCents,
        custoConhecidoCentsUsd,
        chamadasCustoNulo,
        custoIncompleto: chamadasCustoNulo > 0,
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
