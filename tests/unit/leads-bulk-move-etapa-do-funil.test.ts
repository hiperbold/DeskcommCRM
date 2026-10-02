/**
 * D-150: mover em lote só para etapa do MESMO funil do lead, na organização ativa.
 *
 * Prova, contra o Route Handler REAL de `POST /api/v1/leads/bulk` (auth e Supabase
 * mockados), que a etapa de destino é conferida antes da função do banco:
 *  - etapa de outro funil da mesma empresa: 422 `pipeline_immutable_use_clone`,
 *    nomeando os leads, e `fn_mover_leads_em_lote` NÃO roda (a função só troca
 *    `stage_id`, então o lead ficaria com funil de um e etapa de outro);
 *  - etapa de OUTRA organização (a RLS de quem é membro de duas empresas a
 *    mostra): 404, a função não roda;
 *  - a consulta da etapa leva o filtro de organização;
 *  - etapa do mesmo funil segue funcionando.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { AuthUser, Role } from "@/lib/auth/types";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => undefined),
  isServiceRoleConfigured: vi.fn(() => false),
}));
vi.mock("@/lib/leads/activity-emitter", () => ({
  emitLeadActivity: vi.fn(async () => ({ ok: true })),
  stageChangeReason: vi.fn(() => "razão"),
}));

import { POST } from "@/app/api/v1/leads/bulk/route";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const OUTRA_ORG_ID = "99999999-9999-4999-8999-999999999999";
const FUNIL_A = "55555555-5555-4555-8555-555555555555";
const FUNIL_B = "77777777-7777-4777-8777-777777777777";
const ETAPA_ORIGEM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ETAPA_DESTINO = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CARD_A = "44444444-4444-4444-8444-444444444444";
const CARD_B = "66666666-6666-4666-8666-666666666666";

interface Estado {
  etapa: { pipeline_id: string; organization_id: string } | null;
  funilDosCards: string[];
  filtrosDaEtapa: Array<[string, unknown]>;
  rpcChamado: boolean;
}

function clienteStub(estado: Estado) {
  const leads = [CARD_A, CARD_B].map((id, i) => ({
    id,
    organization_id: ORG_ID,
    tags: [],
    stage_id: ETAPA_ORIGEM,
    pipeline_id: estado.funilDosCards[i],
    contact_id: null,
    lost_reason: null,
    custom_fields: {},
    won_reason: null,
    status: "open",
  }));

  return {
    from: (tabela: string) => {
      const b = {
        select() {
          return b;
        },
        eq(coluna: string, valor: unknown) {
          if (tabela === "crm_stages") estado.filtrosDaEtapa.push([coluna, valor]);
          return b;
        },
        in() {
          return b;
        },
        is() {
          return b;
        },
        maybeSingle() {
          return Promise.resolve({
            data: estado.etapa
              ? { id: ETAPA_DESTINO, name: "Proposta", is_lost: false, is_won: false, ...estado.etapa }
              : null,
            error: null,
          });
        },
        then(onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) {
          return Promise.resolve({ data: tabela === "crm_leads" ? leads : [], error: null }).then(
            onF,
            onR,
          );
        },
      };
      return b;
    },
    rpc(nome: string) {
      if (nome !== "fn_mover_leads_em_lote") return Promise.resolve({ data: null, error: null });
      estado.rpcChamado = true;
      return Promise.resolve({
        data: [CARD_A, CARD_B].map((id) => ({
          lead_id: id,
          from_stage_id: ETAPA_ORIGEM,
          pipeline_id: FUNIL_A,
        })),
        error: null,
      });
    },
  };
}

function adminStub() {
  const chain = {
    select: () => chain,
    eq: () => chain,
    is: () => chain,
    maybeSingle: () => Promise.resolve({ data: null, error: null }),
    then: (onF: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(onF),
  };
  return { from: () => chain, rpc: () => Promise.resolve({ data: null, error: null }) };
}

function sessao(estado: Estado) {
  const user: AuthUser = {
    id: USER_ID,
    email: "a@example.com",
    full_name: null,
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR" as const,
    organizations: [{ organization_id: ORG_ID, organization_name: "Org", role: "agent" as Role }],
  };
  vi.mocked(requireRole).mockImplementation(async () => ({
    ok: true,
    user,
    org: { orgId: ORG_ID, name: "Org", role: "agent" as Role },
  }));
  vi.mocked(createClient).mockResolvedValue(clienteStub(estado) as never);
  vi.mocked(createAdminClient).mockReturnValue(adminStub() as never);
}

function pedido() {
  return new NextRequest("http://local/api/v1/leads/bulk", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "move",
      lead_ids: [CARD_A, CARD_B],
      params: { stage_id: ETAPA_DESTINO },
    }),
  });
}

describe("mover o lote: a etapa tem de ser do funil dos leads (D-150)", () => {
  let estado: Estado;
  beforeEach(() => {
    estado = {
      etapa: { pipeline_id: FUNIL_A, organization_id: ORG_ID },
      funilDosCards: [FUNIL_A, FUNIL_A],
      filtrosDaEtapa: [],
      rpcChamado: false,
    };
  });

  it("etapa de outro funil: 422, nomeia os leads e a função do banco NÃO roda", async () => {
    estado.etapa = { pipeline_id: FUNIL_B, organization_id: ORG_ID };
    sessao(estado);
    const res = await POST(pedido());

    expect(res.status).toBe(422);
    const corpo = (await res.json()) as { error?: { code?: string; details?: { lead_ids?: string[] } } };
    expect(corpo.error?.code).toBe("pipeline_immutable_use_clone");
    expect(corpo.error?.details?.lead_ids).toEqual([CARD_A, CARD_B]);
    expect(estado.rpcChamado).toBe(false);
  });

  it("um só lead do lote em outro funil derruba o lote e nomeia só ele", async () => {
    estado.funilDosCards = [FUNIL_A, FUNIL_B];
    sessao(estado);
    const res = await POST(pedido());

    expect(res.status).toBe(422);
    const corpo = (await res.json()) as { error?: { details?: { lead_ids?: string[] } } };
    expect(corpo.error?.details?.lead_ids).toEqual([CARD_B]);
    expect(estado.rpcChamado).toBe(false);
  });

  it("etapa de outra organização (visível pela RLS): 404 e a função NÃO roda", async () => {
    estado.etapa = { pipeline_id: FUNIL_A, organization_id: OUTRA_ORG_ID };
    sessao(estado);
    const res = await POST(pedido());

    expect(res.status).toBe(404);
    expect(estado.rpcChamado).toBe(false);
  });

  it("a consulta da etapa leva o filtro da organização ativa", async () => {
    sessao(estado);
    await POST(pedido());
    expect(estado.filtrosDaEtapa).toContainEqual(["organization_id", ORG_ID]);
  });

  it("etapa do mesmo funil e da mesma organização: move normalmente", async () => {
    sessao(estado);
    const res = await POST(pedido());

    expect(res.status).toBe(200);
    expect(estado.rpcChamado).toBe(true);
  });
});
