"use server";

/**
 * As cinco ações do admin da PLATAFORMA sobre a cobrança do Asaas: fase F5,
 * Tarefa 17 (`hiperbold/planos/fase-F5-tarefas.md`). Segue o molde de
 * `assinaturaDaOrganizacao.ts` (fase F4, tarefa 5): mesmo gate (escopo `full`
 * + MFA em dia pela `requirePlatformAdmin`/`mfaEmDivida`), mesma régua de erro
 * (errcode do Postgres vira frase fixa; o texto cru nunca sai daqui), mesma
 * auditoria (com IP pela régua do projeto) e mesmo `revalidatePath`.
 *
 * `definirCompraPeloCliente` e `definirPlanoAVenda` mexem nas duas metades da
 * chave de compra (decisão 18): `billing_settings.compra_pelo_cliente` e
 * `billing_plans.for_sale`. `reprocessarEventoAsaas` reabre um evento em erro
 * para a próxima rodada do cron pegar de novo (decisão 20). `cancelarPedidoAberto`
 * e `cancelarAssinaturaNoAsaas` são as duas escritas que TOCAM o Asaas de
 * verdade antes de escrever no banco.
 *
 * ─── `cancelarPedidoAberto`: remove no Asaas ANTES de marcar (decisão 10) ───
 *
 * Um pedido pode já ter uma assinatura (`asaas_subscription_id`) ou uma
 * cobrança avulsa (`asaas_payment_id`) registrada no Asaas. Cancelar esse
 * pedido só no CRM, sem remover do lado do Asaas, deixaria uma cobrança
 * fantasma cobrando o cliente sozinha (risco 6/11 do plano da fase: "cobrança
 * dobrada"/"cobrança fantasma"). Por isso esta ação: (1) lê o pedido; (2) se
 * ele tem assinatura OU cobrança no Asaas, remove lá primeiro pelo cliente
 * HTTP (`lib/billing/asaas/cliente.ts`), o que EXIGE `ASAAS_ENABLED` (sem
 * chave ligada, não há como remover com segurança, e a ação recusa antes de
 * tentar); (3) só DEPOIS da remoção (ou quando não havia nada a remover) é
 * que `fn_billing_pedido_marcar` grava `cancelado`. Uma falha na remoção
 * NUNCA chega a marcar o pedido: ele continua como estava, para o admin
 * tentar de novo (ou a conciliação diária alcançar depois).
 *
 * ─── `cancelarAssinaturaNoAsaas`: reusa `cancelarAssinaturaDoCliente` ──────
 *
 * Mesma função de `lib/billing/asaas/compra.ts` que a Tarefa 15
 * (`app/actions/settings/compraDoPlano.ts`) usa para o cliente cancelar a
 * própria assinatura; aqui o ATOR é o admin da plataforma, cancelando a
 * assinatura de QUALQUER organização (suporte). A ordem (DELETE no Asaas,
 * `fn_billing_cancelar_no_fim_do_periodo`, `fn_billing_asaas_marcar_
 * assinatura_encerrada`) e as frases fixas já vêm prontas de `compra.ts`;
 * esta ação só faz o gate do admin e a auditoria.
 *
 * ─── Nenhuma chamada real ao Asaas em teste (restrição fixa 1 da fase) ─────
 *
 * `criarClienteAsaas` só é chamado com a config resolvida por `configDoAsaas()`;
 * os testes (`tests/unit/asaas-acoes-do-admin.test.ts`) trocam os dois módulos
 * inteiros por dublês (`vi.mock`), o mesmo padrão que troca `createAdminClient`
 * por um `{ rpc: vi.fn() }` nos testes de `assinaturaDaOrganizacao.ts`: nenhum
 * `fetch` de verdade sai de um teste desta ação.
 *
 * ─── Auditoria sem dado pessoal ─────────────────────────────────────────────
 *
 * Nenhuma das cinco ações grava CPF/CNPJ, e-mail, celular, chave de API,
 * token de webhook ou o payload do evento no `metadata` da auditoria: só
 * códigos, ids e o que a própria função do banco devolveu (mesma régua de
 * `compraDoPlano.ts`, decisão 16 da fase).
 */
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { mfaEmDivida } from "@/lib/auth/server";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { criarClienteAsaas } from "@/lib/billing/asaas/cliente";
import { cancelarAssinaturaDoCliente } from "@/lib/billing/asaas/compra";
import { configDoAsaas, type ConfigAsaas } from "@/lib/billing/asaas/config";
import { dbCompraSupabase } from "@/lib/billing/asaas/db-compra-supabase";
import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

// ─── Mensagens fixas (nunca o erro cru do Postgres nem do Asaas) ───────────

const MENSAGEM_MFA = "Confirme a verificação em duas etapas.";
const MENSAGEM_DADOS_INVALIDOS = "Dados inválidos.";
const MENSAGEM_GENERICA = "Não foi possível salvar. Tente de novo.";
const MENSAGEM_ERRO_CONFIGURACAO_ASAAS =
  "Não foi possível concluir a operação agora. Tente novamente em instantes ou fale com o suporte.";
const MENSAGEM_PEDIDO_NAO_ENCONTRADO = "Pedido não encontrado.";
const MENSAGEM_ASAAS_DESLIGADO_PARA_REMOVER =
  "Este pedido tem cobrança ou assinatura registrada no Asaas, e a integração está desligada nesta instalação. Ligue o Asaas ou cancele direto no painel do Asaas antes de marcar este pedido como cancelado.";
const MENSAGEM_FALHA_AO_REMOVER_NO_ASAAS =
  "Não foi possível remover a cobrança ou a assinatura no Asaas agora. Tente novamente em instantes.";
const MENSAGEM_ASAAS_DESLIGADO_PARA_CANCELAR =
  "O Asaas está desligado nesta instalação; não é possível cancelar a assinatura por aqui.";

const CAMINHO_TELA_COBRANCA = "/admin/sistema/cobranca";

function caminhoDaAbaDePlano(organizationId: string): string {
  return `/admin/tenants/${organizationId}/plano`;
}

// ─── Entrada (zod) ──────────────────────────────────────────────────────────

const UUID = z.string().uuid();
const NOTA = z.string().trim().max(500);
/** Mesmo formato de `billing_plans.code` (migração 0904). */
const CODIGO_DO_PLANO = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]{1,30}$/, "código inválido");

const entradaDefinirCompraPeloCliente = z.object({
  sim: z.boolean(),
});

const entradaDefinirPlanoAVenda = z.object({
  planCode: CODIGO_DO_PLANO,
  sim: z.boolean(),
});

const entradaReprocessarEventoAsaas = z.object({
  eventoId: UUID,
});

const entradaCancelarPedidoAberto = z.object({
  organizationId: UUID,
  pedidoId: UUID,
  motivo: NOTA.min(1, "obrigatório"),
});

const entradaCancelarAssinaturaNoAsaas = z.object({
  organizationId: UUID,
});

export type ResultadoDaAcaoDeCobrancaAsaas =
  | { ok: true; dados: Record<string, unknown> }
  | { ok: false; error: string };

async function contextoDaRequisicao() {
  const hdrs = await headers();
  return {
    requestId: hdrs.get("x-request-id"),
    ip: ipDoCliente(hdrs),
    userAgent: hdrs.get("user-agent"),
  };
}

/**
 * `configDoAsaas()` lança `ErroConfiguracaoAsaas` quando `ASAAS_ENABLED=true`
 * mas a base/chave estão incoerentes (`lib/billing/asaas/config.ts`): isto é
 * erro de CONFIGURAÇÃO do servidor, nunca algo que o admin causou, então vira
 * log + mensagem genérica (mesmo padrão de `compraDoPlano.ts`).
 */
function configAsaasOuNulo(): ConfigAsaas | null {
  try {
    return configDoAsaas();
  } catch (err) {
    logger.error("[cobrancaAsaas] configuração do Asaas inválida", {
      erro: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function montarDepsCompra(config: ConfigAsaas, admin: ReturnType<typeof createAdminClient>) {
  return {
    db: dbCompraSupabase(admin),
    asaas: criarClienteAsaas({ fetch: globalThis.fetch.bind(globalThis), config, logger }),
    config,
    logger,
  };
}

/**
 * Traduz os errcodes das quatro funções SQL chamadas por este arquivo
 * (`fn_billing_definir_compra_pelo_cliente`, `fn_billing_definir_a_venda`,
 * `fn_billing_asaas_reprocessar_evento`, `fn_billing_pedido_marcar`, todas da
 * migração 0909) para a frase que a tela mostra. `billing_cancele_no_asaas_
 * antes` (de `fn_billing_mudar_estado`, migração 0909/M4) não é levantada por
 * nenhuma das quatro, mas entra aqui por completude do vocabulário desta fase
 * (decisão 22), caso uma chamada futura desta tela passe a usá-la. Qualquer
 * código fora do vocabulário conhecido é falha inesperada do banco: o texto
 * cru vai só para o log, nunca para a resposta.
 */
function mensagemDoErroCobrancaAsaas(error: { code?: string; message?: string } | null): string {
  const msg = error?.message ?? "";
  if (error?.code === "22023") {
    if (msg.includes("billing_sim_obrigatorio")) return "Informe se liga ou desliga.";
    if (msg.includes("billing_preco_nao_definido")) {
      return "O preço mensal deste plano ainda não foi definido. Defina o preço antes de pôr à venda.";
    }
    if (msg.includes("billing_evento_nao_esta_em_erro")) {
      return "Este evento não está em erro; só eventos em erro podem ser reprocessados.";
    }
    if (msg.includes("billing_motivo_obrigatorio")) return "O motivo é obrigatório.";
    if (msg.includes("billing_pedido_ja_pago")) return "Este pedido já foi pago.";
    if (msg.includes("billing_status_invalido_para_marcar")) return "Status inválido.";
    if (msg.includes("billing_cancele_no_asaas_antes")) {
      return "Cancele a assinatura no Asaas antes de mudar o estado do contrato.";
    }
  }
  if (error?.code === "P0002") {
    if (msg.includes("plano_nao_encontrado_ou_inativo")) return "Plano não encontrado ou inativo.";
    if (msg.includes("billing_evento_nao_encontrado")) return "Evento não encontrado.";
    if (msg.includes("billing_pedido_nao_encontrado")) return MENSAGEM_PEDIDO_NAO_ENCONTRADO;
  }
  logger.error("[cobrancaAsaas] erro na escrita da cobrança Asaas", {
    code: error?.code ?? null,
    message: error?.message ?? null,
  });
  return MENSAGEM_GENERICA;
}

// ─── definirCompraPeloCliente ───────────────────────────────────────────────

export async function definirCompraPeloCliente(input: { sim: boolean }): Promise<ResultadoDaAcaoDeCobrancaAsaas> {
  const { user, platformAdmin } = await requirePlatformAdmin();

  if (platformAdmin.scope !== "full") {
    return { ok: false, error: "Seu acesso de suporte não permite ligar ou desligar a compra pelo cliente." };
  }
  if (await mfaEmDivida()) {
    return { ok: false, error: MENSAGEM_MFA };
  }

  const parsed = entradaDefinirCompraPeloCliente.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: MENSAGEM_DADOS_INVALIDOS };
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("fn_billing_definir_compra_pelo_cliente" as never, {
    p_sim: parsed.data.sim,
    p_actor: user.id,
  } as never);

  if (error) {
    return { ok: false, error: mensagemDoErroCobrancaAsaas(error as { code?: string; message?: string }) };
  }

  const resultado = data as { compra_pelo_cliente_anterior: boolean | null; compra_pelo_cliente_novo: boolean };

  const { requestId, ip, userAgent } = await contextoDaRequisicao();
  await audit({
    action: "billing.asaas_self_service_toggled",
    actorUserId: user.id,
    actingAsPlatformAdmin: true,
    resourceType: "installation",
    resourceId: "billing_settings",
    metadata: {
      compra_pelo_cliente_anterior: resultado.compra_pelo_cliente_anterior,
      compra_pelo_cliente_novo: resultado.compra_pelo_cliente_novo,
    },
    requestId,
    ip,
    userAgent,
  });

  revalidatePath(CAMINHO_TELA_COBRANCA);
  return { ok: true, dados: resultado };
}

// ─── definirPlanoAVenda ─────────────────────────────────────────────────────

export async function definirPlanoAVenda(input: {
  planCode: string;
  sim: boolean;
}): Promise<ResultadoDaAcaoDeCobrancaAsaas> {
  const { user, platformAdmin } = await requirePlatformAdmin();

  if (platformAdmin.scope !== "full") {
    return { ok: false, error: "Seu acesso de suporte não permite pôr ou tirar um plano de venda." };
  }
  if (await mfaEmDivida()) {
    return { ok: false, error: MENSAGEM_MFA };
  }

  const parsed = entradaDefinirPlanoAVenda.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: MENSAGEM_DADOS_INVALIDOS };
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("fn_billing_definir_a_venda" as never, {
    p_plan_code: parsed.data.planCode,
    p_sim: parsed.data.sim,
    p_actor: user.id,
  } as never);

  if (error) {
    return { ok: false, error: mensagemDoErroCobrancaAsaas(error as { code?: string; message?: string }) };
  }

  const resultado = data as { plan_code: string; for_sale_anterior: boolean; for_sale_novo: boolean };

  const { requestId, ip, userAgent } = await contextoDaRequisicao();
  await audit({
    action: "billing.asaas_plan_for_sale_toggled",
    actorUserId: user.id,
    actingAsPlatformAdmin: true,
    resourceType: "billing_plan",
    resourceId: resultado.plan_code,
    metadata: {
      plan_code: resultado.plan_code,
      for_sale_anterior: resultado.for_sale_anterior,
      for_sale_novo: resultado.for_sale_novo,
    },
    requestId,
    ip,
    userAgent,
  });

  revalidatePath(CAMINHO_TELA_COBRANCA);
  return { ok: true, dados: resultado };
}

// ─── reprocessarEventoAsaas ─────────────────────────────────────────────────

export async function reprocessarEventoAsaas(input: { eventoId: string }): Promise<ResultadoDaAcaoDeCobrancaAsaas> {
  const { user, platformAdmin } = await requirePlatformAdmin();

  if (platformAdmin.scope !== "full") {
    return { ok: false, error: "Seu acesso de suporte não permite reprocessar eventos do Asaas." };
  }
  if (await mfaEmDivida()) {
    return { ok: false, error: MENSAGEM_MFA };
  }

  const parsed = entradaReprocessarEventoAsaas.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: MENSAGEM_DADOS_INVALIDOS };
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("fn_billing_asaas_reprocessar_evento" as never, {
    p_evento: parsed.data.eventoId,
    p_actor: user.id,
  } as never);

  if (error) {
    return { ok: false, error: mensagemDoErroCobrancaAsaas(error as { code?: string; message?: string }) };
  }

  const resultado = data as { evento_id: string; resultado_anterior: string; resultado_novo: string };

  const { requestId, ip, userAgent } = await contextoDaRequisicao();
  await audit({
    action: "billing.asaas_event_reprocessed",
    actorUserId: user.id,
    actingAsPlatformAdmin: true,
    resourceType: "asaas_webhook_event",
    resourceId: resultado.evento_id,
    metadata: {
      resultado_anterior: resultado.resultado_anterior,
      resultado_novo: resultado.resultado_novo,
    },
    requestId,
    ip,
    userAgent,
  });

  revalidatePath(CAMINHO_TELA_COBRANCA);
  return { ok: true, dados: resultado };
}

// ─── cancelarPedidoAberto ───────────────────────────────────────────────────

export async function cancelarPedidoAberto(input: {
  organizationId: string;
  pedidoId: string;
  motivo: string;
}): Promise<ResultadoDaAcaoDeCobrancaAsaas> {
  const { user, platformAdmin } = await requirePlatformAdmin();

  if (platformAdmin.scope !== "full") {
    return { ok: false, error: "Seu acesso de suporte não permite cancelar pedidos do Asaas." };
  }
  if (await mfaEmDivida()) {
    return { ok: false, error: MENSAGEM_MFA };
  }

  const parsed = entradaCancelarPedidoAberto.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: MENSAGEM_DADOS_INVALIDOS };
  }

  const admin = createAdminClient();
  const { organizationId, pedidoId, motivo } = parsed.data;

  const leitura = await dbCompraSupabase(admin).lerPedido(organizationId, pedidoId);
  if (leitura.error) {
    logger.error("[cobrancaAsaas] ler pedido para cancelar falhou", { pedidoId, codigo: leitura.error.code });
    return { ok: false, error: MENSAGEM_GENERICA };
  }
  const pedido = leitura.data;
  if (!pedido) {
    return { ok: false, error: MENSAGEM_PEDIDO_NAO_ENCONTRADO };
  }
  if (pedido.status === "pago") {
    return { ok: false, error: "Este pedido já foi pago." };
  }

  // Decisão 10/risco 6/11: um pedido com assinatura ou cobrança no Asaas
  // nunca é cancelado só no CRM, sem remover do lado do Asaas antes (deixaria
  // uma cobrança fantasma cobrando o cliente sozinha).
  if (pedido.asaasSubscriptionId || pedido.asaasPaymentId) {
    const config = configAsaasOuNulo();
    if (!config) {
      return { ok: false, error: MENSAGEM_ERRO_CONFIGURACAO_ASAAS };
    }
    if (!config.habilitado) {
      return { ok: false, error: MENSAGEM_ASAAS_DESLIGADO_PARA_REMOVER };
    }
    const cliente = criarClienteAsaas({ fetch: globalThis.fetch.bind(globalThis), config, logger });
    try {
      if (pedido.asaasSubscriptionId) {
        await cliente.removerAssinatura(pedido.asaasSubscriptionId);
      } else if (pedido.asaasPaymentId) {
        await cliente.removerCobranca(pedido.asaasPaymentId);
      }
    } catch (err) {
      logger.error("[cobrancaAsaas] remover cobranca/assinatura antes de cancelar pedido falhou", {
        pedidoId,
        erro: err instanceof Error ? err.message : String(err),
      });
      // NUNCA marca o pedido quando a remoção no Asaas falhou: ele continua
      // como estava, para o admin tentar de novo (ou a conciliação diária,
      // Tarefa 16, alcançar depois).
      return { ok: false, error: MENSAGEM_FALHA_AO_REMOVER_NO_ASAAS };
    }
  }

  const { data, error } = await admin.rpc("fn_billing_pedido_marcar" as never, {
    p_org: organizationId,
    p_pedido: pedidoId,
    p_status: "cancelado",
    p_motivo: motivo,
  } as never);

  if (error) {
    return { ok: false, error: mensagemDoErroCobrancaAsaas(error as { code?: string; message?: string }) };
  }

  const resultado = data as { pedido_id: string; status_anterior: string; status_novo: string };

  const { requestId, ip, userAgent } = await contextoDaRequisicao();
  await audit({
    action: "billing.asaas_order_canceled",
    actorUserId: user.id,
    actingAsPlatformAdmin: true,
    organizationId,
    resourceType: "billing_order",
    resourceId: pedidoId,
    metadata: {
      motivo,
      tinha_cobranca_ou_assinatura_no_asaas: Boolean(pedido.asaasSubscriptionId || pedido.asaasPaymentId),
      status_anterior: resultado.status_anterior,
      status_novo: resultado.status_novo,
    },
    requestId,
    ip,
    userAgent,
  });

  revalidatePath(caminhoDaAbaDePlano(organizationId));
  revalidatePath(CAMINHO_TELA_COBRANCA);
  return { ok: true, dados: resultado };
}

// ─── cancelarAssinaturaNoAsaas ──────────────────────────────────────────────

/**
 * Reusa `cancelarAssinaturaDoCliente` (`lib/billing/asaas/compra.ts`) com o
 * admin da plataforma como ator: mesma ordem (DELETE no Asaas, depois
 * `fn_billing_cancelar_no_fim_do_periodo`, depois `fn_billing_asaas_marcar_
 * assinatura_encerrada`) e as mesmas frases fixas de erro que
 * `compraDoPlano.ts` já usa para o cliente cancelar a própria assinatura.
 */
export async function cancelarAssinaturaNoAsaas(input: {
  organizationId: string;
}): Promise<ResultadoDaAcaoDeCobrancaAsaas> {
  const { user, platformAdmin } = await requirePlatformAdmin();

  if (platformAdmin.scope !== "full") {
    return { ok: false, error: "Seu acesso de suporte não permite cancelar a assinatura no Asaas." };
  }
  if (await mfaEmDivida()) {
    return { ok: false, error: MENSAGEM_MFA };
  }

  const parsed = entradaCancelarAssinaturaNoAsaas.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: MENSAGEM_DADOS_INVALIDOS };
  }

  const config = configAsaasOuNulo();
  if (!config) {
    return { ok: false, error: MENSAGEM_ERRO_CONFIGURACAO_ASAAS };
  }
  if (!config.habilitado) {
    return { ok: false, error: MENSAGEM_ASAAS_DESLIGADO_PARA_CANCELAR };
  }

  const admin = createAdminClient();
  const resultado = await cancelarAssinaturaDoCliente(
    montarDepsCompra(config, admin),
    parsed.data.organizationId,
    user.id,
  );

  if (resultado.tipo === "erro") {
    return { ok: false, error: resultado.mensagem };
  }

  const { requestId, ip, userAgent } = await contextoDaRequisicao();
  await audit({
    action: "billing.asaas_subscription_canceled",
    actorUserId: user.id,
    actingAsPlatformAdmin: true,
    organizationId: parsed.data.organizationId,
    resourceType: "organization",
    resourceId: parsed.data.organizationId,
    metadata: { cancel_at_period_end: resultado.cancelAtPeriodEnd },
    requestId,
    ip,
    userAgent,
  });

  revalidatePath(caminhoDaAbaDePlano(parsed.data.organizationId));
  revalidatePath(CAMINHO_TELA_COBRANCA);
  return { ok: true, dados: { cancelAtPeriodEnd: resultado.cancelAtPeriodEnd } };
}
