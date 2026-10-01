import { describe, expect, it, vi } from "vitest";

import { montarFerramentasDoTurno } from "@/lib/agent-engine/edge/crm/ferramentas-do-turno";

/**
 * D-134: o montador do turno entrega à montagem das ferramentas MCP externas o
 * contato e a conversa do turno, que a trava de argumentos recusa por valor.
 */

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

describe("montarFerramentasDoTurno", () => {
  it("passa contactId e conversationId à montagem externa", async () => {
    const externo = vi.fn().mockResolvedValue({
      tools: {},
      toolIds: [],
      puladas: [],
      externasDeConsulta: new Set<string>(),
      cleanup: async () => {},
    });
    await montarFerramentasDoTurno(
      { supabase: {} } as never,
      { organizationId: "org-1", jobId: "job-1", contactId: "contato-1", conversationId: "conversa-1" },
      { agentId: "ag-1", toolIds: ["mcp_loja__buscar"] } as never,
      log,
      undefined,
      { externo },
    );
    const opcoes = externo.mock.calls[0]![4] as { contexto: Record<string, unknown> };
    expect(opcoes.contexto).toMatchObject({
      agentId: "ag-1",
      jobId: "job-1",
      contactId: "contato-1",
      conversationId: "conversa-1",
    });
  });
});
