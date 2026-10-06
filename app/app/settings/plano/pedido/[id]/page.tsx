/**
 * `/app/settings/plano/pedido/[id]`: fase F5, Tarefa 21, o estado de um
 * pedido de compra (assinatura ou pacote de tokens), com o mesmo polling da
 * tela de compra enquanto ainda aguarda.
 *
 * Leitura DIRETA pelo servidor (`dbCompraSupabase(admin).lerPedido`, a
 * mesma função que `GET /api/v1/billing/pedidos/[id]` usa, Tarefa 15): a
 * organização vem sempre da SESSÃO, nunca do path, e um `id` que não bate
 * com nenhum pedido desta organização cai no MESMO 404 de "não existe"
 * (decisão 17 do plano da fase, o mesmo desenho da rota). O polling
 * seguinte, no cliente, consulta a rota HTTP.
 *
 * Só o papel `admin` (N41: quem compra e cancela também é quem acompanha o
 * pedido); quem não é admin volta para `/app/settings/plano`.
 */
import { notFound, redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { dbCompraSupabase } from "@/lib/billing/asaas/db-compra-supabase";
import { traduzir } from "@/lib/i18n/dicionario";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

import { PedidoClient } from "./_client";

export const metadata = { title: "Pedido" };
export const dynamic = "force-dynamic";

export default async function PedidoPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (ROLE_RANK[activeOrg.role] < ROLE_RANK.admin) {
    redirect("/app/settings/plano");
  }

  const t = (texto: string) => traduzir(texto, user.idioma);

  const admin = createAdminClient();
  const { data, error } = await dbCompraSupabase(admin).lerPedido(activeOrg.orgId, id);

  if (error) {
    logger.error("[plano/pedido] ler pedido falhou", {
      code: error.code ?? null,
      message: error.message ?? null,
    });
  }

  if (error || !data) {
    notFound();
  }

  const descricaoDaOferta =
    data.tipo === "assinatura"
      ? [data.planoNome, data.ciclo === "yearly" ? t("Anual") : data.ciclo === "semiannual" ? t("Semestral") : t("Mensal")]
          .filter(Boolean)
          .join(" · ")
      : data.pacoteNome;

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t("Seu pedido")}</h1>
        <p className="text-sm text-muted-foreground">
          {data.tipo === "assinatura" ? t("Assinatura") : t("Pacote de tokens")}
          {descricaoDaOferta ? ` · ${descricaoDaOferta}` : ""}
        </p>
      </header>

      <PedidoClient pedidoId={data.id} statusInicial={data.status} urlInicial={data.invoiceUrl} />
    </div>
  );
}
