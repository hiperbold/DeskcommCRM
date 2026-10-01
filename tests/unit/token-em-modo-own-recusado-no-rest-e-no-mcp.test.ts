/**
 * D-148: o encaixe do portão de visibilidade ("só os meus") nos dois caminhos do
 * token: as rotas REST duais (`resolveAuthDual` com `comDono`) e o servidor MCP
 * (`createMcpServer`). O portão em si tem suíte em
 * tests/unit/visibilidade-do-token-modo-own.test.ts.
 *
 * Prova: com a empresa em modo `own`, a chave de papel agent leva 403 na rota
 * marcada e na ferramenta com dono, e a mesma chave segue operando a ferramenta
 * sem dono e as rotas não marcadas; gerente passa em tudo.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const estado = vi.hoisted(() => ({
  modo: "own" as string | undefined,
  chamadas: [] as string[],
}));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({})) }));
vi.mock("@/lib/mcp/audit", () => ({ auditMcpToolCall: vi.fn(async () => undefined) }));
vi.mock("@/lib/mcp/rate-limit", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mcp/rate-limit")>(
    "@/lib/mcp/rate-limit",
  );
  return { ...actual, verificarTetoMcp: vi.fn(async () => undefined) };
});
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    const c: Record<string, unknown> = {};
    for (const m of ["select", "eq"]) c[m] = () => c;
    c.maybeSingle = async () => ({
      data: { settings: estado.modo ? { visibility_mode: estado.modo } : {} },
      error: null,
    });
    return { from: () => c };
  },
}));
vi.mock("@/lib/mcp/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mcp/auth")>("@/lib/mcp/auth");
  return { ...actual, validateBearerToken: vi.fn() };
});
vi.mock("@/lib/mcp/tools", () => ({
  allTools: [
    {
      name: "crm_list_leads",
      description: "com dono",
      inputSchema: { q: z.string().optional() },
      requiresRole: "agent",
      requiresScope: "mcp:read",
      handler: async () => {
        estado.chamadas.push("crm_list_leads");
        return { leads: [] };
      },
    },
    {
      name: "crm_list_event_types",
      description: "sem dono",
      inputSchema: {},
      requiresRole: "agent",
      requiresScope: "mcp:read",
      handler: async () => {
        estado.chamadas.push("crm_list_event_types");
        return { tipos: [] };
      },
    },
  ],
}));

const { validateBearerToken } = await import("@/lib/mcp/auth");
const { resolveAuthDual } = await import("@/lib/api/auth-dual");
const { createMcpServer } = await import("@/lib/mcp/server");

const ORG = "22222222-2222-4222-8222-222222222222";

function tokenDeRole(role: string) {
  vi.mocked(validateBearerToken).mockResolvedValue({
    organizationId: ORG,
    scopes: ["mcp:read", "mcp:write"],
    role,
    actor: { type: "api_token", id: "tok-1", role },
    apiTokenId: "tok-1",
  } as never);
}

const req = () =>
  new NextRequest("http://localhost/api/v1/leads/x", {
    method: "PATCH",
    headers: { authorization: "Bearer dsk_abc" },
  });
const OPCOES = { requestId: "r1", resource: "crm_leads", role: "agent" as const, scope: "mcp:write" };

beforeEach(() => {
  vi.clearAllMocks();
  estado.modo = "own";
  estado.chamadas = [];
});

describe("D-148 rotas duais: comDono", () => {
  it("modo own: token agent na rota marcada leva 403", async () => {
    tokenDeRole("agent");
    const r = await resolveAuthDual(req(), { ...OPCOES, comDono: true });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.response.status).toBe(403);
  });

  it("modo own: rota não marcada segue aceitando o token agent", async () => {
    tokenDeRole("agent");
    const r = await resolveAuthDual(req(), OPCOES);
    expect(r.ok).toBe(true);
  });

  it("modo own: token manager passa na rota marcada", async () => {
    tokenDeRole("manager");
    const r = await resolveAuthDual(req(), { ...OPCOES, comDono: true });
    expect(r.ok).toBe(true);
  });

  it("modo padrão: token agent passa na rota marcada (não quebra integração)", async () => {
    estado.modo = "own_and_unassigned";
    tokenDeRole("agent");
    const r = await resolveAuthDual(req(), { ...OPCOES, comDono: true });
    expect(r.ok).toBe(true);
  });
});

async function chamarTool(role: "agent" | "manager", nome: string) {
  const server = createMcpServer(
    {
      organizationId: ORG,
      role,
      actor: { type: "api_token", id: "tok-1", role },
      apiTokenId: "tok-1",
      scopes: ["mcp:read"],
    },
    "req-1",
  );
  const [cliente, servidor] = InMemoryTransport.createLinkedPair();
  await server.connect(servidor);
  const client = new Client({ name: "teste", version: "0.0.0" });
  await client.connect(cliente);
  const res = await client.callTool({ name: nome, arguments: {} });
  await client.close();
  return res as { isError?: boolean; content: Array<{ text: string }> };
}

describe("D-148 servidor MCP", () => {
  it("modo own: ferramenta com dono recusa o token agent e não executa o handler", async () => {
    const res = await chamarTool("agent", "crm_list_leads");
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toMatch(/role:manager/);
    expect(estado.chamadas).toEqual([]);
  });

  it("modo own: ferramenta sem dono segue funcionando para o token agent", async () => {
    const res = await chamarTool("agent", "crm_list_event_types");
    expect(res.isError).toBeFalsy();
    expect(estado.chamadas).toEqual(["crm_list_event_types"]);
  });

  it("modo own: token manager executa a ferramenta com dono", async () => {
    const res = await chamarTool("manager", "crm_list_leads");
    expect(res.isError).toBeFalsy();
    expect(estado.chamadas).toEqual(["crm_list_leads"]);
  });

  it("modo padrão: token agent executa a ferramenta com dono", async () => {
    estado.modo = undefined;
    const res = await chamarTool("agent", "crm_list_leads");
    expect(res.isError).toBeFalsy();
  });
});
