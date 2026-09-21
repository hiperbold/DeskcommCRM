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
  /**
   * Decisão do admin sobre o risco (Tarefa 11): `null` enquanto não decidiu,
   * e então vale a SUGESTÃO do servidor (`somente_leitura`) como "altera
   * dados" por padrão. Volta a `null` quando descrição ou esquema mudam numa
   * atualização, porque a confirmação era sobre o texto antigo.
   *
   * Opcional (e não obrigatório em todo literal) porque `cliente.ts`
   * (Tarefa 5) monta `FerramentaEmCache` fresca a partir do servidor e não
   * sabe de confirmação alguma; quem grava em `tools_cache`
   * (`lib/ai/mcp-externo/conexoes.ts`) é quem preenche o campo.
   */
  somente_leitura_confirmado?: boolean | null;
}

/** O que a API devolve de uma conexão. Nunca o valor do cabeçalho. */
export interface ConexaoPublica {
  id: string;
  apelido: string;
  nome: string;
  /**
   * MASCARADA (`mascararUrl` em `conexoes.ts`): só a origem, mais "/…" se
   * houver caminho ou busca. A URL completa fica só no banco e no que o
   * turno usa para chamar de verdade (`carregarParaOTurno`) — devolvê-la
   * inteira aqui exporia caminho ou parâmetro que também pode carregar
   * segredo (a URL não passa pela mesma cifra do cabeçalho).
   */
  url: string;
  tem_cabecalho: boolean;
  cabecalho_nome: string | null;
  ativa: boolean;
  ferramentas: FerramentaEmCache[];
  ferramentas_atualizadas_em: string | null;
  ultimo_erro: string | null;
}
