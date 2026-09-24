/**
 * Achado 5 da revisão (F4): `POST /api/v1/automation-rules/runs/[runId]/resend`
 * reenvia webhooks de verdade (`executeCallWebhook`) sem checar o modo leitura.
 * Organização suspensa recusa com PT402/`assinatura_suspensa`, o mesmo formato
 * das demais recusas do plano (`lib/billing/planos/recusa-do-plano.ts`).
 *
 * Molde de `tests/unit/canal-parceiro-pre-checagem-de-plano.test.ts` (Route
 * Handler real, auth mockada, client admin dublado só com o que
 * `contaEmModoLeitura` lê).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { ROLE_RANK, type AuthUser, type Role } from "@/lib/auth/types";
import { fail } from "@/lib/api/wrappers";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { executeCallWebhook } from "@/lib/automation/actions/call-webhook";
import { audit } from "@/lib/audit";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/automation/actions/call-webhook", () => ({ executeCallWebhook: vi.fn() }));
vi.mock("@/lib/automation/engine", () => ({ buildContext: vi.fn(async () => ({})) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

import { POST } from "@/app/api/v1/automation-rules/runs/[runId]/resend/route";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const RUN_ID = "33333333-3333-4333-8333-333333333333";
const RULE_ID = "44444444-4444-4444-8444-444444444444";
const EVENT_ID = "55555555-5555-4555-8555-555555555555";

/** Client admin dublado: só o que `contaEmModoLeitura` lê (billing_settings + rpc). */
function adminStub(opts: { modo: string | null; modoLeitura: boolean }) {
  const chamadasRpc: string[] = [];
  return {
    from: (tabela: string) => {
      if (tabela === "billing_settings") {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: { modo: opts.modo }, error: null }) }),
          }),
        };
      }
      // `createAdminClient()` é chamado de novo mais adiante na rota (config
      // do `call_webhook` e o insert do run novo); mesmo dublê responde aos
      // dois usos.
      if (tabela === "automation_rule_runs") {
        return {
          insert: () => ({
            select: () => ({
              single: async () => ({ data: { id: "novo-run-id" }, error: null }),
            }),
          }),
        };
      }
      throw new Error(`tabela inesperada no dublê admin: ${tabela}`);
    },
    rpc: async (nome: string) => {
      chamadasRpc.push(nome);
      if (nome === "fn_billing_modo_leitura") return { data: opts.modoLeitura, error: null };
      throw new Error(`rpc inesperada no dublê admin: ${nome}`);
    },
    chamadasRpc: () => chamadasRpc,
  };
}

/** Client de sessão dublado: run/rule/event, só o caminho feliz (fora do modo leitura). */
function supabaseSessaoStub() {
  return {
    from: (tabela: string) => {
      if (tabela === "automation_rule_runs") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: { id: RUN_ID, rule_id: RULE_ID, event_id: EVENT_ID },
                  error: null,
                }),
              }),
            }),
          }),
          insert: () => ({
            select: () => ({
              single: async () => ({ data: { id: "novo-run-id" }, error: null }),
            }),
          }),
        };
      }
      if (tabela === "automation_rules") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: { id: RULE_ID, name: "Regra", actions: [{ type: "call_webhook", config: {} }] },
                  error: null,
                }),
              }),
            }),
          }),
        };
      }
      if (tabela === "event_log") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: { id: EVENT_ID, organization_id: ORG_ID }, error: null }),
              }),
            }),
          }),
        };
      }
      throw new Error(`tabela inesperada no dublê de sessão: ${tabela}`);
    },
  };
}

function sessao() {
  const user: AuthUser = {
    id: USER_ID,
    email: "a@example.com",
    full_name: null,
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR" as const,
    organizations: [{ organization_id: ORG_ID, organization_name: "Org", role: "admin" as Role }],
  };
  vi.mocked(requireSupportWrite).mockResolvedValue(null);
  vi.mocked(requireRole).mockImplementation(async (min: Role) =>
    ROLE_RANK["admin"] >= ROLE_RANK[min]
      ? { ok: true, user, org: { orgId: ORG_ID, name: "Org", role: "admin" } }
      : { ok: false, response: fail("forbidden_role", `Requer role >= ${min}.`, 403, {}) },
  );
}

function pedido() {
  return new NextRequest(`http://local/api/v1/automation-rules/runs/${RUN_ID}/resend`, {
    method: "POST",
  });
}

function ctx() {
  return { params: Promise.resolve({ runId: RUN_ID }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  sessao();
});

describe("POST .../resend: modo leitura (achado 5, F4)", () => {
  it("organização em modo leitura: recusa 402 assinatura_suspensa, sem tocar run/rule/event nem o webhook", async () => {
    vi.mocked(createAdminClient).mockReturnValue(adminStub({ modo: "bloquear", modoLeitura: true }) as never);
    vi.mocked(createClient).mockResolvedValue({
      from: () => {
        throw new Error("não deveria consultar run/rule/event quando a conta está suspensa");
      },
    } as never);

    const res = await POST(pedido(), ctx());

    expect(res.status).toBe(402);
    const corpo = (await res.json()) as { error?: { code?: string } };
    expect(corpo.error?.code).toBe("plano_limite_atingido");
    expect(vi.mocked(executeCallWebhook)).not.toHaveBeenCalled();
  });

  it("modo avisar: nenhuma consulta a mais, a RPC de modo leitura nunca é chamada, e o reenvio segue", async () => {
    const admin = adminStub({ modo: "avisar", modoLeitura: true });
    vi.mocked(createAdminClient).mockReturnValue(admin as never);
    vi.mocked(createClient).mockResolvedValue(supabaseSessaoStub() as never);
    vi.mocked(executeCallWebhook).mockResolvedValue({ type: "call_webhook", status: "success" } as never);

    const res = await POST(pedido(), ctx());

    expect(admin.chamadasRpc()).toHaveLength(0);
    expect(res.status).toBe(201);
    expect(vi.mocked(executeCallWebhook)).toHaveBeenCalledTimes(1);
  });

  it("modo bloquear + RPC false (carência não vencida, ou status ativo): segue normalmente", async () => {
    vi.mocked(createAdminClient).mockReturnValue(adminStub({ modo: "bloquear", modoLeitura: false }) as never);
    vi.mocked(createClient).mockResolvedValue(supabaseSessaoStub() as never);
    vi.mocked(executeCallWebhook).mockResolvedValue({ type: "call_webhook", status: "success" } as never);

    const res = await POST(pedido(), ctx());

    expect(res.status).toBe(201);
    expect(vi.mocked(executeCallWebhook)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(audit)).toHaveBeenCalledTimes(1);
  });
});
