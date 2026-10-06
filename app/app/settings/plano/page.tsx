/**
 * Configurações → Plano e uso (fase F2 dos planos de assinatura, tarefa 7).
 *
 * ── O que esta tela mostra, e o que ela NÃO faz ainda ────────────────────────
 *
 * Item por item da matriz do plano (funis, etapas por funil, membros,
 * conexões, integrações webhook, leads), quanto a organização usa contra o
 * teto contratado. Nesta fase nenhum teto bloqueia por padrão
 * (`billing_settings.modo` segue `avisar` em toda instalação), o aviso fixo
 * no topo diz isso quando é o caso: ninguém pode confundir "cheguei no teto"
 * com "fui barrado". Quando o admin da plataforma liga o bloqueio para esta
 * organização (fase F3, tarefa 9), o mesmo banner passa a mostrar o estado
 * real, desligado, em carência até tal data, ou valendo ,, e os itens no
 * teto entram listados, com o motivo (`lib/billing/planos/estado-do-bloqueio.ts`,
 * que nunca lança: falha de leitura degrada para "não vale").
 *
 * ── Por que `manager`, e não `admin` como a vizinha Billing ──────────────────
 *
 * Aqui não se troca cartão nem se vê fatura, só se acompanha uso, decisão de
 * desenho 13 da fase (pergunta N11, padrão "admin e gerente"). O gate é o
 * mesmo desenho de `settings/tags` e `settings/voip-trunk`: papel resolvido no
 * servidor, redireciona para `/403` como as outras telas de configuração, sem
 * atalho de platform admin (esta tela não é do painel da plataforma).
 *
 * ── Por que cliente de SERVIÇO, e não o de sessão ─────────────────────────────
 *
 * `usoDaOrganizacao` e `planoDaOrganizacao` chamam RPCs (`fn_billing_uso`,
 * `fn_billing_limites_efetivos`) com `execute` revogado de `anon` e
 * `authenticated` (tarefa 2 da fase): só `service_role` chama. A organização
 * vem da sessão ANTES de qualquer leitura (`activeOrg.orgId`), nunca de
 * parâmetro de URL, o cliente de serviço não filtra por si só.
 *
 * ── A regra de falha ─────────────────────────────────────────────────────────
 *
 * `usoDaOrganizacao` e `planoDaOrganizacao` nunca lançam; cada uma devolve o
 * próprio `leituraFalhou`. Esta tela une os dois com `||` antes de montar as
 * linhas: se qualquer leitura falhou, `linhasDaTelaDePlano` (que faz a conta)
 * devolve NENHUM número, nunca "sem limite", nunca "0 de 5". Ver o comentário
 * daquele módulo para o porquê de não misturar uma leitura boa com uma ruim.
 *
 * ── A seção "Tokens de IA" (fase F2-B, tarefa 6) ─────────────────────────────
 *
 * Mesma régua de gate (`manager` para cima) e mesmo cliente de serviço desta
 * página. `saldoDaOrganizacao` já devolve o ciclo atual (e concede o mês, se
 * for a primeira leitura): `extratoDoCiclo` e `estimativaDeRespostas` reusam
 * esse ciclo e o saldo restante em vez de calcular os dois de novo, para as
 * três leituras nunca discordarem sobre "que mês é este". `linhasDeTokensDeIA`
 * une os TRÊS resultados com o mesmo racional do `||` acima: qualquer um
 * falhando, a seção inteira mostra só o aviso.
 */
import Link from "next/link";
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import {
  estadoDaAssinatura,
  ultimoDiaDoPeriodo,
  type ResultadoEstadoDaAssinatura,
} from "@/lib/billing/assinatura/estado-da-assinatura";
import { contratoSemPlano } from "@/lib/billing/assinatura/sem-plano";
import {
  asaasDaOrganizacao,
  estadoDasChavesAsaas,
  type AssinaturaAsaasDaOrganizacao,
  type EstadoDasChavesAsaas,
  type PedidoAsaas,
} from "@/lib/billing/asaas/leitura";
import { estadoDoBloqueio, type EstadoDoBloqueio } from "@/lib/billing/planos/estado-do-bloqueio";
import {
  linhasDaTelaDePlano,
  type ChaveDaTelaDePlano,
  type LinhaDaTelaDePlano,
} from "@/lib/billing/planos/linhas-da-tela-de-plano";
import { planoDaOrganizacao } from "@/lib/billing/planos/plano-da-organizacao";
import { usoDaOrganizacao } from "@/lib/billing/planos/uso-da-organizacao";
import { estimativaDeRespostas } from "@/lib/billing/tokens/estimativa-de-respostas";
import {
  extratoDoCiclo,
  type LinhaExtratoPorAgente,
  type LinhaExtratoPorDia,
} from "@/lib/billing/tokens/extrato-do-ciclo";
import { saldoDaOrganizacao, type FonteCarteira } from "@/lib/billing/tokens/saldo-da-organizacao";
import { linhasDeTokensDeIA, type LinhasDeTokensDeIA } from "@/lib/billing/tokens/linhas-da-tela";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BotaoCancelarAssinatura } from "./_botao-cancelar-assinatura";
import { parcelasDoPlanoSemRenovacao, podeCancelarAssinatura } from "./_logica-compra";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { traduzir } from "@/lib/i18n/dicionario";
import { tagDeIdioma } from "@/lib/i18n/datas";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const metadata = { title: "Plano e uso" };
export const dynamic = "force-dynamic";

/**
 * `current_period_end`/`dataPrevistaDaSuspensao` são sempre 00:00 em
 * America/Sao_Paulo (migração 0908, decisão 2 e comentário de
 * `estado-da-assinatura.ts`). Formatar sem fixar o fuso deixaria a data
 * depender do fuso do SERVIDOR (que numa instalação self-host pode não ser
 * SP), não do dia civil que o banco de fato gravou.
 */
const FUSO_SP = "America/Sao_Paulo";

/** Rótulo de cada item, na mesma ordem de `CHAVES_DA_TELA_DE_PLANO`. */
const ROTULO_DA_CHAVE: Record<ChaveDaTelaDePlano, string> = {
  funis: "Funis",
  etapas_por_funil: "Etapas por funil",
  membros: "Membros",
  conexoes: "Conexões",
  integracoes_webhook: "Integrações webhook",
  leads: "Leads",
};

/** Rótulo de cada fonte da carteira de tokens (decisão 6 da fase F2-B). */
const ROTULO_DA_FONTE: Record<FonteCarteira, string> = {
  plano: "Do plano contratado",
  adicional: "Assinatura adicional",
  avulso: "Pacote avulso",
};

export default async function PlanoEUsoPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) {
    redirect("/403");
  }

  const idioma = user.idioma;
  const t = (texto: string) => traduzir(texto, idioma);
  const tagDoIdioma = tagDeIdioma(idioma);

  const admin = createAdminClient();
  const [usoResultado, planoResultado, saldoResultado, bloqueio, assinatura] = await Promise.all([
    usoDaOrganizacao(admin, activeOrg.orgId, logger),
    planoDaOrganizacao(admin, activeOrg.orgId, logger),
    saldoDaOrganizacao(admin, activeOrg.orgId, logger),
    // Fase F3, tarefa 9: sem pipelineIds, esta tela não lista funil por
    // funil, só o resumo da organização. `estadoDoBloqueio` já sai cedo (sem
    // ler uso nem limites de novo) quando o bloqueio não vale, então não
    // duplica o custo das duas leituras acima em toda instalação no modo
    // `avisar` de hoje.
    estadoDoBloqueio(admin, activeOrg.orgId, {}, logger),
    // Fase F4, tarefa 8: o estado da assinatura (em dia, em avaliação,
    // atrasada, suspensa, cancelada), o período e, quando o modo leitura
    // (decisão 5) está valendo de verdade para esta organização, o aviso do
    // que parou e do que continua.
    estadoDaAssinatura(admin, activeOrg.orgId, logger),
  ]);

  const leituraFalhou = usoResultado.leituraFalhou || planoResultado.leituraFalhou;
  const linhas = linhasDaTelaDePlano(usoResultado.uso, planoResultado.limites, leituraFalhou);

  // extratoDoCiclo e estimativaDeRespostas reaproveitam o ciclo e o saldo
  // restante já lidos por saldoDaOrganizacao (quando ela não falhou), para as
  // três leituras nunca discordarem sobre o mês corrente.
  const cicloDoSaldo = saldoResultado.status === "leitura_falhou" ? undefined : saldoResultado.ciclo;
  const saldoRestante =
    saldoResultado.status === "ok" ? saldoResultado.totalDisponivel - saldoResultado.totalConsumido : null;

  const [extratoResultado, estimativaResultado] = await Promise.all([
    extratoDoCiclo(admin, activeOrg.orgId, cicloDoSaldo, logger),
    estimativaDeRespostas(admin, activeOrg.orgId, saldoRestante, logger),
  ]);

  const linhasTokens = linhasDeTokensDeIA(saldoResultado, extratoResultado, estimativaResultado);

  // Fase F5, Tarefa 21: o cartão "Assinatura e pagamento" (links para
  // assinar/comprar, e cancelar) só existe para quem PODE comprar e cancelar
  // (N41, decisão 17): o papel `admin`. Ler as duas chaves da decisão 18 e o
  // vínculo Asaas da organização custaria uma leitura a mais em toda
  // instalação para quem nunca vai ver o cartão, então só roda quando faz
  // sentido.
  const souAdminDaOrganizacao = ROLE_RANK[activeOrg.role] >= ROLE_RANK.admin;
  const [chavesAsaas, asaasOrg] = souAdminDaOrganizacao
    ? await Promise.all([estadoDasChavesAsaas(admin, logger), asaasDaOrganizacao(admin, activeOrg.orgId, logger)])
    : [null, null];

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto p-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t("Plano e uso")}</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          {t("Quanto sua organização usa de cada item do plano contratado.")}
        </p>
        {/* Sem plano (D-094 revisto), o contrato guarda um plano só como chave da linha: não o exibe. */}
        {!leituraFalhou && !(assinatura.contrato && contratoSemPlano(assinatura.contrato)) && (
          <p className="text-sm text-muted-foreground">
            {t("Plano")}: <span className="font-medium text-text">{planoResultado.plano.name}</span>
          </p>
        )}
      </header>

      <CartaoDaAssinatura assinatura={assinatura} t={t} tagDoIdioma={tagDoIdioma} />

      {souAdminDaOrganizacao && chavesAsaas && asaasOrg && !asaasOrg.leituraFalhou && (
        <CartaoDeAssinaturaEPagamento
          chaves={chavesAsaas}
          assinaturaAsaas={asaasOrg.assinatura}
          pedidos={asaasOrg.pedidos}
          fimDoPeriodo={assinatura.contrato?.currentPeriodEnd ?? null}
          tagDoIdioma={tagDoIdioma}
          t={t}
        />
      )}

      <BannerDoBloqueio bloqueio={bloqueio} t={t} tagDoIdioma={tagDoIdioma} />

      {leituraFalhou && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
          {t(
            "Não foi possível ler o plano desta organização agora. Os limites desta tela não refletem a realidade: recarregue a página antes de decidir qualquer coisa com base neles.",
          )}
        </div>
      )}

      <Card>
        <CardContent className="divide-y divide-border/60 p-6">
          {linhas.map((linha) => (
            <LinhaDeUso key={linha.chave} linha={linha} t={t} tagDoIdioma={tagDoIdioma} />
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("Tokens de IA")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <SecaoTokensDeIA linhas={linhasTokens} t={t} tagDoIdioma={tagDoIdioma} />
        </CardContent>
      </Card>
    </div>
  );
}

/** Rótulo de cada estado do contrato (fase F4, tarefa 8), mesmo vocabulário da aba do admin. */
function rotuloDoEstadoDaAssinatura(status: string, t: (texto: string) => string): string {
  switch (status) {
    case "avaliacao":
      return t("Em avaliação");
    case "ativa":
      return t("Em dia");
    case "atrasada":
      return t("Atrasada");
    case "suspensa":
      return t("Suspensa");
    case "cancelada":
      return t("Cancelada");
    default:
      return status;
  }
}

const ESTADO_DA_ASSINATURA_VARIANT: Record<string, "success" | "info" | "warning" | "error" | "neutral"> = {
  avaliacao: "info",
  ativa: "success",
  atrasada: "warning",
  suspensa: "error",
  cancelada: "error",
};

/**
 * O que PARA e o que CONTINUA no modo leitura (decisão 5 da fase F4): texto
 * fixo, na mesma ordem do comentário da migração 0908, parte 2. Nunca traz
 * valor nem dado de pagamento (mesma régua dos avisos da Central,
 * `fn_billing_avisar_assinatura`).
 */
function CartaoDaAssinatura({
  assinatura,
  t,
  tagDoIdioma,
}: {
  assinatura: ResultadoEstadoDaAssinatura;
  t: (texto: string) => string;
  tagDoIdioma: string;
}) {
  if (assinatura.leituraFalhou) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
        {t("Não foi possível ler o estado da assinatura agora. Recarregue a página antes de decidir qualquer coisa com base nele.")}
      </div>
    );
  }

  if (!assinatura.contrato) return null;

  const { contrato, modoLeituraValendo } = assinatura;
  // D-094 revisto: a organização que nunca assinou não está "suspensa por falta de pagamento",
  // está sem plano. Mesmo bloqueio (modo leitura), outra frase.
  const semPlano = contratoSemPlano(contrato);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("Assinatura")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <Badge variant={ESTADO_DA_ASSINATURA_VARIANT[contrato.status] ?? "neutral"}>
            {semPlano ? t("Sem plano") : rotuloDoEstadoDaAssinatura(contrato.status, t)}
          </Badge>
          {contrato.status === "avaliacao" && contrato.currentPeriodEnd && (
            <span className="text-sm text-muted-foreground">
              {t("até")}{" "}
              {ultimoDiaDoPeriodo(contrato.currentPeriodEnd).toLocaleDateString(tagDoIdioma, {
                timeZone: FUSO_SP,
              })}
            </span>
          )}
          {contrato.status === "atrasada" && contrato.dataPrevistaDaSuspensao && (
            <span className="text-sm text-muted-foreground">
              {t("modo leitura a partir de")}{" "}
              {new Date(contrato.dataPrevistaDaSuspensao).toLocaleDateString(tagDoIdioma, {
                timeZone: FUSO_SP,
              })}
            </span>
          )}
        </div>

        {contrato.currentPeriodEnd && (
          <p className="text-sm text-muted-foreground">
            {t("Próximo vencimento")}:{" "}
            <span className="font-medium text-text">
              {ultimoDiaDoPeriodo(contrato.currentPeriodEnd).toLocaleDateString(tagDoIdioma, {
                timeZone: FUSO_SP,
              })}
            </span>
            {contrato.cancelAtPeriodEnd && (
              <span className="ml-2">{t("(a assinatura cancela no fim deste período)")}</span>
            )}
          </p>
        )}

        {modoLeituraValendo && semPlano && (
          <div className="space-y-1.5 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            <p className="font-medium">
              {t("Esta organização ainda não tem um plano. Assine um plano para liberar o uso.")}
            </p>
            <p>
              {t("Ficam parados até lá: a IA, as automações, as campanhas, as importações e os follow-ups.")}
            </p>
          </div>
        )}

        {modoLeituraValendo && !semPlano && (
          <div className="space-y-1.5 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            <p className="font-medium">
              {t("O acesso desta organização está em modo leitura por falta de pagamento.")}
            </p>
            <p>
              {t(
                "Param: a IA, as automações, as campanhas de disparo, os follow-ups e a criação de funil, etapa, integração e convite.",
              )}
            </p>
            <p>
              {t(
                "Continuam: receber mensagem, responder à mão, ler tudo e criar lead.",
              )}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * "Assinatura e pagamento" (fase F5, Tarefa 21): links para assinar um plano
 * ou comprar um pacote de tokens, só quando a compra pelo cliente está
 * LIGADA (as duas chaves da decisão 18), e "Cancelar assinatura", só quando
 * existe assinatura Asaas ativa e não encerrada (`asaas_assinatura_
 * encerrada_em` nulo, decisão 22). Só renderizado para o papel `admin`
 * (`page.tsx` já filtra isso antes de montar os dois objetos que este
 * componente recebe).
 */
function CartaoDeAssinaturaEPagamento({
  chaves,
  assinaturaAsaas,
  pedidos,
  fimDoPeriodo,
  tagDoIdioma,
  t,
}: {
  chaves: EstadoDasChavesAsaas;
  assinaturaAsaas: AssinaturaAsaasDaOrganizacao | null;
  pedidos: PedidoAsaas[];
  /** `current_period_end` do contrato (D-177: a data em que o plano parcelado acaba). */
  fimDoPeriodo: string | null;
  tagDoIdioma: string;
  t: (texto: string) => string;
}) {
  // D-177: plano pago em parcelas no cartão não renova sozinho (cobrança parcelada avulsa, sem assinatura).
  const parcelasSemRenovacao = parcelasDoPlanoSemRenovacao({
    assinaturaDoContrato: assinaturaAsaas,
    pedidos: pedidos.map((p) => ({ tipo: p.tipo, status: p.status, parcelas: p.parcelas, pagoEm: p.pagoEm })),
  });
  const podeComprar = chaves.habilitado && chaves.erroConfiguracao === null && chaves.compraPeloCliente;
  // Também com assinatura AGENDADA em pedido de cartão aguardando pagamento (o contrato ainda não
  // guarda o id dela): ver `podeCancelarAssinatura`.
  const podeCancelar = podeCancelarAssinatura({
    habilitado: chaves.habilitado,
    erroConfiguracao: chaves.erroConfiguracao,
    ambiente: chaves.ambiente,
    assinaturaDoContrato: assinaturaAsaas,
    pedidos,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("Assinatura e pagamento")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {podeComprar ? (
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href="/app/settings/plano/assinar#planos">{t("Assinar um plano")}</Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href="/app/settings/plano/assinar#pacotes">{t("Comprar pacote de tokens")}</Link>
            </Button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t("A compra pela tela ainda não está disponível. Fale com o suporte.")}
          </p>
        )}

        {parcelasSemRenovacao !== null && fimDoPeriodo && (
          <div className="space-y-1 rounded-md border border-border p-3 text-sm" data-testid="plano-parcelado-sem-renovacao">
            <p>
              {t("Pago parcelado no cartão. Este plano não renova sozinho: o acesso vai até")}{" "}
              <span className="font-medium">
                {ultimoDiaDoPeriodo(fimDoPeriodo).toLocaleDateString(tagDoIdioma, { timeZone: FUSO_SP })}
              </span>
              . ({parcelasSemRenovacao}x)
            </p>
            <p className="text-xs text-muted-foreground">
              {t("Para continuar depois dessa data, faça uma nova compra antes do fim do período.")}
            </p>
          </div>
        )}

        {podeCancelar && <BotaoCancelarAssinatura />}
      </CardContent>
    </Card>
  );
}

/**
 * O banner do topo, desligado, em carência, ou valendo (fase F3, tarefa 9).
 *
 * Três estados, um por parágrafo, nunca misturados: o de hoje (modo `avisar`
 * ou `desligado`) não pode virar "cheguei no teto"; o de carência precisa da
 * DATA, para o dono da operação saber quanto tempo falta; o de valendo lista
 * os itens no teto, um a um, com o motivo que `estadoDoBloqueio` já monta em
 * português.
 */
function BannerDoBloqueio({
  bloqueio,
  t,
  tagDoIdioma,
}: {
  bloqueio: EstadoDoBloqueio;
  t: (texto: string) => string;
  tagDoIdioma: string;
}) {
  if (bloqueio.vale) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
        <p>
          {t(
            "O bloqueio do plano está valendo para esta organização. Os itens no teto abaixo não deixam criar nem reativar mais, até o plano aumentar ou algo ser liberado.",
          )}
        </p>
        {bloqueio.itensNoTeto.length > 0 && (
          <ul className="mt-2 list-disc space-y-0.5 pl-5">
            {bloqueio.itensNoTeto.map((item, i) => (
              <li key={`${item.chave}-${item.pipelineId ?? i}`}>
                <span className="font-medium">{t(ROTULO_DA_CHAVE[item.chave])}</span>: {item.motivo}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  if (bloqueio.emCarencia && bloqueio.carenciaAte) {
    return (
      <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-200">
        {t("O bloqueio do plano está em carência até")}{" "}
        <span className="font-medium">
          {new Date(bloqueio.carenciaAte).toLocaleDateString(tagDoIdioma)}
        </span>
        . {t("Depois dessa data, os itens no teto impedem criar ou reativar mais.")}
      </div>
    );
  }

  return (
    <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-200">
      {t("Nesta fase nenhum limite bloqueia.")}
    </div>
  );
}

function LinhaDeUso({
  linha,
  t,
  tagDoIdioma,
}: {
  linha: LinhaDaTelaDePlano;
  t: (texto: string) => string;
  tagDoIdioma: string;
}) {
  const rotulo = t(ROTULO_DA_CHAVE[linha.chave]);

  return (
    <div className="space-y-1.5 py-3 first:pt-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">{rotulo}</span>
        <span className="flex items-center gap-2 text-sm text-muted-foreground">
          {linha.atual === null ? (
            t("Não foi possível medir agora.")
          ) : linha.semLimite ? (
            <>
              {linha.atual.toLocaleString(tagDoIdioma)} · {t("sem limite")}
            </>
          ) : (
            <>
              {linha.atual.toLocaleString(tagDoIdioma)} {t("de")} {linha.teto?.toLocaleString(tagDoIdioma)}
            </>
          )}
          {linha.estourou && <Badge variant="warning">{t("No teto")}</Badge>}
        </span>
      </div>

      {linha.percentual !== null && (
        <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={`h-full transition-all ${linha.estourou ? "bg-destructive" : "bg-primary"}`}
            style={{ width: `${linha.percentual}%` }}
            role="progressbar"
            aria-valuenow={linha.percentual}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={rotulo}
          />
        </div>
      )}

      {linha.chave === "etapas_por_funil" && (
        <p className="text-xs text-muted-foreground">
          {t("O número é do funil com mais etapas ativas.")}
        </p>
      )}
    </div>
  );
}

/** `dia` (formato `YYYY-MM-DD`) no idioma de quem está lendo, sem hora nenhuma. */
function formatarDia(dia: string, tagDoIdioma: string): string {
  const comHora = new Date(`${dia}T00:00:00Z`);
  return new Intl.DateTimeFormat(tagDoIdioma, { day: "2-digit", month: "2-digit", timeZone: "UTC" }).format(
    comHora,
  );
}

/** O rótulo de uma linha do extrato por agente: nome do banco, ou uma das duas frases fixas (tarefa 6). */
function rotuloDoAgente(linha: LinhaExtratoPorAgente, t: (texto: string) => string): string {
  if (linha.tipo === "agente") return linha.nome ?? "";
  if (linha.tipo === "agente_removido") return t("Agente removido");
  return t("Conferências e mídia");
}

function SecaoTokensDeIA({
  linhas,
  t,
  tagDoIdioma,
}: {
  linhas: LinhasDeTokensDeIA;
  t: (texto: string) => string;
  tagDoIdioma: string;
}) {
  if (linhas.leituraFalhou || linhas.carteira === null || linhas.estimativa === null) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
        {t(
          "Não foi possível ler o consumo de tokens de IA agora. Os números desta seção não refletem a realidade: recarregue a página antes de decidir qualquer coisa com base neles.",
        )}
      </div>
    );
  }

  const { carteira, estimativa, extratoPorDia, extratoPorAgente } = linhas;

  return (
    <>
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm font-medium">{t("Consumo do mês")}</span>
          <span className="text-sm text-muted-foreground">
            {carteira.semLimite ? (
              <>
                {carteira.totalConsumido.toLocaleString(tagDoIdioma)} · {t("sem limite")}
              </>
            ) : (
              <>
                {carteira.totalConsumido.toLocaleString(tagDoIdioma)} {t("de")}{" "}
                {carteira.totalDisponivel?.toLocaleString(tagDoIdioma)}
              </>
            )}
            {carteira.estourou && <Badge variant="warning">{t("No teto")}</Badge>}
          </span>
        </div>

        {/*
          Item 13 da revisão (23/09/2026): concessão pendente não é "estourou"
          nem passa em silêncio. A tela avisa que o crédito do mês ainda está
          sendo liberado, para o número acima (emprestado do teto efetivo) não
          parecer o retrato final.
        */}
        {carteira.concessaoPendente && (
          <Badge variant="info">{t("Carregando o crédito do mês. Atualize a página em instantes.")}</Badge>
        )}

        {carteira.percentual !== null && (
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div
              className={`h-full transition-all ${carteira.estourou ? "bg-destructive" : "bg-primary"}`}
              style={{ width: `${carteira.percentual}%` }}
              role="progressbar"
              aria-valuenow={carteira.percentual}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={t("Consumo do mês")}
            />
          </div>
        )}

        {carteira.saldoNegativo && (
          <p className="text-xs text-amber-700 dark:text-amber-300">
            {t("O consumo passou do contratado. Nesta fase a IA continua respondendo normalmente.")}
          </p>
        )}
      </div>

      <div className="space-y-1.5">
        <span className="text-sm font-medium">{t("Saldo por fonte")}</span>
        <ul className="space-y-1 text-sm text-muted-foreground">
          {carteira.fontes.map((fonte) => (
            <li key={fonte.fonte} className="flex items-center justify-between gap-2">
              <span>{t(ROTULO_DA_FONTE[fonte.fonte])}</span>
              <span>
                {fonte.saldo.toLocaleString(tagDoIdioma)} {t("de")} {fonte.creditado.toLocaleString(tagDoIdioma)}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className="space-y-1">
        {estimativa.respostasQueCabem !== null ? (
          <p className="text-sm">
            {t("Dá para aproximadamente")}{" "}
            <span className="font-medium text-text">{estimativa.respostasQueCabem.toLocaleString(tagDoIdioma)}</span>{" "}
            {t("respostas da IA.")}
          </p>
        ) : (
          <p className="text-sm">
            {t("Cada resposta usa, em média,")}{" "}
            <span className="font-medium text-text">{estimativa.tokensPorResposta.toLocaleString(tagDoIdioma)}</span>{" "}
            {t("tokens ponderados.")}
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          {estimativa.baseadoEmAmostra
            ? t("Estimativa pelo seu consumo dos últimos 30 dias.")
            : t("Estimativa pela média de referência: ainda não há consumo suficiente para medir o seu.")}
        </p>
      </div>

      <div className="space-y-3">
        <span className="text-sm font-medium">{t("Extrato do mês")}</span>

        {extratoPorDia.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("Nenhum consumo registrado neste ciclo ainda.")}</p>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            <ExtratoPorDia linhas={extratoPorDia} t={t} tagDoIdioma={tagDoIdioma} />
            <ExtratoPorAgente linhas={extratoPorAgente} t={t} tagDoIdioma={tagDoIdioma} />
          </div>
        )}
      </div>
    </>
  );
}

function ExtratoPorDia({
  linhas,
  t,
  tagDoIdioma,
}: {
  linhas: LinhaExtratoPorDia[];
  t: (texto: string) => string;
  tagDoIdioma: string;
}) {
  return (
    <div className="space-y-1.5">
      <span className="text-xs font-medium text-muted-foreground">{t("Por dia")}</span>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("Dia")}</TableHead>
            <TableHead className="text-right">{t("Tokens")}</TableHead>
            <TableHead className="text-right">{t("Chamadas")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {linhas.map((linha) => (
            <TableRow key={linha.dia}>
              <TableCell>{formatarDia(linha.dia, tagDoIdioma)}</TableCell>
              <TableCell className="text-right">{linha.tokensPonderados.toLocaleString(tagDoIdioma)}</TableCell>
              <TableCell className="text-right">{linha.chamadas.toLocaleString(tagDoIdioma)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function ExtratoPorAgente({
  linhas,
  t,
  tagDoIdioma,
}: {
  linhas: LinhaExtratoPorAgente[];
  t: (texto: string) => string;
  tagDoIdioma: string;
}) {
  return (
    <div className="space-y-1.5">
      <span className="text-xs font-medium text-muted-foreground">{t("Por agente")}</span>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("Agente")}</TableHead>
            <TableHead className="text-right">{t("Tokens")}</TableHead>
            <TableHead className="text-right">{t("Chamadas")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {linhas.map((linha) => (
            <TableRow key={linha.agentId ?? linha.tipo}>
              <TableCell>{rotuloDoAgente(linha, t)}</TableCell>
              <TableCell className="text-right">{linha.tokensPonderados.toLocaleString(tagDoIdioma)}</TableCell>
              <TableCell className="text-right">{linha.chamadas.toLocaleString(tagDoIdioma)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
