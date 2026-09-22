import { describe, expect, it } from "vitest";

import { mensagensDePuladasParaAvisar } from "@/lib/agent-engine/agent/inbound-turn";

/**
 * (revisão 2 da Tarefa 9, item 1) Fora da prévia, TODA razão de pulada de
 * ferramenta MCP externa avisa a Central — não só `conexao_indisponivel`.
 * `entregue_ao_operador` é a única exceção: é o resultado ESPERADO da regra
 * de F, não uma falha.
 */
describe("mensagensDePuladasParaAvisar", () => {
  it("sem puladas: nenhuma mensagem", () => {
    expect(mensagensDePuladasParaAvisar([])).toEqual([]);
  });

  it("conexao_indisponivel: mantém a frase com os ids (a que já existia)", () => {
    const msgs = mensagensDePuladasParaAvisar([
      { id: "mcp_n8n__buscar", motivo: "conexao_indisponivel" },
      { id: "mcp_n8n__cadastrar", motivo: "conexao_indisponivel" },
    ]);
    expect(msgs).toEqual(["conexão MCP indisponível: mcp_n8n__buscar, mcp_n8n__cadastrar"]);
  });

  it("aguardando_aprovacao: frase fixa mandando para Conexões MCP", () => {
    const msgs = mensagensDePuladasParaAvisar([{ id: "mcp_n8n__x", motivo: "aguardando_aprovacao" }]);
    expect(msgs).toEqual([
      "Há ferramentas de conexão MCP marcadas no agente aguardando aprovação do admin em IA › Conexões MCP. Elas não rodam até serem aprovadas.",
    ]);
  });

  it("recusada: frase fixa de esquema grande ou inválido", () => {
    const msgs = mensagensDePuladasParaAvisar([{ id: "mcp_n8n__x", motivo: "recusada" }]);
    expect(msgs).toEqual([
      "Uma ferramenta de conexão MCP marcada no agente foi recusada (esquema grande ou inválido) e não roda.",
    ]);
  });

  it("esquema_invalido: MESMA frase de recusada — as duas são 'nunca vai funcionar assim'", () => {
    const msgs = mensagensDePuladasParaAvisar([{ id: "mcp_n8n__x", motivo: "esquema_invalido" }]);
    expect(msgs).toEqual([
      "Uma ferramenta de conexão MCP marcada no agente foi recusada (esquema grande ou inválido) e não roda.",
    ]);
  });

  it("recusada + esquema_invalido juntas: a frase compartilhada aparece UMA vez só", () => {
    const msgs = mensagensDePuladasParaAvisar([
      { id: "mcp_n8n__a", motivo: "recusada" },
      { id: "mcp_n8n__b", motivo: "esquema_invalido" },
    ]);
    expect(msgs).toEqual([
      "Uma ferramenta de conexão MCP marcada no agente foi recusada (esquema grande ou inválido) e não roda.",
    ]);
  });

  it("entregue_ao_operador NUNCA avisa — é o esperado de F, não uma falha", () => {
    expect(mensagensDePuladasParaAvisar([{ id: "mcp_n8n__x", motivo: "entregue_ao_operador" }])).toEqual([]);
  });

  it("so_leitura_na_previa (só existe em prévia) também não gera mensagem — este helper só é chamado fora da prévia, mas ele mesmo não precisa saber disso", () => {
    expect(mensagensDePuladasParaAvisar([{ id: "mcp_n8n__x", motivo: "so_leitura_na_previa" }])).toEqual([]);
  });

  it("todos os motivos avisáveis juntos: três mensagens, uma por grupo, entregue_ao_operador fica de fora", () => {
    const msgs = mensagensDePuladasParaAvisar([
      { id: "a", motivo: "conexao_indisponivel" },
      { id: "b", motivo: "aguardando_aprovacao" },
      { id: "c", motivo: "recusada" },
      { id: "d", motivo: "entregue_ao_operador" },
    ]);
    expect(msgs).toHaveLength(3);
    expect(msgs.some((m) => m.includes("Conexões MCP"))).toBe(true);
    expect(msgs.some((m) => m.includes("recusada"))).toBe(true);
    expect(msgs.some((m) => m.startsWith("conexão MCP indisponível"))).toBe(true);
  });
});
