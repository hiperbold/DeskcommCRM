/**
 * GET /api/v1/webhook-sources/[id]/events — feed de recebimentos da fonte
 * (últimos 20), pra UI mostrar "chegou / não chegou" em tempo quase real
 * depois do botão "Enviar lead de teste".
 */
import { randomUUID } from "node:crypto";

import { ok, fail, falhaInterna } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function GET(_req: Request, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  const authz = await requireRole("manager", { requestId, resource: "webhook_sources" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { org: activeOrg } = authz;

  const supabase = await createClient();
  // D-128: `path_token` não é legível pela sessão. O papel (manager) já foi conferido e o filtro por
  // organização vai junto: o servidor só entrega o token de uma fonte DESTA organização.
  const { data: source, error: sourceErr } = await createAdminClient()
    .from("webhook_sources")
    .select("path_token")
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();
  if (sourceErr) return falhaInterna("internal_error", sourceErr, { requestId });
  if (!source) return fail("not_found", t("Fonte não encontrada."), 404, { requestId });

  const { data, error } = await supabase
    .from("webhook_events_log")
    .select("id, created_at:received_at, valid_signature, payload_parsed, status")
    .eq("webhook_path_token", source.path_token)
    .order("received_at", { ascending: false })
    .limit(20);
  if (error) return falhaInterna("internal_error", error, { requestId });

  return ok(data ?? [], { requestId });
}
