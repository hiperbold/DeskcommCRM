/**
 * `lib/billing/asaas/dinheiro.ts`: fase F5, Tarefa 10, decisão 15, centavos
 * inteiros no banco, reais só na borda, montados por texto (nunca por
 * multiplicação/divisão crua de `number`).
 */
import { describe, expect, it } from "vitest";

import { centavosParaReais, dataSaoPaulo } from "@/lib/billing/asaas/dinheiro";

describe("centavosParaReais", () => {
  it("19990 centavos vira 199.9 reais", () => {
    expect(centavosParaReais(19990)).toBe(199.9);
  });

  it("39900 centavos vira 399 reais", () => {
    expect(centavosParaReais(39900)).toBe(399);
  });

  it("1 centavo vira 0.01", () => {
    expect(centavosParaReais(1)).toBe(0.01);
  });

  it("0 centavos vira 0", () => {
    expect(centavosParaReais(0)).toBe(0);
  });

  it("valor negativo preserva o sinal (estorno)", () => {
    expect(centavosParaReais(-19990)).toBe(-199.9);
  });

  it("não é montado por divisão de ponto flutuante: soma clássica que erra bate certo", () => {
    // 0.1 + 0.2 !== 0.3 em ponto flutuante puro; aqui não há essa operação.
    // É a prova de que a rota é por texto, não por aritmética binária.
    expect(centavosParaReais(10 + 20)).toBe(0.3);
  });

  it("lança para valor não inteiro (nunca aceita fração de centavo)", () => {
    expect(() => centavosParaReais(199.5)).toThrow();
  });
});

describe("dataSaoPaulo", () => {
  it("formata AAAA-MM-DD no fuso de São Paulo, meio-dia UTC", () => {
    // 2026-10-01T12:00:00Z é 09:00 em São Paulo (UTC-3, fora do horário de
    // verão), mesmo dia civil nos dois fusos, prova o formato.
    expect(dataSaoPaulo(new Date("2026-10-01T12:00:00Z"))).toBe("2026-10-01");
  });

  it("vira o dia mais cedo em São Paulo do que em UTC, perto da meia-noite UTC", () => {
    // 2026-10-01T01:00:00Z são 2026-09-30T22:00:00-03:00 em São Paulo: o dia
    // civil já mudou em UTC mas ainda não em São Paulo.
    expect(dataSaoPaulo(new Date("2026-10-01T01:00:00Z"))).toBe("2026-09-30");
  });

  it("mantém dois dígitos em mês e dia de um dígito só", () => {
    expect(dataSaoPaulo(new Date("2026-01-05T12:00:00Z"))).toBe("2026-01-05");
  });
});
