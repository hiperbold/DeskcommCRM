/**
 * Tarefa 5 da fase F2-B (hiperbold/planos/fase-F2-B-tarefas.md): leitura de
 * `estimativaDeRespostas`. Mesmo dublê thenable de
 * `tests/unit/tokens-extrato-do-ciclo.test.ts`, com uma segunda tabela
 * (`llm_calls`, consultada por `count`).
 */
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { estimativaDeRespostas, TOKENS_POR_RESPOSTA_PADRAO } from "@/lib/billing/tokens/estimativa-de-respostas";

const ORG = "22222222-2222-4222-8222-222222222222";

interface Chamada {
  tabela: string;
  filtros: Record<string, unknown>;
}

interface OpcoesDoAdminFalso {
  consumoData?: unknown[];
  consumoErro?: string;
  respostasCount?: number | null;
  respostasErro?: string;
}

function criarAdminFalso(opts: OpcoesDoAdminFalso) {
  const chamadas: Chamada[] = [];

  function builder(tabela: string) {
    const filtros: Record<string, unknown> = {};
    const api = {
      select(_cols: string, _opcoes?: unknown) {
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
      then(resolve: (v: unknown) => void, reject: (e: unknown) => void) {
        chamadas.push({ tabela, filtros: { ...filtros } });
        try {
          if (tabela === "billing_token_consumo_diario") {
            if (opts.consumoErro) {
              resolve({ data: null, error: { message: opts.consumoErro } });
              return;
            }
            resolve({ data: opts.consumoData ?? [], error: null });
            return;
          }
          if (tabela === "llm_calls") {
            if (opts.respostasErro) {
              resolve({ data: null, error: { message: opts.respostasErro }, count: null });
              return;
            }
            resolve({ data: null, error: null, count: opts.respostasCount ?? 0 });
            return;
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

describe("estimativaDeRespostas", () => {
  it("com amostra: tokensPorResposta é o consumo total dividido pelas respostas", async () => {
    const { admin } = criarAdminFalso({
      consumoData: [{ tokens_ponderados: 600_000 }, { tokens_ponderados: 400_000 }],
      respostasCount: 25,
    });

    const r = await estimativaDeRespostas(admin, ORG, 500_000);

    expect(r).toEqual({
      status: "ok",
      estimativa: { tokensPorResposta: 40_000, respostasQueCabem: 12, baseadoEmAmostra: true },
    });
  });

  it("sem amostra (zero respostas): usa a mediana de referência de 32 mil", async () => {
    const { admin } = criarAdminFalso({ consumoData: [{ tokens_ponderados: 100_000 }], respostasCount: 0 });

    const r = await estimativaDeRespostas(admin, ORG, 320_000);

    expect(r).toEqual({
      status: "ok",
      estimativa: {
        tokensPorResposta: TOKENS_POR_RESPOSTA_PADRAO,
        respostasQueCabem: 10,
        baseadoEmAmostra: false,
      },
    });
  });

  it("saldoRestante null (sem teto): respostasQueCabem null, sem dividir por nada", async () => {
    const { admin } = criarAdminFalso({ consumoData: [{ tokens_ponderados: 320_000 }], respostasCount: 10 });

    const r = await estimativaDeRespostas(admin, ORG, null);

    expect(r).toEqual({
      status: "ok",
      estimativa: { tokensPorResposta: 32_000, respostasQueCabem: null, baseadoEmAmostra: true },
    });
  });

  it("saldoRestante negativo: respostasQueCabem nunca fica negativo (piso em zero)", async () => {
    const { admin } = criarAdminFalso({ consumoData: [{ tokens_ponderados: 100_000 }], respostasCount: 10 });

    const r = await estimativaDeRespostas(admin, ORG, -5_000);

    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(r.estimativa.respostasQueCabem).toBe(0);
  });

  it("isolamento: as duas consultas filtram a organização, e llm_calls filtra o purpose certo", async () => {
    const { admin, chamadas } = criarAdminFalso({ consumoData: [], respostasCount: 0 });

    await estimativaDeRespostas(admin, ORG, null);

    const consumo = chamadas.find((c) => c.tabela === "billing_token_consumo_diario");
    const respostas = chamadas.find((c) => c.tabela === "llm_calls");
    expect(consumo?.filtros.eq_organization_id).toBe(ORG);
    expect(respostas?.filtros.eq_organization_id).toBe(ORG);
    expect(respostas?.filtros.eq_purpose).toBe("agent_turn");
  });

  it("a consulta do consumo devolve error: nunca lança, vira leitura_falhou e alarma", async () => {
    const { admin } = criarAdminFalso({ consumoErro: "permission denied", respostasCount: 0 });
    const log = logFalso();

    const r = await estimativaDeRespostas(admin, ORG, null, log);

    expect(r).toEqual({ status: "leitura_falhou" });
    expect(log.error).toHaveBeenCalledWith("alarme_planos_leitura", expect.objectContaining({ organization_id: ORG }));
  });

  it("a contagem de respostas devolve error: vira leitura_falhou", async () => {
    const { admin } = criarAdminFalso({ consumoData: [], respostasErro: "permission denied" });

    const r = await estimativaDeRespostas(admin, ORG, null);

    expect(r).toEqual({ status: "leitura_falhou" });
  });

  it("funciona sem `log` (parâmetro opcional)", async () => {
    const { admin } = criarAdminFalso({ consumoErro: "permission denied", respostasCount: 0 });
    await expect(estimativaDeRespostas(admin, ORG, null)).resolves.toEqual({ status: "leitura_falhou" });
  });
});
