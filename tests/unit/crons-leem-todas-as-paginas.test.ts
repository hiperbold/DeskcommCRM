/**
 * D-161: crons e varreduras que só enxergavam a primeira página.
 *
 * O PostgREST corta em `max_rows` (1000) e um `limit(500)` sem ordem deixava as
 * mesmas linhas ocupando a janela. Estes testes servem páginas de verdade
 * (o dublê respeita `range`) e provam que a leitura continua até o fim; e que a
 * competência dos moldes recorrentes é a do FUSO da organização.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/auth/cron-auth", () => ({ autorizaCron: () => true }));
vi.mock("@/lib/escalacao/retomada", () => ({ devolverAtendimentoAoAgente: vi.fn(async () => ({ ok: true })) }));

const banco = vi.hoisted(() => ({
  admin: null as unknown,
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => banco.admin }));

import { devolverHandoffsVencidos } from "@/app/api/v1/cron/handoff-devolucao/route";
import { GET as rodarMoldes, dataCivilNoFuso } from "@/app/api/v1/cron/recurring-entries/route";
import { createSupabaseSilenceSweepDb } from "@/lib/followup/silence-sweep";

type Linha = Record<string, unknown>;

/** Tabela servida por página: respeita `range` e registra as páginas pedidas. */
function tabelaPaginada(linhas: Linha[], paginasPedidas: number[][]) {
  let faixa: [number, number] | null = null;
  const q: Record<string, unknown> = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "range") {
          return (a: number, b: number) => {
            faixa = [a, b];
            paginasPedidas.push([a, b]);
            return q;
          };
        }
        if (prop === "then") {
          return (ok: (v: unknown) => unknown) =>
            ok({ data: faixa ? linhas.slice(faixa[0], faixa[1] + 1) : linhas, error: null });
        }
        return () => q;
      },
    },
  ) as Record<string, unknown>;
  return q;
}

describe("handoff-devolucao lê todas as páginas de conversas", () => {
  it("1100 candidatas em 3 páginas: examina as 1100, não só as 500 primeiras", async () => {
    const conversas = Array.from({ length: 1100 }, (_, i) => ({
      id: `c-${String(i).padStart(5, "0")}`,
      organization_id: "org-1",
      channel_session_id: "s-1",
      status: "pending",
    }));
    const pedidas: number[][] = [];
    banco.admin = {
      from: (t: string) => {
        if (t === "organizations") {
          return tabelaPaginada([{ id: "org-1", settings: { routing: { handoff_return_after_minutes: 30 } } }], []);
        }
        if (t === "conversations") return tabelaPaginada(conversas, pedidas);
        return tabelaPaginada([], []);
      },
    };

    const r = await devolverHandoffsVencidos(banco.admin as never, "req-1");

    expect(r.examinadas).toBe(1100);
    expect(pedidas).toEqual([
      [0, 499],
      [500, 999],
      [1000, 1499],
    ]);
  });
});

describe("silence-sweep lê todas as conversas abertas", () => {
  it("1200 conversas: pede as três páginas em ordem estável", async () => {
    const linhas = Array.from({ length: 1200 }, (_, i) => ({ id: `c-${i}`, messages: [], contact_id: `k-${i}` }));
    const pedidas: number[][] = [];
    const admin = { from: () => tabelaPaginada(linhas, pedidas) } as never;

    await createSupabaseSilenceSweepDb(admin).loadSilentContactIds("org-1", new Date().toISOString(), []);

    expect(pedidas).toEqual([
      [0, 499],
      [500, 999],
      [1000, 1499],
    ]);
  });
});

describe("recurring-entries", () => {
  it("dataCivilNoFuso: 21h de Brasília do último dia ainda é o mesmo mês (em UTC já seria o seguinte)", () => {
    const instante = new Date("2026-10-01T00:30:00Z"); // 21:30 de 30/09 em São Paulo
    expect(dataCivilNoFuso(instante, "America/Sao_Paulo")).toEqual({ ano: 2026, mes: 9, hoje: "2026-09-30" });
    expect(dataCivilNoFuso(instante, "UTC")).toEqual({ ano: 2026, mes: 10, hoje: "2026-10-01" });
    expect(dataCivilNoFuso(instante, "Fuso/Invalido").mes).toBe(9);
    expect(dataCivilNoFuso(instante, null).mes).toBe(9);
  });

  it("1200 moldes (além do corte de 1000): todos geram lançamento", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-15T15:00:00Z"));
    try {
      const moldes = Array.from({ length: 1200 }, (_, i) => ({
        id: `m-${String(i).padStart(5, "0")}`,
        organization_id: "org-1",
        account_id: "a",
        account_plan_id: null,
        direction: "out",
        amount_cents: 100,
        currency: "BRL",
        name: "Aluguel",
        day_of_month: 5,
      }));
      const inseridos: Linha[] = [];
      banco.admin = {
        from: (t: string) => {
          if (t === "recurring_entries") return tabelaPaginada(moldes, []);
          if (t === "organizations") return tabelaPaginada([{ id: "org-1", timezone: "America/Sao_Paulo" }], []);
          if (t === "financial_entries") {
            return {
              insert: async (row: Linha) => {
                inseridos.push(row);
                return { error: null };
              },
            };
          }
          throw new Error(`tabela inesperada: ${t}`);
        },
      };

      const resp = await rodarMoldes(new Request("http://x/api/v1/cron/recurring-entries") as never);
      expect(resp.status).toBe(200);
      expect(inseridos).toHaveLength(1200);
      expect(inseridos[0]).toMatchObject({ entry_date: "2026-10-05", status: "pending", origin: "recurring" });
    } finally {
      vi.useRealTimers();
    }
  });
});
