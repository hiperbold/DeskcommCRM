/** Uma ferramenta como ficou guardada em `ai_mcp_connections.tools_cache`. */
export interface FerramentaEmCache {
  /** Nome no servidor remoto (o que vai em `tools/call`). */
  nome: string;
  descricao: string;
  /** JSON Schema do servidor, cru. */
  input_schema: Record<string, unknown>;
  /** `annotations.readOnlyHint === true` no servidor. Decide o risco. */
  somente_leitura: boolean;
  /** `mcp_<apelido>__<nome>`, ou null quando o nome não pode virar ferramenta. */
  id: string | null;
  /** Por que não pode ser usada (nome inválido, id longo demais). */
  recusada: string | null;
}

/** O que a API devolve de uma conexão. Nunca o valor do cabeçalho. */
export interface ConexaoPublica {
  id: string;
  apelido: string;
  nome: string;
  url: string;
  tem_cabecalho: boolean;
  cabecalho_nome: string | null;
  ativa: boolean;
  ferramentas: FerramentaEmCache[];
  ferramentas_atualizadas_em: string | null;
  ultimo_erro: string | null;
}
