import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/ai/mcp/conexoes/:id/atualizar — reconecta no servidor MCP e
 * regrava o cache de ferramentas (botão "Atualizar ferramentas" da tela).
 *
 * Papel exigido: admin (mesmo achado da listagem, Tarefa 6). `organizationId`
 * vem sempre de `requireRole`, nunca do corpo nem do path. Sem corpo: é uma
 * ação, não uma edição de campos.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { atualizarFerramentas, listarConexoes } from "@/lib/ai/mcp-externo/conexoes";
// Orçamento COMPARTILHADO com `POST /api/v1/ai/mcp/conexoes` (mesma chave
// org+usuário). Mora fora das rotas: ver o cabeçalho de `limite-de-conexao.ts`.
import { MOTIVO_LIMITE_DE_CONEXAO, tentativaDeConexaoLiberada } from "@/lib/ai/mcp-externo/limite-de-conexao";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const idSchema = z.string().uuid();

function contextoDaRequisicao(req: NextRequest) {
  return {
    ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    userAgent: req.headers.get("user-agent") ?? null,
  };
}

export async function POST(
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
  const conexaoId = idParsed.data;

  // Depois de validar o id (id malformado não gasta orçamento) e antes de
  // reconectar de verdade: mesmo orçamento de `POST /conexoes`.
  if (!(await tentativaDeConexaoLiberada(authz.org.orgId, authz.user.id))) {
    return fail("rate_limited", t(MOTIVO_LIMITE_DE_CONEXAO), 429, { requestId });
  }

  const admin = createAdminClient();
  // Só para o audit da RECUSA (abaixo): `atualizarFerramentas` não devolve a
  // linha quando falha, e o apelido não pode vir do corpo (não existe corpo
  // nesta rota). Lido com a mesma função exportada que a listagem usa, sem
  // tocar `conexoes.ts`.
  const antesDeAtualizar = (await listarConexoes(admin, authz.org.orgId)).find((c) => c.id === conexaoId) ?? null;

  const resultado = await atualizarFerramentas(admin, authz.org.orgId, conexaoId);

  if (!resultado.ok) {
    // 404 (não encontrada), 409 (corrida perdida contra outra edição) e 422
    // (servidor recusou ou não respondeu): repassados com o motivo do
    // repositório, sem reescrever a frase. A tentativa RECUSADA também vai
    // para o audit — só apelido e status, nunca o motivo cru.
    void audit({
      action: "ai_mcp_connection.attempt_rejected",
      actorUserId: authz.user.id,
      organizationId: authz.org.orgId,
      resourceType: "ai_mcp_connection",
      resourceId: conexaoId,
      requestId,
      ...contextoDaRequisicao(req),
      metadata: { apelido: antesDeAtualizar?.apelido ?? null, status: resultado.status },
    });
    const codigo =
      resultado.status === 404 ? "not_found" : resultado.status === 409 ? "state_conflict" : "unprocessable_entity";
    return fail(codigo, t(resultado.motivo), resultado.status, { requestId });
  }

  void audit({
    action: "ai_mcp_connection.tools_refreshed",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "ai_mcp_connection",
    resourceId: conexaoId,
    requestId,
    ...contextoDaRequisicao(req),
    metadata: {
      apelido: resultado.conexao.apelido,
      ferramentas: resultado.conexao.ferramentas.length,
      tem_cabecalho: resultado.conexao.tem_cabecalho,
    },
  });

  return ok({ conexao: resultado.conexao }, { requestId });
}
