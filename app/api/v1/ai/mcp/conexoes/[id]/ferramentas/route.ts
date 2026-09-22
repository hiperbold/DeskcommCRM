import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * PATCH /api/v1/ai/mcp/conexoes/:id/ferramentas — grava a decisão do admin
 * sobre o risco de UMA ferramenta da conexão (Tarefa 11): `true` ("Só
 * consulta"), `false` ("Altera dados") ou `null` ("Aguardando aprovação",
 * desfaz uma decisão anterior).
 *
 * Papel exigido: admin (mesmo achado da listagem, Tarefa 6 — a conexão expõe
 * ferramenta e servidor de terceiro, e aprovar uma delas decide o que o
 * agente pode rodar sozinho). `organizationId` vem sempre de `requireRole`,
 * nunca do corpo.
 *
 * `versao` (obrigatório, auditoria da Tarefa 11 — M1) é o `atualizada_em` que
 * a TELA tinha quando o admin clicou: `aprovarFerramenta` recusa com 409
 * quando a linha já mudou desde então, pra nunca aprovar sobre um cache que o
 * admin nunca viu.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { aprovarFerramenta } from "@/lib/ai/mcp-externo/conexoes";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const idSchema = z.string().uuid();

const aprovarSchema = z.object({
  // Mesma faixa de `NOME_REMOTO` em `lib/ai/mcp-externo/ids.ts`: o nome como o
  // servidor MCP o declarou, não o id `mcp_<apelido>__<nome>` (que uma
  // ferramenta recusada nem sempre tem). SEM `.trim()` (achado da auditoria,
  // B2): este nome é comparado por igualdade estrita contra `tools_cache` em
  // `aprovarFerramenta` — normalizar aqui faria um espaço colado por acidente
  // aprovar (ou "não encontrar") uma ferramenta diferente da que o admin viu,
  // em silêncio.
  nome: z.string().min(1).max(200),
  aprovacao: z.boolean().nullable(),
  // `atualizada_em` que a tela tinha (M1): ver o cabeçalho do arquivo.
  versao: z.string().min(1),
});

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
  const conexaoId = idParsed.data;

  const parsed = aprovarSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Campos inválidos."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const input = parsed.data;

  const admin = createAdminClient();
  const resultado = await aprovarFerramenta(
    admin,
    authz.org.orgId,
    conexaoId,
    input.nome,
    input.aprovacao,
    input.versao,
  );

  if (!resultado.ok) {
    // 404 (conexão não encontrada), 409 (corrida perdida contra outra escrita
    // no mesmo cache, OU a versão que a tela tinha ficou velha) e 422
    // (ferramenta inexistente, duplicada ou recusada): repassados com o
    // motivo do repositório, sem reescrever a frase.
    const codigo =
      resultado.status === 404 ? "not_found" : resultado.status === 409 ? "state_conflict" : "unprocessable_entity";
    return fail(codigo, t(resultado.motivo), resultado.status, { requestId });
  }

  void audit({
    action: "ai_mcp_connection.tool_approval_updated",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "ai_mcp_connection",
    resourceId: conexaoId,
    requestId,
    ...contextoDaRequisicao(req),
    metadata: { apelido: resultado.conexao.apelido, ferramenta: input.nome, aprovacao: input.aprovacao },
  });

  return ok({ conexao: resultado.conexao }, { requestId });
}
