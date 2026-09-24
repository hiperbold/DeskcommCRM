/**
 * F3, decisão 5 (Tarefa 7): o teto de leads do plano NÃO pode derrubar a
 * campanha de prospecção inteira (N22: prospecção respeita o teto como toda
 * origem, mas o chat/campanha não pode travar por causa de UM candidato).
 *
 * Prova, contra `activateCampaign` REAL (banco por `pg.Pool`/`pg.PoolClient`
 * mockado, exatamente como `tests/unit/prospecting-worker.test.ts` já faz),
 * que quando `createLeadHandler` recusa um candidato com `ApiError(402)`
 * (PT402 do gatilho de `crm_leads`, migration 0907):
 *
 *  - o candidato é marcado `skipped` com o motivo do limite do plano, nunca
 *    derruba a ativação inteira com um erro solto;
 *  - a Central recebe o aviso (`avisarLimiteDeLeadsAtingido`);
 *  - a campanha SEGUE: termina em `status='running'` e a função devolve
 *    `{ started: true }`, nunca lança.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/api/v1/contacts/_handler", () => ({ createContactHandler: vi.fn() }));
vi.mock("@/app/api/v1/leads/_handler", () => ({ createLeadHandler: vi.fn() }));
vi.mock("@/lib/leads/aviso-limite-de-leads", () => ({
  avisarLimiteDeLeadsAtingido: vi.fn(async () => undefined),
}));
// Sticky router e agente publicado: fora do escopo desta prova. `null` no
// roteador cai no ramo de `loadPublishedAgentConfig`, e ele devolve o mesmo
// agente da campanha: `validateConfig` passa sem exercitar nenhum dos dois
// de verdade.
vi.mock("@/lib/agent-engine/agent/router-config", () => ({ loadActiveRouter: vi.fn(async () => null) }));
vi.mock("@/lib/agent-engine/agent/agent-config", () => ({
  loadPublishedAgentConfig: vi.fn(async () => ({ agentId: "10000000-0000-4000-8000-000000000001" })),
}));
// A ativação só chega a `beginServiceAtOrigin` para um candidato que PASSA do
// teto (o segundo caso, "sem recusa", de referência); o formato mínimo que
// o resto do laço lê (`boundary.conversation_id`) evita um TypeError que não
// tem nada a ver com o que este arquivo prova.
vi.mock("@/lib/atendimento/origem", () => ({
  beginServiceAtOrigin: vi.fn(async () => ({ conversation_id: "77777777-7777-4777-8777-777777777770" })),
}));

import { createContactHandler } from "@/app/api/v1/contacts/_handler";
import { createLeadHandler } from "@/app/api/v1/leads/_handler";
import { avisarLimiteDeLeadsAtingido } from "@/lib/leads/aviso-limite-de-leads";
import { ApiError } from "@/lib/api/types";
import { STATUS_RECUSA_DO_PLANO } from "@/lib/billing/planos/recusa-do-plano";
import { activateCampaign } from "@/lib/prospecting/store";

const ORG = "22222222-2222-4222-8222-222222222222";
const CAMPAIGN_ID = "33333333-3333-4333-8333-333333333333";
const AGENT_ID = "10000000-0000-4000-8000-000000000001";
const CHANNEL_ID = "44444444-4444-4444-8444-444444444444";
const PIPELINE_ID = "55555555-5555-4555-8555-555555555555";
const STAGE_ID = "66666666-6666-4666-8666-666666666666";
const QUALIFIED_STAGE_ID = "77777777-7777-4777-8777-777777777777";
const CANDIDATE_ID = "candidato-1";

const CONFIG = {
  agent_id: AGENT_ID,
  channel_session_id: CHANNEL_ID,
  pipeline_id: PIPELINE_ID,
  stage_id: STAGE_ID,
  qualified_stage_id: QUALIFIED_STAGE_ID,
  instruction: "Ofereça a consultoria gratuita de 20 minutos.",
  qualification: "A pessoa confirmou que decide pela empresa.",
  daily_limit: 10,
  interval_minutes: 15,
  legal_basis_ref: "LIA-teste",
};

const CANDIDATO_BASE = {
  id: CANDIDATE_ID,
  organization_id: ORG,
  campaign_id: CAMPAIGN_ID,
  data: { key: "place-1", name: "Padaria Teste", phone: null, website: null, category: null },
  status: "new",
  phone: "+5511999990000",
  contact_id: null,
  lead_id: null,
  conversation_id: null,
  service_boundary: null,
  message_id: "msg-1",
};

/** Dublê de `pg.Pool`: `connect()` devolve o MESMO `pg.PoolClient` do double. */
function makePool(candidatos: Array<Record<string, unknown>>) {
  const chamadas: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    chamadas.push({ sql, params });

    if (sql.startsWith("select pg_try_advisory_lock")) return { rows: [{ locked: true }] };

    // ── validateConfig ──
    if (sql.startsWith("select v.tool_ids,v.pipeline_ids"))
      return { rows: [{ tool_ids: ["crm_move_lead_stage"], pipeline_ids: [PIPELINE_ID] }] };
    if (sql.startsWith("select provider,status from channel_sessions"))
      return { rows: [{ provider: "waha", status: "WORKING" }] };
    if (sql.startsWith("select id from crm_stages"))
      return { rows: [{ id: STAGE_ID }, { id: QUALIFIED_STAGE_ID }] };

    // ── activateCampaign ──
    if (sql.startsWith("select * from prospecting_campaigns where organization_id=$1 and id=$2"))
      return {
        rows: [
          {
            id: CAMPAIGN_ID,
            organization_id: ORG,
            name: "Campanha",
            status: "draft",
            search_status: "succeeded",
            config: null,
          },
        ],
      };
    if (sql.startsWith("select id from prospecting_campaigns where organization_id=$1 and status='running'"))
      return { rows: [] };
    if (sql.startsWith("update prospecting_campaigns set config=$3 where")) return { rows: [] };
    if (sql.startsWith("select * from prospecting_candidates")) return { rows: candidatos };
    if (sql.startsWith("select id from contacts")) return { rows: [] };
    if (sql.startsWith("update prospecting_candidates set contact_id=$3")) return { rows: [] };
    if (sql.startsWith("select id from crm_leads where organization_id=$1 and source='prospecting'"))
      return { rows: [] };
    if (sql.startsWith("update prospecting_candidates set status='skipped'")) return { rows: [] };
    if (sql.startsWith("update prospecting_campaigns set config=$3,status='running'")) return { rows: [] };
    if (sql.startsWith("update prospecting_candidates set contact_id=$3,lead_id=$4")) return { rows: [] };

    return { rows: [] };
  });
  const client = { query, release: vi.fn() };
  return { pool: { connect: async () => client } as never, chamadas, client };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createContactHandler).mockResolvedValue({
    contact: { id: "88888888-8888-4888-8888-888888888888" },
  } as never);
});

describe("activateCampaign: o teto de leads não derruba a campanha (F3, Tarefa 7)", () => {
  it("candidato recusado (PT402) é marcado skipped, avisa a Central, e a campanha SEGUE", async () => {
    vi.mocked(createLeadHandler).mockRejectedValue(
      new ApiError(STATUS_RECUSA_DO_PLANO, "plano_limite_atingido", undefined, "rid", "fixa"),
    );
    const { pool, chamadas } = makePool([{ ...CANDIDATO_BASE }]);

    const resultado = await activateCampaign(pool, {} as never, ORG, CAMPAIGN_ID, CONFIG as never);

    expect(resultado).toEqual({ started: true });
    expect(vi.mocked(avisarLimiteDeLeadsAtingido)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(avisarLimiteDeLeadsAtingido)).toHaveBeenCalledWith(expect.anything(), ORG);

    const marcouSkipped = chamadas.some(
      ({ sql, params }) =>
        sql.startsWith("update prospecting_candidates set status='skipped'") &&
        sql.includes("Plano no limite de leads; candidato não processado.") &&
        params[1] === CANDIDATE_ID,
    );
    expect(marcouSkipped).toBe(true);

    // A campanha TERMINA em 'running': o candidato recusado não a deixa presa
    // em 'draft' nem lança um erro que a rota de ativação teria que capturar.
    const terminouRunning = chamadas.some((c) =>
      c.sql.startsWith("update prospecting_campaigns set config=$3,status='running'"),
    );
    expect(terminouRunning).toBe(true);
  });

  it("candidato SEM recusa segue o caminho normal (referência: sem o fix, o teste acima cairia aqui)", async () => {
    vi.mocked(createLeadHandler).mockResolvedValue({ id: "lead-1" } as never);
    const { pool, chamadas } = makePool([{ ...CANDIDATO_BASE }]);

    const resultado = await activateCampaign(pool, {} as never, ORG, CAMPAIGN_ID, CONFIG as never);

    expect(resultado).toEqual({ started: true });
    expect(vi.mocked(avisarLimiteDeLeadsAtingido)).not.toHaveBeenCalled();
    expect(
      chamadas.some((c) => c.sql.startsWith("update prospecting_candidates set contact_id=$3,lead_id=$4")),
    ).toBe(true);
  });

  it("um erro que NÃO é a recusa do plano ainda propaga (a rede de segurança é só para o 402)", async () => {
    vi.mocked(createLeadHandler).mockRejectedValue(new Error("banco fora do ar"));
    const { pool } = makePool([{ ...CANDIDATO_BASE }]);

    await expect(
      activateCampaign(pool, {} as never, ORG, CAMPAIGN_ID, CONFIG as never),
    ).rejects.toThrow("banco fora do ar");
    expect(vi.mocked(avisarLimiteDeLeadsAtingido)).not.toHaveBeenCalled();
  });
});
