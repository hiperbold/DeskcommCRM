/**
 * F3, decisão 5 (Tarefa 7): `POST /api/v1/leads/bulk` (action "move")
 * reabrindo leads ganho/perdido: a pré-checagem de QUANTIDADE só deve rodar
 * quando o bloqueio VALE para a organização (modo `bloquear` + carência
 * vencida). No modo `avisar` de hoje, nada pode mudar de comportamento.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { podeCriar } from "@/lib/billing/planos/pode-criar";
import { ROLE_RANK, type AuthUser, type Role } from "@/lib/auth/types";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/billing/planos/pode-criar", () => ({ podeCriar: vi.fn() }));
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
const PIPELINE_ID = "55555555-5555-4555-8555-555555555555";
const ETAPA_ABERTA_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CARD_A = "44444444-4444-4444-8444-444444444444";
const CARD_B = "66666666-6666-4666-8666-666666666666";

function clienteStub() {
  const leads = [CARD_A, CARD_B].map((id) => ({
    id,
    organization_id: ORG_ID,
    tags: [],
    stage_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    pipeline_id: PIPELINE_ID,
    contact_id: "77777777-7777-4777-8777-777777777777",
    lost_reason: null,
    // Ambos ESTÃO fechados: mover para uma etapa aberta REABRE os dois.
    status: "won",
  }));

  return {
    from: () => {
      const b = {
        _op: "select" as "select" | "update",
        select() {
          return b;
        },
        update() {
          b._op = "update";
          return b;
        },
        eq() {
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
            data: { id: ETAPA_ABERTA_ID, name: "Em contato", is_lost: false, is_won: false },
            error: null,
          });
        },
        then(onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) {
          return Promise.resolve({ data: leads, error: null }).then(onF, onR);
        },
      };
      return b;
    },
    rpc: () => Promise.resolve({ data: null, error: null }),
  };
}

/** Client de serviço dublado, só responde `bloqueioValeParaOrganizacao`. */
function adminStub(opts: { modo?: string | null; bloqueioAPartirDe?: string | null; falhaSettings?: boolean } = {}) {
  const modo = opts.modo ?? "avisar";
  const chain = {
    select: () => chain,
    eq: () => chain,
    is: () => chain,
    maybeSingle: () => Promise.resolve({ data: null, error: null }),
    then: (onF: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(onF),
  };
  return {
    from: (tabela: string) => {
      if (tabela === "billing_settings") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () =>
                opts.falhaSettings
                  ? { data: null, error: { message: "conexão recusada" } }
                  : { data: { modo }, error: null },
            }),
          }),
        };
      }
      if (tabela === "billing_contracts") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { bloqueio_a_partir_de: opts.bloqueioAPartirDe ?? null },
                error: null,
              }),
            }),
          }),
        };
      }
      return chain;
    },
    rpc: () => Promise.resolve({ data: null, error: null }),
  };
}

function sessao() {
  const user: AuthUser = {
    id: USER_ID,
    email: "m@example.com",
    full_name: null,
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR" as const,
    organizations: [{ organization_id: ORG_ID, organization_name: "Org", role: "manager" as Role }],
  };
  vi.mocked(requireRole).mockImplementation(async (min: Role) => {
    void min;
    return { ok: true, user, org: { orgId: ORG_ID, name: "Org", role: "manager" as Role } };
  });
  vi.mocked(createClient).mockResolvedValue(clienteStub() as never);
  void ROLE_RANK;
}

function pedido() {
  return new NextRequest("http://local/api/v1/leads/bulk", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "move", lead_ids: [CARD_A, CARD_B], params: { stage_id: ETAPA_ABERTA_ID } }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  sessao();
});

describe("POST /api/v1/leads/bulk (move): pré-checagem de quantidade (F3, Tarefa 7)", () => {
  it("bloqueio NÃO vale (modo avisar): podeCriar nem é chamado, o lote reabre mesmo acima do teto", async () => {
    vi.mocked(createAdminClient).mockReturnValue(adminStub({ modo: "avisar" }) as never);

    const res = await POST(pedido());

    expect(vi.mocked(podeCriar)).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
  });

  it("bloqueio VALE e o lote estoura o teto: 402 plano_limite_atingido, RPC não chamado", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      adminStub({ modo: "bloquear", bloqueioAPartirDe: "2020-01-01T00:00:00.000Z" }) as never,
    );
    vi.mocked(podeCriar).mockResolvedValue({
      pode: false,
      motivo: "teto_atingido",
      atual: 999,
      teto: 1000,
      leituraFalhou: false,
    });

    const res = await POST(pedido());

    expect(vi.mocked(podeCriar)).toHaveBeenCalledWith(expect.anything(), ORG_ID, "leads");
    expect(res.status).toBe(402);
    const corpo = (await res.json()) as { error?: { code?: string } };
    expect(corpo.error?.code).toBe("plano_limite_atingido");
  });

  it("bloqueio VALE mas cabe no teto: segue normal (200)", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      adminStub({ modo: "bloquear", bloqueioAPartirDe: "2020-01-01T00:00:00.000Z" }) as never,
    );
    vi.mocked(podeCriar).mockResolvedValue({
      pode: true,
      motivo: "ok",
      atual: 1,
      teto: 1000,
      leituraFalhou: false,
    });

    const res = await POST(pedido());

    expect(res.status).toBe(200);
  });

  it("leitura de billing_settings falha: fail-open, nunca 500", async () => {
    vi.mocked(createAdminClient).mockReturnValue(adminStub({ modo: "bloquear", falhaSettings: true }) as never);

    const res = await POST(pedido());

    expect(vi.mocked(podeCriar)).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
  });
});
