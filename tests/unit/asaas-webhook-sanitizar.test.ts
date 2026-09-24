// `lib/billing/asaas/sanitizar.ts`: fase F5, Tarefa 12, decisão 19.
import { describe, expect, it } from "vitest";

import { sanitizarPayloadAsaas } from "@/lib/billing/asaas/sanitizar";

describe("sanitizarPayloadAsaas", () => {
  it("remove creditCard, creditCardToken e creditCardHolderInfo no primeiro nível", () => {
    const saida = sanitizarPayloadAsaas({
      id: "evt_1",
      creditCard: { number: "4111" },
      creditCardToken: "tok_x",
      creditCardHolderInfo: { cpfCnpj: "123" },
      value: 100,
    }) as Record<string, unknown>;
    expect(saida).toEqual({ id: "evt_1", value: 100 });
  });

  it("remove qualquer chave com 'card' no nome, em qualquer profundidade", () => {
    const saida = sanitizarPayloadAsaas({
      payment: {
        id: "pay_1",
        nested: {
          outroCardField: "segredo",
          maisFundo: { cardNumberMasked: "**** 1111", ok: true },
        },
      },
    }) as Record<string, unknown>;
    const payment = saida.payment as Record<string, unknown>;
    const nested = payment.nested as Record<string, unknown>;
    expect(nested.outroCardField).toBeUndefined();
    const maisFundo = nested.maisFundo as Record<string, unknown>;
    expect(maisFundo.cardNumberMasked).toBeUndefined();
    expect(maisFundo.ok).toBe(true);
    expect(payment.id).toBe("pay_1");
  });

  it("é case-insensitive (CreditCard, CARDNUMBER, etc.)", () => {
    const saida = sanitizarPayloadAsaas({
      CreditCard: "x",
      CARDNUMBER: "y",
      cardholderName: "z",
      mantem: "isto fica",
    }) as Record<string, unknown>;
    expect(Object.keys(saida)).toEqual(["mantem"]);
  });

  it("sanitiza dentro de arrays", () => {
    const saida = sanitizarPayloadAsaas({
      itens: [{ creditCard: "x", ok: 1 }, { ok: 2 }],
    }) as { itens: Array<Record<string, unknown>> };
    expect(saida.itens).toEqual([{ ok: 1 }, { ok: 2 }]);
  });

  it("não remove chave sem 'card' no nome, mesmo com valor parecido", () => {
    const saida = sanitizarPayloadAsaas({ description: "cobrança do cartão de crédito" }) as Record<
      string,
      unknown
    >;
    // A varredura é por CHAVE, nunca por valor: apagar por conteúdo do texto
    // livre não é o contrato desta função (e destruiria descrições legítimas).
    expect(saida.description).toBe("cobrança do cartão de crédito");
  });

  it("não muda o objeto original (cópia, sem mutação)", () => {
    const original = { creditCard: "x", ok: 1 };
    const saida = sanitizarPayloadAsaas(original) as Record<string, unknown>;
    expect(original.creditCard).toBe("x");
    expect(saida.creditCard).toBeUndefined();
  });

  it("primitivos e null passam intactos", () => {
    expect(sanitizarPayloadAsaas(null)).toBeNull();
    expect(sanitizarPayloadAsaas(42)).toBe(42);
    expect(sanitizarPayloadAsaas("texto")).toBe("texto");
    expect(sanitizarPayloadAsaas(true)).toBe(true);
  });
});
