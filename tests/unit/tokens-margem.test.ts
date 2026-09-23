/**
 * Tarefa 5 (parte pendente) da fase F2-B: `painelDeMargem` (decisão 17).
 * Dublê de `SupabaseClient` no molde de `tests/unit/tokens-extrato-do-
 * ciclo.test.ts`: um builder mínimo, thenable/awaitable, que registra tabela
 * e filtros aplicados de verdade, com `maybeSingle` e `like` a mais (esta
 * leitura usa as duas).
 */
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { painelDeMargem } from "@/lib/billing/tokens/margem";

const ORG = "22222222-2222-4222-8222-222222222222";
const CICLO = "2026-09-01";

interface Chamada {
  tabela: string;
  filtros: Record<string, unknown>;
  single: boolean;
}

interface OpcoesDoAdminFalso {
  contratoData?: unknown;
  contratoErro?: string;
  adicionaisData?: unknown[];
  adicionaisErro?: string;
  creditosData?: unknown[];
  creditosErro?: string;
  consumoData?: unknown[];
  consumoErro?: string;
}

function criarAdminFalso(opts: OpcoesDoAdminFalso) {
  const chamadas: Chamada[] = [];

  function builder(tabela: string) {
    const filtros: Record<string, unknown> = {};
    let single = false;
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
      like(col: string, val: unknown) {
        filtros[`like_${col}`] = val;
        return api;
      },
      maybeSingle(): Promise<unknown> {
        single = true;
        return new Promise((resolve, reject) => api.then(resolve, reject));
      },
      then(resolve: (v: unknown) => void, reject: (e: unknown) => void) {
        chamadas.push({ tabela, filtros: { ...filtros }, single });
        try {
          if (tabela === "billing_contracts") {
            if (opts.contratoErro) return resolve({ data: null, error: { message: opts.contratoErro } });
            return resolve({ data: opts.contratoData ?? null, error: null });
          }
          if (tabela === "billing_token_adicionais") {
            if (opts.adicionaisErro) return resolve({ data: null, error: { message: opts.adicionaisErro } });
            return resolve({ data: opts.adicionaisData ?? [], error: null });
          }
          if (tabela === "billing_token_ledger") {
            if (opts.creditosErro) return resolve({ data: null, error: { message: opts.creditosErro } });
            return resolve({ data: opts.creditosData ?? [], error: null });
          }
          if (tabela === "billing_token_consumo_diario") {
            if (opts.consumoErro) return resolve({ data: null, error: { message: opts.consumoErro } });
            return resolve({ data: opts.consumoData ?? [], error: null });
          }
          throw new Error(`tabela desconhecida no dublê: ${tabela}`);
        } catch (err) {
          reject(err);
        }
      },
    };
    return api;
  }

  const admin = { from: (tabela: string) => builder(tabela) } as unknown as SupabaseClient;
  return { admin, chamadas };
}

function logFalso() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe("painelDeMargem", () => {
  it("soma receita (plano + adicionais ativos + créditos do ciclo) e custo do ciclo", async () => {
    const { admin } = criarAdminFalso({
      contratoData: { billing_plans: { price_monthly_cents: 49900 } },
      adicionaisData: [{ valor_cents: 10000 }, { valor_cents: 5000 }],
      creditosData: [{ valor_cents: 2000 }, { valor_cents: null }],
      consumoData: [
        { cost_cents_conhecido: 12.5, chamadas_custo_nulo: 0 },
        { cost_cents_conhecido: 3.25, chamadas_custo_nulo: 2 },
      ],
    });

    const r = await painelDeMargem(admin, ORG, CICLO);

    expect(r).toEqual({
      status: "ok",
      margem: {
        ciclo: CICLO,
        receitaPlanoCents: 49900,
        receitaAdicionaisCents: 15000,
        receitaCreditosCents: 2000,
        receitaTotalCents: 66900,
        custoConhecidoCentsUsd: 15.75,
        chamadasCustoNulo: 2,
        custoIncompleto: true,
      },
    });
  });

  it("sem chamada de custo nulo no ciclo: custoIncompleto é falso", async () => {
    const { admin } = criarAdminFalso({
      contratoData: { billing_plans: { price_monthly_cents: 0 } },
      consumoData: [{ cost_cents_conhecido: 1, chamadas_custo_nulo: 0 }],
    });

    const r = await painelDeMargem(admin, ORG, CICLO);

    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect(r.margem.chamadasCustoNulo).toBe(0);
      expect(r.margem.custoIncompleto).toBe(false);
    }
  });

  it("sem contrato gravado: receita do plano é 0, não inventa preço", async () => {
    const { admin } = criarAdminFalso({ contratoData: null });

    const r = await painelDeMargem(admin, ORG, CICLO);

    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(r.margem.receitaPlanoCents).toBe(0);
  });

  it("créditos avulsos: filtra pela CHAVE credito:%, não pela fonte avulso", async () => {
    const { admin, chamadas } = criarAdminFalso({ creditosData: [] });

    await painelDeMargem(admin, ORG, CICLO);

    const ledger = chamadas.find((c) => c.tabela === "billing_token_ledger");
    expect(ledger?.filtros.like_chave).toBe("credito:%");
  });

  it("créditos avulsos: filtra created_at pela virada real do ciclo em São Paulo (UTC-3), não pela data crua", async () => {
    const { admin, chamadas } = criarAdminFalso({ creditosData: [] });

    await painelDeMargem(admin, ORG, CICLO);

    const ledger = chamadas.find((c) => c.tabela === "billing_token_ledger");
    expect(ledger?.filtros.gte_created_at).toBe("2026-09-01T00:00:00-03:00");
  });

  it("adicionais: só os ATIVOS entram na receita", async () => {
    const { admin, chamadas } = criarAdminFalso({ adicionaisData: [] });

    await painelDeMargem(admin, ORG, CICLO);

    const adicionais = chamadas.find((c) => c.tabela === "billing_token_adicionais");
    expect(adicionais?.filtros.eq_ativo).toBe(true);
  });

  it("isolamento: as quatro tabelas são filtradas pela organização", async () => {
    const { admin, chamadas } = criarAdminFalso({});

    await painelDeMargem(admin, ORG, CICLO);

    for (const tabela of [
      "billing_contracts",
      "billing_token_adicionais",
      "billing_token_ledger",
      "billing_token_consumo_diario",
    ]) {
      expect(chamadas.find((c) => c.tabela === tabela)?.filtros.eq_organization_id).toBe(ORG);
    }
  });

  it("a leitura do contrato devolve error: nunca lança, vira leitura_falhou e alarma", async () => {
    const { admin } = criarAdminFalso({ contratoErro: "permission denied for table billing_contracts" });
    const log = logFalso();

    const r = await painelDeMargem(admin, ORG, CICLO, log);

    expect(r).toEqual({ status: "leitura_falhou" });
    expect(log.error).toHaveBeenCalledWith("alarme_planos_leitura", expect.objectContaining({ organization_id: ORG }));
  });

  it("a leitura dos adicionais devolve error: leitura_falhou", async () => {
    const { admin } = criarAdminFalso({ adicionaisErro: "permission denied" });

    const r = await painelDeMargem(admin, ORG, CICLO);

    expect(r).toEqual({ status: "leitura_falhou" });
  });

  it("a leitura dos créditos devolve error: leitura_falhou", async () => {
    const { admin } = criarAdminFalso({ creditosErro: "permission denied" });

    const r = await painelDeMargem(admin, ORG, CICLO);

    expect(r).toEqual({ status: "leitura_falhou" });
  });

  it("a leitura do consumo devolve error: leitura_falhou", async () => {
    const { admin } = criarAdminFalso({ consumoErro: "permission denied" });

    const r = await painelDeMargem(admin, ORG, CICLO);

    expect(r).toEqual({ status: "leitura_falhou" });
  });

  it("linha fora do esquema (valor_cents não numérico): leitura_falhou", async () => {
    const { admin } = criarAdminFalso({ adicionaisData: [{ valor_cents: "muito" }] });

    const r = await painelDeMargem(admin, ORG, CICLO);

    expect(r).toEqual({ status: "leitura_falhou" });
  });

  it("sem ciclo informado, calcula o primeiro dia do mês corrente", async () => {
    const { admin, chamadas } = criarAdminFalso({ consumoData: [] });

    const r = await painelDeMargem(admin, ORG);

    expect(r.status).toBe("ok");
    const consumo = chamadas.find((c) => c.tabela === "billing_token_consumo_diario");
    expect(typeof consumo?.filtros.gte_dia).toBe("string");
  });
});
