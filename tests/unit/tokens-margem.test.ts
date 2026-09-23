/**
 * Tarefa 5 (parte pendente) da fase F2-B: `painelDeMargem` (decisão 17).
 * Desde a revisão de 23/09/2026 (item 1c/item 9), receita e custo (inclusive
 * a ESTIMATIVA pelo catálogo) são calculados NO BANCO por
 * `fn_billing_margem_do_ciclo` (RPC): o dublê é um `admin.rpc` falso, no
 * molde de `tests/unit/tokens-saldo-da-organizacao.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { painelDeMargem } from "@/lib/billing/tokens/margem";

const ORG = "22222222-2222-4222-8222-222222222222";
const CICLO = "2026-09-01";

const MARGEM_ZERADA = {
  receita_plano_cents: 0,
  receita_adicionais_cents: 0,
  receita_creditos_cents: 0,
  receita_total_cents: 0,
  custo_conhecido_cents: 0,
  custo_estimado_cents: 0,
  chamadas_estimadas: 0,
  chamadas_sem_preco: 0,
};

interface OpcoesDoAdminFalso {
  data?: unknown;
  erro?: string;
  lanca?: boolean;
}

function criarAdminFalso(opts: OpcoesDoAdminFalso) {
  const chamadasRpc: Array<{ nome: string; args: unknown }> = [];

  async function rpc(nome: string, args: unknown) {
    chamadasRpc.push({ nome, args });
    if (opts.lanca) throw new Error("conexão com o banco caiu");
    if (opts.erro) return { data: null, error: { message: opts.erro } };
    return { data: opts.data ?? MARGEM_ZERADA, error: null };
  }

  const admin = { rpc } as unknown as SupabaseClient;
  return { admin, chamadasRpc };
}

function logFalso() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe("painelDeMargem", () => {
  it("repassa receita (plano + adicionais + créditos) e custo conhecido do ciclo", async () => {
    const { admin } = criarAdminFalso({
      data: {
        receita_plano_cents: 49900,
        receita_adicionais_cents: 15000,
        receita_creditos_cents: 2000,
        receita_total_cents: 66900,
        custo_conhecido_cents: 15.75,
        custo_estimado_cents: 0,
        chamadas_estimadas: 0,
        chamadas_sem_preco: 0,
      },
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
        custoEstimadoCentsUsd: 0,
        chamadasEstimadas: 0,
        chamadasSemPreco: 0,
        custoIncompleto: false,
      },
    });
  });

  it("item 1c da revisão: custo estimado pelo catálogo e chamadas sem preço são repassados; custoIncompleto reflete chamadasSemPreco", async () => {
    const { admin } = criarAdminFalso({
      data: { ...MARGEM_ZERADA, custo_estimado_cents: 42.5, chamadas_estimadas: 3, chamadas_sem_preco: 2 },
    });

    const r = await painelDeMargem(admin, ORG, CICLO);

    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.margem.custoEstimadoCentsUsd).toBe(42.5);
    expect(r.margem.chamadasEstimadas).toBe(3);
    expect(r.margem.chamadasSemPreco).toBe(2);
    expect(r.margem.custoIncompleto).toBe(true);
  });

  it("sem chamada sem preço no ciclo: custoIncompleto é falso mesmo com chamadas estimadas", async () => {
    const { admin } = criarAdminFalso({
      data: { ...MARGEM_ZERADA, custo_estimado_cents: 10, chamadas_estimadas: 5, chamadas_sem_preco: 0 },
    });

    const r = await painelDeMargem(admin, ORG, CICLO);

    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(r.margem.custoIncompleto).toBe(false);
  });

  it("sem contrato gravado: receita do plano é 0, não inventa preço (a RPC já resolve isso)", async () => {
    const { admin } = criarAdminFalso({ data: MARGEM_ZERADA });

    const r = await painelDeMargem(admin, ORG, CICLO);

    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(r.margem.receitaPlanoCents).toBe(0);
  });

  it("chama a RPC com a organização e o ciclo certos", async () => {
    const { admin, chamadasRpc } = criarAdminFalso({ data: MARGEM_ZERADA });

    await painelDeMargem(admin, ORG, CICLO);

    expect(chamadasRpc).toEqual([
      { nome: "fn_billing_margem_do_ciclo", args: { p_org: ORG, p_ciclo: CICLO } },
    ]);
  });

  it("a RPC devolve error: nunca lança, vira leitura_falhou e alarma", async () => {
    const { admin } = criarAdminFalso({ erro: "permission denied for function fn_billing_margem_do_ciclo" });
    const log = logFalso();

    const r = await painelDeMargem(admin, ORG, CICLO, log);

    expect(r).toEqual({ status: "leitura_falhou" });
    expect(log.error).toHaveBeenCalledWith("alarme_planos_leitura", expect.objectContaining({ organization_id: ORG }));
  });

  it("a RPC lança: nunca propaga, vira leitura_falhou", async () => {
    const { admin } = criarAdminFalso({ lanca: true });

    const r = await painelDeMargem(admin, ORG, CICLO);

    expect(r).toEqual({ status: "leitura_falhou" });
  });

  it("jsonb fora do esquema (receita_plano_cents não numérico): leitura_falhou", async () => {
    const { admin } = criarAdminFalso({ data: { ...MARGEM_ZERADA, receita_plano_cents: "muito" } });

    const r = await painelDeMargem(admin, ORG, CICLO);

    expect(r).toEqual({ status: "leitura_falhou" });
  });

  it("sem ciclo informado, calcula o primeiro dia do mês corrente e passa para a RPC", async () => {
    const { admin, chamadasRpc } = criarAdminFalso({ data: MARGEM_ZERADA });

    const r = await painelDeMargem(admin, ORG);

    expect(r.status).toBe("ok");
    expect(typeof (chamadasRpc[0]?.args as { p_ciclo: string }).p_ciclo).toBe("string");
  });
});
