import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { bloqueioDoBotao, estadoDoBloqueio } from "@/lib/billing/planos/estado-do-bloqueio";
import { traduzir } from "@/lib/i18n/dicionario";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { InviteForm } from "./_components/InviteForm";

export const dynamic = "force-dynamic";

export default async function TeamInvitePage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg || ROLE_RANK[activeOrg.role] < ROLE_RANK.admin) {
    redirect("/403");
  }
  const idioma = user.idioma;
  const t = (texto: string) => traduzir(texto, idioma);

  // Fase F3, tarefa 9: item "membros" da matriz do plano, no botão "Enviar
  // convites". Convite novo é a única ação desta tela (não há reenvio nem
  // vínculo direto aqui), e a decisão 4 da fase bloqueia justamente convite
  // novo, convite renovado e vínculo direto — nunca o aceite.
  const estado = await estadoDoBloqueio(createAdminClient(), activeOrg.orgId, {}, logger);
  const bloqueio = bloqueioDoBotao(estado, "membros");

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t("Convidar membros")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("Cole até 20 emails (um por linha) e escolha a role compartilhada.")}
        </p>
      </header>
      <InviteForm bloqueio={bloqueio} />
    </div>
  );
}
