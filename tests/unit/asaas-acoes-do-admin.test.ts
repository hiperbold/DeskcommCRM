import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * AS CINCO ESCRITAS DO ADMIN DA PLATAFORMA SOBRE A COBRANÇA DO ASAAS (fase
 * F5, tarefa 17, `app/actions/admin/cobrancaAsaas.ts`), no molde de
 * `tests/unit/planos-assinatura-acoes-do-admin.test.ts` (fase F4, tarefa 5).
 *
 * RESTRIÇÃO ABSOLUTA: nenhuma chamada real ao Asaas. `criarClienteAsaas`,
 * `configDoAsaas`, `cancelarAssinaturaDoCliente` e `dbCompraSupabase` são
 * módulos inteiros trocados por dublês (`vi.mock`); um `fetch` espiado em
 * cada teste prova que nunca é chamado.
 */

const USUARIO = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";
const PEDIDO = "33333333-3333-4333-8333-333333333333";
const EVENTO = "44444444-4444-4444-8444-444444444444";

const h = vi.hoisted(() => ({
  guard: vi.fn(),
  rpc: vi.fn(),
  audit: vi.fn(),
  revalidatePath: vi.fn(),
  mfaEmDivida: vi.fn(),
  configDoAsaas: vi.fn(),
  cancelarAssinaturaDoCliente: vi.fn(),
  lerPedido: vi.fn(),
  removerAssinatura: vi.fn(),
  removerCobranca: vi.fn(),
  buscarAssinaturaPorReferencia: vi.fn(),
  buscarCobrancaPorReferencia: vi.fn(),
  criarClienteAsaas: vi.fn(),
}));

vi.mock("@/lib/auth/requirePlatformAdmin", () => ({ requirePlatformAdmin: h.guard }));
vi.mock("@/lib/auth/server", () => ({ mfaEmDivida: h.mfaEmDivida }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc: h.rpc }) }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/billing/asaas/config", () => ({ configDoAsaas: h.configDoAsaas }));
vi.mock("@/lib/billing/asaas/compra", () => ({ cancelarAssinaturaDoCliente: h.cancelarAssinaturaDoCliente }));
vi.mock("@/lib/billing/asaas/db-compra-supabase", () => ({ dbCompraSupabase: () => ({ lerPedido: h.lerPedido }) }));
vi.mock("@/lib/billing/asaas/cliente", () => ({ criarClienteAsaas: h.criarClienteAsaas }));

const ADMIN_FULL = { user: { id: USUARIO }, platformAdmin: { scope: "full" } };
const ADMIN_SUPORTE = { user: { id: USUARIO }, platformAdmin: { scope: "support_readonly" } };

const CONFIG_LIGADO = { habilitado: true, baseUrl: "https://api-sandbox.asaas.com/v3", apiKey: "x", webhookToken: "y", webhookId: "", ambiente: "sandbox" as const };
const CONFIG_DESLIGADO = { habilitado: false, baseUrl: "", apiKey: "", webhookToken: "", webhookId: "", ambiente: "sandbox" as const };

function pedidoFalso(overrides: Record<string, unknown> = {}) {
  return {
    id: PEDIDO,
    status: "criado",
    tipo: "assinatura",
    ambiente: "sandbox",
    metodo: "CREDIT_CARD",
    amountCents: 19900,
    externalReference: `HC:ord:${PEDIDO}`,
    asaasPaymentId: null,
    asaasSubscriptionId: null,
    invoiceUrl: null,
    ciclo: "monthly",
    planoNome: "Pro",
    pacoteNome: null,
    atualizadoEm: "2026-09-24T12:00:00Z",
    ...overrides,
  };
}

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  h.guard.mockResolvedValue(ADMIN_FULL);
  h.mfaEmDivida.mockResolvedValue(false);
  h.configDoAsaas.mockReturnValue(CONFIG_LIGADO);
  h.criarClienteAsaas.mockReturnValue({
    removerAssinatura: h.removerAssinatura,
    removerCobranca: h.removerCobranca,
    buscarAssinaturaPorReferencia: h.buscarAssinaturaPorReferencia,
    buscarCobrancaPorReferencia: h.buscarCobrancaPorReferencia,
  });
  h.buscarAssinaturaPorReferencia.mockResolvedValue(null);
  h.buscarCobrancaPorReferencia.mockResolvedValue(null);
  h.lerPedido.mockResolvedValue({ data: pedidoFalso(), error: null });
  fetchSpy = vi.spyOn(globalThis, "fetch");
});

afterEach(() => {
  // Nenhuma chamada real sai destas ações: criarClienteAsaas é sempre um
  // dublê, então um fetch de verdade só aconteceria se algum código deste
  // arquivo chamasse a rede por fora do cliente Asaas.
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
});

async function acoes() {
  return import("@/app/actions/admin/cobrancaAsaas");
}

describe("definirCompraPeloCliente", () => {
  beforeEach(() => {
    h.rpc.mockResolvedValue({
      data: { compra_pelo_cliente_anterior: false, compra_pelo_cliente_novo: true },
      error: null,
    });
  });

  it("escopo diferente de full é recusado e nenhuma RPC é chamada", async () => {
    h.guard.mockResolvedValueOnce(ADMIN_SUPORTE);
    const { definirCompraPeloCliente } = await acoes();

    const r = await definirCompraPeloCliente({ sim: true });

    expect(r.ok).toBe(false);
    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("com MFA em dívida, nenhuma RPC é chamada", async () => {
    h.mfaEmDivida.mockResolvedValueOnce(true);
    const { definirCompraPeloCliente } = await acoes();

    const r = await definirCompraPeloCliente({ sim: true });

    expect(r.ok).toBe(false);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("entrada fora do formato (sim não booleano) é recusada sem RPC", async () => {
    const { definirCompraPeloCliente } = await acoes();

    const r = await definirCompraPeloCliente({ sim: "sim" as unknown as boolean });

    expect(r.ok).toBe(false);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("billing_sim_obrigatorio (22023) devolve a frase certa", async () => {
    h.rpc.mockResolvedValueOnce({ data: null, error: { code: "22023", message: "billing_sim_obrigatorio" } });
    const { definirCompraPeloCliente } = await acoes();

    const r = await definirCompraPeloCliente({ sim: true });

    expect(r).toEqual({ ok: false, error: "Informe se liga ou desliga." });
  });

  it("🔒 erro qualquer do banco não aparece na resposta", async () => {
    const MENSAGEM_MARCADA = 'relation "segredo_interno" does not exist';
    h.rpc.mockResolvedValueOnce({ data: null, error: { code: "42P01", message: MENSAGEM_MARCADA } });
    const { definirCompraPeloCliente } = await acoes();

    const r = await definirCompraPeloCliente({ sim: true });

    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(MENSAGEM_MARCADA);
  });

  it("sucesso audita a mudança e revalida a tela de cobrança", async () => {
    const { definirCompraPeloCliente } = await acoes();

    const r = await definirCompraPeloCliente({ sim: true });

    expect(r.ok).toBe(true);
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "billing.asaas_self_service_toggled",
        resourceId: null,
        metadata: {
          recurso: "billing_settings",
          compra_pelo_cliente_anterior: false,
          compra_pelo_cliente_novo: true,
        },
      }),
    );
    expect(h.revalidatePath).toHaveBeenCalledWith("/admin/sistema/cobranca");
  });
});

describe("definirPlanoAVenda", () => {
  beforeEach(() => {
    h.rpc.mockResolvedValue({
      data: { plan_code: "pro", for_sale_anterior: false, for_sale_novo: true },
      error: null,
    });
  });

  it("escopo diferente de full é recusado e nenhuma RPC é chamada", async () => {
    h.guard.mockResolvedValueOnce(ADMIN_SUPORTE);
    const { definirPlanoAVenda } = await acoes();

    const r = await definirPlanoAVenda({ planCode: "pro", sim: true });

    expect(r.ok).toBe(false);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("código de plano fora do formato é recusado sem RPC", async () => {
    const { definirPlanoAVenda } = await acoes();

    const r = await definirPlanoAVenda({ planCode: "PLANO INVALIDO!!", sim: true });

    expect(r.ok).toBe(false);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("billing_preco_nao_definido (22023) devolve a frase certa", async () => {
    h.rpc.mockResolvedValueOnce({ data: null, error: { code: "22023", message: "billing_preco_nao_definido" } });
    const { definirPlanoAVenda } = await acoes();

    const r = await definirPlanoAVenda({ planCode: "pro", sim: true });

    expect(r).toEqual({
      ok: false,
      error: "O preço mensal deste plano ainda não foi definido. Defina o preço antes de pôr à venda.",
    });
  });

  it("plano_nao_encontrado_ou_inativo (P0002) devolve a frase certa", async () => {
    h.rpc.mockResolvedValueOnce({ data: null, error: { code: "P0002", message: "plano_nao_encontrado_ou_inativo" } });
    const { definirPlanoAVenda } = await acoes();

    const r = await definirPlanoAVenda({ planCode: "pro", sim: true });

    expect(r).toEqual({ ok: false, error: "Plano não encontrado ou inativo." });
  });

  it("sucesso audita o plano e o antes/depois", async () => {
    const { definirPlanoAVenda } = await acoes();

    const r = await definirPlanoAVenda({ planCode: "pro", sim: true });

    expect(r.ok).toBe(true);
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "billing.asaas_plan_for_sale_toggled",
        resourceId: null,
        metadata: { plan_code: "pro", for_sale_anterior: false, for_sale_novo: true },
      }),
    );
  });
});

describe("reprocessarEventoAsaas", () => {
  beforeEach(() => {
    h.rpc.mockResolvedValue({
      data: { evento_id: EVENTO, resultado_anterior: "erro", resultado_novo: "aguardando" },
      error: null,
    });
  });

  it("escopo diferente de full é recusado e nenhuma RPC é chamada", async () => {
    h.guard.mockResolvedValueOnce(ADMIN_SUPORTE);
    const { reprocessarEventoAsaas } = await acoes();

    const r = await reprocessarEventoAsaas({ eventoId: EVENTO });

    expect(r.ok).toBe(false);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("eventoId que não é uuid é recusado sem RPC", async () => {
    const { reprocessarEventoAsaas } = await acoes();

    const r = await reprocessarEventoAsaas({ eventoId: "não-é-um-uuid" });

    expect(r.ok).toBe(false);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("billing_evento_nao_esta_em_erro (22023) devolve a frase certa", async () => {
    h.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: "22023", message: "billing_evento_nao_esta_em_erro" },
    });
    const { reprocessarEventoAsaas } = await acoes();

    const r = await reprocessarEventoAsaas({ eventoId: EVENTO });

    expect(r).toEqual({ ok: false, error: "Este evento não está em erro; só eventos em erro podem ser reprocessados." });
  });

  it("billing_evento_nao_encontrado (P0002) devolve a frase certa", async () => {
    h.rpc.mockResolvedValueOnce({ data: null, error: { code: "P0002", message: "billing_evento_nao_encontrado" } });
    const { reprocessarEventoAsaas } = await acoes();

    const r = await reprocessarEventoAsaas({ eventoId: EVENTO });

    expect(r).toEqual({ ok: false, error: "Evento não encontrado." });
  });

  it("sucesso audita o evento SEM o payload", async () => {
    const { reprocessarEventoAsaas } = await acoes();

    const r = await reprocessarEventoAsaas({ eventoId: EVENTO });

    expect(r.ok).toBe(true);
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "billing.asaas_event_reprocessed",
        resourceId: EVENTO,
        metadata: { resultado_anterior: "erro", resultado_novo: "aguardando" },
      }),
    );
    const metadataEnviado = h.audit.mock.calls[0]![0].metadata;
    expect(Object.keys(metadataEnviado)).toEqual(["resultado_anterior", "resultado_novo"]);
  });
});

describe("cancelarPedidoAberto", () => {
  beforeEach(() => {
    h.rpc.mockResolvedValue({
      data: { pedido_id: PEDIDO, status_anterior: "criado", status_novo: "cancelado" },
      error: null,
    });
  });

  it("escopo diferente de full é recusado e nenhuma leitura/RPC acontece", async () => {
    h.guard.mockResolvedValueOnce(ADMIN_SUPORTE);
    const { cancelarPedidoAberto } = await acoes();

    const r = await cancelarPedidoAberto({ organizationId: ORG, pedidoId: PEDIDO, motivo: "teste" });

    expect(r.ok).toBe(false);
    expect(h.lerPedido).not.toHaveBeenCalled();
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("motivo vazio é recusado sem leitura nem RPC", async () => {
    const { cancelarPedidoAberto } = await acoes();

    const r = await cancelarPedidoAberto({ organizationId: ORG, pedidoId: PEDIDO, motivo: "" });

    expect(r.ok).toBe(false);
    expect(h.lerPedido).not.toHaveBeenCalled();
  });

  it("pedido não encontrado devolve a frase certa", async () => {
    h.lerPedido.mockResolvedValueOnce({ data: null, error: null });
    const { cancelarPedidoAberto } = await acoes();

    const r = await cancelarPedidoAberto({ organizationId: ORG, pedidoId: PEDIDO, motivo: "teste" });

    expect(r).toEqual({ ok: false, error: "Pedido não encontrado." });
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("pedido já pago é recusado sem chamar o Asaas nem a RPC de marcar", async () => {
    h.lerPedido.mockResolvedValueOnce({ data: pedidoFalso({ status: "pago" }), error: null });
    const { cancelarPedidoAberto } = await acoes();

    const r = await cancelarPedidoAberto({ organizationId: ORG, pedidoId: PEDIDO, motivo: "teste" });

    expect(r).toEqual({ ok: false, error: "Este pedido já foi pago." });
    expect(h.criarClienteAsaas).not.toHaveBeenCalled();
    expect(h.buscarAssinaturaPorReferencia).not.toHaveBeenCalled();
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("pedido estornado é recusado sem chamar o Asaas nem a RPC de marcar", async () => {
    h.lerPedido.mockResolvedValueOnce({ data: pedidoFalso({ status: "estornado" }), error: null });
    const { cancelarPedidoAberto } = await acoes();

    const r = await cancelarPedidoAberto({ organizationId: ORG, pedidoId: PEDIDO, motivo: "teste" });

    expect(r).toEqual({ ok: false, error: "Este pedido já foi estornado." });
    expect(h.criarClienteAsaas).not.toHaveBeenCalled();
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("pedido que já falhou é recusado sem chamar o Asaas nem a RPC de marcar", async () => {
    h.lerPedido.mockResolvedValueOnce({ data: pedidoFalso({ status: "falhou" }), error: null });
    const { cancelarPedidoAberto } = await acoes();

    const r = await cancelarPedidoAberto({ organizationId: ORG, pedidoId: PEDIDO, motivo: "teste" });

    expect(r).toEqual({ ok: false, error: "Este pedido já falhou. Não há nada para cancelar." });
    expect(h.criarClienteAsaas).not.toHaveBeenCalled();
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("sem assinatura nem cobrança encontradas por referência: cancela mesmo assim, depois de buscar as duas", async () => {
    const { cancelarPedidoAberto } = await acoes();

    const r = await cancelarPedidoAberto({ organizationId: ORG, pedidoId: PEDIDO, motivo: "pedido abandonado" });

    expect(r.ok).toBe(true);
    expect(h.criarClienteAsaas).toHaveBeenCalled();
    expect(h.buscarAssinaturaPorReferencia).toHaveBeenCalledWith(`HC:ord:${PEDIDO}`);
    expect(h.buscarCobrancaPorReferencia).toHaveBeenCalledWith(`HC:ord:${PEDIDO}`);
    expect(h.removerAssinatura).not.toHaveBeenCalled();
    expect(h.removerCobranca).not.toHaveBeenCalled();
    expect(h.rpc).toHaveBeenCalledWith(
      "fn_billing_pedido_marcar",
      expect.objectContaining({ p_org: ORG, p_pedido: PEDIDO, p_status: "cancelado", p_motivo: "pedido abandonado" }),
    );
  });

  it("assinatura achada por referência no Asaas: remove ANTES de marcar cancelado", async () => {
    h.buscarAssinaturaPorReferencia.mockResolvedValueOnce({ id: "sub_123" });
    const ordem: string[] = [];
    h.removerAssinatura.mockImplementationOnce(async () => {
      ordem.push("remover_assinatura");
    });
    h.rpc.mockImplementationOnce(async () => {
      ordem.push("marcar_cancelado");
      return { data: { pedido_id: PEDIDO, status_anterior: "aguardando_pagamento", status_novo: "cancelado" }, error: null };
    });
    const { cancelarPedidoAberto } = await acoes();

    const r = await cancelarPedidoAberto({ organizationId: ORG, pedidoId: PEDIDO, motivo: "duplicado" });

    expect(r.ok).toBe(true);
    expect(h.removerAssinatura).toHaveBeenCalledWith("sub_123");
    expect(h.removerCobranca).not.toHaveBeenCalled();
    expect(ordem).toEqual(["remover_assinatura", "marcar_cancelado"]);
  });

  it("cobrança avulsa achada por referência no Asaas (sem assinatura): remove antes de marcar", async () => {
    h.buscarCobrancaPorReferencia.mockResolvedValueOnce({ id: "pay_123" });
    const { cancelarPedidoAberto } = await acoes();

    const r = await cancelarPedidoAberto({ organizationId: ORG, pedidoId: PEDIDO, motivo: "duplicado" });

    expect(r.ok).toBe(true);
    expect(h.removerCobranca).toHaveBeenCalledWith("pay_123");
  });

  it("busca por externalReference falhando recusa o cancelamento sem marcar nada", async () => {
    h.buscarAssinaturaPorReferencia.mockRejectedValueOnce(new Error("timeout"));
    const { cancelarPedidoAberto } = await acoes();

    const r = await cancelarPedidoAberto({ organizationId: ORG, pedidoId: PEDIDO, motivo: "duplicado" });

    expect(r.ok).toBe(false);
    expect(h.removerAssinatura).not.toHaveBeenCalled();
    expect(h.removerCobranca).not.toHaveBeenCalled();
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("remoção no Asaas falhando NUNCA marca o pedido como cancelado", async () => {
    h.buscarAssinaturaPorReferencia.mockResolvedValueOnce({ id: "sub_123" });
    h.removerAssinatura.mockRejectedValueOnce(new Error("timeout"));
    const { cancelarPedidoAberto } = await acoes();

    const r = await cancelarPedidoAberto({ organizationId: ORG, pedidoId: PEDIDO, motivo: "duplicado" });

    expect(r.ok).toBe(false);
    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("ASAAS_ENABLED desligado com assinatura pendente de remover: recusa sem tentar remover nem marcar", async () => {
    h.configDoAsaas.mockReturnValueOnce(CONFIG_DESLIGADO);
    const { cancelarPedidoAberto } = await acoes();

    const r = await cancelarPedidoAberto({ organizationId: ORG, pedidoId: PEDIDO, motivo: "duplicado" });

    expect(r.ok).toBe(false);
    expect(h.criarClienteAsaas).not.toHaveBeenCalled();
    expect(h.buscarAssinaturaPorReferencia).not.toHaveBeenCalled();
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("pedido processando há menos de 15 minutos é recusado com frase fixa, sem buscar nem marcar", async () => {
    h.lerPedido.mockResolvedValueOnce({
      data: pedidoFalso({ status: "processando", atualizadoEm: new Date(Date.now() - 5 * 60 * 1000).toISOString() }),
      error: null,
    });
    const { cancelarPedidoAberto } = await acoes();

    const r = await cancelarPedidoAberto({ organizationId: ORG, pedidoId: PEDIDO, motivo: "teste" });

    expect(r).toEqual({ ok: false, error: "O pedido está sendo processado agora. Tente cancelar em alguns minutos." });
    expect(h.criarClienteAsaas).not.toHaveBeenCalled();
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("pedido processando há mais de 15 minutos segue o fluxo normal de cancelamento", async () => {
    h.lerPedido.mockResolvedValueOnce({
      data: pedidoFalso({ status: "processando", atualizadoEm: new Date(Date.now() - 20 * 60 * 1000).toISOString() }),
      error: null,
    });
    const { cancelarPedidoAberto } = await acoes();

    const r = await cancelarPedidoAberto({ organizationId: ORG, pedidoId: PEDIDO, motivo: "teste" });

    expect(r.ok).toBe(true);
    expect(h.criarClienteAsaas).toHaveBeenCalled();
  });

  it("ambiente configurado diferente do ambiente do pedido é recusado sem buscar no Asaas", async () => {
    h.lerPedido.mockResolvedValueOnce({ data: pedidoFalso({ ambiente: "producao" }), error: null });
    const { cancelarPedidoAberto } = await acoes();

    const r = await cancelarPedidoAberto({ organizationId: ORG, pedidoId: PEDIDO, motivo: "teste" });

    expect(r).toEqual({
      ok: false,
      error: "O ambiente do Asaas configurado agora é diferente do ambiente deste pedido. Ajuste a configuração antes de cancelar.",
    });
    expect(h.criarClienteAsaas).not.toHaveBeenCalled();
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("sucesso audita se havia cobrança/assinatura no Asaas, SEM CPF/CNPJ nem valor", async () => {
    h.buscarAssinaturaPorReferencia.mockResolvedValueOnce({ id: "sub_123" });
    const { cancelarPedidoAberto } = await acoes();

    await cancelarPedidoAberto({ organizationId: ORG, pedidoId: PEDIDO, motivo: "duplicado" });

    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "billing.asaas_order_canceled",
        organizationId: ORG,
        resourceId: PEDIDO,
        metadata: {
          motivo: "duplicado",
          tinha_cobranca_ou_assinatura_no_asaas: true,
          status_anterior: "criado",
          status_novo: "cancelado",
        },
      }),
    );
    const metadataEnviado = JSON.stringify(h.audit.mock.calls[0]![0].metadata);
    expect(metadataEnviado).not.toContain("amountCents");
    expect(metadataEnviado).not.toContain("19900");
  });
});

describe("cancelarAssinaturaNoAsaas", () => {
  beforeEach(() => {
    h.cancelarAssinaturaDoCliente.mockResolvedValue({ tipo: "ok", cancelAtPeriodEnd: true });
  });

  it("escopo diferente de full é recusado e nunca chama cancelarAssinaturaDoCliente", async () => {
    h.guard.mockResolvedValueOnce(ADMIN_SUPORTE);
    const { cancelarAssinaturaNoAsaas } = await acoes();

    const r = await cancelarAssinaturaNoAsaas({ organizationId: ORG });

    expect(r.ok).toBe(false);
    expect(h.cancelarAssinaturaDoCliente).not.toHaveBeenCalled();
  });

  it("com MFA em dívida, nunca chama cancelarAssinaturaDoCliente", async () => {
    h.mfaEmDivida.mockResolvedValueOnce(true);
    const { cancelarAssinaturaNoAsaas } = await acoes();

    const r = await cancelarAssinaturaNoAsaas({ organizationId: ORG });

    expect(r.ok).toBe(false);
    expect(h.cancelarAssinaturaDoCliente).not.toHaveBeenCalled();
  });

  it("organizationId que não é uuid é recusado sem chamar o serviço de compra", async () => {
    const { cancelarAssinaturaNoAsaas } = await acoes();

    const r = await cancelarAssinaturaNoAsaas({ organizationId: "não-é-um-uuid" });

    expect(r.ok).toBe(false);
    expect(h.cancelarAssinaturaDoCliente).not.toHaveBeenCalled();
  });

  it("ASAAS_ENABLED desligado recusa sem chamar o serviço de compra", async () => {
    h.configDoAsaas.mockReturnValueOnce(CONFIG_DESLIGADO);
    const { cancelarAssinaturaNoAsaas } = await acoes();

    const r = await cancelarAssinaturaNoAsaas({ organizationId: ORG });

    expect(r).toEqual({ ok: false, error: "O Asaas está desligado nesta instalação; não é possível cancelar a assinatura por aqui." });
    expect(h.cancelarAssinaturaDoCliente).not.toHaveBeenCalled();
  });

  it("repassa a frase fixa de erro de cancelarAssinaturaDoCliente sem alterar", async () => {
    h.cancelarAssinaturaDoCliente.mockResolvedValueOnce({ tipo: "erro", mensagem: "Esta organização não tem uma assinatura Asaas ativa para cancelar." });
    const { cancelarAssinaturaNoAsaas } = await acoes();

    const r = await cancelarAssinaturaNoAsaas({ organizationId: ORG });

    expect(r).toEqual({ ok: false, error: "Esta organização não tem uma assinatura Asaas ativa para cancelar." });
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("sucesso chama cancelarAssinaturaDoCliente com o ADMIN como ator, audita e revalida as duas telas", async () => {
    const { cancelarAssinaturaNoAsaas } = await acoes();

    const r = await cancelarAssinaturaNoAsaas({ organizationId: ORG });

    expect(r).toEqual({ ok: true, dados: { cancelAtPeriodEnd: true } });
    expect(h.cancelarAssinaturaDoCliente).toHaveBeenCalledWith(expect.any(Object), ORG, USUARIO);
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "billing.asaas_subscription_canceled",
        organizationId: ORG,
        metadata: { cancel_at_period_end: true },
      }),
    );
    expect(h.revalidatePath).toHaveBeenCalledWith(`/admin/tenants/${ORG}/plano`);
    expect(h.revalidatePath).toHaveBeenCalledWith("/admin/sistema/cobranca");
  });
});
