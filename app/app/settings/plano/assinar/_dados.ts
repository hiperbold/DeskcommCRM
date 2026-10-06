import "server-only";

/**
 * Leituras PRÓPRIAS da tela `/app/settings/plano/assinar` (fase F5, Tarefa
 * 20): pacotes de tokens à venda e se a organização já tem cliente Asaas
 * vinculado no ambiente configurado (decide se o formulário do pagador
 * aparece, decisão 16 do plano da fase).
 *
 * Mesma doutrina de `lib/billing/asaas/leitura.ts` (nunca lança, degrada
 * para vazio/neutro com `leituraFalhou`): fica FORA daquele arquivo porque o
 * briefing desta tarefa não autoriza tocar em `lib/billing/asaas/*`.
 *
 * `billing_token_pacotes` não tem um `for_sale` próprio como
 * `billing_plans`: "à venda" para um pacote é `ativo = true` e
 * `preco_cents` preenchido e maior que zero (restrição fixa 3 da fase: nada
 * de preço inventado, e nada sem preço aparece para compra).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Logger } from "@/lib/agent-engine/obs/logger";
import type { AmbienteAsaas } from "@/lib/billing/asaas/config";
import type { ParametrosDeParcelamento } from "@/lib/billing/asaas/parcelamento";

export interface PacoteParaVenda {
  codigo: string;
  nome: string;
  tokens: number;
  precoCents: number;
}

export interface ResultadoPacotesParaVenda {
  pacotes: PacoteParaVenda[];
  leituraFalhou: boolean;
}

interface LinhaDoPacoteCru {
  codigo: string;
  nome: string;
  tokens: number;
  preco_cents: number;
}

function mensagemDeErro(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}

/** Pacotes ativos com preço definido, do mais barato para o mais caro. Nunca lança. */
export async function pacotesParaVenda(
  admin: SupabaseClient,
  log?: Logger,
): Promise<ResultadoPacotesParaVenda> {
  try {
    const { data, error } = await admin
      .from("billing_token_pacotes")
      .select("codigo, nome, tokens, preco_cents")
      .eq("ativo", true)
      .not("preco_cents", "is", null)
      .gt("preco_cents", 0)
      .order("preco_cents", { ascending: true });

    if (error) throw new Error(`ler billing_token_pacotes: ${error.message}`);

    const linhas = (data ?? []) as unknown as LinhaDoPacoteCru[];
    return {
      pacotes: linhas.map((l) => ({
        codigo: l.codigo,
        nome: l.nome,
        tokens: l.tokens,
        precoCents: l.preco_cents,
      })),
      leituraFalhou: false,
    };
  } catch (err) {
    log?.error("alarme_asaas_leitura", {
      etapa: "pacotes_para_venda_tela_cliente",
      erro: mensagemDeErro(err),
    });
    return { pacotes: [], leituraFalhou: true };
  }
}

/**
 * A organização já tem cliente Asaas vinculado no ambiente configurado?
 * Decide se o formulário do pagador aparece (decisão 16: só na primeira
 * compra).
 *
 * Fail-OPEN de propósito, ao contrário de `compraLigada`
 * (`lib/billing/asaas/config.ts`): mostrar o formulário à toa não bloqueia
 * ninguém; escondê-lo por engano barraria a primeira compra com
 * `MENSAGEM_PAGADOR_OBRIGATORIO` (`lib/billing/asaas/compra.ts`) sem a
 * pessoa entender por quê.
 */
export async function precisaDeFormularioDoPagador(
  admin: SupabaseClient,
  organizationId: string,
  ambiente: AmbienteAsaas,
  log?: Logger,
): Promise<boolean> {
  try {
    const { data, error } = await admin
      .from("billing_customers")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("ambiente", ambiente)
      .maybeSingle();
    if (error) throw new Error(`ler billing_customers: ${error.message}`);
    return data === null;
  } catch (err) {
    log?.error("alarme_asaas_leitura", {
      etapa: "precisa_pagador_tela_cliente",
      organization_id: organizationId,
      erro: mensagemDeErro(err),
    });
    return true;
  }
}

/**
 * Os parâmetros de parcelamento de `billing_settings` (D-177): taxa mensal, até quantas parcelas sem
 * juros e os tetos do semestral e do anual. Fail-closed: se a leitura falhar, nenhum parâmetro (só o 1x
 * aparece). Nunca lança.
 */
export async function parametrosDeParcelamento(admin: SupabaseClient, log?: Logger): Promise<ParametrosDeParcelamento> {
  const vazio: ParametrosDeParcelamento = { taxaMensal: null, semJurosAte: null, maxSemestral: null, maxAnual: null };
  try {
    const { data, error } = await admin
      .from("billing_settings")
      .select("parcelamento_taxa_mensal, parcelamento_sem_juros_ate, parcelamento_max_semestral, parcelamento_max_anual")
      .eq("id", 1)
      .maybeSingle();
    if (error) throw new Error(`ler billing_settings: ${error.message}`);
    const c = data as {
      parcelamento_taxa_mensal: number | string | null;
      parcelamento_sem_juros_ate: number | null;
      parcelamento_max_semestral: number | null;
      parcelamento_max_anual: number | null;
    } | null;
    if (!c) return vazio;
    return {
      taxaMensal: c.parcelamento_taxa_mensal == null ? null : Number(c.parcelamento_taxa_mensal),
      semJurosAte: c.parcelamento_sem_juros_ate,
      maxSemestral: c.parcelamento_max_semestral,
      maxAnual: c.parcelamento_max_anual,
    };
  } catch (err) {
    log?.error("alarme_asaas_leitura", { etapa: "parametros_de_parcelamento", erro: mensagemDeErro(err) });
    return vazio;
  }
}
