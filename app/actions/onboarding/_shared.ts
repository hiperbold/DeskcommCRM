/**
 * Shared helpers for onboarding Server Actions: resolve auth + active org +
 * admin client (we use service-role here because we do narrow targeted
 * UPDATEs scoped explicitly by `organization_id` resolved from the validated
 * session — no body-derived ids ever).
 */
import { supportWriteError } from "@/lib/impersonate/support";
import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { createAdminClient } from "@/lib/supabase/admin";
import type { OnboardingState } from "@/lib/schemas/onboarding";

export class OnboardingError extends Error {
  constructor(
    public readonly code:
      | "auth_required"
      | "no_active_org"
      | "forbidden"
      | "mfa_required"
      | "not_found"
      | "db_error",
    message: string,
  ) {
    super(message);
    this.name = "OnboardingError";
  }
}

export interface OnboardingCtx {
  userId: string;
  orgId: string;
  orgName: string;
  role: string;
  fullName: string | null;
  email: string;
}

/**
 * O onboarding é ato de ADMINISTRADOR, em organização AINDA NÃO concluída.
 *
 * As actions daqui escrevem com service role (renomeiam a empresa, mudam o
 * fuso, religam o agente padrão, aplicam o quadro de funil e assinam convites),
 * então o portão tem que ser o da própria action: server action é endpoint
 * público, e o id dela está no bundle do formulário. Antes só a sessão e a
 * organização ativa eram conferidas, e um viewer convidado chegava a virar
 * admin pelo convite do passo "equipe" (D-089, D-090).
 *
 *  1. papel `admin` na organização ativa;
 *  2. `mfaEmDivida()`: sessão aal1 de quem TEM fator não conduz o onboarding;
 *  3. `onboarded_at` nulo: depois de concluído, nenhuma delas roda de novo.
 *     `permitirConcluido` existe só para `finishOnboarding`, que é idempotente
 *     de propósito (segundo clique cai no redirect) e continua exigindo admin.
 */
export async function requireOnboardingCtx(
  opts: { permitirConcluido?: boolean } = {},
): Promise<OnboardingCtx> {
  const user = await loadAuthUser();
  if (!user) throw new OnboardingError("auth_required", "Auth required.");
  if (supportWriteError(user.support)) throw new OnboardingError("forbidden", "Acompanhamento somente leitura ou encerrado.");
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) throw new OnboardingError("no_active_org", "Sem organização ativa.");
  if (ROLE_RANK[activeOrg.role] < ROLE_RANK.admin) {
    throw new OnboardingError("forbidden", "Só um administrador conduz o onboarding.");
  }
  if (await mfaEmDivida()) {
    throw new OnboardingError("mfa_required", "Confirme a verificação em duas etapas.");
  }
  if (!opts.permitirConcluido) {
    const { onboardedAt } = await loadOnboardingState(activeOrg.orgId);
    if (onboardedAt) throw new OnboardingError("forbidden", "O onboarding desta organização já foi concluído.");
  }
  return {
    userId: user.id,
    orgId: activeOrg.orgId,
    orgName: activeOrg.name,
    role: activeOrg.role,
    fullName: user.full_name,
    email: user.email,
  };
}

export async function loadOnboardingState(orgId: string): Promise<{
  state: OnboardingState;
  onboardedAt: string | null;
}> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("organizations")
    .select("onboarding_state, onboarded_at")
    .eq("id", orgId)
    .maybeSingle();
  if (error) throw new OnboardingError("db_error", error.message);
  if (!data) throw new OnboardingError("not_found", "Organização não encontrada.");
  return {
    state: (data.onboarding_state as OnboardingState | null) ?? {},
    onboardedAt: (data.onboarded_at as string | null) ?? null,
  };
}

export async function patchOnboardingState(
  orgId: string,
  patch: Partial<OnboardingState>,
  extra?: { display_name?: string; timezone?: string },
): Promise<void> {
  const admin = createAdminClient();
  const { state } = await loadOnboardingState(orgId);
  const merged: OnboardingState = { ...state, ...patch };
  const update: Record<string, unknown> = { onboarding_state: merged };
  if (extra?.display_name) update.display_name = extra.display_name;
  if (extra?.timezone) update.timezone = extra.timezone;
  const { error } = await admin.from("organizations").update(update).eq("id", orgId);
  if (error) throw new OnboardingError("db_error", error.message);
}
