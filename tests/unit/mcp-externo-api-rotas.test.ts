/**
 * As quatro rotas de conexões MCP (Tarefa 7): autenticação, papel, o
 * `organizationId` vindo sempre da sessão, e os status 409/422 do
 * repositório repassados com o motivo (achados da auditoria da Tarefa 6).
 *
 * O repositório (`lib/ai/mcp-externo/conexoes.ts`) é mockado: o que se testa
 * aqui é a rota (auth, validação de borda, formato de resposta), não a regra
 * de negócio dele — essa já tem `mcp-externo-conexoes.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { loadAuthUser } from "@/lib/auth/server";
import {
  aprovarFerramenta,
  atualizarFerramentas,
  criarConexao,
  editarConexao,
  listarConexoes,
  removerConexao,
} from "@/lib/ai/mcp-externo/conexoes";
import type { ConexaoPublica } from "@/lib/ai/mcp-externo/tipos";
import type { AuthUser } from "@/lib/auth/types";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({ loadAuthUser: vi.fn(), resolveActiveOrg: vi.fn() }));
vi.mock("@/lib/ai/mcp-externo/conexoes", () => ({
  listarConexoes: vi.fn(),
  criarConexao: vi.fn(),
  editarConexao: vi.fn(),
  removerConexao: vi.fn(),
  atualizarFerramentas: vi.fn(),
  aprovarFerramenta: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
// O limite de tentativas de conexão (item novo da auditoria) tem teste PRÓPRIO
// e determinístico em `mcp-externo-api-limite-de-conexao.test.ts`. Aqui ele é
// mockado como "sempre liberado": sem isto, os testes deste arquivo chamariam
// o contador de verdade (Redis local, ou memória do processo) com a MESMA
// chave org+usuário em toda execução, e rodar a suíte mais de uma vez em menos
// de 10 minutos derrubaria testes de sucesso com 429 — flakiness pelo simples
// fato de reexecutar.
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, count: 1, limit: 10, window_sec: 600 }),
}));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const OUTRA_ORG_ID = "99999999-9999-4999-8999-999999999999";
const CONEXAO_ID = "33333333-3333-4333-8333-333333333333";

function sessao(role: "admin" | "manager" | "viewer"): void {
  // `vi.clearAllMocks()` (no `beforeEach`) limpa CHAMADAS, não a
  // IMPLEMENTAÇÃO: sem este reset, um teste anterior que chamou
  // `sessaoSuporteSomenteLeitura()` deixaria `loadAuthUser` preso no usuário
  // de suporte para todos os testes seguintes, e cada um deles veria 403 de
  // `requireSupportWrite()` antes mesmo de chegar em `requireRole`.
  vi.mocked(loadAuthUser).mockResolvedValue(undefined as unknown as AuthUser);
  const user = { id: "user-1", email: "u@example.com", idioma: "pt-BR" } as unknown as AuthUser;
  vi.mocked(requireRole).mockImplementation(async (min) => {
    const rank: Record<string, number> = { viewer: 1, agent: 2, ai_operator: 3, manager: 4, admin: 5 };
    if (rank[role]! < rank[min]!) {
      const { fail } = await import("@/lib/api/wrappers");
      return { ok: false, response: fail("forbidden_role", "Permissão insuficiente.", 403) };
    }
    return { ok: true, user, org: { orgId: ORG_ID, name: "Org", role } };
  });
}

function sessaoNaoAutenticada(): void {
  vi.mocked(loadAuthUser).mockResolvedValue(undefined as unknown as AuthUser);
  vi.mocked(requireRole).mockImplementation(async () => {
    const { fail } = await import("@/lib/api/wrappers");
    return { ok: false, response: fail("unauthenticated", "Auth required.", 401) };
  });
}

/**
 * O que `requireSupportWrite()` (`lib/impersonate/support.ts`) realmente lê:
 * `loadAuthUser().support`, e `supportWriteError` recusa quando
 * `access_mode !== "full"` — sem depender de `organizationId` (a rota chama
 * `requireSupportWrite()` sem argumento, então esse filtro nem entra). Simula
 * a PESSOA DE SUPORTE acompanhando em modo só leitura, não o dono da conta.
 */
function sessaoSuporteSomenteLeitura(): void {
  vi.mocked(loadAuthUser).mockResolvedValue({
    id: "suporte-1",
    email: "suporte@hiperbold.com.br",
    idioma: "pt-BR",
    support: {
      id: "acompanhamento-1",
      organization_id: ORG_ID,
      actor_user_id: "suporte-1",
      auth_session_id: "sessao-1",
      previous_organization_id: null,
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      name: "Acompanhamento",
      locale: "pt-BR",
      access_mode: "support_readonly",
      status: "active",
    },
  } as unknown as AuthUser);
}

const CONEXAO: ConexaoPublica = {
  id: CONEXAO_ID,
  apelido: "n8n",
  nome: "n8n de produção",
  url: "https://n8n.hiperbold.com.br",
  tem_cabecalho: true,
  cabecalho_nome: "Authorization",
  ativa: true,
  ferramentas: [],
  ferramentas_atualizadas_em: null,
  ultimo_erro: null,
  atualizada_em: "2026-01-01T00:00:00.000Z",
};

function reqJson(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── GET /api/v1/ai/mcp/conexoes ─────────────────────────────────────────

describe("GET /api/v1/ai/mcp/conexoes", () => {
  it("não autenticado dá 401", async () => {
    sessaoNaoAutenticada();
    const { GET } = await import("@/app/api/v1/ai/mcp/conexoes/route");
    const res = await GET();
    expect(res.status).toBe(401);
    expect(listarConexoes).not.toHaveBeenCalled();
  });

  it("manager (não admin) dá 403 — a listagem também é admin-only", async () => {
    sessao("manager");
    const { GET } = await import("@/app/api/v1/ai/mcp/conexoes/route");
    const res = await GET();
    expect(res.status).toBe(403);
    expect(listarConexoes).not.toHaveBeenCalled();
  });

  it("admin lista com sucesso, usando o organizationId da sessão", async () => {
    sessao("admin");
    vi.mocked(listarConexoes).mockResolvedValue([CONEXAO]);
    const { GET } = await import("@/app/api/v1/ai/mcp/conexoes/route");
    const res = await GET();
    expect(res.status).toBe(200);
    expect(listarConexoes).toHaveBeenCalledWith(expect.anything(), ORG_ID);
    const body = (await res.json()) as { data: { conexoes: ConexaoPublica[] } };
    expect(body.data.conexoes).toHaveLength(1);
  });
});

// ── POST /api/v1/ai/mcp/conexoes ────────────────────────────────────────

describe("POST /api/v1/ai/mcp/conexoes", () => {
  const corpoValido = {
    apelido: "n8n",
    nome: "n8n de produção",
    url: "https://n8n.hiperbold.com.br",
    cabecalho_nome: "Authorization",
    cabecalho_valor: "Bearer abc123",
    // Tentativa de forçar outra organização pelo corpo: tem que ser ignorada.
    organizationId: OUTRA_ORG_ID,
  };

  it("não autenticado dá 401", async () => {
    sessaoNaoAutenticada();
    const { POST } = await import("@/app/api/v1/ai/mcp/conexoes/route");
    const res = await POST(reqJson("http://localhost/api/v1/ai/mcp/conexoes", "POST", corpoValido));
    expect(res.status).toBe(401);
    expect(criarConexao).not.toHaveBeenCalled();
  });

  it("manager (não admin) dá 403", async () => {
    sessao("manager");
    const { POST } = await import("@/app/api/v1/ai/mcp/conexoes/route");
    const res = await POST(reqJson("http://localhost/api/v1/ai/mcp/conexoes", "POST", corpoValido));
    expect(res.status).toBe(403);
    expect(criarConexao).not.toHaveBeenCalled();
  });

  it("sessão de suporte somente leitura dá 403, antes de checar papel", async () => {
    sessaoSuporteSomenteLeitura();
    const { POST } = await import("@/app/api/v1/ai/mcp/conexoes/route");
    const res = await POST(reqJson("http://localhost/api/v1/ai/mcp/conexoes", "POST", corpoValido));
    expect(res.status).toBe(403);
    expect(criarConexao).not.toHaveBeenCalled();
  });

  it("admin cria com sucesso, e o organizationId do corpo é ignorado (usa o da sessão)", async () => {
    sessao("admin");
    vi.mocked(criarConexao).mockResolvedValue({ ok: true, conexao: CONEXAO });
    const { POST } = await import("@/app/api/v1/ai/mcp/conexoes/route");
    const res = await POST(reqJson("http://localhost/api/v1/ai/mcp/conexoes", "POST", corpoValido));
    expect(res.status).toBe(201);
    expect(criarConexao).toHaveBeenCalledWith(
      expect.anything(),
      ORG_ID, // não OUTRA_ORG_ID
      "user-1",
      {
        apelido: "n8n",
        nome: "n8n de produção",
        url: "https://n8n.hiperbold.com.br",
        cabecalho: { nome: "Authorization", valor: "Bearer abc123" },
      },
    );
  });

  it("http:// é recusado já na borda, sem chamar o repositório", async () => {
    sessao("admin");
    const { POST } = await import("@/app/api/v1/ai/mcp/conexoes/route");
    const res = await POST(
      reqJson("http://localhost/api/v1/ai/mcp/conexoes", "POST", { ...corpoValido, url: "http://n8n.hiperbold.com.br" }),
    );
    expect(res.status).toBe(422);
    expect(criarConexao).not.toHaveBeenCalled();
  });

  it("409 do repositório (apelido repetido) é repassado com o motivo, e a tentativa vai para o audit só com apelido e status", async () => {
    sessao("admin");
    vi.mocked(criarConexao).mockResolvedValue({
      ok: false,
      status: 409,
      motivo: "Já existe uma conexão com este apelido",
    });
    const { audit } = await import("@/lib/audit");
    const { POST } = await import("@/app/api/v1/ai/mcp/conexoes/route");
    const res = await POST(reqJson("http://localhost/api/v1/ai/mcp/conexoes", "POST", corpoValido));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("Já existe uma conexão com este apelido");
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ai_mcp_connection.attempt_rejected",
        metadata: { apelido: "n8n", status: 409 },
      }),
    );
    // Nunca o motivo cru do repositório no audit da recusa.
    const chamada = vi.mocked(audit).mock.calls.find((c) => c[0].action === "ai_mcp_connection.attempt_rejected");
    expect(chamada?.[0].metadata).not.toHaveProperty("motivo");
  });

  it("422 do repositório (ex.: servidor recusou a conexão) é repassado com o motivo", async () => {
    sessao("admin");
    vi.mocked(criarConexao).mockResolvedValue({
      ok: false,
      status: 422,
      motivo: "Não foi possível conectar ao servidor.",
    });
    const { POST } = await import("@/app/api/v1/ai/mcp/conexoes/route");
    const res = await POST(reqJson("http://localhost/api/v1/ai/mcp/conexoes", "POST", corpoValido));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("Não foi possível conectar ao servidor.");
  });
});

// ── PATCH /api/v1/ai/mcp/conexoes/[id] ──────────────────────────────────

describe("PATCH /api/v1/ai/mcp/conexoes/[id]", () => {
  const ctx = { params: Promise.resolve({ id: CONEXAO_ID }) };

  it("não autenticado dá 401", async () => {
    sessaoNaoAutenticada();
    const { PATCH } = await import("@/app/api/v1/ai/mcp/conexoes/[id]/route");
    const res = await PATCH(
      reqJson(`http://localhost/api/v1/ai/mcp/conexoes/${CONEXAO_ID}`, "PATCH", { ativa: false }),
      ctx,
    );
    expect(res.status).toBe(401);
    expect(editarConexao).not.toHaveBeenCalled();
  });

  it("manager (não admin) dá 403", async () => {
    sessao("manager");
    const { PATCH } = await import("@/app/api/v1/ai/mcp/conexoes/[id]/route");
    const res = await PATCH(
      reqJson(`http://localhost/api/v1/ai/mcp/conexoes/${CONEXAO_ID}`, "PATCH", { ativa: false }),
      ctx,
    );
    expect(res.status).toBe(403);
    expect(editarConexao).not.toHaveBeenCalled();
  });

  it("sessão de suporte somente leitura dá 403, antes de checar papel", async () => {
    sessaoSuporteSomenteLeitura();
    const { PATCH } = await import("@/app/api/v1/ai/mcp/conexoes/[id]/route");
    const res = await PATCH(
      reqJson(`http://localhost/api/v1/ai/mcp/conexoes/${CONEXAO_ID}`, "PATCH", { ativa: false }),
      ctx,
    );
    expect(res.status).toBe(403);
    expect(editarConexao).not.toHaveBeenCalled();
  });

  it("id que não é UUID dá 422, sem chamar o repositório", async () => {
    sessao("admin");
    const { PATCH } = await import("@/app/api/v1/ai/mcp/conexoes/[id]/route");
    const res = await PATCH(
      reqJson("http://localhost/api/v1/ai/mcp/conexoes/nao-e-um-uuid", "PATCH", { ativa: false }),
      { params: Promise.resolve({ id: "nao-e-um-uuid" }) },
    );
    expect(res.status).toBe(422);
    expect(editarConexao).not.toHaveBeenCalled();
  });

  it("admin edita com sucesso, usando o organizationId da sessão", async () => {
    sessao("admin");
    vi.mocked(editarConexao).mockResolvedValue({ ok: true, conexao: { ...CONEXAO, ativa: false } });
    const { PATCH } = await import("@/app/api/v1/ai/mcp/conexoes/[id]/route");
    const res = await PATCH(
      reqJson(`http://localhost/api/v1/ai/mcp/conexoes/${CONEXAO_ID}`, "PATCH", {
        ativa: false,
        organizationId: OUTRA_ORG_ID,
      }),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(editarConexao).toHaveBeenCalledWith(expect.anything(), ORG_ID, CONEXAO_ID, {
      nome: undefined,
      ativa: false,
      cabecalho: undefined,
    });
  });

  it("organizationId no corpo é ignorado mesmo apontando para uma org onde o autor também é admin", async () => {
    sessao("admin");
    vi.mocked(editarConexao).mockResolvedValue({ ok: true, conexao: CONEXAO });
    const { PATCH } = await import("@/app/api/v1/ai/mcp/conexoes/[id]/route");
    await PATCH(
      reqJson(`http://localhost/api/v1/ai/mcp/conexoes/${CONEXAO_ID}`, "PATCH", {
        nome: "Novo nome",
        organizationId: OUTRA_ORG_ID,
      }),
      ctx,
    );
    // A ÚNICA org que chega ao repositório é a da SESSÃO — nunca a do corpo.
    expect(editarConexao).toHaveBeenCalledWith(expect.anything(), ORG_ID, CONEXAO_ID, expect.anything());
    expect(editarConexao).not.toHaveBeenCalledWith(expect.anything(), OUTRA_ORG_ID, expect.anything(), expect.anything());
  });

  it("cabecalho_nome e cabecalho_valor null juntos limpam o cabeçalho", async () => {
    sessao("admin");
    vi.mocked(editarConexao).mockResolvedValue({ ok: true, conexao: CONEXAO });
    const { PATCH } = await import("@/app/api/v1/ai/mcp/conexoes/[id]/route");
    await PATCH(
      reqJson(`http://localhost/api/v1/ai/mcp/conexoes/${CONEXAO_ID}`, "PATCH", {
        cabecalho_nome: null,
        cabecalho_valor: null,
      }),
      ctx,
    );
    expect(editarConexao).toHaveBeenCalledWith(
      expect.anything(),
      ORG_ID,
      CONEXAO_ID,
      expect.objectContaining({ cabecalho: null }),
    );
  });

  it("404 do repositório é repassado com o motivo", async () => {
    sessao("admin");
    vi.mocked(editarConexao).mockResolvedValue({ ok: false, status: 404, motivo: "Conexão não encontrada" });
    const { PATCH } = await import("@/app/api/v1/ai/mcp/conexoes/[id]/route");
    const res = await PATCH(
      reqJson(`http://localhost/api/v1/ai/mcp/conexoes/${CONEXAO_ID}`, "PATCH", { ativa: false }),
      ctx,
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("Conexão não encontrada");
  });

  it("422 do repositório é repassado com o motivo", async () => {
    sessao("admin");
    vi.mocked(editarConexao).mockResolvedValue({
      ok: false,
      status: 422,
      motivo: "O nome precisa ter de 2 a 80 caracteres",
    });
    const { PATCH } = await import("@/app/api/v1/ai/mcp/conexoes/[id]/route");
    // "ab" passa pelo Zod da rota (min 2): o 422 testado aqui é o do
    // REPOSITÓRIO (mockado), não o da borda.
    const res = await PATCH(
      reqJson(`http://localhost/api/v1/ai/mcp/conexoes/${CONEXAO_ID}`, "PATCH", { nome: "ab" }),
      ctx,
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("O nome precisa ter de 2 a 80 caracteres");
  });
});

// ── DELETE /api/v1/ai/mcp/conexoes/[id] ─────────────────────────────────

describe("DELETE /api/v1/ai/mcp/conexoes/[id]", () => {
  const ctx = { params: Promise.resolve({ id: CONEXAO_ID }) };

  it("não autenticado dá 401", async () => {
    sessaoNaoAutenticada();
    const { DELETE } = await import("@/app/api/v1/ai/mcp/conexoes/[id]/route");
    const res = await DELETE(new NextRequest(`http://localhost/api/v1/ai/mcp/conexoes/${CONEXAO_ID}`, { method: "DELETE" }), ctx);
    expect(res.status).toBe(401);
    expect(removerConexao).not.toHaveBeenCalled();
  });

  it("manager (não admin) dá 403", async () => {
    sessao("manager");
    const { DELETE } = await import("@/app/api/v1/ai/mcp/conexoes/[id]/route");
    const res = await DELETE(new NextRequest(`http://localhost/api/v1/ai/mcp/conexoes/${CONEXAO_ID}`, { method: "DELETE" }), ctx);
    expect(res.status).toBe(403);
    expect(removerConexao).not.toHaveBeenCalled();
  });

  it("sessão de suporte somente leitura dá 403, antes de checar papel", async () => {
    sessaoSuporteSomenteLeitura();
    const { DELETE } = await import("@/app/api/v1/ai/mcp/conexoes/[id]/route");
    const res = await DELETE(new NextRequest(`http://localhost/api/v1/ai/mcp/conexoes/${CONEXAO_ID}`, { method: "DELETE" }), ctx);
    expect(res.status).toBe(403);
    expect(removerConexao).not.toHaveBeenCalled();
  });

  it("id que não é UUID dá 422, sem chamar o repositório", async () => {
    sessao("admin");
    const { DELETE } = await import("@/app/api/v1/ai/mcp/conexoes/[id]/route");
    const res = await DELETE(
      new NextRequest("http://localhost/api/v1/ai/mcp/conexoes/nao-e-um-uuid", { method: "DELETE" }),
      { params: Promise.resolve({ id: "nao-e-um-uuid" }) },
    );
    expect(res.status).toBe(422);
    expect(removerConexao).not.toHaveBeenCalled();
  });

  it("admin remove com sucesso, usando o organizationId da sessão", async () => {
    sessao("admin");
    vi.mocked(listarConexoes).mockResolvedValue([CONEXAO]);
    vi.mocked(removerConexao).mockResolvedValue({ ok: true });
    const { DELETE } = await import("@/app/api/v1/ai/mcp/conexoes/[id]/route");
    const res = await DELETE(new NextRequest(`http://localhost/api/v1/ai/mcp/conexoes/${CONEXAO_ID}`, { method: "DELETE" }), ctx);
    expect(res.status).toBe(200);
    expect(removerConexao).toHaveBeenCalledWith(expect.anything(), ORG_ID, CONEXAO_ID);
  });

  it("404 do repositório é repassado com o motivo", async () => {
    sessao("admin");
    vi.mocked(listarConexoes).mockResolvedValue([]);
    vi.mocked(removerConexao).mockResolvedValue({ ok: false, status: 404, motivo: "Conexão não encontrada" });
    const { DELETE } = await import("@/app/api/v1/ai/mcp/conexoes/[id]/route");
    const res = await DELETE(new NextRequest(`http://localhost/api/v1/ai/mcp/conexoes/${CONEXAO_ID}`, { method: "DELETE" }), ctx);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("Conexão não encontrada");
  });
});

// ── POST /api/v1/ai/mcp/conexoes/[id]/atualizar ─────────────────────────

describe("POST /api/v1/ai/mcp/conexoes/[id]/atualizar", () => {
  const ctx = { params: Promise.resolve({ id: CONEXAO_ID }) };

  it("não autenticado dá 401", async () => {
    sessaoNaoAutenticada();
    const { POST } = await import("@/app/api/v1/ai/mcp/conexoes/[id]/atualizar/route");
    const res = await POST(
      new NextRequest(`http://localhost/api/v1/ai/mcp/conexoes/${CONEXAO_ID}/atualizar`, { method: "POST" }),
      ctx,
    );
    expect(res.status).toBe(401);
    expect(atualizarFerramentas).not.toHaveBeenCalled();
  });

  it("manager (não admin) dá 403", async () => {
    sessao("manager");
    const { POST } = await import("@/app/api/v1/ai/mcp/conexoes/[id]/atualizar/route");
    const res = await POST(
      new NextRequest(`http://localhost/api/v1/ai/mcp/conexoes/${CONEXAO_ID}/atualizar`, { method: "POST" }),
      ctx,
    );
    expect(res.status).toBe(403);
    expect(atualizarFerramentas).not.toHaveBeenCalled();
  });

  it("sessão de suporte somente leitura dá 403, antes de checar papel", async () => {
    sessaoSuporteSomenteLeitura();
    const { POST } = await import("@/app/api/v1/ai/mcp/conexoes/[id]/atualizar/route");
    const res = await POST(
      new NextRequest(`http://localhost/api/v1/ai/mcp/conexoes/${CONEXAO_ID}/atualizar`, { method: "POST" }),
      ctx,
    );
    expect(res.status).toBe(403);
    expect(atualizarFerramentas).not.toHaveBeenCalled();
  });

  it("id que não é UUID dá 422, sem chamar o repositório", async () => {
    sessao("admin");
    const { POST } = await import("@/app/api/v1/ai/mcp/conexoes/[id]/atualizar/route");
    const res = await POST(
      new NextRequest("http://localhost/api/v1/ai/mcp/conexoes/nao-e-um-uuid/atualizar", { method: "POST" }),
      { params: Promise.resolve({ id: "nao-e-um-uuid" }) },
    );
    expect(res.status).toBe(422);
    expect(atualizarFerramentas).not.toHaveBeenCalled();
  });

  it("admin atualiza com sucesso, usando o organizationId da sessão", async () => {
    sessao("admin");
    vi.mocked(listarConexoes).mockResolvedValue([CONEXAO]);
    vi.mocked(atualizarFerramentas).mockResolvedValue({ ok: true, conexao: CONEXAO });
    const { POST } = await import("@/app/api/v1/ai/mcp/conexoes/[id]/atualizar/route");
    const res = await POST(
      new NextRequest(`http://localhost/api/v1/ai/mcp/conexoes/${CONEXAO_ID}/atualizar`, { method: "POST" }),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(atualizarFerramentas).toHaveBeenCalledWith(expect.anything(), ORG_ID, CONEXAO_ID);
  });

  it("409 do repositório (corrida perdida) é repassado com o motivo", async () => {
    sessao("admin");
    vi.mocked(listarConexoes).mockResolvedValue([CONEXAO]);
    vi.mocked(atualizarFerramentas).mockResolvedValue({
      ok: false,
      status: 409,
      motivo: "A conexão foi alterada por outra pessoa enquanto atualizava. Tente de novo.",
    });
    const { POST } = await import("@/app/api/v1/ai/mcp/conexoes/[id]/atualizar/route");
    const res = await POST(
      new NextRequest(`http://localhost/api/v1/ai/mcp/conexoes/${CONEXAO_ID}/atualizar`, { method: "POST" }),
      ctx,
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("A conexão foi alterada por outra pessoa enquanto atualizava. Tente de novo.");
  });

  it("422 do repositório (servidor recusou) é repassado com o motivo, e a tentativa vai para o audit só com apelido e status", async () => {
    sessao("admin");
    vi.mocked(listarConexoes).mockResolvedValue([CONEXAO]);
    vi.mocked(atualizarFerramentas).mockResolvedValue({
      ok: false,
      status: 422,
      motivo: "Não foi possível conectar ao servidor.",
    });
    const { audit } = await import("@/lib/audit");
    const { POST } = await import("@/app/api/v1/ai/mcp/conexoes/[id]/atualizar/route");
    const res = await POST(
      new NextRequest(`http://localhost/api/v1/ai/mcp/conexoes/${CONEXAO_ID}/atualizar`, { method: "POST" }),
      ctx,
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("Não foi possível conectar ao servidor.");
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ai_mcp_connection.attempt_rejected",
        metadata: { apelido: "n8n", status: 422 },
      }),
    );
  });
});

// ── GET /api/v1/ai/mcp/ferramentas ──────────────────────────────────────

const reqFerramentas = (url = "http://localhost/api/v1/ai/mcp/ferramentas"): NextRequest => new NextRequest(url);

describe("GET /api/v1/ai/mcp/ferramentas", () => {
  it("não autenticado dá 401", async () => {
    sessaoNaoAutenticada();
    const { GET } = await import("@/app/api/v1/ai/mcp/ferramentas/route");
    const res = await GET(reqFerramentas());
    expect(res.status).toBe(401);
  });

  it("viewer (abaixo de manager) dá 403", async () => {
    sessao("viewer");
    const { GET } = await import("@/app/api/v1/ai/mcp/ferramentas/route");
    const res = await GET(reqFerramentas());
    expect(res.status).toBe(403);
  });

  it("manager lista as ferramentas de conexões ativas, usando o organizationId da sessão", async () => {
    sessao("manager");
    vi.mocked(listarConexoes).mockResolvedValue([
      {
        ...CONEXAO,
        ferramentas: [
          {
            nome: "listar_leads",
            descricao: "Lista os leads",
            input_schema: {},
            somente_leitura: true,
            id: "mcp_n8n__listar_leads",
            recusada: null,
            somente_leitura_confirmado: true,
          },
          {
            // Sem id (nome remoto inválido): não pode virar capacidade.
            nome: "algo/invalido",
            descricao: "x",
            input_schema: {},
            somente_leitura: false,
            id: null,
            recusada: "nome inválido",
            somente_leitura_confirmado: null,
          },
        ],
      },
      { ...CONEXAO, id: "44444444-4444-4444-8444-444444444444", apelido: "off", ativa: false },
    ]);
    const { GET } = await import("@/app/api/v1/ai/mcp/ferramentas/route");
    const res = await GET(reqFerramentas());
    expect(res.status).toBe(200);
    expect(listarConexoes).toHaveBeenCalledWith(expect.anything(), ORG_ID);
    const body = (await res.json()) as { data: { tools: Array<Record<string, unknown>> } };
    // Só a ferramenta válida da conexão ATIVA entra: a recusada e a da conexão
    // desligada ficam de fora.
    expect(body.data.tools).toHaveLength(1);
    expect(body.data.tools[0]).toMatchObject({
      id: "mcp_n8n__listar_leads",
      category: "read",
      risco: "seguro",
      requires_scope: "mcp:read",
    });
  });

  it("ignora ?organizationId= na query e o cabeçalho x-organization-id: o org vem sempre da sessão", async () => {
    sessao("manager");
    vi.mocked(listarConexoes).mockResolvedValue([CONEXAO]);
    const { GET } = await import("@/app/api/v1/ai/mcp/ferramentas/route");
    const req = new NextRequest(`http://localhost/api/v1/ai/mcp/ferramentas?organizationId=${OUTRA_ORG_ID}`, {
      headers: { "x-organization-id": OUTRA_ORG_ID },
    });
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(listarConexoes).toHaveBeenCalledWith(expect.anything(), ORG_ID);
    expect(listarConexoes).not.toHaveBeenCalledWith(expect.anything(), OUTRA_ORG_ID);
  });

  it("corta a descrição em 500 caracteres (description e explicacao)", async () => {
    sessao("manager");
    const descricaoGigante = "x".repeat(2000);
    vi.mocked(listarConexoes).mockResolvedValue([
      {
        ...CONEXAO,
        ferramentas: [
          {
            nome: "ferramenta_grande",
            descricao: descricaoGigante,
            input_schema: {},
            somente_leitura: true,
            id: "mcp_n8n__ferramenta_grande",
            recusada: null,
            somente_leitura_confirmado: true,
          },
        ],
      },
    ]);
    const { GET } = await import("@/app/api/v1/ai/mcp/ferramentas/route");
    const res = await GET(reqFerramentas());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { tools: Array<{ description: string; explicacao: string }> } };
    expect(body.data.tools[0]?.description).toHaveLength(500);
    expect(body.data.tools[0]?.description).toBe("x".repeat(500));
    expect(body.data.tools[0]?.explicacao).toHaveLength(500);
  });
});

// ── PATCH /api/v1/ai/mcp/conexoes/[id]/ferramentas ─────────────────────

describe("PATCH /api/v1/ai/mcp/conexoes/[id]/ferramentas", () => {
  const ctx = { params: Promise.resolve({ id: CONEXAO_ID }) };
  const VERSAO = "2026-01-01T00:00:00.000Z";
  const corpoValido = { nome: "listar_leads", aprovacao: true, versao: VERSAO, organizationId: OUTRA_ORG_ID };

  it("não autenticado dá 401", async () => {
    sessaoNaoAutenticada();
    const { PATCH } = await import("@/app/api/v1/ai/mcp/conexoes/[id]/ferramentas/route");
    const res = await PATCH(
      reqJson(`http://localhost/api/v1/ai/mcp/conexoes/${CONEXAO_ID}/ferramentas`, "PATCH", corpoValido),
      ctx,
    );
    expect(res.status).toBe(401);
    expect(aprovarFerramenta).not.toHaveBeenCalled();
  });

  it("manager (não admin) dá 403", async () => {
    sessao("manager");
    const { PATCH } = await import("@/app/api/v1/ai/mcp/conexoes/[id]/ferramentas/route");
    const res = await PATCH(
      reqJson(`http://localhost/api/v1/ai/mcp/conexoes/${CONEXAO_ID}/ferramentas`, "PATCH", corpoValido),
      ctx,
    );
    expect(res.status).toBe(403);
    expect(aprovarFerramenta).not.toHaveBeenCalled();
  });

  it("sessão de suporte somente leitura dá 403, antes de checar papel", async () => {
    sessaoSuporteSomenteLeitura();
    const { PATCH } = await import("@/app/api/v1/ai/mcp/conexoes/[id]/ferramentas/route");
    const res = await PATCH(
      reqJson(`http://localhost/api/v1/ai/mcp/conexoes/${CONEXAO_ID}/ferramentas`, "PATCH", corpoValido),
      ctx,
    );
    expect(res.status).toBe(403);
    expect(aprovarFerramenta).not.toHaveBeenCalled();
  });

  it("id que não é UUID dá 422, sem chamar o repositório", async () => {
    sessao("admin");
    const { PATCH } = await import("@/app/api/v1/ai/mcp/conexoes/[id]/ferramentas/route");
    const res = await PATCH(
      reqJson("http://localhost/api/v1/ai/mcp/conexoes/nao-e-um-uuid/ferramentas", "PATCH", corpoValido),
      { params: Promise.resolve({ id: "nao-e-um-uuid" }) },
    );
    expect(res.status).toBe(422);
    expect(aprovarFerramenta).not.toHaveBeenCalled();
  });

  it("corpo sem 'nome' dá 422 (Zod), sem chamar o repositório", async () => {
    sessao("admin");
    const { PATCH } = await import("@/app/api/v1/ai/mcp/conexoes/[id]/ferramentas/route");
    const res = await PATCH(
      reqJson(`http://localhost/api/v1/ai/mcp/conexoes/${CONEXAO_ID}/ferramentas`, "PATCH", {
        aprovacao: true,
        versao: VERSAO,
      }),
      ctx,
    );
    expect(res.status).toBe(422);
    expect(aprovarFerramenta).not.toHaveBeenCalled();
  });

  it("corpo sem 'versao' dá 422 (Zod), sem chamar o repositório", async () => {
    sessao("admin");
    const { PATCH } = await import("@/app/api/v1/ai/mcp/conexoes/[id]/ferramentas/route");
    const res = await PATCH(
      reqJson(`http://localhost/api/v1/ai/mcp/conexoes/${CONEXAO_ID}/ferramentas`, "PATCH", {
        nome: "listar_leads",
        aprovacao: true,
      }),
      ctx,
    );
    expect(res.status).toBe(422);
    expect(aprovarFerramenta).not.toHaveBeenCalled();
  });

  it("admin aprova com sucesso (true), usando o organizationId da sessão — o do corpo é ignorado", async () => {
    sessao("admin");
    vi.mocked(aprovarFerramenta).mockResolvedValue({ ok: true, conexao: CONEXAO });
    const { PATCH } = await import("@/app/api/v1/ai/mcp/conexoes/[id]/ferramentas/route");
    const res = await PATCH(
      reqJson(`http://localhost/api/v1/ai/mcp/conexoes/${CONEXAO_ID}/ferramentas`, "PATCH", corpoValido),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(aprovarFerramenta).toHaveBeenCalledWith(
      expect.anything(),
      ORG_ID, // não OUTRA_ORG_ID, mesmo enviado no corpo
      CONEXAO_ID,
      "listar_leads",
      true,
      VERSAO,
    );
  });

  it("aceita aprovacao: false ('altera dados')", async () => {
    sessao("admin");
    vi.mocked(aprovarFerramenta).mockResolvedValue({ ok: true, conexao: CONEXAO });
    const { PATCH } = await import("@/app/api/v1/ai/mcp/conexoes/[id]/ferramentas/route");
    await PATCH(
      reqJson(`http://localhost/api/v1/ai/mcp/conexoes/${CONEXAO_ID}/ferramentas`, "PATCH", {
        nome: "listar_leads",
        aprovacao: false,
        versao: VERSAO,
      }),
      ctx,
    );
    expect(aprovarFerramenta).toHaveBeenCalledWith(
      expect.anything(),
      ORG_ID,
      CONEXAO_ID,
      "listar_leads",
      false,
      VERSAO,
    );
  });

  it("aceita aprovacao: null ('aguardando aprovação', desfaz uma decisão anterior)", async () => {
    sessao("admin");
    vi.mocked(aprovarFerramenta).mockResolvedValue({ ok: true, conexao: CONEXAO });
    const { PATCH } = await import("@/app/api/v1/ai/mcp/conexoes/[id]/ferramentas/route");
    await PATCH(
      reqJson(`http://localhost/api/v1/ai/mcp/conexoes/${CONEXAO_ID}/ferramentas`, "PATCH", {
        nome: "listar_leads",
        aprovacao: null,
        versao: VERSAO,
      }),
      ctx,
    );
    expect(aprovarFerramenta).toHaveBeenCalledWith(
      expect.anything(),
      ORG_ID,
      CONEXAO_ID,
      "listar_leads",
      null,
      VERSAO,
    );
  });

  it("404 do repositório é repassado com o motivo", async () => {
    sessao("admin");
    vi.mocked(aprovarFerramenta).mockResolvedValue({ ok: false, status: 404, motivo: "Conexão não encontrada" });
    const { PATCH } = await import("@/app/api/v1/ai/mcp/conexoes/[id]/ferramentas/route");
    const res = await PATCH(
      reqJson(`http://localhost/api/v1/ai/mcp/conexoes/${CONEXAO_ID}/ferramentas`, "PATCH", corpoValido),
      ctx,
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("Conexão não encontrada");
  });

  it("409 do repositório (corrida perdida) é repassado com o motivo", async () => {
    sessao("admin");
    vi.mocked(aprovarFerramenta).mockResolvedValue({
      ok: false,
      status: 409,
      motivo: "A conexão foi alterada por outra pessoa enquanto atualizava. Tente de novo.",
    });
    const { PATCH } = await import("@/app/api/v1/ai/mcp/conexoes/[id]/ferramentas/route");
    const res = await PATCH(
      reqJson(`http://localhost/api/v1/ai/mcp/conexoes/${CONEXAO_ID}/ferramentas`, "PATCH", corpoValido),
      ctx,
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("A conexão foi alterada por outra pessoa enquanto atualizava. Tente de novo.");
  });

  it("409 do repositório (versão desatualizada, M1) é repassado com o motivo", async () => {
    sessao("admin");
    vi.mocked(aprovarFerramenta).mockResolvedValue({
      ok: false,
      status: 409,
      motivo: "A lista de ferramentas mudou desde que você abriu a tela. Recarregue e aprove de novo.",
    });
    const { PATCH } = await import("@/app/api/v1/ai/mcp/conexoes/[id]/ferramentas/route");
    const res = await PATCH(
      reqJson(`http://localhost/api/v1/ai/mcp/conexoes/${CONEXAO_ID}/ferramentas`, "PATCH", corpoValido),
      ctx,
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("A lista de ferramentas mudou desde que você abriu a tela. Recarregue e aprove de novo.");
  });

  it("422 do repositório (ferramenta recusada ou inexistente) é repassado com o motivo", async () => {
    sessao("admin");
    vi.mocked(aprovarFerramenta).mockResolvedValue({
      ok: false,
      status: 422,
      motivo: "Esta ferramenta foi recusada e não pode ser aprovada",
    });
    const { PATCH } = await import("@/app/api/v1/ai/mcp/conexoes/[id]/ferramentas/route");
    const res = await PATCH(
      reqJson(`http://localhost/api/v1/ai/mcp/conexoes/${CONEXAO_ID}/ferramentas`, "PATCH", corpoValido),
      ctx,
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("Esta ferramenta foi recusada e não pode ser aprovada");
  });

  it("registra o audit com apelido, ferramenta e a decisão", async () => {
    sessao("admin");
    vi.mocked(aprovarFerramenta).mockResolvedValue({ ok: true, conexao: CONEXAO });
    const { audit } = await import("@/lib/audit");
    const { PATCH } = await import("@/app/api/v1/ai/mcp/conexoes/[id]/ferramentas/route");
    await PATCH(
      reqJson(`http://localhost/api/v1/ai/mcp/conexoes/${CONEXAO_ID}/ferramentas`, "PATCH", corpoValido),
      ctx,
    );
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ai_mcp_connection.tool_approval_updated",
        resourceId: CONEXAO_ID,
        metadata: { apelido: "n8n", ferramenta: "listar_leads", aprovacao: true },
      }),
    );
  });
});
