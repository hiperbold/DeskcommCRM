/**
 * Servidor MCP de verdade, em memória, reutilizado pelos testes do cliente MCP
 * (Tarefas 5, 6 e 9). Fica fora de `tests/unit/*.test.*` porque o vitest só
 * coleta arquivos `*.test.*`: um helper aqui não vira um arquivo de teste vazio.
 */
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { abrirSessao, type Sessao } from "@/lib/ai/mcp-externo/cliente";

export async function servidorDeTeste(): Promise<Sessao> {
  const server = new McpServer({ name: "imoveis-teste", version: "1.0.0" });
  server.registerTool(
    "buscar_imoveis",
    {
      description: "Busca imóveis por bairro",
      inputSchema: { bairro: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ bairro }) => ({ content: [{ type: "text", text: `3 imóveis em ${bairro}` }] }),
  );
  server.registerTool(
    "cadastrar_visita",
    { description: "Agenda visita", inputSchema: { imovel: z.string() } },
    async () => ({ content: [{ type: "text", text: "ok" }] }),
  );
  server.registerTool(
    "enorme",
    { description: "Resposta gigante", inputSchema: {} },
    async () => ({ content: [{ type: "text", text: "x".repeat(50_000) }] }),
  );
  server.registerTool(
    "demorada",
    { description: "Nunca responde a tempo", inputSchema: {} },
    () => new Promise(() => {}),
  );
  server.registerTool(
    "somente_estruturado",
    { description: "Só devolve dado estruturado, sem bloco de texto", inputSchema: {} },
    // `content` é opcional em runtime (a validação do zod tem `.default([])`),
    // mas o tipo do callback exige o campo; vazio aqui é o valor real.
    async () => ({ content: [], structuredContent: { bairro: "Centro", total: 3 } }),
  );
  // 300 campos: gera um JSON Schema (properties + required) bem acima do
  // teto de cache de esquema (8.192 caracteres), sem precisar de rede real.
  const camposDoEsquemaGigante = Object.fromEntries(
    Array.from({ length: 300 }, (_, i) => [`campo_${i}`, z.string()] as const),
  );
  server.registerTool(
    "schema_gigante",
    { description: "Esquema de entrada grande demais para o cache", inputSchema: camposDoEsquemaGigante },
    async () => ({ content: [{ type: "text", text: "ok" }] }),
  );
  const [lado, outro] = InMemoryTransport.createLinkedPair();
  await server.connect(outro);
  return abrirSessao({ transporte: lado });
}
