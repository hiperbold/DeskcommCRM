/**
 * `lib/billing/asaas/compra.ts`: fase F5, Tarefa 14.
 *
 * RESTRIÇÃO ABSOLUTA: nenhuma chamada real sai destes testes. `DbCompra` e
 * `ClienteAsaasHttp` são sempre dublês em memória (`vi.fn`); nenhum `fetch`
 * é usado aqui (o cliente HTTP de verdade já é testado com `fetch` falso em
 * `tests/unit/asaas-cliente.test.ts`). Nenhum CPF/CNPJ, e-mail ou chave
 * usados aqui é dado real: `111.444.777-35` é o mesmo CPF de teste (válido
 * pelo dígito verificador) já usado em `asaas-cliente.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";

import {
  cancelarAssinaturaDoCliente,
  iniciarCompra,
  MENSAGEM_AGUARDE,
  MENSAGEM_DOCUMENTO_INVALIDO,
  MENSAGEM_SEM_ASSINATURA_ASAAS,
  MENSAGEM_VALIDACAO,
  type DbCompra,
  type DepsCompra,
  type EntradaIniciarCompra,
  type PedidoLinha,
} from "@/lib/billing/asaas/compra";
import type { ClienteAsaasHttp } from "@/lib/billing/asaas/cliente";
import type { ConfigAsaas } from "@/lib/billing/asaas/config";
import type { AssinaturaAsaas, ClienteAsaas, CobrancaAsaas } from "@/lib/billing/asaas/contratos";
import { erroIndisponivel, erroTempoEsgotado, erroValidacao } from "@/lib/billing/asaas/erros";
import { centavosParaReais } from "@/lib/billing/asaas/dinheiro";

const CPF_VALIDO = "111.444.777-35";

const CONFIG_SANDBOX: ConfigAsaas = {
  habilitado: true,
  baseUrl: "https://api-sandbox.asaas.com/v3",
  apiKey: "$aact_hmlg_testeNuncaEUmaChaveReal000111222",
  webhookToken: "token-de-teste-nunca-real",
  webhookId: "",
  ambiente: "sandbox",
};

const ENTRADA_BASE: EntradaIniciarCompra = {
  organizationId: "org-1",
  actorId: "actor-1",
  tipo: "assinatura",
  planCode: "pro",
  ciclo: "monthly",
  metodo: "CREDIT_CARD",
  chave: "11111111-1111-1111-1111-111111111111",
  pagador: {
    nome: "Fulano de Tal",
    documento: CPF_VALIDO,
    email: "fulano@example.com",
    celular: "11999998888",
  },
};

function pedidoBase(overrides: Partial<PedidoLinha> = {}): PedidoLinha {
  return {
    id: "pedido-1",
    status: "criado",
    tipo: "assinatura",
    ambiente: "sandbox",
    metodo: "CREDIT_CARD",
    amountCents: 19900,
    externalReference: "HC:ord:pedido-1",
    asaasPaymentId: null,
    asaasSubscriptionId: null,
    invoiceUrl: null,
    ciclo: "monthly",
    planoNome: "Pro",
    pacoteNome: null,
    ...overrides,
  };
}

function cobrancaFake(overrides: Partial<CobrancaAsaas> = {}): CobrancaAsaas {
  return {
    id: "pay_fake123",
    customer: "cus_fake123",
    status: "PENDING",
    billingType: "CREDIT_CARD",
    value: 199,
    dueDate: "2026-09-25",
    externalReference: "HC:ord:pedido-1",
    invoiceUrl: "https://sandbox.asaas.com/i/fake123",
    valorConfirmado: 199,
    ...overrides,
  };
}

function assinaturaFake(overrides: Partial<AssinaturaAsaas> = {}): AssinaturaAsaas {
  return {
    id: "sub_fake123",
    customer: "cus_fake123",
    status: "ACTIVE",
    billingType: "CREDIT_CARD",
    cycle: "MONTHLY",
    value: 199,
    externalReference: "HC:ord:pedido-1",
    ...overrides,
  };
}

function clienteFake(overrides: Partial<ClienteAsaas> = {}): ClienteAsaas {
  return { id: "cus_fake123", externalReference: "HC:org:org-1", ...overrides };
}

/** Dublê do cliente Asaas: todo método responde algo neutro por padrão. */
function asaasFalso(overrides: Partial<ClienteAsaasHttp> = {}): ClienteAsaasHttp {
  return {
    buscarClientePorReferencia: vi.fn(async () => null),
    criarCliente: vi.fn(async () => clienteFake({ id: "cus_novo123" })),
    criarAssinatura: vi.fn(async () => assinaturaFake()),
    buscarAssinatura: vi.fn(async () => {
      throw new Error("buscarAssinatura não deveria ser chamado por compra.ts");
    }),
    listarCobrancasDaAssinatura: vi.fn(async () => [cobrancaFake({ id: "pay_da_assinatura" })]),
    buscarAssinaturaPorReferencia: vi.fn(async () => null),
    removerAssinatura: vi.fn(async () => undefined),
    criarCobranca: vi.fn(async () => cobrancaFake({ id: "pay_avulso123", billingType: "PIX", invoiceUrl: null })),
    buscarCobranca: vi.fn(async () => {
      throw new Error("buscarCobranca não deveria ser chamado por compra.ts");
    }),
    buscarCobrancaPorReferencia: vi.fn(async () => null),
    removerCobranca: vi.fn(async () => undefined),
    qrPix: vi.fn(async () => ({ encodedImage: "img-base64", payload: "00020126...", expirationDate: "2026-10-02T00:00:00Z" })),
    ...overrides,
  };
}

function loggerFalso() {
  const linhas: { nivel: string; msg: string; ctx?: Record<string, unknown> }[] = [];
  return {
    logger: {
      warn: (msg: string, ctx?: Record<string, unknown>) => linhas.push({ nivel: "warn", msg, ctx }),
      error: (msg: string, ctx?: Record<string, unknown>) => linhas.push({ nivel: "error", msg, ctx }),
    },
    linhas,
  };
}

/** Dublê do banco: um pedido em memória, mutado pelas próprias chamadas (simula o efeito das RPCs reais). */
function dbFalso(pedidoInicial: PedidoLinha, opts: { vinculo?: string | null } = {}) {
  let pedido: PedidoLinha = { ...pedidoInicial };
  let vinculo: string | null = opts.vinculo ?? null;

  const db: DbCompra = {
    criarPedido: vi.fn(async () => ({
      data: {
        pedidoId: pedido.id,
        externalReference: pedido.externalReference,
        amountCents: pedido.amountCents,
        jaExistia: false,
        proximaCobrancaEm: null,
      },
      error: null,
    })),
    buscarPedidoAbertoPorTipo: vi.fn(async () => ({ data: { ...pedido }, error: null })),
    tomarPedido: vi.fn(async () => {
      if (pedido.status === "criado" || pedido.status === "inconclusivo") {
        pedido = { ...pedido, status: "processando" };
        return { data: { tomado: true, pedidoId: pedido.id, status: pedido.status }, error: null };
      }
      return { data: { tomado: false, pedidoId: pedido.id, status: pedido.status }, error: null };
    }),
    lerPedido: vi.fn(async () => ({ data: { ...pedido }, error: null })),
    buscarVinculoClienteAsaas: vi.fn(async () => ({ data: vinculo ? { asaasCustomerId: vinculo } : null, error: null })),
    vincularClienteAsaas: vi.fn(async (_org, _ambiente, asaasCustomerId) => {
      vinculo = asaasCustomerId;
      return { data: { jaExistia: false, asaasCustomerId }, error: null };
    }),
    registrarCobranca: vi.fn(async (args) => {
      pedido = {
        ...pedido,
        asaasPaymentId: args.asaasPaymentId ?? pedido.asaasPaymentId,
        asaasSubscriptionId: args.asaasSubscriptionId ?? pedido.asaasSubscriptionId,
        invoiceUrl: args.invoiceUrl ?? pedido.invoiceUrl,
        status: "aguardando_pagamento",
      };
      return { data: { jaRegistrado: false, pedidoId: pedido.id, status: pedido.status }, error: null };
    }),
    marcarPedido: vi.fn(async (_org, _id, status) => {
      const statusAnterior = pedido.status;
      pedido = { ...pedido, status };
      return { data: { pedidoId: pedido.id, statusAnterior, statusNovo: status }, error: null };
    }),
    lerContrato: vi.fn(async () => ({ data: { asaasSubscriptionId: null, asaasAssinaturaEncerradaEm: null }, error: null })),
    cancelarNoFimDoPeriodo: vi.fn(async () => ({ data: { cancelAtPeriodEnd: true }, error: null })),
  };

  return { db, getPedido: () => pedido };
}

function dbStubVazio(): DbCompra {
  const naoDeveriaSerChamado = (nome: string) =>
    vi.fn(async () => {
      throw new Error(`dbStubVazio: ${nome} não deveria ser chamado neste teste`);
    });
  return {
    criarPedido: naoDeveriaSerChamado("criarPedido") as DbCompra["criarPedido"],
    buscarPedidoAbertoPorTipo: naoDeveriaSerChamado("buscarPedidoAbertoPorTipo") as DbCompra["buscarPedidoAbertoPorTipo"],
    tomarPedido: naoDeveriaSerChamado("tomarPedido") as DbCompra["tomarPedido"],
    lerPedido: naoDeveriaSerChamado("lerPedido") as DbCompra["lerPedido"],
    buscarVinculoClienteAsaas: naoDeveriaSerChamado("buscarVinculoClienteAsaas") as DbCompra["buscarVinculoClienteAsaas"],
    vincularClienteAsaas: naoDeveriaSerChamado("vincularClienteAsaas") as DbCompra["vincularClienteAsaas"],
    registrarCobranca: naoDeveriaSerChamado("registrarCobranca") as DbCompra["registrarCobranca"],
    marcarPedido: naoDeveriaSerChamado("marcarPedido") as DbCompra["marcarPedido"],
    lerContrato: naoDeveriaSerChamado("lerContrato") as DbCompra["lerContrato"],
    cancelarNoFimDoPeriodo: naoDeveriaSerChamado("cancelarNoFimDoPeriodo") as DbCompra["cancelarNoFimDoPeriodo"],
  };
}

function montarDeps(db: DbCompra, asaas: ClienteAsaasHttp, agora?: () => Date): { deps: DepsCompra; linhas: ReturnType<typeof loggerFalso>["linhas"] } {
  const { logger, linhas } = loggerFalso();
  return { deps: { db, asaas, config: CONFIG_SANDBOX, logger, agora }, linhas };
}

describe("iniciarCompra: caminho feliz", () => {
  it("assinatura no cartão devolve a fatura hospedada (redirecionar)", async () => {
    const { db } = dbFalso(pedidoBase());
    const asaas = asaasFalso();
    const { deps } = montarDeps(db, asaas);

    const resultado = await iniciarCompra(deps, ENTRADA_BASE);

    expect(resultado).toEqual({ tipo: "redirecionar", url: "https://sandbox.asaas.com/i/fake123" });
    expect(asaas.criarAssinatura).toHaveBeenCalledTimes(1);
  });

  it("pacote de tokens no Pix devolve o QR", async () => {
    const pedido = pedidoBase({ tipo: "pacote_tokens", metodo: "PIX", ciclo: null, planoNome: null, pacoteNome: "1000 tokens" });
    const { db } = dbFalso(pedido);
    const asaas = asaasFalso({
      criarCobranca: vi.fn(async () => cobrancaFake({ id: "pay_pix123", billingType: "PIX", invoiceUrl: null })),
    });
    const { deps } = montarDeps(db, asaas);

    const resultado = await iniciarCompra(deps, { ...ENTRADA_BASE, tipo: "pacote_tokens", ciclo: undefined, planCode: undefined, pacote: "mil-tokens" });

    expect(resultado).toEqual({
      tipo: "pix",
      pedidoId: "pedido-1",
      qr: { encodedImage: "img-base64", payload: "00020126...", expirationDate: "2026-10-02T00:00:00Z" },
    });
    expect(asaas.criarCobranca).toHaveBeenCalledTimes(1);
    expect(asaas.qrPix).toHaveBeenCalledWith("pay_pix123");
  });
});

describe("iniciarCompra: preço sempre do banco", () => {
  it("usa amountCents do pedido lido no banco, mesmo com entrada adulterada", async () => {
    const { db } = dbFalso(pedidoBase({ amountCents: 39900 }));
    const asaas = asaasFalso();
    const { deps } = montarDeps(db, asaas);

    // EntradaIniciarCompra não tem campo de preço; um campo estranho como
    // "amountCents" aqui só existiria se alguém forçasse `as any` numa
    // camada de fora (a ação, Tarefa 15). Mesmo assim, nada neste arquivo
    // lê esse campo: o valor mandado ao Asaas vem só de `db.lerPedido`.
    const entradaAdulterada = { ...ENTRADA_BASE, amountCents: 1 } as unknown as EntradaIniciarCompra;

    await iniciarCompra(deps, entradaAdulterada);

    const chamada = (asaas.criarAssinatura as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(chamada.value).toBe(centavosParaReais(39900));
  });
});

describe("iniciarCompra: posse atômica (decisão 25/A2)", () => {
  it("duas chamadas ao mesmo pedido: só uma faz o POST ao Asaas", async () => {
    const { db } = dbFalso(pedidoBase());
    const asaas = asaasFalso();
    const { deps } = montarDeps(db, asaas);

    const [a, b] = await Promise.all([
      iniciarCompra(deps, ENTRADA_BASE),
      iniciarCompra(deps, { ...ENTRADA_BASE, chave: "22222222-2222-2222-2222-222222222222" }),
    ]);

    expect(asaas.criarAssinatura).toHaveBeenCalledTimes(1);
    expect(db.tomarPedido).toHaveBeenCalledTimes(2);
    const tipos = [a.tipo, b.tipo].sort();
    expect(tipos).toEqual(["erro", "redirecionar"]);
  });
});

describe("iniciarCompra: recuperação do inconclusivo (decisão 13)", () => {
  it("timeout marca inconclusivo; a retentativa acha pela referência e não cobra em dobro", async () => {
    const { db, getPedido } = dbFalso(pedidoBase());
    const asaas = asaasFalso({
      criarAssinatura: vi.fn(async () => {
        throw erroTempoEsgotado(true);
      }),
    });
    const { deps } = montarDeps(db, asaas);

    const primeira = await iniciarCompra(deps, ENTRADA_BASE);
    expect(primeira).toEqual({ tipo: "erro", mensagem: MENSAGEM_AGUARDE });
    expect(getPedido().status).toBe("inconclusivo");
    expect(asaas.criarAssinatura).toHaveBeenCalledTimes(1);

    // A retentativa acha a assinatura já criada no Asaas por externalReference:
    // NUNCA chama criarAssinatura de novo.
    (asaas.buscarAssinaturaPorReferencia as ReturnType<typeof vi.fn>).mockResolvedValueOnce(assinaturaFake());

    const segunda = await iniciarCompra(deps, { ...ENTRADA_BASE, chave: "33333333-3333-3333-3333-333333333333" });

    expect(segunda.tipo).toBe("redirecionar");
    expect(asaas.criarAssinatura).toHaveBeenCalledTimes(1);
    expect(asaas.buscarAssinaturaPorReferencia).toHaveBeenCalledWith("HC:ord:pedido-1");
  });

  it("4xx de validação marca falhou com mensagem fixa, nunca a mensagem crua do Asaas", async () => {
    const { db, getPedido } = dbFalso(pedidoBase());
    const asaas = asaasFalso({
      criarAssinatura: vi.fn(async () => {
        throw erroValidacao(400, ["invalid_cpfCnpj"]);
      }),
    });
    const { deps } = montarDeps(db, asaas);

    const resultado = await iniciarCompra(deps, ENTRADA_BASE);

    expect(resultado).toEqual({ tipo: "erro", mensagem: MENSAGEM_VALIDACAO });
    expect(getPedido().status).toBe("falhou");
  });
});

describe("iniciarCompra: cliente Asaas (decisão 16)", () => {
  it("reaproveita o vínculo local: nunca busca nem cria cliente no Asaas", async () => {
    const { db } = dbFalso(pedidoBase(), { vinculo: "cus_vinculado123" });
    const asaas = asaasFalso();
    const { deps } = montarDeps(db, asaas);

    await iniciarCompra(deps, ENTRADA_BASE);

    expect(asaas.buscarClientePorReferencia).not.toHaveBeenCalled();
    expect(asaas.criarCliente).not.toHaveBeenCalled();
    const chamada = (asaas.criarAssinatura as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(chamada.customer).toBe("cus_vinculado123");
  });

  it("sem vínculo local, reaproveita o cliente achado por externalReference: nunca cria de novo", async () => {
    const { db } = dbFalso(pedidoBase());
    const asaas = asaasFalso({
      buscarClientePorReferencia: vi.fn(async () => clienteFake({ id: "cus_por_referencia" })),
    });
    const { deps } = montarDeps(db, asaas);

    await iniciarCompra(deps, ENTRADA_BASE);

    expect(asaas.criarCliente).not.toHaveBeenCalled();
    expect(db.vincularClienteAsaas).toHaveBeenCalledWith("org-1", "sandbox", "cus_por_referencia");
    const chamada = (asaas.criarAssinatura as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(chamada.customer).toBe("cus_por_referencia");
  });

  it("CPF inválido é recusado sem nenhuma chamada ao Asaas", async () => {
    const { db, getPedido } = dbFalso(pedidoBase());
    const asaas = asaasFalso();
    const { deps } = montarDeps(db, asaas);

    const entrada: EntradaIniciarCompra = {
      ...ENTRADA_BASE,
      pagador: { ...ENTRADA_BASE.pagador!, documento: "000.000.000-00" },
    };
    const resultado = await iniciarCompra(deps, entrada);

    expect(resultado).toEqual({ tipo: "erro", mensagem: MENSAGEM_DOCUMENTO_INVALIDO });
    expect(asaas.buscarClientePorReferencia).toHaveBeenCalled();
    expect(asaas.criarCliente).not.toHaveBeenCalled();
    expect(asaas.criarAssinatura).not.toHaveBeenCalled();
    expect(getPedido().status).toBe("falhou");
  });
});

describe("iniciarCompra: URL de redirecionamento (risco 8/B7)", () => {
  it("invoice_url fora da lista do ambiente é recusada e o pedido é marcado", async () => {
    const { db, getPedido } = dbFalso(pedidoBase());
    const asaas = asaasFalso({
      listarCobrancasDaAssinatura: vi.fn(async () => [
        cobrancaFake({ id: "pay_malicioso", invoiceUrl: "https://malicious.example.com/pagar" }),
      ]),
    });
    const dbComValidacao: DbCompra = {
      ...db,
      registrarCobranca: vi.fn(async (args) => {
        if (args.invoiceUrl && !/^https:\/\/sandbox\.asaas\.com\//.test(args.invoiceUrl)) {
          return { data: null, error: { code: "22023", message: "billing_invoice_url_fora_do_ambiente" } };
        }
        return { data: { jaRegistrado: false, pedidoId: args.pedidoId, status: "aguardando_pagamento" as const }, error: null };
      }),
    };
    const { deps } = montarDeps(dbComValidacao, asaas);

    const resultado = await iniciarCompra(deps, ENTRADA_BASE);

    expect(resultado).toEqual({ tipo: "erro", mensagem: expect.any(String) });
    expect((resultado as { mensagem: string }).mensagem).not.toContain("malicious.example.com");
    expect(getPedido().status).toBe("falhou");
  });
});

describe("iniciarCompra: pedido aberto retomado (M9)", () => {
  it("chave nova esbarra num pedido aberto do mesmo tipo: retoma, nunca cria um segundo", async () => {
    const pedidoExistente = pedidoBase({ id: "pedido-existente", status: "criado" });
    const { db: dbBase } = dbFalso(pedidoExistente);
    const db: DbCompra = {
      ...dbBase,
      criarPedido: vi.fn(async () => ({ data: null, error: { code: "22023", message: "billing_pedido_aberto_existe" } })),
    };
    const asaas = asaasFalso();
    const { deps } = montarDeps(db, asaas);

    const resultado = await iniciarCompra(deps, { ...ENTRADA_BASE, chave: "44444444-4444-4444-4444-444444444444" });

    expect(db.criarPedido).toHaveBeenCalledTimes(1);
    expect(db.buscarPedidoAbertoPorTipo).toHaveBeenCalledWith("org-1", "assinatura");
    expect(resultado.tipo).toBe("redirecionar");
    expect(asaas.criarAssinatura).toHaveBeenCalledTimes(1);
  });

  it("pedido aberto já com fatura registrada: devolve o que já existe, sem POST nenhum", async () => {
    const pedidoExistente = pedidoBase({
      id: "pedido-existente",
      status: "aguardando_pagamento",
      invoiceUrl: "https://sandbox.asaas.com/i/ja-existente",
      asaasSubscriptionId: "sub_existente123",
    });
    const { db } = dbFalso(pedidoExistente);
    const dbComRecusa: DbCompra = {
      ...db,
      criarPedido: vi.fn(async () => ({ data: null, error: { code: "22023", message: "billing_pedido_aberto_existe" } })),
    };
    const asaas = asaasFalso();
    const { deps } = montarDeps(dbComRecusa, asaas);

    const resultado = await iniciarCompra(deps, { ...ENTRADA_BASE, chave: "55555555-5555-5555-5555-555555555555" });

    expect(resultado).toEqual({ tipo: "redirecionar", url: "https://sandbox.asaas.com/i/ja-existente" });
    expect(asaas.criarAssinatura).not.toHaveBeenCalled();
    expect(dbComRecusa.tomarPedido).not.toHaveBeenCalled();
  });
});

describe("iniciarCompra: nextDueDate (decisão 26/A3)", () => {
  it("com período já pago, usa a data que o banco devolveu, nunca hoje", async () => {
    const { db: dbBase } = dbFalso(pedidoBase());
    const db: DbCompra = {
      ...dbBase,
      criarPedido: vi.fn(async () => ({
        data: { pedidoId: "pedido-1", externalReference: "HC:ord:pedido-1", amountCents: 19900, jaExistia: false, proximaCobrancaEm: "2026-11-15" },
        error: null,
      })),
    };
    const asaas = asaasFalso();
    const { deps } = montarDeps(db, asaas, () => new Date("2026-09-24T12:00:00Z"));

    await iniciarCompra(deps, ENTRADA_BASE);

    const chamada = (asaas.criarAssinatura as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(chamada.nextDueDate).toBe("2026-11-15");
    expect(chamada.nextDueDate).not.toBe("2026-09-24");
  });

  it("sem período vigente, usa hoje em São Paulo", async () => {
    const { db } = dbFalso(pedidoBase());
    const asaas = asaasFalso();
    const { deps } = montarDeps(db, asaas, () => new Date("2026-09-24T12:00:00Z"));

    await iniciarCompra(deps, ENTRADA_BASE);

    const chamada = (asaas.criarAssinatura as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(chamada.nextDueDate).toBe("2026-09-24");
  });
});

describe("iniciarCompra: description sem dado pessoal (decisão 4)", () => {
  it("descreve o plano e o ciclo, nunca o nome ou o documento do pagador", async () => {
    const { db } = dbFalso(pedidoBase({ planoNome: "Pro", ciclo: "monthly" }));
    const asaas = asaasFalso();
    const { deps } = montarDeps(db, asaas);

    await iniciarCompra(deps, ENTRADA_BASE);

    const chamada = (asaas.criarAssinatura as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(chamada.description).toBe("HiperCRM, plano Pro mensal");
    expect(chamada.description).not.toContain("Fulano");
    expect(chamada.description).not.toContain(CPF_VALIDO);
  });
});

describe("iniciarCompra: logs nunca carregam dado sensível", () => {
  it("nenhuma linha de log contém CPF, e-mail ou a chave do pedido", async () => {
    const { db } = dbFalso(pedidoBase());
    const asaas = asaasFalso({
      buscarClientePorReferencia: vi.fn(async () => null), // força passar por criarCliente, com o pagador inteiro em mãos
    });
    const { deps, linhas } = montarDeps(db, asaas);

    await iniciarCompra(deps, ENTRADA_BASE);

    const textoDosLogs = JSON.stringify(linhas);
    expect(textoDosLogs).not.toContain("111.444.777-35");
    expect(textoDosLogs).not.toContain("11144477735");
    expect(textoDosLogs).not.toContain("fulano@example.com");
    expect(textoDosLogs).not.toContain(ENTRADA_BASE.chave);
    expect(textoDosLogs).not.toContain("Fulano de Tal");
  });
});

describe("cancelarAssinaturaDoCliente", () => {
  it("primeiro remove no Asaas, só depois marca cancel_at_period_end no banco", async () => {
    const ordem: string[] = [];
    const asaas = asaasFalso({
      removerAssinatura: vi.fn(async () => {
        ordem.push("asaas_delete");
      }),
    });
    const db: DbCompra = {
      ...dbStubVazio(),
      lerContrato: vi.fn(async () => ({ data: { asaasSubscriptionId: "sub_ativo123", asaasAssinaturaEncerradaEm: null }, error: null })),
      cancelarNoFimDoPeriodo: vi.fn(async () => {
        ordem.push("banco_cancelar");
        return { data: { cancelAtPeriodEnd: true }, error: null };
      }),
    };
    const { deps } = montarDeps(db, asaas);

    const resultado = await cancelarAssinaturaDoCliente(deps, "org-1", "actor-1");

    expect(resultado).toEqual({ tipo: "ok", cancelAtPeriodEnd: true });
    expect(ordem).toEqual(["asaas_delete", "banco_cancelar"]);
  });

  it("DELETE no Asaas falhando nunca marca nada no banco", async () => {
    const asaas = asaasFalso({
      removerAssinatura: vi.fn(async () => {
        throw erroIndisponivel(500, false);
      }),
    });
    const cancelarNoFimDoPeriodo = vi.fn();
    const db: DbCompra = {
      ...dbStubVazio(),
      lerContrato: vi.fn(async () => ({ data: { asaasSubscriptionId: "sub_ativo123", asaasAssinaturaEncerradaEm: null }, error: null })),
      cancelarNoFimDoPeriodo: cancelarNoFimDoPeriodo as DbCompra["cancelarNoFimDoPeriodo"],
    };
    const { deps } = montarDeps(db, asaas);

    const resultado = await cancelarAssinaturaDoCliente(deps, "org-1", "actor-1");

    expect(resultado.tipo).toBe("erro");
    expect(cancelarNoFimDoPeriodo).not.toHaveBeenCalled();
  });

  it("404 do Asaas (assinatura já removida) é tratado como sucesso pelo cliente HTTP e segue o cancelamento", async () => {
    // removerAssinatura já trata 404 internamente (cliente.ts): resolve sem lançar.
    const asaas = asaasFalso({ removerAssinatura: vi.fn(async () => undefined) });
    const db: DbCompra = {
      ...dbStubVazio(),
      lerContrato: vi.fn(async () => ({ data: { asaasSubscriptionId: "sub_ja_removida", asaasAssinaturaEncerradaEm: null }, error: null })),
      cancelarNoFimDoPeriodo: vi.fn(async () => ({ data: { cancelAtPeriodEnd: true }, error: null })),
    };
    const { deps } = montarDeps(db, asaas);

    const resultado = await cancelarAssinaturaDoCliente(deps, "org-1", "actor-1");

    expect(resultado).toEqual({ tipo: "ok", cancelAtPeriodEnd: true });
  });

  it("sem assinatura Asaas na organização, não chama o Asaas nem o banco de escrita", async () => {
    const asaas = asaasFalso();
    const db: DbCompra = {
      ...dbStubVazio(),
      lerContrato: vi.fn(async () => ({ data: { asaasSubscriptionId: null, asaasAssinaturaEncerradaEm: null }, error: null })),
    };
    const { deps } = montarDeps(db, asaas);

    const resultado = await cancelarAssinaturaDoCliente(deps, "org-1", "actor-1");

    expect(resultado).toEqual({ tipo: "erro", mensagem: MENSAGEM_SEM_ASSINATURA_ASAAS });
    expect(asaas.removerAssinatura).not.toHaveBeenCalled();
  });

  it("assinatura já com o marcador de encerramento gravado não tenta remover de novo", async () => {
    const asaas = asaasFalso();
    const db: DbCompra = {
      ...dbStubVazio(),
      lerContrato: vi.fn(async () => ({
        data: { asaasSubscriptionId: "sub_ja_encerrada", asaasAssinaturaEncerradaEm: "2026-09-01T00:00:00Z" },
        error: null,
      })),
    };
    const { deps } = montarDeps(db, asaas);

    const resultado = await cancelarAssinaturaDoCliente(deps, "org-1", "actor-1");

    expect(resultado).toEqual({ tipo: "erro", mensagem: MENSAGEM_SEM_ASSINATURA_ASAAS });
    expect(asaas.removerAssinatura).not.toHaveBeenCalled();
  });
});
