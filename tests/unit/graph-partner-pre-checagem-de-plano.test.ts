/**
 * D-188 (migration 0954): o limite de Conexões do plano bloqueia em qualquer `billing_settings.modo`, então a
 * pré-checagem de `POST /api/v1/channels/graph-partner` deixou de ter o portão de modo/carência que existia na F3: ela pergunta direto
 * "cabe mais uma?" (`podeCriar`, mockado) e, quando não cabe, devolve 402 `plano_limite_atingido` com a frase
 * "Sua conta atingiu o limite de {n} conexões do plano {plano}..." montada com o plano real (lido do dublê do
 * client admin, sem mock do nosso código). Route Handler REAL; auth, provedor e gravação dublados.
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

describe("POST /api/v1/channels/graph-partner: pré-checagem de Conexões (D-188, bloqueia em qualquer modo)", () => {
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
    expect(vi.mocked(validateGraphPartnerCredentials)).not.toHaveBeenCalled();
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
    vi.mocked(findGraphPartnerSession).mockResolvedValue({ id: "sess-1", archivedAt: null } as never);

    const res = await POST(pedido());

    expect(vi.mocked(podeCriar)).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
  });
});
