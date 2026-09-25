"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { mfaEmDivida } from "@/lib/auth/server";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * As seis escritas do admin da plataforma sobre a ASSINATURA de uma
 * organização (fase F4, tarefa 5, migração 0908, decisões 1 a 4): registrar
 * pagamento na mão (N24), estornar, corrigir o período por erro de
 * digitação, mudar o estado manualmente, pôr em avaliação e ligar/desligar o
 * cancelamento no fim do período. Segue o molde de `planoDaOrganizacao.ts`
 * (fase F1) e `carteiraDeTokens.ts` (fase F2-B): mesmo gate (escopo `full` +
 * MFA em dia), mesma régua de erro (errcode do Postgres vira frase fixa; o
 * texto cru nunca sai daqui), mesma auditoria (com IP pela régua do projeto)
 * e mesmo `revalidatePath`.
 *
 * ─── Por que NÃO há uma leitura própria de "organização existe" ────────────
 *
 * Diferente de `carteiraDeTokens.ts` (cujas quatro funções SQL não levantam
 * "organização não encontrada" sozinhas): as SEIS funções desta migração
 * (`fn_billing_registrar_pagamento`, `fn_billing_estornar_pagamento`,
 * `fn_billing_corrigir_periodo`, `fn_billing_mudar_estado`,
 * `fn_billing_cancelar_no_fim_do_periodo`) travam a linha de
 * `billing_contracts` da organização e levantam `billing_contrato_nao_
 * encontrado` (`P0002`) quando ela não existe, o mesmo desenho de
 * `fn_billing_trocar_plano` em `planoDaOrganizacao.ts`. A organização da
 * rota É conferida contra o banco, só que pela PRÓPRIA RPC, travando a linha
 * antes de escrever (sem a janela entre uma leitura separada e a escrita que
 * uma pré-checagem à parte teria).
 *
 * ─── Por que `porEmAvaliacao` chama DUAS RPCs, em DUAS transações ──────────
 *
 * `fn_billing_mudar_estado` não recebe data nenhuma: o destino `avaliacao`
 * exige que `current_period_end` JÁ esteja preenchido (reusa o período
 * existente, decisão 3 da migração). Pôr uma organização em avaliação com um
 * fim escolhido na hora precisa gravar esse fim primeiro
 * (`fn_billing_corrigir_periodo`) e só depois mudar o estado
 * (`fn_billing_mudar_estado` com `avaliacao`). As duas RPCs NÃO estão na
 * mesma transação (cada uma é a sua própria, como todas as funções desta
 * família): se a primeira escrever e a segunda falhar, o período já mudou de
 * verdade (fica correto, é uma correção legítima) mas o estado não; a ação
 * audita o que REALMENTE aconteceu em cada passo, nunca finge que as duas
 * são atômicas.
 *
 * ─── `motivo` NÃO é a `nota` da carteira de tokens ──────────────────────────
 *
 * `nota` (em `registrarPagamento`/`estornarPagamento`, livre e opcional)
 * pode carregar dado do cliente e nunca entra no `metadata` da auditoria,
 * mesma régua da carteira de tokens (decisão 16 da F2-B). `motivo` (em
 * `corrigirPeriodo`/`mudarEstadoDaAssinatura`/`porEmAvaliacao`) é outra
 * coisa: o comentário da própria `fn_billing_corrigir_periodo` (migração
 * 0908, decisão 2) diz que a função recebe `p_motivo` mas NÃO grava, porque
 * "a auditoria de quem/por quê mora em app/actions/admin". É exatamente essa
 * auditoria: `motivo` VAI no `metadata`.
 *
 * ─── Por que o erro do banco nunca vira `error.message` na resposta ────────
 *
 * A mensagem de erro do Postgres pode conter nome de coluna, de tabela ou
 * fragmento de SQL, e nada disso é para a tela. Só os errcodes/mensagens do
 * vocabulário conhecido das seis funções (comentários da migração 0908)
 * viram frase fixa reconhecível; qualquer outro vira uma frase genérica e o
 * texto cru vai só para o log do servidor.
 */

const UUID = z.string().uuid();
const NOTA = z.string().trim().max(500);
// Um bilhão de reais em centavos, mesmo teto de sanidade de
// `carteiraDeTokens.ts`: folga de sobra para o maior contrato real, sem abrir
// mão de rejeitar erro de dedo grosseiro. Não é limite do banco (a coluna é
// `integer`, sem CHECK de valor máximo além de positivo).
const TETO_DE_VALOR_CENTS = 100_000_000_000;

/**
 * "AAAA-MM-DD" é uma data de calendário REAL (não veio de um overflow do
 * `Date`, tipo 31/02). Mesma técnica de `planoDaOrganizacao.ts` (achado médio
 * 3-b da revisão da F3): `Date.UTC` normaliza meses/dias fora do intervalo em
 * vez de lançar; comparar os componentes de volta é como pegar isso.
 */
function dataCalendarioValida(ano: number, mes: number, dia: number): boolean {
  const reconstruida = new Date(Date.UTC(ano, mes - 1, dia));
  return (
    reconstruida.getUTCFullYear() === ano &&
    reconstruida.getUTCMonth() === mes - 1 &&
    reconstruida.getUTCDate() === dia
  );
}

const DATA_AAAAMMDD = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "formato de data inválido")
  .refine((texto) => {
    const [ano, mes, dia] = texto.split("-").map(Number);
    return dataCalendarioValida(ano!, mes!, dia!);
  }, "data inválida");

const ESTADOS_DO_CONTRATO = ["avaliacao", "ativa", "atrasada", "suspensa", "cancelada"] as const;

const entradaRegistrarPagamento = z.object({
  organizationId: UUID,
  fim: DATA_AAAAMMDD,
  valorCents: z.coerce.number().int().positive().max(TETO_DE_VALOR_CENTS),
  chave: UUID,
  nota: NOTA.optional(),
});

const entradaEstornarPagamento = z.object({
  organizationId: UUID,
  pagamentoId: UUID,
  chave: UUID,
  nota: NOTA.optional(),
});

const entradaCorrigirPeriodo = z.object({
  organizationId: UUID,
  fim: DATA_AAAAMMDD,
  // A própria função SQL exige (billing_motivo_obrigatorio, 22023): valida
  // aqui também para a mensagem chegar cedo, sem depender só do banco.
  motivo: NOTA.min(1, "obrigatório"),
});

const entradaMudarEstado = z.object({
  organizationId: UUID,
  estado: z.enum(ESTADOS_DO_CONTRATO),
  // `fn_billing_mudar_estado` recebe `p_motivo` mas não o valida (só
  // repassa para a auditoria do chamador, comentário da função): opcional
  // aqui, diferente de `corrigirPeriodo`, onde o banco recusa sem ele.
  motivo: NOTA.optional(),
});

const entradaPorEmAvaliacao = z.object({
  organizationId: UUID,
  fim: DATA_AAAAMMDD,
  // Motivo do PRIMEIRO passo (fn_billing_corrigir_periodo), que exige (ver
  // entradaCorrigirPeriodo); reusado no segundo passo (fn_billing_
  // mudar_estado) como o motivo da mudança de estado também.
  motivo: NOTA.min(1, "obrigatório"),
});

const entradaCancelarNoFimDoPeriodo = z.object({
  organizationId: UUID,
  sim: z.boolean(),
});

export type ResultadoDaAcaoDaAssinatura =
  | { ok: true; jaRegistrado: boolean; dados: Record<string, unknown> }
  | { ok: false; error: string };

async function contextoDaRequisicao() {
  const hdrs = await headers();
  return {
    requestId: hdrs.get("x-request-id"),
    ip: ipDoCliente(hdrs),
    userAgent: hdrs.get("user-agent"),
  };
}

function caminhoDaAbaDePlano(organizationId: string): string {
  return `/admin/tenants/${organizationId}/plano`;
}

/**
 * Traduz os errcodes das seis funções SQL (decisões 2 e 3, comentários das
 * próprias funções na migração 0908) para a frase que a tela mostra.
 * Qualquer coisa fora do vocabulário conhecido é falha inesperada do banco: o
 * texto cru vai só para o log, nunca para a resposta.
 */
function mensagemDoErroDaAssinatura(error: { code?: string; message?: string } | null): string {
  const msg = error?.message ?? "";
  if (error?.code === "22023") {
    if (msg.includes("billing_valor_invalido")) return "O valor precisa ser maior que zero.";
    if (msg.includes("billing_chave_obrigatoria")) return "A chave do formulário é obrigatória.";
    if (msg.includes("billing_fim_obrigatorio")) return "A data de fim é obrigatória.";
    if (msg.includes("billing_chave_com_valores_diferentes")) {
      return "Essa chave já foi usada com valores diferentes.";
    }
    if (msg.includes("billing_fim_anterior_ao_periodo_atual")) {
      return "A data de fim precisa ser posterior ao período atual.";
    }
    if (msg.includes("billing_pagamento_nao_pode_ser_estornado")) {
      return "Este pagamento já foi estornado e não pode ser estornado de novo.";
    }
    // Achado da Tarefa 1 (estorno duplo), corrigido na Tarefa 2, migração
    // 0908: segundo estorno do MESMO pagamento por outra chave (a checagem
    // acima, pelo status da linha original, não pega esse caso).
    if (msg.includes("billing_pagamento_ja_estornado")) return "Este pagamento já foi estornado.";
    if (msg.includes("billing_motivo_obrigatorio")) return "O motivo é obrigatório.";
    if (msg.includes("billing_fim_anterior_ao_inicio_do_periodo")) {
      return "A data de fim precisa ser posterior ao início do período.";
    }
    // fn_billing_mudar_estado (migração 0908, parte em andamento): avaliacao
    // exige current_period_end preenchido E no futuro, não só preenchido.
    if (msg.includes("billing_avaliacao_sem_data_futura")) {
      return "Para pôr em avaliação, o período precisa terminar numa data futura. Corrija o período antes.";
    }
    if (msg.includes("billing_estado_invalido")) return "Estado inválido.";
    if (msg.includes("billing_estado_sem_periodo_vigente")) {
      return "Não há período vigente para voltar a ativa. Registre um pagamento antes.";
    }
    if (msg.includes("billing_transicao_nao_permitida")) {
      return "Essa transição de estado não é permitida.";
    }
    if (msg.includes("billing_sim_obrigatorio")) {
      return "Informe se a assinatura cancela ou não no fim do período.";
    }
    // Fase F5, Tarefa 19, decisão 22 (migração 0909): `fn_billing_mudar_estado`
    // recusa a mudança manual para `cancelada` quando o contrato tem
    // assinatura Asaas viva (sem `asaas_assinatura_encerrada_em`). O admin
    // cancela a assinatura no Asaas primeiro (`cancelarAssinaturaNoAsaas`,
    // `app/actions/admin/cobrancaAsaas.ts`), e só depois muda o estado aqui.
    if (msg.includes("billing_cancele_no_asaas_antes")) {
      return "Esta organização tem assinatura ativa no Asaas. Cancele a assinatura no Asaas antes de mudar o estado para cancelada.";
    }
  }
  if (error?.code === "P0002") {
    if (msg.includes("billing_contrato_nao_encontrado")) return "Organização não encontrada.";
    if (msg.includes("billing_pagamento_nao_encontrado")) return "Pagamento não encontrado.";
  }
  if (error?.code === "42501") {
    // Nunca revela se o pagamento existe em outra organização: mesma frase
    // genérica de "não encontrado", régua de `carteiraDeTokens.ts`.
    if (msg.includes("billing_pagamento_de_outra_organizacao")) return "Pagamento não encontrado.";
  }
  logger.error("[assinaturaDaOrganizacao] erro na escrita da assinatura", {
    code: error?.code ?? null,
    message: error?.message ?? null,
  });
  return "Não foi possível salvar. Tente de novo.";
}

export async function registrarPagamento(input: {
  organizationId: string;
  fim: string;
  valorCents: number;
  chave: string;
  nota?: string;
}): Promise<ResultadoDaAcaoDaAssinatura> {
  const { user, platformAdmin } = await requirePlatformAdmin();

  if (platformAdmin.scope !== "full") {
    return { ok: false, error: "Seu acesso de suporte não permite registrar pagamento." };
  }
  if (await mfaEmDivida()) {
    return { ok: false, error: "Confirme a verificação em duas etapas." };
  }

  const parsed = entradaRegistrarPagamento.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Dados inválidos." };
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("fn_billing_registrar_pagamento" as never, {
    p_org: parsed.data.organizationId,
    p_fim: parsed.data.fim,
    p_valor_cents: parsed.data.valorCents,
    p_chave: parsed.data.chave,
    p_nota: parsed.data.nota ?? null,
    p_actor: user.id,
  } as never);

  if (error) {
    return { ok: false, error: mensagemDoErroDaAssinatura(error as { code?: string; message?: string }) };
  }

  const resultado = data as {
    ja_registrado: boolean;
    payment_id: string;
    current_period_start: string;
    current_period_end: string;
    status_contrato: string;
  };

  if (!resultado.ja_registrado) {
    const { requestId, ip, userAgent } = await contextoDaRequisicao();
    await audit({
      action: "billing.payment_registered",
      actorUserId: user.id,
      actingAsPlatformAdmin: true,
      organizationId: parsed.data.organizationId,
      resourceType: "organization",
      resourceId: parsed.data.organizationId,
      metadata: {
        fim: parsed.data.fim,
        valor_cents: parsed.data.valorCents,
        chave: parsed.data.chave,
        payment_id: resultado.payment_id,
        current_period_start: resultado.current_period_start,
        current_period_end: resultado.current_period_end,
        status_contrato: resultado.status_contrato,
      },
      requestId,
      ip,
      userAgent,
    });
  }

  revalidatePath(caminhoDaAbaDePlano(parsed.data.organizationId));
  return { ok: true, jaRegistrado: resultado.ja_registrado, dados: resultado };
}

export async function estornarPagamento(input: {
  organizationId: string;
  pagamentoId: string;
  chave: string;
  nota?: string;
}): Promise<ResultadoDaAcaoDaAssinatura> {
  const { user, platformAdmin } = await requirePlatformAdmin();

  if (platformAdmin.scope !== "full") {
    return { ok: false, error: "Seu acesso de suporte não permite estornar pagamento." };
  }
  if (await mfaEmDivida()) {
    return { ok: false, error: "Confirme a verificação em duas etapas." };
  }

  const parsed = entradaEstornarPagamento.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Dados inválidos." };
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("fn_billing_estornar_pagamento" as never, {
    p_org: parsed.data.organizationId,
    p_pagamento: parsed.data.pagamentoId,
    p_chave: parsed.data.chave,
    p_nota: parsed.data.nota ?? null,
    p_actor: user.id,
  } as never);

  if (error) {
    return { ok: false, error: mensagemDoErroDaAssinatura(error as { code?: string; message?: string }) };
  }

  const resultado = data as { ja_registrado: boolean; estorno_id: string };

  if (!resultado.ja_registrado) {
    const { requestId, ip, userAgent } = await contextoDaRequisicao();
    await audit({
      action: "billing.payment_refunded",
      actorUserId: user.id,
      actingAsPlatformAdmin: true,
      organizationId: parsed.data.organizationId,
      resourceType: "organization",
      resourceId: parsed.data.organizationId,
      metadata: {
        pagamento_id: parsed.data.pagamentoId,
        chave: parsed.data.chave,
        estorno_id: resultado.estorno_id,
      },
      requestId,
      ip,
      userAgent,
    });
  }

  revalidatePath(caminhoDaAbaDePlano(parsed.data.organizationId));
  return { ok: true, jaRegistrado: resultado.ja_registrado, dados: resultado };
}

/**
 * Chama `fn_billing_corrigir_periodo` e, se escreveu, audita
 * `billing.period_corrected`. Usada direto por `corrigirPeriodo` e como
 * primeiro passo de `porEmAvaliacao` (por isso devolve o `ResultadoDaAcaoDaAssinatura`
 * cru, e quem chama decide o que fazer com um erro).
 */
async function corrigirPeriodoInterno(
  actorId: string,
  organizationId: string,
  fim: string,
  motivo: string,
): Promise<ResultadoDaAcaoDaAssinatura> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("fn_billing_corrigir_periodo" as never, {
    p_org: organizationId,
    p_fim: fim,
    p_motivo: motivo,
    p_actor: actorId,
  } as never);

  if (error) {
    return { ok: false, error: mensagemDoErroDaAssinatura(error as { code?: string; message?: string }) };
  }

  const resultado = data as {
    current_period_end_anterior: string | null;
    current_period_end_novo: string;
  };

  // Sem chave idempotente nesta função (decisão 2: correção de digitação,
  // rara, feita à mão): toda chamada que não erra É uma escrita, então
  // audita sempre que chegar aqui.
  const { requestId, ip, userAgent } = await contextoDaRequisicao();
  await audit({
    action: "billing.period_corrected",
    actorUserId: actorId,
    actingAsPlatformAdmin: true,
    organizationId,
    resourceType: "organization",
    resourceId: organizationId,
    metadata: {
      fim,
      motivo,
      current_period_end_anterior: resultado.current_period_end_anterior,
      current_period_end_novo: resultado.current_period_end_novo,
    },
    requestId,
    ip,
    userAgent,
  });

  revalidatePath(caminhoDaAbaDePlano(organizationId));
  return { ok: true, jaRegistrado: false, dados: resultado };
}

export async function corrigirPeriodo(input: {
  organizationId: string;
  fim: string;
  motivo: string;
}): Promise<ResultadoDaAcaoDaAssinatura> {
  const { user, platformAdmin } = await requirePlatformAdmin();

  if (platformAdmin.scope !== "full") {
    return { ok: false, error: "Seu acesso de suporte não permite corrigir o período." };
  }
  if (await mfaEmDivida()) {
    return { ok: false, error: "Confirme a verificação em duas etapas." };
  }

  const parsed = entradaCorrigirPeriodo.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Dados inválidos." };
  }

  return corrigirPeriodoInterno(user.id, parsed.data.organizationId, parsed.data.fim, parsed.data.motivo);
}

/**
 * Chama `fn_billing_mudar_estado` e, se escreveu, audita
 * `billing.subscription_state_changed`. Mesmo desenho de
 * `corrigirPeriodoInterno`: usada direto por `mudarEstadoDaAssinatura` e
 * como segundo passo de `porEmAvaliacao`.
 */
async function mudarEstadoInterno(
  actorId: string,
  organizationId: string,
  estado: (typeof ESTADOS_DO_CONTRATO)[number],
  motivo: string | null,
): Promise<ResultadoDaAcaoDaAssinatura> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("fn_billing_mudar_estado" as never, {
    p_org: organizationId,
    p_estado: estado,
    p_motivo: motivo,
    p_actor: actorId,
  } as never);

  if (error) {
    return { ok: false, error: mensagemDoErroDaAssinatura(error as { code?: string; message?: string }) };
  }

  const resultado = data as { estado_anterior: string; estado_novo: string };

  // Sem chave idempotente (a transição só é permitida em estados específicos,
  // ver a própria função): toda chamada que não erra É uma escrita.
  const { requestId, ip, userAgent } = await contextoDaRequisicao();
  await audit({
    action: "billing.subscription_state_changed",
    actorUserId: actorId,
    actingAsPlatformAdmin: true,
    organizationId,
    resourceType: "organization",
    resourceId: organizationId,
    metadata: {
      estado: estado,
      motivo: motivo,
      estado_anterior: resultado.estado_anterior,
      estado_novo: resultado.estado_novo,
    },
    requestId,
    ip,
    userAgent,
  });

  revalidatePath(caminhoDaAbaDePlano(organizationId));
  return { ok: true, jaRegistrado: false, dados: resultado };
}

export async function mudarEstadoDaAssinatura(input: {
  organizationId: string;
  estado: (typeof ESTADOS_DO_CONTRATO)[number];
  motivo?: string;
}): Promise<ResultadoDaAcaoDaAssinatura> {
  const { user, platformAdmin } = await requirePlatformAdmin();

  if (platformAdmin.scope !== "full") {
    return { ok: false, error: "Seu acesso de suporte não permite mudar o estado da assinatura." };
  }
  if (await mfaEmDivida()) {
    return { ok: false, error: "Confirme a verificação em duas etapas." };
  }

  const parsed = entradaMudarEstado.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Dados inválidos." };
  }

  return mudarEstadoInterno(user.id, parsed.data.organizationId, parsed.data.estado, parsed.data.motivo ?? null);
}

/**
 * Compõe as duas RPCs (decisão 3 da fase: `avaliacao` exige `current_
 * period_end` já preenchido): grava o fim do período por
 * `fn_billing_corrigir_periodo` e, só depois, muda o estado para
 * `avaliacao` por `fn_billing_mudar_estado`. NÃO é atômico entre as duas
 * chamadas (cada RPC é a sua própria transação, como toda esta família): se
 * o primeiro passo escrever e o segundo falhar, o período já ficou correto
 * (fica assim mesmo, é uma correção legítima), só o estado não mudou, e a
 * resposta traz o erro do segundo passo para o admin tentar de novo (agora
 * só precisando de `mudarEstadoDaAssinatura`, já com o período certo).
 */
export async function porEmAvaliacao(input: {
  organizationId: string;
  fim: string;
  motivo: string;
}): Promise<ResultadoDaAcaoDaAssinatura> {
  const { user, platformAdmin } = await requirePlatformAdmin();

  if (platformAdmin.scope !== "full") {
    return { ok: false, error: "Seu acesso de suporte não permite pôr a organização em avaliação." };
  }
  if (await mfaEmDivida()) {
    return { ok: false, error: "Confirme a verificação em duas etapas." };
  }

  const parsed = entradaPorEmAvaliacao.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Dados inválidos." };
  }

  const resultadoPeriodo = await corrigirPeriodoInterno(
    user.id,
    parsed.data.organizationId,
    parsed.data.fim,
    parsed.data.motivo,
  );
  if (!resultadoPeriodo.ok) {
    return resultadoPeriodo;
  }

  const resultadoEstado = await mudarEstadoInterno(
    user.id,
    parsed.data.organizationId,
    "avaliacao",
    parsed.data.motivo,
  );
  if (!resultadoEstado.ok) {
    return resultadoEstado;
  }

  return {
    ok: true,
    jaRegistrado: false,
    dados: { periodo: resultadoPeriodo.dados, estado: resultadoEstado.dados },
  };
}

export async function cancelarNoFimDoPeriodo(input: {
  organizationId: string;
  sim: boolean;
}): Promise<ResultadoDaAcaoDaAssinatura> {
  const { user, platformAdmin } = await requirePlatformAdmin();

  if (platformAdmin.scope !== "full") {
    return { ok: false, error: "Seu acesso de suporte não permite mudar o cancelamento no fim do período." };
  }
  if (await mfaEmDivida()) {
    return { ok: false, error: "Confirme a verificação em duas etapas." };
  }

  const parsed = entradaCancelarNoFimDoPeriodo.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Dados inválidos." };
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("fn_billing_cancelar_no_fim_do_periodo" as never, {
    p_org: parsed.data.organizationId,
    p_sim: parsed.data.sim,
    p_actor: user.id,
  } as never);

  if (error) {
    return { ok: false, error: mensagemDoErroDaAssinatura(error as { code?: string; message?: string }) };
  }

  const resultado = data as { cancel_at_period_end: boolean };

  const { requestId, ip, userAgent } = await contextoDaRequisicao();
  await audit({
    action: "billing.cancel_at_period_end_changed",
    actorUserId: user.id,
    actingAsPlatformAdmin: true,
    organizationId: parsed.data.organizationId,
    resourceType: "organization",
    resourceId: parsed.data.organizationId,
    metadata: { cancel_at_period_end: resultado.cancel_at_period_end },
    requestId,
    ip,
    userAgent,
  });

  revalidatePath(caminhoDaAbaDePlano(parsed.data.organizationId));
  return { ok: true, jaRegistrado: false, dados: resultado };
}
