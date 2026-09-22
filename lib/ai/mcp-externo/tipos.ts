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
   * A decisão do admin sobre o risco desta ferramenta (Tarefa 11). Três
   * estados, e só um deles roda:
   *
   *   - `true`  — "Só consulta". Roda no turno real E no botão Testar.
   *   - `false` — "Altera dados". Roda só no turno real.
   *   - `null` (ou ausente) — "Aguardando aprovação". NÃO roda em lugar
   *     nenhum, nem no turno nem no Testar.
   *
   * Toda ferramenta nasce em `null`. Volta a `null` quando a descrição ou o
   * esquema mudam numa atualização (`combinarComConfirmacaoAnterior`, em
   * `lib/ai/mcp-externo/conexoes.ts`), porque a confirmação era sobre o texto
   * antigo — o admin nunca viu o texto novo.
   *
   * Opcional (e não obrigatório em todo literal) porque `cliente.ts`
   * (Tarefa 5) monta `FerramentaEmCache` fresca a partir do servidor e não
   * sabe de confirmação alguma; quem grava em `tools_cache`
   * (`lib/ai/mcp-externo/conexoes.ts`) é quem preenche o campo.
   */
  somente_leitura_confirmado?: boolean | null;
  /**
   * `true` quando esta ferramenta TINHA uma decisão (`true`/`false`) e a
   * perdeu numa atualização porque descrição ou esquema mudaram — é o que a
   * tela lê pra mostrar "mudou desde a última aprovação" (Tarefa 11, auditoria).
   *
   * Existe porque `somente_leitura_confirmado: null` sozinho não distingue
   * "nunca foi decidida" de "foi decidida e o servidor mudou por baixo": as
   * duas colapsam pro mesmo valor, e a tela não tem como avisar a segunda sem
   * este campo. `aprovarFerramenta` zera (`false`) quando o admin decide
   * `true`/`false` de novo; decidir `null` (desfazer) não mexe nele.
   */
  mudou_desde_aprovacao?: boolean;
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
  /**
   * `updated_at` da linha (auditoria M1, Tarefa 11): a tela reenvia este
   * valor em toda aprovação de ferramenta, pra `aprovarFerramenta` recusar
   * com 409 quando o que a tela mostrou não é mais o que está no banco —
   * "conectado" não é o único jeito de perder uma escrita concorrente, uma
   * aprovação também pode mirar num cache que já mudou debaixo do admin.
   */
  atualizada_em: string;
}
