/**
 * M1 (auditoria do lote 16): os pontos que MATRICULAM ou ENFILEIRAM follow-up (relógio HTTP, cron
 * do follow-up, varredura de silêncio e os gatilhos de lead, caso, etapa e retorno) só conferiam
 * `contaEmModoLeitura`. Organização suspensa pelo admin da plataforma, com a cobrança em dia, seguia
 * ganhando matrícula e job. Aqui cada ponto é exercitado com uma organização `suspended` em modo
 * `avisar` (cobrança em dia): a matrícula e o job NÃO podem sair.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  runFollowupTick: vi.fn(),
  runSilenceSweep: vi.fn(async (_opts?: unknown) => ({ enrolled: 0, pointers_gated_out: 0, skipped_existing: 0 })),
  enviarTextoFixoPendente: vi.fn(async () => 0),
  drainEventLog: vi.fn(async () => ({ done: 0, failed: 0, dead: 0 })),
  runRoutingWorker: vi.fn(async () => ({})),
  recoverStuckMessages: vi.fn(async () => ({ failed: 0 })),
  gatilho: vi.fn(async (_deps: unknown, _row: unknown) => ({
    matched: false,
    enrolled: 0,
    pointers_armados: 0,
    skipped_existing: 0,
    pointers_barrados_pelo_gate: 0,
    modo_leitura: 0,
  })),
  admin: { current: null as unknown },
}));

vi.mock("@/lib/env", () => ({ env: { INTERNAL_SECRET: "dev-secret", INTERNAL_CRON_SECRET: "" } }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mocks.admin.current }));
vi.mock("@/app/api/v1/cron/recover-stuck-messages/route", () => ({
  recoverStuckMessages: mocks.recoverStuckMessages,
}));
vi.mock("@/lib/event-log/drain", () => ({ drainEventLog: mocks.drainEventLog }));
vi.mock("@/lib/event-log/register-handlers", () => ({ ensureHandlersRegistered: vi.fn() }));
vi.mock("@/lib/followup/agent-followup-gate", () => ({ createSupabaseFollowupGateDb: () => ({}) }));
vi.mock("@/lib/followup/aplicar-inbound", () => ({
  inboundEhDestaPergunta: () => false,
  avancarFollowupsAtivosDoContato: vi.fn(async () => undefined),
}));
vi.mock("@/lib/followup/engine", async (original) => {
  const real = await original<typeof import("@/lib/followup/engine")>();
  return { ...real, runFollowupTick: mocks.runFollowupTick };
});
vi.mock("@/lib/followup/enviar-texto-fixo", () => ({ enviarTextoFixoPendente: mocks.enviarTextoFixoPendente }));
vi.mock("@/lib/followup/silence-sweep", async (original) => {
  const real = await original<typeof import("@/lib/followup/silence-sweep")>();
  return { ...real, runSilenceSweep: mocks.runSilenceSweep };
});
vi.mock("@/lib/routing/worker", () => ({ runRoutingWorker: mocks.runRoutingWorker }));
vi.mock("@/lib/followup/atendimento", () => ({ encerrarRoteirosVencidos: vi.fn(async () => 0) }));
vi.mock("@/lib/followup/gatilho-lead", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  aplicaGatilhoDeLead: mocks.gatilho,
}));
vi.mock("@/lib/followup/gatilho-caso", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  aplicaGatilhoDeCaso: mocks.gatilho,
}));
vi.mock("@/lib/followup/gatilho-etapa", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  aplicaGatilhoDeEtapa: mocks.gatilho,
}));
vi.mock("@/lib/followup/gatilho-retorno", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  aplicaGatilhoDeRetorno: mocks.gatilho,
}));

import { limparCacheDoStatusDaOrganizacao } from "@/lib/billing/assinatura/status-da-organizacao";
import { followupGatilhoCasoHandler } from "@/lib/followup/gatilho-caso.handler";
import { followupGatilhoEtapaHandler } from "@/lib/followup/gatilho-etapa.handler";
import { followupGatilhoLeadHandler } from "@/lib/followup/gatilho-lead.handler";
import { followupGatilhoRetornoHandler } from "@/lib/followup/gatilho-retorno.handler";

const ORG = "33333333-3333-4333-8333-333333333333";
const JOB = {
  organization_id: ORG,
  contact_id: "contact-1",
  payload: { followup_enrollment_id: "44444444-4444-4444-8444-444444444444" },
} as never;

/** Organização `suspended`, cobrança em dia (`billing_settings.modo = 'avisar'`). */
function adminSuspenso(statusDaOrg = "suspended") {
  const insert = vi.fn(async () => ({ error: null }));
  const enrollmentUpdates: Array<Record<string, unknown>> = [];
  const admin = {
    from: (tabela: string) => {
      if (tabela === "organizations") {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { status: statusDaOrg }, error: null }) }) }) };
      }
      if (tabela === "billing_settings") {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { modo: "avisar" }, error: null }) }) }) };
      }
      if (tabela === "followup_enrollments") {
        return {
          select: () => ({ in: () => ({ order: () => ({ range: async () => ({ data: [], error: null }) }) }) }),
          update: (payload: Record<string, unknown>) => ({
            eq: () => ({
              eq: () => ({
                not: async () => {
                  enrollmentUpdates.push(payload);
                  return { error: null };
                },
              }),
            }),
          }),
        };
      }
      if (tabela === "job_queue") return { insert };
      throw new Error(`tabela não esperada no teste: ${tabela}`);
    },
    rpc: async (nome: string) => {
      throw new Error(`rpc não esperada (modo avisar não consulta a RPC): ${nome}`);
    },
  };
  return { admin, insert, enrollmentUpdates };
}

beforeEach(() => {
  vi.clearAllMocks();
  limparCacheDoStatusDaOrganizacao();
});

describe("relógio HTTP × organização suspensa com a cobrança em dia", () => {
  it("enfileirarFollowup: não grava job_queue e encerra o enrollment com organizacao_inativa", async () => {
    vi.resetModules();
    const { admin, insert, enrollmentUpdates } = adminSuspenso();
    vi.doMock("@/lib/supabase/admin", () => ({ createAdminClient: () => admin }));
    mocks.runFollowupTick.mockImplementation(async (deps: { enqueueJob: (job: unknown) => Promise<void> }) => {
      await deps.enqueueJob(JOB);
      return { claimed: 0, advanced: 0, scheduled: 0, failed: 0, dead: 0 };
    });

    const { executarTickDoRelogio } = await import("@/lib/relogio/executar");
    await executarTickDoRelogio();

    expect(insert).not.toHaveBeenCalled();
    expect(enrollmentUpdates[0]).toMatchObject({ status: "cancelled", cancel_reason: "organizacao_inativa" });
  });

  it("a varredura de silêncio do relógio recebe um portão que barra a organização suspensa", async () => {
    vi.resetModules();
    const { admin } = adminSuspenso();
    vi.doMock("@/lib/supabase/admin", () => ({ createAdminClient: () => admin }));
    mocks.runFollowupTick.mockResolvedValue({ claimed: 0, advanced: 0, scheduled: 0, failed: 0, dead: 0 });
    let portao: ((organizationId: string) => Promise<boolean>) | undefined;
    mocks.runSilenceSweep.mockImplementation(async (opts: unknown) => {
      portao = (opts as { contaEmModoLeitura?: (o: string) => Promise<boolean> }).contaEmModoLeitura;
      return { enrolled: 0, pointers_gated_out: 0, skipped_existing: 0 };
    });

    const { executarTickDoRelogio } = await import("@/lib/relogio/executar");
    await executarTickDoRelogio();

    expect(portao).toBeDefined();
    await expect(portao!(ORG)).resolves.toBe(true);
  });
});

describe("cron do follow-up × organização suspensa com a cobrança em dia", () => {
  function req(): NextRequest {
    return new NextRequest("http://localhost/api/v1/cron/followup-flow-worker", {
      headers: { authorization: "Bearer dev-secret" },
    });
  }

  it("enqueueJob do cron: não grava job_queue e encerra o enrollment com organizacao_inativa", async () => {
    vi.resetModules();
    const { admin, insert, enrollmentUpdates } = adminSuspenso();
    (admin as { rpc: unknown }).rpc = async (nome: string) => {
      if (nome === "fn_appointment_confirmation_sweep") return { data: 0, error: null };
      throw new Error(`rpc não esperada: ${nome}`);
    };
    vi.doMock("@/lib/supabase/admin", () => ({ createAdminClient: () => admin }));
    mocks.runFollowupTick.mockImplementation(async (deps: { enqueueJob: (job: unknown) => Promise<void> }) => {
      await deps.enqueueJob(JOB);
      return { claimed: 0, advanced: 0, scheduled: 0, failed: 0, dead: 0 };
    });

    const { POST } = await import("@/app/api/v1/cron/followup-flow-worker/route");
    const res = await POST(req());

    expect(res.status).toBe(200);
    expect(insert).not.toHaveBeenCalled();
    expect(enrollmentUpdates[0]).toMatchObject({ status: "cancelled", cancel_reason: "organizacao_inativa" });
  });

  it("a varredura de silêncio do cron recebe um portão que barra a organização suspensa", async () => {
    vi.resetModules();
    const { admin } = adminSuspenso();
    (admin as { rpc: unknown }).rpc = async () => ({ data: 0, error: null });
    vi.doMock("@/lib/supabase/admin", () => ({ createAdminClient: () => admin }));
    mocks.runFollowupTick.mockResolvedValue({ claimed: 0, advanced: 0, scheduled: 0, failed: 0, dead: 0 });
    let portao: ((organizationId: string) => Promise<boolean>) | undefined;
    mocks.runSilenceSweep.mockImplementation(async (opts: unknown) => {
      portao = (opts as { contaEmModoLeitura?: (o: string) => Promise<boolean> }).contaEmModoLeitura;
      return { enrolled: 0, pointers_gated_out: 0, skipped_existing: 0 };
    });

    const { POST } = await import("@/app/api/v1/cron/followup-flow-worker/route");
    await POST(req());

    expect(portao).toBeDefined();
    await expect(portao!(ORG)).resolves.toBe(true);
  });
});

describe("gatilhos de follow-up (event_log) × organização suspensa com a cobrança em dia", () => {
  const handlers = [
    ["lead", followupGatilhoLeadHandler],
    ["caso", followupGatilhoCasoHandler],
    ["etapa", followupGatilhoEtapaHandler],
    ["retorno", followupGatilhoRetornoHandler],
  ] as const;

  for (const [nome, handler] of handlers) {
    it(`gatilho de ${nome}: o portão injetado barra a organização suspensa e libera a ativa`, async () => {
      const suspensa = adminSuspenso("suspended");
      mocks.admin.current = suspensa.admin;
      let portao: ((organizationId: string) => Promise<boolean>) | undefined;
      mocks.gatilho.mockImplementationOnce(async (deps: unknown) => {
        portao = (deps as { contaEmModoLeitura?: (o: string) => Promise<boolean> }).contaEmModoLeitura;
        return { matched: false, enrolled: 0, pointers_armados: 0, skipped_existing: 0, pointers_barrados_pelo_gate: 0, modo_leitura: 0 };
      });
      await handler.handle({ id: "e1", organization_id: ORG, event_type: "x", payload: {} } as never);
      expect(portao, `gatilho de ${nome} sem o portão`).toBeDefined();
      await expect(portao!(ORG)).resolves.toBe(true);

      limparCacheDoStatusDaOrganizacao();
      const ativa = adminSuspenso("active");
      mocks.admin.current = ativa.admin;
      mocks.gatilho.mockImplementationOnce(async (deps: unknown) => {
        portao = (deps as { contaEmModoLeitura?: (o: string) => Promise<boolean> }).contaEmModoLeitura;
        return { matched: false, enrolled: 0, pointers_armados: 0, skipped_existing: 0, pointers_barrados_pelo_gate: 0, modo_leitura: 0 };
      });
      await handler.handle({ id: "e2", organization_id: ORG, event_type: "x", payload: {} } as never);
      await expect(portao!(ORG)).resolves.toBe(false);
    });
  }
});
