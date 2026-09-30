"use server";

/**
 * Server Action: bulk-invite teammates from the onboarding wizard.
 *
 * Emite pelo MESMO caminho de `/api/v1/team/invite` (`emitirConvite`): o convite
 * vira linha em `team_invites`, então aparece na tela de Equipe, pode ser
 * revogado e passa pelo teto de membros do plano. Só administrador chega aqui
 * (`requireOnboardingCtx`). Failures to send email do NOT block onboarding
 * progression.
 *
 * Antes esta action assinava o token na mão, sem linha e sem conferir papel: um
 * viewer convidava uma segunda conta como admin (D-089).
 */
import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { recusaDoPlano } from "@/lib/billing/planos/recusa-do-plano";
import { inviteOnboardingSchema } from "@/lib/schemas/onboarding";
import { emitirConvite } from "@/lib/team/convites";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireOnboardingCtx, patchOnboardingState, OnboardingError } from "./_shared";

type PapelHumano = "viewer" | "agent" | "manager" | "admin";

export type SendInvitesResult =
  | {
      ok: true;
      sent: number;
      failed: number;
      /** Convites cujo email NÃO saiu (ex.: nenhum transporte configurado) — o link
       * de aceite é devolvido para o admin enviar manualmente. */
      undelivered?: { email: string; accept_url: string }[];
      /** Convites que o PLANO recusou (teto de membros, conta suspensa), com a frase para a tela. */
      recusados?: { email: string; motivo: string }[];
    }
  | {
      ok: false;
      error: "auth_required" | "no_active_org" | "forbidden" | "mfa_required" | "invalid_input";
      details?: unknown;
    };

interface InvitePayload {
  // Convite é para PESSOA: só papel humano. `ai_operator` não entra aqui de
  // propósito — é papel de token de agente, ninguém o recebe por e-mail.
  invitations: { email: string; role: PapelHumano }[];
  skip?: boolean;
}

export async function sendOnboardingInvites(payload: InvitePayload): Promise<SendInvitesResult> {
  let ctx;
  try {
    ctx = await requireOnboardingCtx();
  } catch (err) {
    if (err instanceof OnboardingError) return { ok: false, error: err.code as never };
    throw err;
  }

  if (payload.skip) {
    await patchOnboardingState(ctx.orgId, { team: { invites_sent: 0, skipped: true } });
    await audit({
      action: "onboarding.team_invited",
      actorUserId: ctx.userId,
      organizationId: ctx.orgId,
      metadata: { skipped: true, count: 0 },
    });
    redirect("/onboarding");
  }

  let input;
  try {
    input = inviteOnboardingSchema.parse(payload);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return { ok: false, error: "invalid_input", details: err.flatten() };
    }
    throw err;
  }

  const inviterName = ctx.fullName ?? ctx.email ?? "Um colega";
  const requestId = randomUUID();
  const admin = createAdminClient();

  let sent = 0;
  let failed = 0;
  const undelivered: { email: string; accept_url: string }[] = [];
  const recusados: { email: string; motivo: string }[] = [];
  for (const inv of input.invitations) {
    const email = inv.email.trim().toLowerCase();
    try {
      const emitido = await emitirConvite(admin, {
        email,
        role: inv.role,
        organizationId: ctx.orgId,
        orgName: ctx.orgName,
        inviterId: ctx.userId,
        inviterName,
        requestId,
      });
      if (emitido.email_dispatched) sent += 1;
      else {
        failed += 1;
        undelivered.push({ email, accept_url: emitido.accept_url });
      }
    } catch (err) {
      // Teto de membros ou conta suspensa: um item do lote, o resto segue (mesmo
      // contrato de `/api/v1/team/invite`). Qualquer outro erro é defeito.
      const recusa = recusaDoPlano(err);
      if (!recusa) throw err;
      failed += 1;
      recusados.push({ email, motivo: recusa.mensagem });
    }
  }

  await patchOnboardingState(ctx.orgId, {
    team: { invites_sent: sent + failed, skipped: false },
  });
  await audit({
    action: "onboarding.team_invited",
    actorUserId: ctx.userId,
    organizationId: ctx.orgId,
    metadata: { count: sent + failed, sent, failed },
  });

  // Email falhou (ex.: VPS sem SMTP e sem Resend): NÃO redireciona em silêncio —
  // devolve os links de aceite pro admin enviar manualmente (mesmo contrato do
  // fallback de /app/team/invite). Redirect só no caminho 100% entregue.
  if (failed > 0) {
    return { ok: true, sent, failed, undelivered, ...(recusados.length ? { recusados } : {}) };
  }

  redirect("/onboarding");
}
