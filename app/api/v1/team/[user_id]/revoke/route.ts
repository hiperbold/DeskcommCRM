import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/team/[user_id]/revoke — revoke a member.
 *
 * Guardrails:
 *  - Caller must be admin of the active org.
 *  - Cannot revoke self.
 *  - Cannot revoke the last admin.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail, falhaInterna } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";
import { registrarTrocaDeComando } from "@/lib/inbox/atividade-de-comando";

export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ user_id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { user_id: targetUserId } = await ctx.params;

  const authz = await requireRole("admin", { requestId, resource: "team" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user: authUser, org: activeOrg } = authz;
  if (targetUserId === authUser.id) {
    return fail("state_conflict", t("Não é possível revogar o próprio acesso."), 409, { requestId });
  }

  const supabase = await createClient();

  const { data: target, error: fetchErr } = await supabase
    .from("user_organizations")
    .select("id, user_id, role, revoked_at")
    .eq("organization_id", activeOrg.orgId)
    .eq("user_id", targetUserId)
    .maybeSingle();
  if (fetchErr) return falhaInterna("internal_error", fetchErr, { requestId });
  if (!target) return fail("not_found", t("Membro não encontrado."), 404, { requestId });
  if (target.revoked_at) {
    return ok({ user_id: targetUserId, already_revoked: true }, { requestId });
  }

  if (target.role === "admin") {
    const { count, error: countErr } = await supabase
      .from("user_organizations")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", activeOrg.orgId)
      .eq("role", "admin")
      .is("revoked_at", null);
    if (countErr) return falhaInterna("internal_error", countErr, { requestId });
    if ((count ?? 0) <= 1) {
      return fail(
        "state_conflict",
        t("Não é possível revogar o último admin do tenant."),
        409,
        { requestId },
      );
    }
  }

  // Conversas abertas atribuídas a quem está saindo — o trigger do banco desatribui
  // para a fila e a rota grava a linha do tempo e o audit de liberação de cada uma (#1562).
  const { data: openConvs } = await supabase
    .from("conversations")
    .select("id, contact_id")
    .eq("organization_id", activeOrg.orgId)
    .eq("assigned_to_user_id", targetUserId)
    .in("status", ["open", "pending", "claimed", "ai_handling"]);

  const nowIso = new Date().toISOString();
  // O vínculo só é gravado pelo servidor (migration 0929, D-125): o admin já foi conferido acima.
  // O banco recusa tirar o último admin, também sob duas revogações ao mesmo tempo.
  const { error: updErr } = await createAdminClient()
    .from("user_organizations")
    .update({ revoked_at: nowIso, updated_at: nowIso })
    .eq("id", target.id)
    .eq("organization_id", activeOrg.orgId);
  if (updErr) {
    if (updErr.message.includes("organizacao_sem_admin")) {
      return fail("state_conflict", t("Não é possível revogar o último admin do tenant."), 409, { requestId });
    }
    return falhaInterna("internal_error", updErr, { requestId });
  }

  // As chaves de API que ele criou saem junto (D-101): a chave carrega o papel de
  // quem a emitiu, e sem isto o admin desligado seguia lendo e escrevendo pelo
  // texto que guardou. O autenticador também confere o vínculo do criador a cada
  // chamada; esta revogação impede a chave de voltar se a pessoa for readmitida.
  // Falha aqui não desfaz a revogação do membro: o log avisa e o vínculo já barra.
  const { data: chavesRevogadas, error: chavesErr } = await supabase
    .from("api_tokens")
    .update({ revoked_at: nowIso, revoked_by: authUser.id, updated_at: nowIso })
    .eq("organization_id", activeOrg.orgId)
    .eq("created_by", targetUserId)
    .is("revoked_at", null)
    .select("id");
  if (chavesErr) {
    logger.error("[team.revoke] revogar chaves do membro falhou", {
      org_id: activeOrg.orgId,
      target_user_id: targetUserId,
      message: chavesErr.message,
    });
  }
  // As inscrições de push dele nesta organização também saem (D-097): a inscrição
  // é só um endereço de entrega, e sem apagá-la o aparelho dele seguia recebendo
  // nome e prévia das mensagens da empresa na tela de bloqueio. O envio também
  // confere o vínculo ativo; esta limpeza evita deixar o endereço guardado. A
  // sessão do admin não alcança a linha de outro usuário (RLS "só a própria"),
  // por isso o cliente de serviço. Falha não desfaz a revogação.
  const { error: pushErr } = await createAdminClient()
    .from("push_subscriptions")
    .delete()
    .eq("organization_id", activeOrg.orgId)
    .eq("user_id", targetUserId);
  if (pushErr) {
    logger.error("[team.revoke] apagar inscrições de push do membro falhou", {
      org_id: activeOrg.orgId,
      target_user_id: targetUserId,
      message: pushErr.message,
    });
  }
  for (const chave of chavesRevogadas ?? []) {
    await audit({
      action: "token.revoked",
      actorUserId: authUser.id,
      organizationId: activeOrg.orgId,
      resourceType: "api_token",
      resourceId: chave.id,
      requestId,
      metadata: { reason: "member_revoked", target_user_id: targetUserId },
    });
  }

  if (openConvs && openConvs.length > 0) {
    for (const conv of openConvs) {
      await audit({
        action: "conversation.released",
        actorUserId: authUser.id,
        organizationId: activeOrg.orgId,
        resourceType: "conversation",
        resourceId: conv.id,
        requestId,
        metadata: { reason: "member_revoked", target_user_id: targetUserId },
      });

      await registrarTrocaDeComando({
        supabase,
        organizationId: activeOrg.orgId,
        conversationId: conv.id,
        contactId: conv.contact_id,
        tipo: "conversation_released",
        actor: { type: "user", id: authUser.id, role: authz.org.role },
        motivo: "Atendente revogado da organização",
      });
    }
  }

  await audit({
    action: "member.revoked",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "membership",
    resourceId: target.id,
    requestId,
    metadata: {
      target_user_id: targetUserId,
      revoked_role: target.role,
      released_conversations_count: openConvs?.length ?? 0,
    },
  });

  return ok({ user_id: targetUserId, revoked_at: nowIso }, { requestId });
}
