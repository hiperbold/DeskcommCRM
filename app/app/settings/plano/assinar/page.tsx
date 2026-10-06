/**
 * `/app/settings/plano/assinar`: fase F5, Tarefa 20 (`hiperbold/planos/
 * fase-F5-tarefas.md`): assinar um plano ou comprar um pacote de tokens
 * pelo PRÓPRIO CLIENTE, atrás das duas chaves da decisão 18.
 *
 * ─── Só o papel `admin` (N41) ───────────────────────────────────────────────
 *
 * Mesma régua de `app/actions/settings/compraDoPlano.ts` (autorização real,
 * que roda de novo a cada chamada): aqui é só o que decide o CONTEÚDO da
 * tela. Quem não é admin da organização vê "peça a um administrador", nunca
 * o formulário de compra.
 *
 * ─── As duas chaves da decisão 18, checadas ANTES de ler o catálogo ────────
 *
 * `ASAAS_ENABLED` e `billing_settings.compra_pelo_cliente` precisam estar
 * ligadas ao mesmo tempo; sem isso a tela nem lê `billing_plans`/
 * `billing_token_pacotes`, e mostra a frase fixa do briefing.
 *
 * ─── Só o que tem preço e está à venda (restrição fixa 3 da fase) ──────────
 *
 * `planosParaVenda` (`lib/billing/asaas/leitura.ts`) já lê todo plano ATIVO;
 * esta página filtra por `forSale && priceMonthlyCents > 0` antes de
 * mostrar. Pacote segue a mesma régua em `./_dados.ts` (`ativo` e
 * `preco_cents` preenchido). Hoje nenhum plano tem `for_sale` e nenhum
 * pacote tem preço (restrição fixa 6): a tela tem que ficar honesta e bonita
 * vazia também.
 */
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { compraLigada, configDoAsaas, ErroConfiguracaoAsaas, type AmbienteAsaas } from "@/lib/billing/asaas/config";
import { planosParaVenda } from "@/lib/billing/asaas/leitura";
import { traduzir } from "@/lib/i18n/dicionario";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

import { opcoesDeParcelamento, type OpcaoDeParcelas } from "@/lib/billing/asaas/parcelamento";

import { pacotesParaVenda, parametrosDeParcelamento, precisaDeFormularioDoPagador } from "./_dados";
import { AssinarOuComprarClient } from "./_client";

export const metadata = { title: "Assinar" };
export const dynamic = "force-dynamic";

export default async function AssinarPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");

  const idioma = user.idioma;
  const t = (texto: string) => traduzir(texto, idioma);

  if (ROLE_RANK[activeOrg.role] < ROLE_RANK.admin) {
    return (
      <div className="flex h-full flex-col gap-4 p-6">
        <h1 className="text-2xl font-semibold tracking-tight">{t("Assinar ou comprar")}</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          {t("Peça a um administrador desta organização para assinar um plano ou comprar um pacote de tokens.")}
        </p>
      </div>
    );
  }

  const admin = createAdminClient();

  let habilitado = false;
  let erroConfiguracao = false;
  let ambiente: AmbienteAsaas = "sandbox";
  try {
    const config = configDoAsaas();
    habilitado = config.habilitado;
    ambiente = config.ambiente;
  } catch (err) {
    erroConfiguracao = true;
    logger.error("[assinar] configuração do Asaas inválida", {
      erro: err instanceof ErroConfiguracaoAsaas ? err.message : String(err),
    });
  }

  const ligada = await compraLigada(admin, habilitado && !erroConfiguracao);

  if (!ligada) {
    return (
      <div className="flex h-full flex-col gap-4 p-6">
        <h1 className="text-2xl font-semibold tracking-tight">{t("Assinar ou comprar")}</h1>
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-900 dark:text-amber-200">
          {t("A compra pela tela ainda não está disponível. Fale com o suporte.")}
        </div>
      </div>
    );
  }

  const [planosResultado, pacotesResultado, precisaPagador, parametros] = await Promise.all([
    planosParaVenda(admin, logger),
    pacotesParaVenda(admin, logger),
    precisaDeFormularioDoPagador(admin, activeOrg.orgId, ambiente, logger),
    parametrosDeParcelamento(admin, logger),
  ]);

  const planos = planosResultado.planos.filter((p) => p.forSale && p.priceMonthlyCents > 0);
  const leituraFalhou = planosResultado.leituraFalhou || pacotesResultado.leituraFalhou;

  // D-177: as opções de parcelamento são calculadas AQUI, no servidor (a conta e os parâmetros nunca vão
  // para o navegador); o cliente só mostra e escolhe o número de parcelas.
  const opcoesDeParcelas: Record<string, { semiannual: OpcaoDeParcelas[]; yearly: OpcaoDeParcelas[] }> = {};
  for (const plano of planos) {
    opcoesDeParcelas[plano.code] = {
      semiannual: plano.priceSemiannualCents ? opcoesDeParcelamento(plano.priceSemiannualCents, "semiannual", parametros) : [],
      yearly: plano.priceYearlyCents ? opcoesDeParcelamento(plano.priceYearlyCents, "yearly", parametros) : [],
    };
  }
  const taxaMensalPercentual = parametros.taxaMensal === null ? null : Math.round(parametros.taxaMensal * 10000) / 100;

  return (
    <AssinarOuComprarClient
      opcoesDeParcelas={opcoesDeParcelas}
      taxaMensalPercentual={taxaMensalPercentual}
      planos={planos}
      pacotes={pacotesResultado.pacotes}
      precisaPagador={precisaPagador}
      leituraFalhou={leituraFalhou}
    />
  );
}
