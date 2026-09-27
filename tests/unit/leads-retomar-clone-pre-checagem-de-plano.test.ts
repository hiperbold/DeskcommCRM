/**
 * `retomarLeadHandler` e `POST /api/v1/leads/[id]/clone` criam um lead novo, e
 * até esta correção o faziam sem a pré-checagem de plano que `bulk`, `import` e
 * `channels/graph-partner` já tinham (lib/billing/planos/bloqueio-vale.ts):
 * confiavam só no gatilho do banco. Estes testes cobrem as duas rotas no teto,
 * no molde de `leads-bulk-move-pre-checagem-de-plano.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { ApiError } from "@/lib/api/types";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { podeCriar } from "@/lib/billing/planos/pode-criar";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import type { AuthUser, Role } from "@/lib/auth/types";

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
vi.mock("@/lib/leads/activity-write-failure", () => ({
  registraFalhaDeAtividade: vi.fn(async () => undefined),
}));

const ORG = "22222222-2222-4222-8222-222222222222";
const LEAD = "33333333-3333-4333-8333-333333333333";
const FUNIL_ORIGEM = "44444444-4444-4444-8444-444444444444";
const PIPELINE_DESTINO = "55555555-5555-4555-8555-555555555555";
const ETAPA_DESTINO = "66666666-6666-4666-8666-666666666666";
const USER_ID = "11111111-1111-4111-8111-111111111111";

/** `bloqueioValeParaOrganizacao` (lib/billing/planos/modo-cacheado.ts) vale
 * quando `billing_settings.modo = 'bloquear'` e o contrato já venceu a
 * carência — dublê mínimo para as duas tabelas que ela lê. */
function adminStub() {
  return {
    from: (tabela: string) => {
      if (tabela === "billing_settings") {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: { modo: "bloquear" }, error: null }) }),
          }),
        };
      }
      if (tabela === "billing_contracts") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { bloqueio_a_partir_de: "2020-01-01T00:00:00.000Z" },
                error: null,
              }),
            }),
          }),
        };
      }
      throw new Error(`adminStub: tabela inesperada ${tabela}`);
    },
  };
}

const TETO_ATINGIDO = {
  pode: false,
  motivo: "teto_atingido" as const,
  atual: 999,
  teto: 999,
  leituraFalhou: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createAdminClient).mockReturnValue(adminStub() as never);
});

// ---------------------------------------------------------------------------
// retomarLeadHandler
// ---------------------------------------------------------------------------

describe("retomarLeadHandler: pré-checagem de plano (F3, Tarefa 7)", () => {
  /** O mínimo que o handler lê antes de criar: origem encerrada, sem retomada
   * aberta ainda, funil sem regra de campos, e a etapa aberta do funil.
   * `crm_leads` é consultado DUAS vezes (a origem, depois a checagem de
   * idempotência `jaRetomado`) — um contador por tabela distingue as duas. */
  function clienteStub() {
    const chamadasPorTabela = new Map<string, number>();
    const etapas = [
      { id: "77777777-7777-4777-8777-777777777777", pipeline_id: FUNIL_ORIGEM, is_won: false, is_lost: false, is_archived: false },
    ];

    return {
      from: (tabela: string) => {
        const numero = (chamadasPorTabela.get(tabela) ?? 0) + 1;
        chamadasPorTabela.set(tabela, numero);
        const builder = {
          select() {
            return builder;
          },
          eq() {
            return builder;
          },
          is() {
            return builder;
          },
          order() {
            return builder;
          },
          limit() {
            return builder;
          },
          maybeSingle: async () => {
            if (tabela === "crm_leads" && numero === 1) {
              return {
                data: {
                  id: LEAD,
                  organization_id: ORG,
                  pipeline_id: FUNIL_ORIGEM,
                  status: "lost",
                  title: "Negócio perdido",
                  contact_id: null,
                  tags: [],
                  custom_fields: {},
                  lost_reason: "price",
                },
                error: null,
              };
            }
            if (tabela === "crm_leads" && numero === 2) {
              return { data: null, error: null }; // jaRetomado: nenhum ainda
            }
            if (tabela === "crm_pipelines") {
              return { data: { settings: {} }, error: null };
            }
            throw new Error(`clienteStub: maybeSingle inesperado em ${tabela} (chamada ${numero})`);
          },
          then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => {
            if (tabela === "crm_stages") {
              return Promise.resolve({ data: etapas, error: null }).then(onF, onR);
            }
            return Promise.reject(new Error(`clienteStub: then inesperado em ${tabela}`)).catch(onR);
          },
          insert() {
            throw new Error("o insert não pode acontecer: a pré-checagem tinha de recusar antes");
          },
        };
        return builder;
      },
    };
  }

  const ctx: HandlerCtx = {
    organization_id: ORG,
    actor: { type: "user", id: USER_ID },
    requestId: "req-1",
    idioma: "pt-BR",
  };

  it("bloqueio VALE e o teto está cheio: recusa com 402 plano_limite_atingido, sem tentar o INSERT", async () => {
    vi.mocked(podeCriar).mockResolvedValue(TETO_ATINGIDO);

    const { retomarLeadHandler } = await import("@/app/api/v1/leads/_handler");

    let erro: ApiError | null = null;
    try {
      await retomarLeadHandler(clienteStub() as never, ctx, LEAD, {});
    } catch (err) {
      if (err instanceof ApiError) erro = err;
      else throw err;
    }

    expect(erro).not.toBeNull();
    expect(erro?.status).toBe(402);
    expect(erro?.code).toBe("plano_limite_atingido");
    expect(vi.mocked(podeCriar)).toHaveBeenCalledWith(expect.anything(), ORG, "leads");
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/leads/[id]/clone
// ---------------------------------------------------------------------------

describe("POST /api/v1/leads/[id]/clone: pré-checagem de plano (F3, Tarefa 7)", () => {
  /** Origem já encerrada (`status: "lost"`), funil de origem em `novo_negocio`
   * (issue #1538): a troca de funil não recusa por fronteira nem por motivo, e
   * chega até a pré-checagem de plano antes do `createLeadHandler`. */
  function clienteStub() {
    const origem = {
      id: LEAD,
      organization_id: ORG,
      pipeline_id: FUNIL_ORIGEM,
      status: "lost",
      title: "Negócio perdido",
      description: null,
      contact_id: null,
      value_cents: null,
      currency: "BRL",
      owner_user_id: null,
      owner_agent_id: null,
      expected_close_date: null,
      tags: [],
      source: "manual",
      custom_fields: {},
      source_metadata: {},
      lost_reason: "price",
    };
    const pipeline = {
      id: PIPELINE_DESTINO,
      name: "Funil de destino",
      settings: { reabertura: "novo_negocio" },
    };
    const etapas = [
      { id: ETAPA_DESTINO, pipeline_id: PIPELINE_DESTINO, position: 1, is_won: false, is_lost: false, is_archived: false },
    ];

    return {
      from: (tabela: string) => {
        const builder = {
          select() {
            return builder;
          },
          eq() {
            return builder;
          },
          order() {
            return builder;
          },
          limit() {
            return builder;
          },
          maybeSingle: async () => {
            if (tabela === "crm_leads") return { data: origem, error: null };
            if (tabela === "crm_pipelines") return { data: pipeline, error: null };
            throw new Error(`clienteStub: maybeSingle inesperado em ${tabela}`);
          },
          then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => {
            if (tabela === "crm_stages") {
              return Promise.resolve({ data: etapas, error: null }).then(onF, onR);
            }
            return Promise.reject(new Error(`clienteStub: then inesperado em ${tabela}`)).catch(onR);
          },
          insert() {
            throw new Error("o clone não pode chegar ao INSERT: a pré-checagem tinha de recusar antes");
          },
        };
        return builder;
      },
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
      organizations: [{ organization_id: ORG, organization_name: "Org", role: "agent" as Role }],
    };
    vi.mocked(requireRole).mockImplementation(async () => ({
      ok: true,
      user,
      org: { orgId: ORG, name: "Org", role: "agent" as Role },
    }));
    vi.mocked(createClient).mockResolvedValue(clienteStub() as never);
  }

  function pedido() {
    return new NextRequest(`http://local/api/v1/leads/${LEAD}/clone`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pipeline_id: PIPELINE_DESTINO }),
    });
  }

  beforeEach(() => {
    sessao();
  });

  it("bloqueio VALE e o teto está cheio: 402 plano_limite_atingido, sem tentar o INSERT", async () => {
    vi.mocked(podeCriar).mockResolvedValue(TETO_ATINGIDO);

    const { POST } = await import("@/app/api/v1/leads/[id]/clone/route");
    const res = await POST(pedido(), { params: Promise.resolve({ id: LEAD }) });

    expect(vi.mocked(podeCriar)).toHaveBeenCalledWith(expect.anything(), ORG, "leads");
    expect(res.status).toBe(402);
    const corpo = (await res.json()) as { error?: { code?: string } };
    expect(corpo.error?.code).toBe("plano_limite_atingido");
  });
});
