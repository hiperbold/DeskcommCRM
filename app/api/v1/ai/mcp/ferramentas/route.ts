/**
 * GET /api/v1/ai/mcp/ferramentas — as ferramentas de conexões MCP ATIVAS,
 * no MESMO formato de `/api/v1/mcp/tools` (o que o `ToolPicker` já entende),
 * para a seção "Conexões MCP" do seletor de capacidades do agente.
 *
 * Papel exigido: manager, não admin — é quem já edita agente e escolhe
 * capacidade (D12 do plano: "Ver e marcar no agente: manager"; "criar,
 * editar e remover conexão" é que fica em admin, porque expõe credencial).
 * Esta rota nunca devolve URL nem cabeçalho: `FerramentaEmCache` não os
 * carrega, e `ConexaoPublica.url` já vem mascarada por `paraPublica`.
 *
 * Só ferramenta com `id` válido (não `recusada`) de conexão `ativa` entra na
 * lista: o resto não pode virar capacidade (ver `lib/ai/mcp-externo/ids.ts`
 * e `tipos.ts`).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { listarConexoes } from "@/lib/ai/mcp-externo/conexoes";
import type { ConexaoPublica, FerramentaEmCache } from "@/lib/ai/mcp-externo/tipos";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** O que a ferramenta acabou classificada: confirmação do admin manda, sugestão do servidor é só o ponto de partida (achado da Tarefa 4-5). */
function ehSomenteLeitura(f: FerramentaEmCache): boolean {
  return f.somente_leitura_confirmado === true;
}

/**
 * O servidor de terceiro escreve `descricao`, não a organização: sem teto,
 * uma descrição gigante (de propósito ou não) infla toda resposta desta rota
 * e o prompt do agente que a consumir. 500 é generoso para uma frase de
 * ferramenta e curto para virar payload.
 */
const DESCRICAO_MAXIMA = 500;

function ferramentasDaConexao(conexao: ConexaoPublica) {
  return conexao.ferramentas
    .filter((f): f is FerramentaEmCache & { id: string } => f.id !== null && f.recusada === null)
    .map((f) => {
      const leitura = ehSomenteLeitura(f);
      const descricao = f.descricao.slice(0, DESCRICAO_MAXIMA);
      return {
        id: f.id,
        description: descricao,
        category: leitura ? "read" : "write",
        requires_role: "ai_operator",
        requires_scope: leitura ? "mcp:read" : "mcp:write",
        rotulo: f.nome,
        explicacao: descricao || `Ferramenta do servidor MCP ${conexao.nome}`,
        o_que_toca: conexao.nome,
        risco: leitura ? "seguro" : "critico",
        pacotes: [] as string[],
        conexao: { apelido: conexao.apelido, nome: conexao.nome },
        // Campo lido pelo ToolPicker (Tarefa 10) para mostrar os três estados de
        // aprovação. `risco`/`leitura` acima já colapsam `false` e `null` no
        // mesmo "crítico" (fail-closed: sem confirmação, trata como escrita);
        // este campo preserva a distinção entre "admin confirmou que altera
        // dados" e "ninguém decidiu ainda", que a tela precisa mostrar.
        somente_leitura_confirmado: f.somente_leitura_confirmado ?? null,
      };
    });
}

// O parâmetro existe só para deixar explícito, num teste, que a rota IGNORA
// `?organizationId=` na query e qualquer cabeçalho: o org vem sempre de
// `requireRole` (sessão). Não lido em lugar nenhum do corpo da função.
export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "ai_mcp_connections" });
  if (!authz.ok) return authz.response;

  const conexoes = await listarConexoes(createAdminClient(), authz.org.orgId);
  const tools = conexoes.filter((c) => c.ativa).flatMap(ferramentasDaConexao);

  return ok({ tools }, { requestId });
}
