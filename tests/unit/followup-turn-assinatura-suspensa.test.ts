/**
 * `createFollowupTurnHandler` × conta suspensa (modo leitura): o portão do
 * achado 2/3 da revisão F4 (comentário em
 * lib/agent-engine/agent/followup-turn.ts:294) tinha código, mas nenhuma prova
 * PRÓPRIA: `tests/unit/followup-enviar-texto-fixo-modo-leitura.test.ts` cobre o
 * mesmo achado só no caminho do texto fixo inline
 * (`lib/followup/enviar-texto-fixo.ts`), um consumidor DIFERENTE. Se alguém
 * apagasse o `if (await contaEmModoLeituraPeloPool(...))` deste handler, nada
 * ficava vermelho. Correção segunda rodada F4, item 4.
 *
 * Mesmo molde de dublê de pool de `tests/unit/followup-canal-arquivado.test.ts`
 * (mesmo handler, mesmo `runAgentTurn` dublado via `vi.mock` de
 * `inbound-turn`).
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

import type * as InboundTurnModule from "@/lib/agent-engine/agent/inbound-turn";
import type { JobRow } from "@/lib/agent-engine/queue/queue";

const runAgentTurn = vi.fn(async () => undefined);

// Só `runAgentTurn` é dublado: o resto do módulo (JobSettledError, ritualBlocks)
// continua real, mesmo padrão de followup-canal-arquivado.test.ts.
vi.mock("@/lib/agent-engine/agent/inbound-turn", async (original) => {
  const real = await original<typeof InboundTurnModule>();
  return { ...real, runAgentTurn };
});

const ORG = "org-1";
const LEAD = "lead-1";
const CONVERSA = "conversa-1";
const CANAL = "canal-1";
const ENROLLMENT = "11111111-1111-4111-8111-111111111111";

const boundary = {
  organization_id: ORG,
  contact_id: LEAD,
  conversation_id: CONVERSA,
  service_revision: 1,
  demanda_id: null,
  demanda_revision: null,
};

function job(payload: Record<string, unknown> = {}): JobRow {
  return {
    id: "job-1",
    organization_id: ORG,
    contact_id: LEAD,
    kind: "followup_turn",
    source_event_id: null,
    payload: { service_boundary: boundary, ...payload },
    status: "running",
    priority: 0,
    run_after: new Date(),
    attempts: 1,
    max_attempts: 3,
    last_error: null,
    locked_by: "w1",
    locked_at: new Date(),
    created_at: new Date(),
  } as JobRow;
}

interface PoolOpts {
  modo: string | null;
  modoLeitura?: boolean;
  /** `organizations.status` que a leitura da conversa traz (D-091). Ausente = como os dublês antigos. */
  orgStatus?: string;
}

/**
 * Dublê de `pg.Pool` que responde à ordem do gate
 * (`contaEmModoLeituraPeloPool`, lib/billing/assinatura/modo-leitura.ts):
 * primeiro `billing_settings.modo` (cacheado), só chama
 * `fn_billing_modo_leitura` quando o modo em cache já é 'bloquear'. Passado o
 * gate, cai no MESMO fallback de followup-canal-arquivado.test.ts (canal
 * ATIVO): boundary "open" para `requireCurrentServiceBoundary`, conversa
 * resolvida para o resto.
 */
function fakePool(opts: PoolOpts) {
  const consultas: string[] = [];
  const query = vi.fn(async (sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> => {
    consultas.push(sql);
    if (/select modo from public\.billing_settings/.test(sql)) {
      return { rows: [{ modo: opts.modo }] };
    }
    if (/fn_billing_modo_leitura/.test(sql)) {
      return { rows: [{ modo_leitura: opts.modoLeitura ?? false }] };
    }
    if (/update followup_enrollments/.test(sql)) {
      return { rows: [] };
    }
    if (sql.includes("d.fechada_em::text")) {
      return { rows: [{ ...boundary, status: "open", demanda_fechada_em: null }] };
    }
    return {
      rows: [{ id: CONVERSA, channel_session_id: CANAL, archived_at: null, ...(opts.orgStatus ? { org_status: opts.orgStatus } : {}) }],
    };
  });
  return { pool: { query } as never, query, consultas };
}

const ctx = { workerId: "w1" };
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

// Mesmo racional de followup-canal-arquivado.test.ts sobre importar FORA do
// `it()` (o transform do grafo inteiro do agent-engine, cronometrado como
// asserção, já reprovou por timeout uma vez).
let criarHandler: typeof import("@/lib/agent-engine/agent/followup-turn").createFollowupTurnHandler;

beforeAll(async () => {
  ({ createFollowupTurnHandler: criarHandler } = await import("@/lib/agent-engine/agent/followup-turn"));
}, 60_000);

function handler() {
  return criarHandler({ log } as never);
}

describe("followup_turn × conta suspensa (modo leitura, correção segunda rodada F4, item 4)", () => {
  it("conta suspensa, job DIRIGIDO POR FLUXO (com enrollment): nada é enviado, o enrollment vira cancelled/assinatura_suspensa", async () => {
    runAgentTurn.mockClear();
    const { pool, query } = fakePool({ modo: "bloquear", modoLeitura: true });
    const run = handler();

    await run(job({ followup_enrollment_id: ENROLLMENT }), pool, ctx);

    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(
      query.mock.calls.some(
        ([sql, params]) =>
          /update followup_enrollments/.test(sql as string) &&
          /status = 'cancelled', cancel_reason = 'assinatura_suspensa'/.test(sql as string) &&
          Array.isArray(params) &&
          params[0] === ORG &&
          params[1] === ENROLLMENT,
      ),
      "não encontrou o UPDATE que encerra o enrollment com organization_id/enrollment_id certos",
    ).toBe(true);
  });

  it("conta suspensa, job LEGADO (schedule_followup, sem enrollment): nada é enviado, e não tenta encerrar enrollment nenhum (não existe um para encerrar)", async () => {
    runAgentTurn.mockClear();
    const { pool, query } = fakePool({ modo: "bloquear", modoLeitura: true });
    const run = handler();

    await run(job(), pool, ctx);

    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql]) => /update followup_enrollments/.test(sql as string))).toBe(false);
  });

  it("modo avisar: o turno segue normal (runAgentTurn roda), fn_billing_modo_leitura NUNCA é chamada (zero custo a mais, decisão 8)", async () => {
    runAgentTurn.mockClear();
    const { pool, query } = fakePool({ modo: "avisar" });
    const run = handler();

    await run(job(), pool, ctx);

    expect(runAgentTurn).toHaveBeenCalledTimes(1);
    expect(query.mock.calls.some(([sql]) => /fn_billing_modo_leitura/.test(sql as string))).toBe(false);
  });
});

describe("followup_turn × organização suspensa ou arquivada (D-091)", () => {
  it.each(["suspended", "archived"])(
    "organização %s, mesmo no modo avisar: nada é enviado, o enrollment é encerrado (organizacao_inativa) e o RPC do modo leitura nunca é chamado",
    async (orgStatus) => {
      runAgentTurn.mockClear();
      const { pool, query } = fakePool({ modo: "avisar", orgStatus });
      const run = handler();

      await run(job({ followup_enrollment_id: ENROLLMENT }), pool, ctx);

      expect(runAgentTurn).not.toHaveBeenCalled();
      expect(
        query.mock.calls.some(
          ([sql, params]) =>
            /update followup_enrollments/.test(sql as string) &&
            /cancel_reason = 'organizacao_inativa'/.test(sql as string) &&
            Array.isArray(params) &&
            params[0] === ORG &&
            params[1] === ENROLLMENT,
        ),
      ).toBe(true);
      expect(query.mock.calls.some(([sql]) => /fn_billing_modo_leitura/.test(sql as string))).toBe(false);
    },
  );

  it("organização ativa: o turno segue normal", async () => {
    runAgentTurn.mockClear();
    const { pool } = fakePool({ modo: "avisar", orgStatus: "active" });
    await handler()(job(), pool, ctx);
    expect(runAgentTurn).toHaveBeenCalledTimes(1);
  });
});
