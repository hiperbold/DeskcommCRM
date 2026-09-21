import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * PATCH  /api/v1/ai/mcp/conexoes/:id — troca nome, liga/desliga ou troca o
 *                                       cabeçalho de acesso. NÃO reconecta:
 *                                       só "Atualizar ferramentas" o faz.
 * DELETE /api/v1/ai/mcp/conexoes/:id — remove a conexão.
 *
 * Papel exigido: admin (mesmo achado da listagem, Tarefa 6). `organizationId`
 * vem sempre de `requireRole`, nunca do corpo nem do path.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { editarConexao, listarConexoes, removerConexao } from "@/lib/ai/mcp-externo/conexoes";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CABECALHO_NOME_REGEX = /^[A-Za-z0-9-]{1,64}$/;

const editarSchema = z.object({
  nome: z.string().trim().min(2).max(80).optional(),
  ativa: z.boolean().optional(),
  // `null` nos dois (não `undefined`) é o pedido explícito de REMOVER o
  // cabeçalho; chave ausente é "não mexer nele". Distinguir os dois é o que
  // permite desligar a credencial sem forçar a pessoa a reenviar nome+valor.
  cabecalho_nome: z.string().regex(CABECALHO_NOME_REGEX).nullable().optional(),
  cabecalho_valor: z.string().min(1).max(2000).nullable().optional(),
});

const idSchema = z.string().uuid();

type Cabecalho = { nome: string; valor: string } | null;

/**
 * `undefined` = campo ausente do corpo, não mexer no cabeçalho atual.
 * `null` = os dois vieram `null`, apagar o cabeçalho.
 * `{ nome, valor }` = os dois vieram preenchidos, trocar o cabeçalho.
 * Qualquer combinação torta (um `null` e o outro string, ou só um dos dois)
 * é erro de quem chamou.
 */
function resolverCabecalho(
  nome: string | null | undefined,
  valor: string | null | undefined,
): { ok: true; cabecalho: Cabecalho | undefined } | { ok: false } {
  if (nome === undefined && valor === undefined) return { ok: true, cabecalho: undefined };
  if (nome === null && valor === null) return { ok: true, cabecalho: null };
  if (typeof nome === "string" && typeof valor === "string") {
    return { ok: true, cabecalho: { nome, valor } };
  }
  return { ok: false };
}

function contextoDaRequisicao(req: NextRequest) {
  return {
    ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    userAgent: req.headers.get("user-agent") ?? null,
  };
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "ai_mcp_connections" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const { id } = await ctx.params;
  const idParsed = idSchema.safeParse(id);
  if (!idParsed.success) return fail("invalid_request", t("Id da conexão inválido."), 422, { requestId });

  const parsed = editarSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Campos inválidos."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const input = parsed.data;

  const cabecalhoResolvido = resolverCabecalho(input.cabecalho_nome, input.cabecalho_valor);
  if (!cabecalhoResolvido.ok) {
    return fail(
      "validation_failed",
      t("Informe nome e valor do cabeçalho juntos, os dois em branco para remover, ou nenhum dos dois."),
      422,
      { requestId },
    );
  }

  const admin = createAdminClient();
  const resultado = await editarConexao(admin, authz.org.orgId, idParsed.data, {
    nome: input.nome,
    ativa: input.ativa,
    cabecalho: cabecalhoResolvido.cabecalho,
  });

  if (!resultado.ok) {
    // 404 (não encontrada) e 422 (validação do repositório): repassados com
    // o motivo do repositório, sem reescrever a frase.
    return fail(
      resultado.status === 404 ? "not_found" : "unprocessable_entity",
      t(resultado.motivo),
      resultado.status,
      { requestId },
    );
  }

  void audit({
    action: "ai_mcp_connection.updated",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "ai_mcp_connection",
    resourceId: idParsed.data,
    requestId,
    ...contextoDaRequisicao(req),
    // Nunca a URL nem o cabeçalho: só o apelido, quantas ferramentas em
    // cache e se ficou com credencial configurada.
    metadata: {
      apelido: resultado.conexao.apelido,
      ferramentas: resultado.conexao.ferramentas.length,
      tem_cabecalho: resultado.conexao.tem_cabecalho,
    },
  });

  return ok({ conexao: resultado.conexao }, { requestId });
}

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "ai_mcp_connections" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const { id } = await ctx.params;
  const idParsed = idSchema.safeParse(id);
  if (!idParsed.success) return fail("invalid_request", t("Id da conexão inválido."), 422, { requestId });

  const admin = createAdminClient();
  // Lida ANTES de remover: é a única forma de levar apelido e contagem de
  // ferramentas para o audit sem reabrir `conexoes.ts` (que este briefing
  // proíbe tocar) e sem devolver a URL ou o cabeçalho, que nunca saem daqui.
  const antes = (await listarConexoes(admin, authz.org.orgId)).find((c) => c.id === idParsed.data) ?? null;

  const resultado = await removerConexao(admin, authz.org.orgId, idParsed.data);
  if (!resultado.ok) {
    return fail("not_found", t(resultado.motivo), resultado.status, { requestId });
  }

  void audit({
    action: "ai_mcp_connection.removed",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "ai_mcp_connection",
    resourceId: idParsed.data,
    requestId,
    ...contextoDaRequisicao(req),
    metadata: antes
      ? { apelido: antes.apelido, ferramentas: antes.ferramentas.length, tem_cabecalho: antes.tem_cabecalho }
      : {},
  });

  return ok({ removida: true }, { requestId });
}
