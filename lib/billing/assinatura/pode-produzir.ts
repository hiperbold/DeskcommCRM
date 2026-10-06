/**
 * "Esta organização pode PRODUZIR mensagem sozinha agora?": status `active` E fora do modo leitura.
 * Helper único dos produtores de follow-up (M1 da auditoria do lote 16). Antes cada ponto só
 * conferia `contaEmModoLeitura` (cobrança), e uma organização suspensa pelo admin da plataforma
 * (spam, por exemplo) com a cobrança em dia seguia mandando WhatsApp.
 *
 * Custo: o status vem de `statusDaOrganizacaoCacheado` (uma leitura por organização a cada 30s, não
 * por mensagem); a parte da cobrança é a de sempre (`contaEmModoLeitura`, zero consulta a mais no
 * modo avisar). Status ilegível ou nulo NÃO bloqueia (fail-open, como o modo leitura), mas grita no
 * log. A IA do motor e a legada não passam por aqui: o gasto de IA falha fechado (B3).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { contaEmModoLeitura } from "@/lib/billing/assinatura/modo-leitura";
import { statusDaOrganizacaoCacheado } from "@/lib/billing/assinatura/status-da-organizacao";

export type MotivoDeNaoProduzir = "organizacao_inativa" | "assinatura_suspensa";

/** `null` = pode produzir. O motivo vai no `cancel_reason` do enrollment encerrado. */
export async function motivoDeNaoProduzir(
  admin: SupabaseClient,
  organizationId: string,
): Promise<MotivoDeNaoProduzir | null> {
  const status = await statusDaOrganizacaoCacheado(admin, organizationId);
  if (status !== null && status !== "active") return "organizacao_inativa";
  if (await contaEmModoLeitura(admin, organizationId)) return "assinatura_suspensa";
  return null;
}

export async function organizacaoPodeProduzir(admin: SupabaseClient, organizationId: string): Promise<boolean> {
  return (await motivoDeNaoProduzir(admin, organizationId)) === null;
}

/**
 * Mesma forma de `contaEmModoLeitura` (`true` = barrado), para ligar nas dependências
 * `contaEmModoLeitura` dos gatilhos e da varredura de silêncio sem mudar o contrato delas.
 */
export async function contaBloqueadaParaProduzir(admin: SupabaseClient, organizationId: string): Promise<boolean> {
  return !(await organizacaoPodeProduzir(admin, organizationId));
}
