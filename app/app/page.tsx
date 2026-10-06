import { redirect } from "next/navigation";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { homeDaInterface } from "@/lib/navigation/interface";
import { CAMINHO_DA_ASSINATURA, organizacaoSemPlano } from "@/lib/billing/assinatura/sem-plano";
import { createAdminClient } from "@/lib/supabase/admin";
export default async function AppHome() {
  const user = await requireAuth();
  const org = await resolveActiveOrg(user);
  // D-094: a entrada de /app também vale na navegação interna, em que o layout não roda de novo.
  if (org && !user.support && (await organizacaoSemPlano(createAdminClient(), org.orgId))) {
    redirect(CAMINHO_DA_ASSINATURA);
  }
  redirect(
    homeDaInterface(
      org?.interface_settings,
      user.is_platform_admin && !user.support,
      org?.role ?? null,
    ),
  );
}
