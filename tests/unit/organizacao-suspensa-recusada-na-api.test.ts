/**
 * D-091: a organização suspensa pela plataforma continuava operando pela API.
 *
 * O único portão era o layout de `/app` (redirect para /account-suspended); a
 * rota `/api/v1/*` com o cookie e o bearer `dsk_` seguiam respondendo. Agora:
 *  - `requireRole` recusa 403 `tenant_suspended` para membro de organização
 *    suspensa, em qualquer papel;
 *  - o admin de plataforma (escopo full, MFA em dia) segue entrando pelo atalho
 *    `allowPlatformAdmin`, senão ninguém reativaria o cliente;
 *  - `resolveApiToken` recusa o token de organização suspensa (`tenant_suspended`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ApiTokenError, McpAuthError, resolveApiToken, validateBearerToken } from "@/lib/mcp/auth";
import type { AuthUser, Role } from "@/lib/auth/types";

vi.mock("@/lib/auth/server", () => ({
  mfaEmDivida: vi.fn(async () => false),
  sessionAal: vi.fn(async () => "aal2"),
  loadAuthUser: vi.fn(),
  resolveActiveOrg: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/auth/rate-limit", () => ({
  registrarFalhaDeToken: vi.fn(async () => undefined),
  tokenFailureLimited: vi.fn(async () => false),
}));

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";

function sessao(status: string | undefined, role: Role = "admin", platformAdmin = false) {
  const user: AuthUser = {
    id: USER_ID,
    email: "u@example.com",
    full_name: null,
    avatar_url: null,
    is_platform_admin: platformAdmin,
    idioma: "pt-BR",
    organizations: [
      { organization_id: ORG_ID, organization_name: "Org", role, organization_status: status },
    ],
  };
  vi.mocked(loadAuthUser).mockResolvedValue(user);
  vi.mocked(resolveActiveOrg).mockResolvedValue({ orgId: ORG_ID, name: "Org", role, status });
  vi.mocked(createClient).mockResolvedValue({
    rpc: vi.fn(async () => ({ data: role, error: null })),
    from: () => {
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "is"]) b[m] = () => b;
      b.maybeSingle = async () => ({ data: platformAdmin ? { scope: "full" } : null, error: null });
      return b;
    },
  } as never);
}

beforeEach(() => vi.clearAllMocks());

describe("D-091 requireRole", () => {
  it("organização suspensa: 403 tenant_suspended, mesmo para admin", async () => {
    sessao("suspended");
    const r = await requireRole("viewer");
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.response.status).toBe(403);
    expect((await r.response.json()).error.code).toBe("tenant_suspended");
  });

  it("organização arquivada ou anonimizada também é recusada", async () => {
    for (const status of ["archived", "redacted"]) {
      sessao(status);
      const r = await requireRole("viewer");
      expect(r.ok, status).toBe(false);
    }
  });

  it("organização ativa passa; status ausente no snapshot não derruba (vazio de teste)", async () => {
    sessao("active");
    expect((await requireRole("viewer")).ok).toBe(true);
    sessao(undefined);
    expect((await requireRole("viewer")).ok).toBe(true);
  });

  it("admin de plataforma full entra na organização suspensa pelo atalho (precisa reativar)", async () => {
    sessao("suspended", "admin", true);
    const r = await requireRole("admin", { allowPlatformAdmin: true, organizationId: ORG_ID });
    expect(r.ok).toBe(true);
  });

  it("o override organizationId também respeita a suspensão do membro", async () => {
    sessao("suspended");
    const r = await requireRole("viewer", { organizationId: ORG_ID });
    expect(r.ok).toBe(false);
  });
});

function adminDeTokens(linha: Record<string, unknown>) {
  vi.mocked(createAdminClient).mockReturnValue({
    from: (tabela: string) => {
      const c: Record<string, unknown> = {};
      if (tabela === "api_tokens") {
        c.select = () => c;
        c.eq = () => c;
        c.maybeSingle = async () => ({ data: linha, error: null });
        c.update = () => ({ eq: () => ({ then: (r: (v: unknown) => unknown) => r({ error: null }) }) });
        return c;
      }
      // user_organizations / platform_admins do criador: sempre em dia aqui.
      c.select = () => c;
      c.eq = () => c;
      c.is = () => c;
      c.maybeSingle = async () => ({ data: { role: "admin", user_id: USER_ID }, error: null });
      return c;
    },
  } as never);
}

const PLAINTEXT = "dsk_abcd_segredo";

function linha(statusDaOrg: string | undefined) {
  return {
    id: "aaaaaaaa-1111-4111-8111-111111111111",
    organization_id: ORG_ID,
    scopes: ["mcp:read", "role:agent"],
    revoked_at: null,
    expires_at: null,
    created_by: USER_ID,
    organizations: statusDaOrg ? { status: statusDaOrg } : null,
  };
}

describe("D-091 token de API", () => {
  it("token de organização suspensa: recusa com reason tenant_suspended", async () => {
    adminDeTokens(linha("suspended"));
    await expect(resolveApiToken(PLAINTEXT)).rejects.toMatchObject({
      name: "ApiTokenError",
      reason: "tenant_suspended",
    });
  });

  it("pela casca MCP vira 403 (a conta existe, está suspensa), não 401", async () => {
    adminDeTokens(linha("suspended"));
    const erro = await validateBearerToken(`Bearer ${PLAINTEXT}`).catch((e) => e);
    expect(erro).toBeInstanceOf(McpAuthError);
    expect(erro.httpStatus).toBe(403);
  });

  it("organização ativa: token resolve", async () => {
    adminDeTokens(linha("active"));
    const r = await resolveApiToken(PLAINTEXT);
    expect(r.organizationId).toBe(ORG_ID);
  });

  it("ApiTokenError é exportada com o reason novo", () => {
    expect(new ApiTokenError("tenant_suspended", "x").reason).toBe("tenant_suspended");
  });
});
