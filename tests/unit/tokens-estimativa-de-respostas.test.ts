/**
 * Tarefa 5 da fase F2-B (hiperbold/planos/fase-F2-B-tarefas.md): leitura de
 * `estimativaDeRespostas`. Desde a revisão de 23/09/2026 (item 1d/item 9), os
 * dois números vêm agregados NO BANCO por `fn_billing_consumo_para_estimativa`
 * (RPC): o dublê é o mesmo molde de `tests/unit/tokens-saldo-da-
 * organizacao.test.ts` (um `admin.rpc` falso), sem mais tabela nenhuma.
 */
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { estimativaDeRespostas, TOKENS_POR_RESPOSTA_PADRAO } from "@/lib/billing/tokens/estimativa-de-respostas";

const ORG = "22222222-2222-4222-8222-222222222222";

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
    return { data: opts.data ?? { tokens_ponderados: 0, respostas: 0 }, error: null };
  }

  const admin = { rpc } as unknown as SupabaseClient;
  return { admin, chamadasRpc };
}

function logFalso() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe("estimativaDeRespostas", () => {
  it("com amostra: tokensPorResposta é o consumo total dividido pelas respostas", async () => {
    const { admin, chamadasRpc } = criarAdminFalso({
      data: { tokens_ponderados: 1_000_000, respostas: 25 },
    });

    const r = await estimativaDeRespostas(admin, ORG, 500_000);

    expect(r).toEqual({
      status: "ok",
      estimativa: { tokensPorResposta: 40_000, respostasQueCabem: 12, baseadoEmAmostra: true },
    });
    expect(chamadasRpc).toEqual([
      { nome: "fn_billing_consumo_para_estimativa", args: { p_org: ORG, p_dias: 30 } },
    ]);
  });

  it("sem amostra (zero respostas): usa a mediana de referência de 32 mil", async () => {
    const { admin } = criarAdminFalso({ data: { tokens_ponderados: 100_000, respostas: 0 } });

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
    const { admin } = criarAdminFalso({ data: { tokens_ponderados: 320_000, respostas: 10 } });

    const r = await estimativaDeRespostas(admin, ORG, null);

    expect(r).toEqual({
      status: "ok",
      estimativa: { tokensPorResposta: 32_000, respostasQueCabem: null, baseadoEmAmostra: true },
    });
  });

  it("saldoRestante negativo: respostasQueCabem nunca fica negativo (piso em zero)", async () => {
    const { admin } = criarAdminFalso({ data: { tokens_ponderados: 100_000, respostas: 10 } });

    const r = await estimativaDeRespostas(admin, ORG, -5_000);

    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(r.estimativa.respostasQueCabem).toBe(0);
  });

  it("isolamento: a RPC é chamada com a organização certa e a janela de 30 dias", async () => {
    const { admin, chamadasRpc } = criarAdminFalso({ data: { tokens_ponderados: 0, respostas: 0 } });

    await estimativaDeRespostas(admin, ORG, null);

    expect(chamadasRpc).toEqual([
      { nome: "fn_billing_consumo_para_estimativa", args: { p_org: ORG, p_dias: 30 } },
    ]);
  });

  it("a RPC devolve error: nunca lança, vira leitura_falhou e alarma", async () => {
    const { admin } = criarAdminFalso({ erro: "permission denied" });
    const log = logFalso();

    const r = await estimativaDeRespostas(admin, ORG, null, log);

    expect(r).toEqual({ status: "leitura_falhou" });
    expect(log.error).toHaveBeenCalledWith("alarme_planos_leitura", expect.objectContaining({ organization_id: ORG }));
  });

  it("a RPC lança: nunca propaga, vira leitura_falhou", async () => {
    const { admin } = criarAdminFalso({ lanca: true });

    const r = await estimativaDeRespostas(admin, ORG, null);

    expect(r).toEqual({ status: "leitura_falhou" });
  });

  it("jsonb fora do esquema (respostas não numérico): leitura_falhou", async () => {
    const { admin } = criarAdminFalso({ data: { tokens_ponderados: 100_000, respostas: "muitas" } });

    const r = await estimativaDeRespostas(admin, ORG, null);

    expect(r).toEqual({ status: "leitura_falhou" });
  });

  it("funciona sem `log` (parâmetro opcional)", async () => {
    const { admin } = criarAdminFalso({ erro: "permission denied" });
    await expect(estimativaDeRespostas(admin, ORG, null)).resolves.toEqual({ status: "leitura_falhou" });
  });
});
