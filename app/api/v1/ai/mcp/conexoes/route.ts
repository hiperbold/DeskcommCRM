import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  /api/v1/ai/mcp/conexoes — lista as conexões MCP externas da organização.
 * POST /api/v1/ai/mcp/conexoes — VALIDA o servidor (conecta e lista ferramentas
 *                                 de verdade) e SÓ ENTÃO grava.
 *
 * Papel exigido: admin nas DUAS rotas, listagem inclusive (achado da auditoria
 * da Tarefa 6). A conexão expõe endereço, nome das ferramentas do servidor de
 * terceiro e se há credencial configurada — não é dado de quem só edita agente.
 *
 * `organizationId` vem SEMPRE de `requireRole` (sessão), nunca do corpo.
 *
 * A URL e o cabeçalho nunca saem daqui: `paraPublica` (em `conexoes.ts`) já
 * devolve a URL mascarada e nunca o valor do cabeçalho, e é o que esta rota
 * repassa sem tocar.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { criarConexao, listarConexoes } from "@/lib/ai/mcp-externo/conexoes";
// O orçamento de tentativas mora fora da rota (partilhado com
// `[id]/atualizar/route.ts`): um `route.ts` só pode exportar handler HTTP e
// config de rota, e `next build` recusa qualquer outro export nomeado — ver
// o cabeçalho de `limite-de-conexao.ts`.
import { MOTIVO_LIMITE_DE_CONEXAO, tentativaDeConexaoLiberada } from "@/lib/ai/mcp-externo/limite-de-conexao";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CABECALHO_NOME_REGEX = /^[A-Za-z0-9-]{1,64}$/;

const criarSchema = z
  .object({
    apelido: z.string().trim().min(2).max(12),
    nome: z.string().trim().min(2).max(80),
    // O `https://` é checado já na borda, antes de qualquer tentativa de
    // conexão: `criarConexao` confere de novo (URL_HTTPS na migration), mas um
    // `http://` colado não pode nem chegar perto de abrir sessão com o servidor.
    url: z.string().trim().min(1).max(500),
    cabecalho_nome: z.string().regex(CABECALHO_NOME_REGEX).optional(),
    cabecalho_valor: z.string().min(1).max(2000).optional(),
  })
  .refine((v) => (v.cabecalho_nome === undefined) === (v.cabecalho_valor === undefined), {
    message: "Informe nome e valor do cabeçalho juntos, ou nenhum dos dois.",
    path: ["cabecalho_nome"],
  })
  .refine((v) => v.url.startsWith("https://"), {
    message: "O endereço do servidor precisa começar com https://.",
    path: ["url"],
  });

function contextoDaRequisicao(req: NextRequest) {
  return {
    ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    userAgent: req.headers.get("user-agent") ?? null,
  };
}

/**
 * O que vai para `metadata` do audit: nunca a URL nem o cabeçalho, só o
 * suficiente para reconstruir "quem mudou o quê" no painel (passo 2 da
 * Tarefa 7).
 */
function metadataDaConexao(c: { apelido: string; ferramentas: unknown[]; tem_cabecalho: boolean }) {
  return { apelido: c.apelido, ferramentas: c.ferramentas.length, tem_cabecalho: c.tem_cabecalho };
}

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "ai_mcp_connections" });
  if (!authz.ok) return authz.response;

  const conexoes = await listarConexoes(createAdminClient(), authz.org.orgId);
  return ok({ conexoes }, { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "ai_mcp_connections" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const parsed = criarSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Campos inválidos."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const input = parsed.data;
  const cabecalho =
    input.cabecalho_nome !== undefined && input.cabecalho_valor !== undefined
      ? { nome: input.cabecalho_nome, valor: input.cabecalho_valor }
      : null;

  // Depois do Zod (corpo malformado não gasta orçamento) e antes de tocar o
  // repositório: é AQUI que uma tentativa de conexão de verdade começaria.
  if (!(await tentativaDeConexaoLiberada(authz.org.orgId, authz.user.id))) {
    return fail("rate_limited", t(MOTIVO_LIMITE_DE_CONEXAO), 429, { requestId });
  }

  const admin = createAdminClient();
  const resultado = await criarConexao(admin, authz.org.orgId, authz.user.id, {
    apelido: input.apelido,
    nome: input.nome,
    url: input.url,
    cabecalho,
  });

  if (!resultado.ok) {
    // 409 (apelido repetido) e 422 (validação do repositório): repassados com
    // o motivo do repositório, sem reescrever a frase. A tentativa RECUSADA
    // também vai para o audit — só apelido e status, nunca o motivo cru (que
    // pode ecoar o que o servidor de terceiro respondeu).
    void audit({
      action: "ai_mcp_connection.attempt_rejected",
      actorUserId: authz.user.id,
      organizationId: authz.org.orgId,
      resourceType: "ai_mcp_connection",
      resourceId: null,
      requestId,
      ...contextoDaRequisicao(req),
      metadata: { apelido: input.apelido, status: resultado.status },
    });
    return fail(
      resultado.status === 409 ? "state_conflict" : "unprocessable_entity",
      t(resultado.motivo),
      resultado.status,
      { requestId },
    );
  }

  void audit({
    action: "ai_mcp_connection.created",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "ai_mcp_connection",
    resourceId: resultado.conexao.id,
    requestId,
    ...contextoDaRequisicao(req),
    metadata: metadataDaConexao(resultado.conexao),
  });

  return ok({ conexao: resultado.conexao }, { status: 201, requestId });
}
