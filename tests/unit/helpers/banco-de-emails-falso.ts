/**
 * Um banco em memória só para os testes dos e-mails de conta e de cobrança: entende o pedaço do cliente
 * Supabase que `lib/email/conta-e-cobranca` usa (select com eq/is/order/limit/maybeSingle, upsert que ignora
 * duplicata, update, rpc do claim da fila) e a unicidade de `billing_emails_enviados` (organização, e-mail,
 * chave). É a borda do banco, não o código sob teste; a unicidade e o claim de verdade (`for update skip
 * locked`) são provados em Postgres por `tests/invariants/emails-de-conta-e-cobranca-banco.test.ts`.
 */
type Linha = Record<string, unknown>;

export interface UsuarioFalso {
  id: string;
  email: string | null;
  user_metadata?: Record<string, unknown>;
  /** Como no GoTrue: conta banida até esta data (ISO) e conta apagada (ISO). */
  banned_until?: string | null;
  deleted_at?: string | null;
  /**
   * Como no GoTrue: quando a pessoa confirmou o endereço. Sem a chave, o falso devolve um endereço confirmado
   * (o caso comum); `null` é endereço nunca confirmado.
   */
  email_confirmed_at?: string | null;
}

export interface BancoFalso {
  tabelas: Record<string, Linha[]>;
  usuarios: Record<string, UsuarioFalso>;
  /** Erro a devolver na próxima operação da tabela (para provar a falha do banco). */
  falhar: Record<string, { code: string; message: string } | undefined>;
  /** O relógio do banco (`now()` do claim). Os testes da fila o dividem com o código sob teste. */
  agora?: () => Date;
  /** Erro a devolver no claim da fila. */
  falharRpc?: { code: string; message: string };
}

export function criarBancoFalso(inicial: Partial<BancoFalso> = {}): BancoFalso {
  return {
    tabelas: { billing_emails_enviados: [], ...(inicial.tabelas ?? {}) },
    usuarios: inicial.usuarios ?? {},
    falhar: inicial.falhar ?? {},
    ...(inicial.agora ? { agora: inicial.agora } : {}),
  };
}

class Consulta implements PromiseLike<{ data: unknown; error: unknown }> {
  private filtros: Array<[string, "eq" | "is", unknown]> = [];
  private op: "select" | "upsert" | "update" = "select";
  private payload: Linha = {};
  private max = Infinity;

  constructor(
    private readonly banco: BancoFalso,
    private readonly tabela: string,
  ) {}

  select(): this {
    return this;
  }
  eq(coluna: string, valor: unknown): this {
    this.filtros.push([coluna, "eq", valor]);
    return this;
  }
  is(coluna: string, valor: unknown): this {
    this.filtros.push([coluna, "is", valor]);
    return this;
  }
  order(): this {
    return this;
  }
  limit(n: number): this {
    this.max = n;
    return this;
  }
  upsert(linha: Linha): this {
    this.op = "upsert";
    this.payload = linha;
    return this;
  }
  update(patch: Linha): this {
    this.op = "update";
    this.payload = patch;
    return this;
  }
  async maybeSingle() {
    const r = this.executar();
    return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error };
  }
  then<T1, T2>(
    ok?: ((v: { data: unknown; error: unknown }) => T1 | PromiseLike<T1>) | null,
    ruim?: ((r: unknown) => T2 | PromiseLike<T2>) | null,
  ): PromiseLike<T1 | T2> {
    return Promise.resolve(this.executar()).then(ok, ruim);
  }

  private casam(): Linha[] {
    const linhas = this.banco.tabelas[this.tabela] ?? [];
    return linhas.filter((l) =>
      this.filtros.every(([c, tipo, v]) => (tipo === "is" ? (l[c] ?? null) === v : l[c] === v)),
    );
  }

  private executar(): { data: unknown; error: unknown } {
    const erro = this.banco.falhar[this.tabela];
    if (erro) return { data: null, error: erro };
    if (this.op === "update") {
      for (const l of this.casam()) Object.assign(l, this.payload);
      return { data: null, error: null };
    }
    if (this.op === "upsert") {
      const lista = (this.banco.tabelas[this.tabela] ??= []);
      const igual = lista.find(
        (l) =>
          l.organization_id === this.payload.organization_id &&
          l.email_id === this.payload.email_id &&
          l.chave === this.payload.chave,
      );
      if (igual) return { data: [], error: null };
      const agora = (this.banco.agora ?? (() => new Date()))().toISOString();
      const nova = {
        id: `reserva-${lista.length + 1}`,
        resultado: {},
        status: "pendente",
        tentativas: 0,
        proxima_tentativa_em: agora,
        enviado_em: null,
        ultimo_erro: null,
        ...this.payload,
      };
      lista.push(nova);
      return { data: [{ id: nova.id }], error: null };
    }
    return { data: this.casam().slice(0, this.max), error: null };
  }
}

/** O claim `fn_billing_emails_reservar_lote` em memória (o de verdade é provado em Postgres). */
function reservarLote(banco: BancoFalso, args: Record<string, unknown>) {
  if (banco.falharRpc) return { data: null, error: banco.falharRpc };
  const agora = (banco.agora ?? (() => new Date()))();
  const limite = Number(args.p_limite ?? 20);
  const reservaMs = Number(args.p_reserva_segundos ?? 300) * 1000;
  const maximo = Number(args.p_max_tentativas ?? 6);
  const lista = banco.tabelas.billing_emails_enviados ?? [];
  const venceu = (l: Linha) => Date.parse(String(l.proxima_tentativa_em)) <= agora.getTime();

  for (const l of lista) {
    if (l.status === "enviando" && venceu(l) && Number(l.tentativas) >= maximo) {
      Object.assign(l, { status: "falhou", ultimo_erro: "esgotado", proxima_tentativa_em: agora.toISOString() });
    }
  }
  const pegas = lista
    .filter((l) => (l.status === "pendente" || l.status === "enviando") && venceu(l))
    .sort((a, b) => String(a.proxima_tentativa_em).localeCompare(String(b.proxima_tentativa_em)))
    .slice(0, limite);
  for (const l of pegas) {
    Object.assign(l, {
      status: "enviando",
      tentativas: Number(l.tentativas) + 1,
      proxima_tentativa_em: new Date(agora.getTime() + reservaMs).toISOString(),
    });
  }
  return { data: pegas.map((l) => ({ ...l })), error: null };
}

export function clienteFalso(banco: BancoFalso) {
  return {
    from: (tabela: string) => new Consulta(banco, tabela),
    rpc: async (nome: string, args: Record<string, unknown>) => {
      if (nome !== "fn_billing_emails_reservar_lote") throw new Error(`rpc inesperada: ${nome}`);
      return reservarLote(banco, args);
    },
    auth: {
      admin: {
        getUserById: async (id: string) => {
          const u = banco.usuarios[id];
          const user = u ? { ...u, email_confirmed_at: "email_confirmed_at" in u ? u.email_confirmed_at : "2026-01-01T00:00:00Z" } : null;
          return { data: { user }, error: null };
        },
      },
    },
  } as never;
}
