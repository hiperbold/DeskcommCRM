import "server-only";

/**
 * Leitura do Asaas para as telas do admin (fase F5, Tarefa 18, decisão que
 * fecha as tarefas 17/19: "a tela pode escrever" é assunto delas, esta
 * mora só do lado de LER).
 *
 * ─── Nunca lança, mesma doutrina de `lib/billing/assinatura/estado-da-
 * assinatura.ts` e `lib/billing/planos/plano-da-organizacao.ts` ───────────
 *
 * Uma falha de leitura aqui não pode virar "sem chave", "nenhum pedido" ou
 * "nenhum alarme" por acidente: cada função devolve `leituraFalhou: true` e
 * um resultado vazio/neutro, nunca um estado inventado. Quem chama mostra
 * "não foi possível ler agora", nunca finge saber.
 *
 * ─── O que NUNCA sai daqui (restrição fixa 4 da fase) ──────────────────────
 *
 * `ASAAS_API_KEY` inteira: só o booleano `habilitado` (a chave está
 * configurada) e o `ambiente` DERIVADO da base (nunca a chave em si, mesma
 * doutrina de `configDoAsaas()`). `payload` cru do webhook: as colunas lidas
 * de `asaas_webhook_events` nunca incluem `payload` (`COLUNAS_DO_EVENTO`
 * abaixo é uma lista fechada, sem essa coluna). Nome, CPF/CNPJ, e-mail e
 * celular do pagador: `billing_customers` só guarda `asaas_customer_id` e
 * `ambiente` (decisão 16), então não há dado pessoal para vazar aqui.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Logger } from "@/lib/agent-engine/obs/logger";
import {
  compraLigada,
  configDoAsaas,
  ErroConfiguracaoAsaas,
  type AmbienteAsaas,
} from "@/lib/billing/asaas/config";
import { env } from "@/lib/env";

function mensagemDeErro(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}

// ─────────────────────────────────────────────────────────────────────────
// 1. Estado das duas chaves (decisão 18) e o ambiente derivado da base.
// ─────────────────────────────────────────────────────────────────────────

export interface EstadoDasChavesAsaas {
  /** A PRIMEIRA chave da decisão 18: `ASAAS_ENABLED` no ambiente do servidor. */
  habilitado: boolean;
  /**
   * Derivado da base configurada (nunca de uma variável própria, mesma
   * doutrina de `configDoAsaas()`). Vale `"sandbox"` como valor neutro
   * quando desligado ou com erro de configuração: nada faz chamada de rede
   * nesse caso.
   */
  ambiente: AmbienteAsaas;
  /**
   * A SEGUNDA chave da decisão 18: `billing_settings.compra_pelo_cliente`.
   * Só considera o banco quando `habilitado` é verdadeiro E não há erro de
   * configuração (mesmo fail-closed de `compraLigada`).
   */
  compraPeloCliente: boolean;
  /**
   * A mensagem de `ErroConfiguracaoAsaas` (base e chave incoerentes entre
   * si), NUNCA a chave em si: as mensagens de `configDoAsaas()` citam só
   * nomes de variável e prefixo esperado. `null` quando a configuração está
   * coerente ou desligada.
   */
  erroConfiguracao: string | null;
}

/**
 * O estado das duas chaves da decisão 18, para a tela da instalação. Nunca
 * lança: um erro de configuração (`ErroConfiguracaoAsaas`) vira
 * `erroConfiguracao` preenchido, não uma exceção que derruba a tela.
 */
export async function estadoDasChavesAsaas(
  admin: SupabaseClient,
  log?: Logger,
): Promise<EstadoDasChavesAsaas> {
  const habilitado = env.ASAAS_ENABLED;
  let ambiente: AmbienteAsaas = "sandbox";
  let erroConfiguracao: string | null = null;

  try {
    const config = configDoAsaas();
    ambiente = config.ambiente;
  } catch (err) {
    if (err instanceof ErroConfiguracaoAsaas) {
      erroConfiguracao = err.message;
    } else {
      erroConfiguracao = "Não foi possível ler a configuração do Asaas.";
      log?.error("alarme_asaas_leitura", {
        etapa: "estado_das_chaves",
        erro: mensagemDeErro(err),
      });
    }
  }

  // A compra pelo cliente só é considerada ligada quando as DUAS metades da
  // decisão 18 concordam: ambiente habilitado, coerente, E o banco também diz
  // sim (`compraLigada` já é fail-closed por conta própria).
  const compraPeloCliente = await compraLigada(admin, habilitado && erroConfiguracao === null);

  return { habilitado, ambiente, compraPeloCliente, erroConfiguracao };
}

// ─────────────────────────────────────────────────────────────────────────
// 2. Planos com `for_sale` e preço.
// ─────────────────────────────────────────────────────────────────────────

export interface PlanoParaVenda {
  code: string;
  name: string;
  version: number;
  forSale: boolean;
  priceMonthlyCents: number;
  /** `null` até o Filipe definir (N8/N9, restrição fixa 3 da fase). */
  priceYearlyCents: number | null;
}

export interface ResultadoPlanosParaVenda {
  planos: PlanoParaVenda[];
  leituraFalhou: boolean;
}

interface LinhaDoPlanoCru {
  code: string;
  name: string;
  version: number;
  for_sale: boolean;
  price_monthly_cents: number;
  price_yearly_cents: number | null;
}

/** Todo plano ATIVO (a versão em vigor de cada `code`), com `for_sale` e preço. Nunca lança. */
export async function planosParaVenda(
  admin: SupabaseClient,
  log?: Logger,
): Promise<ResultadoPlanosParaVenda> {
  try {
    const { data, error } = await admin
      .from("billing_plans")
      .select("code, name, version, for_sale, price_monthly_cents, price_yearly_cents")
      .eq("active", true)
      .order("price_monthly_cents", { ascending: true });

    if (error) throw new Error(`ler billing_plans: ${error.message}`);

    const linhas = (data ?? []) as unknown as LinhaDoPlanoCru[];
    return {
      planos: linhas.map((l) => ({
        code: l.code,
        name: l.name,
        version: l.version,
        forSale: l.for_sale,
        priceMonthlyCents: l.price_monthly_cents,
        priceYearlyCents: l.price_yearly_cents,
      })),
      leituraFalhou: false,
    };
  } catch (err) {
    log?.error("alarme_asaas_leitura", { etapa: "planos_para_venda", erro: mensagemDeErro(err) });
    return { planos: [], leituraFalhou: true };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 3. Pedidos (`billing_orders`), com filtro por organização e por status.
// ─────────────────────────────────────────────────────────────────────────

export interface FiltroDePedidosAsaas {
  organizationId?: string;
  status?: string;
  limite?: number;
}

export interface PedidoAsaas {
  id: string;
  organizationId: string;
  ambiente: AmbienteAsaas;
  tipo: string;
  ciclo: string | null;
  metodo: string;
  amountCents: number;
  status: string;
  externalReference: string;
  asaasPaymentId: string | null;
  asaasSubscriptionId: string | null;
  invoiceUrl: string | null;
  criadoEm: string;
  atualizadoEm: string;
  pagoEm: string | null;
}

export interface ResultadoPedidosAsaas {
  pedidos: PedidoAsaas[];
  leituraFalhou: boolean;
}

interface LinhaDoPedidoCru {
  id: string;
  organization_id: string;
  ambiente: AmbienteAsaas;
  tipo: string;
  ciclo: string | null;
  metodo: string;
  amount_cents: number;
  status: string;
  external_reference: string;
  asaas_payment_id: string | null;
  asaas_subscription_id: string | null;
  invoice_url: string | null;
  created_at: string;
  updated_at: string;
  pago_em: string | null;
}

const LIMITE_PADRAO_DE_PEDIDOS = 200;

const COLUNAS_DO_PEDIDO =
  "id, organization_id, ambiente, tipo, ciclo, metodo, amount_cents, status, external_reference, asaas_payment_id, asaas_subscription_id, invoice_url, created_at, updated_at, pago_em";

function linhaDoPedidoParaPedido(l: LinhaDoPedidoCru): PedidoAsaas {
  return {
    id: l.id,
    organizationId: l.organization_id,
    ambiente: l.ambiente,
    tipo: l.tipo,
    ciclo: l.ciclo,
    metodo: l.metodo,
    amountCents: l.amount_cents,
    status: l.status,
    externalReference: l.external_reference,
    asaasPaymentId: l.asaas_payment_id,
    asaasSubscriptionId: l.asaas_subscription_id,
    invoiceUrl: l.invoice_url,
    criadoEm: l.created_at,
    atualizadoEm: l.updated_at,
    pagoEm: l.pago_em,
  };
}

/**
 * Pedidos (`billing_orders`), mais recente primeiro. `filtro.organizationId`
 * é o que a seção "Asaas" da aba do tenant usa (Tarefa 18); `filtro.status` é
 * o que o filtro da tela da instalação usa. Os dois juntam-se numa aba só
 * quando os dois vierem preenchidos. Nunca lança.
 */
export async function pedidosAsaas(
  admin: SupabaseClient,
  filtro: FiltroDePedidosAsaas = {},
  log?: Logger,
): Promise<ResultadoPedidosAsaas> {
  try {
    let consulta = admin.from("billing_orders").select(COLUNAS_DO_PEDIDO);
    if (filtro.organizationId) consulta = consulta.eq("organization_id", filtro.organizationId);
    if (filtro.status) consulta = consulta.eq("status", filtro.status);

    const { data, error } = await consulta
      .order("created_at", { ascending: false })
      .limit(filtro.limite ?? LIMITE_PADRAO_DE_PEDIDOS);

    if (error) throw new Error(`ler billing_orders: ${error.message}`);

    const linhas = (data ?? []) as unknown as LinhaDoPedidoCru[];
    return { pedidos: linhas.map(linhaDoPedidoParaPedido), leituraFalhou: false };
  } catch (err) {
    log?.error("alarme_asaas_leitura", {
      etapa: "pedidos_asaas",
      organization_id: filtro.organizationId ?? null,
      erro: mensagemDeErro(err),
    });
    return { pedidos: [], leituraFalhou: true };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 4. Eventos do webhook, com filtro por `resultado`, SEM o payload cru.
// ─────────────────────────────────────────────────────────────────────────

export interface FiltroDeEventosAsaas {
  resultado?: string;
  limite?: number;
}

export interface EventoAsaas {
  id: string;
  eventType: string;
  resourceId: string | null;
  ambiente: AmbienteAsaas;
  origem: string;
  recebidoEm: string;
  processadoEm: string | null;
  resultado: string;
  tentativas: number;
  proximaTentativaEm: string | null;
  erroCodigo: string | null;
  organizationId: string | null;
  /** Código (ou vários, separados por vírgula) da decisão 21; `null` quando o evento não precisa de atenção. */
  alarme: string | null;
}

export interface ResultadoEventosAsaas {
  eventos: EventoAsaas[];
  leituraFalhou: boolean;
}

interface LinhaDoEventoCru {
  id: string;
  event_type: string;
  resource_id: string | null;
  ambiente: AmbienteAsaas;
  origem: string;
  recebido_em: string;
  processado_em: string | null;
  resultado: string;
  tentativas: number;
  proxima_tentativa_em: string | null;
  erro_codigo: string | null;
  organization_id: string | null;
  alarme: string | null;
}

const LIMITE_PADRAO_DE_EVENTOS = 200;

/**
 * Colunas do evento SEM `payload` (restrição fixa 4 da fase): a tela do
 * admin nunca abre o corpo cru do webhook por esta leitura. Lista FECHADA de
 * propósito: um `select("*")` voltaria a trazer o payload por acidente na
 * primeira coluna nova.
 */
const COLUNAS_DO_EVENTO =
  "id, event_type, resource_id, ambiente, origem, recebido_em, processado_em, resultado, tentativas, proxima_tentativa_em, erro_codigo, organization_id, alarme";

/** Eventos do webhook (e da conciliação, `origem = 'conciliacao'`), mais recente primeiro. Nunca lança. */
export async function eventosAsaas(
  admin: SupabaseClient,
  filtro: FiltroDeEventosAsaas = {},
  log?: Logger,
): Promise<ResultadoEventosAsaas> {
  try {
    let consulta = admin.from("asaas_webhook_events").select(COLUNAS_DO_EVENTO);
    if (filtro.resultado) consulta = consulta.eq("resultado", filtro.resultado);

    const { data, error } = await consulta
      .order("recebido_em", { ascending: false })
      .limit(filtro.limite ?? LIMITE_PADRAO_DE_EVENTOS);

    if (error) throw new Error(`ler asaas_webhook_events: ${error.message}`);

    const linhas = (data ?? []) as unknown as LinhaDoEventoCru[];
    return {
      eventos: linhas.map((l) => ({
        id: l.id,
        eventType: l.event_type,
        resourceId: l.resource_id,
        ambiente: l.ambiente,
        origem: l.origem,
        recebidoEm: l.recebido_em,
        processadoEm: l.processado_em,
        resultado: l.resultado,
        tentativas: l.tentativas,
        proximaTentativaEm: l.proxima_tentativa_em,
        erroCodigo: l.erro_codigo,
        organizationId: l.organization_id,
        alarme: l.alarme,
      })),
      leituraFalhou: false,
    };
  } catch (err) {
    log?.error("alarme_asaas_leitura", { etapa: "eventos_asaas", erro: mensagemDeErro(err) });
    return { eventos: [], leituraFalhou: true };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 5. Contadores de alarme (decisão 21).
// ─────────────────────────────────────────────────────────────────────────

export interface ContadoresDeAlarmeAsaas {
  /** `resultado = 'aguardando'` recebido há mais de 1 hora. */
  pendenteHaMaisDeUmaHora: number;
  /** `resultado = 'erro'` nas últimas 24 horas. */
  erroUltimas24h: number;
  /** `resultado = 'divergente'` nas últimas 24 horas. */
  divergenteUltimas24h: number;
  /** `resultado = 'sem_vinculo'` nas últimas 24 horas. */
  semVinculoUltimas24h: number;
  /**
   * Alarme da INSTALAÇÃO (não por organização, correção da decisão 21): `1`
   * quando existe PELO MENOS UMA assinatura Asaas ativa (`asaas_
   * subscription_id` preenchido e `asaas_assinatura_encerrada_em` nulo, em
   * qualquer organização) e NENHUM evento (webhook ou conciliação, de
   * qualquer organização) chegou nos últimos 3 dias; `0` caso contrário. O
   * sinal é "o webhook parou de chegar", não "esta organização específica
   * está quieta" - uma organização sem transação recente não é um problema,
   * a fila do Asaas parar de entregar é. O prazo é 3 dias, não os 35 do
   * conferidor de vencimento: o Asaas só guarda evento por 14 dias (decisão
   * 21).
   */
  semEventoHa3DiasComAssinaturaAtiva: number;
}

export interface ResultadoContadoresDeAlarmeAsaas {
  contadores: ContadoresDeAlarmeAsaas;
  leituraFalhou: boolean;
}

const CONTADORES_EM_FALHA: ContadoresDeAlarmeAsaas = {
  pendenteHaMaisDeUmaHora: 0,
  erroUltimas24h: 0,
  divergenteUltimas24h: 0,
  semVinculoUltimas24h: 0,
  semEventoHa3DiasComAssinaturaAtiva: 0,
};

const MS_POR_HORA = 60 * 60 * 1000;
const MS_POR_DIA = 24 * MS_POR_HORA;

/**
 * Os contadores de alarme da decisão 21, para a tela da instalação. "Sem
 * evento há 3 dias" é um alarme da INSTALAÇÃO (correção da decisão 21, não
 * mais por organização): só duas contagens (existe assinatura ativa? existe
 * evento recente?), nunca uma lista de organizações. Esta função é uma
 * leitura de EXIBIÇÃO: a autoridade sobre o alarme de verdade é
 * `logger.error` na cron de conciliação (decisão 21, fora desta tarefa).
 * Nunca lança.
 */
export async function contadoresDeAlarmeAsaas(
  admin: SupabaseClient,
  log?: Logger,
): Promise<ResultadoContadoresDeAlarmeAsaas> {
  try {
    const agora = Date.now();
    const haUmaHora = new Date(agora - MS_POR_HORA).toISOString();
    const ha24Horas = new Date(agora - 24 * MS_POR_HORA).toISOString();
    const ha3Dias = new Date(agora - 3 * MS_POR_DIA).toISOString();

    const [pendenteRes, erroRes, divergenteRes, semVinculoRes, assinaturaAtivaRes, eventoRecenteRes] = await Promise.all([
      admin
        .from("asaas_webhook_events")
        .select("id", { count: "exact", head: true })
        .eq("resultado", "aguardando")
        .lt("recebido_em", haUmaHora),
      admin
        .from("asaas_webhook_events")
        .select("id", { count: "exact", head: true })
        .eq("resultado", "erro")
        .gte("recebido_em", ha24Horas),
      admin
        .from("asaas_webhook_events")
        .select("id", { count: "exact", head: true })
        .eq("resultado", "divergente")
        .gte("recebido_em", ha24Horas),
      admin
        .from("asaas_webhook_events")
        .select("id", { count: "exact", head: true })
        .eq("resultado", "sem_vinculo")
        .gte("recebido_em", ha24Horas),
      admin
        .from("billing_contracts")
        .select("organization_id", { count: "exact", head: true })
        .not("asaas_subscription_id", "is", null)
        .is("asaas_assinatura_encerrada_em", null),
      admin.from("asaas_webhook_events").select("id", { count: "exact", head: true }).gte("recebido_em", ha3Dias),
    ]);

    for (const [etapa, r] of [
      ["pendentes", pendenteRes],
      ["erro", erroRes],
      ["divergente", divergenteRes],
      ["sem_vinculo", semVinculoRes],
      ["assinatura_ativa_instalacao", assinaturaAtivaRes],
      ["evento_recente_instalacao", eventoRecenteRes],
    ] as const) {
      if (r.error) throw new Error(`ler alarmes (${etapa}): ${r.error.message}`);
    }

    const existeAssinaturaAtiva = (assinaturaAtivaRes.count ?? 0) > 0;
    const existeEventoRecente = (eventoRecenteRes.count ?? 0) > 0;
    const semEventoHa3Dias = existeAssinaturaAtiva && !existeEventoRecente ? 1 : 0;

    return {
      contadores: {
        pendenteHaMaisDeUmaHora: pendenteRes.count ?? 0,
        erroUltimas24h: erroRes.count ?? 0,
        divergenteUltimas24h: divergenteRes.count ?? 0,
        semVinculoUltimas24h: semVinculoRes.count ?? 0,
        semEventoHa3DiasComAssinaturaAtiva: semEventoHa3Dias,
      },
      leituraFalhou: false,
    };
  } catch (err) {
    log?.error("alarme_asaas_leitura", { etapa: "contadores_de_alarme", erro: mensagemDeErro(err) });
    return { contadores: CONTADORES_EM_FALHA, leituraFalhou: true };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 6. Por organização: cliente, assinatura, pedidos e pagamentos com origem.
// ─────────────────────────────────────────────────────────────────────────

export interface ClienteAsaasDaOrganizacao {
  /** Só o id `cus_...` e o ambiente (decisão 16): nunca nome, CPF/CNPJ, e-mail ou celular. */
  asaasCustomerId: string;
  ambiente: AmbienteAsaas;
}

export interface AssinaturaAsaasDaOrganizacao {
  asaasSubscriptionId: string;
  /** `billing_contracts.asaas_assinatura_encerrada_em` (decisão 22); `null` enquanto a assinatura segue ativa no Asaas. */
  encerradaEm: string | null;
}

export interface PagamentoAsaasComOrigem {
  id: string;
  status: string;
  grossCents: number;
  /** `manual` ou `asaas` (decisão 8). */
  origem: string;
  orderId: string | null;
  paidAt: string;
  /** `null` só em crédito de pacote de tokens vindo do Asaas (decisão 8). */
  billingPeriodStart: string | null;
  billingPeriodEnd: string | null;
  createdAt: string;
}

export interface ResultadoAsaasDaOrganizacao {
  cliente: ClienteAsaasDaOrganizacao | null;
  assinatura: AssinaturaAsaasDaOrganizacao | null;
  pedidos: PedidoAsaas[];
  pagamentos: PagamentoAsaasComOrigem[];
  leituraFalhou: boolean;
}

interface LinhaDoClienteCru {
  asaas_customer_id: string;
  ambiente: AmbienteAsaas;
}

interface LinhaDoContratoAsaasCru {
  asaas_subscription_id: string | null;
  asaas_assinatura_encerrada_em: string | null;
}

interface LinhaDoPagamentoAsaasCru {
  id: string;
  status: string;
  gross_cents: number;
  origem: string;
  order_id: string | null;
  paid_at: string;
  billing_period_start: string | null;
  billing_period_end: string | null;
  created_at: string;
}

/**
 * O que a fase F5 sabe do Asaas para UMA organização, para a seção "Asaas"
 * da aba `tenants/[id]/plano` (Tarefa 18): cliente vinculado, assinatura,
 * pedidos e pagamentos COM origem.
 *
 * A leitura de pagamentos AQUI é PRÓPRIA, e não reaproveita
 * `pagamentosDaAssinatura` de `lib/billing/assinatura/estado-da-
 * assinatura.ts` (fase F4): aquela função não traz `origem`/`order_id`, e a
 * tabela dela já tem lugar fixo na mesma aba ("Pagamentos e estornos"), fora
 * do escopo desta tarefa. Nunca lança.
 */
export async function asaasDaOrganizacao(
  admin: SupabaseClient,
  organizationId: string,
  log?: Logger,
): Promise<ResultadoAsaasDaOrganizacao> {
  try {
    const [clienteRes, contratoRes, pedidosResultado, pagamentosRes] = await Promise.all([
      admin
        .from("billing_customers")
        .select("asaas_customer_id, ambiente")
        .eq("organization_id", organizationId)
        .maybeSingle(),
      admin
        .from("billing_contracts")
        .select("asaas_subscription_id, asaas_assinatura_encerrada_em")
        .eq("organization_id", organizationId)
        .maybeSingle(),
      pedidosAsaas(admin, { organizationId }, log),
      admin
        .from("billing_payments")
        .select(
          "id, status, gross_cents, origem, order_id, paid_at, billing_period_start, billing_period_end, created_at",
        )
        .eq("organization_id", organizationId)
        .order("created_at", { ascending: false }),
    ]);

    if (clienteRes.error) throw new Error(`ler billing_customers: ${clienteRes.error.message}`);
    if (contratoRes.error) throw new Error(`ler billing_contracts (asaas): ${contratoRes.error.message}`);
    if (pagamentosRes.error) {
      throw new Error(`ler billing_payments (com origem): ${pagamentosRes.error.message}`);
    }
    if (pedidosResultado.leituraFalhou) throw new Error("ler billing_orders da organização");

    const clienteLinha = clienteRes.data as unknown as LinhaDoClienteCru | null;
    const contratoLinha = contratoRes.data as unknown as LinhaDoContratoAsaasCru | null;
    const pagamentosLinhas = (pagamentosRes.data ?? []) as unknown as LinhaDoPagamentoAsaasCru[];

    return {
      cliente: clienteLinha
        ? { asaasCustomerId: clienteLinha.asaas_customer_id, ambiente: clienteLinha.ambiente }
        : null,
      assinatura: contratoLinha?.asaas_subscription_id
        ? {
            asaasSubscriptionId: contratoLinha.asaas_subscription_id,
            encerradaEm: contratoLinha.asaas_assinatura_encerrada_em,
          }
        : null,
      pedidos: pedidosResultado.pedidos,
      pagamentos: pagamentosLinhas.map((l) => ({
        id: l.id,
        status: l.status,
        grossCents: l.gross_cents,
        origem: l.origem,
        orderId: l.order_id,
        paidAt: l.paid_at,
        billingPeriodStart: l.billing_period_start,
        billingPeriodEnd: l.billing_period_end,
        createdAt: l.created_at,
      })),
      leituraFalhou: false,
    };
  } catch (err) {
    log?.error("alarme_asaas_leitura", {
      organization_id: organizationId,
      etapa: "asaas_da_organizacao",
      erro: mensagemDeErro(err),
    });
    return { cliente: null, assinatura: null, pedidos: [], pagamentos: [], leituraFalhou: true };
  }
}
