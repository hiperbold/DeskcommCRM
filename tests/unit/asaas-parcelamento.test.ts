import { describe, expect, it } from "vitest";

import {
  calcularParcelamento,
  dividirTotalEmParcelas,
  maximoDeParcelas,
  opcoesDeParcelamento,
  parcelasValidas,
} from "@/lib/billing/asaas/parcelamento";

/** Os valores que a migration 0945 semeia em billing_settings (decisão do Filipe em 06/10/2026). */
const PARAMETROS_DE_REFERENCIA = { taxaMensal: 0.0199, semJurosAte: 3, maxSemestral: 6, maxAnual: 12 };

/**
 * D-177, parte 1: a conta do parcelamento do semestral e do anual no cartão. Taxa de 1,99% ao mês pelo
 * comprador a partir da 4a parcela, Tabela Price, parcela arredondada ao centavo (half-up) e total =
 * parcela x n. De 1x a 3x o total é o preço do ciclo (a Hiperbold arca com a taxa do cartão). Os valores
 * de conferência são os da decisão do Filipe em 06/10/2026.
 */

const PRO_SEMESTRAL = 104900;
const PRO_ANUAL = 189900;

describe("calcularParcelamento: Tabela Price a 1,99% ao mês (valores de conferência da decisão)", () => {
  it("Pro semestral 4x: parcela 27543, total 110172", () => {
    const r = calcularParcelamento(PRO_SEMESTRAL, 4, PARAMETROS_DE_REFERENCIA);
    expect(r.parcelaCents).toBe(27543);
    expect(r.totalCents).toBe(110172);
    expect(r.comJuros).toBe(true);
  });

  it("Pro semestral 6x: parcela 18721, total 112326", () => {
    const r = calcularParcelamento(PRO_SEMESTRAL, 6, PARAMETROS_DE_REFERENCIA);
    expect(r.parcelaCents).toBe(18721);
    expect(r.totalCents).toBe(112326);
  });

  it("Pro anual 4x: parcela 49860, total 199440", () => {
    const r = calcularParcelamento(PRO_ANUAL, 4, PARAMETROS_DE_REFERENCIA);
    expect(r.parcelaCents).toBe(49860);
    expect(r.totalCents).toBe(199440);
  });

  it("Pro anual 12x: parcela 17946, total 215352", () => {
    const r = calcularParcelamento(PRO_ANUAL, 12, PARAMETROS_DE_REFERENCIA);
    expect(r.parcelaCents).toBe(17946);
    expect(r.totalCents).toBe(215352);
  });

  it("com juros o total é sempre parcela x n, sem sobra na última", () => {
    for (let n = 4; n <= 12; n += 1) {
      const r = calcularParcelamento(PRO_ANUAL, n, PARAMETROS_DE_REFERENCIA);
      expect(r.totalCents).toBe(r.parcelaCents * n);
      expect(r.ultimaParcelaCents).toBe(r.parcelaCents);
    }
  });
});

describe("calcularParcelamento: 1x, 2x e 3x sem juros", () => {
  it("1x, 2x e 3x têm o total igual ao preço do ciclo", () => {
    for (const n of [1, 2, 3]) {
      const r = calcularParcelamento(PRO_SEMESTRAL, n, PARAMETROS_DE_REFERENCIA);
      expect(r.totalCents).toBe(PRO_SEMESTRAL);
      expect(r.comJuros).toBe(false);
    }
  });

  it("3x do Pro semestral: o Asaas divide o total e a diferença de arredondamento vai para a última (349,66 x 2 e 349,68, medido no sandbox em 07/10/2026)", () => {
    const r = calcularParcelamento(PRO_SEMESTRAL, 3, PARAMETROS_DE_REFERENCIA);
    expect(r.parcelaCents).toBe(34966);
    expect(r.ultimaParcelaCents).toBe(34968);
    expect(r.parcelaCents * 2 + r.ultimaParcelaCents).toBe(PRO_SEMESTRAL);
  });

  it("divisão exata não mexe na última (2x do Pro semestral, 3x do Pro anual)", () => {
    expect(calcularParcelamento(PRO_SEMESTRAL, 2, PARAMETROS_DE_REFERENCIA)).toMatchObject({
      parcelaCents: 52450,
      ultimaParcelaCents: 52450,
    });
    expect(calcularParcelamento(PRO_ANUAL, 3, PARAMETROS_DE_REFERENCIA)).toMatchObject({
      parcelaCents: 63300,
      ultimaParcelaCents: 63300,
    });
  });

  it("a soma das parcelas é sempre o total, para qualquer preço e qualquer número de parcelas", () => {
    for (const preco of [104900, 189900, 214900, 379900, 319900, 574900, 100001, 99999]) {
      for (let n = 1; n <= 12; n += 1) {
        const r = calcularParcelamento(preco, n, PARAMETROS_DE_REFERENCIA);
        expect(r.parcelaCents * (n - 1) + r.ultimaParcelaCents).toBe(r.totalCents);
      }
    }
  });
});

describe("dividirTotalEmParcelas: a regra do Asaas (totalValue)", () => {
  it("arredonda a parcela ao centavo e joga a diferença na última", () => {
    expect(dividirTotalEmParcelas(104900, 3)).toEqual({ parcelaCents: 34966, ultimaParcelaCents: 34968 });
    expect(dividirTotalEmParcelas(100000, 3)).toEqual({ parcelaCents: 33333, ultimaParcelaCents: 33334 });
    expect(dividirTotalEmParcelas(100000, 1)).toEqual({ parcelaCents: 100000, ultimaParcelaCents: 100000 });
  });
});

describe("teto de parcelas e validação", () => {
  it("semestral até 6x e anual até 12x com os parâmetros de referência", () => {
    expect(maximoDeParcelas("semiannual", PARAMETROS_DE_REFERENCIA)).toBe(6);
    expect(maximoDeParcelas("yearly", PARAMETROS_DE_REFERENCIA)).toBe(12);
  });

  it("parcelasValidas recusa zero, negativo, fracionado e acima do teto do ciclo", () => {
    expect(parcelasValidas("semiannual", 6, PARAMETROS_DE_REFERENCIA)).toBe(true);
    expect(parcelasValidas("semiannual", 7, PARAMETROS_DE_REFERENCIA)).toBe(false);
    expect(parcelasValidas("yearly", 12, PARAMETROS_DE_REFERENCIA)).toBe(true);
    expect(parcelasValidas("yearly", 13, PARAMETROS_DE_REFERENCIA)).toBe(false);
    expect(parcelasValidas("yearly", 0, PARAMETROS_DE_REFERENCIA)).toBe(false);
    expect(parcelasValidas("yearly", -1, PARAMETROS_DE_REFERENCIA)).toBe(false);
    expect(parcelasValidas("yearly", 2.5, PARAMETROS_DE_REFERENCIA)).toBe(false);
  });

  it("calcularParcelamento recusa número de parcelas inválido em vez de devolver conta errada", () => {
    expect(() => calcularParcelamento(PRO_ANUAL, 0, PARAMETROS_DE_REFERENCIA)).toThrow();
    expect(() => calcularParcelamento(PRO_ANUAL, 1.5, PARAMETROS_DE_REFERENCIA)).toThrow();
  });

  it("opcoesDeParcelamento lista de 1x até o teto, com juros só a partir de 4x", () => {
    const semestral = opcoesDeParcelamento(PRO_SEMESTRAL, "semiannual", PARAMETROS_DE_REFERENCIA);
    expect(semestral.map((o) => o.parcelas)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(semestral.map((o) => o.comJuros)).toEqual([false, false, false, true, true, true]);

    const anual = opcoesDeParcelamento(PRO_ANUAL, "yearly", PARAMETROS_DE_REFERENCIA);
    expect(anual).toHaveLength(12);
    expect(anual[11]).toMatchObject({ parcelas: 12, parcelaCents: 17946, totalCents: 215352, comJuros: true });
  });

  it("sem parâmetros de parcelamento (taxa ou teto ausentes), só existe o 1x", () => {
    const semConfig = { taxaMensal: null, semJurosAte: null, maxSemestral: null, maxAnual: null };
    expect(opcoesDeParcelamento(PRO_ANUAL, "yearly", semConfig).map((o) => o.parcelas)).toEqual([1]);
    expect(maximoDeParcelas("semiannual", semConfig)).toBe(1);
  });
});
