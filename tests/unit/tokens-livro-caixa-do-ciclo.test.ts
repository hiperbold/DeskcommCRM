/**
 * Tarefa 7 da fase F2-B: `livroCaixaDoCiclo`, a leitura do livro-caixa COM
 * NOTA E AUTOR para a aba do admin da plataforma (diferente de
 * `extratoDoCiclo`, tarefa 6, que é para a tela do cliente e nunca lê nota
 * nem autor). Dublê no molde de `tests/unit/tokens-extrato-do-ciclo.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { inicioDoCicloEmUtc, livroCaixaDoCiclo } from "@/lib/billing/tokens/livro-caixa-do-ciclo";

const ORG = "22222222-2222-4222-8222-222222222222";
const CICLO = "2026-09-01";
const ADMIN_A = "33333333-3333-4333-8333-333333333333";
const ADMIN_B = "44444444-4444-4444-8444-444444444444";

interface Chamada {
  tabela: string;
  filtros: Record<string, unknown>;
}

interface OpcoesDoAdminFalso {
  ledgerData?: unknown[];
  ledgerErro?: string;
  ledgerLanca?: boolean;
  usuarios?: Record<string, { email: string | null; full_name?: string | null }>;
}

function criarAdminFalso(opts: OpcoesDoAdminFalso) {
  const chamadas: Chamada[] = [];

  function builder(tabela: string) {
    const filtros: Record<string, unknown> = {};
    const api = {
      select(_cols: string) {
        return api;
      },
      eq(col: string, val: unknown) {
        filtros[`eq_${col}`] = val;
        return api;
      },
      gte(col: string, val: unknown) {
        filtros[`gte_${col}`] = val;
        return api;
      },
      order(_col: string, _opcoes?: unknown) {
        return api;
      },
      then(resolve: (v: unknown) => void, reject: (e: unknown) => void) {
        chamadas.push({ tabela, filtros: { ...filtros } });
        try {
          if (tabela === "billing_token_ledger") {
            if (opts.ledgerLanca) throw new Error("conexão com o banco caiu");
            if (opts.ledgerErro) return resolve({ data: null, error: { message: opts.ledgerErro } });
            return resolve({ data: opts.ledgerData ?? [], error: null });
          }
          throw new Error(`tabela desconhecida no dublê: ${tabela}`);
        } catch (err) {
          reject(err);
        }
      },
    };
    return api;
  }

  const admin = {
    from: (tabela: string) => builder(tabela),
    auth: {
      admin: {
        getUserById: vi.fn(async (id: string) => {
          const usuario = opts.usuarios?.[id];
          if (!usuario) return { data: { user: null }, error: { message: "not found", status: 404 } };
          return {
            data: { user: { id, email: usuario.email, user_metadata: { full_name: usuario.full_name ?? null } } },
            error: null,
          };
        }),
      },
    },
  } as unknown as SupabaseClient;

  return { admin, chamadas };
}

function logFalso() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe("livroCaixaDoCiclo", () => {
  it("classifica os quatro tipos pela chave: concessão (plano/adicional), crédito, consumo e ajuste", async () => {
    const { admin } = criarAdminFalso({
      ledgerData: [
        { fonte: "plano", tokens: 3000000, chave: "plano:2026-09-01", nota: null, valor_cents: null, criado_por: null, created_at: "2026-09-02T13:00:00Z" },
        { fonte: "adicional", tokens: 100000, chave: "adicional:aaa:2026-09-01", nota: null, valor_cents: null, criado_por: null, created_at: "2026-09-02T13:00:00Z" },
        { fonte: "avulso", tokens: 50000, chave: "credito:bbb", nota: "pacote extra combinado", valor_cents: 5000, criado_por: ADMIN_A, created_at: "2026-09-03T13:00:00Z" },
        { fonte: "plano", tokens: -1000, chave: "consumo:ccc:plano", nota: null, valor_cents: null, criado_por: null, created_at: "2026-09-03T14:00:00Z" },
        { fonte: "plano", tokens: -2000, chave: "ajuste:ddd", nota: "estorno de débito errado", valor_cents: null, criado_por: ADMIN_B, created_at: "2026-09-04T13:00:00Z" },
      ],
      usuarios: {
        [ADMIN_A]: { email: "a@hiperbold.com.br", full_name: "Admin A" },
        [ADMIN_B]: { email: "b@hiperbold.com.br" },
      },
    });

    const r = await livroCaixaDoCiclo(admin, ORG, CICLO);

    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    const tipos = r.livroCaixa.linhas.map((l) => l.tipo).sort();
    expect(tipos).toEqual(["ajuste", "concessao", "concessao", "consumo", "credito"]);
  });

  it("consumo é agrupado por dia e fonte; concessão, crédito e ajuste ficam individuais", async () => {
    const { admin } = criarAdminFalso({
      ledgerData: [
        { fonte: "plano", tokens: -1000, chave: "consumo:c1:plano", nota: null, valor_cents: null, criado_por: null, created_at: "2026-09-03T14:00:00Z" },
        { fonte: "plano", tokens: -500, chave: "consumo:c2:plano", nota: null, valor_cents: null, criado_por: null, created_at: "2026-09-03T18:00:00Z" },
        { fonte: "adicional", tokens: -200, chave: "consumo:c3:adicional", nota: null, valor_cents: null, criado_por: null, created_at: "2026-09-03T18:00:00Z" },
      ],
    });

    const r = await livroCaixaDoCiclo(admin, ORG, CICLO);

    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    // As duas linhas de consumo do dia 03 em `plano` viram UMA linha somada;
    // a de `adicional` (fonte diferente, mesmo dia) fica separada.
    const consumoPlano = r.livroCaixa.linhas.find((l) => l.tipo === "consumo" && l.fonte === "plano");
    const consumoAdicional = r.livroCaixa.linhas.find((l) => l.tipo === "consumo" && l.fonte === "adicional");
    expect(consumoPlano).toEqual(
      expect.objectContaining({ dia: "2026-09-03", tokens: -1500, linhas: 2, nota: null }),
    );
    expect(consumoAdicional).toEqual(
      expect.objectContaining({ dia: "2026-09-03", tokens: -200, linhas: 1, nota: null }),
    );
  });

  it("resolve o autor (nome e e-mail) de crédito e ajuste; concessão e consumo nunca têm autor", async () => {
    const { admin } = criarAdminFalso({
      ledgerData: [
        { fonte: "avulso", tokens: 50000, chave: "credito:bbb", nota: "pacote", valor_cents: 5000, criado_por: ADMIN_A, created_at: "2026-09-03T13:00:00Z" },
        { fonte: "plano", tokens: 3000000, chave: "plano:2026-09-01", nota: null, valor_cents: null, criado_por: null, created_at: "2026-09-02T13:00:00Z" },
      ],
      usuarios: { [ADMIN_A]: { email: "a@hiperbold.com.br", full_name: "Admin A" } },
    });

    const r = await livroCaixaDoCiclo(admin, ORG, CICLO);

    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    const credito = r.livroCaixa.linhas.find((l) => l.tipo === "credito");
    const concessao = r.livroCaixa.linhas.find((l) => l.tipo === "concessao");
    expect(credito).toEqual(
      expect.objectContaining({ autorId: ADMIN_A, autorNome: "Admin A", autorEmail: "a@hiperbold.com.br", nota: "pacote", valorCents: 5000 }),
    );
    expect(concessao).toEqual(expect.objectContaining({ autorId: null, autorNome: null, autorEmail: null, nota: null }));
  });

  it("autor que o Auth não resolve (404): a linha continua, sem nome nem e-mail, e a leitura não falha", async () => {
    const { admin } = criarAdminFalso({
      ledgerData: [
        { fonte: "avulso", tokens: 50000, chave: "credito:bbb", nota: "pacote", valor_cents: 5000, criado_por: ADMIN_A, created_at: "2026-09-03T13:00:00Z" },
      ],
      usuarios: {},
    });

    const r = await livroCaixaDoCiclo(admin, ORG, CICLO);

    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.livroCaixa.linhas[0]).toEqual(
      expect.objectContaining({ autorId: ADMIN_A, autorNome: null, autorEmail: null }),
    );
  });

  it("filtra created_at pela virada real do ciclo em São Paulo (UTC-3), não pela data crua", async () => {
    const { admin, chamadas } = criarAdminFalso({ ledgerData: [] });

    await livroCaixaDoCiclo(admin, ORG, CICLO);

    const ledger = chamadas.find((c) => c.tabela === "billing_token_ledger");
    expect(ledger?.filtros.gte_created_at).toBe(inicioDoCicloEmUtc(CICLO));
    expect(inicioDoCicloEmUtc(CICLO)).toBe("2026-09-01T00:00:00-03:00");
  });

  it("isolamento: filtra pela organização", async () => {
    const { admin, chamadas } = criarAdminFalso({ ledgerData: [] });

    await livroCaixaDoCiclo(admin, ORG, CICLO);

    expect(chamadas.find((c) => c.tabela === "billing_token_ledger")?.filtros.eq_organization_id).toBe(ORG);
  });

  it("a consulta do livro-caixa devolve error: nunca lança, vira leitura_falhou e alarma", async () => {
    const { admin } = criarAdminFalso({ ledgerErro: "permission denied for table billing_token_ledger" });
    const log = logFalso();

    const r = await livroCaixaDoCiclo(admin, ORG, CICLO, log);

    expect(r).toEqual({ status: "leitura_falhou" });
    expect(log.error).toHaveBeenCalledWith("alarme_planos_leitura", expect.objectContaining({ organization_id: ORG }));
  });

  it("a consulta do livro-caixa lança: nunca propaga, vira leitura_falhou", async () => {
    const { admin } = criarAdminFalso({ ledgerLanca: true });

    const r = await livroCaixaDoCiclo(admin, ORG, CICLO);

    expect(r).toEqual({ status: "leitura_falhou" });
  });

  it("linha fora do esquema (tokens não numérico): leitura_falhou", async () => {
    const { admin } = criarAdminFalso({
      ledgerData: [{ fonte: "plano", tokens: "muitos", chave: "plano:2026-09-01", nota: null, valor_cents: null, criado_por: null, created_at: "2026-09-02T13:00:00Z" }],
    });

    const r = await livroCaixaDoCiclo(admin, ORG, CICLO);

    expect(r).toEqual({ status: "leitura_falhou" });
  });

  it("sem nenhuma linha no ciclo: devolve o livro-caixa vazio", async () => {
    const { admin } = criarAdminFalso({ ledgerData: [] });

    const r = await livroCaixaDoCiclo(admin, ORG, CICLO);

    expect(r).toEqual({ status: "ok", livroCaixa: { ciclo: CICLO, linhas: [] } });
  });
});
