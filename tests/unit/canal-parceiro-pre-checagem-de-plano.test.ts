/**
 * Defeito achado na sessão principal (F3): `POST /api/v1/channels/partner`
 * chamava `podeCriar` direto, sem perguntar antes se o bloqueio VALE para a
 * organização. No modo `avisar` de hoje (o único em produção) o bloqueio
 * nunca vale, e a pré-checagem recusava uma conexão que o modo atual deixa
 * passar.
 *
 * Prova, contra o Route Handler REAL (auth, `lib/channels/connect` e
 * `podeCriar` mockados; `bloqueioValeParaOrganizacao` REAL, com o client
 * admin dublado): os três casos a seguir.
 *
 *  1. bloqueio NÃO vale (modo != 'bloquear'): `podeCriar` nem é chamado, a
 *     conexão segue;
 *  2. bloqueio VALE e `podeCriar` diz `teto_atingido`: 402 `plano_limite_atingido`;
 *  3. leitura de `billing_settings` falha: fail-open, mesmo efeito do caso 1,
 *     nunca um 500 nem uma recusa por acidente.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { ROLE_RANK, type AuthUser, type Role } from "@/lib/auth/types";
import { fail } from "@/lib/api/wrappers";
import { createAdminClient } from "@/lib/supabase/admin";
import { podeCriar } from "@/lib/billing/planos/pode-criar";
import {
  findPartnerSession,
  savePartnerSession,
  validatePartnerCredentials,
} from "@/lib/channels/connect";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/billing/planos/pode-criar", () => ({ podeCriar: vi.fn() }));
vi.mock("@/lib/channels/connect", () => ({
  PARTNER_CHANNEL_LABEL: "Zernio",
  findPartnerSession: vi.fn(),
  partnerEndpoint: () => "https://partner.example",
  savePartnerSession: vi.fn(),
  validatePartnerCredentials: vi.fn(),
}));
vi.mock("@/lib/webhooks/secrets", () => ({
  encryptWebhookSecret: vi.fn(async () => "cifrado"),
  decryptWebhookSecret: vi.fn(),
}));

import { POST } from "@/app/api/v1/channels/partner/route";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";

/** Client admin dublado, só responde o que `bloqueioValeParaOrganizacao` lê. */
function adminStub(opts: {
  modo: string | null;
  bloqueioAPartirDe?: string | null;
  falhaSettings?: boolean;
}) {
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
  vi.mocked(requireSupportWrite).mockResolvedValue(null);
  vi.mocked(requireRole).mockImplementation(async (min: Role) =>
    ROLE_RANK["admin"] >= ROLE_RANK[min]
      ? { ok: true, user, org: { orgId: ORG_ID, name: "Org", role: "admin" } }
      : { ok: false, response: fail("forbidden_role", `Requer role >= ${min}.`, 403, {}) },
  );
}

function pedido() {
  return new NextRequest("http://local/api/v1/channels/partner", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ account_id: "conta-123", api_key: "chave-bem-comprida-o-bastante" }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  sessao();
  vi.mocked(findPartnerSession).mockResolvedValue(null); // sessão nova: conta contra o teto
  vi.mocked(validatePartnerCredentials).mockResolvedValue({
    ok: true,
    phoneNumber: "5511999990000",
    displayName: "Empresa",
    qualityRating: "GREEN",
  });
  vi.mocked(savePartnerSession).mockResolvedValue({ error: null, errorRaw: null } as never);
});

describe("POST /api/v1/channels/partner: pré-checagem de plano (F3)", () => {
  it("bloqueio NÃO vale (modo avisar): podeCriar nem é chamado, conexão segue", async () => {
    vi.mocked(createAdminClient).mockReturnValue(adminStub({ modo: "avisar" }) as never);

    const res = await POST(pedido());

    expect(vi.mocked(podeCriar)).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
  });

  it("bloqueio VALE (modo bloquear, carência vencida) e o teto foi atingido: 402 plano_limite_atingido", async () => {
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
    expect(vi.mocked(validatePartnerCredentials)).not.toHaveBeenCalled();
  });

  it("bloqueio VALE mas ainda cabe no teto: segue normal", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      adminStub({ modo: "bloquear", bloqueioAPartirDe: "2020-01-01T00:00:00.000Z" }) as never,
    );
    vi.mocked(podeCriar).mockResolvedValue({
      pode: true,
      motivo: "ok",
      atual: 1,
      teto: 3,
      leituraFalhou: false,
    });

    const res = await POST(pedido());

    expect(res.status).toBe(200);
  });

  it("bloqueio VALE mas a carência ainda não venceu (data no futuro): podeCriar nem é chamado", async () => {
    const futuro = new Date(Date.now() + 86_400_000).toISOString();
    vi.mocked(createAdminClient).mockReturnValue(
      adminStub({ modo: "bloquear", bloqueioAPartirDe: futuro }) as never,
    );

    const res = await POST(pedido());

    expect(vi.mocked(podeCriar)).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
  });

  it("leitura de billing_settings falha: fail-open, nunca 500 nem recusa por acidente", async () => {
    vi.mocked(createAdminClient).mockReturnValue(adminStub({ modo: "bloquear", falhaSettings: true }) as never);

    const res = await POST(pedido());

    expect(vi.mocked(podeCriar)).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
  });
});
