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
  MENSAGEM_TERMOS_NAO_ACEITOS,
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
  termosVersao: "2026-09-23",
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
    planCode: "pro",
    pacoteCode: null,
    atualizadoEm: "2026-09-24T12:00:00Z",
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
    atualizarCliente: vi.fn(async (id: string) => clienteFake({ id, notificationDisabled: true })),
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
    criarCobrancaParcelada: vi.fn(async () => {
      throw new Error("criarCobrancaParcelada não deveria ser chamado neste teste");
    }),
    buscarParcelamento: vi.fn(async () => ({ removido: true as const })),
    removerParcelamento: vi.fn(async () => undefined),
    listarCobrancasDoParcelamento: vi.fn(async () => []),
    qrPix: vi.fn(async () => ({ encodedImage: "img-base64", payload: "00020126...", expirationDate: "2026-10-02T00:00:00Z" })),
    buscarWebhook: vi.fn(async () => {
      throw new Error("buscarWebhook não deveria ser chamado por compra.ts");
    }),
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
    lerParcelamentoDoPlano: vi.fn(async () => ({
      data: { precoCents: 104900, parametros: { taxaMensal: 0.0199, semJurosAte: 3, maxSemestral: 6, maxAnual: 12 } },
      error: null,
    })),
    registrarParcelamento: vi.fn(async () => ({ data: { jaRegistrado: false }, error: null })),
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
    // Correção 2 (revisão da fase): imita o comportamento REAL de
    // fn_billing_pedido_registrar_cobranca a partir de `aguardando_
    // pagamento` (migração 0909, Tarefa 3): reenviar exatamente o que já
    // está gravado é idempotente (`ja_registrado: true`); COMPLETAR um campo
    // que ainda estava nulo (ex.: `invoice_url` chegando agora, correção 4)
    // também é aceito; só uma cobrança DIFERENTE de uma já gravada e
    // preenchida (conflito de verdade) é recusada com `22023`. A partir de
    // `criado`/`processando`/`inconclusivo`, sempre transita normalmente.
    registrarCobranca: vi.fn(async (args) => {
      if (pedido.status === "aguardando_pagamento") {
        const conflita = (antigo: string | null, novo: string | null) =>
          antigo !== null && novo !== null && antigo !== novo;
        if (
          conflita(pedido.asaasPaymentId, args.asaasPaymentId) ||
          conflita(pedido.asaasSubscriptionId, args.asaasSubscriptionId) ||
          conflita(pedido.invoiceUrl, args.invoiceUrl)
        ) {
          return { data: null, error: { code: "22023", message: "billing_pedido_status_invalido_para_cobranca" } };
        }
        const nadaMudou =
          (args.asaasPaymentId ?? null) === pedido.asaasPaymentId &&
          (args.asaasSubscriptionId ?? null) === pedido.asaasSubscriptionId &&
          (args.invoiceUrl ?? null) === pedido.invoiceUrl;
        pedido = {
          ...pedido,
          asaasPaymentId: args.asaasPaymentId ?? pedido.asaasPaymentId,
          asaasSubscriptionId: args.asaasSubscriptionId ?? pedido.asaasSubscriptionId,
          invoiceUrl: args.invoiceUrl ?? pedido.invoiceUrl,
        };
        return { data: { jaRegistrado: nadaMudou, pedidoId: pedido.id, status: pedido.status }, error: null };
      }
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
    lerContrato: vi.fn(async () => ({
      data: { asaasSubscriptionId: null, asaasAssinaturaEncerradaEm: null, currentPeriodEnd: null },
      error: null,
    })),
    marcarAssinaturaEncerrada: vi.fn(async () => ({
      data: { jaRegistrado: false, asaasAssinaturaEncerradaEm: "2026-09-24T00:00:00Z" },
      error: null,
    })),
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
    marcarAssinaturaEncerrada: naoDeveriaSerChamado("marcarAssinaturaEncerrada") as DbCompra["marcarAssinaturaEncerrada"],
    lerParcelamentoDoPlano: naoDeveriaSerChamado("lerParcelamentoDoPlano") as DbCompra["lerParcelamentoDoPlano"],
    registrarParcelamento: naoDeveriaSerChamado("registrarParcelamento") as DbCompra["registrarParcelamento"],
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
    const pedido = pedidoBase({
      tipo: "pacote_tokens",
      metodo: "PIX",
      ciclo: null,
      planoNome: null,
      pacoteNome: "1000 tokens",
      planCode: null,
      pacoteCode: "mil-tokens",
    });
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

  it("timeout marca inconclusivo; se a retentativa NÃO conseguir consultar por referência, aguarda sem POST", async () => {
    const { db, getPedido } = dbFalso(pedidoBase());
    const asaas = asaasFalso({
      criarAssinatura: vi.fn(async () => {
        throw erroTempoEsgotado(true);
      }),
    });
    const { deps } = montarDeps(db, asaas);

    await iniciarCompra(deps, ENTRADA_BASE);
    expect(getPedido().status).toBe("inconclusivo");

    (asaas.buscarAssinaturaPorReferencia as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("504"));

    const segunda = await iniciarCompra(deps, { ...ENTRADA_BASE, chave: "66666666-6666-6666-6666-666666666666" });

    expect(segunda).toEqual({ tipo: "erro", mensagem: MENSAGEM_AGUARDE });
    expect(asaas.criarAssinatura).toHaveBeenCalledTimes(1); // nunca um segundo POST
  });

  it("correção 1: se a consulta por referência falhar, o pedido volta a inconclusivo (nunca fica preso em processando), e uma TERCEIRA chamada retoma", async () => {
    const { db, getPedido } = dbFalso(pedidoBase());
    const asaas = asaasFalso({
      criarAssinatura: vi.fn(async () => {
        throw erroTempoEsgotado(true);
      }),
    });
    const { deps } = montarDeps(db, asaas);

    await iniciarCompra(deps, ENTRADA_BASE);
    expect(getPedido().status).toBe("inconclusivo");

    (asaas.buscarAssinaturaPorReferencia as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("504"));

    const segunda = await iniciarCompra(deps, { ...ENTRADA_BASE, chave: "66666666-6666-6666-6666-666666666666" });

    expect(segunda).toEqual({ tipo: "erro", mensagem: MENSAGEM_AGUARDE });
    // `tomarPedido` já tinha movido o pedido para "processando" antes da
    // consulta falhar; sem a correção, ele ficaria preso ali (fora do
    // alcance de fn_billing_pedido_tomar, que só toma de criado/
    // inconclusivo) até a conciliação diária alcançar.
    expect(getPedido().status).toBe("inconclusivo");
    expect(db.marcarPedido).toHaveBeenCalledWith(
      "org-1",
      "pedido-1",
      "inconclusivo",
      expect.any(String),
    );

    // Terceira chamada: a consulta por referência agora funciona, e o
    // pedido, de volta a "inconclusivo", pode ser tomado de novo.
    (asaas.buscarAssinaturaPorReferencia as ReturnType<typeof vi.fn>).mockResolvedValueOnce(assinaturaFake());

    const terceira = await iniciarCompra(deps, { ...ENTRADA_BASE, chave: "99999999-9999-9999-9999-999999999999" });

    expect(terceira.tipo).toBe("redirecionar");
    expect(asaas.criarAssinatura).toHaveBeenCalledTimes(1); // nunca um segundo POST
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

  it("D-087: cliente novo nasce com notificationDisabled: true (o Asaas não manda e-mail de cobrança)", async () => {
    const { db } = dbFalso(pedidoBase());
    const asaas = asaasFalso();
    const { deps } = montarDeps(db, asaas);

    await iniciarCompra(deps, ENTRADA_BASE);

    const dados = (asaas.criarCliente as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(dados.notificationDisabled).toBe(true);
    expect(dados.externalReference).toBe("HC:org:org-1");
    // Criado já calado: nenhum PUT depois.
    expect(asaas.atualizarCliente).not.toHaveBeenCalled();
  });

  it("D-087: cliente reaproveitado por externalReference com notificações ligadas é atualizado UMA vez", async () => {
    const { db } = dbFalso(pedidoBase());
    const asaas = asaasFalso({
      buscarClientePorReferencia: vi.fn(async () => clienteFake({ id: "cus_por_referencia", notificationDisabled: false })),
    });
    const { deps } = montarDeps(db, asaas);

    await iniciarCompra(deps, ENTRADA_BASE);

    expect(asaas.atualizarCliente).toHaveBeenCalledTimes(1);
    expect(asaas.atualizarCliente).toHaveBeenCalledWith("cus_por_referencia", { notificationDisabled: true });
    expect(asaas.criarCliente).not.toHaveBeenCalled();
  });

  it("D-087: cliente reaproveitado sem o campo na resposta também é atualizado (campo ausente = ligado)", async () => {
    const { db } = dbFalso(pedidoBase());
    const asaas = asaasFalso({
      buscarClientePorReferencia: vi.fn(async () => clienteFake({ id: "cus_por_referencia" })),
    });
    const { deps } = montarDeps(db, asaas);

    await iniciarCompra(deps, ENTRADA_BASE);

    expect(asaas.atualizarCliente).toHaveBeenCalledTimes(1);
  });

  it("D-087: cliente reaproveitado que já está desligado NÃO chama o update", async () => {
    const { db } = dbFalso(pedidoBase());
    const asaas = asaasFalso({
      buscarClientePorReferencia: vi.fn(async () => clienteFake({ id: "cus_por_referencia", notificationDisabled: true })),
    });
    const { deps } = montarDeps(db, asaas);

    await iniciarCompra(deps, ENTRADA_BASE);

    expect(asaas.atualizarCliente).not.toHaveBeenCalled();
    expect(db.vincularClienteAsaas).toHaveBeenCalledWith("org-1", "sandbox", "cus_por_referencia");
  });

  it("D-087: vínculo local existente não gasta nenhuma chamada extra (nem GET nem PUT)", async () => {
    const { db } = dbFalso(pedidoBase(), { vinculo: "cus_vinculado123" });
    const asaas = asaasFalso();
    const { deps } = montarDeps(db, asaas);

    await iniciarCompra(deps, ENTRADA_BASE);

    expect(asaas.atualizarCliente).not.toHaveBeenCalled();
    expect(asaas.buscarClientePorReferencia).not.toHaveBeenCalled();
  });

  it("D-087: se o update falha, a compra segue (o script de manutenção fecha o que sobrar) e o log não leva dado pessoal", async () => {
    const { db } = dbFalso(pedidoBase());
    const asaas = asaasFalso({
      buscarClientePorReferencia: vi.fn(async () => clienteFake({ id: "cus_por_referencia" })),
      atualizarCliente: vi.fn(async () => {
        throw erroIndisponivel(503, true);
      }),
    });
    const { deps, linhas } = montarDeps(db, asaas);

    const resultado = await iniciarCompra(deps, ENTRADA_BASE);

    expect(resultado.tipo).toBe("redirecionar");
    expect(asaas.criarAssinatura).toHaveBeenCalled();
    const aviso = linhas.find((l) => l.msg === "asaas_compra_desligar_notificacoes_falhou");
    expect(aviso?.ctx).toEqual({ tipoErro: "indisponivel" });
    expect(JSON.stringify(linhas)).not.toContain(CPF_VALIDO);
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
    // Correção 8: a assinatura recém-criada é removida no Asaas ANTES de
    // marcar falhou (nunca deixa uma cobrança fantasma cobrando sozinha).
    expect(asaas.removerAssinatura).toHaveBeenCalledWith("sub_fake123");
  });

  it("correção 8: se a remoção no Asaas falhar, marca inconclusivo em vez de falhou (a conciliação retoma)", async () => {
    const { db, getPedido } = dbFalso(pedidoBase());
    const asaas = asaasFalso({
      listarCobrancasDaAssinatura: vi.fn(async () => [
        cobrancaFake({ id: "pay_malicioso", invoiceUrl: "https://malicious.example.com/pagar" }),
      ]),
      removerAssinatura: vi.fn(async () => {
        throw erroIndisponivel(500, false);
      }),
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
    expect(asaas.removerAssinatura).toHaveBeenCalledWith("sub_fake123");
    expect(getPedido().status).toBe("inconclusivo");
  });

  it("D-072: a segunda validação (TS), depois que o banco já aceitou a invoice_url, remove o recém-criado e marca falhou", async () => {
    // O dublê de `registrarCobranca` aqui NÃO valida a URL (imita o "banco já
    // aceitou"): só a validação em TypeScript, que roda depois, recusa.
    const { db, getPedido } = dbFalso(pedidoBase());
    const asaas = asaasFalso({
      listarCobrancasDaAssinatura: vi.fn(async () => [
        cobrancaFake({ id: "pay_url_ruim", invoiceUrl: "https://fora-da-lista.example.com/pagar" }),
      ]),
    });
    const { deps } = montarDeps(db, asaas);

    const resultado = await iniciarCompra(deps, ENTRADA_BASE);

    expect(resultado).toEqual({ tipo: "erro", mensagem: expect.any(String) });
    expect((resultado as { mensagem: string }).mensagem).not.toContain("fora-da-lista.example.com");
    expect(getPedido().status).toBe("falhou");
    expect(asaas.removerAssinatura).toHaveBeenCalledWith("sub_fake123");
  });

  it("D-072: se a remoção no Asaas falhar depois da segunda validação, marca inconclusivo (a conciliação retoma)", async () => {
    const { db, getPedido } = dbFalso(pedidoBase());
    const asaas = asaasFalso({
      listarCobrancasDaAssinatura: vi.fn(async () => [
        cobrancaFake({ id: "pay_url_ruim", invoiceUrl: "https://fora-da-lista.example.com/pagar" }),
      ]),
      removerAssinatura: vi.fn(async () => {
        throw erroIndisponivel(500, false);
      }),
    });
    const { deps } = montarDeps(db, asaas);

    const resultado = await iniciarCompra(deps, ENTRADA_BASE);

    expect(resultado).toEqual({ tipo: "erro", mensagem: expect.any(String) });
    expect(asaas.removerAssinatura).toHaveBeenCalledWith("sub_fake123");
    expect(getPedido().status).toBe("inconclusivo");
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

  it("pedido aberto de OUTRA oferta (plano diferente): recusa, nunca retoma nem cria outro", async () => {
    const pedidoExistente = pedidoBase({ id: "pedido-existente", status: "criado", planCode: "ilimitado" });
    const { db: dbBase } = dbFalso(pedidoExistente);
    const db: DbCompra = {
      ...dbBase,
      criarPedido: vi.fn(async () => ({ data: null, error: { code: "22023", message: "billing_pedido_aberto_existe" } })),
    };
    const asaas = asaasFalso();
    const { deps } = montarDeps(db, asaas);

    const resultado = await iniciarCompra(deps, { ...ENTRADA_BASE, chave: "77777777-7777-7777-7777-777777777777" });

    expect(resultado.tipo).toBe("erro");
    if (resultado.tipo === "erro") {
      expect(resultado.mensagem).toContain("Há um pedido em aberto de outra opção");
    }
    expect(db.tomarPedido).not.toHaveBeenCalled();
    expect(asaas.criarAssinatura).not.toHaveBeenCalled();
  });

  it("retomada calcula a próxima cobrança a partir do contrato (decisão 26), nunca hoje", async () => {
    const pedidoExistente = pedidoBase({ id: "pedido-existente", status: "criado" });
    const { db: dbBase } = dbFalso(pedidoExistente);
    const db: DbCompra = {
      ...dbBase,
      criarPedido: vi.fn(async () => ({ data: null, error: { code: "22023", message: "billing_pedido_aberto_existe" } })),
      lerContrato: vi.fn(async () => ({
        data: { asaasSubscriptionId: null, asaasAssinaturaEncerradaEm: null, currentPeriodEnd: "2026-11-15T03:00:00Z" },
        error: null,
      })),
    };
    const asaas = asaasFalso();
    const { deps } = montarDeps(db, asaas, () => new Date("2026-09-24T12:00:00Z"));

    await iniciarCompra(deps, { ...ENTRADA_BASE, chave: "88888888-8888-8888-8888-888888888888" });

    const chamada = (asaas.criarAssinatura as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(chamada.nextDueDate).toBe("2026-11-15");
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

describe("iniciarCompra: aguardando_pagamento com invoice_url nula (correção 4)", () => {
  it("assinatura sem fatura ainda: reconsulta pela assinatura e registra a que achar", async () => {
    const pedido = pedidoBase({ status: "aguardando_pagamento", invoiceUrl: null, asaasSubscriptionId: "sub_existente" });
    const { db } = dbFalso(pedido);
    const asaas = asaasFalso({
      listarCobrancasDaAssinatura: vi.fn(async () => [
        cobrancaFake({ id: "pay_novo", invoiceUrl: "https://sandbox.asaas.com/i/novo" }),
      ]),
    });
    const { deps } = montarDeps(db, asaas);

    const resultado = await iniciarCompra(deps, ENTRADA_BASE);

    expect(resultado).toEqual({ tipo: "redirecionar", url: "https://sandbox.asaas.com/i/novo" });
    expect(db.registrarCobranca).toHaveBeenCalledWith(
      expect.objectContaining({ asaasPaymentId: "pay_novo", invoiceUrl: "https://sandbox.asaas.com/i/novo" }),
    );
  });

  it("reconsulta falhando (rede) devolve aguarde, nunca erro permanente", async () => {
    const pedido = pedidoBase({ status: "aguardando_pagamento", invoiceUrl: null, asaasSubscriptionId: "sub_existente" });
    const { db } = dbFalso(pedido);
    const asaas = asaasFalso({
      listarCobrancasDaAssinatura: vi.fn(async () => {
        throw new Error("504");
      }),
    });
    const { deps } = montarDeps(db, asaas);

    const resultado = await iniciarCompra(deps, ENTRADA_BASE);

    expect(resultado).toEqual({ tipo: "erro", mensagem: MENSAGEM_AGUARDE });
  });

  it("reconsulta ainda sem fatura: aguarde, nunca erro permanente", async () => {
    const pedido = pedidoBase({ status: "aguardando_pagamento", invoiceUrl: null, asaasSubscriptionId: "sub_existente" });
    const { db } = dbFalso(pedido);
    const asaas = asaasFalso({
      listarCobrancasDaAssinatura: vi.fn(async () => []),
    });
    const { deps } = montarDeps(db, asaas);

    const resultado = await iniciarCompra(deps, ENTRADA_BASE);

    expect(resultado).toEqual({ tipo: "erro", mensagem: MENSAGEM_AGUARDE });
  });

  it("correção 2: uma cobrança DIFERENTE da já registrada é um conflito real, recusado como o SQL recusa (nunca sobrescreve silenciosamente)", async () => {
    const pedido = pedidoBase({
      status: "aguardando_pagamento",
      invoiceUrl: null,
      asaasPaymentId: "pay_ja_registrado",
      asaasSubscriptionId: "sub_existente",
    });
    const { db, getPedido } = dbFalso(pedido);
    const asaas = asaasFalso({
      // O `pay_novo` é OUTRO pagamento (não `pay_ja_registrado`, que já está
      // gravado): o dublê de registrarCobranca precisa recusar isso como
      // conflito de verdade, e não sobrescrever `pay_ja_registrado`.
      listarCobrancasDaAssinatura: vi.fn(async () => [
        cobrancaFake({ id: "pay_novo", invoiceUrl: "https://sandbox.asaas.com/i/novo" }),
      ]),
    });
    const { deps } = montarDeps(db, asaas);

    const resultado = await iniciarCompra(deps, ENTRADA_BASE);

    expect(resultado).toEqual({ tipo: "erro", mensagem: MENSAGEM_AGUARDE });
    expect(getPedido().asaasPaymentId).toBe("pay_ja_registrado");
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
  it("primeiro remove no Asaas, depois marca a assinatura encerrada (que já liga cancel_at_period_end)", async () => {
    const ordem: string[] = [];
    const asaas = asaasFalso({
      removerAssinatura: vi.fn(async () => {
        ordem.push("asaas_delete");
      }),
    });
    const db: DbCompra = {
      ...dbStubVazio(),
      lerContrato: vi.fn(async () => ({
        data: { asaasSubscriptionId: "sub_ativo123", asaasAssinaturaEncerradaEm: null, currentPeriodEnd: null },
        error: null,
      })),
      marcarAssinaturaEncerrada: vi.fn(async () => {
        ordem.push("marcar_encerrada");
        return { data: { jaRegistrado: false, asaasAssinaturaEncerradaEm: "2026-09-24T00:00:00Z" }, error: null };
      }),
    };
    const { deps } = montarDeps(db, asaas);

    const resultado = await cancelarAssinaturaDoCliente(deps, "org-1", "actor-1");

    expect(resultado).toEqual({ tipo: "ok", cancelAtPeriodEnd: true });
    expect(ordem).toEqual(["asaas_delete", "marcar_encerrada"]);
    expect(db.marcarAssinaturaEncerrada).toHaveBeenCalledWith("org-1", "sub_ativo123", "actor-1");
  });

  it("DELETE no Asaas falhando nunca marca nada no banco", async () => {
    const asaas = asaasFalso({
      removerAssinatura: vi.fn(async () => {
        throw erroIndisponivel(500, false);
      }),
    });
    const marcarAssinaturaEncerrada = vi.fn();
    const db: DbCompra = {
      ...dbStubVazio(),
      lerContrato: vi.fn(async () => ({
        data: { asaasSubscriptionId: "sub_ativo123", asaasAssinaturaEncerradaEm: null, currentPeriodEnd: null },
        error: null,
      })),
      marcarAssinaturaEncerrada: marcarAssinaturaEncerrada as DbCompra["marcarAssinaturaEncerrada"],
    };
    const { deps } = montarDeps(db, asaas);

    const resultado = await cancelarAssinaturaDoCliente(deps, "org-1", "actor-1");

    expect(resultado.tipo).toBe("erro");
    expect(marcarAssinaturaEncerrada).not.toHaveBeenCalled();
  });

  it("404 do Asaas (assinatura já removida) é tratado como sucesso pelo cliente HTTP e segue o cancelamento", async () => {
    // removerAssinatura já trata 404 internamente (cliente.ts): resolve sem lançar.
    const asaas = asaasFalso({ removerAssinatura: vi.fn(async () => undefined) });
    const db: DbCompra = {
      ...dbStubVazio(),
      lerContrato: vi.fn(async () => ({
        data: { asaasSubscriptionId: "sub_ja_removida", asaasAssinaturaEncerradaEm: null, currentPeriodEnd: null },
        error: null,
      })),
      marcarAssinaturaEncerrada: vi.fn(async () => ({
        data: { jaRegistrado: false, asaasAssinaturaEncerradaEm: "2026-09-24T00:00:00Z" },
        error: null,
      })),
    };
    const { deps } = montarDeps(db, asaas);

    const resultado = await cancelarAssinaturaDoCliente(deps, "org-1", "actor-1");

    expect(resultado).toEqual({ tipo: "ok", cancelAtPeriodEnd: true });
  });

  it("falha ao marcar a assinatura como encerrada devolve erro, nunca 'ok' (o marcador não foi gravado)", async () => {
    const asaas = asaasFalso();
    const db: DbCompra = {
      ...dbStubVazio(),
      lerContrato: vi.fn(async () => ({
        data: { asaasSubscriptionId: "sub_ativo123", asaasAssinaturaEncerradaEm: null, currentPeriodEnd: null },
        error: null,
      })),
      marcarAssinaturaEncerrada: vi.fn(async () => ({ data: null, error: { code: "P0002", message: "billing_contrato_nao_encontrado" } })),
    };
    const { deps, linhas } = montarDeps(db, asaas);

    const resultado = await cancelarAssinaturaDoCliente(deps, "org-1", "actor-1");

    expect(resultado.tipo).toBe("erro");
    expect(linhas.some((l) => l.nivel === "error" && l.msg === "asaas_cancelar_marcar_encerrada_falhou")).toBe(true);
  });

  it("sem assinatura Asaas na organização, não chama o Asaas nem o banco de escrita", async () => {
    const asaas = asaasFalso();
    const db: DbCompra = {
      ...dbStubVazio(),
      lerContrato: vi.fn(async () => ({
        data: { asaasSubscriptionId: null, asaasAssinaturaEncerradaEm: null, currentPeriodEnd: null },
        error: null,
      })),
      // 0942 (item 7): sem assinatura no contrato, o cancelamento procura a assinatura agendada no
      // pedido aberto; aqui não há pedido nenhum.
      buscarPedidoAbertoPorTipo: vi.fn(async () => ({ data: null, error: null })),
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
        data: { asaasSubscriptionId: "sub_ja_encerrada", asaasAssinaturaEncerradaEm: "2026-09-01T00:00:00Z", currentPeriodEnd: null },
        error: null,
      })),
      buscarPedidoAbertoPorTipo: vi.fn(async () => ({ data: null, error: null })),
    };
    const { deps } = montarDeps(db, asaas);

    const resultado = await cancelarAssinaturaDoCliente(deps, "org-1", "actor-1");

    expect(resultado).toEqual({ tipo: "erro", mensagem: MENSAGEM_SEM_ASSINATURA_ASAAS });
    expect(asaas.removerAssinatura).not.toHaveBeenCalled();
  });
});

describe("cancelarAssinaturaDoCliente: assinatura AGENDADA de quem tem período pago a frente (0942, item 7)", () => {
  /** Contrato sem assinatura viva (o id só entra no primeiro pagamento) e o pedido aberto que a carrega. */
  function cenario(pedido: PedidoLinha, overrides: Partial<DbCompra> = {}) {
    const marcarPedido = vi.fn(async (_org: string, id: string, status: "inconclusivo" | "falhou" | "cancelado") => ({
      data: { pedidoId: id, statusAnterior: pedido.status, statusNovo: status },
      error: null,
    }));
    const db: DbCompra = {
      ...dbStubVazio(),
      lerContrato: vi.fn(async () => ({
        data: { asaasSubscriptionId: null, asaasAssinaturaEncerradaEm: null, currentPeriodEnd: "2026-11-15T03:00:00Z" },
        error: null,
      })),
      buscarPedidoAbertoPorTipo: vi.fn(async () => ({ data: pedido, error: null })),
      marcarPedido: marcarPedido as DbCompra["marcarPedido"],
      ...overrides,
    };
    return { db, marcarPedido };
  }
  const agendado = (extra: Partial<PedidoLinha> = {}) =>
    pedidoBase({ status: "aguardando_pagamento", asaasSubscriptionId: "sub_agendada123", ...extra });

  it("apaga a assinatura agendada no Asaas e só depois cancela o pedido; o contrato não é tocado", async () => {
    const ordem: string[] = [];
    const asaas = asaasFalso({
      removerAssinatura: vi.fn(async () => {
        ordem.push("asaas_delete");
      }),
    });
    const { db, marcarPedido } = cenario(agendado());
    marcarPedido.mockImplementationOnce(async (_org, id, status) => {
      ordem.push("marcar_pedido");
      return { data: { pedidoId: id, statusAnterior: "aguardando_pagamento" as const, statusNovo: status }, error: null };
    });
    const { deps } = montarDeps(db, asaas);

    const resultado = await cancelarAssinaturaDoCliente(deps, "org-1", "actor-1");

    expect(resultado).toEqual({ tipo: "ok", cancelAtPeriodEnd: false });
    expect(asaas.removerAssinatura).toHaveBeenCalledWith("sub_agendada123");
    expect(ordem).toEqual(["asaas_delete", "marcar_pedido"]);
    expect(marcarPedido).toHaveBeenCalledWith("org-1", "pedido-1", "cancelado", "cancelado_pelo_cliente");
    expect(db.marcarAssinaturaEncerrada).not.toHaveBeenCalled();
  });

  it("DELETE no Asaas falhando devolve erro e o pedido NÃO é cancelado (a assinatura ainda cobraria)", async () => {
    const asaas = asaasFalso({
      removerAssinatura: vi.fn(async () => {
        throw erroIndisponivel(500, false);
      }),
    });
    const { db, marcarPedido } = cenario(agendado());
    const { deps } = montarDeps(db, asaas);

    const resultado = await cancelarAssinaturaDoCliente(deps, "org-1", "actor-1");

    expect(resultado.tipo).toBe("erro");
    expect(marcarPedido).not.toHaveBeenCalled();
  });

  it("falha ao cancelar o pedido depois do DELETE devolve erro (repetir é seguro: o DELETE é idempotente)", async () => {
    const asaas = asaasFalso();
    const { db } = cenario(agendado(), {
      marcarPedido: vi.fn(async () => ({ data: null, error: { code: "22023", message: "falhou" } })) as DbCompra["marcarPedido"],
    });
    const { deps, linhas } = montarDeps(db, asaas);

    const resultado = await cancelarAssinaturaDoCliente(deps, "org-1", "actor-1");

    expect(resultado.tipo).toBe("erro");
    expect(linhas.some((l) => l.msg === "asaas_cancelar_marcar_pedido_agendado_falhou")).toBe(true);
  });

  it("pedido aberto que não é assinatura de cartão agendada não é tocado: Pix, pedido sem assinatura gravada, outro ambiente", async () => {
    for (const pedido of [
      agendado({ metodo: "PIX", asaasSubscriptionId: null, asaasPaymentId: "pay_pix123" }),
      agendado({ status: "criado", asaasSubscriptionId: null }),
      agendado({ ambiente: "producao" }),
    ]) {
      const asaas = asaasFalso();
      const { db, marcarPedido } = cenario(pedido);
      const { deps } = montarDeps(db, asaas);

      const resultado = await cancelarAssinaturaDoCliente(deps, "org-1", "actor-1");

      expect(resultado).toEqual({ tipo: "erro", mensagem: MENSAGEM_SEM_ASSINATURA_ASAAS });
      expect(asaas.removerAssinatura).not.toHaveBeenCalled();
      expect(marcarPedido).not.toHaveBeenCalled();
    }
  });

  it("falha ao ler o pedido aberto devolve o erro genérico, sem chamar o Asaas", async () => {
    const asaas = asaasFalso();
    const { db } = cenario(agendado(), {
      buscarPedidoAbertoPorTipo: vi.fn(async () => ({ data: null, error: { code: "XX000", message: "falhou" } })),
    });
    const { deps } = montarDeps(db, asaas);

    const resultado = await cancelarAssinaturaDoCliente(deps, "org-1", "actor-1");

    expect(resultado.tipo).toBe("erro");
    expect(asaas.removerAssinatura).not.toHaveBeenCalled();
  });

  it("com assinatura viva no contrato o caminho é o de sempre: não lê o pedido aberto", async () => {
    const asaas = asaasFalso();
    const buscarPedidoAbertoPorTipo = vi.fn();
    const db: DbCompra = {
      ...dbStubVazio(),
      lerContrato: vi.fn(async () => ({
        data: { asaasSubscriptionId: "sub_viva123", asaasAssinaturaEncerradaEm: null, currentPeriodEnd: null },
        error: null,
      })),
      marcarAssinaturaEncerrada: vi.fn(async () => ({
        data: { jaRegistrado: false, asaasAssinaturaEncerradaEm: "2026-09-24T00:00:00Z" },
        error: null,
      })),
      buscarPedidoAbertoPorTipo: buscarPedidoAbertoPorTipo as DbCompra["buscarPedidoAbertoPorTipo"],
    };
    const { deps } = montarDeps(db, asaas);

    const resultado = await cancelarAssinaturaDoCliente(deps, "org-1", "actor-1");

    expect(resultado).toEqual({ tipo: "ok", cancelAtPeriodEnd: true });
    expect(buscarPedidoAbertoPorTipo).not.toHaveBeenCalled();
  });

  it("de ponta a ponta: a compra no cartão com período pago a frente grava o id da assinatura agendada no pedido, e o cancelamento o acha e o apaga", async () => {
    const { db: dbBase, getPedido } = dbFalso(pedidoBase());
    const db: DbCompra = {
      ...dbBase,
      criarPedido: vi.fn(async () => ({
        data: { pedidoId: "pedido-1", externalReference: "HC:ord:pedido-1", amountCents: 189900, jaExistia: false, proximaCobrancaEm: "2027-10-15" },
        error: null,
      })),
    };
    const asaas = asaasFalso({ criarAssinatura: vi.fn(async () => assinaturaFake({ id: "sub_agendada_e2e" })) });
    const { deps } = montarDeps(db, asaas, () => new Date("2026-09-24T12:00:00Z"));

    const compra = await iniciarCompra(deps, ENTRADA_BASE);

    expect(compra.tipo).toBe("redirecionar");
    expect((asaas.criarAssinatura as ReturnType<typeof vi.fn>).mock.calls[0]![0].nextDueDate).toBe("2027-10-15");
    expect(getPedido().asaasSubscriptionId).toBe("sub_agendada_e2e");
    expect(getPedido().status).toBe("aguardando_pagamento");

    const cancelamento = await cancelarAssinaturaDoCliente(deps, "org-1", "actor-1");

    expect(cancelamento).toEqual({ tipo: "ok", cancelAtPeriodEnd: false });
    expect(asaas.removerAssinatura).toHaveBeenCalledWith("sub_agendada_e2e");
    expect(getPedido().status).toBe("cancelado");
  });
});

describe("D-133: iniciarCompra sem o aceite dos Termos", () => {
  it("recusa antes de criar pedido ou falar com o Asaas", async () => {
    const criarPedido = vi.fn();
    const asaas = { criarCobranca: vi.fn(), criarAssinatura: vi.fn(), criarCliente: vi.fn() };
    const deps = {
      db: { criarPedido },
      asaas,
      config: { ambiente: "sandbox" },
      logger: { warn: vi.fn(), error: vi.fn() },
    } as never;
    for (const termosVersao of ["", "   "]) {
      const r = await iniciarCompra(deps, { ...ENTRADA_BASE, termosVersao });
      expect(r).toEqual({ tipo: "erro", mensagem: MENSAGEM_TERMOS_NAO_ACEITOS });
    }
    expect(criarPedido).not.toHaveBeenCalled();
    expect(asaas.criarCobranca).not.toHaveBeenCalled();
    expect(asaas.criarAssinatura).not.toHaveBeenCalled();
  });
});

describe("cancelarAssinaturaDoCliente: aviso COB-07 (cancelamento confirmado)", () => {
  const contratoVivo = () =>
    vi.fn(async () => ({
      data: { asaasSubscriptionId: "sub_ativo123", asaasAssinaturaEncerradaEm: null, currentPeriodEnd: "2026-11-15T03:00:00Z" },
      error: null,
    }));

  it("depois do cancelamento gravado, avisa com a organização e a assinatura cancelada", async () => {
    const ordem: string[] = [];
    const db: DbCompra = {
      ...dbStubVazio(),
      lerContrato: contratoVivo(),
      marcarAssinaturaEncerrada: vi.fn(async () => {
        ordem.push("marcar_encerrada");
        return { data: { jaRegistrado: false, asaasAssinaturaEncerradaEm: "2026-09-24T00:00:00Z" }, error: null };
      }),
    };
    const avisoDeCancelamento = vi.fn(async () => {
      ordem.push("aviso");
    });
    const { deps } = montarDeps(db, asaasFalso());

    const resultado = await cancelarAssinaturaDoCliente({ ...deps, avisoDeCancelamento }, "org-1", "actor-1");

    expect(resultado).toEqual({ tipo: "ok", cancelAtPeriodEnd: true });
    expect(avisoDeCancelamento).toHaveBeenCalledWith({ organizationId: "org-1", asaasSubscriptionId: "sub_ativo123" });
    expect(ordem).toEqual(["marcar_encerrada", "aviso"]);
  });

  it("aviso que lança não muda o resultado do cancelamento (vira log)", async () => {
    const db: DbCompra = { ...dbStubVazio(), lerContrato: contratoVivo() };
    db.marcarAssinaturaEncerrada = vi.fn(async () => ({
      data: { jaRegistrado: false, asaasAssinaturaEncerradaEm: "2026-09-24T00:00:00Z" },
      error: null,
    }));
    const { deps, linhas } = montarDeps(db, asaasFalso());

    const resultado = await cancelarAssinaturaDoCliente(
      {
        ...deps,
        avisoDeCancelamento: async () => {
          throw new Error("smtp caiu");
        },
      },
      "org-1",
      "actor-1",
    );

    expect(resultado).toEqual({ tipo: "ok", cancelAtPeriodEnd: true });
    expect(linhas.some((l) => l.nivel === "warn" && l.msg === "asaas_cancelar_aviso_falhou")).toBe(true);
  });

  it("sem o aviso injetado o cancelamento é o de sempre", async () => {
    const db: DbCompra = { ...dbStubVazio(), lerContrato: contratoVivo() };
    db.marcarAssinaturaEncerrada = vi.fn(async () => ({
      data: { jaRegistrado: false, asaasAssinaturaEncerradaEm: "2026-09-24T00:00:00Z" },
      error: null,
    }));
    const { deps } = montarDeps(db, asaasFalso());
    expect(await cancelarAssinaturaDoCliente(deps, "org-1", "actor-1")).toEqual({ tipo: "ok", cancelAtPeriodEnd: true });
  });

  it("cancelamento que falhou (DELETE no Asaas ou marcador não gravado) não avisa", async () => {
    const avisoDeCancelamento = vi.fn(async () => {});

    const asaasQuebrado = asaasFalso({
      removerAssinatura: vi.fn(async () => {
        throw erroIndisponivel(500, false);
      }),
    });
    const dbA: DbCompra = { ...dbStubVazio(), lerContrato: contratoVivo() };
    const a = montarDeps(dbA, asaasQuebrado);
    expect((await cancelarAssinaturaDoCliente({ ...a.deps, avisoDeCancelamento }, "org-1", "actor-1")).tipo).toBe("erro");

    const dbB: DbCompra = {
      ...dbStubVazio(),
      lerContrato: contratoVivo(),
      marcarAssinaturaEncerrada: vi.fn(async () => ({ data: null, error: { code: "P0002", message: "billing_contrato_nao_encontrado" } })),
    };
    const b = montarDeps(dbB, asaasFalso());
    expect((await cancelarAssinaturaDoCliente({ ...b.deps, avisoDeCancelamento }, "org-1", "actor-1")).tipo).toBe("erro");

    expect(avisoDeCancelamento).not.toHaveBeenCalled();
  });

  it("assinatura AGENDADA cancelada (período pago a frente): avisa com a assinatura agendada", async () => {
    const pedido = pedidoBase({ status: "aguardando_pagamento", asaasSubscriptionId: "sub_agendada123" });
    const db: DbCompra = {
      ...dbStubVazio(),
      lerContrato: vi.fn(async () => ({
        data: { asaasSubscriptionId: null, asaasAssinaturaEncerradaEm: null, currentPeriodEnd: "2026-11-15T03:00:00Z" },
        error: null,
      })),
      buscarPedidoAbertoPorTipo: vi.fn(async () => ({ data: pedido, error: null })),
      marcarPedido: vi.fn(async (_org: string, id: string, status: "inconclusivo" | "falhou" | "cancelado") => ({
        data: { pedidoId: id, statusAnterior: pedido.status, statusNovo: status },
        error: null,
      })) as DbCompra["marcarPedido"],
    };
    const avisoDeCancelamento = vi.fn(async () => {});
    const { deps } = montarDeps(db, asaasFalso());

    const resultado = await cancelarAssinaturaDoCliente({ ...deps, avisoDeCancelamento }, "org-1", "actor-1");

    expect(resultado).toEqual({ tipo: "ok", cancelAtPeriodEnd: false });
    expect(avisoDeCancelamento).toHaveBeenCalledWith({ organizationId: "org-1", asaasSubscriptionId: "sub_agendada123" });
  });
});
