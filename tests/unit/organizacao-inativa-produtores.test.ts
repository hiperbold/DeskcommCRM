/**
 * D-091: os produtores automáticos (IA do motor e a legada, automação, follow-up e prospecção) não
 * rodam para organização com `organizations.status` diferente de `active`. A checagem mora na
 * leitura da organização que cada produtor JÁ fazia (nenhuma consulta a mais por mensagem), e o
 * modo `avisar` do plano segue sem consulta nenhuma (os testes de assinatura não mudam).
 *
 * O que se mede é COMPORTAMENTO: o que o produtor faz com o evento ou com o job de uma organização
 * suspensa, contra o produtor real com o banco dublado só na borda.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({ env: {} }));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { drainTick } from "@/lib/agent-engine/edge/crm/drain";
import { dispatchAgents } from "@/lib/ai/dispatcher";
import { limparCacheDoStatusDaOrganizacao, runAutomationForEvent } from "@/lib/automation/engine";
import { tickProspecting } from "@/lib/prospecting/worker";
import { createAdminClient } from "@/lib/supabase/admin";

const ORG = "11111111-1111-4111-8111-111111111111";
const EVENTO = "33333333-3333-4333-8333-333333333333";
const CONVERSA = "44444444-4444-4444-8444-444444444444";
const CONTATO = "77777777-7777-4777-8777-777777777777";
const CANAL = "55555555-5555-4555-8555-555555555555";
const MENSAGEM = "66666666-6666-4666-8666-666666666666";

const PAYLOAD = {
  conversation_id: CONVERSA,
  contact_id: CONTATO,
  channel_session_id: CANAL,
  inbound_message_id: MENSAGEM,
};

beforeEach(() => {
  vi.clearAllMocks();
  limparCacheDoStatusDaOrganizacao();
});

// ─── IA do motor: o dreno de eventos de despacho ───────────────────────────

function poolDoDreno(statusDaOrg: string) {
  const sqls: string[] = [];
  const pool = {
    query: vi.fn(async (sql: string) => {
      sqls.push(sql);
      if (sql.startsWith("update event_log e")) {
        return { rows: [{ id: EVENTO, organization_id: ORG, payload: PAYLOAD, attempts: 1, created_at: new Date().toISOString() }] };
      }
      if (sql.includes("from organizations")) return { rows: [{ mode: null, status: statusDaOrg }] };
      if (sql.includes("from conversations")) return { rows: [{ is_group: false }] };
      return { rows: [] };
    }),
  };
  return { pool, sqls };
}

const KNOBS = { batchSize: 10, intervalMs: 1, idleIntervalMs: 1, debounceMs: 0, reapTimeoutMs: 1000 };
const LOG = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

describe("IA do motor (dreno): organização suspensa", () => {
  it("consome o evento sem seguir para conversa, agente nem job, e sem consulta a mais", async () => {
    const { pool, sqls } = poolDoDreno("suspended");
    await drainTick(pool as never, KNOBS as never, LOG);

    expect(sqls.filter((s) => s.includes("from organizations"))).toHaveLength(1);
    expect(sqls.some((s) => s.includes("from conversations"))).toBe(false);
    expect(sqls.some((s) => s.includes("job_queue"))).toBe(false);
    expect(sqls.some((s) => s.startsWith("update event_log set status = 'done'"))).toBe(true);
  });

  it("organização arquivada também não gasta", async () => {
    const { pool, sqls } = poolDoDreno("archived");
    await drainTick(pool as never, KNOBS as never, LOG);
    expect(sqls.some((s) => s.includes("from conversations"))).toBe(false);
  });

  it("organização ativa segue o caminho de sempre (lê a conversa)", async () => {
    const { pool, sqls } = poolDoDreno("active");
    await drainTick(pool as never, KNOBS as never, LOG).catch(() => undefined);
    expect(sqls.some((s) => s.includes("from conversations"))).toBe(true);
  });
});

// ─── IA legada: o dispatcher ───────────────────────────────────────────────

function adminDoDispatcher(statusDaOrg: string, atualizacoes: Array<Record<string, unknown>>) {
  const from = (table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      select: () => chain,
      eq: () => chain,
      or: () => chain,
      in: () => chain,
      order: () => chain,
      update: (payload: Record<string, unknown>) => {
        if (table === "event_log") atualizacoes.push(payload);
        return chain;
      },
      limit: () =>
        Promise.resolve({
          data:
            table === "event_log"
              ? [{ id: EVENTO, organization_id: ORG, payload: { organization_id: ORG, ...PAYLOAD }, metadata: null, consumed_by: [], attempts: 0, next_attempt_at: null, status: "pending" }]
              : [],
          error: null,
        }),
      maybeSingle: () => Promise.resolve({ data: table === "event_log" ? { id: EVENTO } : null, error: null }),
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve({
          data: table === "organizations" ? [{ id: ORG, settings: {}, status: statusDaOrg }] : [],
          error: null,
        }).then(resolve),
    };
    return chain;
  };
  return { from };
}

describe("IA legada (dispatcher): organização suspensa", () => {
  it("consome o evento com o desfecho próprio e não processa", async () => {
    const atualizacoes: Array<Record<string, unknown>> = [];
    vi.mocked(createAdminClient).mockReturnValue(adminDoDispatcher("suspended", atualizacoes) as never);

    const resumo = await dispatchAgents({});

    expect(resumo.outcomes.skipped_org_inativa).toBe(1);
    expect(resumo.batch_size).toBe(0);
    expect(atualizacoes).toHaveLength(1);
    expect(atualizacoes[0]).toMatchObject({ status: "done" });
    expect((atualizacoes[0]!.metadata as Record<string, unknown>).outcome).toBe("skipped_org_inativa");
  });

  it("organização ativa não é barrada", async () => {
    const atualizacoes: Array<Record<string, unknown>> = [];
    vi.mocked(createAdminClient).mockReturnValue(adminDoDispatcher("active", atualizacoes) as never);
    const resumo = await dispatchAgents({});
    expect(resumo.outcomes.skipped_org_inativa).toBe(0);
    expect(resumo.batch_size).toBe(1);
  });
});

// ─── Automação ─────────────────────────────────────────────────────────────

function adminDaAutomacao(statusDaOrg: string | null) {
  const escritas: string[] = [];
  const regras = [{ id: "r1", name: "regra", conditions: [], actions: [] }];
  const from = (table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      select: () => chain,
      eq: () => chain,
      gte: () => chain,
      order: () => Promise.resolve({ data: table === "automation_rules" ? regras : [], error: null }),
      insert: () => {
        escritas.push(table);
        return chain;
      },
      maybeSingle: async () => ({ data: table === "organizations" && statusDaOrg ? { status: statusDaOrg } : null, error: null }),
    };
    return chain;
  };
  return { admin: { from, rpc: async () => ({ data: false, error: null }) }, escritas };
}

const EVENTO_DE_AUTOMACAO = {
  id: EVENTO,
  organization_id: ORG,
  event_type: "contact.created",
  entity_kind: "contact",
  entity_id: CONTATO,
  payload: {},
  metadata: {},
  created_at: new Date().toISOString(),
} as never;

describe("automação: organização suspensa", () => {
  it("consome o evento sem executar regra nem gravar execução", async () => {
    const { admin, escritas } = adminDaAutomacao("suspended");
    const r = await runAutomationForEvent(admin as never, EVENTO_DE_AUTOMACAO);
    expect(r).toMatchObject({ status: "ok", detail: "organizacao_inativa" });
    expect(escritas).toEqual([]);
  });

  it("organização ativa (ou sem conseguir ler o status) segue para a avaliação", async () => {
    for (const status of ["active", null]) {
      const { admin } = adminDaAutomacao(status);
      const r = await runAutomationForEvent(admin as never, EVENTO_DE_AUTOMACAO).catch(() => ({ detail: "seguiu" }));
      expect((r as { detail?: string }).detail).not.toBe("organizacao_inativa");
    }
  });
});

// ─── Prospecção ────────────────────────────────────────────────────────────

describe("prospecção: organização suspensa", () => {
  it("a lista de organizações do tick exclui as que não estão ativas, na mesma consulta", async () => {
    const consultas: string[] = [];
    const pool = {
      query: vi.fn(async (sql: string) => {
        consultas.push(sql);
        return { rows: [] };
      }),
    };
    await tickProspecting(pool as never, {} as never);

    expect(consultas).toHaveLength(1);
    expect(consultas[0]).toMatch(/from prospecting_campaigns where \(status='running' or search_status in \('starting','running'\)\)/);
    expect(consultas[0]).toMatch(/not exists \(select 1 from organizations o where o\.id=prospecting_campaigns\.organization_id and o\.status<>'active'\)/);
  });
});
