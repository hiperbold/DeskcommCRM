import Link from "next/link";
import { notFound } from "next/navigation";

import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { loadAuthUser } from "@/lib/auth/server";
import {
  contadoresDeAlarmeAsaas,
  estadoDasChavesAsaas,
  eventosAsaas,
  pedidosAsaas,
  planosParaVenda,
} from "@/lib/billing/asaas/leitura";
import { createAdminClient } from "@/lib/supabase/admin";
import { traduzir } from "@/lib/i18n/dicionario";
import { tagDeIdioma } from "@/lib/i18n/datas";
import { formatCentsBRL } from "@/lib/money";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

import {
  AlternarCompraPeloCliente,
  AlternarPlanoAVenda,
  BotaoDeReprocessarEvento,
  FormularioDeCancelarPedido,
} from "./_client";

export const metadata = { title: "Cobrança (Asaas)" };
export const dynamic = "force-dynamic";

/**
 * A tela de cobrança da instalação para a fase F5 (`hiperbold/planos/fase-F5-
 * tarefas.md`): estado das duas chaves da decisão 18, planos à venda,
 * pedidos, eventos do webhook (sem o payload cru) e os contadores de alarme
 * da decisão 21 (Tarefa 18); ligar/desligar a compra pelo cliente, pôr/tirar
 * plano à venda, reprocessar evento e cancelar pedido aberto (Tarefa 19, que
 * liga esta tela às cinco ações de `app/actions/admin/cobrancaAsaas.ts`,
 * Tarefa 17).
 *
 * ─── Onde mora a barreira de verdade ────────────────────────────────────────
 *
 * `podeEscrever` aqui só decide o que a tela MOSTRA (mesmo padrão de
 * `podeEscreverNaAba` na aba de plano do tenant): cada ação em `./_client.tsx`
 * chama uma server action que confere de novo `requirePlatformAdmin()`,
 * escopo `full` e MFA em dia. Esconder o botão para quem tem escopo
 * `support_readonly` é conveniência de interface, não segurança.
 *
 * ─── Por que os filtros são `<form method="get">`/`Link`, não client state ─
 *
 * Mesma doutrina do resto desta tela: leitura pura não precisa de
 * interatividade no cliente. Filtrar por querystring mantém a página um
 * Server Component só, sem "use client", e o filtro fica endereçável
 * (compartilhável por link, sobrevive a um F5 do navegador). Só as AÇÕES
 * (Tarefa 19) precisam de um componente cliente à parte.
 */
const RESULTADOS_DO_EVENTO = [
  "aplicado",
  "ja_aplicado",
  "ignorado",
  "outro_app",
  "sem_vinculo",
  "divergente",
  "aguardando",
  "erro",
] as const;

const STATUS_DO_PEDIDO = [
  "criado",
  "processando",
  "aguardando_pagamento",
  "inconclusivo",
  "pago",
  "vencido",
  "cancelado",
  "falhou",
  "estornado",
] as const;

const FUSO_SP = "America/Sao_Paulo";

/** Pedido ainda não concluído (decisões 11 e 25): o único conjunto que "Cancelar pedido" mostra. */
const STATUS_DE_PEDIDO_ABERTO = new Set(["criado", "processando", "aguardando_pagamento", "inconclusivo"]);

/** Resultado de evento que a Tarefa 19 deixa reprocessar (decisão 20, `fn_billing_asaas_reprocessar_evento`). */
const RESULTADOS_REPROCESSAVEIS = new Set(["erro", "sem_vinculo"]);

function variantDoResultado(resultado: string): "success" | "warning" | "error" | "neutral" {
  if (resultado === "aplicado" || resultado === "ja_aplicado") return "success";
  if (resultado === "aguardando") return "warning";
  if (resultado === "erro" || resultado === "divergente" || resultado === "sem_vinculo") return "error";
  return "neutral";
}

interface CobrancaPageProps {
  searchParams: Promise<{ resultado?: string; status?: string; organizacao?: string }>;
}

export default async function CobrancaPage({ searchParams }: CobrancaPageProps) {
  const usuario = await loadAuthUser();
  if (!usuario?.is_platform_admin) notFound();

  // O layout de `(protected)` já roda `requirePlatformAdmin()`; chamá-la de
  // novo aqui é o mesmo padrão de `tenants/[id]/plano/page.tsx` (Tarefa 5,
  // fase F1): é o único jeito de saber o ESCOPO do admin sem duplicar a
  // consulta a `platform_admins` dentro de `loadAuthUser`.
  const { platformAdmin } = await requirePlatformAdmin();
  const podeEscrever = platformAdmin.scope === "full";

  const { resultado, status, organizacao } = await searchParams;
  const admin = createAdminClient();
  const t = (texto: string) => traduzir(texto, usuario.idioma);
  const tagDoIdioma = tagDeIdioma(usuario.idioma);

  const [chaves, planos, pedidosResultado, eventosResultado, alarmesResultado] = await Promise.all([
    estadoDasChavesAsaas(admin),
    planosParaVenda(admin),
    pedidosAsaas(admin, {
      status: status || undefined,
      organizationId: organizacao || undefined,
    }),
    eventosAsaas(admin, { resultado: resultado || undefined }),
    contadoresDeAlarmeAsaas(admin),
  ]);

  const formatarData = (iso: string | null) =>
    iso ? new Date(iso).toLocaleString(tagDoIdioma, { timeZone: FUSO_SP }) : "-";

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Link
          href="/admin/sistema"
          className="text-sm text-primary underline-offset-4 hover:underline"
        >
          {t("Voltar para Comportamento da instalação")}
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">{t("Cobrança (Asaas)")}</h1>
        <p className="text-sm text-muted-foreground">
          {t(
            "Estado da integração, planos à venda, pedidos, eventos do webhook e alarmes.",
          )}
        </p>
      </div>

      {/* Chaves (decisão 18) */}
      <Card>
        <CardHeader>
          <CardTitle>{t("Chaves")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex flex-wrap items-center gap-3">
            <Badge variant={chaves.habilitado ? "success" : "neutral"}>
              {chaves.habilitado ? t("ASAAS_ENABLED ligada") : t("ASAAS_ENABLED desligada")}
            </Badge>
            <Badge variant={chaves.compraPeloCliente ? "success" : "neutral"}>
              {chaves.compraPeloCliente
                ? t("Compra pelo cliente ligada")
                : t("Compra pelo cliente desligada")}
            </Badge>
            <Badge variant="neutral">
              {chaves.ambiente === "producao" ? t("Ambiente: produção") : t("Ambiente: sandbox")}
            </Badge>
            {podeEscrever && <AlternarCompraPeloCliente ligada={chaves.compraPeloCliente} />}
          </div>
          {chaves.erroConfiguracao && (
            <p className="text-sm text-destructive">
              {t("Erro de configuração")}: {chaves.erroConfiguracao}
            </p>
          )}
          <p className="text-xs text-text-muted">
            {t(
              "As duas chaves precisam estar ligadas ao mesmo tempo para o cliente comprar pela tela.",
            )}
          </p>
        </CardContent>
      </Card>

      {/* Alarmes (decisão 21) */}
      <Card>
        <CardHeader>
          <CardTitle>{t("Alarmes")}</CardTitle>
        </CardHeader>
        <CardContent>
          {alarmesResultado.leituraFalhou ? (
            <p className="text-sm text-destructive">{t("Não foi possível ler os alarmes agora.")}</p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <ContadorDeAlarme
                rotulo={t("Pendente há mais de 1 hora")}
                valor={alarmesResultado.contadores.pendenteHaMaisDeUmaHora}
              />
              <ContadorDeAlarme
                rotulo={t("Erro nas últimas 24h")}
                valor={alarmesResultado.contadores.erroUltimas24h}
              />
              <ContadorDeAlarme
                rotulo={t("Divergente nas últimas 24h")}
                valor={alarmesResultado.contadores.divergenteUltimas24h}
              />
              <ContadorDeAlarme
                rotulo={t("Sem vínculo nas últimas 24h")}
                valor={alarmesResultado.contadores.semVinculoUltimas24h}
              />
              <ContadorDeAlarme
                rotulo={t("Estorno sem corte nas últimas 24h")}
                valor={alarmesResultado.contadores.estornoComCorteFalhouUltimas24h}
              />
              <ContadorDeAlarme
                rotulo={t("Estorno de cobrança antiga nas últimas 24h")}
                valor={alarmesResultado.contadores.estornoDePeriodoAntigoUltimas24h}
              />
              <ContadorDeAlarme
                rotulo={t("Estorno de parcela sem corte nas últimas 24h")}
                valor={alarmesResultado.contadores.estornoParcialDoParcelamentoUltimas24h}
              />
              <ContadorDeAlarme
                rotulo={t("Chargeback confirmado nas últimas 24h")}
                valor={alarmesResultado.contadores.chargebackConfirmadoUltimas24h}
              />
              <ContadorDeAlarme
                rotulo={t("Parcelamento removido com pagamento nas últimas 24h")}
                valor={alarmesResultado.contadores.parcelamentoRemovidoComPagamentoUltimas24h}
              />
              <ContadorDeAlarme
                rotulo={t("Sem evento há 3 dias, assinatura ativa")}
                valor={alarmesResultado.contadores.semEventoHa3DiasComAssinaturaAtiva}
              />
            </div>
          )}
        </CardContent>
      </Card>

      {/* Planos à venda */}
      <Card>
        <CardHeader>
          <CardTitle>{t("Planos")}</CardTitle>
        </CardHeader>
        <CardContent>
          {planos.leituraFalhou ? (
            <p className="text-sm text-destructive">{t("Não foi possível ler os planos agora.")}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("Plano")}</TableHead>
                  <TableHead>{t("À venda")}</TableHead>
                  <TableHead>{t("Preço mensal")}</TableHead>
                  <TableHead>{t("Preço semestral")}</TableHead>
                  <TableHead>{t("Preço anual")}</TableHead>
                  {podeEscrever && <TableHead />}
                </TableRow>
              </TableHeader>
              <TableBody>
                {planos.planos.map((p) => (
                  <TableRow key={p.code}>
                    <TableCell className="font-medium">{p.name}</TableCell>
                    <TableCell>
                      <Badge variant={p.forSale ? "success" : "neutral"}>
                        {p.forSale ? t("Sim") : t("Não")}
                      </Badge>
                    </TableCell>
                    <TableCell>{formatCentsBRL(p.priceMonthlyCents)}</TableCell>
                    <TableCell>
                      {p.priceSemiannualCents === null ? t("não definido") : formatCentsBRL(p.priceSemiannualCents)}
                    </TableCell>
                    <TableCell>
                      {p.priceYearlyCents === null ? t("não definido") : formatCentsBRL(p.priceYearlyCents)}
                    </TableCell>
                    {podeEscrever && (
                      <TableCell>
                        <AlternarPlanoAVenda
                          planCode={p.code}
                          forSale={p.forSale}
                          podeVender={p.priceMonthlyCents > 0}
                        />
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Pedidos */}
      <Card>
        <CardHeader>
          <CardTitle>{t("Pedidos")}</CardTitle>
          <CardDescription>{t("Filtre por organização e por status.")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <form method="get" className="flex flex-wrap items-end gap-2">
            <div className="space-y-1.5">
              <label htmlFor="organizacao" className="block text-xs text-text-muted">
                {t("Organização (id)")}
              </label>
              <Input
                id="organizacao"
                name="organizacao"
                defaultValue={organizacao ?? ""}
                className="w-72"
                placeholder={t("uuid da organização")}
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="status" className="block text-xs text-text-muted">
                {t("Status")}
              </label>
              <select
                id="status"
                name="status"
                defaultValue={status ?? ""}
                className="h-10 w-48 rounded-sm border border-border bg-bg px-3 text-sm text-text"
              >
                <option value="">{t("Todos")}</option>
                {STATUS_DO_PEDIDO.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
            <Button type="submit" variant="secondary" size="sm">
              {t("Filtrar")}
            </Button>
            {(status || organizacao) && (
              <Link
                href="/admin/sistema/cobranca"
                className="text-sm text-primary underline-offset-4 hover:underline"
              >
                {t("Limpar filtro")}
              </Link>
            )}
          </form>

          {pedidosResultado.leituraFalhou ? (
            <p className="text-sm text-destructive">{t("Não foi possível ler os pedidos agora.")}</p>
          ) : pedidosResultado.pedidos.length === 0 ? (
            <p className="text-sm text-text-muted">{t("Nenhum pedido encontrado.")}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("Organização")}</TableHead>
                  <TableHead>{t("Tipo")}</TableHead>
                  <TableHead>{t("Método")}</TableHead>
                  <TableHead>{t("Valor")}</TableHead>
                  <TableHead>{t("Status")}</TableHead>
                  <TableHead>{t("Ambiente")}</TableHead>
                  <TableHead>{t("Criado em")}</TableHead>
                  {podeEscrever && <TableHead />}
                </TableRow>
              </TableHeader>
              <TableBody>
                {pedidosResultado.pedidos.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell>
                      <Link
                        className="text-primary underline-offset-4 hover:underline"
                        href={`/admin/tenants/${p.organizationId}/plano`}
                      >
                        {p.organizationId.slice(0, 8)}
                      </Link>
                    </TableCell>
                    <TableCell>{p.tipo === "assinatura" ? t("Assinatura") : t("Pacote de tokens")}</TableCell>
                    <TableCell>{p.metodo}</TableCell>
                    <TableCell>{formatCentsBRL(p.amountCents)}</TableCell>
                    <TableCell>
                      <Badge variant="neutral">{p.status}</Badge>
                    </TableCell>
                    <TableCell>{p.ambiente === "producao" ? t("Produção") : t("Sandbox")}</TableCell>
                    <TableCell>{formatarData(p.criadoEm)}</TableCell>
                    {podeEscrever && (
                      <TableCell>
                        {STATUS_DE_PEDIDO_ABERTO.has(p.status) && (
                          <FormularioDeCancelarPedido organizationId={p.organizationId} pedidoId={p.id} />
                        )}
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Eventos do webhook */}
      <Card>
        <CardHeader>
          <CardTitle>{t("Eventos do webhook")}</CardTitle>
          <CardDescription>{t("Sem o corpo cru do evento por padrão. Filtre por resultado.")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Link href="/admin/sistema/cobranca">
              <Badge variant={!resultado ? "info" : "neutral"}>{t("Todos")}</Badge>
            </Link>
            {RESULTADOS_DO_EVENTO.map((r) => (
              <Link key={r} href={`/admin/sistema/cobranca?resultado=${r}`}>
                <Badge variant={resultado === r ? "info" : variantDoResultado(r)}>{r}</Badge>
              </Link>
            ))}
          </div>

          {eventosResultado.leituraFalhou ? (
            <p className="text-sm text-destructive">{t("Não foi possível ler os eventos agora.")}</p>
          ) : eventosResultado.eventos.length === 0 ? (
            <p className="text-sm text-text-muted">{t("Nenhum evento encontrado.")}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("Tipo")}</TableHead>
                  <TableHead>{t("Resultado")}</TableHead>
                  <TableHead>{t("Alarme")}</TableHead>
                  <TableHead>{t("Tentativas")}</TableHead>
                  <TableHead>{t("Erro")}</TableHead>
                  <TableHead>{t("Organização")}</TableHead>
                  <TableHead>{t("Recebido em")}</TableHead>
                  <TableHead>{t("Processado em")}</TableHead>
                  {podeEscrever && <TableHead />}
                </TableRow>
              </TableHeader>
              <TableBody>
                {eventosResultado.eventos.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="font-mono text-xs">{e.eventType}</TableCell>
                    <TableCell>
                      <Badge variant={variantDoResultado(e.resultado)}>{e.resultado}</Badge>
                    </TableCell>
                    <TableCell>{e.alarme ?? "-"}</TableCell>
                    <TableCell>{e.tentativas}</TableCell>
                    <TableCell className="max-w-xs truncate">{e.erroCodigo ?? "-"}</TableCell>
                    <TableCell>
                      {e.organizationId ? (
                        <Link
                          className="text-primary underline-offset-4 hover:underline"
                          href={`/admin/tenants/${e.organizationId}/plano`}
                        >
                          {e.organizationId.slice(0, 8)}
                        </Link>
                      ) : (
                        "-"
                      )}
                    </TableCell>
                    <TableCell>{formatarData(e.recebidoEm)}</TableCell>
                    <TableCell>{formatarData(e.processadoEm)}</TableCell>
                    {podeEscrever && (
                      <TableCell>
                        {RESULTADOS_REPROCESSAVEIS.has(e.resultado) && (
                          <BotaoDeReprocessarEvento eventoId={e.id} />
                        )}
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function ContadorDeAlarme({ rotulo, valor }: { rotulo: string; valor: number }) {
  return (
    <div className="rounded-md border border-border p-3">
      <p className="text-2xl font-semibold">{valor}</p>
      <p className="text-xs text-text-muted">{rotulo}</p>
    </div>
  );
}
