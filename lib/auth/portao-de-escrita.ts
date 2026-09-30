/**
 * PORTÃO ÚNICO das server actions que ESCREVEM configuração sensível (D-093,
 * D-137 e D-103 da auditoria de 30/09/2026).
 *
 * ## Por que existe
 *
 * Server action não é rota: não passa por `requireRole`, então cada uma
 * reimplementava o próprio portão. Três defeitos saíram dessa cópia:
 *
 *  1. `is_platform_admin && papel < admin` valia para QUALQUER linha não
 *     revogada de `platform_admins`, sem olhar o escopo. Um operador de suporte
 *     `support_readonly` que também era viewer de uma empresa cliente apagava os
 *     dados dela, trocava a conexão de anúncios e o funil.
 *  2. Só algumas actions chamavam `mfaEmDivida()`: a sessão aal1 de quem TEM
 *     fator (senha vazada) mexia no SMTP, no modo de cadastro e na exigência de
 *     MFA da empresa.
 *  3. A régua certa existia num lugar só (`compraDoPlano.ts`, "Correção 7").
 *
 * Aqui ela vira função. Quem escreve configuração sensível importa uma das duas,
 * e `tests/unit/acoes-de-escrita-usam-o-portao-comum.test.ts` reprova a action
 * que voltar a escrever o portão na mão.
 *
 *  - `requirePlatformAdminFull()`: a instalação inteira (SMTP, cadastro, marca,
 *    Meta, Google, módulos). Escopo `full` + MFA em dia.
 *  - `portaoDeAdminDaOrganizacao()`: a empresa ativa. Admin do tenant, ou admin
 *    da plataforma de escopo `full`; nos dois casos com MFA em dia.
 */
import { redirect } from "next/navigation";

import { mfaEmDivida, sessionAal } from "@/lib/auth/server";
import {
  requirePlatformAdmin,
  type PlatformAdminContext,
} from "@/lib/auth/requirePlatformAdmin";
import { ROLE_RANK, type ActiveOrg, type AuthUser } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";

/**
 * O admin da plataforma tem escopo `full`? Lê a própria linha de
 * `platform_admins` (a policy `platform_admins_self` deixa um admin de
 * plataforma ler), só as não revogadas. Falha fechada: erro de leitura, linha
 * ausente ou escopo `support_readonly` dão `false`.
 */
export async function escopoCompletoDaPlataforma(userId: string): Promise<boolean> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("platform_admins")
    .select("scope")
    .eq("user_id", userId)
    .is("revoked_at", null)
    .maybeSingle();
  if (error || !data) return false;
  return data.scope === "full";
}

/**
 * Guarda de escrita da INSTALAÇÃO, no lugar de `requirePlatformAdmin()`.
 *
 * Mesmo contrato de redirect do guarda original (estas actions já o usavam para
 * negar quem não é admin de plataforma, então o formato de retorno delas não
 * muda): sem sessão ou sem linha, o de sempre; escopo que não é `full` vai para
 * `/admin/forbidden`; sessão aal1 de quem tem fator vai para `/login/mfa`.
 *
 * `requirePlatformAdmin()` segue valendo para LEITURA (telas e consultas): o
 * `support_readonly` existe para olhar.
 */
export async function requirePlatformAdminFull(): Promise<PlatformAdminContext> {
  const ctx = await requirePlatformAdmin();
  if (ctx.platformAdmin.scope !== "full") redirect("/admin/forbidden");
  if (await mfaEmDivida()) redirect("/login/mfa?next=/admin");
  return ctx;
}

export type RecusaDoPortao = "forbidden_role" | "mfa_required";
export type ResultadoDoPortao = { ok: true } | { ok: false; erro: RecusaDoPortao };

/**
 * Portão de escrita de quem administra a EMPRESA ATIVA. Chamar DEPOIS de
 * `supportWriteError` e de `resolveActiveOrg` (quem chama já os tem).
 *
 *  1. Papel `admin` na empresa, OU admin da plataforma de escopo `full`.
 *     `is_platform_admin` sozinho não basta: vale para `support_readonly`.
 *  2. `mfaEmDivida()`: sessão aal1 de quem TEM fator não escreve. Vem DEPOIS do
 *     papel de propósito (quem nem tem o papel recebe a verdade sobre ele, não
 *     uma cobrança de segundo fator), a mesma ordem de `requireRole`.
 *  3. `exigirAal2`: operação irreversível. Exige o segundo fator PROVADO nesta
 *     sessão, mesmo de quem nunca cadastrou um (aí a pessoa precisa ativar a
 *     verificação em duas etapas antes).
 */
export async function portaoDeAdminDaOrganizacao(
  authUser: Pick<AuthUser, "id" | "is_platform_admin">,
  activeOrg: Pick<ActiveOrg, "role">,
  opts: { exigirAal2?: boolean } = {},
): Promise<ResultadoDoPortao> {
  if (ROLE_RANK[activeOrg.role] < ROLE_RANK.admin) {
    if (!authUser.is_platform_admin) return { ok: false, erro: "forbidden_role" };
    if (!(await escopoCompletoDaPlataforma(authUser.id))) {
      return { ok: false, erro: "forbidden_role" };
    }
  }
  if (await mfaEmDivida()) return { ok: false, erro: "mfa_required" };
  if (opts.exigirAal2 && (await sessionAal()) !== "aal2") {
    return { ok: false, erro: "mfa_required" };
  }
  return { ok: true };
}
