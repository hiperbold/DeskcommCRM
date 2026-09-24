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
 * O CADASTRO do catálogo de pacotes de tokens vendidos na mão (fase F4,
 * tarefa 8, decisão 10 de `hiperbold/planos/fase-F4-tarefas.md`:
 * `billing_token_pacotes`, migração 0908, parte 3). Duas escritas, criar e
 * desativar, no molde de `bloqueioDosPlanos.ts`: escopo `full`, MFA em dia,
 * zod no servidor, erro do banco nunca vira `error.message` cru na resposta,
 * sucesso audita e revalida a tela.
 *
 * ─── Por que direto pelo `.from()`, sem RPC nova ────────────────────────────
 *
 * `billing_token_pacotes` já tem `grant select, insert, update` para
 * `service_role` (sem `delete`: um pacote vendido fica no histórico,
 * comentário da migração 0908, parte 3), e não há concorrência a travar
 * aqui: cada linha é o cadastro isolado de UM pacote, sem soma nem saldo por
 * cima dela. Mesmo racional de `definirDiasDeCarencia`
 * (`bloqueioDosPlanos.ts`): uma coluna solta sem `for update` não justificou
 * uma função nova só para isto.
 *
 * ─── Por que `precoCents` NUNCA é inventado (N9) ────────────────────────────
 *
 * O campo fica opcional no formulário e nulo no banco até o Filipe decidir o
 * preço; `fn_billing_creditar_pacote` (migração 0908, parte 3) já sabe pedir
 * o valor na hora quando o catálogo não tem um. Esta ação nunca preenche um
 * padrão.
 */
const CODIGO = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]{1,30}$/, "letras minúsculas, dígitos e _, começando por letra");
const NOME = z.string().trim().min(1, "obrigatório").max(200);
const UUID = z.string().uuid();
// Um trilhão de tokens: mesmo teto de sanidade de `carteiraDeTokens.ts`.
const TETO_DE_TOKENS = 1_000_000_000_000;
const TETO_DE_VALOR_CENTS = 100_000_000_000;

const entradaCriar = z.object({
  codigo: CODIGO,
  nome: NOME,
  tokens: z.coerce.number().int().positive().max(TETO_DE_TOKENS),
  // Ausente/vazio = nulo no banco (N9): nenhum preço é inventado aqui.
  precoCents: z.coerce.number().int().nonnegative().max(TETO_DE_VALOR_CENTS).optional(),
});

const entradaDesativar = z.object({
  pacoteId: UUID,
});

export type ResultadoDoCadastroDePacote =
  | { ok: true; pacoteId: string }
  | { ok: false; error: string };

async function contextoDaRequisicao() {
  const hdrs = await headers();
  return {
    requestId: hdrs.get("x-request-id"),
    ip: ipDoCliente(hdrs),
    userAgent: hdrs.get("user-agent"),
  };
}

const CAMINHO_DA_TELA = "/admin/sistema";

/** Traduz o que o Postgres pode devolver para o insert/update desta tabela. */
function mensagemDoErroDoCadastro(error: { code?: string; message?: string } | null): string {
  if (error?.code === "23505") {
    return "Já existe um pacote com este código.";
  }
  if (error?.code === "23514") {
    return "Dados inválidos para este pacote.";
  }
  logger.error("[pacotesDeTokens] erro no cadastro do pacote", {
    code: error?.code ?? null,
    message: error?.message ?? null,
  });
  return "Não foi possível salvar. Tente de novo.";
}

export async function criarPacote(input: {
  codigo: string;
  nome: string;
  tokens: number;
  precoCents?: number;
}): Promise<ResultadoDoCadastroDePacote> {
  const { user, platformAdmin } = await requirePlatformAdmin();

  if (platformAdmin.scope !== "full") {
    return { ok: false, error: "Seu acesso de suporte não permite cadastrar pacotes." };
  }
  if (await mfaEmDivida()) {
    return { ok: false, error: "Confirme a verificação em duas etapas." };
  }

  const parsed = entradaCriar.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Dados inválidos." };
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("billing_token_pacotes")
    .insert({
      codigo: parsed.data.codigo,
      nome: parsed.data.nome,
      tokens: parsed.data.tokens,
      preco_cents: parsed.data.precoCents ?? null,
    })
    .select("id")
    .single();

  if (error) {
    return { ok: false, error: mensagemDoErroDoCadastro(error) };
  }

  const pacoteId = (data as { id: string }).id;

  const { requestId, ip, userAgent } = await contextoDaRequisicao();
  await audit({
    action: "billing.token_pack_created",
    actorUserId: user.id,
    actingAsPlatformAdmin: true,
    resourceType: "billing_token_pacotes",
    resourceId: pacoteId,
    metadata: {
      pacote_id: pacoteId,
      codigo: parsed.data.codigo,
      nome: parsed.data.nome,
      tokens: parsed.data.tokens,
      preco_cents: parsed.data.precoCents ?? null,
    },
    requestId,
    ip,
    userAgent,
  });

  revalidatePath(CAMINHO_DA_TELA);
  return { ok: true, pacoteId };
}

export async function desativarPacote(input: { pacoteId: string }): Promise<ResultadoDoCadastroDePacote> {
  const { user, platformAdmin } = await requirePlatformAdmin();

  if (platformAdmin.scope !== "full") {
    return { ok: false, error: "Seu acesso de suporte não permite desativar pacotes." };
  }
  if (await mfaEmDivida()) {
    return { ok: false, error: "Confirme a verificação em duas etapas." };
  }

  const parsed = entradaDesativar.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Dados inválidos." };
  }

  const admin = createAdminClient();
  const { error } = await admin
    .from("billing_token_pacotes")
    .update({ ativo: false })
    .eq("id", parsed.data.pacoteId);

  if (error) {
    return { ok: false, error: mensagemDoErroDoCadastro(error) };
  }

  const { requestId, ip, userAgent } = await contextoDaRequisicao();
  await audit({
    action: "billing.token_pack_deactivated",
    actorUserId: user.id,
    actingAsPlatformAdmin: true,
    resourceType: "billing_token_pacotes",
    resourceId: parsed.data.pacoteId,
    metadata: { pacote_id: parsed.data.pacoteId },
    requestId,
    ip,
    userAgent,
  });

  revalidatePath(CAMINHO_DA_TELA);
  return { ok: true, pacoteId: parsed.data.pacoteId };
}
