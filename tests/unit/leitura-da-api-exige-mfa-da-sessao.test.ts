/**
 * D-092: a exigência de MFA só valia nas rotas com `requireRole`. As rotas de
 * LEITURA usavam `resolveActiveOrg` direto, e a RLS não olha o nível da sessão:
 * uma sessão aal1 (só senha) de quem tem TOTP cadastrado lia todas as conversas
 * e mensagens da empresa.
 *
 * Duas provas:
 *  1. comportamento: com a sessão aal1 e fator cadastrado (`mfaEmDivida` true),
 *     cada rota de leitura responde 403 `mfa_required` e não toca nos dados;
 *     com a MFA em dia, a mesma sessão passa do portão (não é 403);
 *  2. cerca: nenhuma rota de `app/api` decide acesso lendo só `resolveActiveOrg`
 *     sem passar por `requireRole`/`resolveAuthDual`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { AuthUser } from "@/lib/auth/types";

vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(),
  resolveActiveOrg: vi.fn(),
  mfaEmDivida: vi.fn(),
  sessionAal: vi.fn(async () => "aal1"),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => undefined),
  isServiceRoleConfigured: () => false,
  hashEmail: (e: string) => e,
}));

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";

/** Cada chamada ao banco que ESCAPAR do portão aparece aqui. */
const consultasAoBanco: string[] = [];

function sessao() {
  const user: AuthUser = {
    id: USER_ID,
    email: "u@example.com",
    full_name: null,
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR",
    organizations: [{ organization_id: ORG_ID, organization_name: "Org", role: "admin" }],
  };
  vi.mocked(loadAuthUser).mockResolvedValue(user);
  vi.mocked(resolveActiveOrg).mockResolvedValue({ orgId: ORG_ID, name: "Org", role: "admin" });
  const stub = {
    auth: { getUser: async () => ({ data: { user: { id: USER_ID } }, error: null }) },
    rpc: async (fn: string) =>
      fn === "fn_user_role_in_org" ? { data: "admin", error: null } : { data: null, error: null },
    from: (tabela: string) => {
      consultasAoBanco.push(tabela);
      const resultado = { data: [], error: null, count: 0 };
      const proxy: unknown = new Proxy(() => proxy, {
        get(_t, prop) {
          if (prop === "then") {
            return (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) =>
              Promise.resolve(resultado).then(ok, ko);
          }
          return () => proxy;
        },
        apply: () => proxy,
      });
      return proxy;
    },
  } as never;
  vi.mocked(createClient).mockResolvedValue(stub);
  vi.mocked(createAdminClient).mockReturnValue(stub);
}

const req = (url: string) => new NextRequest(`http://localhost${url}`);
const ctx = (p: Record<string, string>) => ({ params: Promise.resolve(p) });
const ID = "33333333-3333-4333-8333-333333333333";

type Chamada = [string, () => Promise<{ GET: (...a: never[]) => Promise<Response> }>, unknown[]];
const ROTAS: Chamada[] = [
  ["conversations", () => import("@/app/api/v1/conversations/route"), [req("/api/v1/conversations?limit=100")]],
  ["conversations/[id]", () => import("@/app/api/v1/conversations/[id]/route"), [req("/x"), ctx({ id: ID })]],
  ["conversations/[id]/messages", () => import("@/app/api/v1/conversations/[id]/messages/route"), [req("/x"), ctx({ id: ID })]],
  ["conversations/[id]/retention", () => import("@/app/api/v1/conversations/[id]/retention/route"), [req("/x"), ctx({ id: ID })]],
  ["conversations/counts", () => import("@/app/api/v1/conversations/counts/route"), [req("/api/v1/conversations/counts")]],
  ["pipelines/[id]/board", () => import("@/app/api/v1/pipelines/[id]/board/route"), [req("/x"), ctx({ id: ID })]],
  ["leads/[id]/timeline", () => import("@/app/api/v1/leads/[id]/timeline/route"), [req("/x"), ctx({ id: ID })]],
  ["contacts/[id]/timeline", () => import("@/app/api/v1/contacts/[id]/timeline/route"), [req("/x"), ctx({ id: ID })]],
  ["contacts/[id]/crm-summary", () => import("@/app/api/v1/contacts/[id]/crm-summary/route"), [req("/x"), ctx({ id: ID })]],
  ["contacts/[id]/hierarquia-do-anuncio", () => import("@/app/api/v1/contacts/[id]/hierarquia-do-anuncio/route"), [req("/x"), ctx({ id: ID })]],
  ["contacts/[id]/avatar", () => import("@/app/api/v1/contacts/[id]/avatar/route"), [req("/x"), ctx({ id: ID })]],
  ["contacts/duplicates", () => import("@/app/api/v1/contacts/duplicates/route"), []],
  ["leads/proposals", () => import("@/app/api/v1/leads/proposals/route"), [req("/api/v1/leads/proposals")]],
  ["messages/[id]/media", () => import("@/app/api/v1/messages/[id]/media/route"), [req("/x"), ctx({ id: ID })]],
  ["ai/providers/[provider]/models", () => import("@/app/api/v1/ai/providers/[provider]/models/route"), [req("/x"), ctx({ provider: "openai" })]],
  ["voice/sessions/status", () => import("@/app/api/v1/voice/sessions/status/route"), []],
  ["mcp/tools", () => import("@/app/api/v1/mcp/tools/route"), [req("/api/v1/mcp/tools")]],
];

beforeEach(() => {
  vi.clearAllMocks();
  consultasAoBanco.length = 0;
  sessao();
});

describe("D-092 rotas de leitura: MFA da sessão", () => {
  it.each(ROTAS)("%s: sessão aal1 com fator cadastrado leva 403 mfa_required e não lê dado", async (_nome, carregar, args) => {
    vi.mocked(mfaEmDivida).mockResolvedValue(true);
    const { GET } = await carregar();
    const res = await (GET as (...a: unknown[]) => Promise<Response>)(...args);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("mfa_required");
    expect(consultasAoBanco, "a rota leu tabela antes do portão de MFA").toEqual([]);
  });

  it.each(ROTAS)("%s: com a MFA em dia passa do portão (não é 401/403 de acesso)", async (_nome, carregar, args) => {
    vi.mocked(mfaEmDivida).mockResolvedValue(false);
    const { GET } = await carregar();
    const res = await (GET as (...a: unknown[]) => Promise<Response>)(...args);
    expect([401, 403]).not.toContain(res.status);
  });
});

function rotas(dir: string, acc: string[] = []): string[] {
  for (const nome of readdirSync(dir)) {
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory()) rotas(caminho, acc);
    else if (nome === "route.ts") acc.push(caminho);
  }
  return acc;
}

describe("D-092 cerca: rota não decide acesso só com resolveActiveOrg", () => {
  it("todo route.ts que lê resolveActiveOrg passa por requireRole, resolveAuthDual ou requirePlatformAdmin", () => {
    const sem = rotas(join(process.cwd(), "app/api"))
      .filter((f) => {
        const src = readFileSync(f, "utf8");
        return (
          /\bresolveActiveOrg\b/.test(src) &&
          !/\b(requireRole|resolveAuthDual|requirePlatformAdmin)\b/.test(src)
        );
      })
      .map((f) => f.replace(process.cwd(), ""));
    expect(sem, "rota decide a organização sem o gate único (MFA fica de fora)").toEqual([]);
  });
});
