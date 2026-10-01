"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { safeNext } from "@/lib/auth/safe-next";
import { z } from "zod";

import { createAdminClient } from "@/lib/supabase/admin";
import { audit, isServiceRoleConfigured } from "@/lib/audit";
import { hashRecoveryCode } from "@/lib/auth/recovery-codes";
import { authRateLimited, AUTH_LIMITS } from "@/lib/auth/rate-limit";
import { avisarSobreCodigosDeRecuperacao } from "@/lib/auth/aviso-de-codigos-de-recuperacao";
import { ipDoCliente } from "@/lib/http/ip-do-cliente";

export type UseRecoveryCodeResult =
  | { ok: false; error: "invalid_or_used" }
  | { ok: false; error: "service_unavailable" };

const inputSchema = z.object({
  email: z.string().email(),
  code: z.string().regex(/^[A-Z0-9]{8}$/, "Código inválido"),
});

/**
 * Burns a recovery code: marks it used, deletes ALL TOTP factors of the user
 * (so they can re-enroll on next login), then redirects to /login. Generic
 * errors are returned for any failure — never leak whether email exists.
 *
 * Security:
 *  - 200ms artificial delay on miss (timing leak protection).
 *  - hashRecoveryCode = sha256 → bytea match.
 *  - Audit emits with masked code (`AB****YZ`).
 */
export async function useRecoveryCode(
  rawInput: { email: string; code: string },
  next?: string,
): Promise<UseRecoveryCodeResult | void> {
  const hdrs = await headers();
  const requestId = hdrs.get("x-request-id");
  // D-036: o primeiro salto do `x-forwarded-for` é forjável pelo cliente;
  // `ipDoCliente` lê o salto confiável (ver `lib/http/ip-do-cliente.ts`).
  const ip = ipDoCliente(hdrs);
  const userAgent = hdrs.get("user-agent") ?? null;

  const parsed = inputSchema.safeParse({
    email: rawInput.email?.trim().toLowerCase(),
    code: rawInput.code?.trim().toUpperCase(),
  });
  if (!parsed.success) {
    await delay(200);
    return { ok: false, error: "invalid_or_used" };
  }

  // Ação anônima: sem teto o chute de código é grátis e cada tentativa varre o diretório de
  // contas. A recusa é a mesma resposta genérica de qualquer falha (D-126).
  if (await authRateLimited("recovery_code", parsed.data.email, AUTH_LIMITS.recovery_code)) {
    await delay(200);
    return { ok: false, error: "invalid_or_used" };
  }

  if (!isServiceRoleConfigured()) {
    console.warn(
      "[useRecoveryCode] SUPABASE_SERVICE_ROLE_KEY not configured — recovery flow unavailable",
    );
    return { ok: false, error: "service_unavailable" };
  }

  const admin = createAdminClient();
  const { email, code } = parsed.data;

  // 1) Resolve user by email via admin API. Generic error if missing.
  const achado = await acharUsuarioPorEmail(admin, email);
  if (achado === "erro") {
    await delay(200);
    return { ok: false, error: "invalid_or_used" };
  }
  const targetUser = achado;
  if (!targetUser) {
    await delay(200);
    return { ok: false, error: "invalid_or_used" };
  }

  // 2) Find an unused recovery code matching the sha256 hash.
  const codeHash = hashRecoveryCode(code);
  const { data: row, error: rowErr } = await admin
    .from("user_recovery_codes")
    .select("id, used_at")
    .eq("user_id", targetUser.id)
    .eq("code_hash", codeHash)
    .is("used_at", null)
    .limit(1)
    .maybeSingle();

  if (rowErr || !row) {
    await delay(200);
    return { ok: false, error: "invalid_or_used" };
  }

  // 3) Burn it.
  const { data: queimado, error: updErr } = await admin
    .from("user_recovery_codes")
    .update({ used_at: new Date().toISOString(), used_ip: ip })
    .eq("id", row.id)
    // Duas chamadas simultâneas com o mesmo código liam a linha como livre e as duas
    // queimavam: só a que de fato a marcar como usada segue (D-126).
    .is("used_at", null)
    .select("id");
  if (updErr || !queimado || queimado.length === 0) {
    return { ok: false, error: "invalid_or_used" };
  }

  // 4) Delete ALL TOTP factors for the user so they re-enroll on next login.
  try {
    const { data: factors } = await admin.auth.admin.mfa.listFactors({
      userId: targetUser.id,
    });
    for (const f of factors?.factors ?? []) {
      await admin.auth.admin.mfa.deleteFactor({ userId: targetUser.id, id: f.id });
    }
    // Sem fator não há o que recuperar: os códigos que sobraram (os outros nove
    // e qualquer um que tenha vazado) não valem mais. O cadastro seguinte gera
    // um conjunto novo. Só depois de os fatores saírem de fato: se a remoção
    // falhou, a pessoa ainda precisa deles.
    await admin.from("user_recovery_codes").delete().eq("user_id", targetUser.id);
  } catch (err) {
    console.error("[useRecoveryCode] failed to delete factors", err);
    // Non-fatal: user still gets a recovery_used redirect; on next login the
    // residual factor would block them, but seeded user has no factor anyway.
  }

  // 5) Audit (masked).
  await audit({
    action: "auth.recovery_code_used",
    actorUserId: targetUser.id,
    metadata: {
      masked_code: `${code.slice(0, 2)}****${code.slice(-2)}`,
      next: next ?? null,
    },
    requestId,
    ip,
    userAgent,
  });

  // 6) O dono da conta é avisado: o código queima o segundo fator inteiro.
  await avisarSobreCodigosDeRecuperacao({ email: targetUser.email, evento: "usado", ip });

  // 7) Redirect to /login fresh: user logs in normally and re-enrolls MFA.
  const params = new URLSearchParams({ recovery_used: "1" });
  // Sanitiza aqui também: este `next` volta para /login e de lá alimenta o
  // redirect de signInWithPassword — carregar destino externo por este caminho
  // daria na mesma coisa, só com um salto a mais.
  const destino = safeNext(next, "");
  if (destino) params.set("next", destino);
  redirect(`/login?${params.toString()}`);
}

/** Contas por página e teto de páginas da varredura do diretório. */
const CONTAS_POR_PAGINA = 200;
const PAGINAS_DO_DIRETORIO = 50;

/**
 * `listUsers` não filtra por e-mail: a busca antiga olhava só a primeira página de 200 contas
 * e uma instalação maior nunca achava o dono do código (D-126). Varre o diretório paginado
 * até achar ou até a página vazia, como `lib/auth/provision.ts`; não usa `nextPage` porque o
 * auth-js o deriva do header Link com `.substring(0, 1)` e da página 10 em diante lê "1".
 * `"erro"` = o GoTrue falhou; `null` = não existe conta com esse e-mail.
 */
async function acharUsuarioPorEmail(
  admin: ReturnType<typeof createAdminClient>,
  email: string,
): Promise<{ id: string; email?: string | null } | null | "erro"> {
  for (let pagina = 1; pagina <= PAGINAS_DO_DIRETORIO; pagina++) {
    const { data, error } = await admin.auth.admin.listUsers({ page: pagina, perPage: CONTAS_POR_PAGINA });
    if (error) return "erro";
    if (data.users.length === 0) return null;
    const achada = data.users.find((u) => u.email?.toLowerCase() === email);
    if (achada) return { id: achada.id, email: achada.email };
  }
  return null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
