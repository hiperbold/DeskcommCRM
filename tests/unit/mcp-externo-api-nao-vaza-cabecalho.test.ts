/**
 * GET /api/v1/ai/mcp/conexoes e GET /api/v1/ai/mcp/ferramentas nunca devolvem
 * `auth_header_value_encrypted` nem o valor do cabeçalho de acesso — a URL sai
 * sempre mascarada (achado da auditoria da Tarefa 6: `paraPublica` já garante
 * isso, esta rota só não pode furar o contrato repassando outra coisa).
 *
 * O handler roda com `requireRole` e o repositório (`conexoes.ts`) mockados:
 * o que importa aqui é o formato da resposta HTTP, não a query em si (já
 * coberta em `mcp-externo-conexoes.test.ts`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { listarConexoes } from "@/lib/ai/mcp-externo/conexoes";
import type { ConexaoPublica } from "@/lib/ai/mcp-externo/tipos";
import type { AuthUser } from "@/lib/auth/types";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/ai/mcp-externo/conexoes", () => ({
  listarConexoes: vi.fn(),
  criarConexao: vi.fn(),
  editarConexao: vi.fn(),
  removerConexao: vi.fn(),
  atualizarFerramentas: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));

const ORG_ID = "22222222-2222-4222-8222-222222222222";

function sessaoAdmin(): void {
  const user = { id: "user-1", email: "u@example.com", idioma: "pt-BR" } as unknown as AuthUser;
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user,
    org: { orgId: ORG_ID, name: "Org", role: "admin" },
  });
}

const CONEXAO_COM_CABECALHO: ConexaoPublica = {
  id: "33333333-3333-4333-8333-333333333333",
  apelido: "n8n",
  nome: "n8n de produção",
  url: "https://n8n.hiperbold.com.br/…",
  tem_cabecalho: true,
  cabecalho_nome: "Authorization",
  ativa: true,
  ferramentas: [
    {
      nome: "listar_leads",
      descricao: "Lista os leads do funil",
      input_schema: { type: "object" },
      somente_leitura: true,
      id: "mcp_n8n__listar_leads",
      recusada: null,
      somente_leitura_confirmado: true,
    },
  ],
  ferramentas_atualizadas_em: "2026-09-21T12:00:00Z",
  ultimo_erro: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/v1/ai/mcp/conexoes — nunca vaza credencial", () => {
  it("a resposta não contém o valor do cabeçalho nem a URL completa", async () => {
    sessaoAdmin();
    vi.mocked(listarConexoes).mockResolvedValue([CONEXAO_COM_CABECALHO]);

    const { GET } = await import("@/app/api/v1/ai/mcp/conexoes/route");
    const res = await GET();
    expect(res.status).toBe(200);

    const corpoTexto = await res.text();
    // A checagem é textual, não só de campo: garante que nenhum caminho novo
    // (log, campo espelhado, erro) tenha colado o segredo em outro lugar.
    expect(corpoTexto).not.toContain("auth_header_value_encrypted");
    expect(corpoTexto).not.toMatch(/n8n\.hiperbold\.com\.br\/[a-z]/); // só a origem + "/…", nunca caminho real
    expect(corpoTexto).toContain("/…");

    const body = JSON.parse(corpoTexto) as { data: { conexoes: ConexaoPublica[] } };
    expect(body.data.conexoes[0]?.cabecalho_nome).toBe("Authorization");
    expect(body.data.conexoes[0]).not.toHaveProperty("auth_header_value_encrypted");
    expect(body.data.conexoes[0]).not.toHaveProperty("cabecalho_valor");
  });
});

describe("GET /api/v1/ai/mcp/ferramentas — nunca vaza credencial", () => {
  it("a resposta lista a ferramenta sem qualquer traço do cabeçalho ou da URL completa", async () => {
    sessaoAdmin();
    vi.mocked(listarConexoes).mockResolvedValue([CONEXAO_COM_CABECALHO]);

    const { GET } = await import("@/app/api/v1/ai/mcp/ferramentas/route");
    const res = await GET(new NextRequest("http://localhost/api/v1/ai/mcp/ferramentas"));
    expect(res.status).toBe(200);

    const corpoTexto = await res.text();
    expect(corpoTexto).not.toContain("Authorization");
    expect(corpoTexto).not.toContain("auth_header_value_encrypted");
    expect(corpoTexto).not.toMatch(/n8n\.hiperbold\.com\.br\/[a-z]/);

    const body = JSON.parse(corpoTexto) as {
      data: { tools: Array<{ id: string; conexao: { apelido: string; nome: string } }> };
    };
    expect(body.data.tools).toHaveLength(1);
    expect(body.data.tools[0]?.id).toBe("mcp_n8n__listar_leads");
    expect(body.data.tools[0]?.conexao).toEqual({ apelido: "n8n", nome: "n8n de produção" });
  });
});
