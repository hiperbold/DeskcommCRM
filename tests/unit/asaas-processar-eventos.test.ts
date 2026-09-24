/**
 * `lib/billing/asaas/processar-eventos.ts`: fase F5, Tarefa 13.
 *
 * RESTRIÇÃO ABSOLUTA: nenhuma chamada real sai destes testes. `DbEventosAsaas`
 * e `ClienteAsaasHttp` são sempre dublês em memória (`vi.fn`); nenhum `fetch`
 * é usado aqui (o cliente HTTP de verdade já é testado com `fetch` falso em
 * `tests/unit/asaas-cliente.test.ts`).
 */
import { describe, expect, it, vi } from "vitest";

import type { ClienteAsaasHttp } from "@/lib/billing/asaas/cliente";
import type { ConfigAsaas } from "@/lib/billing/asaas/config";
import type { AssinaturaAsaas, CobrancaAsaas } from "@/lib/billing/asaas/contratos";
import { erroConfiguracao, erroIndisponivel, erroLimite } from "@/lib/billing/asaas/erros";
import {
  processarEventosAsaas,
  type DbEventosAsaas,
  type DepsProcessarEventosAsaas,
  type EventoReservado,
} from "@/lib/billing/asaas/processar-eventos";

const CONFIG_SANDBOX: ConfigAsaas = {
  habilitado: true,
  baseUrl: "https://api-sandbox.asaas.com/v3",
  apiKey: "$aact_hmlg_testeNuncaEUmaChaveReal000111222",
  webhookToken: "token-de-teste-nunca-real",
  webhookId: "",
  ambiente: "sandbox",
};

function cobrancaFake(overrides: Partial<CobrancaAsaas> = {}): CobrancaAsaas {
  return {
    id: "pay_fake123",
    customer: "cus_fake123",
    status: "RECEIVED",
    billingType: "CREDIT_CARD",
    value: 199,
    dueDate: "2026-09-25",
    externalReference: "HC:ord:pedido-1",
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

function asaasFalso(overrides: Partial<ClienteAsaasHttp> = {}): ClienteAsaasHttp {
  return {
    buscarClientePorReferencia: vi.fn(async () => null),
    criarCliente: vi.fn(async () => {
      throw new Error("criarCliente não deveria ser chamado pelo processador");
    }),
    criarAssinatura: vi.fn(async () => {
      throw new Error("criarAssinatura não deveria ser chamado pelo processador");
    }),
    buscarAssinatura: vi.fn(async () => assinaturaFake()),
    listarCobrancasDaAssinatura: vi.fn(async () => []),
    buscarAssinaturaPorReferencia: vi.fn(async () => null),
    removerAssinatura: vi.fn(async () => undefined),
    criarCobranca: vi.fn(async () => {
      throw new Error("criarCobranca não deveria ser chamado pelo processador");
    }),
    buscarCobranca: vi.fn(async () => cobrancaFake()),
    buscarCobrancaPorReferencia: vi.fn(async () => null),
    removerCobranca: vi.fn(async () => undefined),
    qrPix: vi.fn(async () => {
      throw new Error("qrPix não deveria ser chamado pelo processador");
    }),
    ...overrides,
  };
}

function dbFalso(overrides: Partial<DbEventosAsaas> = {}): DbEventosAsaas {
  return {
    reservarEventos: vi.fn(async () => ({ data: [], error: null })),
    lerPayloads: vi.fn(async () => ({ data: [], error: null })),
    pagamentoConhecido: vi.fn(async () => ({ data: false, error: null })),
    assinaturaConhecida: vi.fn(async () => ({ data: false, error: null })),
    clienteConhecido: vi.fn(async () => ({ data: false, error: null })),
    aplicarEvento: vi.fn(async () => ({ data: { resultado: "aguardando", organizationId: null, alarme: null }, error: null })),
    registrarFalha: vi.fn(async () => ({ data: { tentativas: 1, resultado: "aguardando" }, error: null })),
    ...overrides,
  };
}

function loggerFalso() {
  return { warn: vi.fn(), error: vi.fn() };
}

function deps(overrides: Partial<DepsProcessarEventosAsaas> = {}): DepsProcessarEventosAsaas {
  return {
    db: dbFalso(),
    asaas: asaasFalso(),
    config: CONFIG_SANDBOX,
    logger: loggerFalso(),
    ...overrides,
  };
}

function eventoDinheiro(overrides: Partial<EventoReservado> = {}): EventoReservado {
  return { id: "evt-1", eventType: "PAYMENT_RECEIVED", resourceId: "pay_1", leaseToken: "lease-1", ...overrides };
}

function payloadDePagamento(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt-1",
    event: "PAYMENT_RECEIVED",
    payment: {
      id: "pay_1",
      customer: "cus_1",
      status: "RECEIVED",
      billingType: "CREDIT_CARD",
      value: 199,
      dueDate: "2026-09-25",
      externalReference: "HC:ord:pedido-1",
      ...overrides,
    },
  };
}

describe("processarEventosAsaas", () => {
  it("sem ASAAS_ENABLED: não reserva nada, não chama o Asaas, contagem zero", async () => {
    const db = dbFalso();
    const asaas = asaasFalso();
    const resumo = await processarEventosAsaas(deps({ db, asaas, config: { ...CONFIG_SANDBOX, habilitado: false } }));

    expect(db.reservarEventos).not.toHaveBeenCalled();
    expect(asaas.buscarCobranca).not.toHaveBeenCalled();
    expect(resumo).toMatchObject({ habilitado: false, reservados: 0, aplicados: 0, falhas: 0 });
  });

  it("pagamento confirmado: consulta o Asaas e aplica com o objeto CONFIRMADO (não o do webhook)", async () => {
    const evento = eventoDinheiro();
    const payload = payloadDePagamento();
    const cobranca = cobrancaFake({ status: "RECEIVED", value: 199, originalValue: null });
    const db = dbFalso({
      reservarEventos: vi.fn(async () => ({ data: [evento], error: null })),
      lerPayloads: vi.fn(async () => ({ data: [{ id: "evt-1", payload }], error: null })),
      aplicarEvento: vi.fn(async () => ({ data: { resultado: "aplicado", organizationId: "org-1", alarme: null }, error: null })),
    });
    const asaas = asaasFalso({ buscarCobranca: vi.fn(async () => cobranca) });

    const resumo = await processarEventosAsaas(deps({ db, asaas }));

    expect(asaas.buscarCobranca).toHaveBeenCalledWith("pay_1");
    expect(db.aplicarEvento).toHaveBeenCalledWith(
      "evt-1",
      "lease-1",
      expect.objectContaining({ id: "pay_fake123", status: "RECEIVED", value: 199, dueDate: "2026-09-25" }),
    );
    expect(resumo.aplicados).toBe(1);
    expect(resumo.processados).toBe(1);
  });

  it("GET diz PENDING para um evento PAYMENT_RECEIVED forjado: a confirmação leva o status REAL, não concede", async () => {
    const evento = eventoDinheiro();
    const payload = payloadDePagamento();
    const cobranca = cobrancaFake({ status: "PENDING" });
    const db = dbFalso({
      reservarEventos: vi.fn(async () => ({ data: [evento], error: null })),
      lerPayloads: vi.fn(async () => ({ data: [{ id: "evt-1", payload }], error: null })),
      aplicarEvento: vi.fn(async () => ({ data: { resultado: "aguardando", organizationId: null, alarme: null }, error: null })),
    });
    const asaas = asaasFalso({ buscarCobranca: vi.fn(async () => cobranca) });

    const resumo = await processarEventosAsaas(deps({ db, asaas }));

    expect(db.aplicarEvento).toHaveBeenCalledWith("evt-1", "lease-1", expect.objectContaining({ status: "PENDING" }));
    expect(resumo.aguardando).toBe(1);
    expect(resumo.aplicados).toBe(0);
  });

  it("payload sem prefixo HC: e sem vínculo local conhecido: nunca faz GET (pré-roteamento, decisão 6/M8)", async () => {
    const evento = eventoDinheiro({ id: "evt-2", resourceId: "pay_de_outro_app", leaseToken: "lease-2" });
    const payload = payloadDePagamento({ id: "pay_de_outro_app", customer: "cus_de_outro_app", externalReference: "HT:pay:xyz" });
    payload.id = "evt-2";
    const db = dbFalso({
      reservarEventos: vi.fn(async () => ({ data: [evento], error: null })),
      lerPayloads: vi.fn(async () => ({ data: [{ id: "evt-2", payload }], error: null })),
    });
    const asaas = asaasFalso();

    const resumo = await processarEventosAsaas(deps({ db, asaas }));

    expect(asaas.buscarCobranca).not.toHaveBeenCalled();
    expect(db.aplicarEvento).toHaveBeenCalledWith("evt-2", "lease-2", null);
    // Nunca concede nada, e não fica escondido como "aplicado".
    expect(resumo.aplicados).toBe(0);
  });

  it("evento conhecido localmente pelo id do pagamento (sem HC:) ainda assim faz o GET", async () => {
    const evento = eventoDinheiro({ id: "evt-2b", resourceId: "pay_conhecido", leaseToken: "lease-2b" });
    const payload = { id: "evt-2b", event: "PAYMENT_RECEIVED", payment: { id: "pay_conhecido", status: "RECEIVED", value: 10, dueDate: "2026-09-25" } };
    const db = dbFalso({
      reservarEventos: vi.fn(async () => ({ data: [evento], error: null })),
      lerPayloads: vi.fn(async () => ({ data: [{ id: "evt-2b", payload }], error: null })),
      pagamentoConhecido: vi.fn(async () => ({ data: true, error: null })),
    });
    const asaas = asaasFalso({ buscarCobranca: vi.fn(async () => cobrancaFake({ id: "pay_conhecido" })) });

    await processarEventosAsaas(deps({ db, asaas }));

    expect(db.pagamentoConhecido).toHaveBeenCalledWith("pay_conhecido");
    expect(asaas.buscarCobranca).toHaveBeenCalledWith("pay_conhecido");
  });

  it("evento que não é de dinheiro nunca gera GET, mesmo sem qualquer pré-roteamento", async () => {
    const evento: EventoReservado = { id: "evt-7", eventType: "SUBSCRIPTION_DELETED", resourceId: "sub_7", leaseToken: "lease-7" };
    const db = dbFalso({
      reservarEventos: vi.fn(async () => ({ data: [evento], error: null })),
      aplicarEvento: vi.fn(async () => ({ data: { resultado: "ignorado", organizationId: null, alarme: null }, error: null })),
    });
    const asaas = asaasFalso();

    const resumo = await processarEventosAsaas(deps({ db, asaas }));

    expect(db.lerPayloads).not.toHaveBeenCalled();
    expect(asaas.buscarCobranca).not.toHaveBeenCalled();
    expect(asaas.buscarAssinatura).not.toHaveBeenCalled();
    expect(db.aplicarEvento).toHaveBeenCalledWith("evt-7", "lease-7", null);
    expect(resumo.ignorados).toBe(1);
  });

  it("GET falha (indisponível): registra a falha com o código, sem tentar de novo dentro da rodada", async () => {
    const evento = eventoDinheiro({ id: "evt-4", resourceId: "pay_4", leaseToken: "lease-4" });
    const payload = payloadDePagamento({ id: "pay_4" });
    payload.id = "evt-4";
    const db = dbFalso({
      reservarEventos: vi.fn(async () => ({ data: [evento], error: null })),
      lerPayloads: vi.fn(async () => ({ data: [{ id: "evt-4", payload }], error: null })),
    });
    const asaas = asaasFalso({
      buscarCobranca: vi.fn(async () => {
        throw erroIndisponivel(503);
      }),
    });

    const resumo = await processarEventosAsaas(deps({ db, asaas }));

    expect(db.registrarFalha).toHaveBeenCalledWith("evt-4", "lease-4", "asaas_indisponivel");
    expect(db.aplicarEvento).not.toHaveBeenCalled();
    expect(resumo.falhas).toBe(1);
  });

  it("429 acima do teto de espera (limite): registra falha com o código, sem segurar a rodada", async () => {
    const evento = eventoDinheiro({ id: "evt-6", resourceId: "pay_6", leaseToken: "lease-6" });
    const payload = payloadDePagamento({ id: "pay_6" });
    payload.id = "evt-6";
    const db = dbFalso({
      reservarEventos: vi.fn(async () => ({ data: [evento], error: null })),
      lerPayloads: vi.fn(async () => ({ data: [{ id: "evt-6", payload }], error: null })),
    });
    const asaas = asaasFalso({
      buscarCobranca: vi.fn(async () => {
        throw erroLimite(10);
      }),
    });

    await processarEventosAsaas(deps({ db, asaas }));

    expect(db.registrarFalha).toHaveBeenCalledWith("evt-6", "lease-6", "asaas_limite");
  });

  it("erro de CONFIGURAÇÃO aborta a rodada inteira, sem tentar os próximos eventos", async () => {
    const eventos: EventoReservado[] = [
      eventoDinheiro({ id: "evt-9", resourceId: "pay_9", leaseToken: "lease-9" }),
      eventoDinheiro({ id: "evt-10", resourceId: "pay_10", leaseToken: "lease-10" }),
    ];
    const payload9 = payloadDePagamento({ id: "pay_9" });
    payload9.id = "evt-9";
    const db = dbFalso({
      reservarEventos: vi.fn(async () => ({ data: eventos, error: null })),
      lerPayloads: vi.fn(async () => ({ data: [{ id: "evt-9", payload: payload9 }], error: null })),
    });
    const asaas = asaasFalso({
      buscarCobranca: vi.fn(async () => {
        throw erroConfiguracao("ASAAS_API_KEY e ASAAS_BASE_URL incoerentes");
      }),
    });

    const resumo = await processarEventosAsaas(deps({ db, asaas }));

    expect(asaas.buscarCobranca).toHaveBeenCalledTimes(1);
    expect(db.registrarFalha).not.toHaveBeenCalled();
    expect(resumo.processados).toBe(1);
    expect(resumo.falhas).toBe(1);
  });

  it("lease expirado: fn_billing_asaas_aplicar_evento recusa gravar, e o processador não trava a rodada", async () => {
    const evento: EventoReservado = { id: "evt-5", eventType: "PAYMENT_CREATED", resourceId: null, leaseToken: "lease-5" };
    const db = dbFalso({
      reservarEventos: vi.fn(async () => ({ data: [evento], error: null })),
      aplicarEvento: vi.fn(async () => ({ data: null, error: { code: "22023", message: "billing_lease_invalido" } })),
    });
    const asaas = asaasFalso();

    const resumo = await processarEventosAsaas(deps({ db, asaas }));

    expect(resumo.processados).toBe(1);
    expect(resumo.falhas).toBe(1);
  });

  it("orçamento de tempo por rodada: para de processar perto do teto, mesmo com eventos sobrando", async () => {
    const eventos: EventoReservado[] = [
      { id: "evt-a", eventType: "PAYMENT_CREATED", resourceId: null, leaseToken: "lease-a" },
      { id: "evt-b", eventType: "PAYMENT_CREATED", resourceId: null, leaseToken: "lease-b" },
      { id: "evt-c", eventType: "PAYMENT_CREATED", resourceId: null, leaseToken: "lease-c" },
    ];
    let relogio = 0;
    const agora = () => new Date((relogio += 20));
    const aplicarEvento = vi.fn(async () => ({ data: { resultado: "ignorado", organizationId: null, alarme: null }, error: null }));
    const db = dbFalso({
      reservarEventos: vi.fn(async () => ({ data: eventos, error: null })),
      aplicarEvento,
    });
    const asaas = asaasFalso();

    const resumo = await processarEventosAsaas(deps({ db, asaas, agora, orcamentoMs: 50 }));

    expect(resumo.reservados).toBe(3);
    expect(resumo.cortadoPeloOrcamento).toBe(true);
    expect(resumo.processados).toBeLessThan(3);
    expect(aplicarEvento.mock.calls.length).toBe(resumo.processados);
  });

  it("alarme remover_cobranca_pendente: chama removerCobranca depois de aplicar; falha nisso só loga", async () => {
    const evento: EventoReservado = { id: "evt-8", eventType: "PAYMENT_OVERDUE", resourceId: "pay_8", leaseToken: "lease-8" };
    const db = dbFalso({
      reservarEventos: vi.fn(async () => ({ data: [evento], error: null })),
      aplicarEvento: vi.fn(async () => ({
        data: { resultado: "ignorado", organizationId: "org-1", alarme: "remover_cobranca_pendente" },
        error: null,
      })),
    });
    const asaas = asaasFalso({ removerCobranca: vi.fn(async () => undefined) });

    await processarEventosAsaas(deps({ db, asaas }));

    expect(asaas.removerCobranca).toHaveBeenCalledWith("pay_8");
  });

  it("falha ao remover a cobrança só loga; não derruba a rodada nem muda o resultado contabilizado", async () => {
    const evento: EventoReservado = { id: "evt-8b", eventType: "PAYMENT_OVERDUE", resourceId: "pay_8b", leaseToken: "lease-8b" };
    const db = dbFalso({
      reservarEventos: vi.fn(async () => ({ data: [evento], error: null })),
      aplicarEvento: vi.fn(async () => ({
        data: { resultado: "ignorado", organizationId: "org-1", alarme: "remover_cobranca_pendente" },
        error: null,
      })),
    });
    const logger = loggerFalso();
    const asaas = asaasFalso({
      removerCobranca: vi.fn(async () => {
        throw erroIndisponivel(500);
      }),
    });

    const resumo = await processarEventosAsaas(deps({ db, asaas, logger }));

    expect(logger.warn).toHaveBeenCalledWith("asaas_processar_remover_cobranca_falhou", expect.any(Object));
    expect(resumo.ignorados).toBe(1);
  });

  it("assinatura vinculada ao pagamento: também consulta GET /subscriptions para o assinatura_status (M3)", async () => {
    const evento = eventoDinheiro({ id: "evt-11", resourceId: "pay_11", leaseToken: "lease-11" });
    const payload = payloadDePagamento({ id: "pay_11" });
    payload.id = "evt-11";
    const cobranca = cobrancaFake({ id: "pay_11", subscription: "sub_11" });
    const db = dbFalso({
      reservarEventos: vi.fn(async () => ({ data: [evento], error: null })),
      lerPayloads: vi.fn(async () => ({ data: [{ id: "evt-11", payload }], error: null })),
      aplicarEvento: vi.fn(async () => ({ data: { resultado: "aplicado", organizationId: "org-1", alarme: null }, error: null })),
    });
    const asaas = asaasFalso({
      buscarCobranca: vi.fn(async () => cobranca),
      buscarAssinatura: vi.fn(async () => assinaturaFake({ id: "sub_11", status: "ACTIVE" })),
    });

    await processarEventosAsaas(deps({ db, asaas }));

    expect(asaas.buscarAssinatura).toHaveBeenCalledWith("sub_11");
    expect(db.aplicarEvento).toHaveBeenCalledWith(
      "evt-11",
      "lease-11",
      expect.objectContaining({ assinatura_status: "ACTIVE" }),
    );
  });
});
