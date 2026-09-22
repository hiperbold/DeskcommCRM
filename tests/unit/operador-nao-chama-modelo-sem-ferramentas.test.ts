import { describe, expect, it } from "vitest";

import { mcpTemFerramentasParaOperador } from "@/lib/agent-engine/agent/operator-turn";

/**
 * (J) Mão MONTADA mas VAZIA é o mesmo que não ter ferramenta nenhuma: o
 * Operador só existe para agir, e chamar o modelo sem nada que ele possa
 * executar gasta a chave do self-hoster para descobrir de novo o que a
 * montagem já sabia (ex.: todas as externas marcadas ficaram
 * `aguardando_aprovacao` e nenhuma sobreviveu à montagem).
 */
describe("(J) o Operador não chama modelo quando a mão veio vazia", () => {
  it("mcp null: não roda", () => {
    expect(mcpTemFerramentasParaOperador(null)).toBe(false);
  });

  it("mcp montado com tools vazio (ex.: tudo aguardando_aprovacao): não roda", () => {
    expect(mcpTemFerramentasParaOperador({ tools: {} })).toBe(false);
  });

  it("mcp com pelo menos uma tool montada: roda", () => {
    expect(mcpTemFerramentasParaOperador({ tools: { crm_move_lead_stage: {} } })).toBe(true);
  });

  it("é um type guard: dentro do if, o TypeScript já sabe que mcp não é null", () => {
    const mcp: { tools: Record<string, unknown> } | null = { tools: { x: {} } };
    if (mcpTemFerramentasParaOperador(mcp)) {
      // Este acesso só compila se o predicado realmente estreitar o tipo —
      // é a garantia que permite `tools: mcp.tools` no call site sem `!`.
      expect(Object.keys(mcp.tools)).toEqual(["x"]);
    } else {
      throw new Error("deveria ter estreitado para o ramo verdadeiro");
    }
  });
});
