/**
 * O id de uma ferramenta vinda de um servidor MCP externo.
 *
 * É o NOME que o modelo vê, então obedece à regra dos provedores
 * (`^[a-zA-Z0-9_-]{1,64}$`, OpenAI e Anthropic). E é o valor que fica congelado
 * em `tool_ids` da versão publicada, então o apelido que o prefixa é imutável.
 *
 * Client-safe: sem zod, supabase ou next, o ToolPicker e o Zod compartilhado
 * com o navegador importam daqui.
 */
export const PREFIXO_EXTERNO = "mcp_";
export const TAMANHO_MAXIMO_DO_ID = 64;

const APELIDO = /^[a-z0-9]{2,12}$/;
const NOME_REMOTO = /^[a-zA-Z0-9_-]+$/;
const ID = /^mcp_([a-z0-9]{2,12})__([a-zA-Z0-9_-]+)$/;

export function apelidoValido(apelido: string): boolean {
  return APELIDO.test(apelido);
}

/** `null` quando o nome remoto não pode virar nome de ferramenta do modelo. */
export function montarIdDaFerramenta(apelido: string, nome: string): string | null {
  if (!APELIDO.test(apelido) || !NOME_REMOTO.test(nome)) return null;
  const id = `${PREFIXO_EXTERNO}${apelido}__${nome}`;
  return id.length <= TAMANHO_MAXIMO_DO_ID ? id : null;
}

export function lerIdDaFerramenta(id: string): { apelido: string; nome: string } | null {
  if (id.length > TAMANHO_MAXIMO_DO_ID) return null;
  const m = ID.exec(id);
  if (!m) return null;
  const apelido = m[1];
  const nome = m[2];
  if (apelido === undefined || nome === undefined) return null;
  return { apelido, nome };
}

export function ehFerramentaExterna(id: string): boolean {
  return lerIdDaFerramenta(id) !== null;
}

export function separarFerramentas(ids: readonly string[]): { catalogo: string[]; externas: string[] } {
  const catalogo: string[] = [];
  const externas: string[] = [];
  for (const id of ids) (ehFerramentaExterna(id) ? externas : catalogo).push(id);
  return { catalogo, externas };
}
