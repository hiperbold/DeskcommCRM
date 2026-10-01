/**
 * Lote 7 da auditoria (conta, convite, login), parte de código: D-126, D-120, D-107.
 * O que mexe em banco (D-094, D-125, D-133, D-106) é provado em
 * `tests/invariants/lote7-conta-e-cobranca-banco.test.ts`.
 *
 *     npx vitest run tests/unit/lote7-conta-e-login.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { modoDeCadastro } from "@/lib/auth/politica-de-cadastro";

const h = vi.hoisted(() => ({
  papelDoUsuario: "viewer" as "viewer" | "agent" | "manager" | "admin",
  linhasDaAuditoria: [] as Array<Record<string, unknown>>,
  listUsers: vi.fn(),
  deleteFactor: vi.fn(),
  listFactors: vi.fn(),
  limitado: vi.fn(async () => false),
  atualizacoes: [] as Array<{ tabela: string; filtros: Array<[string, string, unknown]> }>,
  linhaDoCodigo: { id: "c-1", used_at: null } as { id: string; used_at: string | null } | null,
  linhasQueimadas: [{ id: "c-1" }] as Array<{ id: string }>,
}));

vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((destino: string) => {
    throw new Error(`REDIRECT:${destino}`);
  }),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
// O portão de papel é simulado só no que a rota escolhe: o papel pedido contra o do usuário.
// O que se prova é QUAL papel cada rota exige, e que quem não alcança nem chega ao WAHA.
vi.mock("@/lib/auth/require-role", () => {
  const rank = { viewer: 1, agent: 2, manager: 3, admin: 4 } as const;
  return {
    requireRole: vi.fn(async (min: keyof typeof rank) =>
      rank[h.papelDoUsuario] >= rank[min]
        ? { ok: true, user: { id: "u-1", idioma: "pt-BR" }, org: { orgId: "o-1" } }
        : { ok: false, response: new Response(JSON.stringify({ error: "forbidden_role" }), { status: 403 }) },
    ),
  };
});
vi.mock("@/lib/channels/onboarding-session", () => ({
  loadOnboardingChannel: vi.fn(async () => ({ waha_session_name: "sessao-1", archived_at: null })),
}));
vi.mock("@/lib/auth/politica-de-cadastro", () => ({ modoDeCadastro: vi.fn(async () => "aberto") }));
vi.mock("@/lib/audit", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  audit: vi.fn(async () => undefined),
  isServiceRoleConfigured: vi.fn(() => true),
}));
vi.mock("@/lib/auth/aviso-de-codigos-de-recuperacao", () => ({
  avisarSobreCodigosDeRecuperacao: vi.fn(async () => undefined),
}));
vi.mock("@/lib/auth/rate-limit", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  authRateLimited: h.limitado,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({
    auth: {
      admin: {
        listUsers: h.listUsers,
        mfa: { listFactors: h.listFactors, deleteFactor: h.deleteFactor },
      },
    },
    from: (tabela: string) => ({
      select: () => {
        const c: Record<string, unknown> = {};
        for (const m of ["eq", "is", "limit"]) c[m] = () => c;
        c.maybeSingle = async () => ({ data: h.linhaDoCodigo, error: null });
        return c;
      },
      update: () => {
        const registro = { tabela, filtros: [] as Array<[string, string, unknown]> };
        h.atualizacoes.push(registro);
        const c: Record<string, unknown> = {};
        c.eq = (col: string, v: unknown) => (registro.filtros.push(["eq", col, v]), c);
        c.is = (col: string, v: unknown) => (registro.filtros.push(["is", col, v]), c);
        c.select = async () => ({ data: h.linhasQueimadas, error: null });
        return c;
      },
      delete: () => ({ eq: async () => ({ error: null }) }),
    }),
  })),
}));

const APP_URL = "https://crm.exemplo.test";

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_APP_URL", APP_URL);
  h.papelDoUsuario = "viewer";
  h.linhasDaAuditoria = [];
  h.listUsers.mockReset();
  h.listFactors.mockReset().mockResolvedValue({ data: { factors: [] } });
  h.limitado.mockReset().mockResolvedValue(false);
  h.atualizacoes.length = 0;
  h.linhaDoCodigo = { id: "c-1", used_at: null };
  h.linhasQueimadas = [{ id: "c-1" }];
  vi.mocked(headers).mockResolvedValue({
    get: (k: string) =>
      k === "origin" ? "https://atacante.example" : k === "x-forwarded-for" ? "198.51.100.7" : null,
  } as never);
  vi.mocked(modoDeCadastro).mockResolvedValue("aberto");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("D-126: links de e-mail usam a URL configurada, não o cabeçalho Origin", () => {
  it("redefinição de senha: redirectTo vem de NEXT_PUBLIC_APP_URL mesmo com Origin de outro domínio", async () => {
    const reset = vi.fn(async () => ({ error: null }));
    vi.mocked(createClient).mockResolvedValue({ auth: { resetPasswordForEmail: reset } } as never);
    const { requestPasswordReset } = await import("@/app/actions/auth/requestPasswordReset");
    const r = await requestPasswordReset({ email: `reset-${Date.now()}@exemplo.test` });
    expect(r).toEqual({ ok: true });
    const opcoes = (reset.mock.calls[0] as unknown as [string, { redirectTo: string }])[1];
    expect(opcoes.redirectTo).toBe(`${APP_URL}/auth/confirm?type=recovery`);
    expect(opcoes.redirectTo).not.toContain("atacante");
  });

  it("cadastro: emailRedirectTo vem de NEXT_PUBLIC_APP_URL mesmo com Origin de outro domínio", async () => {
    const signUpDoProvedor = vi.fn(async () => ({
      data: { user: { id: "u-1" }, session: null },
      error: null,
    }));
    vi.mocked(createClient).mockResolvedValue({ auth: { signUp: signUpDoProvedor } } as never);
    const { signUp } = await import("@/app/actions/auth/signUp");
    const res = await signUp({
      org_name: "Clinica Lote7",
      email: `cadastro-${Date.now()}@exemplo.test`,
      password: "SenhaForte!2026",
      password_confirm: "SenhaForte!2026",
    });
    expect(res).toEqual({ ok: true, sessao_ativa: false });
    const opcoes = (signUpDoProvedor.mock.calls[0] as unknown as [{ options: { emailRedirectTo: string } }])[0].options;
    expect(opcoes.emailRedirectTo).toBe(`${APP_URL}/auth/confirm?type=signup`);
  });
});

describe("D-126: segredo do convite vazio ou curto não vira chave de HMAC", () => {
  const payload = () => ({
    invite_id: "11111111-1111-4111-8111-111111111111",
    email: "alice@example.com",
    organization_id: "22222222-2222-4222-8222-222222222222",
    role: "agent",
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  const LONGO = "a".repeat(40);

  it("INVITE_TOKEN_SECRET vazio cai no INTERNAL_SECRET (|| e não ??): token assinado com chave vazia não passa", async () => {
    vi.stubEnv("INVITE_TOKEN_SECRET", "");
    vi.stubEnv("INTERNAL_SECRET", LONGO);
    const { signInviteToken, verifyInviteToken } = await import("@/lib/auth/invite-token");
    const [corpo] = signInviteToken(payload()).split(".");
    const { createHmac } = await import("node:crypto");
    const forjado = `${corpo}.${createHmac("sha256", "").update(corpo!).digest("base64url")}`;
    expect(verifyInviteToken(forjado)).toBeNull();
    expect(verifyInviteToken(signInviteToken(payload()))).not.toBeNull();
  });

  it("em produção, segredo ausente, vazio ou com menos de 32 caracteres não assina nem verifica", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { signInviteToken, verifyInviteToken } = await import("@/lib/auth/invite-token");
    for (const [a, b] of [["", ""], ["curto", ""], ["", "x".repeat(31)]] as const) {
      vi.stubEnv("INVITE_TOKEN_SECRET", a);
      vi.stubEnv("INTERNAL_SECRET", b);
      expect(() => signInviteToken(payload())).toThrow(/invite_token_secret/);
      expect(verifyInviteToken("abc.def")).toBeNull();
    }
  });

  it("em produção, segredo com 32+ caracteres assina e verifica (controle)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("INVITE_TOKEN_SECRET", "");
    vi.stubEnv("INTERNAL_SECRET", "x".repeat(32));
    const { signInviteToken, verifyInviteToken } = await import("@/lib/auth/invite-token");
    expect(verifyInviteToken(signInviteToken(payload()))?.invite_id).toBe(payload().invite_id);
  });
});

describe("D-126: código de recuperação", () => {
  const entrada = { email: "dono@exemplo.test", code: "ABCD1234" };
  const usuario = (n: number, email: string) => ({ id: `u-${n}`, email });
  const pagina = (de: number, qtd: number) =>
    Array.from({ length: qtd }, (_, i) => usuario(de + i, `pessoa${de + i}@exemplo.test`));

  it("acha a conta que está depois dos primeiros 200 usuários", async () => {
    h.listUsers
      .mockResolvedValueOnce({ data: { users: pagina(0, 200) }, error: null })
      .mockResolvedValueOnce({ data: { users: [...pagina(200, 5), usuario(999, "dono@exemplo.test")] }, error: null });
    const { useRecoveryCode } = await import("@/app/actions/auth/useRecoveryCode");
    await expect(useRecoveryCode(entrada)).rejects.toThrow(/REDIRECT:\/login\?recovery_used=1/);
    expect(h.listUsers).toHaveBeenCalledTimes(2);
  });

  it("e-mail que não existe termina na página vazia, com a resposta genérica", async () => {
    h.listUsers
      .mockResolvedValueOnce({ data: { users: pagina(0, 3) }, error: null })
      .mockResolvedValueOnce({ data: { users: [] }, error: null });
    const { useRecoveryCode } = await import("@/app/actions/auth/useRecoveryCode");
    await expect(useRecoveryCode(entrada)).resolves.toEqual({ ok: false, error: "invalid_or_used" });
  });

  it("teto de tentativas: estourado, nem consulta o diretório de contas", async () => {
    h.limitado.mockResolvedValue(true);
    const { useRecoveryCode } = await import("@/app/actions/auth/useRecoveryCode");
    await expect(useRecoveryCode(entrada)).resolves.toEqual({ ok: false, error: "invalid_or_used" });
    expect(h.listUsers).not.toHaveBeenCalled();
    expect(h.limitado).toHaveBeenCalledWith("recovery_code", "dono@exemplo.test", expect.objectContaining({ ip: expect.any(Number) }));
  });

  it("queimar o código só vale com used_at ainda nulo: perdeu a corrida, não segue", async () => {
    h.listUsers.mockResolvedValue({ data: { users: [usuario(1, "dono@exemplo.test")] }, error: null });
    h.linhasQueimadas = [];
    const { useRecoveryCode } = await import("@/app/actions/auth/useRecoveryCode");
    await expect(useRecoveryCode(entrada)).resolves.toEqual({ ok: false, error: "invalid_or_used" });
    const upd = h.atualizacoes.find((a) => a.tabela === "user_recovery_codes");
    expect(upd?.filtros).toContainEqual(["is", "used_at", null]);
    expect(h.listFactors).not.toHaveBeenCalled();
  });
});

describe("D-120: QR de pareamento do WhatsApp só para admin", () => {
  const upstream = () => new Response("png", { status: 200, headers: { "content-type": "image/png" } });
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubEnv("WAHA_API_BASE_URL", "http://waha.interno");
    vi.stubEnv("WAHA_API_KEY", "chave-de-teste-do-waha");
    fetchSpy = vi.fn(async () => upstream());
    vi.stubGlobal("fetch", fetchSpy);
    vi.mocked(createClient).mockResolvedValue({
      from: () => {
        const c: Record<string, unknown> = {};
        for (const m of ["select", "eq"]) c[m] = () => c;
        c.maybeSingle = async () => ({ data: { waha_session_name: "sessao-1", archived_at: null }, error: null });
        return c;
      },
    } as never);
  });
  afterEach(() => vi.unstubAllGlobals());

  const chamadas = [
    {
      nome: "canal por id",
      chamar: async () => {
        const { GET } = await import("@/app/api/v1/channel-sessions/[id]/qr/route");
        return GET(new Request("http://x/qr"), { params: Promise.resolve({ id: "c-1" }) });
      },
    },
    {
      nome: "onboarding",
      chamar: async () => {
        const { GET } = await import("@/app/api/v1/onboarding/whatsapp/qr/route");
        return GET();
      },
    },
  ];

  for (const { nome, chamar } of chamadas) {
    for (const papel of ["viewer", "agent", "manager"] as const) {
      it(`${nome}: ${papel} recebe 403 e o WAHA nem é chamado`, async () => {
        h.papelDoUsuario = papel;
        const r = await chamar();
        expect(r.status).toBe(403);
        expect(fetchSpy).not.toHaveBeenCalled();
      });
    }
    it(`${nome}: admin recebe a imagem (controle)`, async () => {
      h.papelDoUsuario = "admin";
      const r = await chamar();
      expect(r.status).toBe(200);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  }

  it("as duas rotas pedem admin com o atalho do admin de plataforma, como o pairing-code", async () => {
    const { requireRole } = await import("@/lib/auth/require-role");
    vi.mocked(requireRole).mockClear();
    h.papelDoUsuario = "admin";
    for (const { chamar } of chamadas) await chamar();
    const pedidos = vi.mocked(requireRole).mock.calls.map((c) => [c[0], c[1]?.allowPlatformAdmin]);
    expect(pedidos).toEqual([
      ["admin", true],
      ["admin", true],
    ]);
  });
});

describe("D-107: CSV da auditoria sem injeção de fórmula", () => {
  it("célula que começa com = + - @ tab ou CR leva apóstrofo na frente", async () => {
    const { csvEscape } = await import("@/lib/audit/csv");
    for (const perigoso of ['=HYPERLINK("http://x","clique")', "+1+1", "-2+3", "@SUM(A1)", "\tcmd", "\rcmd"]) {
      const saida = csvEscape(perigoso);
      expect(saida.replace(/^"/, "").startsWith("'")).toBe(true);
    }
  });

  it("texto comum, UUID, data e vazio ficam como estavam (controle)", async () => {
    const { csvEscape } = await import("@/lib/audit/csv");
    expect(csvEscape("2026-09-30T10:00:00Z")).toBe("2026-09-30T10:00:00Z");
    expect(csvEscape("0f8f4c3e-1111-4222-8333-444455556666")).toBe("0f8f4c3e-1111-4222-8333-444455556666");
    expect(csvEscape(null)).toBe("");
    expect(csvEscape("a,b")).toBe('"a,b"');
    expect(csvEscape({ k: "=x" })).toBe('"{""k"":""=x""}"');
  });

  it("a exportação sai com no-store e sem fórmula viva no request_id gravado", async () => {
    h.papelDoUsuario = "manager";
    h.linhasDaAuditoria = [
      {
        id: "a-1",
        created_at: "2026-09-30T10:00:00Z",
        actor_user_id: "u-1",
        action: "agenda.tipo.created",
        resource_type: "agenda_tipo",
        resource_id: "t-1",
        request_id: '=HYPERLINK("http://atacante.example","x")',
        actor_ip: "198.51.100.1",
        metadata: {},
      },
    ];
    vi.mocked(createClient).mockResolvedValue({
      from: () => {
        const c: Record<string, unknown> = {};
        for (const m of ["select", "eq", "order", "limit", "ilike", "gte", "lte"]) c[m] = () => c;
        c.then = (resolve: (v: unknown) => unknown) => resolve({ data: h.linhasDaAuditoria, error: null });
        return c;
      },
    } as never);
    const { GET } = await import("@/app/api/v1/audit/export/route");
    const { NextRequest } = await import("next/server");
    const r = await GET(new NextRequest("http://x/api/v1/audit/export"));
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store, private");
    const corpo = await r.text();
    expect(corpo).toContain(`"'=HYPERLINK(""http://atacante.example"",""x"")"`);
    expect(corpo.split("\n")[1]).not.toMatch(/,=HYPERLINK|,"=HYPERLINK/);
  });

  it("proxy: x-request-id que não é UUID é trocado por um novo, e o id sanitizado vai para a requisição", async () => {
    const { proxy } = await import("@/proxy");
    const { NextRequest } = await import("next/server");
    const r = await proxy(new NextRequest("http://x/login", { headers: { "x-request-id": '=cmd|" /C calc"!A0' } }));
    const id = r.headers.get("x-request-id");
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(r.headers.get("x-middleware-request-x-request-id")).toBe(id);
  });

  it("proxy: x-request-id em UUID é mantido (controle)", async () => {
    const { proxy } = await import("@/proxy");
    const { NextRequest } = await import("next/server");
    const dado = "0f8f4c3e-1111-4222-8333-444455556666";
    const r = await proxy(new NextRequest("http://x/login", { headers: { "x-request-id": dado } }));
    expect(r.headers.get("x-request-id")).toBe(dado);
    expect(r.headers.get("x-middleware-request-x-request-id")).toBe(dado);
  });
});

