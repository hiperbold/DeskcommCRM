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
    atualizarCliente: vi.fn(async () => {
      throw new Error("atualizarCliente não deveria ser chamado pelo processador");
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
    criarCobrancaParcelada: vi.fn(async () => {
      throw new Error("criarCobrancaParcelada não deveria ser chamado neste teste");
    }),
    buscarParcelamento: vi.fn(async () => ({ removido: true as const })),
    removerParcelamento: vi.fn(async () => undefined),
    listarCobrancasDoParcelamento: vi.fn(async () => []),
    qrPix: vi.fn(async () => {
      throw new Error("qrPix não deveria ser chamado pelo processador");
    }),
    buscarWebhook: vi.fn(async () => {
      throw new Error("buscarWebhook não deveria ser chamado pelo processador");
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
    marcarAssinaturaEncerrada: vi.fn(async () => ({ data: { jaRegistrado: false }, error: null })),
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
  return { id: "evt-1", eventType: "PAYMENT_RECEIVED", idDoRecurso: "pay_1", leaseToken: "lease-1", ...overrides };
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

function payloadDeAssinatura(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt-sub-1",
    event: "SUBSCRIPTION_DELETED",
    subscription: {
      id: "sub_1",
      customer: "cus_1",
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
    const evento = eventoDinheiro({ id: "evt-2", idDoRecurso: "pay_de_outro_app", leaseToken: "lease-2" });
    const payload = payloadDePagamento({ id: "pay_de_outro_app", customer: "cus_de_outro_app", externalReference: "HT:pay:xyz" });
    payload.id = "evt-2";
    const db = dbFalso({
      reservarEventos: vi.fn(async () => ({ data: [evento], error: null })),
      lerPayloads: vi.fn(async () => ({ data: [{ id: "evt-2", payload }], error: null })),
    });
    const asaas = asaasFalso();

    const resumo = await processarEventosAsaas(deps({ db, asaas }));

    expect(asaas.buscarCobranca).not.toHaveBeenCalled();
    expect(db.aplicarEvento).toHaveBeenCalledWith("evt-2", "lease-2", { pre_roteamento: "outro_app" });
    // Nunca concede nada, e não fica escondido como "aplicado".
    expect(resumo.aplicados).toBe(0);
  });

  it("evento conhecido localmente pelo id do pagamento (sem HC:) ainda assim faz o GET", async () => {
    const evento = eventoDinheiro({ id: "evt-2b", idDoRecurso: "pay_conhecido", leaseToken: "lease-2b" });
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

  it("evento que não precisa de confirmação (PAYMENT_CREATED) nunca gera GET, mesmo sem qualquer pré-roteamento", async () => {
    const evento: EventoReservado = { id: "evt-7", eventType: "PAYMENT_CREATED", idDoRecurso: "pay_7", leaseToken: "lease-7" };
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
    const evento = eventoDinheiro({ id: "evt-4", idDoRecurso: "pay_4", leaseToken: "lease-4" });
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
    const evento = eventoDinheiro({ id: "evt-6", idDoRecurso: "pay_6", leaseToken: "lease-6" });
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
      eventoDinheiro({ id: "evt-9", idDoRecurso: "pay_9", leaseToken: "lease-9" }),
      eventoDinheiro({ id: "evt-10", idDoRecurso: "pay_10", leaseToken: "lease-10" }),
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
    const evento: EventoReservado = { id: "evt-5", eventType: "PAYMENT_CREATED", idDoRecurso: null, leaseToken: "lease-5" };
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
      { id: "evt-a", eventType: "PAYMENT_CREATED", idDoRecurso: null, leaseToken: "lease-a" },
      { id: "evt-b", eventType: "PAYMENT_CREATED", idDoRecurso: null, leaseToken: "lease-b" },
      { id: "evt-c", eventType: "PAYMENT_CREATED", idDoRecurso: null, leaseToken: "lease-c" },
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
    const evento: EventoReservado = { id: "evt-8", eventType: "PAYMENT_OVERDUE", idDoRecurso: "pay_8", leaseToken: "lease-8" };
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
    const evento: EventoReservado = { id: "evt-8b", eventType: "PAYMENT_OVERDUE", idDoRecurso: "pay_8b", leaseToken: "lease-8b" };
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
    const evento = eventoDinheiro({ id: "evt-11", idDoRecurso: "pay_11", leaseToken: "lease-11" });
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

  // ─── Correção 1: PAYMENT_OVERDUE/PAYMENT_DELETED/estorno/chargeback e
  // SUBSCRIPTION_* agora também fazem GET, com o contrato certo de
  // p_confirmacao para cada família ────────────────────────────────────────

  it("PAYMENT_OVERDUE conhecido: consulta GET /payments e monta a confirmação com status (contrato de fim de pagamento)", async () => {
    const evento: EventoReservado = { id: "evt-20", eventType: "PAYMENT_OVERDUE", idDoRecurso: "pay_20", leaseToken: "lease-20" };
    const payload = payloadDePagamento({ id: "pay_20" });
    payload.id = "evt-20";
    payload.event = "PAYMENT_OVERDUE";
    const cobranca = cobrancaFake({ id: "pay_20", status: "OVERDUE", subscription: null });
    const db = dbFalso({
      reservarEventos: vi.fn(async () => ({ data: [evento], error: null })),
      lerPayloads: vi.fn(async () => ({ data: [{ id: "evt-20", payload }], error: null })),
      aplicarEvento: vi.fn(async () => ({ data: { resultado: "aplicado", organizationId: "org-1", alarme: null }, error: null })),
    });
    const asaas = asaasFalso({ buscarCobranca: vi.fn(async () => cobranca) });

    await processarEventosAsaas(deps({ db, asaas }));

    expect(asaas.buscarCobranca).toHaveBeenCalledWith("pay_20");
    expect(db.aplicarEvento).toHaveBeenCalledWith(
      "evt-20",
      "lease-20",
      expect.objectContaining({ id: "pay_20", status: "OVERDUE", removida: false }),
    );
  });

  it("PAYMENT_DELETED confirmado (404 no GET): confirmação leva removida:true, nunca status", async () => {
    const evento: EventoReservado = { id: "evt-21", eventType: "PAYMENT_DELETED", idDoRecurso: "pay_21", leaseToken: "lease-21" };
    const payload = payloadDePagamento({ id: "pay_21" });
    payload.id = "evt-21";
    payload.event = "PAYMENT_DELETED";
    const db = dbFalso({
      reservarEventos: vi.fn(async () => ({ data: [evento], error: null })),
      lerPayloads: vi.fn(async () => ({ data: [{ id: "evt-21", payload }], error: null })),
      aplicarEvento: vi.fn(async () => ({ data: { resultado: "aplicado", organizationId: "org-1", alarme: null }, error: null })),
    });
    const asaas = asaasFalso({ buscarCobranca: vi.fn(async () => ({ removido: true as const })) });

    await processarEventosAsaas(deps({ db, asaas }));

    expect(db.aplicarEvento).toHaveBeenCalledWith("evt-21", "lease-21", { id: "pay_21", removida: true });
  });

  it("PAYMENT_REFUNDED conhecido: monta a confirmação com value/originalValue (contrato de estorno)", async () => {
    const evento: EventoReservado = { id: "evt-22", eventType: "PAYMENT_REFUNDED", idDoRecurso: "pay_22", leaseToken: "lease-22" };
    const payload = payloadDePagamento({ id: "pay_22" });
    payload.id = "evt-22";
    payload.event = "PAYMENT_REFUNDED";
    const cobranca = cobrancaFake({ id: "pay_22", status: "REFUNDED", value: 100, originalValue: 100 });
    const db = dbFalso({
      reservarEventos: vi.fn(async () => ({ data: [evento], error: null })),
      lerPayloads: vi.fn(async () => ({ data: [{ id: "evt-22", payload }], error: null })),
      aplicarEvento: vi.fn(async () => ({ data: { resultado: "aplicado", organizationId: "org-1", alarme: null }, error: null })),
    });
    const asaas = asaasFalso({ buscarCobranca: vi.fn(async () => cobranca) });

    await processarEventosAsaas(deps({ db, asaas }));

    expect(db.aplicarEvento).toHaveBeenCalledWith(
      "evt-22",
      "lease-22",
      expect.objectContaining({ id: "pay_22", value: 100, originalValue: 100 }),
    );
    // O contrato de estorno não tem campo `dueDate`/`customer` (só o de pagamento confirmado).
    const chamada = (db.aplicarEvento as ReturnType<typeof vi.fn>).mock.calls[0]![2] as Record<string, unknown>;
    expect(chamada).not.toHaveProperty("dueDate");
    expect(chamada).not.toHaveProperty("customer");
  });

  it("PAYMENT_REFUNDED com o recurso removido no Asaas (404): manda null, evento fica aguardando", async () => {
    const evento: EventoReservado = { id: "evt-23", eventType: "PAYMENT_REFUNDED", idDoRecurso: "pay_23", leaseToken: "lease-23" };
    const payload = payloadDePagamento({ id: "pay_23" });
    payload.id = "evt-23";
    payload.event = "PAYMENT_REFUNDED";
    const db = dbFalso({
      reservarEventos: vi.fn(async () => ({ data: [evento], error: null })),
      lerPayloads: vi.fn(async () => ({ data: [{ id: "evt-23", payload }], error: null })),
      aplicarEvento: vi.fn(async () => ({ data: { resultado: "aguardando", organizationId: null, alarme: null }, error: null })),
    });
    const asaas = asaasFalso({ buscarCobranca: vi.fn(async () => ({ removido: true as const })) });

    await processarEventosAsaas(deps({ db, asaas }));

    expect(db.aplicarEvento).toHaveBeenCalledWith("evt-23", "lease-23", null);
  });

  it("SUBSCRIPTION_DELETED conhecido: consulta GET /subscriptions e monta a confirmação (removida:false, ainda ativa)", async () => {
    const evento: EventoReservado = { id: "evt-24", eventType: "SUBSCRIPTION_DELETED", idDoRecurso: "sub_24", leaseToken: "lease-24" };
    // externalReference nulo de propósito: sem prefixo "HC:" o roteamento
    // precisa passar por assinaturaConhecida (não pelo atalho do prefixo).
    const payload = payloadDeAssinatura({ id: "sub_24", externalReference: null });
    payload.id = "evt-24";
    const db = dbFalso({
      reservarEventos: vi.fn(async () => ({ data: [evento], error: null })),
      lerPayloads: vi.fn(async () => ({ data: [{ id: "evt-24", payload }], error: null })),
      assinaturaConhecida: vi.fn(async () => ({ data: true, error: null })),
      aplicarEvento: vi.fn(async () => ({ data: { resultado: "aplicado", organizationId: "org-1", alarme: null }, error: null })),
    });
    const asaas = asaasFalso({ buscarAssinatura: vi.fn(async () => assinaturaFake({ id: "sub_24", status: "ACTIVE" })) });

    await processarEventosAsaas(deps({ db, asaas }));

    expect(db.assinaturaConhecida).toHaveBeenCalledWith("sub_24");
    expect(asaas.buscarAssinatura).toHaveBeenCalledWith("sub_24");
    expect(db.aplicarEvento).toHaveBeenCalledWith("evt-24", "lease-24", { id: "sub_24", status: "ACTIVE", removida: false });
  });

  it("SUBSCRIPTION_DELETED confirmado (404 no GET): confirmação leva removida:true", async () => {
    const evento: EventoReservado = { id: "evt-25", eventType: "SUBSCRIPTION_DELETED", idDoRecurso: "sub_25", leaseToken: "lease-25" };
    const payload = payloadDeAssinatura({ id: "sub_25" });
    payload.id = "evt-25";
    const db = dbFalso({
      reservarEventos: vi.fn(async () => ({ data: [evento], error: null })),
      lerPayloads: vi.fn(async () => ({ data: [{ id: "evt-25", payload }], error: null })),
      assinaturaConhecida: vi.fn(async () => ({ data: true, error: null })),
      aplicarEvento: vi.fn(async () => ({ data: { resultado: "aplicado", organizationId: "org-1", alarme: null }, error: null })),
    });
    const asaas = asaasFalso({ buscarAssinatura: vi.fn(async () => ({ removido: true as const })) });

    await processarEventosAsaas(deps({ db, asaas }));

    expect(db.aplicarEvento).toHaveBeenCalledWith("evt-25", "lease-25", { id: "sub_25", removida: true });
  });

  // ─── Correção 2: falha de INFRAESTRUTURA no pré-roteamento nunca vira
  // outro_app silencioso; registra falha com backoff ─────────────────────────

  it("lerPayloads falha: registra falha com backoff, nunca fecha como outro_app", async () => {
    const evento = eventoDinheiro({ id: "evt-30", idDoRecurso: "pay_30", leaseToken: "lease-30" });
    const db = dbFalso({
      reservarEventos: vi.fn(async () => ({ data: [evento], error: null })),
      lerPayloads: vi.fn(async () => ({ data: null, error: { code: "500", message: "timeout" } })),
    });
    const asaas = asaasFalso();

    const resumo = await processarEventosAsaas(deps({ db, asaas }));

    expect(db.aplicarEvento).not.toHaveBeenCalled();
    expect(db.registrarFalha).toHaveBeenCalledWith("evt-30", "lease-30", "asaas_pre_roteamento_falhou");
    expect(resumo.outroApp).toBe(0);
    expect(resumo.falhas).toBe(1);
  });

  it("pagamentoConhecido falha (infraestrutura): registra falha com backoff, nunca fecha como outro_app", async () => {
    const evento = eventoDinheiro({ id: "evt-31", idDoRecurso: "pay_31", leaseToken: "lease-31" });
    const payload = payloadDePagamento({ id: "pay_31", externalReference: null });
    payload.id = "evt-31";
    const db = dbFalso({
      reservarEventos: vi.fn(async () => ({ data: [evento], error: null })),
      lerPayloads: vi.fn(async () => ({ data: [{ id: "evt-31", payload }], error: null })),
      pagamentoConhecido: vi.fn(async () => ({ data: null, error: { code: "500", message: "indisponivel" } })),
    });
    const asaas = asaasFalso();

    const resumo = await processarEventosAsaas(deps({ db, asaas }));

    expect(asaas.buscarCobranca).not.toHaveBeenCalled();
    expect(db.aplicarEvento).not.toHaveBeenCalled();
    expect(db.registrarFalha).toHaveBeenCalledWith("evt-31", "lease-31", "asaas_pre_roteamento_falhou");
    expect(resumo.outroApp).toBe(0);
  });

  // ─── Correção 3: falha da PRÓPRIA RPC de aplicar registra falha com o
  // lease, em vez de só logar e deixar o lease expirar sozinho ───────────────

  it("fn_billing_asaas_aplicar_evento falha (RPC com erro, não confirmação): registra falha com o mesmo lease", async () => {
    const evento: EventoReservado = { id: "evt-40", eventType: "PAYMENT_CREATED", idDoRecurso: null, leaseToken: "lease-40" };
    const db = dbFalso({
      reservarEventos: vi.fn(async () => ({ data: [evento], error: null })),
      aplicarEvento: vi.fn(async () => ({ data: null, error: { code: "08006", message: "conexao perdida" } })),
    });
    const asaas = asaasFalso();

    const resumo = await processarEventosAsaas(deps({ db, asaas }));

    expect(db.registrarFalha).toHaveBeenCalledWith("evt-40", "lease-40", "asaas_aplicar_evento_08006");
    expect(resumo.falhas).toBe(1);
  });

  // ─── Correção 4: alarme remover_assinatura_pendente remove a assinatura
  // (não a cobrança) e marca o contrato como encerrado ───────────────────────

  it("alarme remover_assinatura_pendente: chama removerAssinatura e depois marcarAssinaturaEncerrada", async () => {
    const evento: EventoReservado = { id: "evt-50", eventType: "PAYMENT_OVERDUE", idDoRecurso: "pay_50", leaseToken: "lease-50" };
    const payload = payloadDePagamento({ id: "pay_50", subscription: "sub_50" });
    payload.id = "evt-50";
    payload.event = "PAYMENT_OVERDUE";
    const cobranca = cobrancaFake({ id: "pay_50", status: "OVERDUE", subscription: "sub_50" });
    const db = dbFalso({
      reservarEventos: vi.fn(async () => ({ data: [evento], error: null })),
      lerPayloads: vi.fn(async () => ({ data: [{ id: "evt-50", payload }], error: null })),
      aplicarEvento: vi.fn(async () => ({
        data: { resultado: "aplicado", organizationId: "org-50", alarme: "remover_assinatura_pendente" },
        error: null,
      })),
    });
    const asaas = asaasFalso({
      buscarCobranca: vi.fn(async () => cobranca),
      removerAssinatura: vi.fn(async () => undefined),
    });

    await processarEventosAsaas(deps({ db, asaas }));

    expect(asaas.removerAssinatura).toHaveBeenCalledWith("sub_50");
    expect(asaas.removerCobranca).not.toHaveBeenCalled();
    expect(db.marcarAssinaturaEncerrada).toHaveBeenCalledWith("org-50", "sub_50");
  });

  it("remover_assinatura_pendente: contrato já não tem mais esta assinatura (billing_assinatura_nao_confere) não é logado como falha", async () => {
    const evento: EventoReservado = { id: "evt-51", eventType: "PAYMENT_OVERDUE", idDoRecurso: "pay_51", leaseToken: "lease-51" };
    const payload = payloadDePagamento({ id: "pay_51", subscription: "sub_51" });
    payload.id = "evt-51";
    payload.event = "PAYMENT_OVERDUE";
    const cobranca = cobrancaFake({ id: "pay_51", status: "OVERDUE", subscription: "sub_51" });
    const db = dbFalso({
      reservarEventos: vi.fn(async () => ({ data: [evento], error: null })),
      lerPayloads: vi.fn(async () => ({ data: [{ id: "evt-51", payload }], error: null })),
      aplicarEvento: vi.fn(async () => ({
        data: { resultado: "aplicado", organizationId: "org-51", alarme: "remover_assinatura_pendente" },
        error: null,
      })),
      marcarAssinaturaEncerrada: vi.fn(async () => ({
        data: null,
        error: { code: "22023", message: "billing_assinatura_nao_confere" },
      })),
    });
    const logger = loggerFalso();
    const asaas = asaasFalso({ buscarCobranca: vi.fn(async () => cobranca) });

    await processarEventosAsaas(deps({ db, asaas, logger }));

    expect(logger.warn).not.toHaveBeenCalledWith("asaas_processar_marcar_assinatura_encerrada_falhou", expect.any(Object));
  });

  it("falha ao remover a assinatura só loga; conciliação refaz depois", async () => {
    const evento: EventoReservado = { id: "evt-52", eventType: "PAYMENT_OVERDUE", idDoRecurso: "pay_52", leaseToken: "lease-52" };
    const payload = payloadDePagamento({ id: "pay_52", subscription: "sub_52" });
    payload.id = "evt-52";
    payload.event = "PAYMENT_OVERDUE";
    const cobranca = cobrancaFake({ id: "pay_52", status: "OVERDUE", subscription: "sub_52" });
    const db = dbFalso({
      reservarEventos: vi.fn(async () => ({ data: [evento], error: null })),
      lerPayloads: vi.fn(async () => ({ data: [{ id: "evt-52", payload }], error: null })),
      aplicarEvento: vi.fn(async () => ({
        data: { resultado: "aplicado", organizationId: "org-52", alarme: "remover_assinatura_pendente" },
        error: null,
      })),
    });
    const logger = loggerFalso();
    const asaas = asaasFalso({
      buscarCobranca: vi.fn(async () => cobranca),
      removerAssinatura: vi.fn(async () => {
        throw erroIndisponivel(500);
      }),
    });

    await processarEventosAsaas(deps({ db, asaas, logger }));

    expect(logger.warn).toHaveBeenCalledWith("asaas_processar_remover_assinatura_falhou", expect.any(Object));
    expect(db.marcarAssinaturaEncerrada).not.toHaveBeenCalled();
  });

  it("correção 9: sem subscriptionId (recurso já veio removido/404 do GET), cai para removerCobranca pelo asaas_payment_id do evento", async () => {
    const evento: EventoReservado = { id: "evt-53", eventType: "PAYMENT_DELETED", idDoRecurso: "pay_53", leaseToken: "lease-53" };
    const payload = payloadDePagamento({ id: "pay_53" });
    payload.id = "evt-53";
    payload.event = "PAYMENT_DELETED";
    const db = dbFalso({
      reservarEventos: vi.fn(async () => ({ data: [evento], error: null })),
      lerPayloads: vi.fn(async () => ({ data: [{ id: "evt-53", payload }], error: null })),
      aplicarEvento: vi.fn(async () => ({
        data: { resultado: "aplicado", organizationId: "org-53", alarme: "remover_assinatura_pendente" },
        error: null,
      })),
    });
    const asaas = asaasFalso({
      // O GET devolve o recurso REMOVIDO (404/deleted:true): sem `.subscription`
      // no objeto, o processador não tem como saber a que assinatura este
      // pagamento pertencia.
      buscarCobranca: vi.fn(async () => ({ removido: true }) as never),
      removerCobranca: vi.fn(async () => undefined),
    });

    await processarEventosAsaas(deps({ db, asaas }));

    expect(asaas.removerCobranca).toHaveBeenCalledWith("pay_53");
    expect(asaas.removerAssinatura).not.toHaveBeenCalled();
    expect(db.marcarAssinaturaEncerrada).not.toHaveBeenCalled();
  });

  it("correção 9: falha ao remover a cobrança de fallback só loga; não derruba a rodada", async () => {
    const evento: EventoReservado = { id: "evt-54", eventType: "PAYMENT_DELETED", idDoRecurso: "pay_54", leaseToken: "lease-54" };
    const payload = payloadDePagamento({ id: "pay_54" });
    payload.id = "evt-54";
    payload.event = "PAYMENT_DELETED";
    const db = dbFalso({
      reservarEventos: vi.fn(async () => ({ data: [evento], error: null })),
      lerPayloads: vi.fn(async () => ({ data: [{ id: "evt-54", payload }], error: null })),
      aplicarEvento: vi.fn(async () => ({
        data: { resultado: "aplicado", organizationId: "org-54", alarme: "remover_assinatura_pendente" },
        error: null,
      })),
    });
    const logger = loggerFalso();
    const asaas = asaasFalso({
      buscarCobranca: vi.fn(async () => ({ removido: true }) as never),
      removerCobranca: vi.fn(async () => {
        throw erroIndisponivel(500);
      }),
    });

    const resumo = await processarEventosAsaas(deps({ db, asaas, logger }));

    expect(logger.warn).toHaveBeenCalledWith("asaas_processar_remover_cobranca_fallback_de_assinatura_falhou", expect.any(Object));
    expect(resumo.aplicados).toBe(1);
  });

  // ─── D-086: estorno total corta o acesso e os tokens ──────────────────────
  // O que o banco decide (contrato, tokens, marcador) é provado em
  // tests/invariants/estorno-total-corta-acesso-e-tokens.test.ts. Aqui se prova o
  // que o PROCESSADOR faz com o que o banco devolve: remover a assinatura no
  // Asaas (só GET e DELETE, nunca dentro de transação), gravar o marcador depois,
  // auditar, e não agir em parcial, chargeback nem em reentrega.

  describe("D-086: estorno total", () => {
    function cenario(eventType: string, alarme: string | null, resultado = "aplicado", assinatura: string | null = "sub_est") {
      const evento: EventoReservado = { id: "evt-60", eventType, idDoRecurso: "pay_60", leaseToken: "lease-60" };
      const payload = payloadDePagamento({ id: "pay_60", subscription: assinatura ?? undefined });
      payload.id = "evt-60";
      payload.event = eventType;
      const auditar = vi.fn(async () => undefined);
      const db = dbFalso({
        reservarEventos: vi.fn(async () => ({ data: [evento], error: null })),
        lerPayloads: vi.fn(async () => ({ data: [{ id: "evt-60", payload }], error: null })),
        aplicarEvento: vi.fn(async () => ({ data: { resultado, organizationId: "org-60", alarme }, error: null })),
      });
      const asaas = asaasFalso({
        buscarCobranca: vi.fn(async () =>
          cobrancaFake({ id: "pay_60", status: "REFUNDED", subscription: assinatura ?? undefined }),
        ),
      });
      return { db, asaas, auditar };
    }

    it("estorno total de assinatura: remove a assinatura no Asaas, depois grava o marcador, e audita com o motivo", async () => {
      const { db, asaas, auditar } = cenario(
        "PAYMENT_REFUNDED",
        "estorno_confirmado,estorno_cortou_acesso,remover_assinatura_pendente",
      );
      const ordem: string[] = [];
      asaas.removerAssinatura = vi.fn(async () => {
        ordem.push("remover");
      });
      db.marcarAssinaturaEncerrada = vi.fn(async () => {
        ordem.push("marcar");
        return { data: { jaRegistrado: false }, error: null };
      });

      await processarEventosAsaas(deps({ db, asaas, auditar }));

      expect(asaas.removerAssinatura).toHaveBeenCalledWith("sub_est");
      expect(asaas.removerCobranca).not.toHaveBeenCalled();
      expect(ordem).toEqual(["remover", "marcar"]);
      expect(db.marcarAssinaturaEncerrada).toHaveBeenCalledWith("org-60", "sub_est");
      expect(auditar).toHaveBeenCalledTimes(1);
      expect(auditar).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "billing.asaas_refund_cut",
          organizationId: "org-60",
          resourceType: "organization",
          resourceId: "org-60",
          metadata: expect.objectContaining({ motivo: "estorno_total", tipo: "assinatura", pagamento_asaas: "pay_60" }),
        }),
      );
    });

    it("estorno total de pacote: não remove assinatura nenhuma, só audita o corte de tokens", async () => {
      const { db, asaas, auditar } = cenario("PAYMENT_REFUNDED", "estorno_confirmado,estorno_removeu_tokens_do_pacote", "aplicado", null);

      await processarEventosAsaas(deps({ db, asaas, auditar }));

      expect(asaas.removerAssinatura).not.toHaveBeenCalled();
      expect(asaas.removerCobranca).not.toHaveBeenCalled();
      expect(db.marcarAssinaturaEncerrada).not.toHaveBeenCalled();
      expect(auditar).toHaveBeenCalledWith(
        expect.objectContaining({ metadata: expect.objectContaining({ motivo: "estorno_total", tipo: "pacote_tokens" }) }),
      );
    });

    it("estorno parcial e chargeback (só alarmam): nenhuma remoção, nenhum marcador, nenhuma auditoria de corte", async () => {
      for (const [tipo, alarme] of [
        ["PAYMENT_PARTIALLY_REFUNDED", "parcialmente_estornado"],
        ["PAYMENT_CHARGEBACK_REQUESTED", "chargeback_confirmado"],
      ] as const) {
        const { db, asaas, auditar } = cenario(tipo, alarme);
        await processarEventosAsaas(deps({ db, asaas, auditar }));
        expect(asaas.removerAssinatura, tipo).not.toHaveBeenCalled();
        expect(db.marcarAssinaturaEncerrada, tipo).not.toHaveBeenCalled();
        expect(auditar, tipo).not.toHaveBeenCalled();
      }
    });

    it("reentrega (o banco devolve ja_aplicado, sem alarme): não remove de novo nem audita de novo", async () => {
      const { db, asaas, auditar } = cenario("PAYMENT_REFUNDED", null, "ja_aplicado");
      const resumo = await processarEventosAsaas(deps({ db, asaas, auditar }));

      expect(resumo.jaAplicados).toBe(1);
      expect(asaas.removerAssinatura).not.toHaveBeenCalled();
      expect(db.marcarAssinaturaEncerrada).not.toHaveBeenCalled();
      expect(auditar).not.toHaveBeenCalled();
    });

    it("DELETE da assinatura falha: só loga (a conciliação refaz), sem marcador, e a auditoria do corte sai mesmo assim", async () => {
      const { db, asaas, auditar } = cenario(
        "PAYMENT_REFUNDED",
        "estorno_confirmado,estorno_cortou_acesso,remover_assinatura_pendente",
      );
      asaas.removerAssinatura = vi.fn(async () => {
        throw erroIndisponivel(500);
      });
      const logger = loggerFalso();

      const resumo = await processarEventosAsaas(deps({ db, asaas, auditar, logger }));

      expect(logger.warn).toHaveBeenCalledWith("asaas_processar_remover_assinatura_falhou", expect.any(Object));
      expect(db.marcarAssinaturaEncerrada).not.toHaveBeenCalled();
      expect(auditar).toHaveBeenCalledTimes(1);
      expect(resumo.aplicados).toBe(1);
    });

    it("auditoria que lança não derruba o evento nem impede a remoção", async () => {
      const { db, asaas } = cenario(
        "PAYMENT_REFUNDED",
        "estorno_confirmado,estorno_cortou_acesso,remover_assinatura_pendente",
      );
      const auditar = vi.fn(async () => {
        throw new Error("banco de auditoria fora");
      });

      const resumo = await processarEventosAsaas(deps({ db, asaas, auditar }));

      expect(resumo.aplicados).toBe(1);
      expect(asaas.removerAssinatura).toHaveBeenCalledWith("sub_est");
    });

    it("estorno_corte_falhou: loga um erro (o evento fechou aplicado, mas nada foi cortado), mantém a remoção da assinatura e não audita corte", async () => {
      const { db, asaas, auditar } = cenario(
        "PAYMENT_REFUNDED",
        "estorno_confirmado,estorno_corte_falhou,remover_assinatura_pendente",
      );
      const logger = loggerFalso();

      await processarEventosAsaas(deps({ db, asaas, auditar, logger }));

      expect(logger.error).toHaveBeenCalledWith("alarme_asaas_estorno_corte_falhou", expect.objectContaining({ eventoId: "evt-60" }));
      expect(asaas.removerAssinatura).toHaveBeenCalledWith("sub_est");
      expect(auditar).not.toHaveBeenCalled();
    });

    it("estorno_de_periodo_antigo: loga o alarme, não remove a assinatura, não grava marcador e não audita corte", async () => {
      const { db, asaas, auditar } = cenario("PAYMENT_REFUNDED", "estorno_confirmado,estorno_de_periodo_antigo");
      const logger = loggerFalso();

      await processarEventosAsaas(deps({ db, asaas, auditar, logger }));

      expect(logger.warn).toHaveBeenCalledWith("alarme_asaas_estorno_de_periodo_antigo", expect.objectContaining({ eventoId: "evt-60" }));
      expect(asaas.removerAssinatura).not.toHaveBeenCalled();
      expect(db.marcarAssinaturaEncerrada).not.toHaveBeenCalled();
      expect(auditar).not.toHaveBeenCalled();
    });

    it("estorno_encurtou_periodo: loga o alarme (o período encolheu, o acesso segue), não remove a assinatura e não audita corte", async () => {
      const { db, asaas, auditar } = cenario("PAYMENT_REFUNDED", "estorno_confirmado,estorno_encurtou_periodo");
      const logger = loggerFalso();

      await processarEventosAsaas(deps({ db, asaas, auditar, logger }));

      expect(logger.warn).toHaveBeenCalledWith("alarme_asaas_estorno_encurtou_periodo", expect.objectContaining({ eventoId: "evt-60" }));
      expect(asaas.removerAssinatura).not.toHaveBeenCalled();
      expect(db.marcarAssinaturaEncerrada).not.toHaveBeenCalled();
      expect(auditar).not.toHaveBeenCalled();
    });

    it("D-177 M1: estorno parcial do parcelamento loga o alarme (o evento fecha aplicado, sem corte)", async () => {
      const { db, asaas, auditar } = cenario("PAYMENT_REFUNDED", "estorno_confirmado,estorno_parcial_do_parcelamento");
      const logger = loggerFalso();

      await processarEventosAsaas(deps({ db, asaas, auditar, logger }));

      expect(logger.warn).toHaveBeenCalledWith("alarme_asaas_estorno_parcial_do_parcelamento", expect.objectContaining({ eventoId: "evt-60" }));
      expect(asaas.removerAssinatura).not.toHaveBeenCalled();
      expect(auditar).not.toHaveBeenCalled();
    });

    it("D-177 M1: chargeback confirmado loga o alarme (o pedido segue pago, o admin decide)", async () => {
      const { db, asaas, auditar } = cenario("PAYMENT_CHARGEBACK_REQUESTED", "chargeback_confirmado");
      const logger = loggerFalso();

      await processarEventosAsaas(deps({ db, asaas, auditar, logger }));

      expect(logger.warn).toHaveBeenCalledWith("alarme_asaas_chargeback_confirmado", expect.objectContaining({ eventoId: "evt-60" }));
      expect(asaas.removerAssinatura).not.toHaveBeenCalled();
      expect(auditar).not.toHaveBeenCalled();
    });

    it("D-177 B4: parcelamento removido com pagamento loga o alarme", async () => {
      const { db, asaas, auditar } = cenario("PAYMENT_CONFIRMED", "parcelamento_removido_com_pagamento", "divergente");
      const logger = loggerFalso();

      await processarEventosAsaas(deps({ db, asaas, auditar, logger }));

      expect(logger.warn).toHaveBeenCalledWith("alarme_asaas_parcelamento_removido_com_pagamento", expect.objectContaining({ eventoId: "evt-60" }));
    });

    it("sem o auditar injetado o corte segue igual", async () => {
      const { db, asaas } = cenario(
        "PAYMENT_REFUNDED",
        "estorno_confirmado,estorno_cortou_acesso,remover_assinatura_pendente",
      );
      await processarEventosAsaas(deps({ db, asaas }));
      expect(asaas.removerAssinatura).toHaveBeenCalledWith("sub_est");
    });
  });
});

describe("D-177: parcela de um parcelamento no cartão", () => {
  const INSTALLMENT = "7315c152-a55f-4727-aa6c-d48249df28d4";

  function dbDaParcela(aplicar = vi.fn(async () => ({ data: { resultado: "aplicado", organizationId: "org-1", alarme: null }, error: null }))) {
    const evento = eventoDinheiro({ eventType: "PAYMENT_CONFIRMED", idDoRecurso: "pay_parcela2" });
    const payload = payloadDePagamento({ id: "pay_parcela2", installment: INSTALLMENT });
    payload.event = "PAYMENT_CONFIRMED";
    return dbFalso({
      reservarEventos: vi.fn(async () => ({ data: [evento], error: null })),
      lerPayloads: vi.fn(async () => ({ data: [{ id: "evt-1", payload }], error: null })),
      aplicarEvento: aplicar,
    });
  }

  it("lê o total do parcelamento (GET /installments) e manda ao banco, nunca só o valor da parcela", async () => {
    const db = dbDaParcela();
    const cobranca = cobrancaFake({ id: "pay_parcela2", status: "CONFIRMED", value: 275.43, installment: INSTALLMENT } as Partial<CobrancaAsaas>);
    const asaas = asaasFalso({
      buscarCobranca: vi.fn(async () => cobranca),
      buscarParcelamento: vi.fn(async () => ({ id: INSTALLMENT, value: 1101.72, installmentCount: 4 })),
    });

    await processarEventosAsaas(deps({ db, asaas }));

    expect(asaas.buscarParcelamento).toHaveBeenCalledWith(INSTALLMENT);
    expect(db.aplicarEvento).toHaveBeenCalledWith(
      "evt-1",
      "lease-1",
      expect.objectContaining({ id: "pay_parcela2", value: 275.43, installment: INSTALLMENT, parcelamento_total: 1101.72, parcelamento_parcelas: 4 }),
    );
  });

  it("GET do parcelamento falhou: não aplica nada e registra a falha para tentar de novo", async () => {
    const db = dbDaParcela();
    const asaas = asaasFalso({
      buscarCobranca: vi.fn(async () => cobrancaFake({ id: "pay_parcela2", status: "CONFIRMED", installment: INSTALLMENT } as Partial<CobrancaAsaas>)),
      buscarParcelamento: vi.fn(async () => {
        throw erroIndisponivel(503);
      }),
    });

    const resumo = await processarEventosAsaas(deps({ db, asaas }));

    expect(db.aplicarEvento).not.toHaveBeenCalled();
    expect(db.registrarFalha).toHaveBeenCalled();
    expect(resumo.falhas).toBe(1);
  });

  describe("M2: o banco só concede o período com todas as parcelas confirmadas", () => {
    const cobrancaDaParcela = () =>
      cobrancaFake({ id: "pay_parcela2", status: "CONFIRMED", value: 100, installment: INSTALLMENT } as Partial<CobrancaAsaas>);
    const parcelas = (statuses: string[]): CobrancaAsaas[] =>
      statuses.map((status, i) => cobrancaFake({ id: `pay_p${i + 1}`, status, installment: INSTALLMENT } as Partial<CobrancaAsaas>));

    async function rodar(lista: CobrancaAsaas[], total = 12) {
      const db = dbDaParcela();
      const asaas = asaasFalso({
        buscarCobranca: vi.fn(async () => cobrancaDaParcela()),
        buscarParcelamento: vi.fn(async () => ({ id: INSTALLMENT, value: 1200, installmentCount: total })),
        listarCobrancasDoParcelamento: vi.fn(async () => lista),
      });
      await processarEventosAsaas(deps({ db, asaas }));
      return { db, asaas };
    }

    it("1 de 12 confirmada: lista as parcelas e declara 1 de 12 ao banco (o banco não concede, ver parcelamento-banco.test.ts)", async () => {
      const { db, asaas } = await rodar(parcelas(["CONFIRMED", ...Array(11).fill("PENDING")]));

      expect(asaas.listarCobrancasDoParcelamento).toHaveBeenCalledWith(INSTALLMENT);
      expect(db.aplicarEvento).toHaveBeenCalledWith(
        "evt-1",
        "lease-1",
        expect.objectContaining({ parcelamento_parcelas: 12, parcelamento_confirmadas: 1 }),
      );
    });

    it("12 de 12 confirmadas: declara 12 de 12, contando CONFIRMED, RECEIVED e RECEIVED_IN_CASH", async () => {
      const { db } = await rodar(parcelas([...Array(10).fill("CONFIRMED"), "RECEIVED", "RECEIVED_IN_CASH"]));

      expect(db.aplicarEvento).toHaveBeenCalledTimes(1);
      expect(db.aplicarEvento).toHaveBeenCalledWith(
        "evt-1",
        "lease-1",
        expect.objectContaining({ parcelamento_parcelas: 12, parcelamento_confirmadas: 12 }),
      );
    });

    it("estorno, vencida, pendente e chargeback não contam como confirmadas", async () => {
      const { db } = await rodar(parcelas(["CONFIRMED", "REFUNDED", "OVERDUE", "PENDING", "CHARGEBACK_REQUESTED", "RECEIVED"]), 6);

      expect(db.aplicarEvento).toHaveBeenCalledWith(
        "evt-1",
        "lease-1",
        expect.objectContaining({ parcelamento_confirmadas: 2 }),
      );
    });

    it("cobrança repetida na lista conta uma vez, e cobrança de outro parcelamento não conta", async () => {
      const lista = [
        ...parcelas(["CONFIRMED", "CONFIRMED"]),
        cobrancaFake({ id: "pay_p1", status: "CONFIRMED", installment: INSTALLMENT } as Partial<CobrancaAsaas>),
        cobrancaFake({ id: "pay_outra", status: "CONFIRMED", installment: "outro-parcelamento-0000" } as Partial<CobrancaAsaas>),
      ];
      const { db } = await rodar(lista, 4);

      expect(db.aplicarEvento).toHaveBeenCalledWith(
        "evt-1",
        "lease-1",
        expect.objectContaining({ parcelamento_confirmadas: 2 }),
      );
    });

    it("a listagem das parcelas falhou: não aplica nada e registra a falha para tentar de novo", async () => {
      const db = dbDaParcela();
      const asaas = asaasFalso({
        buscarCobranca: vi.fn(async () => cobrancaDaParcela()),
        buscarParcelamento: vi.fn(async () => ({ id: INSTALLMENT, value: 1200, installmentCount: 12 })),
        listarCobrancasDoParcelamento: vi.fn(async () => {
          throw erroIndisponivel(503);
        }),
      });

      const resumo = await processarEventosAsaas(deps({ db, asaas }));

      expect(db.aplicarEvento).not.toHaveBeenCalled();
      expect(db.registrarFalha).toHaveBeenCalled();
      expect(resumo.falhas).toBe(1);
    });
  });

  it("B4: parcelamento removido no Asaas com parcela CONFIRMED não é ignorado em silêncio: o banco recebe a confirmação com o aviso", async () => {
    const db = dbDaParcela();
    const asaas = asaasFalso({
      buscarCobranca: vi.fn(async () => cobrancaFake({ id: "pay_parcela2", status: "CONFIRMED", value: 100, installment: INSTALLMENT } as Partial<CobrancaAsaas>)),
      buscarParcelamento: vi.fn(async () => ({ removido: true as const })),
    });

    await processarEventosAsaas(deps({ db, asaas }));

    expect(asaas.listarCobrancasDoParcelamento).not.toHaveBeenCalled();
    expect(db.aplicarEvento).toHaveBeenCalledTimes(1);
    expect(db.aplicarEvento).toHaveBeenCalledWith(
      "evt-1",
      "lease-1",
      expect.objectContaining({ id: "pay_parcela2", status: "CONFIRMED", installment: INSTALLMENT, parcelamento_removido: true }),
    );
    const confirmacao = (db.aplicarEvento as ReturnType<typeof vi.fn>).mock.calls[0]![2] as Record<string, unknown>;
    expect(confirmacao).not.toHaveProperty("parcelamento_total");
  });

  it("pagamento sem parcelamento não consulta /installments", async () => {
    const evento = eventoDinheiro();
    const db = dbFalso({
      reservarEventos: vi.fn(async () => ({ data: [evento], error: null })),
      lerPayloads: vi.fn(async () => ({ data: [{ id: "evt-1", payload: payloadDePagamento() }], error: null })),
      aplicarEvento: vi.fn(async () => ({ data: { resultado: "aplicado", organizationId: "org-1", alarme: null }, error: null })),
    });
    const asaas = asaasFalso({ buscarCobranca: vi.fn(async () => cobrancaFake()) });
    await processarEventosAsaas(deps({ db, asaas }));
    expect(asaas.buscarParcelamento).not.toHaveBeenCalled();
  });

  it("parcela vencida de pedido parcelado: remove o parcelamento INTEIRO, não só a parcela", async () => {
    const evento: EventoReservado = { id: "evt-9", eventType: "PAYMENT_OVERDUE", idDoRecurso: "pay_parcela1", leaseToken: "lease-9" };
    const payload = payloadDePagamento({ id: "pay_parcela1", installment: INSTALLMENT });
    payload.id = "evt-9";
    payload.event = "PAYMENT_OVERDUE";
    const db = dbFalso({
      reservarEventos: vi.fn(async () => ({ data: [evento], error: null })),
      lerPayloads: vi.fn(async () => ({ data: [{ id: "evt-9", payload }], error: null })),
      aplicarEvento: vi.fn(async () => ({ data: { resultado: "aplicado", organizationId: "org-1", alarme: "remover_cobranca_pendente" }, error: null })),
    });
    const asaas = asaasFalso({
      buscarCobranca: vi.fn(async () => cobrancaFake({ id: "pay_parcela1", status: "OVERDUE", installment: INSTALLMENT } as Partial<CobrancaAsaas>)),
    });

    await processarEventosAsaas(deps({ db, asaas }));

    expect(db.aplicarEvento).toHaveBeenCalledWith("evt-9", "lease-9", expect.objectContaining({ installment: INSTALLMENT }));
    expect(asaas.removerParcelamento).toHaveBeenCalledWith(INSTALLMENT);
    expect(asaas.removerCobranca).not.toHaveBeenCalled();
  });
});

describe("processarEventosAsaas: o aviso por e-mail roda dentro do fluxo do evento, logo depois do efeito gravado", () => {
  function tresPagamentos() {
    const eventos = [1, 2, 3].map((n) =>
      eventoDinheiro({ id: `evt-${n}`, idDoRecurso: `pay_${n}`, leaseToken: `lease-${n}` }),
    );
    const ordem: string[] = [];
    const db = dbFalso({
      reservarEventos: vi.fn(async () => ({ data: eventos, error: null })),
      lerPayloads: vi.fn(async () => ({
        data: eventos.map((e) => ({ id: e.id, payload: payloadDePagamento({ id: e.idDoRecurso }) })),
        error: null,
      })),
      aplicarEvento: vi.fn(async (eventoId: string) => {
        ordem.push(`aplicar:${eventoId}`);
        return { data: { resultado: "aplicado", organizationId: "org-1", alarme: null }, error: null };
      }),
    });
    const asaas = asaasFalso({
      buscarCobranca: vi.fn(async (id: string) => cobrancaFake({ id })),
    });
    return { eventos, ordem, db, asaas };
  }

  it("cada aviso sai logo depois de o seu evento ser aplicado e antes do evento seguinte", async () => {
    const { ordem, db, asaas } = tresPagamentos();
    const avisos = {
      aoAplicar: vi.fn(async (e: { idDoPagamento: string | null }) => {
        ordem.push(`aviso:${e.idDoPagamento}`);
      }),
    };

    const resumo = await processarEventosAsaas(deps({ db, asaas, avisos }));

    expect(resumo.aplicados).toBe(3);
    expect(ordem).toEqual([
      "aplicar:evt-1",
      "aviso:pay_1",
      "aplicar:evt-2",
      "aviso:pay_2",
      "aplicar:evt-3",
      "aviso:pay_3",
    ]);
  });

  it("aviso que lança vira log, não muda o resumo e não impede os seguintes", async () => {
    const { db, asaas } = tresPagamentos();
    const logger = loggerFalso();
    const entregues: string[] = [];
    const avisos = {
      aoAplicar: vi.fn(async (e: { idDoPagamento: string | null }) => {
        if (e.idDoPagamento === "pay_2") throw new Error("banco caiu");
        entregues.push(String(e.idDoPagamento));
      }),
    };

    const resumo = await processarEventosAsaas(deps({ db, asaas, avisos, logger }));

    expect(resumo).toMatchObject({ aplicados: 3, falhas: 0 });
    expect(entregues).toEqual(["pay_1", "pay_3"]);
    expect(logger.warn).toHaveBeenCalledWith("asaas_processar_aviso_ao_cliente_falhou", expect.any(Object));
  });

  it("orçamento da rodada esgotado: os eventos já aplicados foram avisados, e só eles", async () => {
    const { db, asaas } = tresPagamentos();
    let relogio = 0;
    const agora = () => new Date((relogio += 20));
    const entregues: string[] = [];
    const avisos = {
      aoAplicar: vi.fn(async (e: { idDoPagamento: string | null }) => {
        entregues.push(String(e.idDoPagamento));
      }),
    };

    const resumo = await processarEventosAsaas(deps({ db, asaas, avisos, agora, orcamentoMs: 50 }));

    expect(resumo.cortadoPeloOrcamento).toBe(true);
    expect(resumo.processados).toBeLessThan(3);
    expect(entregues).toHaveLength(resumo.processados);
  });

  it("evento que o banco não aplicou não chega ao aviso", async () => {
    const { db, asaas } = tresPagamentos();
    db.aplicarEvento = vi.fn(async () => ({ data: null, error: { code: "XX000", message: "boom" } }));
    const avisos = { aoAplicar: vi.fn(async () => undefined) };
    await processarEventosAsaas(deps({ db, asaas, avisos }));
    expect(avisos.aoAplicar).not.toHaveBeenCalled();
  });

  it("sem avisos injetados o processamento é o de sempre", async () => {
    const { db, asaas } = tresPagamentos();
    const resumo = await processarEventosAsaas(deps({ db, asaas }));
    expect(resumo.aplicados).toBe(3);
  });
});
