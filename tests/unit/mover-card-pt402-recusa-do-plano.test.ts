/**
 * F3, decisão 5 (Tarefa 7): arrastar o card (`POST /api/v1/leads/[id]/move`,
 * a rota que o BOARD usa) para reabrir um lead ganho/perdido acima do teto de
 * leads responde 402 com a frase FIXA, nunca o texto cru do Postgres nem 500.
 *
 * Mesmo molde de `tests/unit/etapa-de-perda-no-arrasto.test.ts` (Route
 * Handler REAL, auth e Supabase mockados): o duplo do UPDATE devolve a
 * recusa `PT402` como ela chega pelo `supabase-js` (`code` + `details`, SEM
 * "s" trocado, ver `lib/billing/planos/recusa-do-plano.ts`), emulando o
 * gatilho `trg_crm_leads_billing_bloqueio` (migration 0907, parte 4).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";
import { ROLE_RANK, type AuthUser, type Role } from "@/lib/auth/types";
import { fail } from "@/lib/api/wrappers";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/leads/activity-emitter", () => ({
  emitLeadActivity: vi.fn(async () => ({ ok: true })),
  stageChangeReason: vi.fn(() => "razão"),
}));

import { POST } from "@/app/api/v1/leads/[id]/move/route";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const LEAD_ID = "44444444-4444-4444-8444-444444444444";
const PIPELINE_ID = "55555555-5555-4555-8555-555555555555";
const ETAPA_ABERTA_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const UPDATED_AT = "2026-09-15T12:00:00.000Z";

/** A recusa PT402 do gatilho de bloqueio de leads, como chega pelo supabase-js. */
const RECUSA_DO_BANCO = { code: "PT402", details: "leads" };

const FRASE_FIXA =
  "O plano desta organização chegou ao limite de leads. Fale com o suporte para ampliar.";

interface Estado {
  updates: Array<Record<string, unknown>>;
}

function stub(estado: Estado) {
  const select = () => ({
    eq: () => ({
      maybeSingle: async () => ({
        data: {
          id: LEAD_ID,
          organization_id: ORG_ID,
          pipeline_id: PIPELINE_ID,
          stage_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          status: "won",
          lost_reason: null,
          updated_at: UPDATED_AT,
          contact_id: "66666666-6666-4666-8666-666666666666",
        },
        error: null,
      }),
    }),
  });

  return {
    from: (tabela: string) => ({
      select: () => (tabela === "crm_leads" ? select() : {
        eq: () => ({
          maybeSingle: async () => ({
            data: { id: ETAPA_ABERTA_ID, pipeline_id: PIPELINE_ID, name: "Em contato", is_lost: false },
            error: null,
          }),
        }),
      }),
      update: (payload: Record<string, unknown>) => {
        estado.updates.push(payload);
        // O gatilho de bloqueio é BEFORE e roda ANTES do trigger de motivo da
        // perda: reabrir acima do teto recusa mesmo sem nada de errado com o
        // motivo da perda (aqui nem se aplica: a etapa de destino é aberta).
        return {
          eq: () => ({
            eq: () => ({
              select: () => ({
                maybeSingle: async () => ({ data: null, error: RECUSA_DO_BANCO }),
              }),
            }),
          }),
        };
      },
    }),
    rpc: () => Promise.resolve({ data: null, error: null }),
  };
}

function sessao(estado: Estado, papel: Role = "agent") {
  const user: AuthUser = {
    id: USER_ID,
    email: "a@example.com",
    full_name: null,
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR" as const,
    organizations: [{ organization_id: ORG_ID, organization_name: "Org", role: papel }],
  };
  vi.mocked(requireSupportWrite).mockResolvedValue(null);
  vi.mocked(requireRole).mockImplementation(async (min: Role) => {
    if (ROLE_RANK[papel] >= ROLE_RANK[min]) {
      return { ok: true, user, org: { orgId: ORG_ID, name: "Org", role: papel } };
    }
    return { ok: false, response: fail("forbidden_role", `Requer role >= ${min}.`, 403, {}) };
  });
  vi.mocked(createClient).mockResolvedValue(stub(estado) as never);
}

function pedido(corpo: Record<string, unknown>) {
  return new NextRequest(`http://local/api/v1/leads/${LEAD_ID}/move`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(corpo),
  });
}

describe("arrastar o card para reabrir acima do teto de leads (F3, Tarefa 7)", () => {
  let estado: Estado;
  beforeEach(() => {
    estado = { updates: [] };
  });

  it("PT402: 402 com a frase FIXA, nunca o texto do Postgres nem 500", async () => {
    sessao(estado);
    const res = await POST(
      pedido({ stage_id: ETAPA_ABERTA_ID, position_in_stage: 1000, expected_updated_at: UPDATED_AT }),
      { params: Promise.resolve({ id: LEAD_ID }) },
    );

    expect(res.status).toBe(402);
    const corpo = (await res.json()) as { error?: { code?: string; message?: string } };
    expect(corpo.error?.code).toBe("plano_limite_atingido");
    expect(corpo.error?.message).toBe(FRASE_FIXA);
    expect(corpo.error?.message ?? "").not.toMatch(/PT402|constraint|relation|Postgres/i);
  });
});
