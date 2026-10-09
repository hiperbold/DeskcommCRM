/**
 * Banco em memória com a semântica de filtro do PostgREST, para teste de código
 * que pagina, atualiza com condição e lê o que acabou de gravar.
 *
 * Um dublê que só devolve lista fixa não distingue "paginou direito" de "paginou
 * errado": o defeito do offset (D-141) só aparece quando o filtro enxerga o que o
 * laço acabou de alterar. Aqui as linhas são de verdade: `update` muda a linha,
 * `eq`/`neq`/`gt`/`in`/`is` filtram a linha atual, `order`/`limit`/`range` cortam.
 *
 * Cobre só o que os testes pedem; coluna JSON por seta (`a->>b`) lê o objeto.
 */

export type Linha = Record<string, unknown>;

type Filtro = (linha: Linha) => boolean;

function valorDa(linha: Linha, coluna: string): unknown {
  if (coluna.includes("->>")) {
    const [base, chave] = coluna.split("->>") as [string, string];
    const obj = linha[base];
    if (obj && typeof obj === "object") {
      const v = (obj as Record<string, unknown>)[chave];
      return v === undefined || v === null ? null : String(v);
    }
    return null;
  }
  return linha[coluna];
}

export interface ResultadoDoBanco<T = Linha[] | Linha | null> {
  data: T;
  error: { message: string; code?: string } | null;
  count?: number | null;
}

class Consulta implements PromiseLike<ResultadoDoBanco> {
  private filtros: Filtro[] = [];
  private modo: "select" | "update" | "insert" | "delete" = "select";
  private patch: Linha | null = null;
  private novas: Linha[] = [];
  private ordem: { coluna: string; asc: boolean } | null = null;
  private limite: number | null = null;
  private faixa: [number, number] | null = null;
  private retorna = false;
  private unica: "single" | "maybe" | null = null;

  constructor(
    private readonly tabela: Linha[],
    private readonly aoEscrever?: (modo: string, linhas: Linha[], patch?: Linha | null) => { message: string; code?: string } | null,
  ) {}

  select(_colunas?: string, _opts?: { count?: string; head?: boolean }): this {
    if (this.modo !== "select") this.retorna = true;
    return this;
  }
  update(patch: Linha): this {
    this.modo = "update";
    this.patch = patch;
    return this;
  }
  insert(linhas: Linha | Linha[]): this {
    this.modo = "insert";
    this.novas = Array.isArray(linhas) ? linhas : [linhas];
    return this;
  }
  /** Sem checar conflito: o teste que precisa de `onConflict` monta a unicidade por conta própria. */
  upsert(linhas: Linha | Linha[], _opts?: { onConflict?: string; ignoreDuplicates?: boolean }): this {
    return this.insert(linhas);
  }
  delete(): this {
    this.modo = "delete";
    return this;
  }
  eq(coluna: string, valor: unknown): this {
    this.filtros.push((l) => valorDa(l, coluna) === valor);
    return this;
  }
  neq(coluna: string, valor: unknown): this {
    // PostgREST: `neq` não casa NULL (NULL <> x é desconhecido).
    this.filtros.push((l) => {
      const v = valorDa(l, coluna);
      return v !== null && v !== undefined && v !== valor;
    });
    return this;
  }
  gt(coluna: string, valor: unknown): this {
    this.filtros.push((l) => {
      const v = valorDa(l, coluna);
      return v !== null && v !== undefined && (v as string | number) > (valor as string | number);
    });
    return this;
  }
  lt(coluna: string, valor: unknown): this {
    this.filtros.push((l) => {
      const v = valorDa(l, coluna);
      return v !== null && v !== undefined && (v as string | number) < (valor as string | number);
    });
    return this;
  }
  gte(coluna: string, valor: unknown): this {
    this.filtros.push((l) => {
      const v = valorDa(l, coluna);
      return v !== null && v !== undefined && (v as string | number) >= (valor as string | number);
    });
    return this;
  }
  in(coluna: string, valores: unknown[]): this {
    this.filtros.push((l) => valores.includes(valorDa(l, coluna)));
    return this;
  }
  is(coluna: string, valor: unknown): this {
    this.filtros.push((l) => (valor === null ? valorDa(l, coluna) == null : valorDa(l, coluna) === valor));
    return this;
  }
  /** Filtro composto não é interpretado: o teste que depende dele monta a fixture para não precisar. */
  or(_expressao: string): this {
    return this;
  }
  order(coluna: string, opts?: { ascending?: boolean }): this {
    this.ordem = { coluna, asc: opts?.ascending !== false };
    return this;
  }
  limit(n: number): this {
    this.limite = n;
    return this;
  }
  range(de: number, ate: number): this {
    this.faixa = [de, ate];
    return this;
  }
  maybeSingle(): this {
    this.unica = "maybe";
    return this;
  }
  single(): this {
    this.unica = "single";
    return this;
  }

  private executa(): ResultadoDoBanco {
    if (this.modo === "insert") {
      const erro = this.aoEscrever?.("insert", this.novas) ?? null;
      if (erro) return { data: null, error: erro };
      for (const l of this.novas) this.tabela.push({ ...l });
      return this.formata(this.retorna ? this.novas : []);
    }

    let linhas = this.tabela.filter((l) => this.filtros.every((f) => f(l)));
    if (this.ordem) {
      const { coluna, asc } = this.ordem;
      linhas = [...linhas].sort((a, b) => {
        const x = valorDa(a, coluna) as string | number;
        const y = valorDa(b, coluna) as string | number;
        return (x < y ? -1 : x > y ? 1 : 0) * (asc ? 1 : -1);
      });
    }
    if (this.faixa) linhas = linhas.slice(this.faixa[0], this.faixa[1] + 1);
    if (this.limite !== null) linhas = linhas.slice(0, this.limite);

    if (this.modo === "update") {
      const erro = this.aoEscrever?.("update", linhas, this.patch) ?? null;
      if (erro) return { data: null, error: erro };
      for (const l of linhas) Object.assign(l, this.patch);
      return this.formata(this.retorna ? linhas : []);
    }
    if (this.modo === "delete") {
      for (const l of linhas) this.tabela.splice(this.tabela.indexOf(l), 1);
      return this.formata(this.retorna ? linhas : []);
    }
    return this.formata(linhas);
  }

  private formata(linhas: Linha[]): ResultadoDoBanco {
    const copia = linhas.map((l) => ({ ...l }));
    if (this.unica) {
      if (copia.length > 1) return { data: null, error: { message: "mais de uma linha" } };
      if (copia.length === 0 && this.unica === "single") {
        return { data: null, error: { message: "nenhuma linha", code: "PGRST116" } };
      }
      return { data: copia[0] ?? null, error: null };
    }
    return { data: copia, error: null, count: copia.length };
  }

  then<R1 = ResultadoDoBanco, R2 = never>(
    ok?: ((v: ResultadoDoBanco) => R1 | PromiseLike<R1>) | null,
    ko?: ((r: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return Promise.resolve().then(() => this.executa()).then(ok, ko);
  }
}

export interface BancoEmMemoria {
  from(tabela: string): Consulta;
  rpc: (nome: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
  tabelas: Record<string, Linha[]>;
  chamadasRpc: Array<{ nome: string; args: Record<string, unknown> }>;
}

export interface OpcoesDoBanco {
  /** Resposta de cada RPC; devolver `{ error }` simula falha. */
  rpc?: Record<string, (args: Record<string, unknown>) => { data?: unknown; error?: { message: string } | null }>;
  /** Gancho de escrita por tabela: devolver erro faz a escrita falhar sem mudar nada. */
  aoEscrever?: Record<
    string,
    (modo: string, linhas: Linha[], patch?: Linha | null) => { message: string; code?: string } | null
  >;
}

export function criarBancoEmMemoria(
  tabelas: Record<string, Linha[]>,
  opcoes: OpcoesDoBanco = {},
): BancoEmMemoria {
  const chamadasRpc: BancoEmMemoria["chamadasRpc"] = [];
  return {
    tabelas,
    chamadasRpc,
    from(nome: string) {
      tabelas[nome] ??= [];
      return new Consulta(tabelas[nome]!, opcoes.aoEscrever?.[nome]);
    },
    rpc: async (nome, args) => {
      chamadasRpc.push({ nome, args });
      const r = opcoes.rpc?.[nome]?.(args) ?? { data: null, error: null };
      return { data: r.data ?? null, error: r.error ?? null };
    },
  };
}
