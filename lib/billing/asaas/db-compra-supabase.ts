import "server-only";

/**
 * A implementação REAL de `DbCompra` (`lib/billing/asaas/compra.ts`) contra
 * o Supabase de verdade: fase F5, Tarefa 15 (`hiperbold/planos/fase-F5-
 * tarefas.md`). `compra.ts` deixou isto explicitamente fora da Tarefa 14
 * (comentário do próprio arquivo): este módulo é só a PONTE, um método por
 * RPC/leitura, no mesmo molde de `conferidorDeCarteiraSobre`
 * (`lib/billing/tokens/conferir-carteira.ts`): nenhuma regra de negócio
 * mora aqui, só tradução de nomes (`snake_case` do Postgres para
 * `camelCase` do TypeScript) e o `join` com `billing_plans`/
 * `billing_token_pacotes` para a `description` sem dado pessoal (decisão 4
 * do plano da fase).
 *
 * As funções chamadas por RPC (`fn_billing_criar_pedido`, `fn_billing_
 * pedido_tomar`, `fn_billing_vincular_cliente_asaas`, `fn_billing_pedido_
 * registrar_cobranca`, `fn_billing_pedido_marcar` e `fn_billing_asaas_
 * marcar_assinatura_encerrada`, todas da migração 0909) ainda não estão em
 * `lib/database.types.ts` (tabelas/funções novas desta fase): os nomes de
 * RPC e os argumentos levam `as never`, o mesmo tratamento que
 * `conferidorDeCarteiraSobre` já dá às funções novas da fase F2-B.
 * `fn_billing_cancelar_no_fim_do_periodo` (0908) saiu da lista: a correção 5
 * da revisão/auditoria removeu a chamada redundante em `cancelarAssinatura
 * DoCliente` (`lib/billing/asaas/compra.ts`), já que `fn_billing_asaas_
 * marcar_assinatura_encerrada` liga `cancel_at_period_end` sozinha.
 *
 * `SupabaseClient` (de `createAdminClient()`, `lib/supabase/admin.ts`) BYPASSA
 * RLS: toda leitura aqui é filtrada por `organization_id`, sempre recebido
 * por parâmetro (nunca lido de outro lugar): quem resolve esse valor da
 * sessão é o CHAMADOR (`app/actions/settings/compraDoPlano.ts`, Tarefa 15),
 * nunca este arquivo.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { AmbienteAsaas } from "./config";
import type {
  CicloPedido,
  ContratoAsaas,
  DbCompra,
  MetodoPedido,
  PedidoCriado,
  PedidoLinha,
  PedidoTomado,
  RpcErro,
  StatusPedido,
  TipoPedido,
  VinculoClienteAsaas,
} from "./compra";

/** Mesma lista de `billing_orders_aberto_por_tipo_unique` (migração 0909, decisão 11/25). */
const ESTADOS_ABERTOS: StatusPedido[] = ["criado", "aguardando_pagamento", "inconclusivo", "processando"];

const COLUNAS_PEDIDO =
  "id, status, tipo, ambiente, metodo, amount_cents, external_reference, asaas_payment_id, asaas_subscription_id, invoice_url, ciclo, plan_id, pacote_id, updated_at, parcelas, asaas_installment_id";

interface LinhaBillingOrders {
  id: string;
  status: string;
  tipo: string;
  ambiente: string;
  metodo: string;
  amount_cents: number;
  external_reference: string;
  asaas_payment_id: string | null;
  asaas_subscription_id: string | null;
  invoice_url: string | null;
  ciclo: string | null;
  plan_id: string | null;
  pacote_id: string | null;
  parcelas: number;
  asaas_installment_id: string | null;
  /** Correção 10 (tarefa 17): `cancelarPedidoAberto` usa para o gate de 15 minutos em `processando`. */
  updated_at: string;
}

/**
 * Nomes do plano (`billing_plans.name`) e do pacote (`billing_token_pacotes.
 * nome`), e os respectivos CÓDIGOS (`billing_plans.code`/`billing_token_
 * pacotes.codigo`, correção 3/M9: comparar a oferta do pedido aberto
 * retomado com a que a entrada pediu agora), só quando o pedido carrega um
 * dos dois ids (checks de coerência da migração 0909 garantem que nunca os
 * dois ao mesmo tempo). Os nomes são usados por `montarDescricao` em
 * `compra.ts` para a `description` sem dado pessoal (decisão 4).
 */
async function nomesDoPedido(
  admin: SupabaseClient,
  planId: string | null,
  pacoteId: string | null,
): Promise<{ planoNome: string | null; pacoteNome: string | null; planCode: string | null; pacoteCode: string | null }> {
  let planoNome: string | null = null;
  let pacoteNome: string | null = null;
  let planCode: string | null = null;
  let pacoteCode: string | null = null;

  if (planId) {
    const { data } = await admin.from("billing_plans").select("name, code").eq("id", planId).maybeSingle();
    const row = data as { name: string; code: string } | null;
    planoNome = row?.name ?? null;
    planCode = row?.code ?? null;
  }
  if (pacoteId) {
    const { data } = await admin.from("billing_token_pacotes").select("nome, codigo").eq("id", pacoteId).maybeSingle();
    const row = data as { nome: string; codigo: string } | null;
    pacoteNome = row?.nome ?? null;
    pacoteCode = row?.codigo ?? null;
  }

  return { planoNome, pacoteNome, planCode, pacoteCode };
}

function paraPedidoLinha(
  row: LinhaBillingOrders,
  planoNome: string | null,
  pacoteNome: string | null,
  planCode: string | null,
  pacoteCode: string | null,
): PedidoLinha {
  return {
    id: row.id,
    status: row.status as StatusPedido,
    tipo: row.tipo as TipoPedido,
    ambiente: row.ambiente as AmbienteAsaas,
    metodo: row.metodo as MetodoPedido,
    amountCents: row.amount_cents,
    externalReference: row.external_reference,
    asaasPaymentId: row.asaas_payment_id,
    asaasSubscriptionId: row.asaas_subscription_id,
    invoiceUrl: row.invoice_url,
    parcelas: row.parcelas ?? 1,
    asaasInstallmentId: row.asaas_installment_id ?? null,
    ciclo: row.ciclo as CicloPedido | null,
    planoNome,
    pacoteNome,
    planCode,
    pacoteCode,
    atualizadoEm: row.updated_at,
  };
}

/**
 * Monta o `DbCompra` (`lib/billing/asaas/compra.ts`) sobre um `SupabaseClient`
 * de verdade (`createAdminClient()`). Cada método é um RPC ou uma leitura
 * pura; nenhum aqui decide regra de negócio, isso é `compra.ts`.
 */
export function dbCompraSupabase(admin: SupabaseClient): DbCompra {
  return {
    async criarPedido(args) {
      const { data, error } = await admin.rpc("fn_billing_criar_pedido" as never, {
        p_org: args.org,
        p_tipo: args.tipo,
        p_plan_code: args.planCode,
        p_ciclo: args.ciclo,
        p_pacote: args.pacote,
        p_metodo: args.metodo,
        p_ambiente: args.ambiente,
        p_chave: args.chave,
        p_actor: args.actor,
        p_termos_versao: args.termosVersao,
        p_parcelas: args.parcelas,
        p_total_cents: args.totalCents,
      } as never);
      if (error) return { data: null, error: error as RpcErro };
      const d = data as {
        pedido_id: string;
        external_reference: string;
        amount_cents: number;
        parcelas?: number;
        ja_existia: boolean;
        proxima_cobranca_em: string | null;
      } | null;
      if (!d) return { data: null, error: null };
      const criado: PedidoCriado = {
        pedidoId: d.pedido_id,
        externalReference: d.external_reference,
        amountCents: d.amount_cents,
        parcelas: d.parcelas ?? 1,
        jaExistia: d.ja_existia,
        proximaCobrancaEm: d.proxima_cobranca_em,
      };
      return { data: criado, error: null };
    },

    async lerParcelamentoDoPlano(planCode, ciclo) {
      const [plano, config] = await Promise.all([
        admin
          .from("billing_plans")
          .select("price_semiannual_cents, price_yearly_cents")
          .eq("code", planCode)
          .eq("active", true)
          .limit(1)
          .maybeSingle(),
        admin
          .from("billing_settings")
          .select("parcelamento_taxa_mensal, parcelamento_sem_juros_ate, parcelamento_max_semestral, parcelamento_max_anual")
          .eq("id", 1)
          .maybeSingle(),
      ]);
      if (plano.error) return { data: null, error: plano.error as RpcErro };
      if (config.error) return { data: null, error: config.error as RpcErro };
      const p = plano.data as { price_semiannual_cents: number | null; price_yearly_cents: number | null } | null;
      const c = config.data as {
        parcelamento_taxa_mensal: number | string | null;
        parcelamento_sem_juros_ate: number | null;
        parcelamento_max_semestral: number | null;
        parcelamento_max_anual: number | null;
      } | null;
      const preco = ciclo === "semiannual" ? p?.price_semiannual_cents : ciclo === "yearly" ? p?.price_yearly_cents : null;
      return {
        data: {
          precoCents: preco ?? null,
          parametros: {
            taxaMensal: c?.parcelamento_taxa_mensal == null ? null : Number(c.parcelamento_taxa_mensal),
            semJurosAte: c?.parcelamento_sem_juros_ate ?? null,
            maxSemestral: c?.parcelamento_max_semestral ?? null,
            maxAnual: c?.parcelamento_max_anual ?? null,
          },
        },
        error: null,
      };
    },

    async registrarParcelamento(org, pedidoId, asaasInstallmentId) {
      const { data, error } = await admin.rpc("fn_billing_pedido_registrar_parcelamento" as never, {
        p_org: org,
        p_pedido: pedidoId,
        p_asaas_installment_id: asaasInstallmentId,
      } as never);
      if (error) return { data: null, error: error as RpcErro };
      const d = data as { ja_registrado: boolean } | null;
      return { data: { jaRegistrado: d?.ja_registrado ?? false }, error: null };
    },

    async buscarPedidoAbertoPorTipo(org, tipo) {
      const { data, error } = await admin
        .from("billing_orders")
        .select(COLUNAS_PEDIDO)
        .eq("organization_id", org)
        .eq("tipo", tipo)
        .in("status", ESTADOS_ABERTOS)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) return { data: null, error: error as RpcErro };
      const row = data as LinhaBillingOrders | null;
      if (!row) return { data: null, error: null };
      const { planoNome, pacoteNome, planCode, pacoteCode } = await nomesDoPedido(admin, row.plan_id, row.pacote_id);
      return { data: paraPedidoLinha(row, planoNome, pacoteNome, planCode, pacoteCode), error: null };
    },

    async tomarPedido(org, pedidoId) {
      const { data, error } = await admin.rpc("fn_billing_pedido_tomar" as never, {
        p_org: org,
        p_pedido: pedidoId,
      } as never);
      if (error) return { data: null, error: error as RpcErro };
      const d = data as { tomado: boolean; pedido_id: string; status: string } | null;
      if (!d) return { data: null, error: null };
      const tomado: PedidoTomado = { tomado: d.tomado, pedidoId: d.pedido_id, status: d.status as StatusPedido };
      return { data: tomado, error: null };
    },

    async lerPedido(org, pedidoId) {
      const { data, error } = await admin
        .from("billing_orders")
        .select(COLUNAS_PEDIDO)
        .eq("organization_id", org)
        .eq("id", pedidoId)
        .maybeSingle();
      if (error) return { data: null, error: error as RpcErro };
      const row = data as LinhaBillingOrders | null;
      if (!row) return { data: null, error: null };
      const { planoNome, pacoteNome, planCode, pacoteCode } = await nomesDoPedido(admin, row.plan_id, row.pacote_id);
      return { data: paraPedidoLinha(row, planoNome, pacoteNome, planCode, pacoteCode), error: null };
    },

    async buscarVinculoClienteAsaas(org, ambiente) {
      const { data, error } = await admin
        .from("billing_customers")
        .select("asaas_customer_id")
        .eq("organization_id", org)
        .eq("ambiente", ambiente)
        .maybeSingle();
      if (error) return { data: null, error: error as RpcErro };
      const row = data as { asaas_customer_id: string } | null;
      if (!row) return { data: null, error: null };
      const vinculo: VinculoClienteAsaas = { asaasCustomerId: row.asaas_customer_id };
      return { data: vinculo, error: null };
    },

    async vincularClienteAsaas(org, ambiente, asaasCustomerId) {
      const { data, error } = await admin.rpc("fn_billing_vincular_cliente_asaas" as never, {
        p_org: org,
        p_ambiente: ambiente,
        p_asaas_customer_id: asaasCustomerId,
      } as never);
      if (error) return { data: null, error: error as RpcErro };
      const d = data as { ja_existia: boolean; asaas_customer_id: string } | null;
      if (!d) return { data: null, error: null };
      return { data: { jaExistia: d.ja_existia, asaasCustomerId: d.asaas_customer_id }, error: null };
    },

    async registrarCobranca(args) {
      const { data, error } = await admin.rpc("fn_billing_pedido_registrar_cobranca" as never, {
        p_org: args.org,
        p_pedido: args.pedidoId,
        p_asaas_payment_id: args.asaasPaymentId,
        p_asaas_subscription_id: args.asaasSubscriptionId,
        p_invoice_url: args.invoiceUrl,
      } as never);
      if (error) return { data: null, error: error as RpcErro };
      const d = data as { ja_registrado: boolean; pedido_id: string; status: string } | null;
      if (!d) return { data: null, error: null };
      return {
        data: { jaRegistrado: d.ja_registrado, pedidoId: d.pedido_id, status: d.status as StatusPedido },
        error: null,
      };
    },

    async marcarPedido(org, pedidoId, status, motivo) {
      const { data, error } = await admin.rpc("fn_billing_pedido_marcar" as never, {
        p_org: org,
        p_pedido: pedidoId,
        p_status: status,
        p_motivo: motivo,
      } as never);
      if (error) return { data: null, error: error as RpcErro };
      const d = data as { pedido_id: string; status_anterior: string; status_novo: string } | null;
      if (!d) return { data: null, error: null };
      return {
        data: {
          pedidoId: d.pedido_id,
          statusAnterior: d.status_anterior as StatusPedido,
          statusNovo: d.status_novo as StatusPedido,
        },
        error: null,
      };
    },

    async lerContrato(org) {
      const { data, error } = await admin
        .from("billing_contracts")
        .select("asaas_subscription_id, asaas_assinatura_encerrada_em, current_period_end")
        .eq("organization_id", org)
        .maybeSingle();
      if (error) return { data: null, error: error as RpcErro };
      const row = data as {
        asaas_subscription_id: string | null;
        asaas_assinatura_encerrada_em: string | null;
        current_period_end: string | null;
      } | null;
      if (!row) return { data: null, error: null };
      const contrato: ContratoAsaas = {
        asaasSubscriptionId: row.asaas_subscription_id,
        asaasAssinaturaEncerradaEm: row.asaas_assinatura_encerrada_em,
        currentPeriodEnd: row.current_period_end,
      };
      return { data: contrato, error: null };
    },

    async marcarAssinaturaEncerrada(org, asaasSubscriptionId, actor) {
      const { data, error } = await admin.rpc("fn_billing_asaas_marcar_assinatura_encerrada" as never, {
        p_org: org,
        p_asaas_subscription_id: asaasSubscriptionId,
        p_actor: actor,
      } as never);
      if (error) return { data: null, error: error as RpcErro };
      const d = data as { ja_registrado: boolean; asaas_assinatura_encerrada_em: string } | null;
      if (!d) return { data: null, error: null };
      return {
        data: { jaRegistrado: d.ja_registrado, asaasAssinaturaEncerradaEm: d.asaas_assinatura_encerrada_em },
        error: null,
      };
    },
  };
}
