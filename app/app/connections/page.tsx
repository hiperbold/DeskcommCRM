import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { bloqueioDoBotaoDeConexoes } from "@/lib/billing/planos/limite-de-conexoes";
import { ConexoesShell } from "@/components/connections/ConexoesShell";
import { pareamentoQrDisponivel } from "@/lib/channels/pareamento-qr";
import { canalGraphParceiroLigado, GRAPH_PARTNER_LABEL } from "@/lib/channels/graph-parceiro/credentials";
import { traduzir } from "@/lib/i18n/dicionario";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Conexões" };

export default async function ConnectionsPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (!(user.is_platform_admin && !user.support) && ROLE_RANK[activeOrg.role] < ROLE_RANK.admin) {
    redirect("/403");
  }
  const idioma = user.idioma;

  const key = process.env.WAHA_API_KEY;
  const wahaConfigured = Boolean(
    process.env.WAHA_API_BASE_URL && key && key !== "dev_plaintext_change_me",
  );
  const wacallsConfigured = Boolean(process.env.WACALLS_API_BASE_URL);

  // D-188: os canais que criam `channel_sessions` (instância, QR Code, oficial, parceiro, redes sociais)
  // usam o MESMO item da matriz de plano, "Conexões", somado entre todos, e ele bloqueia em qualquer modo de
  // `billing_settings`. Um só cálculo serve a todos; cada componente decide sozinho se o botão que ele
  // mostra é uma conexão NOVA.
  const bloqueio = await bloqueioDoBotaoDeConexoes(createAdminClient(), activeOrg.orgId, idioma, logger);

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{traduzir("Conexões", idioma)}</h1>
        <p className="text-sm text-muted-foreground">
          {traduzir(
            "Por onde seu negócio fala com o cliente. Conecte um número pela API não oficial ou o número oficial da Meta, e acompanhe a saúde de cada um.",
            idioma,
          )}
        </p>
      </header>
      <ConexoesShell
        wahaConfigured={wahaConfigured}
        wacallsConfigured={wacallsConfigured}
        bloqueio={bloqueio}
        graphParceiro={canalGraphParceiroLigado() ? { label: GRAPH_PARTNER_LABEL } : null}
        // O mesmo piso de `PUT /api/v1/ai/pacing` (`manager`): abaixo disso a ficha
        // abre só para ler, em vez de oferecer um Salvar que a rota recusaria.
        podeEditarProtecao={ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager}
        // Só aparece com o servidor e o token de administrador configurados na instalação.
        pareamentoQr={await pareamentoQrDisponivel()}
      />
    </div>
  );
}
