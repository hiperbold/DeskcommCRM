import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * PATCH  /api/v1/webhook-sources/[id] — atualiza campos (inclui is_active — switch da UI).
 * DELETE /api/v1/webhook-sources/[id] — remove a fonte.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail, noContent, falhaInterna } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { recusaDoPlano, STATUS_RECUSA_DO_PLANO } from "@/lib/billing/planos/recusa-do-plano";
import { requireRole } from "@/lib/auth/require-role";
import { ApiError } from "@/lib/api/types";
import { autoriaDaMudanca } from "@/lib/operacao/autoria";
import { COLUNAS_DA_FONTE, destinoValido, tokensDasFontes } from "@/lib/operacao/entradas-automaticas";
import { updateWebhookSourceSchema } from "@/lib/schemas";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function PATCH(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;
  const authz = await requireRole("manager", { requestId, resource: "webhook_sources" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org: activeOrg } = authz;

  let raw: unknown = {};
  try {
    raw = await req.json();
  } catch {
    raw = {};
  }
  const parsed = updateWebhookSourceSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("invalid_request", t("Dados inválidos."), 400, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const supabase = await createClient();
  const { data: existing, error: fetchErr } = await supabase
    .from("webhook_sources")
    .select("id, default_pipeline_id, default_stage_id")
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();
  if (fetchErr) return falhaInterna("internal_error", fetchErr, { requestId });
  if (!existing) return fail("not_found", t("Fonte não encontrada."), 404, { requestId });

  // D-132: o POST confere o destino (funil e etapa desta organizacao, etapa do
  // funil e em uso); o PATCH nao conferia, e a fonte so falhava em silencio na
  // hora de criar o lead. Vale o par que ficaria gravado: o enviado, ou o que ja
  // existe para a metade omitida.
  if (parsed.data.default_pipeline_id !== undefined || parsed.data.default_stage_id !== undefined) {
    try {
      await destinoValido(
        { supabase, organizationId: activeOrg.orgId, actor: { type: "user", id: user.id }, requestId },
        parsed.data.default_pipeline_id ?? (existing as { default_pipeline_id: string }).default_pipeline_id,
        parsed.data.default_stage_id ?? (existing as { default_stage_id: string }).default_stage_id,
      );
    } catch (err) {
      if (err instanceof ApiError) {
        return fail(err.code, err.message ?? t("Destino inválido."), err.status, { requestId });
      }
      throw err;
    }
  }

  // secret plaintext do input vira secret_encrypted (migration 0041); a coluna
  // em claro não existe mais. `secret: null` remove o segredo da fonte.
  const { secret: patchedSecret, ...restPatch } = parsed.data;
  // A autoria vai junto de TODA escrita, pelo mesmo helper que o agente usa: a
  // tela precisa distinguir o que ela mesma mudou do que o assistente mudou, e
  // duas contas de "quem mexeu" divergiriam no primeiro ajuste (migration 0101).
  const patch: Record<string, unknown> = {
    ...restPatch,
    updated_at: new Date().toISOString(),
    ...autoriaDaMudanca({ type: "user", id: user.id, role: activeOrg.role }),
  };
  if (patchedSecret !== undefined) {
    if (patchedSecret === null) {
      patch.secret_encrypted = null;
    } else {
      const enc = await encryptWebhookSecret(createAdminClient(), patchedSecret);
      if (enc === null) {
        return fail(
          "encryption_unavailable",
          t("Não foi possível guardar o segredo com segurança: a chave de cifra desta instalação não está ativa. Quem administra o servidor resolve rodando o update.sh, que gera e ativa a chave."),
          422,
          { requestId },
        );
      }
      patch.secret_encrypted = enc;
    }
  }

  const { data: updated, error: updErr } = await supabase
    .from("webhook_sources")
    .update(patch)
    .eq("id", id)
    .select(COLUNAS_DA_FONTE)
    .single();
  if (updErr) {
    // Fase F3, decisão 3: este PATCH é um SEGUNDO caminho de escrita para
    // `is_active` (o outro é `definirEntradaAtiva`, usado pelo agente de IA) —
    // ativar por aqui também conta contra o teto de integrações. PT402 pelo
    // `code`, nunca pelo texto do Postgres.
    const recusa = recusaDoPlano(updErr);
    if (recusa) return fail("plano_limite_atingido", recusa.mensagem, STATUS_RECUSA_DO_PLANO, { requestId });
    return falhaInterna("internal_error", updErr, { requestId });
  }

  void audit({
    action: "webhook.source_updated",
    actorUserId: user.id,
    organizationId: activeOrg.orgId,
    resourceType: "webhook_source",
    resourceId: id,
    requestId,
    // Nunca gravar o valor do secret no audit log — só o fato da troca.
    metadata: { ...restPatch, ...(patchedSecret !== undefined ? { secret_changed: true } : {}) },
  });

  // D-128: `path_token` não é legível pela sessão; o servidor o lê (o corpo de sucesso segue o mesmo).
  const tokens = await tokensDasFontes(
    { supabase, leitorDeTokens: createAdminClient(), organizationId: activeOrg.orgId, actor: { type: "user", id: user.id }, requestId },
    [id],
  );
  const { secret_encrypted: encAfter, ...updatedPublic } = updated as unknown as Record<string, unknown>;
  return ok({ ...updatedPublic, path_token: tokens.get(id) ?? "", has_secret: encAfter !== null }, { requestId });
}

export async function DELETE(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;
  const authz = await requireRole("manager", { requestId, resource: "webhook_sources" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org: activeOrg } = authz;

  const supabase = await createClient();
  const { data: existing, error: fetchErr } = await supabase
    .from("webhook_sources")
    .select("id")
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();
  if (fetchErr) return falhaInterna("internal_error", fetchErr, { requestId });
  if (!existing) return fail("not_found", t("Fonte não encontrada."), 404, { requestId });

  const { error: delErr } = await supabase.from("webhook_sources").delete().eq("id", id);
  if (delErr) return falhaInterna("internal_error", delErr, { requestId });

  void audit({
    action: "webhook.source_deleted",
    actorUserId: user.id,
    organizationId: activeOrg.orgId,
    resourceType: "webhook_source",
    resourceId: id,
    requestId,
  });

  return noContent(requestId);
}
