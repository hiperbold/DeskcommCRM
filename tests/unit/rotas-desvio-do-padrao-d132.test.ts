/**
 * D-132 (parte das rotas): captura Meta, relógio da instalação e fonte de
 * webhook. Roda os Route Handlers REAIS com as fronteiras dubladas.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { criarClickRef } from "@/lib/plataformas-de-anuncio/captura-de-clique";
import { executarTickDoRelogio } from "@/lib/relogio/executar";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({ loadAuthUser: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({
    from: () => {
      const q: Record<string, unknown> = {
        select: () => q,
        eq: () => q,
        // D-128: o PATCH da fonte lê o `path_token` pelo cliente de servidor (`.in("id", [...])`).
        in: () => q,
        then: (resolver: (v: unknown) => unknown) =>
          resolver({ data: [{ id: "33333333-3333-4333-8333-333333333333", path_token: "tok" }], error: null }),
        maybeSingle: async () => ({ data: { id: "22222222-2222-4222-8222-222222222222" }, error: null }),
      };
      return q;
    },
  })),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: vi.fn(async () => ({ allowed: true })) }));
vi.mock("@/lib/plataformas-de-anuncio/landing-config", () => ({
  lerConfigDaLanding: vi.fn(async () => ({ whatsappE164: "+5511999990000", messageTemplate: "Oi {token}" })),
}));
vi.mock("@/lib/plataformas-de-anuncio/captura-de-clique", () => ({
  criarClickRef: vi.fn(async () => ({ token: "tok" })),
}));
vi.mock("@/lib/relogio/executar", () => ({
  executarTickDoRelogio: vi.fn(async () => ({ mexeu: false, tarefas: [] })),
}));

const ORG = "22222222-2222-4222-8222-222222222222";
const FONTE = "33333333-3333-4333-8333-333333333333";
const FUNIL_A = "44444444-4444-4444-8444-444444444444";
const ETAPA_B = "55555555-5555-4555-8555-555555555555";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("captura Meta: query_raw só guarda o que normalizarUtm aceitou", () => {
  it("nome, telefone e e-mail repassados pela landing não são gravados", async () => {
    const { GET } = await import("@/app/api/v1/anuncios/meta/[org]/route");
    const url =
      "http://local/api/v1/anuncios/meta/clinica?utm_source=meta&utm_campaign=c1&nome=Maria&telefone=11999990000&email=m@x.com";
    await GET(new NextRequest(url), { params: Promise.resolve({ org: "clinica" }) });

    const gravado = vi.mocked(criarClickRef).mock.calls[0]?.[3] as {
      utm: Record<string, string>;
      query_raw: Record<string, unknown>;
    };
    expect(gravado.utm.utm_source).toBe("meta");
    const texto = JSON.stringify(gravado.query_raw);
    for (const pessoal of ["Maria", "11999990000", "m@x.com"]) expect(texto).not.toContain(pessoal);
    expect(gravado.query_raw.utm_campaign).toBe("c1");
  });
});

describe("relógio da instalação: sessão só de admin da plataforma", () => {
  const tick = () => new NextRequest("http://local/api/v1/system/relogio/tick", { method: "POST" });

  it("admin de uma organização (não da plataforma) é recusado e o tick não roda", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: true,
      user: { id: "u", is_platform_admin: false },
      org: { orgId: ORG, role: "admin" },
    } as never);
    const { POST } = await import("@/app/api/v1/system/relogio/tick/route");
    const res = await POST(tick());
    expect(res.status).toBe(403);
    expect(executarTickDoRelogio).not.toHaveBeenCalled();
  });

  it("admin da plataforma passa", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: true,
      user: { id: "u", is_platform_admin: true },
      org: { orgId: ORG, role: "admin" },
    } as never);
    const { POST } = await import("@/app/api/v1/system/relogio/tick/route");
    const res = await POST(tick());
    expect(res.status).toBe(200);
    expect(executarTickDoRelogio).toHaveBeenCalledTimes(1);
  });
});

describe("PATCH de fonte de webhook confere o destino como o POST", () => {
  function banco(etapaDoFunil: boolean) {
    return {
      from: (tabela: string) => {
        const q: Record<string, unknown> = {
          select: () => q,
          eq: () => q,
          update: () => q,
          single: async () => ({ data: { id: FONTE }, error: null }),
          maybeSingle: async () => {
            if (tabela === "webhook_sources") {
              return { data: { id: FONTE, default_pipeline_id: FUNIL_A, default_stage_id: ETAPA_B }, error: null };
            }
            if (tabela === "crm_pipelines") return { data: { id: FUNIL_A }, error: null };
            // crm_stages: a etapa só casa se for do funil.
            return { data: etapaDoFunil ? { id: ETAPA_B, is_archived: false } : null, error: null };
          },
        };
        return q;
      },
    };
  }
  const patch = (corpo: unknown) =>
    new NextRequest(`http://local/api/v1/webhook-sources/${FONTE}`, {
      method: "PATCH",
      body: JSON.stringify(corpo),
    });

  beforeEach(() => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: true,
      user: { id: "u", idioma: "pt-BR" },
      org: { orgId: ORG, role: "manager" },
    } as never);
  });

  it("etapa que não é do funil: 422 e nada é gravado", async () => {
    vi.mocked(createClient).mockResolvedValue(banco(false) as never);
    const { PATCH } = await import("@/app/api/v1/webhook-sources/[id]/route");
    const res = await PATCH(patch({ default_stage_id: ETAPA_B }), { params: Promise.resolve({ id: FONTE }) });
    expect(res.status).toBe(422);
  });

  it("destino válido segue para a gravação", async () => {
    vi.mocked(createClient).mockResolvedValue(banco(true) as never);
    const { PATCH } = await import("@/app/api/v1/webhook-sources/[id]/route");
    const res = await PATCH(patch({ default_stage_id: ETAPA_B }), { params: Promise.resolve({ id: FONTE }) });
    expect(res.status).toBe(200);
  });

  it("mudar só o nome não consulta funil nem etapa", async () => {
    const b = banco(false);
    const tabelas: string[] = [];
    vi.mocked(createClient).mockResolvedValue({
      from: (t: string) => (tabelas.push(t), b.from(t)),
    } as never);
    const { PATCH } = await import("@/app/api/v1/webhook-sources/[id]/route");
    const res = await PATCH(patch({ name: "Novo nome" }), { params: Promise.resolve({ id: FONTE }) });
    expect(res.status).toBe(200);
    expect(tabelas).not.toContain("crm_stages");
  });
});
