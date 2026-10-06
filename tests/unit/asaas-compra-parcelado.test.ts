/**
 * D-177, parte 1: `iniciarCompra` do semestral e do anual PARCELADO no cartão. Nenhuma chamada real: banco e
 * cliente Asaas são dublês em memória. O que se mede: o total com juros é calculado no servidor (o navegador só
 * manda o número de parcelas), 2x ou mais vira cobrança parcelada avulsa (`installmentCount` + `totalValue`,
 * sem assinatura), 1x segue a assinatura de sempre, e o id do parcelamento vai para o pedido antes da cobrança.
 */
import { describe, expect, it, vi } from "vitest";

import {
  iniciarCompra,
  MENSAGEM_AGUARDE,
  MENSAGEM_PARCELAMENTO_INDISPONIVEL,
  type DbCompra,
  type DepsCompra,
  type EntradaIniciarCompra,
  type PedidoLinha,
} from "@/lib/billing/asaas/compra";
import type { ClienteAsaasHttp } from "@/lib/billing/asaas/cliente";
import type { CobrancaAsaas } from "@/lib/billing/asaas/contratos";

const PARAMETROS = { taxaMensal: 0.0199, semJurosAte: 3, maxSemestral: 6, maxAnual: 12 };
const INSTALLMENT = "7315c152-a55f-4727-aa6c-d48249df28d4";

function pedidoBase(parcelas: number, amountCents: number, ciclo: "semiannual" | "yearly" = "semiannual"): PedidoLinha {
  return {
    id: "pedido-1",
    status: "criado",
    tipo: "assinatura",
    ambiente: "sandbox",
    metodo: "CREDIT_CARD",
    amountCents,
    externalReference: "HC:ord:pedido-1",
    asaasPaymentId: null,
    asaasSubscriptionId: null,
    invoiceUrl: null,
    parcelas,
    asaasInstallmentId: null,
    ciclo,
    planoNome: "Pro",
    pacoteNome: null,
    planCode: "pro",
    pacoteCode: null,
    atualizadoEm: "2026-10-06T12:00:00Z",
  };
}

function primeiraParcela(): CobrancaAsaas {
  return {
    id: "pay_parcela1",
    customer: "cus_fake123",
    status: "PENDING",
    billingType: "CREDIT_CARD",
    value: 275.43,
    dueDate: "2026-10-06",
    externalReference: "HC:ord:pedido-1",
    invoiceUrl: "https://sandbox.asaas.com/i/parcela1",
    installment: INSTALLMENT,
    valorConfirmado: 275.43,
  } as CobrancaAsaas;
}

function montar(parcelas: number, amountCents: number, opcoes: { registrarParcelamentoFalha?: boolean } = {}) {
  let pedido = pedidoBase(parcelas, amountCents);
  const ordem: string[] = [];
  const db: DbCompra = {
    criarPedido: vi.fn(async () => ({
      data: { pedidoId: pedido.id, externalReference: pedido.externalReference, amountCents, parcelas, jaExistia: false, proximaCobrancaEm: null },
      error: null,
    })),
    lerParcelamentoDoPlano: vi.fn(async () => ({ data: { precoCents: 104900, parametros: PARAMETROS }, error: null })),
    registrarParcelamento: vi.fn(async () => {
      ordem.push("registrarParcelamento");
      return opcoes.registrarParcelamentoFalha
        ? { data: null, error: { code: "22023", message: "falhou" } }
        : { data: { jaRegistrado: false }, error: null };
    }),
    buscarPedidoAbertoPorTipo: vi.fn(async () => ({ data: null, error: null })),
    tomarPedido: vi.fn(async () => {
      pedido = { ...pedido, status: "processando" };
      return { data: { tomado: true, pedidoId: pedido.id, status: pedido.status }, error: null };
    }),
    lerPedido: vi.fn(async () => ({ data: { ...pedido }, error: null })),
    buscarVinculoClienteAsaas: vi.fn(async () => ({ data: { asaasCustomerId: "cus_fake123" }, error: null })),
    vincularClienteAsaas: vi.fn(),
    registrarCobranca: vi.fn(async (args) => {
      ordem.push("registrarCobranca");
      pedido = { ...pedido, status: "aguardando_pagamento", invoiceUrl: args.invoiceUrl };
      return { data: { jaRegistrado: false, pedidoId: pedido.id, status: pedido.status }, error: null };
    }),
    marcarPedido: vi.fn(async () => ({ data: null, error: null })),
    lerContrato: vi.fn(async () => ({ data: null, error: null })),
    marcarAssinaturaEncerrada: vi.fn(),
  };
  const asaas = {
    criarCobrancaParcelada: vi.fn(async () => primeiraParcela()),
    criarAssinatura: vi.fn(async () => ({ id: "sub_fake123", customer: "cus_fake123", status: "ACTIVE", billingType: "CREDIT_CARD", cycle: "SEMIANNUALLY", value: 1049 })),
    listarCobrancasDaAssinatura: vi.fn(async () => [{ ...primeiraParcela(), installment: null }]),
    criarCobranca: vi.fn(),
    removerParcelamento: vi.fn(async () => undefined),
    removerCobranca: vi.fn(async () => undefined),
    removerAssinatura: vi.fn(async () => undefined),
  } as unknown as ClienteAsaasHttp;
  const deps: DepsCompra = {
    db,
    asaas,
    config: { habilitado: true, baseUrl: "https://api-sandbox.asaas.com/v3", apiKey: "$aact_hmlg_teste", webhookToken: "t", webhookId: "", ambiente: "sandbox" },
    logger: { warn: vi.fn(), error: vi.fn() },
    agora: () => new Date("2026-10-06T15:00:00Z"),
  };
  return { db, asaas, deps, ordem };
}

const entrada = (sobre: Partial<EntradaIniciarCompra> = {}): EntradaIniciarCompra => ({
  organizationId: "org-1",
  actorId: "user-1",
  tipo: "assinatura",
  planCode: "pro",
  ciclo: "semiannual",
  metodo: "CREDIT_CARD",
  chave: "chave-1",
  termosVersao: "2026-09-23",
  ...sobre,
});

describe("iniciarCompra parcelado (D-177)", () => {
  it("semestral 4x: o servidor calcula o total (R$ 1.101,72), cria cobrança parcelada avulsa e não cria assinatura", async () => {
    const { db, asaas, deps } = montar(4, 110172);
    const r = await iniciarCompra(deps, entrada({ parcelas: 4 }));

    expect(db.criarPedido).toHaveBeenCalledWith(expect.objectContaining({ parcelas: 4, totalCents: 110172 }));
    expect(asaas.criarCobrancaParcelada).toHaveBeenCalledWith({
      customer: "cus_fake123",
      billingType: "CREDIT_CARD",
      installmentCount: 4,
      totalValue: 1101.72,
      dueDate: "2026-10-06",
      description: "HiperCRM, plano Pro semestral em 4x",
      externalReference: "HC:ord:pedido-1",
    });
    expect(asaas.criarAssinatura).not.toHaveBeenCalled();
    expect(r).toEqual({ tipo: "redirecionar", url: "https://sandbox.asaas.com/i/parcela1" });
  });

  it("o id do parcelamento vai para o pedido ANTES de registrar a cobrança", async () => {
    const { db, deps, ordem } = montar(3, 104900);
    await iniciarCompra(deps, entrada({ parcelas: 3 }));
    expect(db.registrarParcelamento).toHaveBeenCalledWith("org-1", "pedido-1", INSTALLMENT);
    expect(ordem).toEqual(["registrarParcelamento", "registrarCobranca"]);
  });

  it("falha ao gravar o id do parcelamento: pede para aguardar e não registra a cobrança", async () => {
    const { db, deps } = montar(3, 104900, { registrarParcelamentoFalha: true });
    const r = await iniciarCompra(deps, entrada({ parcelas: 3 }));
    expect(r).toEqual({ tipo: "erro", mensagem: MENSAGEM_AGUARDE });
    expect(db.registrarCobranca).not.toHaveBeenCalled();
  });

  it("1x segue exatamente como antes: assinatura do Asaas, sem cobrança parcelada, sem total", async () => {
    const { db, asaas, deps } = montar(1, 104900);
    await iniciarCompra(deps, entrada({ parcelas: 1 }));
    expect(db.criarPedido).toHaveBeenCalledWith(expect.objectContaining({ parcelas: 1, totalCents: null }));
    expect(asaas.criarAssinatura).toHaveBeenCalledWith(expect.objectContaining({ cycle: "SEMIANNUALLY", value: 1049 }));
    expect(asaas.criarCobrancaParcelada).not.toHaveBeenCalled();
    expect(db.registrarParcelamento).not.toHaveBeenCalled();
  });

  it("acima do teto do ciclo (7x no semestral) é recusado sem criar pedido nem chamar o Asaas", async () => {
    const { db, asaas, deps } = montar(7, 120000);
    const r = await iniciarCompra(deps, entrada({ parcelas: 7 }));
    expect(r).toEqual({ tipo: "erro", mensagem: MENSAGEM_PARCELAMENTO_INDISPONIVEL });
    expect(db.criarPedido).not.toHaveBeenCalled();
    expect(asaas.criarCobrancaParcelada).not.toHaveBeenCalled();
  });

  it("Pix e mensal não parcelam: recusados antes de qualquer leitura ou chamada", async () => {
    const pix = montar(4, 110172);
    expect(await iniciarCompra(pix.deps, entrada({ parcelas: 4, metodo: "PIX" }))).toEqual({ tipo: "erro", mensagem: MENSAGEM_PARCELAMENTO_INDISPONIVEL });
    const mensal = montar(2, 20000);
    expect(await iniciarCompra(mensal.deps, entrada({ parcelas: 2, ciclo: "monthly" }))).toEqual({ tipo: "erro", mensagem: MENSAGEM_PARCELAMENTO_INDISPONIVEL });
    expect(pix.db.criarPedido).not.toHaveBeenCalled();
    expect(mensal.db.criarPedido).not.toHaveBeenCalled();
  });

  it("número de parcelas que não é inteiro é recusado", async () => {
    const { db, deps } = montar(2, 104900);
    const r = await iniciarCompra(deps, entrada({ parcelas: 2.5 }));
    expect(r).toEqual({ tipo: "erro", mensagem: MENSAGEM_PARCELAMENTO_INDISPONIVEL });
    expect(db.criarPedido).not.toHaveBeenCalled();
  });
});
