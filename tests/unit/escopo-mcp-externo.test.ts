/**
 * `validarEscopoDaVersao` para `tool_ids`/`operator_tool_ids` (Tarefa 8).
 *
 * Não havia teste dedicado do escopo antes desta tarefa: os existentes
 * (`rascunho-superado-nao-e-regravado.test.ts` e outros) sempre mockam
 * `@/lib/ai/agents/escopo` inteiro, então nunca exercitam a consulta real a
 * `ai_mcp_connections`.
 *
 * O dublê abaixo aplica os mesmos filtros do código real
 * (`organization_id`, `is_active`, `slug IN (...)`) sobre um estado fixo: um
 * `eq` ou `in` errado no `escopo.ts` faria "conexão de outra organização"
 * passar como se fosse desta, ou uma conexão desligada continuar contando.
 */
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { mensagemDoEscopo, validarEscopoDaVersao } from "@/lib/ai/agents/escopo";
import type { FerramentaEmCache } from "@/lib/ai/mcp-externo/tipos";

const ORG = "org-1";
const OUTRA_ORG = "org-2";

function ferramenta(apelido: string, nome: string): FerramentaEmCache {
  return {
    nome,
    descricao: "busca no CRM",
    input_schema: {},
    somente_leitura: true,
    id: `mcp_${apelido}__${nome}`,
    recusada: null,
  };
}

interface ConexaoSeed {
  organization_id: string;
  slug: string;
  is_active?: boolean;
  tools_cache?: FerramentaEmCache[];
}

/** Dublê mínimo de `ai_mcp_connections`: só o que `escopo.ts` consulta. */
function adminComConexoes(conexoes: ConexaoSeed[]): SupabaseClient {
  return {
    from(tabela: string) {
      if (tabela !== "ai_mcp_connections") {
        throw new Error(`escopo-mcp-externo.test.ts: consulta inesperada em "${tabela}"`);
      }
      const filtros: [string, unknown][] = [];
      const pertinencias: [string, unknown[]][] = [];
      const b = {
        select: () => b,
        eq: (c: string, v: unknown) => {
          filtros.push([c, v]);
          return b;
        },
        in: (c: string, vs: unknown[]) => {
          pertinencias.push([c, vs]);
          return b;
        },
        then: (res: (v: { data: unknown; error: null }) => unknown) => {
          const linhas = conexoes
            .filter((c) => filtros.every(([campo, v]) => (c as unknown as Record<string, unknown>)[campo] === v))
            .filter((c) =>
              pertinencias.every(([campo, vs]) => vs.includes((c as unknown as Record<string, unknown>)[campo])),
            )
            .map((c) => ({ slug: c.slug, tools_cache: c.tools_cache ?? [] }));
          return Promise.resolve({ data: linhas, error: null }).then(res);
        },
      };
      return b;
    },
  } as unknown as SupabaseClient;
}

describe("validarEscopoDaVersao — ferramenta de conexão MCP externa em tool_ids", () => {
  it("organização sem conexão ativa: id externo fica ausente", async () => {
    const admin = adminComConexoes([]);
    const r = await validarEscopoDaVersao(admin, ORG, { tool_ids: ["mcp_n8n__buscar"] });
    expect(r).toEqual({ ok: false, campo: "tool_ids", ausentes: ["mcp_n8n__buscar"] });
  });

  it("conexão ativa com a ferramenta em cache: passa", async () => {
    const admin = adminComConexoes([
      { organization_id: ORG, slug: "n8n", is_active: true, tools_cache: [ferramenta("n8n", "buscar")] },
    ]);
    const r = await validarEscopoDaVersao(admin, ORG, { tool_ids: ["mcp_n8n__buscar"] });
    expect(r).toEqual({ ok: true });
  });

  it("conexão DESATIVADA com a mesma ferramenta em cache: ausente (o filtro is_active tem de valer)", async () => {
    const admin = adminComConexoes([
      { organization_id: ORG, slug: "n8n", is_active: false, tools_cache: [ferramenta("n8n", "buscar")] },
    ]);
    const r = await validarEscopoDaVersao(admin, ORG, { tool_ids: ["mcp_n8n__buscar"] });
    expect(r).toEqual({ ok: false, campo: "tool_ids", ausentes: ["mcp_n8n__buscar"] });
  });

  it("conexão de OUTRA organização com o mesmo apelido: não conta", async () => {
    const admin = adminComConexoes([
      { organization_id: OUTRA_ORG, slug: "n8n", is_active: true, tools_cache: [ferramenta("n8n", "buscar")] },
    ]);
    const r = await validarEscopoDaVersao(admin, ORG, { tool_ids: ["mcp_n8n__buscar"] });
    expect(r).toEqual({ ok: false, campo: "tool_ids", ausentes: ["mcp_n8n__buscar"] });
  });

  it("mesmo caso em operator_tool_ids", async () => {
    const admin = adminComConexoes([]);
    const r = await validarEscopoDaVersao(admin, ORG, { operator_tool_ids: ["mcp_n8n__cadastrar_visita"] });
    expect(r).toEqual({ ok: false, campo: "operator_tool_ids", ausentes: ["mcp_n8n__cadastrar_visita"] });
  });

  it("operator_tool_ids com a conexão ativa e a ferramenta certa: passa", async () => {
    const admin = adminComConexoes([
      {
        organization_id: ORG,
        slug: "n8n",
        is_active: true,
        tools_cache: [ferramenta("n8n", "cadastrar_visita")],
      },
    ]);
    const r = await validarEscopoDaVersao(admin, ORG, { operator_tool_ids: ["mcp_n8n__cadastrar_visita"] });
    expect(r).toEqual({ ok: true });
  });

  it("id do catálogo não dispara consulta a ai_mcp_connections (só a FORMA já resolveu)", async () => {
    // O dublê lança se `from` for chamado com outra tabela — chamar
    // `ai_mcp_connections` aqui seria uma consulta que nada tem a responder.
    const admin = adminComConexoes([]);
    const r = await validarEscopoDaVersao(admin, ORG, { tool_ids: ["crm_list_tags"] });
    expect(r).toEqual({ ok: true });
  });

  it("array vazio ou ausente não consulta nada e passa", async () => {
    const admin = adminComConexoes([]);
    expect(await validarEscopoDaVersao(admin, ORG, {})).toEqual({ ok: true });
    expect(await validarEscopoDaVersao(admin, ORG, { tool_ids: [] })).toEqual({ ok: true });
  });

  it("mensagemDoEscopo para tool_ids cita Conexões MCP, não a frase de funil/material", () => {
    const msg = mensagemDoEscopo({ ok: false, campo: "tool_ids", ausentes: ["mcp_n8n__buscar"] });
    expect(msg).toMatch(/Conexões MCP/);
    expect(msg).not.toMatch(/funil|material/);
  });

  it("mensagemDoEscopo para operator_tool_ids usa a mesma frase de conexão MCP", () => {
    const msg = mensagemDoEscopo({ ok: false, campo: "operator_tool_ids", ausentes: ["mcp_n8n__x"] });
    expect(msg).toMatch(/Conexões MCP/);
  });
});
