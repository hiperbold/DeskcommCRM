/**
 * `organizations.status` com cache curto por organização, para os produtores automáticos que não
 * têm leitura de `organizations` própria (automação, follow-up). Nasceu em `lib/automation/engine.ts`
 * (D-091) e subiu para cá para o follow-up usar a MESMA leitura (M1 da auditoria do lote 16).
 *
 * `null` = não conseguiu ler (o chamador segue: mesma doutrina fail-open de `contaEmModoLeitura`,
 * mas a falha grita no log). Isto NÃO serve para gasto de IA: lá a leitura que falha fecha (B3).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

const TTL_STATUS_DA_ORGANIZACAO_MS = 30_000;
const statusDaOrganizacao = new Map<string, { status: string | null; expiraEm: number }>();

/** `organizations.status` com cache de 30s por organização. `null` = não conseguiu ler (segue). */
export async function statusDaOrganizacaoCacheado(admin: SupabaseClient, organizationId: string): Promise<string | null> {
  const agora = Date.now();
  const guardado = statusDaOrganizacao.get(organizationId);
  if (guardado && guardado.expiraEm > agora) return guardado.status;
  let status: string | null = null;
  try {
    const { data, error } = await admin.from("organizations").select("status").eq("id", organizationId).maybeSingle();
    if (error) throw new Error(error.message);
    status = typeof (data as { status?: unknown } | null)?.status === "string" ? (data as { status: string }).status : null;
  } catch (err) {
    logger.error("[status-da-organizacao] não foi possível ler o status da organização", {
      organization_id: organizationId,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
    });
    return null;
  }
  statusDaOrganizacao.set(organizationId, { status, expiraEm: agora + TTL_STATUS_DA_ORGANIZACAO_MS });
  return status;
}

/** Só para teste: esquece o cache. */
export function limparCacheDoStatusDaOrganizacao(): void {
  statusDaOrganizacao.clear();
}
