/**
 * Fase F4, tarefa 8: `lib/billing/assinatura/estado-da-assinatura.ts`.
 * Dublê do cliente Supabase, sem banco de verdade, no estilo de
 * `tests/unit/planos-estado-do-bloqueio.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  dataPrevistaDaSuspensao,
  estadoDaAssinatura,
  organizacoesAtrasadasESuspensas,
  pagamentosDaAssinatura,
} from "@/lib/billing/assinatura/estado-da-assinatura";

const ORG = "22222222-2222-4222-8222-222222222222";
const USUARIO = "11111111-1111-4111-8111-111111111111";

function logFalso() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

// ───────────────────────────────────────────────────────────────────────
// dataPrevistaDaSuspensao (função pura)
// ───────────────────────────────────────────────────────────────────────

describe("dataPrevistaDaSuspensao", () => {
  it("status atrasada com período: fim do período + grace_days", () => {
    const r = dataPrevistaDaSuspensao("atrasada", "2026-09-10T00:00:00.000Z", 7);
    expect(r).toBe("2026-09-17T00:00:00.000Z");
  });

  it("status diferente de atrasada: null", () => {
    expect(dataPrevistaDaSuspensao("ativa", "2026-09-10T00:00:00.000Z", 7)).toBeNull();
    expect(dataPrevistaDaSuspensao("suspensa", "2026-09-10T00:00:00.000Z", 7)).toBeNull();
  });

  it("atrasada sem período gravado: null", () => {
    expect(dataPrevistaDaSuspensao("atrasada", null, 7)).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────
// estadoDaAssinatura
// ───────────────────────────────────────────────────────────────────────

interface OpcoesDoAdminDeEstado {
  settingsData?: { modo: string } | null;
  settingsErro?: string;
  contratoData?: unknown;
  contratoErro?: string;
  modoLeituraValendo?: boolean;
  modoLeituraErro?: string;
}

function adminParaEstado(opts: OpcoesDoAdminDeEstado) {
  const chamadas: string[] = [];

  function from(tabela: string) {
    return {
      select: () => ({
        eq: () => ({
          maybeSingle: async () => {
            chamadas.push(`from:${tabela}`);
            if (tabela === "billing_settings") {
              if (opts.settingsErro) return { data: null, error: { message: opts.settingsErro } };
              return { data: opts.settingsData ?? { modo: "avisar" }, error: null };
            }
            if (tabela === "billing_contracts") {
              if (opts.contratoErro) return { data: null, error: { message: opts.contratoErro } };
              return { data: opts.contratoData ?? null, error: null };
            }
            throw new Error(`from desconhecido no dublê: ${tabela}`);
          },
        }),
      }),
    };
  }

  async function rpc(nome: string) {
    chamadas.push(`rpc:${nome}`);
    if (nome === "fn_billing_modo_leitura") {
      if (opts.modoLeituraErro) return { data: null, error: { message: opts.modoLeituraErro } };
      return { data: opts.modoLeituraValendo ?? false, error: null };
    }
    throw new Error(`rpc desconhecida no dublê: ${nome}`);
  }

  const admin = { from, rpc } as unknown as SupabaseClient;
  return { admin, chamadas };
}

describe("estadoDaAssinatura", () => {
  it("modo avisar: modoLeituraValendo falso, e ZERO chamada à RPC do modo leitura", async () => {
    const { admin, chamadas } = adminParaEstado({
      settingsData: { modo: "avisar" },
      contratoData: {
        status: "ativa",
        cycle: "monthly",
        current_period_start: "2026-09-01T00:00:00.000Z",
        current_period_end: "2026-10-01T00:00:00.000Z",
        cancel_at_period_end: false,
        billing_plans: { grace_days: 7 },
      },
    });

    const r = await estadoDaAssinatura(admin, ORG);

    expect(r.leituraFalhou).toBe(false);
    expect(r.modoLeituraValendo).toBe(false);
    expect(r.contrato).toEqual({
      status: "ativa",
      cycle: "monthly",
      currentPeriodStart: "2026-09-01T00:00:00.000Z",
      currentPeriodEnd: "2026-10-01T00:00:00.000Z",
      cancelAtPeriodEnd: false,
      dataPrevistaDaSuspensao: null,
    });
    expect(chamadas.some((c) => c.startsWith("rpc:"))).toBe(false);
  });

  it("modo bloquear: chama fn_billing_modo_leitura e repassa o valor", async () => {
    const { admin, chamadas } = adminParaEstado({
      settingsData: { modo: "bloquear" },
      contratoData: {
        status: "suspensa",
        cycle: "monthly",
        current_period_start: "2026-08-01T00:00:00.000Z",
        current_period_end: "2026-09-01T00:00:00.000Z",
        cancel_at_period_end: false,
        billing_plans: { grace_days: 7 },
      },
      modoLeituraValendo: true,
    });

    const r = await estadoDaAssinatura(admin, ORG);

    expect(r.modoLeituraValendo).toBe(true);
    expect(r.contrato?.status).toBe("suspensa");
    expect(chamadas).toContain("rpc:fn_billing_modo_leitura");
  });

  it("atrasada, com grace_days do plano: dataPrevistaDaSuspensao calculada", async () => {
    const { admin } = adminParaEstado({
      settingsData: { modo: "avisar" },
      contratoData: {
        status: "atrasada",
        cycle: "monthly",
        current_period_start: "2026-08-01T00:00:00.000Z",
        current_period_end: "2026-09-10T00:00:00.000Z",
        cancel_at_period_end: true,
        billing_plans: { grace_days: 5 },
      },
    });

    const r = await estadoDaAssinatura(admin, ORG);

    expect(r.contrato?.dataPrevistaDaSuspensao).toBe("2026-09-15T00:00:00.000Z");
    expect(r.contrato?.cancelAtPeriodEnd).toBe(true);
  });

  it("sem contrato gravado: contrato null, sem leituraFalhou", async () => {
    const { admin } = adminParaEstado({ settingsData: { modo: "avisar" }, contratoData: null });
    const log = logFalso();

    const r = await estadoDaAssinatura(admin, ORG, log);

    expect(r).toEqual({ contrato: null, modoLeituraValendo: false, leituraFalhou: false });
    expect(log.error).not.toHaveBeenCalled();
  });

  it("falha ao ler billing_contracts: leituraFalhou, sem estado inventado", async () => {
    const { admin } = adminParaEstado({ settingsData: { modo: "avisar" }, contratoErro: "conexão caiu" });
    const log = logFalso();

    const r = await estadoDaAssinatura(admin, ORG, log);

    expect(r).toEqual({ contrato: null, modoLeituraValendo: false, leituraFalhou: true });
    expect(log.error).toHaveBeenCalledWith("alarme_planos_leitura", expect.objectContaining({ organization_id: ORG }));
  });

  it("falha ao ler billing_settings: leituraFalhou", async () => {
    const { admin } = adminParaEstado({ settingsErro: "conexão caiu", contratoData: null });

    const r = await estadoDaAssinatura(admin, ORG);

    expect(r.leituraFalhou).toBe(true);
    expect(r.contrato).toBeNull();
  });

  it("falha na RPC fn_billing_modo_leitura: leituraFalhou, sem inventar estado do bloqueio", async () => {
    const { admin } = adminParaEstado({
      settingsData: { modo: "bloquear" },
      contratoData: {
        status: "suspensa",
        cycle: "monthly",
        current_period_start: null,
        current_period_end: "2026-09-01T00:00:00.000Z",
        cancel_at_period_end: false,
        billing_plans: { grace_days: 7 },
      },
      modoLeituraErro: "conexão caiu",
    });

    const r = await estadoDaAssinatura(admin, ORG);

    expect(r.leituraFalhou).toBe(true);
    expect(r.modoLeituraValendo).toBe(false);
    expect(r.contrato).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────
// pagamentosDaAssinatura
// ───────────────────────────────────────────────────────────────────────

function adminParaPagamentos(opts: {
  pagamentosData?: unknown[];
  pagamentosErro?: string;
  getUserById?: (id: string) => Promise<{ data: { user: unknown } | null; error: unknown }>;
}) {
  function from(tabela: string) {
    if (tabela !== "billing_payments") throw new Error(`from desconhecido no dublê: ${tabela}`);
    return {
      select: () => ({
        eq: () => ({
          order: async () => {
            if (opts.pagamentosErro) return { data: null, error: { message: opts.pagamentosErro } };
            return { data: opts.pagamentosData ?? [], error: null };
          },
        }),
      }),
    };
  }

  const admin = {
    from,
    auth: {
      admin: {
        getUserById:
          opts.getUserById ??
          (async () => ({ data: { user: null } as { user: unknown } | null, error: null })),
      },
    },
  } as unknown as SupabaseClient;

  return { admin };
}

describe("pagamentosDaAssinatura", () => {
  it("lista pagamentos e estornos, com o autor resolvido pela Auth Admin API", async () => {
    const { admin } = adminParaPagamentos({
      pagamentosData: [
        {
          id: "p1",
          status: "RECEIVED_IN_CASH",
          gross_cents: 50000,
          paid_at: "2026-09-01T00:00:00.000Z",
          billing_period_start: "2026-09-01T00:00:00.000Z",
          billing_period_end: "2026-10-01T00:00:00.000Z",
          nota: "pago via pix",
          estorna_pagamento_id: null,
          criado_por: USUARIO,
          created_at: "2026-09-01T00:00:00.000Z",
        },
      ],
      getUserById: async (id) => ({
        data: { user: { id, email: "admin@hiperbold.com", user_metadata: { full_name: "Admin" } } },
        error: null,
      }),
    });

    const r = await pagamentosDaAssinatura(admin, ORG);

    expect(r.leituraFalhou).toBe(false);
    expect(r.pagamentos).toHaveLength(1);
    expect(r.pagamentos[0]).toMatchObject({
      id: "p1",
      status: "RECEIVED_IN_CASH",
      grossCents: 50000,
      nota: "pago via pix",
      autorNome: "Admin",
      autorEmail: "admin@hiperbold.com",
    });
  });

  it("falha em resolver UM autor não derruba a leitura", async () => {
    const { admin } = adminParaPagamentos({
      pagamentosData: [
        {
          id: "p1",
          status: "RECEIVED_IN_CASH",
          gross_cents: 50000,
          paid_at: "2026-09-01T00:00:00.000Z",
          billing_period_start: "2026-09-01T00:00:00.000Z",
          billing_period_end: "2026-10-01T00:00:00.000Z",
          nota: null,
          estorna_pagamento_id: null,
          criado_por: USUARIO,
          created_at: "2026-09-01T00:00:00.000Z",
        },
      ],
      getUserById: async () => {
        throw new Error("auth indisponível");
      },
    });
    const log = logFalso();

    const r = await pagamentosDaAssinatura(admin, ORG, log);

    expect(r.leituraFalhou).toBe(false);
    expect(r.pagamentos[0]?.autorNome).toBeNull();
    expect(log.warn).toHaveBeenCalled();
  });

  it("falha ao ler billing_payments: leituraFalhou, lista vazia", async () => {
    const { admin } = adminParaPagamentos({ pagamentosErro: "conexão caiu" });

    const r = await pagamentosDaAssinatura(admin, ORG);

    expect(r).toEqual({ pagamentos: [], leituraFalhou: true });
  });
});

// ───────────────────────────────────────────────────────────────────────
// organizacoesAtrasadasESuspensas
// ───────────────────────────────────────────────────────────────────────

function adminParaOrganizacoes(opts: { data?: unknown[]; erro?: string }) {
  function from(tabela: string) {
    if (tabela !== "billing_contracts") throw new Error(`from desconhecido no dublê: ${tabela}`);
    return {
      select: () => ({
        in: () => ({
          order: async () => {
            if (opts.erro) return { data: null, error: { message: opts.erro } };
            return { data: opts.data ?? [], error: null };
          },
        }),
      }),
    };
  }
  const admin = { from } as unknown as SupabaseClient;
  return { admin };
}

describe("organizacoesAtrasadasESuspensas", () => {
  it("lista atrasadas e suspensas com o nome e a data prevista da suspensão", async () => {
    const { admin } = adminParaOrganizacoes({
      data: [
        {
          organization_id: ORG,
          status: "atrasada",
          current_period_end: "2026-09-10T00:00:00.000Z",
          billing_plans: { grace_days: 7 },
          organizations: { display_name: "Clínica Exemplo" },
        },
        {
          organization_id: "33333333-3333-4333-8333-333333333333",
          status: "suspensa",
          current_period_end: "2026-08-01T00:00:00.000Z",
          billing_plans: { grace_days: 7 },
          organizations: { display_name: null },
        },
      ],
    });

    const r = await organizacoesAtrasadasESuspensas(admin);

    expect(r.leituraFalhou).toBe(false);
    expect(r.organizacoes).toEqual([
      {
        organizationId: ORG,
        nome: "Clínica Exemplo",
        status: "atrasada",
        currentPeriodEnd: "2026-09-10T00:00:00.000Z",
        dataPrevistaDaSuspensao: "2026-09-17T00:00:00.000Z",
      },
      {
        organizationId: "33333333-3333-4333-8333-333333333333",
        nome: "33333333-3333-4333-8333-333333333333",
        status: "suspensa",
        currentPeriodEnd: "2026-08-01T00:00:00.000Z",
        // suspensa: já aconteceu, não há mais "prevista".
        dataPrevistaDaSuspensao: null,
      },
    ]);
  });

  it("falha na leitura: leituraFalhou, lista vazia", async () => {
    const { admin } = adminParaOrganizacoes({ erro: "conexão caiu" });

    const r = await organizacoesAtrasadasESuspensas(admin);

    expect(r).toEqual({ organizacoes: [], leituraFalhou: true });
  });
});
