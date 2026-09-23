/**
 * Tarefa 6 da fase F2-B (hiperbold/planos/fase-F2-B-tarefas.md): a função
 * pura que monta as linhas da seção "Tokens de IA", a partir do que
 * `saldoDaOrganizacao`, `extratoDoCiclo` e `estimativaDeRespostas` já leram.
 * Sem rede, sem banco, no molde de `tests/unit/planos-linhas-da-tela.test.ts`.
 */
import { describe, expect, it } from "vitest";

import { linhasDeTokensDeIA } from "@/lib/billing/tokens/linhas-da-tela";
import type { ResultadoSaldoDaCarteira } from "@/lib/billing/tokens/saldo-da-organizacao";
import type { ResultadoExtratoDoCiclo } from "@/lib/billing/tokens/extrato-do-ciclo";
import type { ResultadoEstimativaDeRespostas } from "@/lib/billing/tokens/estimativa-de-respostas";

const FONTE_ZERADA = { creditado: 0, consumido: 0, saldo: 0 };

const SALDO_OK: ResultadoSaldoDaCarteira = {
  status: "ok",
  ciclo: "2026-09-01",
  porFonte: {
    plano: { creditado: 3_000_000, consumido: 500_000, saldo: 2_500_000 },
    adicional: FONTE_ZERADA,
    avulso: { creditado: 100_000, consumido: 0, saldo: 100_000 },
  },
  totalDisponivel: 3_100_000,
  totalConsumido: 500_000,
};

const SALDO_SEM_LIMITE: ResultadoSaldoDaCarteira = {
  status: "sem_limite",
  ciclo: "2026-09-01",
  porFonte: { plano: FONTE_ZERADA, adicional: FONTE_ZERADA, avulso: FONTE_ZERADA },
  totalConsumido: 820_000,
};

const EXTRATO_OK: ResultadoExtratoDoCiclo = {
  status: "ok",
  extrato: {
    ciclo: "2026-09-01",
    porDia: [
      { dia: "2026-09-01", tokensPonderados: 1000, chamadas: 2 },
      { dia: "2026-09-03", tokensPonderados: 500, chamadas: 1 },
      { dia: "2026-09-02", tokensPonderados: 3000, chamadas: 5 },
    ],
    porAgente: [
      { agentId: "a1", tipo: "agente", nome: "Vendas", tokensPonderados: 500, chamadas: 2 },
      { agentId: "a2", tipo: "agente", nome: "Suporte", tokensPonderados: 4000, chamadas: 5 },
      { agentId: null, tipo: "sem_agente", nome: null, tokensPonderados: 50, chamadas: 1 },
    ],
  },
};

const ESTIMATIVA_OK: ResultadoEstimativaDeRespostas = {
  status: "ok",
  estimativa: { tokensPorResposta: 40_000, respostasQueCabem: 65, baseadoEmAmostra: true },
};

describe("linhasDeTokensDeIA", () => {
  it("resposta boa (com teto): carteira, estimativa e extratos preenchidos", () => {
    const r = linhasDeTokensDeIA(SALDO_OK, EXTRATO_OK, ESTIMATIVA_OK);

    expect(r.leituraFalhou).toBe(false);
    expect(r.carteira).toEqual({
      semLimite: false,
      totalDisponivel: 3_100_000,
      totalConsumido: 500_000,
      percentual: 16, // round(500000/3100000*100)
      estourou: false,
      saldoNegativo: false,
      fontes: [
        { fonte: "plano", ...SALDO_OK.porFonte.plano },
        { fonte: "avulso", ...SALDO_OK.porFonte.avulso },
      ],
    });
    expect(r.estimativa).toEqual(ESTIMATIVA_OK.estimativa);
  });

  it("só as fontes com crédito aparecem, e o plano sempre, mesmo zerado", () => {
    const saldoSoPlanoZerado: ResultadoSaldoDaCarteira = {
      ...SALDO_OK,
      porFonte: { plano: FONTE_ZERADA, adicional: FONTE_ZERADA, avulso: FONTE_ZERADA },
    };

    const r = linhasDeTokensDeIA(saldoSoPlanoZerado, EXTRATO_OK, ESTIMATIVA_OK);

    expect(r.carteira?.fontes).toEqual([{ fonte: "plano", ...FONTE_ZERADA }]);
  });

  it("Ilimitado: semLimite true, sem totalDisponivel nem percentual, nunca estourado", () => {
    const r = linhasDeTokensDeIA(SALDO_SEM_LIMITE, EXTRATO_OK, ESTIMATIVA_OK);

    expect(r.carteira).toMatchObject({
      semLimite: true,
      totalDisponivel: null,
      totalConsumido: 820_000,
      percentual: null,
      estourou: false,
      saldoNegativo: false,
    });
  });

  it("consumo no teto (100%): percentual 100, estourou true, sem ser saldoNegativo", () => {
    const saldoNoTeto: ResultadoSaldoDaCarteira = {
      ...SALDO_OK,
      totalConsumido: 3_100_000,
    };

    const r = linhasDeTokensDeIA(saldoNoTeto, EXTRATO_OK, ESTIMATIVA_OK);

    expect(r.carteira).toMatchObject({ percentual: 100, estourou: true, saldoNegativo: false });
  });

  it("consumo ACIMA do disponível: saldoNegativo true, percentual limitado a 100", () => {
    const saldoNegativo: ResultadoSaldoDaCarteira = {
      ...SALDO_OK,
      totalConsumido: 4_000_000,
    };

    const r = linhasDeTokensDeIA(saldoNegativo, EXTRATO_OK, ESTIMATIVA_OK);

    expect(r.carteira).toMatchObject({ percentual: 100, estourou: true, saldoNegativo: true });
  });

  it("extrato por dia: mais recente primeiro", () => {
    const r = linhasDeTokensDeIA(SALDO_OK, EXTRATO_OK, ESTIMATIVA_OK);

    expect(r.extratoPorDia.map((l) => l.dia)).toEqual(["2026-09-03", "2026-09-02", "2026-09-01"]);
  });

  it("extrato por agente: maior consumo primeiro", () => {
    const r = linhasDeTokensDeIA(SALDO_OK, EXTRATO_OK, ESTIMATIVA_OK);

    expect(r.extratoPorAgente.map((l) => l.agentId)).toEqual(["a2", "a1", null]);
  });

  it("leitura do saldo falhou: nenhum número sai, nem do extrato nem da estimativa", () => {
    const r = linhasDeTokensDeIA({ status: "leitura_falhou" }, EXTRATO_OK, ESTIMATIVA_OK);

    expect(r).toEqual({
      leituraFalhou: true,
      carteira: null,
      estimativa: null,
      extratoPorDia: [],
      extratoPorAgente: [],
    });
  });

  it("leitura do extrato falhou: idem, mesmo com saldo e estimativa ok", () => {
    const r = linhasDeTokensDeIA(SALDO_OK, { status: "leitura_falhou" }, ESTIMATIVA_OK);

    expect(r.leituraFalhou).toBe(true);
    expect(r.carteira).toBeNull();
  });

  it("leitura da estimativa falhou: idem, mesmo com saldo e extrato ok", () => {
    const r = linhasDeTokensDeIA(SALDO_OK, EXTRATO_OK, { status: "leitura_falhou" });

    expect(r.leituraFalhou).toBe(true);
    expect(r.extratoPorDia).toEqual([]);
  });
});
