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
 * As quatro escritas do admin da plataforma sobre a CARTEIRA DE TOKENS de IA
 * de uma organização (fase F2-B, tarefa 4, decisão 16): creditar um pacote
 * avulso, contratar um adicional, cancelar um adicional e ajustar tokens com
 * sinal livre. Segue à risca o molde de `planoDaOrganizacao.ts` (fase F1,
 * tarefa 4): mesmo gate (escopo `full` + MFA em dia), mesma régua de erro
 * (errcode do Postgres vira frase fixa; o texto cru nunca sai daqui), mesma
 * auditoria (com IP pela régua do projeto) e mesmo `revalidatePath`.
 *
 * ─── Por que a organização é conferida ANTES da RPC, e não pela FK ──────────
 *
 * As quatro funções SQL (`fn_billing_creditar_tokens`,
 * `fn_billing_contratar_adicional`, `fn_billing_cancelar_adicional`,
 * `fn_billing_ajustar_tokens`) não checam "organização existe" — diferente de
 * `fn_billing_trocar_plano` (F1), nenhuma delas levanta
 * `organizacao_nao_encontrada`. Uma organização inexistente só apareceria como
 * violação de chave estrangeira (23503) na tabela de destino, um erro genérico
 * que a régua abaixo trataria como "não foi possível salvar" — uma mensagem
 * pior que a fixa que a tela de Plano (F1) já mostra para o mesmo caso. Por
 * isso a action confere a organização com uma leitura própria (a mesma que a
 * página já faz para render, sem custo extra de rota) antes de chamar
 * qualquer RPC.
 *
 * ─── A chave idempotente (decisão 16) ────────────────────────────────────────
 *
 * Nasce no CLIENTE quando cada formulário é montado (`crypto.randomUUID()` em
 * `_client.tsx`), não aqui: o servidor só VALIDA o formato (uuid) e repassa
 * como `p_chave`/`id` para a RPC, que faz `insert ... on conflict do nothing`.
 * Reenvio (duplo clique, timeout que reenvia) chega aqui com a MESMA chave, a
 * RPC não credita/contrata/ajusta de novo, e o retorno da função (`creditado`,
 * `criado`, `cancelado_agora`, `ajustado`) diz se ESTA chamada foi a que
 * escreveu. Só quando foi de fato é que a action audita: reenvio da mesma
 * chave não gera um segundo evento de auditoria para um crédito que não
 * aconteceu de novo.
 *
 * ─── Por que a nota nunca entra no `metadata` da auditoria ──────────────────
 *
 * Decisão 16/7 da fase: a nota pode ter dado do cliente (o formulário avisa
 * para não pôr nenhum), e fica só no livro-caixa (`billing_token_ledger`),
 * lido pela mesma régua de "gerente para cima" da carteira — não no log de
 * auditoria, que qualquer admin de suporte também lê.
 */

const UUID = z.string().uuid();
const NOTA = z.string().trim().max(500);
// Teto de sanidade, não um limite do banco (as colunas são bigint, sem
// constraint de valor máximo): evita que um dedo no formulário vire um
// número absurdo que estoura a exibição em toda tela que lê a carteira
// depois. Um trilhão de tokens ponderados é folga de sobra para qualquer
// pacote real desta fase.
const TETO_DE_TOKENS = 1_000_000_000_000;
// Um bilhão de reais em centavos: mesma lógica, folga de sobra para o maior
// contrato real, sem abrir mão de rejeitar erro de dedo grosseiro.
const TETO_DE_VALOR_CENTS = 100_000_000_000;

const entradaCreditar = z.object({
  organizationId: UUID,
  tokens: z.coerce.number().int().positive().max(TETO_DE_TOKENS),
  chave: UUID,
  valorCents: z.coerce.number().int().nonnegative().max(TETO_DE_VALOR_CENTS).optional(),
  nota: NOTA.optional(),
});

const entradaCreditarPacote = z.object({
  organizationId: UUID,
  pacoteId: UUID,
  chave: UUID,
  // Só entra quando o pacote não tem preço no catálogo (decisão 10, N9):
  // `fn_billing_creditar_pacote` usa o preço do catálogo quando ele existe,
  // e recusa (22023) se os dois estiverem ausentes.
  valorCents: z.coerce.number().int().nonnegative().max(TETO_DE_VALOR_CENTS).optional(),
  nota: NOTA.optional(),
});

const entradaContratar = z.object({
  organizationId: UUID,
  tokensPorCiclo: z.coerce.number().int().positive().max(TETO_DE_TOKENS),
  chave: UUID,
  valorCents: z.coerce.number().int().nonnegative().max(TETO_DE_VALOR_CENTS).optional(),
  nota: NOTA.optional(),
});

const entradaCancelar = z.object({
  organizationId: UUID,
  adicionalId: UUID,
});

const FONTES_DE_AJUSTE = ["plano", "adicional", "avulso"] as const;

const entradaAjustar = z.object({
  organizationId: UUID,
  fonte: z.enum(FONTES_DE_AJUSTE),
  tokens: z.coerce
    .number()
    .int()
    .min(-TETO_DE_TOKENS)
    .max(TETO_DE_TOKENS)
    .refine((n) => n !== 0, "não pode ser zero"),
  chave: UUID,
  // A linha do livro-caixa que este ajuste compensa (estorno de débito
  // errado), opcional (decisão 16).
  compensaId: UUID.optional(),
  // Nota OBRIGATÓRIA no ajuste (a mesma régua de `fn_billing_ajustar_tokens`,
  // que recusa nota vazia com 22023): sem ela ninguém que olhar o livro-caixa
  // depois sabe por que um número saiu do lugar.
  nota: NOTA.min(1, "obrigatória"),
});

export type ResultadoDaAcaoDeTokens =
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
 * A organização do parâmetro/rota existe de verdade? Mesma leitura mínima que
 * `page.tsx` já faria implicitamente (a página nem renderiza para uma
 * organização inexistente); aqui é a barreira que evita uma FK genérica virar
 * a mensagem de erro. Nunca lança: erro de leitura vira "não encontrada" (o
 * mesmo efeito de segurança de negar por padrão) e vai para o log.
 */
async function organizacaoExiste(organizationId: string): Promise<boolean> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("organizations")
    .select("id")
    .eq("id", organizationId)
    .maybeSingle();
  if (error) {
    logger.error("[carteiraDeTokens] erro ao conferir organização", {
      organization_id: organizationId,
      code: error.code ?? null,
    });
    return false;
  }
  return data !== null;
}

/**
 * Traduz os errcodes das quatro funções SQL (decisão 16, comentários das
 * próprias funções na migração 0906 Parte 4) para a frase que a tela mostra.
 * Qualquer coisa fora do vocabulário conhecido é falha inesperada do banco: o
 * texto cru vai só para o log, nunca para a resposta.
 */
function mensagemDoErroDeTokens(error: { code?: string; message?: string } | null): string {
  const msg = error?.message ?? "";
  if (error?.code === "22023") {
    if (msg.includes("credito_tokens_deve_ser_positivo")) return "A quantidade de tokens precisa ser maior que zero.";
    if (msg.includes("ajuste_tokens_nao_pode_ser_zero")) return "A quantidade de tokens do ajuste não pode ser zero.";
    if (msg.includes("ajuste_fonte_invalida")) return "Fonte inválida.";
    if (msg.includes("ajuste_precisa_de_nota")) return "O ajuste precisa de uma nota.";
    if (msg.includes("billing_pacote_inativo")) return "Este pacote não está mais à venda.";
    if (msg.includes("billing_valor_obrigatorio")) {
      return "Este pacote não tem preço no catálogo: informe o valor recebido.";
    }
  }
  if (error?.code === "P0002") {
    if (msg.includes("adicional_nao_encontrado")) return "Adicional não encontrado.";
    if (msg.includes("billing_pacote_nao_encontrado")) return "Pacote não encontrado.";
  }
  if (error?.code === "42501") {
    // As duas mensagens (adicional de outra organização, linha de
    // compensação inválida) nunca revelam se a linha existe em outra
    // organização: a mesma frase genérica cobre as duas, seguindo o
    // comentário da própria função SQL.
    if (msg.includes("adicional_de_outra_organizacao")) return "Adicional não encontrado.";
    if (msg.includes("ajuste_compensa_linha_invalida")) return "A linha informada para compensar não foi encontrada.";
  }
  logger.error("[carteiraDeTokens] erro na escrita da carteira", {
    code: error?.code ?? null,
    message: error?.message ?? null,
  });
  return "Não foi possível salvar. Tente de novo.";
}

export async function creditarTokens(input: {
  organizationId: string;
  tokens: number;
  chave: string;
  valorCents?: number;
  nota?: string;
}): Promise<ResultadoDaAcaoDeTokens> {
  const { user, platformAdmin } = await requirePlatformAdmin();

  if (platformAdmin.scope !== "full") {
    return { ok: false, error: "Seu acesso de suporte não permite creditar tokens." };
  }
  if (await mfaEmDivida()) {
    return { ok: false, error: "Confirme a verificação em duas etapas." };
  }

  const parsed = entradaCreditar.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Dados inválidos." };
  }

  if (!(await organizacaoExiste(parsed.data.organizationId))) {
    return { ok: false, error: "Organização não encontrada." };
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("fn_billing_creditar_tokens", {
    p_org: parsed.data.organizationId,
    p_tokens: parsed.data.tokens,
    p_chave: parsed.data.chave,
    p_valor_cents: parsed.data.valorCents ?? null,
    p_nota: parsed.data.nota ?? null,
    p_criado_por: user.id,
  });

  if (error) {
    return { ok: false, error: mensagemDoErroDeTokens(error) };
  }

  const resultado = data as { creditado: boolean; saldo_avulso: number };

  if (resultado.creditado) {
    const { requestId, ip, userAgent } = await contextoDaRequisicao();
    await audit({
      action: "billing.tokens_credited",
      actorUserId: user.id,
      actingAsPlatformAdmin: true,
      organizationId: parsed.data.organizationId,
      resourceType: "organization",
      resourceId: parsed.data.organizationId,
      metadata: { tokens: parsed.data.tokens, chave: parsed.data.chave, valor_cents: parsed.data.valorCents ?? null },
      requestId,
      ip,
      userAgent,
    });
  }

  revalidatePath(caminhoDaAbaDePlano(parsed.data.organizationId));
  return { ok: true, jaRegistrado: !resultado.creditado, dados: resultado };
}

/**
 * Credita um pacote do CATÁLOGO (fase F4, tarefa 8, decisão 10:
 * `billing_token_pacotes`), pela RPC `fn_billing_creditar_pacote` (migração
 * 0908, parte 3), que é a ponte até `fn_billing_creditar_tokens` (0906).
 * Mesma régua das outras três escritas deste arquivo: escopo `full`, MFA em
 * dia, zod no servidor, errcode do Postgres vira frase fixa, sucesso audita
 * SEM a nota (`billing.token_pack_credited`, acrescentado ao fim de
 * `lib/audit/actions.ts`) e só quando a RPC diz que ESTA chamada creditou de
 * fato (reenvio com a mesma chave não audita de novo).
 */
export async function creditarPacote(input: {
  organizationId: string;
  pacoteId: string;
  chave: string;
  valorCents?: number;
  nota?: string;
}): Promise<ResultadoDaAcaoDeTokens> {
  const { user, platformAdmin } = await requirePlatformAdmin();

  if (platformAdmin.scope !== "full") {
    return { ok: false, error: "Seu acesso de suporte não permite creditar um pacote do catálogo." };
  }
  if (await mfaEmDivida()) {
    return { ok: false, error: "Confirme a verificação em duas etapas." };
  }

  const parsed = entradaCreditarPacote.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Dados inválidos." };
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("fn_billing_creditar_pacote" as never, {
    p_org: parsed.data.organizationId,
    p_pacote: parsed.data.pacoteId,
    p_valor_cents: parsed.data.valorCents ?? null,
    p_chave: parsed.data.chave,
    p_nota: parsed.data.nota ?? null,
    p_actor: user.id,
  } as never);

  if (error) {
    return { ok: false, error: mensagemDoErroDeTokens(error as { code?: string; message?: string }) };
  }

  const resultado = data as {
    creditado: boolean;
    saldo_avulso: number;
    pacote_id: string;
    tokens: number;
    valor_cents: number;
  };

  if (resultado.creditado) {
    const { requestId, ip, userAgent } = await contextoDaRequisicao();
    await audit({
      action: "billing.token_pack_credited",
      actorUserId: user.id,
      actingAsPlatformAdmin: true,
      organizationId: parsed.data.organizationId,
      resourceType: "organization",
      resourceId: parsed.data.organizationId,
      metadata: {
        pacote_id: resultado.pacote_id,
        tokens: resultado.tokens,
        valor_cents: resultado.valor_cents,
        chave: parsed.data.chave,
      },
      requestId,
      ip,
      userAgent,
    });
  }

  revalidatePath(caminhoDaAbaDePlano(parsed.data.organizationId));
  return { ok: true, jaRegistrado: !resultado.creditado, dados: resultado };
}

export async function contratarAdicional(input: {
  organizationId: string;
  tokensPorCiclo: number;
  chave: string;
  valorCents?: number;
  nota?: string;
}): Promise<ResultadoDaAcaoDeTokens> {
  const { user, platformAdmin } = await requirePlatformAdmin();

  if (platformAdmin.scope !== "full") {
    return { ok: false, error: "Seu acesso de suporte não permite contratar um adicional." };
  }
  if (await mfaEmDivida()) {
    return { ok: false, error: "Confirme a verificação em duas etapas." };
  }

  const parsed = entradaContratar.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Dados inválidos." };
  }

  if (!(await organizacaoExiste(parsed.data.organizationId))) {
    return { ok: false, error: "Organização não encontrada." };
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("fn_billing_contratar_adicional", {
    p_org: parsed.data.organizationId,
    p_tokens_por_ciclo: parsed.data.tokensPorCiclo,
    p_chave: parsed.data.chave,
    p_valor_cents: parsed.data.valorCents ?? null,
    p_nota: parsed.data.nota ?? null,
    p_criado_por: user.id,
  });

  if (error) {
    return { ok: false, error: mensagemDoErroDeTokens(error) };
  }

  const resultado = data as { id: string; criado: boolean };

  if (resultado.criado) {
    const { requestId, ip, userAgent } = await contextoDaRequisicao();
    await audit({
      action: "billing.addon_changed",
      actorUserId: user.id,
      actingAsPlatformAdmin: true,
      organizationId: parsed.data.organizationId,
      resourceType: "organization",
      resourceId: parsed.data.organizationId,
      metadata: {
        acao: "contratado",
        adicional_id: resultado.id,
        tokens_por_ciclo: parsed.data.tokensPorCiclo,
        chave: parsed.data.chave,
        valor_cents: parsed.data.valorCents ?? null,
      },
      requestId,
      ip,
      userAgent,
    });
  }

  revalidatePath(caminhoDaAbaDePlano(parsed.data.organizationId));
  return { ok: true, jaRegistrado: !resultado.criado, dados: resultado };
}

export async function cancelarAdicional(input: {
  organizationId: string;
  adicionalId: string;
}): Promise<ResultadoDaAcaoDeTokens> {
  const { user, platformAdmin } = await requirePlatformAdmin();

  if (platformAdmin.scope !== "full") {
    return { ok: false, error: "Seu acesso de suporte não permite cancelar um adicional." };
  }
  if (await mfaEmDivida()) {
    return { ok: false, error: "Confirme a verificação em duas etapas." };
  }

  const parsed = entradaCancelar.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Dados inválidos." };
  }

  if (!(await organizacaoExiste(parsed.data.organizationId))) {
    return { ok: false, error: "Organização não encontrada." };
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("fn_billing_cancelar_adicional", {
    p_org: parsed.data.organizationId,
    p_adicional: parsed.data.adicionalId,
    p_criado_por: user.id,
  });

  if (error) {
    return { ok: false, error: mensagemDoErroDeTokens(error) };
  }

  const resultado = data as { id: string; cancelado: boolean; cancelado_agora: boolean };

  if (resultado.cancelado_agora) {
    const { requestId, ip, userAgent } = await contextoDaRequisicao();
    await audit({
      action: "billing.addon_changed",
      actorUserId: user.id,
      actingAsPlatformAdmin: true,
      organizationId: parsed.data.organizationId,
      resourceType: "organization",
      resourceId: parsed.data.organizationId,
      metadata: { acao: "cancelado", adicional_id: parsed.data.adicionalId },
      requestId,
      ip,
      userAgent,
    });
  }

  revalidatePath(caminhoDaAbaDePlano(parsed.data.organizationId));
  return { ok: true, jaRegistrado: !resultado.cancelado_agora, dados: resultado };
}

export async function ajustarTokens(input: {
  organizationId: string;
  fonte: "plano" | "adicional" | "avulso";
  tokens: number;
  chave: string;
  compensaId?: string;
  nota: string;
}): Promise<ResultadoDaAcaoDeTokens> {
  const { user, platformAdmin } = await requirePlatformAdmin();

  if (platformAdmin.scope !== "full") {
    return { ok: false, error: "Seu acesso de suporte não permite ajustar tokens." };
  }
  if (await mfaEmDivida()) {
    return { ok: false, error: "Confirme a verificação em duas etapas." };
  }

  const parsed = entradaAjustar.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Dados inválidos." };
  }

  if (!(await organizacaoExiste(parsed.data.organizationId))) {
    return { ok: false, error: "Organização não encontrada." };
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("fn_billing_ajustar_tokens", {
    p_org: parsed.data.organizationId,
    p_fonte: parsed.data.fonte,
    p_tokens: parsed.data.tokens,
    p_chave: parsed.data.chave,
    p_compensa: parsed.data.compensaId ?? null,
    p_nota: parsed.data.nota,
    p_criado_por: user.id,
  });

  if (error) {
    return { ok: false, error: mensagemDoErroDeTokens(error) };
  }

  const resultado = data as { ajustado: boolean; saldo: number };

  if (resultado.ajustado) {
    const { requestId, ip, userAgent } = await contextoDaRequisicao();
    await audit({
      action: "billing.tokens_adjusted",
      actorUserId: user.id,
      actingAsPlatformAdmin: true,
      organizationId: parsed.data.organizationId,
      resourceType: "organization",
      resourceId: parsed.data.organizationId,
      metadata: {
        fonte: parsed.data.fonte,
        tokens: parsed.data.tokens,
        chave: parsed.data.chave,
        compensa_id: parsed.data.compensaId ?? null,
      },
      requestId,
      ip,
      userAgent,
    });
  }

  revalidatePath(caminhoDaAbaDePlano(parsed.data.organizationId));
  return { ok: true, jaRegistrado: !resultado.ajustado, dados: resultado };
}
