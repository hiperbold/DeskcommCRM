/**
 * O gate de custo de IA para quem NÃO passa por `runModelCall` (D-117, D-118):
 * a carteira de tokens e o orçamento em dólar, lidos pelo PostgREST.
 *
 * É a mesma decisão pura do caminho de texto (`deveConsultarCarteira`,
 * `decidirOrcamento`): uma régua só. Quem chama decide o que fazer com o veredito
 * e trata a falha de leitura (aqui lança; os chamadores seguem em fail-open e
 * deixam a causa no log).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  aplicarChaveNoVeredicto,
  deveConsultarCarteira,
  interpretarVeredictoDaCarteira,
  normalizarModoDeBilling,
  type VeredictoDaCarteira,
} from "@/lib/agent-engine/edge/llm/carteira";
import {
  decidirOrcamento,
  LIMIAR_PADRAO_PCT,
  normalizarChaveDeOrcamento,
  normalizarModoDeOrcamento,
  type Veredito,
} from "@/lib/agent-engine/edge/llm/orcamento";
import { modoDeBillingCacheado } from "@/lib/billing/planos/modo-cacheado";

export type OrigemDaChave = "chave_da_instalacao" | "credencial_da_organizacao";

export async function veredictoDaCarteira(
  admin: SupabaseClient,
  organizationId: string,
  origemDaChave: OrigemDaChave,
  purpose: string,
): Promise<VeredictoDaCarteira | null> {
  const chave = normalizarChaveDeOrcamento(process.env.PLANOS_BLOQUEIO);
  // As mesmas condições do caminho de texto: chave de emergência, origem e propósito
  // decidem em memória SE vale a pena ler o modo.
  if (chave === "off" || origemDaChave !== "chave_da_instalacao") return null;
  const { modo, error: erroDoModo } = await modoDeBillingCacheado(admin);
  if (erroDoModo) throw new Error(`ler billing_settings: ${erroDoModo}`);
  if (
    !deveConsultarCarteira({
      chave,
      modoDoBanco: normalizarModoDeBilling(modo),
      origemDaChave,
      purpose,
    })
  ) {
    return null;
  }
  const { data, error } = await admin.rpc("fn_billing_ia_pode_responder", { p_org: organizationId });
  if (error) throw new Error(`fn_billing_ia_pode_responder: ${error.message}`);
  return aplicarChaveNoVeredicto(interpretarVeredictoDaCarteira(data), chave);
}

export async function veredictoDoOrcamento(
  admin: SupabaseClient,
  organizationId: string,
  purpose: string,
  agora: Date,
): Promise<Veredito | null> {
  const chave = normalizarChaveDeOrcamento(process.env.AI_BUDGET_ENFORCEMENT);
  if (chave === "off") return null;
  const { data: orc, error } = await admin
    .from("ai_budgets")
    .select("monthly_limit_cents, enforcement_mode, enforcement_effective_at, alarm_threshold_pct")
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) throw new Error(`ler ai_budgets: ${error.message}`);
  const modo = normalizarModoDeOrcamento(orc?.enforcement_mode ?? null);
  if (!orc || modo === "off") return null;

  const { data: gasto, error: erroDoGasto } = await admin.rpc("fn_gasto_de_ia_do_mes", { p_org: organizationId });
  if (erroDoGasto) throw new Error(`fn_gasto_de_ia_do_mes: ${erroDoGasto.message}`);

  const inicioDoMes = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), 1)).toISOString();
  const { count, error: erroDoAviso } = await admin
    .from("agent_inbox_items")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .eq("kind", "budget_warning")
    .gte("created_at", inicioDoMes);
  if (erroDoAviso) throw new Error(`ler agent_inbox_items: ${erroDoAviso.message}`);

  return decidirOrcamento({
    modo,
    tetoCents: Number(orc.monthly_limit_cents ?? 0),
    gastoCents: Number(gasto ?? 0),
    efetivoEm: orc.enforcement_effective_at ? new Date(orc.enforcement_effective_at) : null,
    agora,
    purpose,
    chave,
    limiarPct: Number(orc.alarm_threshold_pct ?? LIMIAR_PADRAO_PCT),
    avisadoNesteMes: (count ?? 0) > 0,
  });
}

