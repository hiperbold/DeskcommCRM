import { describe, expect, it } from "vitest";
import { versionCreateSchema as agentVersionInputSchema } from "@/lib/ai/agents/validation";
import { TETO_TOOLS_POR_AGENTE } from "@/lib/mcp/tools/selecao-por-pacote";
import { VALID_TOOL_IDS } from "@/lib/mcp/tools/catalog";

/**
 * A regra do Filipe: a ferramenta do MCP É uma capacidade do agente e CONTA no
 * teto. Não há contador novo: ela mora no mesmo array, e o `.max()` que já
 * existe é o que a recusa.
 */
const base = (ids: string[]) => ({ tool_ids: ids });

describe("ferramenta MCP externa como capacidade", () => {
  it("id externo bem formado é aceito", () => {
    const r = agentVersionInputSchema.pick({ tool_ids: true }).safeParse(base(["mcp_n8n__buscar_imoveis"]));
    expect(r.success).toBe(true);
  });

  it("id externo malformado continua recusado", () => {
    const r = agentVersionInputSchema.pick({ tool_ids: true }).safeParse(base(["mcp_N8N__x"]));
    expect(r.success).toBe(false);
  });

  it("24 do catálogo + 2 externas = 26, passa do teto e é recusado", () => {
    const catalogo = VALID_TOOL_IDS.slice(0, TETO_TOOLS_POR_AGENTE - 1);
    const r = agentVersionInputSchema
      .pick({ tool_ids: true })
      .safeParse(base([...catalogo, "mcp_n8n__a", "mcp_n8n__b"]));
    expect(r.success).toBe(false);
  });

  it("vale também para as capacidades do Operador", () => {
    const r = agentVersionInputSchema
      .pick({ operator_tool_ids: true })
      .safeParse({ operator_tool_ids: ["mcp_n8n__cadastrar_visita"] });
    expect(r.success).toBe(true);
  });
});
