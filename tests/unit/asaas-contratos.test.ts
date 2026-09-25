/**
 * `lib/billing/asaas/contratos.ts`: schemas zod das respostas do Asaas que
 * este app usa, e o `coalesce(originalValue, value)` fixado no schema da
 * cobrança (decisão M5).
 */
import { describe, expect, it } from "vitest";

import {
  clienteAsaasSchema,
  cobrancaAsaasSchema,
  criarCobrancaRequestSchema,
  envelopeWebhookAsaasSchema,
  listaCobrancasSchema,
  qrPixAsaasSchema,
} from "@/lib/billing/asaas/contratos";

describe("cobrancaAsaasSchema: coalesce(originalValue, value)", () => {
  it("usa originalValue quando presente", () => {
    const c = cobrancaAsaasSchema.parse({
      id: "pay_123",
      customer: "cus_123",
      status: "RECEIVED",
      billingType: "PIX",
      value: 199.9,
      originalValue: 250,
      dueDate: "2026-10-01",
    });
    expect(c.valorConfirmado).toBe(250);
  });

  it("cai em value quando originalValue é nulo/ausente", () => {
    const c = cobrancaAsaasSchema.parse({
      id: "pay_123",
      customer: "cus_123",
      status: "RECEIVED",
      billingType: "PIX",
      value: 199.9,
      dueDate: "2026-10-01",
    });
    expect(c.valorConfirmado).toBe(199.9);
  });

  it("aceita campos desconhecidos (o Asaas pode acrescentar campos)", () => {
    const c = cobrancaAsaasSchema.parse({
      id: "pay_123",
      customer: "cus_123",
      status: "RECEIVED",
      billingType: "PIX",
      value: 100,
      dueDate: "2026-10-01",
      campoNovoQueOAsaasAcrescentouDepois: "x",
    });
    expect(c.id).toBe("pay_123");
  });

  it("recusa um id de cobrança fora do formato pay_...", () => {
    expect(() =>
      cobrancaAsaasSchema.parse({
        id: "not-a-payment",
        customer: "cus_123",
        status: "RECEIVED",
        billingType: "PIX",
        value: 100,
        dueDate: "2026-10-01",
      }),
    ).toThrow();
  });

  it("recusa dueDate fora do formato AAAA-MM-DD", () => {
    expect(() =>
      cobrancaAsaasSchema.parse({
        id: "pay_123",
        customer: "cus_123",
        status: "RECEIVED",
        billingType: "PIX",
        value: 100,
        dueDate: "01/10/2026",
      }),
    ).toThrow();
  });
});

describe("listaCobrancasSchema", () => {
  it("valida a lista paginada e cada item dentro dela", () => {
    const lista = listaCobrancasSchema.parse({
      object: "list",
      hasMore: false,
      data: [
        {
          id: "pay_1",
          customer: "cus_1",
          status: "PENDING",
          billingType: "PIX",
          value: 100,
          dueDate: "2026-10-01",
        },
      ],
    });
    expect(lista.data).toHaveLength(1);
    expect(lista.data[0]!.valorConfirmado).toBe(100);
  });
});

describe("clienteAsaasSchema", () => {
  it("recusa um id de cliente fora do formato cus_...", () => {
    expect(() => clienteAsaasSchema.parse({ id: "cliente-qualquer" })).toThrow();
  });
});

describe("criarCobrancaRequestSchema", () => {
  it("recusa value zero ou negativo (nunca cobrança de graça por engano)", () => {
    expect(() =>
      criarCobrancaRequestSchema.parse({
        customer: "cus_123",
        billingType: "PIX",
        value: 0,
        dueDate: "2026-10-01",
      }),
    ).toThrow();
  });
});

describe("qrPixAsaasSchema", () => {
  it("valida o envelope de QR", () => {
    const qr = qrPixAsaasSchema.parse({
      encodedImage: "base64...",
      payload: "000201...",
      expirationDate: "2026-10-01 23:59:00",
    });
    expect(qr.payload).toBe("000201...");
  });
});

describe("envelopeWebhookAsaasSchema", () => {
  it("valida id, event e o payment embutido", () => {
    const env = envelopeWebhookAsaasSchema.parse({
      id: "evt_123",
      event: "PAYMENT_RECEIVED",
      payment: {
        id: "pay_1",
        customer: "cus_1",
        status: "RECEIVED",
        billingType: "PIX",
        value: 100,
        dueDate: "2026-10-01",
      },
    });
    expect(env.event).toBe("PAYMENT_RECEIVED");
    expect(env.payment?.id).toBe("pay_1");
    expect(env.payment?.customer).toBe("cus_1");
  });

  it("recusa event fora do formato MAIUSCULO_COM_UNDERSCORE", () => {
    expect(() => envelopeWebhookAsaasSchema.parse({ id: "evt_1", event: "payment.received" })).toThrow();
  });

  it("payment/subscription são tolerantes: um subcampo fora do formato da API de verdade não derruba o envelope inteiro", () => {
    // `dueDate` num formato estranho e `value` como texto derrubariam
    // `cobrancaAsaasSchema` (usada para validar a RESPOSTA de verdade da
    // API); no envelope do webhook isso não pode jogar um evento
    // AUTENTICADO para a quarentena (correção de tolerância do envelope).
    const env = envelopeWebhookAsaasSchema.parse({
      id: "evt_tolerante",
      event: "PAYMENT_OVERDUE",
      payment: {
        id: "pay_estranho",
        customer: "cus_1",
        subscription: "sub_1",
        externalReference: "HC:ord:pedido-1",
        status: "OVERDUE",
        value: "cem reais",
        dueDate: "data invalida",
      },
    });
    expect(env.payment?.id).toBe("pay_estranho");
    expect(env.payment?.subscription).toBe("sub_1");
    expect(env.payment?.externalReference).toBe("HC:ord:pedido-1");
  });

  it("id/event continuam obrigatórios mesmo com payment/subscription tolerantes", () => {
    expect(() => envelopeWebhookAsaasSchema.parse({ event: "PAYMENT_CREATED", payment: {} })).toThrow();
    expect(() => envelopeWebhookAsaasSchema.parse({ id: "evt_1", payment: {} })).toThrow();
  });
});
