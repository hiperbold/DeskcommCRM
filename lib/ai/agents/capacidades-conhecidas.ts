/**
 * Capacidade do catálogo (constante em código) OU ferramenta de uma conexão
 * MCP da organização (id `mcp_<apelido>__<nome>`). Aqui só a FORMA: se a
 * conexão existe e está ativa é conferido no servidor, em `escopo.ts`, porque
 * esta regra também roda no navegador (Zod compartilhado) e não consulta o banco.
 *
 * Existe num arquivo só porque QUATRO lugares precisam dela: o Zod da versão e
 * as conferências de publicar, publicar pela action e duplicar/reverter. Cada
 * uma comparava com `VALID_TOOL_IDS` à mão; uma que ficasse para trás recusaria
 * com `tool_id_invalid` o agente que a tela deixou salvar.
 */
import { ehFerramentaExterna } from "@/lib/ai/mcp-externo/ids";
import { VALID_TOOL_IDS } from "@/lib/mcp/tools/catalog";

const DO_CATALOGO = new Set<string>(VALID_TOOL_IDS as readonly string[]);

export function capacidadeConhecida(id: string): boolean {
  return DO_CATALOGO.has(id) || ehFerramentaExterna(id);
}

export function capacidadesDesconhecidas(ids: readonly string[]): string[] {
  return ids.filter((id) => !capacidadeConhecida(id));
}
