/**
 * M2 (auditoria do lote 16): o dreno só barrava evento NOVO. Job que já estava na fila
 * (`inbound_turn`, `case_reply_turn`, `operator_turn`, `followup_turn`) rodava depois da suspensão e
 * gastava a chave da Hiperbold. O ponto único é o seam de chamada de modelo (`runModelCall`): a
 * leitura da organização que ele já faz para a config LLM passa a trazer o `status`, e organização
 * que não está `active` recusa a chamada ANTES de sair byte para o provedor.
 *
 * `approved_reply` e `transactional_delivery` não chamam modelo (enviam texto já decidido), então
 * têm o próprio portão no handler, na leitura que já faziam.
 */
import { describe, expect, it, vi } from "vitest";

import {
  LlmBudgetExceededError,
  LlmOrganizacaoInativaError,
  runModelCall,
} from "@/lib/agent-engine/edge/llm/run-model-call";
import { createApprovedReplyHandler } from "@/lib/agent-engine/agent/approved-reply";
import { createMeetDeliveryHandler } from "@/lib/agent-engine/agent/meet-delivery";

const ORG = "55555555-5555-4555-8555-555555555555";
const SENTINELA = new Error("o provedor foi alcançado");

// ─── runModelCall ──────────────────────────────────────────────────────────

function poolDoSeam(statusDaOrg: string | undefined, opts: { schemaAtrasado?: boolean } = {}) {
  const sqls: string[] = [];
  const llmCalls: unknown[][] = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    sqls.push(sql);
    if (sql.includes("left join ai_budgets")) {
      if (opts.schemaAtrasado) throw new Error("coluna não existe");
      return {
        rows: [
          {
            llm: { provider: "anthropic", default_model: "claude-padrao", params: {}, enabled_models: [] },
            teto: 1000,
            modo: "off",
            efetivo_em: null,
            limiar_pct: 80,
            ...(statusDaOrg === undefined ? {} : { org_status: statusDaOrg }),
          },
        ],
      };
    }
    if (sql.includes("settings->'llm'")) {
      return {
        rows: [
          {
            llm: { provider: "anthropic", default_model: "claude-padrao" },
            ...(statusDaOrg === undefined ? {} : { org_status: statusDaOrg }),
          },
        ],
      };
    }
    if (sql.includes("ai_purpose_bindings")) return { rows: [] };
    if (sql.includes("ai_provider_credentials")) return { rows: [] };
    if (sql.includes("billing_settings")) return { rows: [{ modo: "avisar" }] };
    if (sql.includes("insert into llm_calls")) {
      llmCalls.push(params);
      return { rows: [{ id: "call-1" }] };
    }
    return { rows: [] };
  });
  return { pool: { query } as never, sqls, llmCalls };
}

function registryQueRegistra() {
  const invocacoes: string[] = [];
  const fabrica = (_chave: string, modelo: string) => {
    invocacoes.push(modelo);
    return {
      specificationVersion: "v3",
      provider: "anthropic",
      modelId: modelo,
      doGenerate: async () => {
        throw SENTINELA;
      },
    } as never;
  };
  return { invocacoes, registry: { anthropic: fabrica, openai: fabrica, google: fabrica, openrouter: fabrica } };
}

async function chamar(statusDaOrg: string | undefined, opts: { schemaAtrasado?: boolean; purpose?: string } = {}) {
  const p = poolDoSeam(statusDaOrg, opts);
  const r = registryQueRegistra();
  const avisos: string[] = [];
  let lancou: unknown = null;
  try {
    await runModelCall(
      p.pool,
      { anthropicApiKey: "sk-ant-x", cacheTtl: "1h" },
      { tenantId: ORG, messages: [{ role: "user", content: "oi" }], ...(opts.purpose ? { purpose: opts.purpose } : {}) } as never,
      { registry: r.registry as never, log: { info: vi.fn(), warn: (m: string) => void avisos.push(m), error: vi.fn() } as never },
    );
  } catch (err) {
    lancou = err;
  }
  return { ...p, ...r, avisos, lancou };
}

describe("runModelCall × organização suspensa (job já na fila)", () => {
  it("organização suspensa: recusa antes do provedor, com erro terminal e sem gravar chamada", async () => {
    const r = await chamar("suspended");
    expect(r.lancou).toBeInstanceOf(LlmOrganizacaoInativaError);
    expect((r.lancou as LlmOrganizacaoInativaError).terminal).toBe(true);
    expect(r.invocacoes).toEqual([]);
    expect(r.llmCalls).toEqual([]);
    expect(r.avisos.join(" ")).toMatch(/organiza/i);
  });

  it("organização arquivada também recusa, qualquer que seja o propósito (inclusive os isentos de orçamento)", async () => {
    for (const purpose of ["agent_turn", "jailbreak_classifier", "stage_classifier"]) {
      const r = await chamar("archived", { purpose });
      expect(r.lancou, purpose).toBeInstanceOf(LlmOrganizacaoInativaError);
      expect(r.invocacoes, purpose).toEqual([]);
    }
  });

  it("o erro NÃO é um veto de orçamento: a escolta de handoff não manda aviso ao lead de uma conta suspensa", () => {
    expect(new LlmOrganizacaoInativaError("suspended")).not.toBeInstanceOf(LlmBudgetExceededError);
  });

  it("schema atrasado (leitura legada da config) também traz o status e recusa", async () => {
    const r = await chamar("suspended", { schemaAtrasado: true });
    expect(r.lancou).toBeInstanceOf(LlmOrganizacaoInativaError);
    expect(r.invocacoes).toEqual([]);
  });

  it("controle positivo: organização ativa chega ao provedor", async () => {
    const r = await chamar("active");
    expect(r.lancou).not.toBeInstanceOf(LlmOrganizacaoInativaError);
    expect(r.invocacoes.length).toBeGreaterThan(0);
  });

  it("a leitura do status vem da MESMA consulta da config (nenhuma consulta a mais)", async () => {
    const r = await chamar("active");
    const consultasAOrganizations = r.sqls.filter((s) => /from organizations/.test(s));
    expect(consultasAOrganizations).toHaveLength(1);
    expect(consultasAOrganizations[0]).toMatch(/o\.status/);
  });
});

// ─── approved_reply ────────────────────────────────────────────────────────

const JOB_ID = "77777777-7777-4777-8777-777777777777";
const CLAIM = { worker_id: "w1", acquired_at: "2026-10-06T10:00:00.000Z" };

vi.mock("@/lib/agent-engine/queue/claim", () => ({
  claimOfJob: () => ({ worker_id: "w1", acquired_at: "2026-10-06T10:00:00.000Z" }),
}));
vi.mock("@/lib/atendimento/fronteira-server", () => ({
  withServiceJob: async (_pool: unknown, _job: unknown, fn: () => Promise<unknown>) => fn(),
  guardServiceTools: (t: unknown) => t,
}));
vi.mock("@/lib/ai/replies/delivery", () => ({
  assertApprovedReplyReceiptPg: vi.fn(async () => undefined),
  assertApprovedReplyPg: vi.fn(async () => ({
    channel_session_id: "canal-1",
    agent_id: "agente-1",
    body: "Resposta aprovada",
    conversation_id: "conv-1",
  })),
}));
vi.mock("@/lib/agenda/meet-delivery", () => ({
  assertMeetingDeliveryReceiptPg: vi.fn(async () => undefined),
  assertMeetingDeliveryPg: vi.fn(async () => undefined),
  MeetingDeliveryBlockedError: class extends Error {},
}));
vi.mock("@/lib/agent-engine/edge/crm/send-ledger", () => ({
  reconcileAcceptedSend: vi.fn(async () => false),
}));
const beforeSend = vi.hoisted(() => vi.fn(async () => ({ status: "sent", outcome: { kind: "sent" } })));
vi.mock("@/lib/agent-engine/guardrails/before-send", () => ({ runBeforeSend: beforeSend }));
vi.mock("@/lib/channels/runtime", () => ({ createRuntimeSendChannel: () => ({ send: vi.fn() }) }));

function poolDosHandlers(statusDaOrg: string) {
  const settles: unknown[][] = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("fn_reply_settle") || sql.includes("fn_meet_delivery_settle")) {
      settles.push(params);
      return { rows: [{}] };
    }
    if (sql.includes("from contacts c join channel_sessions")) {
      return {
        rows: [
          { source: "whatsapp", consent: "granted", is_anonymized: false, daily_message_limit: null, org_status: statusDaOrg },
        ],
      };
    }
    if (sql.includes("from calendar_appointments a")) {
      return {
        rows: [
          {
            meeting_url: "https://meet.google.com/abc-defg-hij",
            location_kind: "google_meet",
            starts_at: "2026-10-10T13:00:00.000Z",
            time_zone: "America/Sao_Paulo",
            source: "whatsapp",
            consent: "granted",
            is_anonymized: false,
            channel_session_id: "canal-1",
            daily_message_limit: null,
            archived_at: null,
            contact_locale: null,
            organization_locale: "pt-BR",
            org_status: statusDaOrg,
          },
        ],
      };
    }
    return { rows: [] };
  });
  return { pool: { query } as never, settles };
}

const DEPS = {
  crmCfg: {} as never,
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
  sleep: async () => {},
};

function jobDe(kind: string) {
  return {
    id: JOB_ID,
    organization_id: ORG,
    contact_id: "contato-1",
    kind,
    payload: {
      service_boundary: {
        organization_id: ORG,
        contact_id: "contato-1",
        conversation_id: "conv-1",
        service_revision: 1,
        demanda_id: null,
        demanda_revision: null,
      },
      appointment_id: "ag-1",
    },
    attempts: 1,
    max_attempts: 5,
  } as never;
}

describe("approved_reply × organização suspensa", () => {
  it("não envia a resposta já aprovada por humano, e fecha o job como falho com organizacao_inativa", async () => {
    beforeSend.mockClear();
    const { pool, settles } = poolDosHandlers("suspended");
    await createApprovedReplyHandler(DEPS)(jobDe("approved_reply"), pool);
    expect(beforeSend).not.toHaveBeenCalled();
    expect(settles).toHaveLength(1);
    expect(settles[0]).toEqual([ORG, JOB_ID, CLAIM.worker_id, CLAIM.acquired_at, "failed", "organizacao_inativa"]);
  });

  it("controle positivo: organização ativa envia", async () => {
    beforeSend.mockClear();
    const { pool } = poolDosHandlers("active");
    await createApprovedReplyHandler(DEPS)(jobDe("approved_reply"), pool);
    expect(beforeSend).toHaveBeenCalledTimes(1);
  });
});

describe("transactional_delivery (compromisso) × organização suspensa", () => {
  it("não envia o texto do compromisso, e fecha o job como falho", async () => {
    beforeSend.mockClear();
    const { pool, settles } = poolDosHandlers("suspended");
    await createMeetDeliveryHandler({ ...DEPS, crmCfg: {} as never })(jobDe("transactional_delivery"), pool);
    expect(beforeSend).not.toHaveBeenCalled();
    expect(settles).toHaveLength(1);
    expect(settles[0]![4]).toBe("failed");
  });

  it("controle positivo: organização ativa envia", async () => {
    beforeSend.mockClear();
    const { pool } = poolDosHandlers("active");
    await createMeetDeliveryHandler({ ...DEPS, crmCfg: {} as never })(jobDe("transactional_delivery"), pool);
    expect(beforeSend).toHaveBeenCalledTimes(1);
  });
});
