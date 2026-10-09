/**
 * D-188 (migration 0954): o limite de Conexões do plano bloqueia em qualquer `billing_settings.modo`, então a
 * pré-checagem de `POST /api/v1/channels/partner` deixou de ter o portão de modo/carência que existia na F3: ela pergunta direto
 * "cabe mais uma?" (`podeCriar`, mockado) e, quando não cabe, devolve 402 `plano_limite_atingido` com a frase
 * "Sua conta atingiu o limite de {n} conexões do plano {plano}..." montada com o plano real (lido do dublê do
 * client admin, sem mock do nosso código). Route Handler REAL; auth, provedor e gravação dublados.
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

/**
 * Client admin dublado. D-188: a pré-checagem de Conexões NÃO lê `billing_settings` nem a carência (bloqueia em
 * qualquer modo); só lê o plano (nome e limite) para montar a frase de recusa.
 */
function adminStub(opts: { limiteConexoes?: number | null; planoNome?: string } = {}) {
  const lerTabela = vi.fn((tabela: string) => {
    if (tabela === "billing_settings") throw new Error("a pré-checagem de Conexões não pode ler o modo");
    if (tabela === "billing_contracts") {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: {
                status: "ativa",
                cycle: "monthly",
                billing_plans: { code: "pro", name: opts.planoNome ?? "Pro", version: 1 },
              },
              error: null,
            }),
          }),
        }),
      };
    }
    throw new Error(`tabela inesperada no dublê: ${tabela}`);
  });
  return {
    lerTabela,
    from: lerTabela,
    rpc: async (nome: string) => {
      if (nome !== "fn_billing_limites_efetivos") throw new Error(`rpc inesperada: ${nome}`);
      return {
        data: {
          funis: 5,
          etapas_por_funil: 10,
          leads: 5000,
          membros: 3,
          conexoes: opts.limiteConexoes === undefined ? 3 : opts.limiteConexoes,
          integracoes_webhook: 3,
          tokens_ia_mes: 3_000_000,
        },
        error: null,
      };
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

describe("POST /api/v1/channels/partner: pré-checagem de Conexões (D-188, bloqueia em qualquer modo)", () => {
  it("o teto foi atingido: 402 plano_limite_atingido com o limite e o plano, SEM ler o modo", async () => {
    const admin = adminStub({ limiteConexoes: 3, planoNome: "Pro" });
    vi.mocked(createAdminClient).mockReturnValue(admin as never);
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
    const corpo = (await res.json()) as { error?: { code?: string; message?: string } };
    expect(corpo.error?.code).toBe("plano_limite_atingido");
    expect(corpo.error?.message).toBe(
      "Sua conta atingiu o limite de 3 conexões do plano Pro. Remova uma conexão ou mude de plano.",
    );
    expect(vi.mocked(validatePartnerCredentials)).not.toHaveBeenCalled();
    expect(admin.lerTabela).not.toHaveBeenCalledWith("billing_settings");
  });

  it("ainda cabe no teto: segue normal", async () => {
    vi.mocked(createAdminClient).mockReturnValue(adminStub() as never);
    vi.mocked(podeCriar).mockResolvedValue({ pode: true, motivo: "ok", atual: 1, teto: 3, leituraFalhou: false });

    const res = await POST(pedido());

    expect(res.status).toBe(200);
  });

  it("leitura do teto falhou: fail-open, nunca 500 nem recusa por acidente", async () => {
    vi.mocked(createAdminClient).mockReturnValue(adminStub() as never);
    vi.mocked(podeCriar).mockResolvedValue({
      pode: true,
      motivo: "leitura_falhou",
      atual: null,
      teto: null,
      leituraFalhou: true,
    });

    const res = await POST(pedido());

    expect(res.status).toBe(200);
  });

  it("conexão que já está ativa (só editar a credencial) não conta contra o teto: podeCriar nem é chamado", async () => {
    vi.mocked(createAdminClient).mockReturnValue(adminStub() as never);
    vi.mocked(findPartnerSession).mockResolvedValue({ id: "sess-1", archivedAt: null } as never);

    const res = await POST(pedido());

    expect(vi.mocked(podeCriar)).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
  });
});
