import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * D-146: a IA que conversa com UM cliente não lê, no banco externo da loja, o
 * dado de outro cliente. A cadeia testada é a do turno: contexto com o contato
 * do turno (`escopoDoTurno`) -> handler de `crm_query_external_data` -> o que
 * chega (ou não) ao banco externo.
 */

vi.mock("@/lib/external-db/acesso", () => ({ abrirAcesso: vi.fn() }));
vi.mock("@/lib/external-db/introspeccao", () => ({
  listarTabelas: vi.fn(),
  colunasDaTabela: vi.fn(),
}));
vi.mock("@/lib/external-db/leitura", async () => {
  const real = (await vi.importActual("@/lib/external-db/leitura")) as Record<string, unknown>;
  return { ...real, lerTabela: vi.fn() };
});

import { abrirAcesso } from "@/lib/external-db/acesso";
import {
  avaliarConsultaDoTurno,
  mesmoTelefone,
  tabelaTemDadoDePessoa,
} from "@/lib/external-db/escopo-do-contato";
import { colunasDaTabela } from "@/lib/external-db/introspeccao";
import { lerTabela } from "@/lib/external-db/leitura";
import type { ConexaoExterna } from "@/lib/external-db/types";
import type { McpContext } from "@/lib/mcp/types";
import { crmQueryExternalData } from "@/lib/mcp/tools/dados-externos";

const CONTATO = "22222222-2222-4222-8222-222222222222";

const CONEXAO: ConexaoExterna = {
  id: "conn-1",
  organizationId: "org-1",
  label: "Loja",
  host: "db.exemplo.com",
  port: 5432,
  database: "loja",
  username: "leitor",
  password: "segredo",
  sslMode: "require",
  maxRows: 200,
  maxFilters: 20,
  maxResponseBytes: 30_000,
  versao: "v1",
};

function ctxDoTurno(opts: { telefone?: string | null; email?: string | null; semTurno?: boolean } = {}): McpContext {
  const contato = {
    phone_number: opts.telefone === undefined ? "+55 35 99148-5627" : opts.telefone,
    email: opts.email === undefined ? null : opts.email,
  };
  const supabase = {
    from(tabela: string) {
      const q = {
        select: () => q,
        eq: () => q,
        order: async () => ({ data: [{ id: "conn-1", label: "Loja" }], error: null }),
        maybeSingle: async () => ({ data: tabela === "contacts" ? contato : null, error: null }),
      };
      return q;
    },
  };
  return {
    organizationId: "org-1",
    role: "ai_operator",
    actor: { type: "ai_agent", id: "ag-1" },
    apiTokenId: "tok-1",
    requestId: "req-1",
    supabase,
    ...(opts.semTurno ? {} : { escopoDoTurno: { contatoId: CONTATO, externo: { conhecidos: new Set<string>() } } }),
  } as unknown as McpContext;
}

const consulta = (tabela: string, extra: Record<string, unknown> = {}) => ({
  tabela,
  limite: 20,
  ...extra,
});

async function consultar(ctx: McpContext, input: Record<string, unknown>) {
  return (await crmQueryExternalData.handler(input as never, ctx)) as Record<string, unknown>;
}

beforeEach(() => {
  vi.mocked(abrirAcesso).mockReset().mockResolvedValue({ ok: true, conexao: CONEXAO, pool: {} as never });
  vi.mocked(colunasDaTabela).mockReset();
  vi.mocked(lerTabela).mockReset().mockResolvedValue({ colunas: [], linhas: [], limite: 20, offset: 0 });
});

describe("tabela com dado de pessoa só é lida ancorada no cliente da conversa", () => {
  beforeEach(() => {
    vi.mocked(colunasDaTabela).mockResolvedValue(new Set(["id", "nome", "telefone", "email", "endereco"]));
  });

  it("'liste os últimos pedidos', sem filtro de identidade: recusada, e o banco não é tocado", async () => {
    const r = await consultar(ctxDoTurno(), consulta("clientes", { schema: "public", colunas: ["nome"] }));
    expect(r.erro).toBe("consulta_sem_identidade");
    expect(lerTabela).not.toHaveBeenCalled();
  });

  it("'o CPF 123' (dado que o cliente digitou) não vira identidade", async () => {
    vi.mocked(colunasDaTabela).mockResolvedValue(new Set(["id", "nome", "cpf"]));
    const r = await consultar(
      ctxDoTurno(),
      consulta("clientes", {
        schema: "public",
        colunas: ["nome", "cpf"],
        filtros: [{ coluna: "cpf", operador: "eq", valor: "12345678900" }],
      }),
    );
    expect(r.erro).toBe("consulta_sem_identidade");
    expect(lerTabela).not.toHaveBeenCalled();
  });

  it("telefone de OUTRA pessoa não ancora", async () => {
    const r = await consultar(
      ctxDoTurno(),
      consulta("clientes", {
        schema: "public",
        colunas: ["nome"],
        filtros: [{ coluna: "telefone", operador: "eq", valor: "(11) 98888-7777" }],
      }),
    );
    expect(r.erro).toBe("consulta_sem_identidade");
    expect(lerTabela).not.toHaveBeenCalled();
  });

  it("o telefone do próprio contato, em qualquer formatação, ancora", async () => {
    for (const valor of ["5535991485627", "(35) 99148-5627", "35991485627", "3591485627"]) {
      vi.mocked(lerTabela).mockClear();
      const r = await consultar(
        ctxDoTurno(),
        consulta("clientes", {
          schema: "public",
          colunas: ["id", "nome"],
          filtros: [{ coluna: "telefone", operador: "eq", valor }],
        }),
      );
      expect(r.erro, valor).toBeUndefined();
      expect(lerTabela).toHaveBeenCalledTimes(1);
    }
  });

  it("sem `colunas`, a tabela de pessoa é recusada (nada de linha inteira)", async () => {
    const r = await consultar(
      ctxDoTurno(),
      consulta("clientes", {
        schema: "public",
        filtros: [{ coluna: "telefone", operador: "eq", valor: "5535991485627" }],
      }),
    );
    expect(r.erro).toBe("colunas_obrigatorias");
    expect(lerTabela).not.toHaveBeenCalled();
  });

  it("contato sem telefone nem e-mail: não há como ligar a consulta, recusa", async () => {
    const r = await consultar(
      ctxDoTurno({ telefone: null, email: null }),
      consulta("clientes", {
        schema: "public",
        colunas: ["nome"],
        filtros: [{ coluna: "telefone", operador: "eq", valor: "5535991485627" }],
      }),
    );
    expect(r.erro).toBe("consulta_sem_identidade");
    expect(lerTabela).not.toHaveBeenCalled();
  });

  it("o e-mail do contato ancora (sem diferenciar caixa)", async () => {
    await consultar(
      ctxDoTurno({ email: "Maria@Exemplo.com" }),
      consulta("clientes", {
        schema: "public",
        colunas: ["nome"],
        filtros: [{ coluna: "email", operador: "eq", valor: "maria@exemplo.com" }],
      }),
    );
    expect(lerTabela).toHaveBeenCalledTimes(1);
  });
});

describe("a prova se encadeia da ficha do cliente para as outras tabelas", () => {
  it("o id que a consulta pelo telefone devolveu vale em pedidos.cliente_id; outro id não", async () => {
    const ctx = ctxDoTurno();

    vi.mocked(colunasDaTabela).mockResolvedValueOnce(new Set(["id", "nome", "telefone"]));
    vi.mocked(lerTabela).mockResolvedValueOnce({
      colunas: ["id", "nome"],
      linhas: [{ id: 55, nome: "Maria" }],
      limite: 20,
      offset: 0,
    });
    await consultar(
      ctx,
      consulta("clientes", {
        schema: "public",
        colunas: ["id", "nome"],
        filtros: [{ coluna: "telefone", operador: "eq", valor: "5535991485627" }],
      }),
    );

    vi.mocked(colunasDaTabela).mockResolvedValue(new Set(["id", "cliente_id", "total", "endereco_entrega"]));
    vi.mocked(lerTabela).mockClear();

    const dele = await consultar(
      ctx,
      consulta("pedidos", {
        schema: "public",
        colunas: ["id", "total"],
        filtros: [{ coluna: "cliente_id", operador: "eq", valor: 55 }],
      }),
    );
    expect(dele.erro).toBeUndefined();
    expect(lerTabela).toHaveBeenCalledTimes(1);

    vi.mocked(lerTabela).mockClear();
    const doVizinho = await consultar(
      ctx,
      consulta("pedidos", {
        schema: "public",
        colunas: ["id", "total"],
        filtros: [{ coluna: "cliente_id", operador: "eq", valor: 56 }],
      }),
    );
    expect(doVizinho.erro).toBe("consulta_sem_identidade");
    expect(lerTabela).not.toHaveBeenCalled();
  });

  it("sem consulta ancorada antes, um cliente_id inventado não abre nada", async () => {
    vi.mocked(colunasDaTabela).mockResolvedValue(new Set(["id", "cliente_id", "total"]));
    const r = await consultar(
      ctxDoTurno(),
      consulta("pedidos", {
        schema: "public",
        colunas: ["total"],
        filtros: [{ coluna: "cliente_id", operador: "eq", valor: 55 }],
      }),
    );
    expect(r.erro).toBe("consulta_sem_identidade");
  });

  it("o id de um pedido (devolvido por consulta encadeada) não vira id de cliente", async () => {
    const ctx = ctxDoTurno();
    ctx.escopoDoTurno!.externo.conhecidos.add("55");
    vi.mocked(colunasDaTabela).mockResolvedValue(new Set(["id", "cliente_id", "total"]));
    vi.mocked(lerTabela).mockResolvedValueOnce({
      colunas: ["id"],
      linhas: [{ id: 9001 }],
      limite: 20,
      offset: 0,
    });
    await consultar(
      ctx,
      consulta("pedidos", {
        schema: "public",
        colunas: ["id"],
        filtros: [{ coluna: "cliente_id", operador: "eq", valor: 55 }],
      }),
    );
    expect(ctx.escopoDoTurno!.externo.conhecidos.has("9001")).toBe(false);
  });
});

describe("o que não é dado de pessoa segue como sempre", () => {
  it("catálogo de produtos: sem filtro de identidade e sem `colunas`", async () => {
    vi.mocked(colunasDaTabela).mockResolvedValue(new Set(["id", "nome", "preco", "foto"]));
    const r = await consultar(
      ctxDoTurno(),
      consulta("produtos", { schema: "public", filtros: [{ coluna: "nome", operador: "contem", valor: "CB 250" }] }),
    );
    expect(r.erro).toBeUndefined();
    expect(lerTabela).toHaveBeenCalledTimes(1);
  });

  it("fora de um turno de conversa (teste, API) a regra não se aplica", async () => {
    vi.mocked(colunasDaTabela).mockResolvedValue(new Set(["id", "nome", "telefone"]));
    const r = await consultar(ctxDoTurno({ semTurno: true }), consulta("clientes", { schema: "public" }));
    expect(r.erro).toBeUndefined();
    expect(lerTabela).toHaveBeenCalledTimes(1);
  });
});

describe("a regra pura", () => {
  it("reconhece tabela de pessoa pelo nome e pelas colunas", () => {
    expect(tabelaTemDadoDePessoa("pedidos", ["id", "total"])).toBe(true);
    expect(tabelaTemDadoDePessoa("itens", ["id", "cliente_id"])).toBe(true);
    expect(tabelaTemDadoDePessoa("itens", ["id", "email_contato"])).toBe(true);
    expect(tabelaTemDadoDePessoa("produtos", ["id", "nome", "preco"])).toBe(false);
  });

  it("telefone: absorve 55, máscara e o nono dígito, e não confunde números diferentes", () => {
    expect(mesmoTelefone("(35) 99148-5627", "+5535991485627")).toBe(true);
    expect(mesmoTelefone("3591485627", "35991485627")).toBe(true);
    expect(mesmoTelefone("35991485628", "35991485627")).toBe(false);
    expect(mesmoTelefone("11991485627", "35991485627")).toBe(false);
    expect(mesmoTelefone("99148", "35991485627")).toBe(false);
  });

  it("`contem` curto no telefone não é âncora (casaria com meia loja)", () => {
    const v = avaliarConsultaDoTurno({
      tabela: "clientes",
      colunasDaTabela: ["id", "telefone"],
      colunasPedidas: ["id"],
      filtros: [{ coluna: "telefone", operador: "contem", valor: "99148" }],
      identidade: { telefones: ["35991485627"], emails: [] },
      memoria: { conhecidos: new Set() },
    });
    expect(v.ok).toBe(false);
  });

  it("filtro `ne` ou `in` em telefone não é âncora", () => {
    for (const operador of ["ne", "in", "nao_nulo"]) {
      const v = avaliarConsultaDoTurno({
        tabela: "clientes",
        colunasDaTabela: ["id", "telefone"],
        colunasPedidas: ["id"],
        filtros: [{ coluna: "telefone", operador, valor: "35991485627" }],
        identidade: { telefones: ["35991485627"], emails: [] },
        memoria: { conhecidos: new Set() },
      });
      expect(v.ok, operador).toBe(false);
    }
  });
});
