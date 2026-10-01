/**
 * D-119 (lote 7 da auditoria): o retorno do OAuth do Google Ads amarra o `state` ao navegador
 * que iniciou o fluxo (cookie de vínculo) e queima o nonce (uso único); o vizinho da Nuvemshop
 * recusa state sem ator e também queima o nonce.
 *
 *     npx vitest run tests/unit/lote7-oauth-ads-e-nuvemshop.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const ORG = "33333333-3333-4333-8333-333333333333";
const USUARIO = "11111111-1111-4111-8111-111111111111";
const SEGREDO = "segredo-de-teste-com-mais-de-trinta-e-dois-caracteres";
const CAMINHO = "/api/v1/plataformas-de-anuncio/google/callback";

const h = vi.hoisted(() => ({
  nonceJaUsado: false,
  nonces: [] as string[],
  upserts: [] as unknown[],
  estadoEmitido: "" as string,
}));

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/impersonate/support", () => ({
  requireSupportWrite: vi.fn(async () => null),
  supportCallbackWriteAllowed: vi.fn(async () => true),
}));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(async () => ({
    ok: true,
    user: { id: USUARIO, email: "admin@exemplo.test" },
    org: { orgId: ORG },
  })),
}));
vi.mock("@/lib/plataformas-de-anuncio/google/config", () => ({
  configuracaoDoGoogleAds: vi.fn(() => ({ clientId: "cid", clientSecret: "cs", redirectUri: "http://x/cb" })),
}));
vi.mock("@/lib/plataformas-de-anuncio/google/oauth", () => ({
  montarUrlDeConsentimento: vi.fn((_app: unknown, o: { state: string }) => {
    h.estadoEmitido = o.state;
    return new URL(`https://accounts.google.test/consent?state=${o.state}`);
  }),
}));
const trocarCodigo = vi.hoisted(() => vi.fn());
vi.mock("@/lib/plataformas-de-anuncio/google/token", () => ({ trocarCodigoPorToken: trocarCodigo }));
vi.mock("@/lib/webhooks/secrets", () => ({ encryptWebhookSecret: vi.fn(async () => "cifrado") }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({
    from: (tabela: string) => ({
      insert: async (linha: { nonce: string }) => {
        if (tabela !== "calendar_oauth_nonces") return { error: null };
        if (h.nonceJaUsado || h.nonces.includes(linha.nonce)) return { error: { code: "23505" } };
        h.nonces.push(linha.nonce);
        return { error: null };
      },
      upsert: async (linha: unknown) => {
        h.upserts.push(linha);
        return { error: null };
      },
    }),
  })),
}));

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("INTERNAL_SECRET", SEGREDO);
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://crm.exemplo.test");
  h.nonceJaUsado = false;
  h.nonces = [];
  h.upserts = [];
  h.estadoEmitido = "";
  trocarCodigo.mockReset().mockResolvedValue({ ok: true, token: { refresh_token: "refresh-do-admin" } });
});
afterEach(() => vi.unstubAllEnvs());

/** Roda o `connect` e devolve o state emitido e o valor do cookie de vínculo. */
async function iniciar() {
  const { GET } = await import("@/app/api/v1/plataformas-de-anuncio/google/connect/route");
  const r = await GET(new NextRequest("https://crm.exemplo.test/api/v1/plataformas-de-anuncio/google/connect?api=google_ads"));
  const cookie = r.cookies.get("crm_oauth_bind");
  return { resposta: r, state: h.estadoEmitido, cookie };
}

async function voltar(state: string, cookie?: string) {
  const { GET } = await import("@/app/api/v1/plataformas-de-anuncio/google/callback/route");
  const req = new NextRequest(`https://crm.exemplo.test${CAMINHO}?state=${encodeURIComponent(state)}&code=codigo-do-google`, {
    headers: cookie ? { cookie: `crm_oauth_bind=${cookie}` } : {},
  });
  return GET(req);
}

const destino = (r: Response) => new URL(r.headers.get("location") ?? "");

describe("D-119: Google Ads, o retorno só vale no navegador que iniciou", () => {
  it("connect põe o cookie de vínculo: httpOnly, Lax e preso ao caminho do callback", async () => {
    const { cookie, resposta } = await iniciar();
    expect(cookie?.value).toBeTruthy();
    const setCookie = resposta.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=lax/i);
    expect(setCookie).toContain(`Path=${CAMINHO}`);
  });

  it("o navegador que iniciou volta e conecta (controle)", async () => {
    const { state, cookie } = await iniciar();
    const r = await voltar(state, cookie?.value);
    expect(destino(r).searchParams.get("ok")).toBe("1");
    expect(h.upserts).toHaveLength(1);
    expect(h.nonces).toHaveLength(1);
  });

  it("outro navegador, sem o cookie, com o state capturado: recusado, o código do Google não é gasto e nada é gravado", async () => {
    const { state } = await iniciar();
    const r = await voltar(state, undefined);
    expect(destino(r).searchParams.get("erro")).toBe("estado_invalido");
    expect(trocarCodigo).not.toHaveBeenCalled();
    expect(h.upserts).toHaveLength(0);
    expect(h.nonces).toHaveLength(0);
  });

  it("cookie de outro fluxo (nonce diferente) também é recusado", async () => {
    const primeiro = await iniciar();
    const segundo = await iniciar();
    const r = await voltar(primeiro.state, segundo.cookie?.value);
    expect(destino(r).searchParams.get("erro")).toBe("estado_invalido");
    expect(h.upserts).toHaveLength(0);
  });

  it("uso único: o mesmo state apresentado de novo com o cookie certo é recusado", async () => {
    const { state, cookie } = await iniciar();
    const primeira = await voltar(state, cookie?.value);
    expect(destino(primeira).searchParams.get("ok")).toBe("1");
    trocarCodigo.mockClear();
    const replay = await voltar(state, cookie?.value);
    expect(destino(replay).searchParams.get("erro")).toBe("estado_invalido");
    expect(trocarCodigo).not.toHaveBeenCalled();
    expect(h.upserts).toHaveLength(1);
  });

  it("toda saída limpa o cookie de vínculo", async () => {
    const { state, cookie } = await iniciar();
    for (const r of [await voltar(state, undefined), await voltar(state, cookie?.value)]) {
      const apagado = r.cookies.get("crm_oauth_bind");
      expect(apagado?.value).toBe("");
      expect(r.headers.get("set-cookie") ?? "").toMatch(/Max-Age=0/i);
    }
  });
});

describe("D-119 vizinho: Nuvemshop recusa state sem ator e queima o nonce", () => {
  const CHAMADA = "https://crm.exemplo.test/api/v1/integrations/nuvemshop/callback";

  beforeEach(() => {
    vi.doMock("@/lib/nuvemshop/config", () => ({
      getConfig: () => ({ appId: "app", clientSecret: "segredo" }),
      SUBSCRIBED_EVENTS: [],
      eventToSlug: (e: string) => e,
    }));
    vi.doMock("@/lib/nuvemshop/oauth", () => ({
      exchangeCodeForToken: vi.fn(async () => ({ ok: false, error: "token_exchange_failed", status: 400 })),
    }));
    vi.doMock("@/lib/nuvemshop/api-client", () => ({ NuvemshopApiClient: class {} }));
  });

  const chamar = async (state: string) => {
    const { GET } = await import("@/app/api/v1/integrations/nuvemshop/callback/route");
    return GET(new NextRequest(`${CHAMADA}?code=c&state=${encodeURIComponent(state)}`));
  };

  it("state de 3 segmentos (sem ator) é recusado antes de qualquer coisa", async () => {
    const { createHmac } = await import("node:crypto");
    const payload = `${ORG}.nonce-sem-ator.${Date.now() + 60_000}`;
    const sig = createHmac("sha256", SEGREDO).update(payload, "utf8").digest("hex");
    const r = await chamar(`${Buffer.from(payload).toString("base64url")}.${sig}`);
    expect(destino(r).searchParams.get("error")).toBe("invalid_state");
    expect(h.nonces).toHaveLength(0);
  });

  it("state com ator vale uma vez só: o segundo uso é recusado como state inválido", async () => {
    const { issueState } = await import("@/lib/nuvemshop/state");
    const state = issueState(ORG, { userId: USUARIO, authSessionId: "sessao-1" });
    const primeira = await chamar(state);
    expect(destino(primeira).searchParams.get("error")).toBe("token_exchange_failed");
    expect(h.nonces).toHaveLength(1);
    const replay = await chamar(state);
    expect(destino(replay).searchParams.get("error")).toBe("invalid_state");
  });
});
