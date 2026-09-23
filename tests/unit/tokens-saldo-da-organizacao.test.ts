/**
 * Tarefa 5 da fase F2-B (hiperbold/planos/fase-F2-B-tarefas.md): leitura de
 * `saldoDaOrganizacao`. Dublê do cliente Supabase, sem banco de verdade, no
 * molde de `tests/unit/planos-uso-e-pode-criar.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { saldoDaOrganizacao } from "@/lib/billing/tokens/saldo-da-organizacao";

const ORG = "22222222-2222-4222-8222-222222222222";

const FONTE_ZERADA = { creditado: 0, consumido: 0, saldo: 0 };

const SALDO_OK = {
  ciclo: "2026-09-01",
  por_fonte: {
    plano: { creditado: 3_000_000, consumido: 500_000, saldo: 2_500_000 },
    adicional: FONTE_ZERADA,
    avulso: { creditado: 100_000, consumido: 0, saldo: 100_000 },
  },
  sem_limite: false,
  total_disponivel: 3_100_000,
  total_consumido: 500_000,
};

const SALDO_ILIMITADO = {
  ciclo: "2026-09-01",
  por_fonte: { plano: FONTE_ZERADA, adicional: FONTE_ZERADA, avulso: FONTE_ZERADA },
  sem_limite: true,
  total_disponivel: 0,
  total_consumido: 820_000,
};

const TEXTO_CRU_DO_BANCO = "coluna organization_id_fantasma não existe na tabela billing_token_wallets";

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
    return { data: opts.data ?? SALDO_OK, error: null };
  }

  const admin = { rpc } as unknown as SupabaseClient;
  return { admin, chamadasRpc };
}

function logFalso() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe("saldoDaOrganizacao", () => {
  it("resposta boa (com teto): status ok, chama a RPC certa e devolve os números", async () => {
    const { admin, chamadasRpc } = criarAdminFalso({ data: SALDO_OK });
    const log = logFalso();

    const r = await saldoDaOrganizacao(admin, ORG, log);

    expect(r).toEqual({
      status: "ok",
      ciclo: "2026-09-01",
      porFonte: SALDO_OK.por_fonte,
      totalDisponivel: 3_100_000,
      totalConsumido: 500_000,
    });
    expect(chamadasRpc).toEqual([{ nome: "fn_billing_saldo_da_carteira", args: { p_org: ORG } }]);
    expect(log.error).not.toHaveBeenCalled();
  });

  it("Ilimitado (sem_limite true): status sem_limite, sem totalDisponivel", async () => {
    const { admin } = criarAdminFalso({ data: SALDO_ILIMITADO });

    const r = await saldoDaOrganizacao(admin, ORG);

    expect(r).toEqual({
      status: "sem_limite",
      ciclo: "2026-09-01",
      porFonte: SALDO_ILIMITADO.por_fonte,
      totalConsumido: 820_000,
    });
    expect(r).not.toHaveProperty("totalDisponivel");
  });

  it("a RPC devolve error: nunca lança, vira leitura_falhou e alarma", async () => {
    const { admin } = criarAdminFalso({ erro: TEXTO_CRU_DO_BANCO });
    const log = logFalso();

    const r = await saldoDaOrganizacao(admin, ORG, log);

    expect(r).toEqual({ status: "leitura_falhou" });
    expect(log.error).toHaveBeenCalledWith(
      "alarme_planos_leitura",
      expect.objectContaining({ organization_id: ORG, error: expect.stringContaining(TEXTO_CRU_DO_BANCO) }),
    );
  });

  it("a RPC lança: nunca propaga, vira leitura_falhou e alarma", async () => {
    const { admin } = criarAdminFalso({ lanca: true });
    const log = logFalso();

    const r = await saldoDaOrganizacao(admin, ORG, log);

    expect(r).toEqual({ status: "leitura_falhou" });
    expect(log.error).toHaveBeenCalledWith("alarme_planos_leitura", expect.anything());
  });

  it("jsonb malformado (chave faltando em por_fonte): leitura_falhou", async () => {
    const { plano: _plano, ...semPlano } = SALDO_OK.por_fonte;
    const { admin } = criarAdminFalso({ data: { ...SALDO_OK, por_fonte: semPlano } });
    const log = logFalso();

    const r = await saldoDaOrganizacao(admin, ORG, log);

    expect(r).toEqual({ status: "leitura_falhou" });
    expect(log.error).toHaveBeenCalledWith("alarme_planos_leitura", expect.anything());
  });

  it("jsonb malformado (tipo errado em sem_limite): leitura_falhou", async () => {
    const { admin } = criarAdminFalso({ data: { ...SALDO_OK, sem_limite: "nao" } });

    const r = await saldoDaOrganizacao(admin, ORG);

    expect(r).toEqual({ status: "leitura_falhou" });
  });

  it("saldo negativo (ajuste do admin) passa direto, sem piso em zero", async () => {
    const comAjusteNegativo = {
      ...SALDO_OK,
      por_fonte: { ...SALDO_OK.por_fonte, plano: { creditado: -50_000, consumido: 0, saldo: -50_000 } },
      total_disponivel: -50_000,
    };
    const { admin } = criarAdminFalso({ data: comAjusteNegativo });

    const r = await saldoDaOrganizacao(admin, ORG);

    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect(r.porFonte.plano.saldo).toBe(-50_000);
      expect(r.totalDisponivel).toBe(-50_000);
    }
  });

  it("funciona sem `log` (parâmetro opcional)", async () => {
    const { admin } = criarAdminFalso({ erro: TEXTO_CRU_DO_BANCO });
    await expect(saldoDaOrganizacao(admin, ORG)).resolves.toEqual({ status: "leitura_falhou" });
  });
});
