/**
 * `executarTickDoRelogio` × conta suspensa (modo leitura): achado 1 da
 * revisão F4 (lib/relogio/executar.ts:39 e :161). O relógio HTTP tem o
 * próprio `enqueueJob` (`enfileirarFollowup`, função PRIVADA do arquivo, só
 * alcançável por aqui) e o próprio fio até `runSilenceSweep`, com o mesmo
 * portão que o cron já tinha. Nenhum teste exercitava este arquivo até agora:
 * se alguém apagasse os dois `if`/callback, nada ficava vermelho. Correção
 * segunda rodada F4, item 4.
 *
 * `runFollowupTick` é dublado para, na prática, chamar `deps.enqueueJob`
 * direto (é exatamente `enfileirarFollowup`, a função real deste arquivo,
 * fechada sobre o `createAdminClient` mockado): prova o gate de :39 sem
 * reimplementar o motor de fila inteiro. `runSilenceSweep` é dublado para
 * CAPTURAR a opção `contaEmModoLeitura` recebida e invocá-la, provando :161
 * (o sweep recebe o mesmo portão, não um stub morto).
 */
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runFollowupTick: vi.fn(),
  runSilenceSweep: vi.fn(async (_opts?: { contaEmModoLeitura?: (organizationId: string) => Promise<boolean> }) => ({
    enrolled: 0,
    pointers_gated_out: 0,
    skipped_existing: 0,
  })),
  enviarTextoFixoPendente: vi.fn(async () => 0),
  drainEventLog: vi.fn(async () => ({ done: 0, failed: 0, dead: 0 })),
  runRoutingWorker: vi.fn(async () => ({})),
  recoverStuckMessages: vi.fn(async () => ({ failed: 0 })),
}));

vi.mock("@/app/api/v1/cron/recover-stuck-messages/route", () => ({
  recoverStuckMessages: mocks.recoverStuckMessages,
}));
vi.mock("@/lib/event-log/drain", () => ({ drainEventLog: mocks.drainEventLog }));
vi.mock("@/lib/event-log/register-handlers", () => ({ ensureHandlersRegistered: vi.fn() }));
vi.mock("@/lib/followup/agent-followup-gate", () => ({
  createSupabaseFollowupGateDb: () => ({}),
}));
vi.mock("@/lib/followup/aplicar-inbound", () => ({ inboundEhDestaPergunta: () => false }));
vi.mock("@/lib/followup/engine", async (original) => {
  const real = await original<typeof import("@/lib/followup/engine")>();
  return {
    ...real,
    runFollowupTick: mocks.runFollowupTick,
  };
});
vi.mock("@/lib/followup/enviar-texto-fixo", () => ({
  enviarTextoFixoPendente: mocks.enviarTextoFixoPendente,
}));
vi.mock("@/lib/followup/silence-sweep", async (original) => {
  const real = await original<typeof import("@/lib/followup/silence-sweep")>();
  return {
    ...real,
    runSilenceSweep: mocks.runSilenceSweep,
  };
});
vi.mock("@/lib/routing/worker", () => ({ runRoutingWorker: mocks.runRoutingWorker }));

function fakeAdmin(opts: { modo: string | null; modoLeitura: boolean }) {
  let chamadasRpc = 0;
  const admin = {
    from: (tabela: string) => {
      if (tabela === "billing_settings") {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { modo: opts.modo }, error: null }) }) }) };
      }
      if (tabela === "followup_enrollments") {
        // aplicarRespostasQueChegaram (lib/relogio/executar.ts): sem
        // enrollment nenhum esperando resposta, o passo fica vazio.
        return { select: () => ({ in: () => ({ order: () => ({ range: async () => ({ data: [], error: null }) }) }) }) };
      }
      if (tabela === "job_queue") {
        return { insert: async () => ({ error: null }) };
      }
      throw new Error(`tabela não esperada no teste: ${tabela}`);
    },
    rpc: async (nome: string) => {
      if (nome === "fn_billing_modo_leitura") {
        chamadasRpc += 1;
        return { data: opts.modoLeitura, error: null };
      }
      throw new Error(`rpc não esperada no teste: ${nome}`);
    },
  };
  return { admin, contarRpc: () => chamadasRpc };
}

const ORG_DO_JOB = "33333333-3333-4333-8333-333333333333";

const JOB = {
  organization_id: ORG_DO_JOB,
  contact_id: "contact-1",
  payload: { followup_enrollment_id: "44444444-4444-4444-8444-444444444444" },
} as never;

describe("executarTickDoRelogio × conta suspensa (modo leitura, correção segunda rodada F4, item 4)", () => {
  it(":39 enfileirarFollowup: organização em modo leitura NÃO grava job_queue, e encerra o enrollment (cancelled/assinatura_suspensa)", async () => {
    vi.resetModules();
    const insert = vi.fn(async () => ({ error: null }));
    const update = vi.fn(() => ({ eq: () => ({ eq: () => ({ not: async () => ({ error: null }) }) }) }));
    const admin = {
      from: (tabela: string) => {
        if (tabela === "billing_settings") return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { modo: "bloquear" }, error: null }) }) }) };
        if (tabela === "followup_enrollments") return { select: () => ({ in: () => ({ order: () => ({ range: async () => ({ data: [], error: null }) }) }) }), update };
        if (tabela === "job_queue") return { insert };
        throw new Error(`tabela não esperada: ${tabela}`);
      },
      rpc: async (nome: string) => {
        if (nome === "fn_billing_modo_leitura") return { data: true, error: null };
        throw new Error(`rpc não esperada: ${nome}`);
      },
    };
    vi.doMock("@/lib/supabase/admin", () => ({ createAdminClient: () => admin }));

    mocks.runFollowupTick.mockImplementation(async (deps: { enqueueJob: (job: unknown) => Promise<void> }) => {
      await deps.enqueueJob(JOB);
      return { claimed: 0, advanced: 0, scheduled: 0, failed: 0, dead: 0 };
    });

    const { executarTickDoRelogio } = await import("@/lib/relogio/executar");
    await executarTickDoRelogio();

    expect(insert).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "cancelled", cancel_reason: "assinatura_suspensa" }),
    );
  });

  it(":39 enfileirarFollowup: modo avisar, o job É gravado em job_queue normalmente", async () => {
    vi.resetModules();
    const insert = vi.fn(async () => ({ error: null }));
    const admin = {
      from: (tabela: string) => {
        if (tabela === "billing_settings") return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { modo: "avisar" }, error: null }) }) }) };
        if (tabela === "followup_enrollments") return { select: () => ({ in: () => ({ order: () => ({ range: async () => ({ data: [], error: null }) }) }) }) };
        if (tabela === "job_queue") return { insert };
        throw new Error(`tabela não esperada: ${tabela}`);
      },
      rpc: async () => {
        throw new Error("fn_billing_modo_leitura não deveria ser chamada no modo avisar");
      },
    };
    vi.doMock("@/lib/supabase/admin", () => ({ createAdminClient: () => admin }));

    mocks.runFollowupTick.mockImplementation(async (deps: { enqueueJob: (job: unknown) => Promise<void> }) => {
      await deps.enqueueJob(JOB);
      return { claimed: 0, advanced: 0, scheduled: 0, failed: 0, dead: 0 };
    });

    const { executarTickDoRelogio } = await import("@/lib/relogio/executar");
    await executarTickDoRelogio();

    expect(insert).toHaveBeenCalledTimes(1);
  });

  it(":161 o sweep recebe `contaEmModoLeitura` real (não um stub morto): a opção chamada com a organização certa devolve o veredito da RPC", async () => {
    vi.resetModules();
    const { admin, contarRpc } = fakeAdmin({ modo: "bloquear", modoLeitura: true });
    vi.doMock("@/lib/supabase/admin", () => ({ createAdminClient: () => admin }));

    mocks.runFollowupTick.mockResolvedValue({ claimed: 0, advanced: 0, scheduled: 0, failed: 0, dead: 0 });
    let opcaoRecebida = undefined as ((organizationId: string) => Promise<boolean>) | undefined;
    mocks.runSilenceSweep.mockImplementation(async (opts?: { contaEmModoLeitura?: (organizationId: string) => Promise<boolean> }) => {
      opcaoRecebida = opts?.contaEmModoLeitura;
      return { enrolled: 0, pointers_gated_out: 0, skipped_existing: 0 };
    });

    const { executarTickDoRelogio } = await import("@/lib/relogio/executar");
    await executarTickDoRelogio();

    expect(opcaoRecebida, "runSilenceSweep foi chamado sem a opção contaEmModoLeitura").toBeDefined();
    await expect(opcaoRecebida!(ORG_DO_JOB)).resolves.toBe(true);
    expect(contarRpc()).toBeGreaterThan(0);
  });
});
