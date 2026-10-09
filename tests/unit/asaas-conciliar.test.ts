/**
 * `lib/billing/asaas/conciliar.ts`: fase F5, Tarefa 16, decisão 21.
 *
 * RESTRIÇÃO ABSOLUTA: nenhuma chamada real sai destes testes. `DbConciliarAsaas`
 * e `ClienteAsaasHttp` são sempre dublês em memória (`vi.fn`); nenhum `fetch`
 * é usado aqui (o cliente HTTP de verdade já é testado com `fetch` falso em
 * `tests/unit/asaas-cliente.test.ts`).
 */
import { describe, expect, it, vi } from "vitest";

import type { ClienteAsaasHttp } from "@/lib/billing/asaas/cliente";
import {
  conciliarAsaas,
  criarDbConciliarAsaasSobre,
  type AssinaturaAtivaParaConciliar,
  type DbConciliarAsaas,
  type DepsConciliarAsaas,
  type PedidoParaConciliar,
  type PedidoParceladoComParcelaFaltando,
  type PedidoVencidoParaRemocao,
} from "@/lib/billing/asaas/conciliar";
import type { ConfigAsaas } from "@/lib/billing/asaas/config";
import type { AssinaturaAsaas, CobrancaAsaas } from "@/lib/billing/asaas/contratos";
import { erroConfiguracao, erroIndisponivel } from "@/lib/billing/asaas/erros";

const CONFIG_SANDBOX: ConfigAsaas = {
  habilitado: true,
  baseUrl: "https://api-sandbox.asaas.com/v3",
  apiKey: "$aact_hmlg_testeNuncaEUmaChaveReal000111222",
  webhookToken: "token-de-teste-nunca-real",
  webhookId: "wh_1",
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

function pedidoFake(overrides: Partial<PedidoParaConciliar> = {}): PedidoParaConciliar {
  return {
    id: "pedido-1",
    organizationId: "org-1",
    ambiente: "sandbox",
    tipo: "pacote_tokens",
    status: "aguardando_pagamento",
    externalReference: "HC:ord:pedido-1",
    asaasPaymentId: "pay_fake123",
    asaasSubscriptionId: null,
    ...overrides,
  };
}

function asaasFalso(overrides: Partial<ClienteAsaasHttp> = {}): ClienteAsaasHttp {
  return {
    buscarClientePorReferencia: vi.fn(async () => null),
    criarCliente: vi.fn(async () => {
      throw new Error("criarCliente não deveria ser chamado pela conciliação");
    }),
    atualizarCliente: vi.fn(async () => {
      throw new Error("atualizarCliente não deveria ser chamado pela conciliação");
    }),
    criarAssinatura: vi.fn(async () => {
      throw new Error("criarAssinatura não deveria ser chamado pela conciliação");
    }),
    buscarAssinatura: vi.fn(async () => assinaturaFake()),
    listarCobrancasDaAssinatura: vi.fn(async () => []),
    buscarAssinaturaPorReferencia: vi.fn(async () => null),
    removerAssinatura: vi.fn(async () => undefined),
    criarCobranca: vi.fn(async () => {
      throw new Error("criarCobranca não deveria ser chamado pela conciliação");
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
      throw new Error("qrPix não deveria ser chamado pela conciliação");
    }),
    buscarWebhook: vi.fn(async () => ({ id: "wh_1", interrupted: false })),
    ...overrides,
  };
}

function dbFalso(overrides: Partial<DbConciliarAsaas> = {}): DbConciliarAsaas {
  return {
    listarPedidosPendentes: vi.fn(async () => ({ data: [], error: null })),
    listarPedidosVencidosParaRemocao: vi.fn(async () => ({ data: [], error: null })),
    listarAssinaturasAtivas: vi.fn(async () => ({ data: [], error: null })),
    listarPedidosParceladosComParcelaFaltando: vi.fn(async () => ({ data: [], error: null })),
    listarContratosCanceladosComAssinaturaViva: vi.fn(async () => ({ data: [], error: null })),
    marcarAssinaturaEncerrada: vi.fn(async () => ({ data: {}, error: null })),
    clienteAsaasDaOrganizacao: vi.fn(async () => ({ data: "cus_fake123", error: null })),
    marcarPedidoInconclusivo: vi.fn(async () => ({ data: {}, error: null })),
    registrarEventoSintetico: vi.fn(async () => ({ data: { novo: true }, error: null })),
    podarEventos: vi.fn(async () => ({ data: { podados: 0 }, error: null })),
    contadoresDeAlarme: vi.fn(async () => ({
      contadores: {
        pendenteHaMaisDeUmaHora: 0,
        erroUltimas24h: 0,
        divergenteUltimas24h: 0,
        semVinculoUltimas24h: 0,
        estornoComCorteFalhouUltimas24h: 0,
        estornoDePeriodoAntigoUltimas24h: 0,
        estornoParcialDoParcelamentoUltimas24h: 0,
        chargebackConfirmadoUltimas24h: 0,
        parcelamentoRemovidoComPagamentoUltimas24h: 0,
        semEventoHa3DiasComAssinaturaAtiva: 0,
      },
      leituraFalhou: false,
    })),
    ...overrides,
  };
}

function loggerFalso() {
  return { warn: vi.fn(), error: vi.fn() };
}

function deps(overrides: Partial<DepsConciliarAsaas> = {}): DepsConciliarAsaas {
  return {
    db: dbFalso(),
    asaas: asaasFalso(),
    config: CONFIG_SANDBOX,
    logger: loggerFalso(),
    ...overrides,
  };
}

describe("conciliarAsaas", () => {
  it("sem ASAAS_ENABLED: não toca banco nem o Asaas, resumo zerado", async () => {
    const db = dbFalso();
    const asaas = asaasFalso();
    const resumo = await conciliarAsaas(deps({ db, asaas, config: { ...CONFIG_SANDBOX, habilitado: false } }));

    expect(db.listarPedidosPendentes).not.toHaveBeenCalled();
    expect(db.podarEventos).not.toHaveBeenCalled();
    expect(asaas.buscarCobranca).not.toHaveBeenCalled();
    expect(resumo).toMatchObject({ habilitado: false, pedidosAnalisados: 0, falhas: 0 });
  });

  it("pedido processando travado: marca inconclusivo, sem gastar GET", async () => {
    const pedido = pedidoFake({ status: "processando", asaasPaymentId: null });
    const db = dbFalso({ listarPedidosPendentes: vi.fn(async () => ({ data: [pedido], error: null })) });
    const asaas = asaasFalso();
    const resumo = await conciliarAsaas(deps({ db, asaas }));

    expect(db.marcarPedidoInconclusivo).toHaveBeenCalledWith("org-1", "pedido-1", expect.any(String));
    expect(asaas.buscarCobranca).not.toHaveBeenCalled();
    expect(resumo.pedidosMarcadosInconclusivo).toBe(1);
  });

  it("cobrança paga sem evento aplicado: injeta evento sintético com o event_id conc:<id>:<status>, MESMO caminho (registrarEventoSintetico)", async () => {
    const pedido = pedidoFake({ status: "aguardando_pagamento" });
    const cobranca = cobrancaFake({ id: "pay_fake123", status: "CONFIRMED" });
    const db = dbFalso({ listarPedidosPendentes: vi.fn(async () => ({ data: [pedido], error: null })) });
    const asaas = asaasFalso({ buscarCobranca: vi.fn(async () => cobranca) });
    const resumo = await conciliarAsaas(deps({ db, asaas }));

    expect(db.registrarEventoSintetico).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: "conc:pay_fake123:CONFIRMED",
        eventType: "PAYMENT_CONFIRMED",
        idDoRecurso: "pay_fake123",
        ambiente: "sandbox",
        payload: expect.objectContaining({
          id: "conc:pay_fake123:CONFIRMED",
          event: "PAYMENT_CONFIRMED",
          payment: expect.objectContaining({ id: "pay_fake123" }),
        }),
      }),
    );
    expect(resumo.eventosSinteticos).toBe(1);
  });

  it("cobrança vencida (OVERDUE) e pedido ainda não vencido: injeta PAYMENT_OVERDUE sintético", async () => {
    const pedido = pedidoFake({ status: "aguardando_pagamento" });
    const cobranca = cobrancaFake({ id: "pay_fake123", status: "OVERDUE" });
    const db = dbFalso({ listarPedidosPendentes: vi.fn(async () => ({ data: [pedido], error: null })) });
    const asaas = asaasFalso({ buscarCobranca: vi.fn(async () => cobranca) });
    const resumo = await conciliarAsaas(deps({ db, asaas }));

    expect(db.registrarEventoSintetico).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: "conc:pay_fake123:OVERDUE", eventType: "PAYMENT_OVERDUE" }),
    );
    expect(resumo.eventosSinteticos).toBe(1);
  });

  it("banco e Asaas já concordam (pedido pago, cobrança CONFIRMED): nenhum evento sintético", async () => {
    const pedido = pedidoFake({ status: "pago" });
    const cobranca = cobrancaFake({ id: "pay_fake123", status: "CONFIRMED" });
    const db = dbFalso({ listarPedidosPendentes: vi.fn(async () => ({ data: [pedido], error: null })) });
    const asaas = asaasFalso({ buscarCobranca: vi.fn(async () => cobranca) });
    const resumo = await conciliarAsaas(deps({ db, asaas }));

    expect(db.registrarEventoSintetico).not.toHaveBeenCalled();
    expect(resumo.eventosSinteticos).toBe(0);
  });

  it("pedido inconclusivo sem cobrança achada pela referência: sem evento, sem mutação, pedido já retomável", async () => {
    const pedido = pedidoFake({
      status: "inconclusivo",
      asaasPaymentId: null,
      asaasSubscriptionId: null,
      tipo: "pacote_tokens",
    });
    const db = dbFalso({ listarPedidosPendentes: vi.fn(async () => ({ data: [pedido], error: null })) });
    const asaas = asaasFalso({ buscarCobrancaPorReferencia: vi.fn(async () => null) });
    const resumo = await conciliarAsaas(deps({ db, asaas }));

    expect(asaas.buscarCobrancaPorReferencia).toHaveBeenCalledWith("HC:ord:pedido-1");
    expect(db.registrarEventoSintetico).not.toHaveBeenCalled();
    expect(db.marcarPedidoInconclusivo).not.toHaveBeenCalled();
    expect(resumo.semCobrancaEncontrada).toBe(1);
  });

  it("teto de 200 GET: para de consultar o Asaas ao esgotar o teto, sinaliza cortadoPeloTetoDeGets", async () => {
    const pedidos = Array.from({ length: 3 }, (_v, i) => pedidoFake({ id: `pedido-${i}`, asaasPaymentId: `pay_${i}` }));
    const db = dbFalso({ listarPedidosPendentes: vi.fn(async () => ({ data: pedidos, error: null })) });
    const asaas = asaasFalso({ buscarCobranca: vi.fn(async () => cobrancaFake({ status: "PENDING" })) });
    const resumo = await conciliarAsaas(deps({ db, asaas, limiteGets: 2 }));

    expect(asaas.buscarCobranca).toHaveBeenCalledTimes(2);
    expect(resumo.cortadoPeloTetoDeGets).toBe(true);
  });

  it("assinatura ativa removida no Asaas: injeta SUBSCRIPTION_DELETED sintético com o customer conhecido", async () => {
    const contrato: AssinaturaAtivaParaConciliar = { organizationId: "org-2", asaasSubscriptionId: "sub_fake123" };
    const clienteAsaasDaOrganizacao = vi.fn(async () => ({ data: "cus_conhecido", error: null }));
    const db = dbFalso({
      listarAssinaturasAtivas: vi.fn(async () => ({ data: [contrato], error: null })),
      clienteAsaasDaOrganizacao,
    });
    const asaas = asaasFalso({ buscarAssinatura: vi.fn(async () => ({ removido: true as const })) });
    const resumo = await conciliarAsaas(deps({ db, asaas }));

    expect(db.registrarEventoSintetico).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: "conc:sub_fake123:DELETED",
        eventType: "SUBSCRIPTION_DELETED",
        idDoRecurso: "sub_fake123",
        payload: expect.objectContaining({
          event: "SUBSCRIPTION_DELETED",
          subscription: expect.objectContaining({ id: "sub_fake123", customer: "cus_conhecido", deleted: true }),
        }),
      }),
    );
    expect(resumo.eventosSinteticos).toBe(1);
    // Correção 9: o cliente Asaas da organização é buscado FILTRANDO pelo
    // ambiente da configuração corrente, nunca o primeiro cliente achado
    // (uma organização pode ter cliente em sandbox e em produção).
    expect(clienteAsaasDaOrganizacao).toHaveBeenCalledWith("org-2", "sandbox");
  });

  it("assinatura ativa ainda existe no Asaas: nenhum evento", async () => {
    const contrato: AssinaturaAtivaParaConciliar = { organizationId: "org-2", asaasSubscriptionId: "sub_fake123" };
    const db = dbFalso({ listarAssinaturasAtivas: vi.fn(async () => ({ data: [contrato], error: null })) });
    const asaas = asaasFalso({ buscarAssinatura: vi.fn(async () => assinaturaFake({ status: "ACTIVE" })) });
    const resumo = await conciliarAsaas(deps({ db, asaas }));

    expect(db.registrarEventoSintetico).not.toHaveBeenCalled();
    expect(resumo.eventosSinteticos).toBe(0);
  });

  it("pedido vencido com cobrança gravada (pacote/avulso): refaz removerCobranca (decisão 10, A1)", async () => {
    const vencido: PedidoVencidoParaRemocao = {
      id: "pedido-3",
      organizationId: "org-3",
      tipo: "pacote_tokens",
      asaasPaymentId: "pay_velho",
      asaasSubscriptionId: null,
    };
    const db = dbFalso({ listarPedidosVencidosParaRemocao: vi.fn(async () => ({ data: [vencido], error: null })) });
    const asaas = asaasFalso({ removerCobranca: vi.fn(async () => undefined) });
    const resumo = await conciliarAsaas(deps({ db, asaas }));

    expect(asaas.removerCobranca).toHaveBeenCalledWith("pay_velho");
    expect(asaas.removerAssinatura).not.toHaveBeenCalled();
    expect(resumo.cobrancasRemovidas).toBe(1);
  });

  it("B6: pedido vencido que só tem o id do parcelamento (a cobrança não chegou a ser registrada): remove o parcelamento inteiro", async () => {
    const vencido: PedidoVencidoParaRemocao = {
      id: "pedido-5",
      organizationId: "org-5",
      tipo: "assinatura",
      asaasPaymentId: null,
      asaasSubscriptionId: null,
      asaasInstallmentId: "7315c152-a55f-4727-aa6c-d48249df28d4",
    };
    const db = dbFalso({ listarPedidosVencidosParaRemocao: vi.fn(async () => ({ data: [vencido], error: null })) });
    const asaas = asaasFalso({ removerParcelamento: vi.fn(async () => undefined) });
    const resumo = await conciliarAsaas(deps({ db, asaas }));

    expect(asaas.removerParcelamento).toHaveBeenCalledWith("7315c152-a55f-4727-aa6c-d48249df28d4");
    expect(asaas.removerCobranca).not.toHaveBeenCalled();
    expect(asaas.removerAssinatura).not.toHaveBeenCalled();
    expect(resumo.cobrancasRemovidas).toBe(1);
  });

  it("remoção de cobrança vencida falha de novo: alarme remover_cobranca_pendente", async () => {
    const vencido: PedidoVencidoParaRemocao = {
      id: "pedido-3",
      organizationId: "org-3",
      tipo: "pacote_tokens",
      asaasPaymentId: "pay_velho",
      asaasSubscriptionId: null,
    };
    const db = dbFalso({ listarPedidosVencidosParaRemocao: vi.fn(async () => ({ data: [vencido], error: null })) });
    const asaas = asaasFalso({
      removerCobranca: vi.fn(async () => {
        throw erroIndisponivel(500);
      }),
    });
    const logger = loggerFalso();
    const resumo = await conciliarAsaas(deps({ db, asaas, logger }));

    expect(logger.error).toHaveBeenCalledWith("alarme_asaas_remover_cobranca_pendente", expect.any(Object));
    expect(resumo.falhas).toBe(1);
  });

  it("pedido vencido do tipo assinatura com asaas_subscription_id: refaz removerAssinatura, nunca removerCobranca (correção 4)", async () => {
    const vencido: PedidoVencidoParaRemocao = {
      id: "pedido-4",
      organizationId: "org-4",
      tipo: "assinatura",
      asaasPaymentId: "pay_da_assinatura",
      asaasSubscriptionId: "sub_velha",
    };
    const db = dbFalso({ listarPedidosVencidosParaRemocao: vi.fn(async () => ({ data: [vencido], error: null })) });
    const asaas = asaasFalso({ removerAssinatura: vi.fn(async () => undefined) });
    const resumo = await conciliarAsaas(deps({ db, asaas }));

    expect(asaas.removerAssinatura).toHaveBeenCalledWith("sub_velha");
    expect(asaas.removerCobranca).not.toHaveBeenCalled();
    expect(resumo.cobrancasRemovidas).toBe(1);
  });

  it("remoção de assinatura vencida falha de novo: alarme remover_assinatura_pendente", async () => {
    const vencido: PedidoVencidoParaRemocao = {
      id: "pedido-4",
      organizationId: "org-4",
      tipo: "assinatura",
      asaasPaymentId: null,
      asaasSubscriptionId: "sub_velha",
    };
    const db = dbFalso({ listarPedidosVencidosParaRemocao: vi.fn(async () => ({ data: [vencido], error: null })) });
    const asaas = asaasFalso({
      removerAssinatura: vi.fn(async () => {
        throw erroIndisponivel(500);
      }),
    });
    const logger = loggerFalso();
    const resumo = await conciliarAsaas(deps({ db, asaas, logger }));

    expect(logger.error).toHaveBeenCalledWith("alarme_asaas_remover_assinatura_pendente", expect.any(Object));
    expect(resumo.falhas).toBe(1);
  });

  it("poda é chamada com os dias configurados (padrão 180)", async () => {
    const db = dbFalso({ podarEventos: vi.fn(async () => ({ data: { podados: 7 }, error: null })) });
    const resumo = await conciliarAsaas(deps({ db }));

    expect(db.podarEventos).toHaveBeenCalledWith(180);
    expect(resumo.podados).toBe(7);
  });

  it("cada contador de alarme de leitura.ts vira um logger.error", async () => {
    const contadores = {
      pendenteHaMaisDeUmaHora: 1,
      erroUltimas24h: 2,
      divergenteUltimas24h: 3,
      semVinculoUltimas24h: 4,
      estornoComCorteFalhouUltimas24h: 6,
      estornoDePeriodoAntigoUltimas24h: 7,
      estornoParcialDoParcelamentoUltimas24h: 8,
      chargebackConfirmadoUltimas24h: 9,
      parcelamentoRemovidoComPagamentoUltimas24h: 10,
      semEventoHa3DiasComAssinaturaAtiva: 5,
    };
    const db = dbFalso({ contadoresDeAlarme: vi.fn(async () => ({ contadores, leituraFalhou: false })) });
    const logger = loggerFalso();
    const resumo = await conciliarAsaas(deps({ db, logger }));

    expect(logger.error).toHaveBeenCalledWith("alarme_asaas_evento_pendente_ha_mais_de_uma_hora", { quantidade: 1 });
    expect(logger.error).toHaveBeenCalledWith("alarme_asaas_evento_em_erro_ultimas_24h", { quantidade: 2 });
    expect(logger.error).toHaveBeenCalledWith("alarme_asaas_evento_divergente_ultimas_24h", { quantidade: 3 });
    expect(logger.error).toHaveBeenCalledWith("alarme_asaas_evento_sem_vinculo_ultimas_24h", { quantidade: 4 });
    expect(logger.error).toHaveBeenCalledWith("alarme_asaas_estorno_corte_falhou_ultimas_24h", { quantidade: 6 });
    expect(logger.error).toHaveBeenCalledWith("alarme_asaas_estorno_de_periodo_antigo_ultimas_24h", { quantidade: 7 });
    expect(logger.error).toHaveBeenCalledWith("alarme_asaas_estorno_parcial_do_parcelamento_ultimas_24h", { quantidade: 8 });
    expect(logger.error).toHaveBeenCalledWith("alarme_asaas_chargeback_confirmado_ultimas_24h", { quantidade: 9 });
    expect(logger.error).toHaveBeenCalledWith("alarme_asaas_parcelamento_removido_com_pagamento_ultimas_24h", { quantidade: 10 });
    expect(logger.error).toHaveBeenCalledWith("alarme_asaas_sem_evento_ha_3_dias_com_assinatura_ativa", {
      quantidade: 5,
    });
    expect(resumo.contadores).toEqual(contadores);
  });

  it("fila do webhook interrompida (GET /webhooks/{id}): alarma e marca webhookInterrompido", async () => {
    const asaas = asaasFalso({ buscarWebhook: vi.fn(async () => ({ id: "wh_1", interrupted: true })) });
    const logger = loggerFalso();
    const resumo = await conciliarAsaas(deps({ asaas, logger, config: { ...CONFIG_SANDBOX, webhookId: "wh_1" } }));

    expect(asaas.buscarWebhook).toHaveBeenCalledWith("wh_1");
    expect(logger.error).toHaveBeenCalledWith("alarme_asaas_webhook_interrompido", { webhookId: "wh_1" });
    expect(resumo.webhookInterrompido).toBe(true);
  });

  it("fila do webhook saudável: não alarma", async () => {
    const asaas = asaasFalso({ buscarWebhook: vi.fn(async () => ({ id: "wh_1", interrupted: false })) });
    const logger = loggerFalso();
    const resumo = await conciliarAsaas(deps({ asaas, logger, config: { ...CONFIG_SANDBOX, webhookId: "wh_1" } }));

    expect(logger.error).not.toHaveBeenCalledWith("alarme_asaas_webhook_interrompido", expect.any(Object));
    expect(resumo.webhookInterrompido).toBe(false);
  });

  it("erro de CONFIGURAÇÃO num GET aborta o restante da rodada (sem tentar mais chamadas ao Asaas)", async () => {
    const pedido = pedidoFake();
    const contrato: AssinaturaAtivaParaConciliar = { organizationId: "org-2", asaasSubscriptionId: "sub_fake123" };
    const db = dbFalso({
      listarPedidosPendentes: vi.fn(async () => ({ data: [pedido], error: null })),
      listarAssinaturasAtivas: vi.fn(async () => ({ data: [contrato], error: null })),
    });
    const asaas = asaasFalso({
      buscarCobranca: vi.fn(async () => {
        throw erroConfiguracao("base e chave incoerentes");
      }),
    });
    const resumo = await conciliarAsaas(deps({ db, asaas }));

    expect(asaas.buscarAssinatura).not.toHaveBeenCalled();
    expect(asaas.removerCobranca).not.toHaveBeenCalled();
    // Poda e alarmes continuam rodando: não dependem do Asaas.
    expect(db.podarEventos).toHaveBeenCalled();
    expect(resumo.falhas).toBe(0);
  });

  describe("D-086: contrato cancelado por estorno total com a assinatura ainda viva", () => {
    const contrato = { organizationId: "org-9", asaasSubscriptionId: "sub_estornada" };

    it("pede ao banco só os contratos do AMBIENTE da instalação (sandbox não toca assinatura de produção)", async () => {
      const listar = vi.fn(async () => ({ data: [], error: null }));
      const db = dbFalso({ listarContratosCanceladosComAssinaturaViva: listar });
      await conciliarAsaas(deps({ db }));
      expect(listar).toHaveBeenCalledWith(expect.any(Number), "sandbox");

      const listarProducao = vi.fn(async () => ({ data: [], error: null }));
      await conciliarAsaas(
        deps({
          db: dbFalso({ listarContratosCanceladosComAssinaturaViva: listarProducao }),
          config: { ...CONFIG_SANDBOX, ambiente: "producao" },
        }),
      );
      expect(listarProducao).toHaveBeenCalledWith(expect.any(Number), "producao");
    });

    it("remove a assinatura no Asaas e DEPOIS grava o marcador", async () => {
      const ordem: string[] = [];
      const db = dbFalso({
        listarContratosCanceladosComAssinaturaViva: vi.fn(async () => ({ data: [contrato], error: null })),
        marcarAssinaturaEncerrada: vi.fn(async () => {
          ordem.push("marcar");
          return { data: {}, error: null };
        }),
      });
      const asaas = asaasFalso({
        removerAssinatura: vi.fn(async () => {
          ordem.push("remover");
        }),
      });
      const resumo = await conciliarAsaas(deps({ db, asaas }));

      expect(asaas.removerAssinatura).toHaveBeenCalledWith("sub_estornada");
      expect(db.marcarAssinaturaEncerrada).toHaveBeenCalledWith("org-9", "sub_estornada");
      expect(ordem).toEqual(["remover", "marcar"]);
      expect(resumo.falhas).toBe(0);
    });

    it("DELETE falhou: alarma, conta a falha e NÃO grava o marcador (recompra continua barrada, sem cobrança dupla)", async () => {
      const db = dbFalso({
        listarContratosCanceladosComAssinaturaViva: vi.fn(async () => ({ data: [contrato], error: null })),
      });
      const asaas = asaasFalso({
        removerAssinatura: vi.fn(async () => {
          throw erroIndisponivel(503);
        }),
      });
      const logger = loggerFalso();
      const resumo = await conciliarAsaas(deps({ db, asaas, logger }));

      expect(db.marcarAssinaturaEncerrada).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledWith("alarme_asaas_remover_assinatura_pendente", expect.any(Object));
      expect(resumo.falhas).toBe(1);
    });

    it("sem contrato nessa situação: não chama o Asaas", async () => {
      const asaas = asaasFalso();
      await conciliarAsaas(deps({ asaas }));
      expect(asaas.removerAssinatura).not.toHaveBeenCalled();
    });
  });
});

describe("B6 (D-177): a listagem dos pedidos vencidos inclui o que só tem o id do parcelamento", () => {
  function adminFalso(linhas: unknown[]) {
    const filtros: Array<[string, ...unknown[]]> = [];
    const builder: Record<string, unknown> = {};
    for (const metodo of ["select", "eq", "or", "limit"]) {
      builder[metodo] = (...args: unknown[]) => {
        filtros.push([metodo, ...args]);
        return builder;
      };
    }
    builder.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve({ data: linhas, error: null }).then(resolve, reject);
    return { admin: { from: () => builder } as never, filtros };
  }

  it("o filtro aceita pedido com asaas_installment_id e o mapeamento devolve o id do parcelamento", async () => {
    const { admin, filtros } = adminFalso([
      {
        id: "p-1",
        organization_id: "org-1",
        tipo: "assinatura",
        asaas_payment_id: null,
        asaas_subscription_id: null,
        asaas_installment_id: "7315c152-a55f-4727-aa6c-d48249df28d4",
      },
    ]);
    const r = await criarDbConciliarAsaasSobre(admin).listarPedidosVencidosParaRemocao(50);

    expect(r.error).toBeNull();
    expect(r.data).toEqual([
      {
        id: "p-1",
        organizationId: "org-1",
        tipo: "assinatura",
        asaasPaymentId: null,
        asaasSubscriptionId: null,
        asaasInstallmentId: "7315c152-a55f-4727-aa6c-d48249df28d4",
      },
    ]);
    const filtroOr = filtros.find((f) => f[0] === "or")?.[1] as string;
    expect(filtroOr).toContain("asaas_payment_id.not.is.null");
    expect(filtroOr).toContain("asaas_subscription_id.not.is.null");
    expect(filtroOr).toContain("asaas_installment_id.not.is.null");
  });
});

describe("D-086, M3 e B2: a listagem do passo 3b só devolve contrato cortado por estorno, do ambiente da instalação", () => {
  /** Admin falso encadeável: registra os filtros de cada consulta e devolve o resultado da tabela. */
  function adminFalso(resultados: Record<string, { data: unknown; error: null }>) {
    const filtros: Record<string, Array<[string, ...unknown[]]>> = {};
    const admin = {
      from(tabela: string) {
        const lista: Array<[string, ...unknown[]]> = (filtros[tabela] = filtros[tabela] ?? []);
        const builder: Record<string, unknown> = {};
        for (const metodo of ["select", "eq", "not", "is", "in", "limit"]) {
          builder[metodo] = (...args: unknown[]) => {
            lista.push([metodo, ...args]);
            return builder;
          };
        }
        builder.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
          Promise.resolve(resultados[tabela]).then(resolve, reject);
        return builder;
      },
    };
    return { admin: admin as never, filtros };
  }

  it("contrato cancelado pelo admin SEM evento de estorno não entra (a assinatura dele não é removida pela conciliação)", async () => {
    const { admin, filtros } = adminFalso({
      billing_contracts: {
        data: [
          { id: "c-estorno", organization_id: "org-a", asaas_subscription_id: "sub_a" },
          { id: "c-admin", organization_id: "org-b", asaas_subscription_id: "sub_b" },
        ],
        error: null,
      },
      // só o contrato c-estorno tem evento com motivo estorno_asaas
      billing_contract_eventos: { data: [{ contract_id: "c-estorno" }], error: null },
    });
    const r = await criarDbConciliarAsaasSobre(admin).listarContratosCanceladosComAssinaturaViva(50, "sandbox");

    expect(r.error).toBeNull();
    expect(r.data).toEqual([{ organizationId: "org-a", asaasSubscriptionId: "sub_a" }]);
    expect(filtros.billing_contract_eventos).toContainEqual(["eq", "motivo", "estorno_asaas"]);
    expect(filtros.billing_contract_eventos).toContainEqual(["in", "contract_id", ["c-estorno", "c-admin"]]);
  });

  it("filtra por status cancelada, marcador nulo e pelo AMBIENTE pedido", async () => {
    const { admin, filtros } = adminFalso({
      billing_contracts: { data: [], error: null },
      billing_contract_eventos: { data: [], error: null },
    });
    await criarDbConciliarAsaasSobre(admin).listarContratosCanceladosComAssinaturaViva(50, "producao");

    expect(filtros.billing_contracts).toContainEqual(["eq", "status", "cancelada"]);
    expect(filtros.billing_contracts).toContainEqual(["eq", "asaas_ambiente", "producao"]);
    expect(filtros.billing_contracts).toContainEqual(["is", "asaas_assinatura_encerrada_em", null]);
    // sem candidato, nem consulta os eventos
    expect(filtros.billing_contract_eventos).toBeUndefined();
  });
});

describe("D-177: parcela 2..N confirmada cujo webhook se perdeu entra no livro-caixa pela conciliação", () => {
  const INSTALLMENT = "7315c152-a55f-4727-aa6c-d48249df28d4";

  function parcelado(overrides: Partial<PedidoParceladoComParcelaFaltando> = {}): PedidoParceladoComParcelaFaltando {
    return {
      id: "pedido-parc-1",
      organizationId: "org-1",
      ambiente: "sandbox",
      asaasInstallmentId: INSTALLMENT,
      parcelas: 3,
      parcelasRegistradas: ["pay_1"],
      ...overrides,
    };
  }

  function parcela(n: number, status: string): CobrancaAsaas {
    return cobrancaFake({
      id: `pay_${n}`,
      status,
      installment: INSTALLMENT,
      installmentNumber: n,
      externalReference: "HC:ord:pedido-parc-1",
    });
  }

  function dbComParcelados(lista: PedidoParceladoComParcelaFaltando[]) {
    return dbFalso({ listarPedidosParceladosComParcelaFaltando: vi.fn(async () => ({ data: lista, error: null })) });
  }

  it("⭐ registra, pelo MESMO caminho do webhook, só as parcelas pagas que não têm linha em billing_payments", async () => {
    const db = dbComParcelados([parcelado()]);
    const asaas = asaasFalso({
      listarCobrancasDoParcelamento: vi.fn(async () => [parcela(1, "CONFIRMED"), parcela(2, "CONFIRMED"), parcela(3, "RECEIVED")]),
    });
    const resumo = await conciliarAsaas(deps({ db, asaas }));

    expect(asaas.listarCobrancasDoParcelamento).toHaveBeenCalledWith(INSTALLMENT);
    expect(db.registrarEventoSintetico).toHaveBeenCalledTimes(2);
    expect(db.registrarEventoSintetico).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: "conc:pay_2:CONFIRMED",
        eventType: "PAYMENT_CONFIRMED",
        idDoRecurso: "pay_2",
        ambiente: "sandbox",
        payload: expect.objectContaining({ event: "PAYMENT_CONFIRMED", payment: expect.objectContaining({ id: "pay_2" }) }),
      }),
    );
    expect(db.registrarEventoSintetico).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: "conc:pay_3:RECEIVED", eventType: "PAYMENT_RECEIVED", idDoRecurso: "pay_3" }),
    );
    expect(resumo.pedidosParceladosAnalisados).toBe(1);
    expect(resumo.parcelasRecuperadas).toBe(2);
    expect(resumo.falhas).toBe(0);
  });

  it("parcela ainda PENDING ou OVERDUE não vira evento (só dinheiro confirmado entra)", async () => {
    const db = dbComParcelados([parcelado({ parcelasRegistradas: ["pay_1"] })]);
    const asaas = asaasFalso({
      listarCobrancasDoParcelamento: vi.fn(async () => [parcela(1, "CONFIRMED"), parcela(2, "PENDING"), parcela(3, "OVERDUE")]),
    });
    const resumo = await conciliarAsaas(deps({ db, asaas }));

    expect(db.registrarEventoSintetico).not.toHaveBeenCalled();
    expect(resumo.parcelasRecuperadas).toBe(0);
  });

  it("idempotente: evento sintético que já existe (novo: false) não conta como recuperado nem como falha", async () => {
    const db = dbFalso({
      listarPedidosParceladosComParcelaFaltando: vi.fn(async () => ({ data: [parcelado()], error: null })),
      registrarEventoSintetico: vi.fn(async () => ({ data: { novo: false }, error: null })),
    });
    const asaas = asaasFalso({
      listarCobrancasDoParcelamento: vi.fn(async () => [parcela(1, "CONFIRMED"), parcela(2, "CONFIRMED"), parcela(3, "CONFIRMED")]),
    });
    const resumo = await conciliarAsaas(deps({ db, asaas }));

    expect(resumo.parcelasRecuperadas).toBe(0);
    expect(resumo.falhas).toBe(0);
  });

  it("falha ao registrar o evento: conta falha e segue para o próximo pedido", async () => {
    const db = dbFalso({
      listarPedidosParceladosComParcelaFaltando: vi.fn(async () => ({
        data: [parcelado({ id: "a" }), parcelado({ id: "b", asaasInstallmentId: "outro-parcelamento-1234" })],
        error: null,
      })),
      registrarEventoSintetico: vi.fn(async () => ({ data: null, error: { code: "XX000" } })),
    });
    const asaas = asaasFalso({ listarCobrancasDoParcelamento: vi.fn(async () => [parcela(2, "CONFIRMED")]) });
    const resumo = await conciliarAsaas(deps({ db, asaas }));

    expect(asaas.listarCobrancasDoParcelamento).toHaveBeenCalledTimes(2);
    expect(resumo.falhas).toBe(2);
  });

  it("falha na listagem do parcelamento num pedido não derruba os outros", async () => {
    const listar = vi
      .fn()
      .mockRejectedValueOnce(erroIndisponivel(503))
      .mockResolvedValueOnce([parcela(2, "CONFIRMED")]);
    const db = dbComParcelados([parcelado({ id: "a" }), parcelado({ id: "b", asaasInstallmentId: "outro-parcelamento-1234" })]);
    const resumo = await conciliarAsaas(deps({ db, asaas: asaasFalso({ listarCobrancasDoParcelamento: listar }) }));

    expect(resumo.falhas).toBe(1);
    expect(resumo.parcelasRecuperadas).toBe(1);
  });

  it("erro de CONFIGURAÇÃO na listagem aborta o passo, sem mais chamadas ao Asaas", async () => {
    const listar = vi.fn(async () => {
      throw erroConfiguracao("base e chave incoerentes");
    });
    const db = dbComParcelados([parcelado({ id: "a" }), parcelado({ id: "b", asaasInstallmentId: "outro-parcelamento-1234" })]);
    const resumo = await conciliarAsaas(deps({ db, asaas: asaasFalso({ listarCobrancasDoParcelamento: listar }) }));

    expect(listar).toHaveBeenCalledTimes(1);
    expect(resumo.falhas).toBe(0);
  });

  it("⭐ orçamento: no máximo `limitePedidosParcelados` pedidos por rodada, e os dias seguintes cobrem a lista toda sem repetir", async () => {
    const lista = Array.from({ length: 5 }, (_v, i) => parcelado({ id: `p-${i}`, asaasInstallmentId: `parcelamento-${i}-aaaa` }));
    const vistos: string[] = [];
    for (let dia = 0; dia < 3; dia += 1) {
      const asaas = asaasFalso({ listarCobrancasDoParcelamento: vi.fn(async () => []) });
      const resumo = await conciliarAsaas(
        deps({
          db: dbComParcelados(lista),
          asaas,
          limitePedidosParcelados: 2,
          agora: () => new Date(Date.UTC(2026, 9, 7 + dia, 12)),
        }),
      );
      expect(asaas.listarCobrancasDoParcelamento).toHaveBeenCalledTimes(2);
      expect(resumo.pedidosParceladosAnalisados).toBe(2);
      for (const chamada of vi.mocked(asaas.listarCobrancasDoParcelamento).mock.calls) vistos.push(chamada[0]);
    }
    // 3 rodadas x 2 pedidos = 6 consultas para 5 pedidos: todos vistos, só um repete (a volta da janela).
    expect(new Set(vistos).size).toBe(5);
  });

  it("⭐ o teto de GET da rodada é dividido com os outros passos: sem GET restante, nem lista parcelamento", async () => {
    const pedido = pedidoFake({ asaasPaymentId: "pay_x" });
    const db = dbFalso({
      listarPedidosPendentes: vi.fn(async () => ({ data: [pedido], error: null })),
      listarPedidosParceladosComParcelaFaltando: vi.fn(async () => ({ data: [parcelado()], error: null })),
    });
    const asaas = asaasFalso({ buscarCobranca: vi.fn(async () => cobrancaFake({ status: "PENDING" })) });
    const resumo = await conciliarAsaas(deps({ db, asaas, limiteGets: 1 }));

    expect(asaas.listarCobrancasDoParcelamento).not.toHaveBeenCalled();
    expect(resumo.cortadoPeloTetoDeGets).toBe(true);
  });

  it("erro ao listar os pedidos parcelados vira falha e a rodada segue (poda e alarmes rodam)", async () => {
    const db = dbFalso({
      listarPedidosParceladosComParcelaFaltando: vi.fn(async () => ({ data: null, error: { code: "42501" } })),
    });
    const resumo = await conciliarAsaas(deps({ db }));

    expect(resumo.falhas).toBe(1);
    expect(db.podarEventos).toHaveBeenCalled();
  });

  it("consulta o banco só do ambiente da instalação e dos pedidos pagos nos últimos 400 dias", async () => {
    const db = dbComParcelados([]);
    const agora = new Date(Date.UTC(2026, 9, 7, 12));
    await conciliarAsaas(deps({ db, agora: () => agora }));

    const desde = new Date(agora.getTime() - 400 * 86_400_000).toISOString();
    expect(db.listarPedidosParceladosComParcelaFaltando).toHaveBeenCalledWith("sandbox", desde);
  });
});

describe("D-177: a listagem dos pedidos parcelados só devolve quem tem parcela sem linha em billing_payments", () => {
  function adminFalso(resultados: Record<string, unknown[]>) {
    const filtros: Record<string, Array<[string, ...unknown[]]>> = {};
    const admin = {
      from(tabela: string) {
        const lista: Array<[string, ...unknown[]]> = (filtros[tabela] = filtros[tabela] ?? []);
        const builder: Record<string, unknown> = {};
        for (const metodo of ["select", "eq", "gt", "gte", "not", "in", "order", "limit"]) {
          builder[metodo] = (...args: unknown[]) => {
            lista.push([metodo, ...args]);
            return builder;
          };
        }
        builder.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
          Promise.resolve({ data: resultados[tabela] ?? [], error: null }).then(resolve, reject);
        return builder;
      },
    };
    return { admin: admin as never, filtros };
  }

  const pedido = (id: string, parcelas: number) => ({
    id,
    organization_id: "org-1",
    ambiente: "sandbox",
    asaas_installment_id: `parcelamento-${id}-aaaa`,
    parcelas,
  });

  it("pedido com todas as parcelas registradas sai; o que falta fica com os ids já registrados", async () => {
    const { admin, filtros } = adminFalso({
      billing_orders: [pedido("completo", 2), pedido("faltando", 3)],
      billing_payments: [
        { order_id: "completo", asaas_payment_id: "pay_a" },
        { order_id: "completo", asaas_payment_id: "pay_b" },
        { order_id: "faltando", asaas_payment_id: "pay_c" },
        // pagamento manual (sem id do Asaas) não conta como parcela registrada
        { order_id: "faltando", asaas_payment_id: null },
      ],
    });
    const r = await criarDbConciliarAsaasSobre(admin).listarPedidosParceladosComParcelaFaltando("sandbox", "2025-09-02T00:00:00.000Z");

    expect(r.error).toBeNull();
    expect(r.data).toEqual([
      {
        id: "faltando",
        organizationId: "org-1",
        ambiente: "sandbox",
        asaasInstallmentId: "parcelamento-faltando-aaaa",
        parcelas: 3,
        parcelasRegistradas: ["pay_c"],
      },
    ]);
    expect(filtros.billing_orders).toContainEqual(["eq", "status", "pago"]);
    expect(filtros.billing_orders).toContainEqual(["gt", "parcelas", 1]);
    expect(filtros.billing_orders).toContainEqual(["eq", "ambiente", "sandbox"]);
    expect(filtros.billing_orders).toContainEqual(["gte", "pago_em", "2025-09-02T00:00:00.000Z"]);
    expect(filtros.billing_orders).toContainEqual(["order", "id"]);
    expect(filtros.billing_payments).toContainEqual(["in", "order_id", ["completo", "faltando"]]);
  });

  it("sem pedido parcelado pago, nem consulta billing_payments", async () => {
    const { admin, filtros } = adminFalso({ billing_orders: [] });
    const r = await criarDbConciliarAsaasSobre(admin).listarPedidosParceladosComParcelaFaltando("producao", "2025-09-02T00:00:00.000Z");

    expect(r.data).toEqual([]);
    expect(filtros.billing_payments).toBeUndefined();
  });
});
