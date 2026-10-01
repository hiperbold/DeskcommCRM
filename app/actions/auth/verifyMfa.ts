"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { safeNext } from "@/lib/auth/safe-next";

import { createClient } from "@/lib/supabase/server";
import { audit } from "@/lib/audit";
import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import {
  MFA_FAILURE_LIMITS,
  mfaBloqueadoPorFalhas,
  registrarFalhaDeMfa,
  segundosAteFimDaJanela,
} from "@/lib/auth/rate-limit";

export type VerifyMfaResult =
  | { ok: false; error: "mfa_invalid" }
  | { ok: false; error: "mfa_locked"; retry_in_seconds: number };

/**
 * Verifies a TOTP code against the user's verified factor and (on success)
 * elevates the session to AAL2. On failure, counts the attempt on the SERVER,
 * keyed on user_id (D-102: the counter lived in a cookie, and clearing the cookie
 * reset it). After `MFA_FAILURE_LIMITS.max` failures in the window the user is
 * locked out until the window turns; the reply carries the real seconds left.
 */
export async function verifyMfa(code: string, next?: string): Promise<VerifyMfaResult> {
  const supabase = await createClient();
  const hdrs = await headers();
  const requestId = hdrs.get("x-request-id");
  // D-036: o primeiro salto do `x-forwarded-for` é forjável pelo cliente;
  // `ipDoCliente` lê o salto confiável (ver `lib/http/ip-do-cliente.ts`).
  const ip = ipDoCliente(hdrs);
  const userAgent = hdrs.get("user-agent") ?? null;

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // Sanity-check: must have a verified TOTP factor.
  const { data: factorsData } = await supabase.auth.mfa.listFactors();
  const totp = factorsData?.totp?.find((f) => f.status === "verified");
  if (!totp) redirect("/app");

  // Lockout check (server-side counter, per user).
  const bloqueado = () =>
    ({
      ok: false,
      error: "mfa_locked",
      retry_in_seconds: segundosAteFimDaJanela(MFA_FAILURE_LIMITS.windowSec),
    }) as const;
  if (await mfaBloqueadoPorFalhas(user.id)) return bloqueado();

  if (!/^\d{6}$/.test(code)) {
    return { ok: false, error: "mfa_invalid" };
  }

  // Issue challenge + verify.
  const { data: challenge, error: challengeErr } = await supabase.auth.mfa.challenge({
    factorId: totp.id,
  });
  if (challengeErr || !challenge) {
    return { ok: false, error: "mfa_invalid" };
  }

  const { error: verifyErr } = await supabase.auth.mfa.verify({
    factorId: totp.id,
    challengeId: challenge.id,
    code,
  });

  if (verifyErr) {
    const newAttempts = await registrarFalhaDeMfa(user.id);
    const locked = newAttempts >= MFA_FAILURE_LIMITS.max;
    await audit({
      action: "auth.mfa_failed",
      actorUserId: user.id,
      metadata: { locked, attempts: newAttempts },
      requestId,
      ip,
      userAgent,
    });
    if (locked) return bloqueado();
    return { ok: false, error: "mfa_invalid" };
  }

  await audit({
    action: "auth.mfa_success",
    actorUserId: user.id,
    metadata: {},
    requestId,
    ip,
    userAgent,
  });

  redirect(safeNext(next, "/app"));
}
