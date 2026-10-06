"use server";

/**
 * A compra pelo PRÓPRIO CLIENTE, atrás da chave: fase F5, Tarefa 15
 * (`hiperbold/planos/fase-F5-tarefas.md`). Três ações da tela `/app/settings/
 * plano` (Tarefa 20, fora desta tarefa): assinar um plano (cartão ou Pix
 * semestral e anual), comprar um pacote de tokens, e cancelar a assinatura Asaas ativa.
 *
 * ─── Organização SEMPRE da sessão, nunca da entrada (decisão 17) ──────────
 *
 * Nenhum dos três `input` abaixo tem `organizationId`: `resolveActiveOrg`
 * (`lib/auth/server.ts`) é a ÚNICA fonte, o mesmo molde de
 * `apagarDadosOperacionaisDaOrganizacao.ts`. `createAdminClient()` BYPASSA
 * RLS; é o `organizationId` da sessão, passado para `iniciarCompra`/
 * `cancelarAssinaturaDoCliente`, que mantém cada leitura e escrita dentro da
 * organização de quem chamou.
 *
 * ─── Só o papel `admin` da organização compra e cancela (N41) ─────────────
 *
 * `ROLE_RANK[activeOrg.role] < ROLE_RANK.admin` recusa antes de qualquer
 * outra checagem (mesma ordem de `apagarDadosOperacionaisDaOrganizacao.ts`:
 * sessão, depois papel, só depois o resto). `supportWriteError` barra sessão
 * de suporte em modo só-leitura ou encerrada. Correção 7: o admin da
 * PLATAFORMA (`authUser.is_platform_admin`) pode bypassar o papel do tenant,
 * mas só depois de provar escopo `full` em `platform_admins` e MFA em dia
 * (`mfaEmDivida`), a mesma régua de `cobrancaAsaas.ts`
 * (`requirePlatformAdmin` + `mfaEmDivida`); sem isso, comprar ou cancelar em
 * QUALQUER organização ficaria ao alcance de um escopo de suporte só
 * leitura, ou de uma sessão sem MFA provado.
 *
 * ─── As duas chaves da decisão 18 ──────────────────────────────────────────
 *
 * Comprar (`iniciarAssinatura`/`comprarPacote`) exige `ASAAS_ENABLED=true`
 * (`configDoAsaas().habilitado`) E `billing_settings.compra_pelo_cliente`
 * (`compraLigada`) ao mesmo tempo. Cancelar (`cancelarAssinatura`) exige só
 * `ASAAS_ENABLED`: desligar a VENDA não pode prender ninguém numa assinatura
 * já contratada (decisão 18, plano da fase). `fn_billing_criar_pedido`
 * confere a chave do banco de novo (defesa em profundidade); esta ação
 * confere ANTES para nunca montar um cliente Asaas nem gastar uma leitura à
 * toa quando a resposta já é conhecida.
 *
 * ─── Frase fixa, nunca erro cru (risco 13) ─────────────────────────────────
 *
 * `iniciarCompra`/`cancelarAssinaturaDoCliente` (`lib/billing/asaas/
 * compra.ts`) já devolvem só mensagens fixas (nunca o texto do Postgres nem
 * do Asaas); esta ação REPASSA esse resultado sem alterar a mensagem. As
 * únicas mensagens que este arquivo cria são as do próprio gate (sessão,
 * papel, zod, as duas chaves): todas constantes, nunca construídas com o
 * erro.
 *
 * ─── Auditoria sem dado sensível ───────────────────────────────────────────
 *
 * `billing.order_created`/`billing.subscription_cancel_requested`
 * (acrescentadas ao FIM de `lib/audit/actions.ts`, nunca reordenado) só
 * disparam quando o resultado NÃO é `"erro"` (uma tentativa recusada não
 * deixa rastro de "pedido criado"). O `metadata` nunca carrega
 * `pagador` (nome/CPF/CNPJ/e-mail/celular, decisão 16 da fase) nem
 * `amountCents`: só o código do plano/pacote, o ciclo, o método e o tipo do
 * resultado (`redirecionar`/`pix`), a mesma régua de "nunca a nota livre" que
 * `assinaturaDaOrganizacao.ts` já segue para dado do cliente.
 */
import { headers } from "next/headers";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { criarClienteAsaas } from "@/lib/billing/asaas/cliente";
import { compraLigada, configDoAsaas, type ConfigAsaas } from "@/lib/billing/asaas/config";
import {
  cancelarAssinaturaDoCliente,
  iniciarCompra,
  type EntradaIniciarCompra,
  type ResultadoCancelarAssinatura,
  type ResultadoIniciarCompra,
} from "@/lib/billing/asaas/compra";
import { dbCompraSupabase } from "@/lib/billing/asaas/db-compra-supabase";
import { supportWriteError } from "@/lib/impersonate/support";
import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import { VERSAO_DOS_TERMOS } from "@/lib/legal/versao-dos-termos";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

// ─── Mensagens fixas do GATE (nunca do banco/Asaas) ────────────────────────

const MENSAGEM_SEM_PERMISSAO_COMPRAR = "Você não tem permissão para comprar planos desta organização.";
const MENSAGEM_SEM_PERMISSAO_CANCELAR = "Você não tem permissão para cancelar a assinatura desta organização.";
const MENSAGEM_SEM_ORGANIZACAO = "Nenhuma organização ativa nesta sessão.";
const MENSAGEM_DADOS_INVALIDOS = "Dados inválidos. Confira o formulário e tente de novo.";
const MENSAGEM_COMPRA_DESLIGADA = "A compra pela tela ainda não está disponível. Fale com o suporte.";
const MENSAGEM_CANCELAMENTO_DESLIGADO =
  "O cancelamento pela tela não está disponível no momento. Fale com o suporte.";
const MENSAGEM_ERRO_CONFIGURACAO =
  "Não foi possível concluir a operação agora. Tente novamente em instantes ou fale com o suporte.";
const MENSAGEM_MFA = "Confirme a verificação em duas etapas.";
const MENSAGEM_TERMOS_NAO_ACEITOS = "Aceite os Termos de Uso para continuar.";
const MENSAGEM_TERMOS_ATUALIZADOS =
  "Os Termos de Uso foram atualizados. Recarregue a página e aceite de novo para continuar.";

// ─── Entrada (zod): nunca organizationId, nunca preço/plano resolvido ─────

/** Mesmo formato de `billing_plans.code`/`billing_token_pacotes.codigo` (migrações 0904/0908). */
const CODIGO = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]{1,30}$/, "código inválido");

const CHAVE = z.string().uuid("chave inválida");

const PAGADOR = z.object({
  nome: z.string().trim().min(1).max(200),
  documento: z.string().trim().min(11).max(20),
  email: z.string().trim().email().max(200).optional(),
  celular: z.string().trim().min(8).max(20).optional(),
});

const entradaIniciarAssinatura = z.object({
  planCode: CODIGO,
  ciclo: z.enum(["monthly", "semiannual", "yearly"]),
  metodo: z.enum(["CREDIT_CARD", "PIX"]),
  chave: CHAVE,
  pagador: PAGADOR.optional(),
  // D-133: a versão dos Termos que a tela mostrou ao aceite. Opcional no schema só para a recusa ter
  // frase própria (`conferirAceiteDosTermos`).
  termosVersao: z.string().max(40).optional(),
});

const entradaComprarPacote = z.object({
  // `fn_billing_criar_pedido` (migração 0909) casa `p_pacote` contra
  // `billing_token_pacotes.codigo`, não o `id`: mesmo formato de `CODIGO`.
  pacote: CODIGO,
  metodo: z.enum(["CREDIT_CARD", "PIX"]),
  chave: CHAVE,
  pagador: PAGADOR.optional(),
  termosVersao: z.string().max(40).optional(),
});

export type EntradaAcaoIniciarAssinatura = z.infer<typeof entradaIniciarAssinatura>;
export type EntradaAcaoComprarPacote = z.infer<typeof entradaComprarPacote>;

// ─── Contexto da requisição, mesmo molde de assinaturaDaOrganizacao.ts ────

async function contextoDaRequisicao() {
  const hdrs = await headers();
  return {
    requestId: hdrs.get("x-request-id"),
    ip: ipDoCliente(hdrs),
    userAgent: hdrs.get("user-agent"),
  };
}

// ─── Sessão: organização ativa + papel admin (mesmo molde de
// apagarDadosOperacionaisDaOrganizacao.ts) ─────────────────────────────────

type Autorizacao = { ok: true; userId: string; orgId: string } | { ok: false; mensagem: string };

async function autorizarAdminDaOrganizacao(mensagemSemPermissao: string): Promise<Autorizacao> {
  const authUser = await loadAuthUser();
  if (!authUser) return { ok: false, mensagem: mensagemSemPermissao };
  if (supportWriteError(authUser.support)) return { ok: false, mensagem: mensagemSemPermissao };

  const activeOrg = await resolveActiveOrg(authUser);
  if (!activeOrg) return { ok: false, mensagem: MENSAGEM_SEM_ORGANIZACAO };

  if (ROLE_RANK[activeOrg.role] < ROLE_RANK.admin) {
    if (!authUser.is_platform_admin) {
      return { ok: false, mensagem: mensagemSemPermissao };
    }
    // Correção 7: bypass do papel do tenant pelo admin da PLATAFORMA exige
    // escopo `full` e MFA em dia, a mesma régua de `cobrancaAsaas.ts`
    // (`requirePlatformAdmin` + `mfaEmDivida`). Sem isso, um platform admin
    // com escopo de suporte só leitura, ou numa sessão sem MFA provado,
    // compraria ou cancelaria a assinatura de QUALQUER organização.
    const admin = createAdminClient();
    const { data: paRow, error: paErro } = await admin
      .from("platform_admins")
      .select("scope")
      .eq("user_id", authUser.id)
      .is("revoked_at", null)
      .maybeSingle();
    if (paErro || !paRow || paRow.scope !== "full") {
      return { ok: false, mensagem: mensagemSemPermissao };
    }
    if (await mfaEmDivida()) {
      return { ok: false, mensagem: MENSAGEM_MFA };
    }
  }

  return { ok: true, userId: authUser.id, orgId: activeOrg.orgId };
}

/**
 * `configDoAsaas()` lança `ErroConfiguracaoAsaas` quando `ASAAS_ENABLED=true`
 * mas a base/chave estão incoerentes (`lib/billing/asaas/config.ts`): isto é
 * um erro de CONFIGURAÇÃO do servidor, não algo que o cliente causou, então
 * vira log + a mesma mensagem genérica, nunca o texto da exceção.
 */
function configAsaasOuNulo(): ConfigAsaas | null {
  try {
    return configDoAsaas();
  } catch (err) {
    logger.error("[compraDoPlano] configuração do Asaas inválida", {
      erro: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function montarDeps(config: ConfigAsaas, admin: ReturnType<typeof createAdminClient>) {
  return {
    db: dbCompraSupabase(admin),
    asaas: criarClienteAsaas({ fetch: globalThis.fetch.bind(globalThis), config, logger }),
    config,
    logger,
  };
}

/**
 * D-133: a compra só segue com o aceite da versão VIGENTE dos Termos. Sem versão: pede o aceite. Versão
 * diferente da vigente (a página ficou aberta enquanto o texto mudou): pede para recarregar e aceitar o
 * texto novo. A versão gravada é sempre a constante do servidor, nunca texto vindo do navegador.
 */
function conferirAceiteDosTermos(versaoEnviada: string | undefined): string | null {
  if (!versaoEnviada) return MENSAGEM_TERMOS_NAO_ACEITOS;
  if (versaoEnviada !== VERSAO_DOS_TERMOS) return MENSAGEM_TERMOS_ATUALIZADOS;
  return null;
}

async function auditarPedido(
  actorId: string,
  orgId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  const { requestId, ip, userAgent } = await contextoDaRequisicao();
  await audit({
    action: "billing.order_created",
    actorUserId: actorId,
    organizationId: orgId,
    resourceType: "organization",
    resourceId: orgId,
    metadata,
    requestId,
    ip,
    userAgent,
  });
}

// ─── iniciarAssinatura ──────────────────────────────────────────────────────

export async function iniciarAssinatura(input: {
  planCode: string;
  ciclo: "monthly" | "semiannual" | "yearly";
  metodo: "CREDIT_CARD" | "PIX";
  chave: string;
  pagador?: { nome: string; documento: string; email?: string; celular?: string };
  termosVersao?: string;
}): Promise<ResultadoIniciarCompra> {
  const auth = await autorizarAdminDaOrganizacao(MENSAGEM_SEM_PERMISSAO_COMPRAR);
  if (!auth.ok) return { tipo: "erro", mensagem: auth.mensagem };

  const parsed = entradaIniciarAssinatura.safeParse(input);
  if (!parsed.success) return { tipo: "erro", mensagem: MENSAGEM_DADOS_INVALIDOS };
  const recusaDosTermos = conferirAceiteDosTermos(parsed.data.termosVersao);
  if (recusaDosTermos) return { tipo: "erro", mensagem: recusaDosTermos };

  const config = configAsaasOuNulo();
  if (!config) return { tipo: "erro", mensagem: MENSAGEM_ERRO_CONFIGURACAO };
  if (!config.habilitado) return { tipo: "erro", mensagem: MENSAGEM_COMPRA_DESLIGADA };

  const admin = createAdminClient();
  if (!(await compraLigada(admin, config.habilitado))) {
    return { tipo: "erro", mensagem: MENSAGEM_COMPRA_DESLIGADA };
  }

  const entrada: EntradaIniciarCompra = {
    organizationId: auth.orgId,
    actorId: auth.userId,
    tipo: "assinatura",
    planCode: parsed.data.planCode,
    ciclo: parsed.data.ciclo,
    metodo: parsed.data.metodo,
    chave: parsed.data.chave,
    pagador: parsed.data.pagador,
    termosVersao: VERSAO_DOS_TERMOS,
  };

  const resultado = await iniciarCompra(montarDeps(config, admin), entrada);

  if (resultado.tipo !== "erro") {
    await auditarPedido(auth.userId, auth.orgId, {
      termos_versao: VERSAO_DOS_TERMOS,
      tipo: "assinatura",
      plan_code: parsed.data.planCode,
      ciclo: parsed.data.ciclo,
      metodo: parsed.data.metodo,
      resultado: resultado.tipo,
    });
  }

  return resultado;
}

// ─── comprarPacote ──────────────────────────────────────────────────────────

export async function comprarPacote(input: {
  pacote: string;
  metodo: "CREDIT_CARD" | "PIX";
  chave: string;
  pagador?: { nome: string; documento: string; email?: string; celular?: string };
  termosVersao?: string;
}): Promise<ResultadoIniciarCompra> {
  const auth = await autorizarAdminDaOrganizacao(MENSAGEM_SEM_PERMISSAO_COMPRAR);
  if (!auth.ok) return { tipo: "erro", mensagem: auth.mensagem };

  const parsed = entradaComprarPacote.safeParse(input);
  if (!parsed.success) return { tipo: "erro", mensagem: MENSAGEM_DADOS_INVALIDOS };
  const recusaDosTermos = conferirAceiteDosTermos(parsed.data.termosVersao);
  if (recusaDosTermos) return { tipo: "erro", mensagem: recusaDosTermos };

  const config = configAsaasOuNulo();
  if (!config) return { tipo: "erro", mensagem: MENSAGEM_ERRO_CONFIGURACAO };
  if (!config.habilitado) return { tipo: "erro", mensagem: MENSAGEM_COMPRA_DESLIGADA };

  const admin = createAdminClient();
  if (!(await compraLigada(admin, config.habilitado))) {
    return { tipo: "erro", mensagem: MENSAGEM_COMPRA_DESLIGADA };
  }

  const entrada: EntradaIniciarCompra = {
    organizationId: auth.orgId,
    actorId: auth.userId,
    tipo: "pacote_tokens",
    pacote: parsed.data.pacote,
    metodo: parsed.data.metodo,
    chave: parsed.data.chave,
    pagador: parsed.data.pagador,
    termosVersao: VERSAO_DOS_TERMOS,
  };

  const resultado = await iniciarCompra(montarDeps(config, admin), entrada);

  if (resultado.tipo !== "erro") {
    await auditarPedido(auth.userId, auth.orgId, {
      termos_versao: VERSAO_DOS_TERMOS,
      tipo: "pacote_tokens",
      pacote: parsed.data.pacote,
      metodo: parsed.data.metodo,
      resultado: resultado.tipo,
    });
  }

  return resultado;
}

// ─── cancelarAssinatura ─────────────────────────────────────────────────────

/**
 * Cancela a assinatura Asaas ATIVA da organização (decisão 18: depende só de
 * `ASAAS_ENABLED`, nunca de `compra_pelo_cliente`: desligar a venda não pode
 * prender ninguém numa assinatura já contratada).
 */
export async function cancelarAssinatura(): Promise<ResultadoCancelarAssinatura> {
  const auth = await autorizarAdminDaOrganizacao(MENSAGEM_SEM_PERMISSAO_CANCELAR);
  if (!auth.ok) return { tipo: "erro", mensagem: auth.mensagem };

  const config = configAsaasOuNulo();
  if (!config) return { tipo: "erro", mensagem: MENSAGEM_ERRO_CONFIGURACAO };
  if (!config.habilitado) return { tipo: "erro", mensagem: MENSAGEM_CANCELAMENTO_DESLIGADO };

  const admin = createAdminClient();
  const resultado = await cancelarAssinaturaDoCliente(montarDeps(config, admin), auth.orgId, auth.userId);

  if (resultado.tipo === "ok") {
    const { requestId, ip, userAgent } = await contextoDaRequisicao();
    await audit({
      action: "billing.subscription_cancel_requested",
      actorUserId: auth.userId,
      organizationId: auth.orgId,
      resourceType: "organization",
      resourceId: auth.orgId,
      metadata: { cancel_at_period_end: resultado.cancelAtPeriodEnd },
      requestId,
      ip,
      userAgent,
    });
  }

  return resultado;
}
