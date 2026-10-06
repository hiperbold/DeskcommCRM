/**
 * D-176: venda do plano no ciclo SEMESTRAL e ANUAL, à vista. Cobre as peças em TypeScript:
 * o ciclo do Asaas (`SEMIANNUALLY`), a compra (`iniciarCompra`) com o ciclo e o valor do período
 * que o banco decidiu, a recusa da troca de ciclo, a leitura do preço do catálogo e a conta do
 * total e da economia que a tela mostra.
 *
 * Nenhuma chamada real sai daqui: `DbCompra` e `ClienteAsaasHttp` são dublês em memória, o mesmo
 * padrão de `asaas-compra.test.ts`. O preço do período é sempre o `amountCents` do pedido lido no
 * banco; a SQL (preço por ciclo, período, tokens, estorno) é provada em
 * `tests/invariants/venda-semestral-e-anual-banco.test.ts`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  ciclosDisponiveis,
  MESES_DO_CICLO,
  precoDoCiclo,
  resumoDoCiclo,
  type PrecosDoPlano,
} from "@/app/app/settings/plano/_logica-compra";
import type { ClienteAsaasHttp } from "@/lib/billing/asaas/cliente";
import { DICIONARIO } from "@/lib/i18n/dicionario";
import type { ConfigAsaas } from "@/lib/billing/asaas/config";
import {
  assinaturaAsaasSchema,
  cicloAsaasSchema,
  criarAssinaturaRequestSchema,
  type AssinaturaAsaas,
  type CobrancaAsaas,
} from "@/lib/billing/asaas/contratos";
import {
  CICLO_ASAAS_DO_PEDIDO,
  iniciarCompra,
  MENSAGEM_GENERICA,
  MENSAGEM_TROCA_DE_CICLO,
  MENSAGEM_TROCA_DE_PLANO,
  type DbCompra,
  type EntradaIniciarCompra,
  type PedidoLinha,
} from "@/lib/billing/asaas/compra";

// ─── 1. O ciclo do Asaas ──────────────────────────────────────────────────

describe("cicloAsaasSchema: o semestral entra, e só os três ciclos de venda", () => {
  it("aceita MONTHLY, SEMIANNUALLY e YEARLY", () => {
    for (const ciclo of ["MONTHLY", "SEMIANNUALLY", "YEARLY"]) {
      expect(cicloAsaasSchema.safeParse(ciclo).success).toBe(true);
    }
  });

  it("recusa ciclo que a venda não oferece (trimestral, bimestral, minúsculas)", () => {
    for (const ciclo of ["QUARTERLY", "BIMONTHLY", "WEEKLY", "semiannually", ""]) {
      expect(cicloAsaasSchema.safeParse(ciclo).success).toBe(false);
    }
  });

  it("criarAssinaturaRequestSchema aceita SEMIANNUALLY com o valor do período", () => {
    const pedido = criarAssinaturaRequestSchema.parse({
      customer: "cus_000009287353",
      billingType: "CREDIT_CARD",
      value: 1049,
      nextDueDate: "2026-10-08",
      cycle: "SEMIANNUALLY",
      description: "HiperCRM, plano Pro semestral",
      externalReference: "HC:ord:abc",
    });
    expect(pedido.cycle).toBe("SEMIANNUALLY");
    expect(pedido.value).toBe(1049);
  });

  it("a resposta real do sandbox (30/09/2026: SEMIANNUALLY, nextDueDate seis meses adiante) passa no parse", () => {
    const assinatura = assinaturaAsaasSchema.parse({
      id: "sub_03sv65n3po5oxzd4",
      customer: "cus_000009287353",
      status: "ACTIVE",
      billingType: "CREDIT_CARD",
      cycle: "SEMIANNUALLY",
      value: 1049,
      nextDueDate: "2027-03-30",
      creditCard: null,
    });
    expect(assinatura.cycle).toBe("SEMIANNUALLY");
    expect(assinatura.nextDueDate).toBe("2027-03-30");
  });

  it("cada ciclo do pedido tem o seu ciclo no Asaas, e nenhum fica sem par", () => {
    expect(CICLO_ASAAS_DO_PEDIDO).toEqual({ monthly: "MONTHLY", semiannual: "SEMIANNUALLY", yearly: "YEARLY" });
  });
});

// ─── 2. A compra ──────────────────────────────────────────────────────────

const CONFIG: ConfigAsaas = {
  habilitado: true,
  baseUrl: "https://api-sandbox.asaas.com/v3",
  apiKey: "$aact_hmlg_testeNuncaEUmaChaveReal000111222",
  webhookToken: "token-de-teste-nunca-real",
  webhookId: "",
  ambiente: "sandbox",
};

const ENTRADA: EntradaIniciarCompra = {
  organizationId: "org-1",
  actorId: "actor-1",
  tipo: "assinatura",
  planCode: "pro",
  ciclo: "semiannual",
  metodo: "CREDIT_CARD",
  chave: "11111111-1111-1111-1111-111111111111",
};

function pedidoDe(ciclo: "monthly" | "semiannual" | "yearly", amountCents: number, metodo: "CREDIT_CARD" | "PIX"): PedidoLinha {
  return {
    id: "pedido-1",
    status: "criado",
    tipo: "assinatura",
    ambiente: "sandbox",
    metodo,
    amountCents,
    externalReference: "HC:ord:pedido-1",
    asaasPaymentId: null,
    asaasSubscriptionId: null,
    invoiceUrl: null,
    ciclo,
    planoNome: "Pro",
    pacoteNome: null,
    planCode: "pro",
    pacoteCode: null,
    atualizadoEm: "2026-10-08T12:00:00Z",
  };
}

function cobranca(overrides: Partial<CobrancaAsaas> = {}): CobrancaAsaas {
  return {
    id: "pay_fake123",
    customer: "cus_fake123",
    status: "PENDING",
    billingType: "CREDIT_CARD",
    value: 1049,
    dueDate: "2026-10-08",
    externalReference: "HC:ord:pedido-1",
    invoiceUrl: "https://sandbox.asaas.com/i/fake123",
    valorConfirmado: 1049,
    ...overrides,
  };
}

function assinatura(overrides: Partial<AssinaturaAsaas> = {}): AssinaturaAsaas {
  return {
    id: "sub_fake123",
    customer: "cus_fake123",
    status: "ACTIVE",
    billingType: "CREDIT_CARD",
    cycle: "SEMIANNUALLY",
    value: 1049,
    externalReference: "HC:ord:pedido-1",
    ...overrides,
  };
}

/** O banco devolve o pedido já resolvido (preço e ciclo do catálogo); o cliente do Asaas só anota o que recebeu. */
function montar(pedido: PedidoLinha, opcoes: { erroDoPedido?: string } = {}) {
  let atual = { ...pedido };
  const db: DbCompra = {
    criarPedido: vi.fn(async () =>
      opcoes.erroDoPedido
        ? { data: null, error: { code: "22023", message: opcoes.erroDoPedido } }
        : {
            data: {
              pedidoId: atual.id,
              externalReference: atual.externalReference,
              amountCents: atual.amountCents,
              jaExistia: false,
              proximaCobrancaEm: null,
            },
            error: null,
          },
    ),
    buscarPedidoAbertoPorTipo: vi.fn(async () => ({ data: null, error: null })),
    tomarPedido: vi.fn(async () => {
      atual = { ...atual, status: "processando" };
      return { data: { tomado: true, pedidoId: atual.id, status: atual.status }, error: null };
    }),
    lerPedido: vi.fn(async () => ({ data: { ...atual }, error: null })),
    buscarVinculoClienteAsaas: vi.fn(async () => ({ data: { asaasCustomerId: "cus_fake123" }, error: null })),
    vincularClienteAsaas: vi.fn(),
    registrarCobranca: vi.fn(async (args) => {
      atual = {
        ...atual,
        status: "aguardando_pagamento",
        asaasPaymentId: args.asaasPaymentId,
        asaasSubscriptionId: args.asaasSubscriptionId,
        invoiceUrl: args.invoiceUrl,
      };
      return { data: { jaRegistrado: false, pedidoId: atual.id, status: atual.status }, error: null };
    }),
    marcarPedido: vi.fn(async (_org, _id, status) => ({
      data: { pedidoId: atual.id, statusAnterior: atual.status, statusNovo: status },
      error: null,
    })),
    lerContrato: vi.fn(async () => ({
      data: { asaasSubscriptionId: null, asaasAssinaturaEncerradaEm: null, currentPeriodEnd: null },
      error: null,
    })),
    marcarAssinaturaEncerrada: vi.fn(),
  };
  const asaas = {
    buscarClientePorReferencia: vi.fn(),
    criarCliente: vi.fn(),
    criarAssinatura: vi.fn(async () => assinatura()),
    listarCobrancasDaAssinatura: vi.fn(async () => [cobranca()]),
    buscarAssinaturaPorReferencia: vi.fn(async () => null),
    criarCobranca: vi.fn(async () => cobranca({ id: "pay_pix123", billingType: "PIX", invoiceUrl: null })),
    buscarCobrancaPorReferencia: vi.fn(async () => null),
    qrPix: vi.fn(async () => ({ encodedImage: "img", payload: "00020126", expirationDate: null })),
  } as unknown as ClienteAsaasHttp;
  const logs: string[] = [];
  const logger = { warn: (m: string) => logs.push(m), error: (m: string) => logs.push(m) };
  return { deps: { db, asaas, config: CONFIG, logger, agora: () => new Date("2026-10-08T15:00:00Z") }, db, asaas, logs };
}

describe("iniciarCompra: ciclo e valor do período vão para a assinatura do Asaas", () => {
  it("semestral no cartão: assinatura SEMIANNUALLY com o valor do período (R$ 1.049,00) e vencimento hoje", async () => {
    const { deps, asaas } = montar(pedidoDe("semiannual", 104900, "CREDIT_CARD"));

    const r = await iniciarCompra(deps, ENTRADA);

    expect(r).toEqual({ tipo: "redirecionar", url: "https://sandbox.asaas.com/i/fake123" });
    expect(asaas.criarAssinatura).toHaveBeenCalledTimes(1);
    const chamada = (asaas.criarAssinatura as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(chamada).toMatchObject({
      billingType: "CREDIT_CARD",
      cycle: "SEMIANNUALLY",
      value: 1049,
      nextDueDate: "2026-10-08",
      description: "HiperCRM, plano Pro semestral",
      externalReference: "HC:ord:pedido-1",
    });
    // O período é UMA assinatura de ciclo longo: nunca doze cobranças mensais nem parcelamento.
    expect(asaas.criarCobranca).not.toHaveBeenCalled();
  });

  it("anual no cartão: assinatura YEARLY com o valor do período (R$ 1.899,00)", async () => {
    const { deps, asaas } = montar(pedidoDe("yearly", 189900, "CREDIT_CARD"));

    await iniciarCompra(deps, { ...ENTRADA, ciclo: "yearly" });

    const chamada = (asaas.criarAssinatura as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(chamada).toMatchObject({ cycle: "YEARLY", value: 1899, description: "HiperCRM, plano Pro anual" });
  });

  it("mensal continua MONTHLY, sem mudança de comportamento", async () => {
    const { deps, asaas } = montar(pedidoDe("monthly", 19900, "CREDIT_CARD"));

    await iniciarCompra(deps, { ...ENTRADA, ciclo: "monthly" });

    const chamada = (asaas.criarAssinatura as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(chamada).toMatchObject({ cycle: "MONTHLY", value: 199, description: "HiperCRM, plano Pro mensal" });
  });

  it("o valor cobrado é o do pedido lido no banco, nunca o que a entrada sugere", async () => {
    const { deps, asaas } = montar(pedidoDe("semiannual", 104900, "CREDIT_CARD"));

    await iniciarCompra(deps, { ...ENTRADA, ...({ amountCents: 1, valor: 1 } as object) });

    const chamada = (asaas.criarAssinatura as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(chamada.value).toBe(1049);
  });

  it("semestral no Pix: cobrança avulsa PIX do período inteiro (não renova sozinha), sem assinatura", async () => {
    const { deps, asaas } = montar(pedidoDe("semiannual", 104900, "PIX"));

    const r = await iniciarCompra(deps, { ...ENTRADA, metodo: "PIX" });

    expect(r.tipo).toBe("pix");
    expect(asaas.criarAssinatura).not.toHaveBeenCalled();
    const chamada = (asaas.criarCobranca as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(chamada).toMatchObject({ billingType: "PIX", value: 1049, description: "HiperCRM, plano Pro semestral" });
  });
});

describe("iniciarCompra: troca de ciclo e preço do ciclo", () => {
  it("contrato ativo em outro ciclo: mensagem própria, nenhum POST ao Asaas e nenhum pedido tomado", async () => {
    const { deps, asaas, db } = montar(pedidoDe("semiannual", 104900, "CREDIT_CARD"), {
      erroDoPedido: "billing_troca_de_ciclo_indisponivel",
    });

    const r = await iniciarCompra(deps, ENTRADA);

    expect(r).toEqual({ tipo: "erro", mensagem: MENSAGEM_TROCA_DE_CICLO });
    expect(MENSAGEM_TROCA_DE_CICLO).toMatch(/troca de ciclo/i);
    expect(asaas.criarAssinatura).not.toHaveBeenCalled();
    expect(asaas.criarCobranca).not.toHaveBeenCalled();
    expect(db.tomarPedido).not.toHaveBeenCalled();
  });

  it("contrato ativo com período pago de OUTRO plano (0942): mensagem própria, nenhum POST ao Asaas e nenhum pedido tomado", async () => {
    const { deps, asaas, db } = montar(pedidoDe("yearly", 189900, "PIX"), {
      erroDoPedido: "billing_troca_de_plano_indisponivel",
    });

    const r = await iniciarCompra(deps, ENTRADA);

    expect(r).toEqual({ tipo: "erro", mensagem: MENSAGEM_TROCA_DE_PLANO });
    expect(MENSAGEM_TROCA_DE_PLANO).toMatch(/troca de plano/i);
    expect(MENSAGEM_TROCA_DE_PLANO).not.toBe(MENSAGEM_TROCA_DE_CICLO);
    expect(asaas.criarAssinatura).not.toHaveBeenCalled();
    expect(asaas.criarCobranca).not.toHaveBeenCalled();
    expect(db.tomarPedido).not.toHaveBeenCalled();
  });

  it("a frase da troca de plano tem tradução para es e zh-CN no dicionário", () => {
    expect(DICIONARIO[MENSAGEM_TROCA_DE_PLANO]?.es).toMatch(/cambio de plan/i);
    const zh = JSON.parse(readFileSync(join(process.cwd(), "lib/i18n/traducoes/zh-CN.json"), "utf8")) as Record<string, string>;
    expect(zh[MENSAGEM_TROCA_DE_PLANO]).toMatch(/套餐/);
  });

  it("plano sem preço no ciclo: a mensagem de preço não definido, nunca a genérica", async () => {
    const { deps, asaas } = montar(pedidoDe("semiannual", 104900, "CREDIT_CARD"), { erroDoPedido: "billing_preco_nao_definido" });

    const r = await iniciarCompra(deps, ENTRADA);

    expect(r).toEqual({ tipo: "erro", mensagem: "O preço desta oferta ainda não foi definido." });
    expect(asaas.criarAssinatura).not.toHaveBeenCalled();
  });

  it("erro que o serviço não conhece continua com a mensagem genérica (nada cru do banco)", async () => {
    const { deps } = montar(pedidoDe("semiannual", 104900, "CREDIT_CARD"), { erroDoPedido: "billing_ciclo_invalido" });

    const r = await iniciarCompra(deps, ENTRADA);

    expect(r).toEqual({ tipo: "erro", mensagem: MENSAGEM_GENERICA });
  });
});

// ─── 3. Os preços e a economia que a tela mostra ──────────────────────────

const PRO: PrecosDoPlano = { priceMonthlyCents: 19900, priceSemiannualCents: 104900, priceYearlyCents: 189900 };
const MAX: PrecosDoPlano = { priceMonthlyCents: 39900, priceSemiannualCents: 214900, priceYearlyCents: 379900 };
const ESCALE: PrecosDoPlano = { priceMonthlyCents: 59900, priceSemiannualCents: 319900, priceYearlyCents: 574900 };

describe("precoDoCiclo e ciclosDisponiveis: só o que tem preço no catálogo", () => {
  it("plano com os três preços oferece mensal, semestral e anual, nessa ordem", () => {
    expect(ciclosDisponiveis(PRO)).toEqual(["monthly", "semiannual", "yearly"]);
    expect(precoDoCiclo(PRO, "semiannual")).toBe(104900);
    expect(precoDoCiclo(PRO, "yearly")).toBe(189900);
  });

  it("preço nulo ou zero esconde o ciclo; o mensal continua", () => {
    expect(ciclosDisponiveis({ ...PRO, priceSemiannualCents: null })).toEqual(["monthly", "yearly"]);
    expect(ciclosDisponiveis({ ...PRO, priceYearlyCents: 0 })).toEqual(["monthly", "semiannual"]);
    expect(ciclosDisponiveis({ priceMonthlyCents: 19900, priceSemiannualCents: null, priceYearlyCents: null })).toEqual(["monthly"]);
  });

  it("os meses de cada ciclo", () => {
    expect(MESES_DO_CICLO).toEqual({ monthly: 1, semiannual: 6, yearly: 12 });
  });
});

describe("resumoDoCiclo: total do período e economia, calculados só dos preços", () => {
  it.each([
    ["Pro", PRO, "semiannual", 104900, 14500, 12],
    ["Pro", PRO, "yearly", 189900, 48900, 20],
    ["Max", MAX, "semiannual", 214900, 24500, 10],
    ["Max", MAX, "yearly", 379900, 98900, 20],
    ["Escale", ESCALE, "semiannual", 319900, 39500, 10],
    ["Escale", ESCALE, "yearly", 574900, 143900, 20],
  ] as const)("%s %s: total %i, economia %i, %i%%", (_nome, plano, ciclo, total, economia, percentual) => {
    const r = resumoDoCiclo(plano, ciclo);
    expect(r).not.toBeNull();
    expect(r!.totalCents).toBe(total);
    expect(r!.economiaCents).toBe(economia);
    expect(r!.economiaPercentual).toBe(percentual);
    expect(r!.totalNoMensalCents - r!.economiaCents).toBe(total);
  });

  it("o percentual arredonda para baixo: 12,1% aparece como 12%, nunca 13%", () => {
    expect(resumoDoCiclo(PRO, "semiannual")!.economiaPercentual).toBe(12);
  });

  it("o mensal não tem economia contra si mesmo", () => {
    const r = resumoDoCiclo(PRO, "monthly");
    expect(r).toMatchObject({ totalCents: 19900, meses: 1, economiaCents: 0, economiaPercentual: 0 });
  });

  it("ciclo mais caro que o mensal pelo mesmo período não vira economia negativa", () => {
    const r = resumoDoCiclo({ priceMonthlyCents: 10000, priceSemiannualCents: 70000, priceYearlyCents: null }, "semiannual");
    expect(r!.economiaCents).toBe(0);
    expect(r!.economiaPercentual).toBe(0);
  });

  it("ciclo sem preço, ou plano sem preço mensal para comparar, não tem resumo", () => {
    expect(resumoDoCiclo({ ...PRO, priceSemiannualCents: null }, "semiannual")).toBeNull();
    expect(resumoDoCiclo({ priceMonthlyCents: 0, priceSemiannualCents: 100, priceYearlyCents: null }, "semiannual")).toBeNull();
  });
});
