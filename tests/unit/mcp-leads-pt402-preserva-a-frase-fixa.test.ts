import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F3, Tarefa 7 (pendência da sessão principal): o `ApiError(402)` que
 * `createLeadHandler`/`moveLeadHandler` levantam (PT402, mensagem fixa de
 * `recusaDoPlano`) tem de chegar ao CLIENTE MCP com a MESMA frase, nunca o
 * texto cru do Postgres nem um "unknown_error" genérico.
 *
 * Prova contra o wrapper REAL: `createMcpServer` (lib/mcp/server.ts) de
 * ponta a ponta por um transporte MCP de verdade (mesmo padrão de
 * `mcp-servidor-busca-vazia-nao-e-sucesso.test.ts`), com as tools REAIS
 * `crm_create_lead` e `crm_move_lead_stage` (lib/mcp/tools/leads.ts): só o
 * handler de banco (`createLeadHandler`/`moveLeadHandler`) é dublê.
 *
 * `err instanceof Error` é o que decide: `ApiError extends Error` e o
 * `message` dela já É a frase fixa (`recusaDoPlano`, nunca `insErr.message`),
 * então o `catch` de `server.ts` (`err.message`) preserva sem precisar de
 * nenhum tratamento extra. Este teste é a prova viva disso: vermelho se
 * algum dia um `catch` no meio do caminho trocar a mensagem por
 * `"unknown_error"` ou pelo texto do banco.
 */
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/mcp/audit", () => ({ auditMcpToolCall: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));

const handlers = vi.hoisted(() => ({
  createLeadHandler: vi.fn(),
  moveLeadHandler: vi.fn(),
}));
vi.mock("@/app/api/v1/leads/_handler", () => ({
  createLeadHandler: handlers.createLeadHandler,
  moveLeadHandler: handlers.moveLeadHandler,
  // As demais tools de leads (list/get/update) importam estes três também:
  // sem stub o módulo mockado devolveria `undefined` para eles e QUALQUER
  // outra tool de `allTools` que os referencie quebraria ao importar.
  listLeadsHandler: vi.fn(),
  getLeadHandler: vi.fn(),
  updateLeadHandler: vi.fn(),
}));

const { ApiError } = await import("@/lib/api/types");
const { STATUS_RECUSA_DO_PLANO } = await import("@/lib/billing/planos/recusa-do-plano");
const { crmCreateLead, crmMoveLeadStage } = await import("@/lib/mcp/tools/leads");
vi.mock("@/lib/mcp/tools", () => ({ allTools: [crmCreateLead, crmMoveLeadStage] }));

const { createMcpServer } = await import("@/lib/mcp/server");

const ORG = "00000000-0000-4000-8000-000000000001";
const FRASE_FIXA =
  "O plano desta organização chegou ao limite de leads. Fale com o suporte para ampliar.";

async function chamar(nome: string, args: Record<string, unknown>) {
  const server = createMcpServer(
    {
      organizationId: ORG,
      role: "manager",
      actor: { type: "user", id: "00000000-0000-4000-8000-000000000002" },
      apiTokenId: "tok",
      scopes: ["mcp:write"],
    },
    "req-1",
  );
  const [cliente, servidor] = InMemoryTransport.createLinkedPair();
  await server.connect(servidor);
  const client = new Client({ name: "teste", version: "0.0.0" });
  await client.connect(cliente);
  const resultado = await client.callTool({ name: nome, arguments: args });
  await client.close();
  return resultado as { isError?: boolean; content: Array<{ type: string; text: string }> };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("MCP crm_create_lead / crm_move_lead_stage: PT402 chega com a frase fixa", () => {
  it("crm_create_lead: ApiError(402) vira isError com a MESMA frase, nunca texto do Postgres", async () => {
    handlers.createLeadHandler.mockRejectedValue(
      new ApiError(STATUS_RECUSA_DO_PLANO, "plano_limite_atingido", undefined, "rid", FRASE_FIXA),
    );

    const resultado = await chamar("crm_create_lead", {
      pipeline_id: "10000000-0000-4000-8000-000000000001",
      stage_id: "10000000-0000-4000-8000-000000000002",
      title: "Negócio novo",
    });

    expect(resultado.isError).toBe(true);
    expect(resultado.content[0]?.text).toBe(FRASE_FIXA);
    // O texto cru que o Postgres devolveria (a CHECK/raise da migration 0907)
    // nunca deve vazar: é exatamente o que `recusaDoPlano` existe para evitar.
    expect(resultado.content[0]?.text).not.toMatch(/PT402|constraint|Postgres|relation/i);
  });

  it("crm_move_lead_stage: mesma preservação para a reabertura acima do teto", async () => {
    handlers.moveLeadHandler.mockRejectedValue(
      new ApiError(STATUS_RECUSA_DO_PLANO, "plano_limite_atingido", undefined, "rid", FRASE_FIXA),
    );

    const resultado = await chamar("crm_move_lead_stage", {
      lead_id: "10000000-0000-4000-8000-000000000003",
      to_stage_id: "10000000-0000-4000-8000-000000000004",
    });

    expect(resultado.isError).toBe(true);
    expect(resultado.content[0]?.text).toBe(FRASE_FIXA);
  });

  it("controle negativo: um erro comum (sem ApiError) continua chegando pela mesma via, sem mascarar a frase fixa dos outros dois", async () => {
    handlers.createLeadHandler.mockRejectedValue(new Error("falha qualquer"));

    const resultado = await chamar("crm_create_lead", {
      pipeline_id: "10000000-0000-4000-8000-000000000001",
      stage_id: "10000000-0000-4000-8000-000000000002",
      title: "Negócio novo",
    });

    expect(resultado.isError).toBe(true);
    expect(resultado.content[0]?.text).toBe("falha qualquer");
  });
});
