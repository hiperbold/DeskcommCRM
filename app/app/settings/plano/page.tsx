/**
 * Configurações → Plano e uso (fase F2 dos planos de assinatura, tarefa 7).
 *
 * ── O que esta tela mostra, e o que ela NÃO faz ainda ────────────────────────
 *
 * Item por item da matriz do plano (funis, etapas por funil, membros,
 * conexões, integrações webhook, leads), quanto a organização usa contra o
 * teto contratado. Nesta fase nenhum teto bloqueia, o aviso fixo no topo
 * existe para ninguém confundir "cheguei no teto" com "fui barrado": a trava
 * de verdade é da F3 (`hiperbold/planos/fase-F2-tarefas.md`).
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
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
  const [usoResultado, planoResultado, saldoResultado] = await Promise.all([
    usoDaOrganizacao(admin, activeOrg.orgId, logger),
    planoDaOrganizacao(admin, activeOrg.orgId, logger),
    saldoDaOrganizacao(admin, activeOrg.orgId, logger),
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

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto p-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t("Plano e uso")}</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          {t("Quanto sua organização usa de cada item do plano contratado.")}
        </p>
        {!leituraFalhou && (
          <p className="text-sm text-muted-foreground">
            {t("Plano")}: <span className="font-medium text-text">{planoResultado.plano.name}</span>
          </p>
        )}
      </header>

      <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-200">
        {t("Nesta fase nenhum limite bloqueia.")}
      </div>

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
