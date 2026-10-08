import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as ConferirReal from "@/lib/billing/assinatura/conferir-vencimentos";

import { clienteFalso, criarBancoFalso, type BancoFalso } from "./helpers/banco-de-emails-falso";

/**
 * A LIGAÇÃO dos avisos por e-mail com quem os dispara. Os gatilhos e a fila têm a suíte própria; aqui se prova
 * que cada ponto de partida os passa de verdade, com os gatilhos REAIS sobre um banco em memória (nada do
 * código de e-mail é dublê), e que o efeito chega à fila `billing_emails_enviados`:
 *
 *   - a rota `processar-eventos-asaas` passa `avisos` ao processador (pagamento aplicado enfileira COB-02/COB-03);
 *   - a rota `conferir-vencimentos` passa `aoSuspender` ao conferidor (a organização suspensa enfileira COB-06,
 *     a atrasada não);
 *   - as actions `compraDoPlano` (cliente) e `admin/cobrancaAsaas` (admin da plataforma) passam
 *     `avisoDeCancelamento` a `cancelarAssinaturaDoCliente` (o cancelamento enfileira COB-07).
 */

const SEGREDO = "segredo-da-ligacao";
const ORG = "0952f000-0000-4000-8000-00000000000a";
const FIM_DO_PERIODO = "2026-11-01T03:00:00+00:00";

const h = vi.hoisted(() => ({
  banco: null as unknown as BancoFalso,
  processar: vi.fn(),
  conferir: vi.fn(),
  estadoPorOrg: { valor: "suspensa" as string | null },
  cancelarDoCliente: vi.fn(),
}));

vi.mock("@/lib/env", () => ({
  env: { INTERNAL_CRON_SECRET: "segredo-da-ligacao", INTERNAL_SECRET: "" },
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    const base = clienteFalso(h.banco) as unknown as Record<string, unknown>;
    return {
      ...base,
      from: (tabela: string) =>
        tabela === "organizations"
          ? { select: () => ({ order: () => ({ range: async () => ({ data: [{ id: ORG }], error: null }) }) }) }
          : (base.from as (t: string) => unknown)(tabela),
      rpc: async (nome: string) =>
        nome === "fn_billing_conferir_vencimento" ? { data: h.estadoPorOrg.valor, error: null } : { data: null, error: null },
    };
  },
}));

// ─── processar-eventos-asaas: só a borda do Asaas e o processador são dublês; os avisos são os reais ───
vi.mock("@/lib/billing/asaas/config", () => ({
  configDoAsaas: () => ({
    habilitado: true,
    baseUrl: "https://api-sandbox.asaas.com/v3",
    apiKey: "$aact_hmlg_fake",
    webhookToken: "token-fake",
    webhookId: "",
    ambiente: "sandbox" as const,
  }),
}));
vi.mock("@/lib/billing/asaas/cliente", () => ({ criarClienteAsaas: () => ({ marcador: "asaas-falso" }) }));
vi.mock("@/lib/billing/asaas/processar-eventos", () => ({
  criarDbEventosAsaasSobre: () => ({ marcador: "db-falso" }),
  processarEventosAsaas: (...a: unknown[]) => h.processar(...a),
}));

// ─── a compra: o dublê é só o do Asaas/compra; o gatilho de cancelamento é o real ───
vi.mock("@/lib/billing/asaas/compra", () => ({
  cancelarAssinaturaDoCliente: (...a: unknown[]) => h.cancelarDoCliente(...a),
  iniciarCompra: vi.fn(),
}));
vi.mock("@/lib/billing/asaas/db-compra-supabase", () => ({ dbCompraSupabase: () => ({ marca: "db-falso" }) }));

vi.mock("@/lib/billing/assinatura/conferir-vencimentos", async (importar) => {
  const real = await importar<typeof ConferirReal>();
  return {
    ...real,
    conferirVencimentos: (...a: unknown[]) => {
      h.conferir(...a);
      return (real.conferirVencimentos as (...x: unknown[]) => unknown)(...a);
    },
  };
});

function mundo(): BancoFalso {
  return criarBancoFalso({
    tabelas: {
      billing_plans: [{ id: "plano-pro", code: "pro", name: "Pro", grace_days: 7 }],
      billing_contracts: [
        { id: "c-1", organization_id: ORG, plan_id: "plano-pro", status: "ativa", cycle: "monthly", current_period_end: FIM_DO_PERIODO },
      ],
      billing_orders: [
        { id: "ord-1", organization_id: ORG, tipo: "assinatura", plan_id: "plano-pro", ciclo: "monthly", metodo: "CREDIT_CARD", amount_cents: 34900, parcelas: 1, invoice_url: null },
      ],
      billing_payments: [
        { id: "bp-1", organization_id: ORG, order_id: "ord-1", contract_id: "c-1", asaas_payment_id: "pay_1", gross_cents: 34900, status: "CONFIRMED", paid_at: "2026-10-02T12:00:00+00:00", billing_period_start: "2026-10-02T03:00:00+00:00", billing_period_end: FIM_DO_PERIODO, estorna_pagamento_id: null },
      ],
    },
  });
}

const fila = () => h.banco.tabelas.billing_emails_enviados!;

beforeEach(() => {
  h.banco = mundo();
  h.processar.mockReset();
  h.conferir.mockReset();
  h.cancelarDoCliente.mockReset();
  h.estadoPorOrg.valor = "suspensa";
});

describe("rota processar-eventos-asaas -> processador -> fila", () => {
  it("passa `avisos` ao processador, e o aviso aplicado enfileira COB-02 e COB-03 de verdade", async () => {
    h.processar.mockResolvedValue({ habilitado: true, falhas: 0, cortadoPeloOrcamento: false });
    const { GET } = await import("@/app/api/v1/cron/processar-eventos-asaas/route");
    const res = await GET(
      new NextRequest("http://local/api/v1/cron/processar-eventos-asaas", { headers: { authorization: `Bearer ${SEGREDO}` } }),
    );
    expect(res.status).toBe(200);

    const deps = h.processar.mock.calls[0]![0] as {
      avisos?: { aoAplicar: (e: unknown) => Promise<void> };
    };
    expect(deps.avisos).toBeDefined();
    expect(typeof deps.avisos!.aoAplicar).toBe("function");

    await deps.avisos!.aoAplicar({
      eventType: "PAYMENT_CONFIRMED",
      resultado: "aplicado",
      organizationId: ORG,
      alarmes: [],
      idDoPagamento: "pay_1",
      cobranca: null,
    });
    expect(fila().map((l) => [l.email_id, l.chave, l.status])).toEqual([
      ["COB-02", "pedido:ord-1", "pendente"],
      ["COB-03", "pagamento:pay_1", "pendente"],
    ]);
  });
});

describe("rota conferir-vencimentos -> conferidor -> fila", () => {
  async function rodar() {
    const { GET } = await import("@/app/api/v1/cron/conferir-vencimentos/route");
    return GET(
      new NextRequest("http://local/api/v1/cron/conferir-vencimentos", { headers: { authorization: `Bearer ${SEGREDO}` } }),
    );
  }

  it("passa `aoSuspender` ao conferidor, e a organização que a RPC suspendeu enfileira COB-06", async () => {
    const res = await rodar();
    expect(res.status).toBe(200);
    const avisos = h.conferir.mock.calls[0]![1] as { aoSuspender?: unknown };
    expect(typeof avisos.aoSuspender).toBe("function");
    expect(fila().map((l) => [l.email_id, l.organization_id, l.chave])).toEqual([
      ["COB-06", ORG, `suspensao:c-1:${FIM_DO_PERIODO}`],
    ]);
  });

  it("organização que só ficou atrasada (ou sem mudança) não enfileira nada", async () => {
    for (const estado of ["atrasada", null]) {
      h.banco = mundo();
      h.estadoPorOrg.valor = estado;
      await rodar();
      expect(fila(), String(estado)).toEqual([]);
    }
  });
});

describe("as actions de cancelamento passam `avisoDeCancelamento`", () => {
  const USER = "11111111-1111-4111-8111-111111111111";

  function capturarDeps(): { avisoDeCancelamento?: (c: { organizationId: string; asaasSubscriptionId: string }) => Promise<void> } {
    return h.cancelarDoCliente.mock.calls[0]![0] as never;
  }

  it("compraDoPlano: cancelarAssinatura entrega o aviso real ao cancelamento, que enfileira COB-07", async () => {
    vi.doMock("next/headers", () => ({ headers: async () => new Map<string, string>([["x-request-id", "req"]]) }));
    vi.doMock("@/lib/impersonate/support", () => ({ supportWriteError: () => null }));
    vi.doMock("@/lib/auth/server", () => ({
      loadAuthUser: async () => ({ id: USER, is_platform_admin: false, support: null }),
      resolveActiveOrg: async () => ({ orgId: ORG, name: "Org", role: "admin" }),
      mfaEmDivida: async () => false,
    }));
    h.cancelarDoCliente.mockResolvedValue({ tipo: "ok", cancelAtPeriodEnd: true });
    vi.resetModules();
    const { cancelarAssinatura } = await import("@/app/actions/settings/compraDoPlano");
    await cancelarAssinatura();

    expect(h.cancelarDoCliente).toHaveBeenCalledTimes(1);
    const deps = capturarDeps();
    expect(typeof deps.avisoDeCancelamento).toBe("function");
    await deps.avisoDeCancelamento!({ organizationId: ORG, asaasSubscriptionId: "sub_1" });
    expect(fila().map((l) => [l.email_id, l.chave])).toEqual([["COB-07", `cancelamento:${ORG}:${FIM_DO_PERIODO}`]]);
  });

  it("admin/cobrancaAsaas: cancelarAssinaturaNoAsaas entrega o aviso real ao cancelamento, que enfileira COB-07", async () => {
    vi.doMock("next/headers", () => ({ headers: async () => new Map<string, string>([["x-request-id", "req"]]) }));
    vi.doMock("@/lib/auth/requirePlatformAdmin", () => ({
      requirePlatformAdmin: async () => ({ user: { id: USER }, platformAdmin: { scope: "full" } }),
    }));
    vi.doMock("@/lib/auth/server", () => ({ mfaEmDivida: async () => false }));
    vi.doMock("next/cache", () => ({ revalidatePath: vi.fn() }));
    h.cancelarDoCliente.mockResolvedValue({ tipo: "ok", cancelAtPeriodEnd: true });
    vi.resetModules();
    const { cancelarAssinaturaNoAsaas } = await import("@/app/actions/admin/cobrancaAsaas");
    await cancelarAssinaturaNoAsaas({ organizationId: ORG });

    expect(h.cancelarDoCliente).toHaveBeenCalledTimes(1);
    const deps = capturarDeps();
    expect(typeof deps.avisoDeCancelamento).toBe("function");
    await deps.avisoDeCancelamento!({ organizationId: ORG, asaasSubscriptionId: "sub_1" });
    expect(fila().map((l) => [l.email_id, l.chave])).toEqual([["COB-07", `cancelamento:${ORG}:${FIM_DO_PERIODO}`]]);
  });
});
