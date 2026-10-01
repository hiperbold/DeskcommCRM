/**
 * GET /api/v1/voice/sessions/status — estado do pareamento de chamada de voz
 * da organização ativa. Usado pelo discador (§5.1 da spec) pra decidir se
 * mostra o botão "Ligar".
 */
import { randomUUID } from "node:crypto";

import { ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();

  // D-092: gate único de leitura (papel efetivo e MFA da sessão), não só a RLS.
  const authz = await requireRole("viewer", { requestId, resource: "channel_sessions" });
  if (!authz.ok) return authz.response;
  const activeOrg = authz.org;

  const supabase = await createClient();
  const { data } = await supabase
    .from("channel_sessions")
    .select("id, status, wacalls_jid, wacalls_paired_at")
    .eq("organization_id", activeOrg.orgId)
    .eq("provider", "wacalls")
    .is("archived_at", null)
    .maybeSingle();

  const row = data as {
    id: string;
    status: string;
    wacalls_jid: string | null;
    wacalls_paired_at: string | null;
  } | null;

  return ok(
    {
      configured: !!row,
      channelSessionId: row?.id ?? null,
      status: row?.status ?? null,
      paired: !!row?.wacalls_paired_at,
      jid: row?.wacalls_jid ?? null,
    },
    { requestId },
  );
}
