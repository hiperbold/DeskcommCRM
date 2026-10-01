/**
 * GET /api/v1/conversations/[id]/messages — histórico de mensagens (handler
 * em /app/api/v1/messages/_handler.ts → listMessagesHandler).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ApiError } from "@/lib/api/types";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { listMessagesQuerySchema } from "@/lib/schemas";
import { createClient } from "@/lib/supabase/server";

import { listMessagesHandler } from "@/app/api/v1/messages/_handler";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function GET(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id: conversationId } = await ctx.params;
  const supabase = await createClient();

  // D-092: a leitura passa pelo gate único (papel efetivo, MFA da sessão e
  // organização ativa), não só pela RLS: ela não olha o nível da sessão.
  const authz = await requireRole("viewer", { requestId, resource: "messages" });
  if (!authz.ok) return authz.response;
  const { user, org: activeOrg } = authz;
  const authUser = user;
  const t = (texto: string) => traduzir(texto, authUser.idioma);

  const url = new URL(req.url);
  const qsParsed = listMessagesQuerySchema.safeParse({
    cursor: url.searchParams.get("cursor") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
  });
  if (!qsParsed.success) {
    return fail("validation_failed", t("Query inválida."), 422, {
      details: qsParsed.error.flatten().fieldErrors as Record<string, unknown>,
      requestId,
    });
  }

  try {
    const { messages, cursor, has_more } = await listMessagesHandler(
      supabase,
      {
        organization_id: activeOrg.orgId,
        actor: { type: "user", id: user.id },
        requestId,
        idioma: authUser?.idioma,
      },
      conversationId,
      qsParsed.data,
    );
    return ok(messages, { requestId, meta: { cursor, has_more } });
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, { requestId });
    }
    throw err;
  }
}
