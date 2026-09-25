/**
 * Tarefa 7, fase F4: `tickProspecting` não chama `sendNextCandidate` quando a
 * organização está em modo leitura: nenhum candidato é reservado, nenhuma
 * abordagem fica represada para a reativação. Molde de
 * `tests/unit/prospecting-worker.test.ts` (mocks das dependências de envio)
 * mais o mock de `contaEmModoLeituraPeloPool` (`lib/billing/assinatura/modo-leitura.ts`).
 *
 * Achado 4 da revisão (F4): a campanha é PAUSADA (status='paused',
 * error='assinatura_suspensa'), não só represada, para não voltar a abordar
 * sozinha com atraso quando a conta reativar.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  audit: vi.fn(),
  guard: vi.fn(),
  boundary: vi.fn(),
  preflight: vi.fn(),
  authorize: vi.fn(),
  knobs: vi.fn(),
  open: vi.fn(),
  generate: vi.fn(),
  modoLeitura: vi.fn(),
}));
vi.mock("@/app/api/v1/messages/_handler", () => ({ sendMessageHandler: mocks.send }));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));
vi.mock("@/lib/agent-engine/agent/abordagem-de-formulario", () => ({
  gerarAbordagemDeFormulario: mocks.generate,
}));
vi.mock("@/lib/agent-engine/edge/llm/credentials", () => ({ llmEdgeConfigFromEnv: () => ({}) }));
vi.mock("@/lib/atendimento/origem", () => ({
  assertServiceBoundarySupabase: mocks.boundary,
  beginServiceAtOrigin: vi.fn(),
}));
vi.mock("@/lib/atendimento/fronteira", () => ({ parseServiceBoundary: (x: unknown) => x }));
vi.mock("@/lib/ai/elegibilidade/autorizacao", () => ({ autorizarContatoParaIA: mocks.authorize }));
vi.mock("@/lib/ai/elegibilidade/consulta-pre-go-live", () => ({
  decidirPreGoLiveDoCanalViaSupabase: mocks.preflight,
}));
vi.mock("@/lib/prospecting/guard", () => ({ assertProspectingDelivery: mocks.guard }));
vi.mock("@/lib/agent-engine/pacing/store", () => ({
  loadChannelKnobs: mocks.knobs,
  loadPacingState: vi.fn().mockResolvedValue({ sentToday: 0 }),
  recordSend: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/agent-engine/pacing/engine", () => ({
  janelaDeEnvioAberta: mocks.open,
  decidePacing: () => ({ allow: true, waitMs: 0 }),
  proximaAberturaDaJanela: () => new Date(Date.now() + 3600000),
  warmupCapFor: (_idade: number, degraus: Array<{ minAgeDays: number; cap: number | null }>) => {
    let cap: number | null = degraus[0]?.cap ?? null;
    for (const d of degraus) if (_idade >= d.minAgeDays) cap = d.cap;
    return cap;
  },
}));
vi.mock("@/lib/env", () => ({ env: {} }));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/billing/assinatura/modo-leitura", () => ({
  contaEmModoLeituraPeloPool: mocks.modoLeitura,
}));

const dbCalls: string[] = [];
/** D-066: hook para um teste único sobrescrever uma resposta pontual do `db.query`. */
let dbQueryImplOverride: ((sql: string) => { rows: unknown[]; rowCount?: number } | undefined) | null = null;
function dbQueryImpl(sql: string) {
  dbCalls.push(sql);
  const desviado = dbQueryImplOverride?.(sql);
  if (desviado) return desviado;
  if (sql.startsWith("update prospecting_campaigns set search_status='unknown'")) return { rows: [] };
  if (sql.startsWith("update prospecting_candidates set status='failed',error='Execução interrompida"))
    return { rows: [] };
  if (sql.startsWith("select * from prospecting_campaigns where organization_id=$1 and search_status='running'"))
    return { rows: [] };
  if (sql.startsWith("select * from prospecting_campaigns where organization_id=$1 and status='running'"))
    return { rows: [campaign] };
  // D-066: a linha realmente pausou (rowCount 1); é o que decide se a
  // auditoria dispara.
  if (sql.startsWith("update prospecting_campaigns set status='paused',error=$3"))
    return { rows: [], rowCount: 1 };
  if (sql.startsWith("update prospecting_campaigns set updated_at=now()")) return { rows: [] };
  if (sql.startsWith("select daily_message_limit")) return { rows: [{ daily_message_limit: 50 }] };
  if (sql.includes("count(*) filter"))
    return { rows: [{ campaign: 0, total: 0, retry_at: null, last_attempt: null }] };
  if (sql.startsWith("select * from prospecting_candidates where organization_id=$1 and campaign_id=$2"))
    return { rows: [candidate] };
  if (sql.startsWith("select locale from organizations")) return { rows: [{ locale: null }] };
  if (sql.startsWith("select published_version_id"))
    return { rows: [{ published_version_id: id, operation_revision: 1 }] };
  return { rows: [] };
}
vi.mock("@/lib/prospecting/store", () => ({
  withProspectingLock: (_pool: unknown, _org: string, fn: (db: unknown) => unknown) =>
    fn({ query: vi.fn(async (sql: string) => dbQueryImpl(sql)) }),
  synchronizeSearch: vi.fn(),
  validateConfig: vi.fn().mockResolvedValue(undefined),
}));

import { tickProspecting } from "@/lib/prospecting/worker";
import type { Campaign } from "@/lib/prospecting/store";
import { logger } from "@/lib/logger";

const id = "10000000-0000-4000-8000-000000000001";
const campaign = {
  id,
  organization_id: id,
  next_send_at: new Date(0),
  config: {
    agent_id: id,
    channel_session_id: id,
    pipeline_id: id,
    stage_id: id,
    qualified_stage_id: "10000000-0000-4000-8000-000000000002",
    instruction: "Oferta definida pelo operador",
    qualification: "Necessidade confirmada pela pessoa",
    daily_limit: 10,
    interval_minutes: 15,
    legal_basis_ref: "LIA-example",
  },
} as Campaign;
const candidate = {
  id: "candidate",
  contact_id: id,
  conversation_id: id,
  message_id: "stable-message",
  phone: "+5511999990000",
  service_boundary: { conversation_id: id },
  data: { name: "Example", socials: [] },
};

const pool = {
  query: vi.fn(async (sql: string) => {
    if (sql.includes("group by organization_id")) return { rows: [{ organization_id: id }] };
    return { rows: [] };
  }),
};

beforeEach(() => {
  vi.clearAllMocks();
  dbCalls.length = 0;
  dbQueryImplOverride = null;
  mocks.knobs.mockResolvedValue({ knobs: {} });
  mocks.open.mockReturnValue(true);
  mocks.preflight.mockResolvedValue({ permite: true });
  mocks.guard.mockResolvedValue(undefined);
  mocks.boundary.mockResolvedValue(undefined);
  mocks.generate.mockResolvedValue({
    ok: true,
    texto: "Olá. Posso entender como vocês atendem hoje?",
  });
  mocks.authorize.mockResolvedValue({ ok: true });
  mocks.send.mockResolvedValue({ status: "sent" });
});

describe("tickProspecting × modo leitura (Tarefa 7)", () => {
  it("organização em modo leitura: não chama sendNextCandidate, a campanha fica como está", async () => {
    mocks.modoLeitura.mockResolvedValue(true);

    await tickProspecting(pool as never, {} as never);

    expect(mocks.modoLeitura).toHaveBeenCalledWith(pool, id);
    // sendNextCandidate nunca começou: nenhuma das suas dependências rodou.
    expect(mocks.knobs).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
      expect.stringContaining("modo leitura"),
      expect.objectContaining({ organization_id: id }),
    );
    // A campanha continua sendo "tocada" (updated_at), só não abordou ninguém.
    expect(dbCalls.some((s) => s.startsWith("update prospecting_campaigns set updated_at=now()"))).toBe(
      true,
    );
    // Achado 4: a campanha é PAUSADA (não só represada) com o motivo.
    expect(
      dbCalls.some((s) => s.startsWith("update prospecting_campaigns set status='paused',error=$3")),
    ).toBe(true);
    // D-066: a pausa por conta suspensa grava auditoria, igual à campanha de
    // disparo (`campaign.paused`), só que com a ação própria de prospecção.
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "prospecting.paused",
        organizationId: id,
        resourceType: "prospecting_campaign",
        resourceId: id,
        metadata: { reason: "assinatura_suspensa" },
      }),
    );
  });

  it("D-066: UPDATE que não pausa nenhuma linha (corrida perdida) não audita", async () => {
    mocks.modoLeitura.mockResolvedValue(true);
    dbQueryImplOverride = (sql: string) => {
      if (sql.startsWith("update prospecting_campaigns set status='paused',error=$3")) {
        return { rows: [], rowCount: 0 };
      }
      return undefined;
    };

    await tickProspecting(pool as never, {} as never);

    expect(mocks.audit).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "prospecting.paused" }),
    );
  });

  it("fora do modo leitura: chama sendNextCandidate normalmente e aborda o candidato", async () => {
    mocks.modoLeitura.mockResolvedValue(false);

    await tickProspecting(pool as never, {} as never);

    expect(mocks.modoLeitura).toHaveBeenCalledWith(pool, id);
    expect(mocks.knobs).toHaveBeenCalledTimes(1);
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });
});
