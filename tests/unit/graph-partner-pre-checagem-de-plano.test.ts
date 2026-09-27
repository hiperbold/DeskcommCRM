/**
 * `POST /api/v1/channels/graph-partner` criava lead sem a trava do plano na
 * aplicação: nem a pré-checagem (`podeCriar`/`bloqueioValeParaOrganizacao`,
 * como `channels/partner`) nem a rede de segurança (`saveGraphPartnerSession`
 * reduzia o erro a `error?.message`, perdendo o `code` do PT402, a rota caía
 * sempre em 500 `internal_error`). Molde de
 * `canal-parceiro-pre-checagem-de-plano.test.ts` (a mesma família, canal
 * `partner`), aqui contra o Route Handler REAL do `graph-partner`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import type { AuthUser, Role } from "@/lib/auth/types";
import { createAdminClient } from "@/lib/supabase/admin";
import { podeCriar } from "@/lib/billing/planos/pode-criar";
import {
  findGraphPartnerSession,
  saveGraphPartnerSession,
} from "@/lib/channels/graph-parceiro/session";
import { validateGraphPartnerCredentials } from "@/lib/channels/graph-parceiro/validate-credentials";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/billing/planos/pode-criar", () => ({ podeCriar: vi.fn() }));
vi.mock("@/lib/channels/graph-parceiro/credentials", () => ({
  canalGraphParceiroLigado: () => true,
  GRAPH_PARTNER_LABEL: "Parceiro",
}));
vi.mock("@/lib/channels/graph-parceiro/session", () => ({
  findGraphPartnerSession: vi.fn(),
  saveGraphPartnerSession: vi.fn(),
  saveGraphPartnerSigningSecret: vi.fn(),
}));
vi.mock("@/lib/channels/graph-parceiro/validate-credentials", () => ({
  validateGraphPartnerCredentials: vi.fn(),
}));
vi.mock("@/lib/webhooks/secrets", () => ({
  encryptWebhookSecret: vi.fn(async (_admin: unknown, v: string) => `enc(${v})`),
  decryptWebhookSecret: vi.fn(),
}));

import { POST } from "@/app/api/v1/channels/graph-partner/route";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";

/** Client admin dublado, só responde o que `bloqueioValeParaOrganizacao` lê. */
function adminStub(opts: { modo: string | null; bloqueioAPartirDe?: string | null; falhaSettings?: boolean }) {
  return {
    from: (tabela: string) => {
      if (tabela === "billing_settings") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () =>
                opts.falhaSettings
                  ? { data: null, error: { message: "conexão recusada" } }
                  : { data: { modo: opts.modo }, error: null },
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
      throw new Error(`tabela inesperada no dublê: ${tabela}`);
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
  vi.mocked(requireRole).mockImplementation(async () => ({
    ok: true,
    user,
    org: { orgId: ORG_ID, name: "Org", role: "admin" as Role },
  }));
}

function pedido() {
  return new NextRequest("http://local/api/v1/channels/graph-partner", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "x".repeat(30) }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  sessao();
  vi.mocked(findGraphPartnerSession).mockResolvedValue(null); // sessão nova: conta contra o teto
  vi.mocked(validateGraphPartnerCredentials).mockResolvedValue({
    ok: true,
    phoneNumberId: "PN",
    wabaId: "WABA",
    displayPhoneNumber: "5531999990000",
    verifiedName: "Loja",
  } as never);
  vi.mocked(saveGraphPartnerSession).mockResolvedValue({
    error: null,
    errorRaw: null,
    channelSessionId: "sess-1",
  } as never);
});

describe("POST /api/v1/channels/graph-partner: pré-checagem de plano (F3)", () => {
  it("bloqueio NÃO vale (modo avisar): podeCriar nem é chamado, conexão segue", async () => {
    vi.mocked(createAdminClient).mockReturnValue(adminStub({ modo: "avisar" }) as never);

    const res = await POST(pedido());

    expect(vi.mocked(podeCriar)).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
  });

  it("bloqueio VALE e o teto foi atingido: 402 plano_limite_atingido, sem chamar o provedor", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      adminStub({ modo: "bloquear", bloqueioAPartirDe: "2020-01-01T00:00:00.000Z" }) as never,
    );
    vi.mocked(podeCriar).mockResolvedValue({
      pode: false,
      motivo: "teto_atingido",
      atual: 3,
      teto: 3,
      leituraFalhou: false,
    });

    const res = await POST(pedido());

    expect(vi.mocked(podeCriar)).toHaveBeenCalledWith(expect.anything(), ORG_ID, "conexoes");
    expect(res.status).toBe(402);
    const corpo = (await res.json()) as { error?: { code?: string } };
    expect(corpo.error?.code).toBe("plano_limite_atingido");
    expect(vi.mocked(validateGraphPartnerCredentials)).not.toHaveBeenCalled();
  });

  it("bloqueio VALE mas ainda cabe no teto: segue normal", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      adminStub({ modo: "bloquear", bloqueioAPartirDe: "2020-01-01T00:00:00.000Z" }) as never,
    );
    vi.mocked(podeCriar).mockResolvedValue({ pode: true, motivo: "ok", atual: 1, teto: 3, leituraFalhou: false });

    const res = await POST(pedido());

    expect(res.status).toBe(200);
  });

  it("leitura de billing_settings falha: fail-open, nunca 500 nem recusa por acidente", async () => {
    vi.mocked(createAdminClient).mockReturnValue(adminStub({ modo: "bloquear", falhaSettings: true }) as never);

    const res = await POST(pedido());

    expect(vi.mocked(podeCriar)).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
  });

  it("o gatilho do banco recusa com PT402: rede de segurança devolve 402, nunca 500", async () => {
    // Sessão já ativa: a pré-checagem nem entra (mesma régua de `channels/partner`),
    // e é o gatilho do banco quem recusa no INSERT/UPDATE, o caso que
    // `saveGraphPartnerSession` perdia ao reduzir o erro a `.message`.
    vi.mocked(createAdminClient).mockReturnValue(adminStub({ modo: "avisar" }) as never);
    vi.mocked(saveGraphPartnerSession).mockResolvedValue({
      error: "Limite do plano atingido",
      errorRaw: { code: "PT402", details: "conexoes" },
      channelSessionId: null,
    } as never);

    const res = await POST(pedido());

    expect(res.status).toBe(402);
    const corpo = (await res.json()) as { error?: { code?: string } };
    expect(corpo.error?.code).toBe("plano_limite_atingido");
  });
});
