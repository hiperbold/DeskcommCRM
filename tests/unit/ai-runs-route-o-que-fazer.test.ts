// @vitest-environment node
/**
 * Revisão da F3 (achado baixo 6): `carteira_de_tokens_esgotada`
 * (`LlmCarteiraEsgotadaError`, decisão 7 da fase) não tinha entrada no mapa
 * `O_QUE_FAZER` de `app/api/v1/ai/runs/route.ts`, a tela mostrava o código
 * cru sem nenhuma orientação, a única linha do mapa que faltava para esse
 * erro deliberado da fase de planos.
 */
import { describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

const ORG = "22222222-2222-4222-8222-222222222222";

function supabaseComLinha(linha: Record<string, unknown>) {
  const query = {
    select: () => query,
    eq: () => query,
    order: () => query,
    limit: () => Promise.resolve({ data: [linha], error: null }),
  };
  return { from: () => query } as never;
}

describe("GET /api/v1/ai/runs: O_QUE_FAZER cobre carteira_de_tokens_esgotada", () => {
  it("uma execução com esse error_code volta com orientação, não null", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: true,
      user: { idioma: "pt-BR" } as never,
      org: { orgId: ORG, name: "Org", role: "manager" } as never,
    });
    vi.mocked(createClient).mockReturnValue(
      supabaseComLinha({
        id: "call-1",
        purpose: "agent_turn",
        provider: "anthropic",
        model: "claude",
        status: "erro",
        error_code: "carteira_de_tokens_esgotada",
        error_message: "carteira esgotada",
        http_status: null,
        origem_da_escolha: null,
        input_tokens: 0,
        output_tokens: 0,
        cost_cents: null,
        latency_ms: null,
        created_at: "2026-09-24T12:00:00.000Z",
      }) as never,
    );

    const { GET } = await import("@/app/api/v1/ai/runs/route");
    const res = await GET(new Request("http://x/api/v1/ai/runs") as never);
    const corpo = (await res.json()) as {
      data: { execucoes: Array<{ oQueFazer: string | null }>; resumo: { porCodigo: Array<{ codigo: string; oQueFazer: string | null }> } };
    };

    expect(corpo.data.execucoes[0]!.oQueFazer).not.toBeNull();
    expect(corpo.data.execucoes[0]!.oQueFazer).toMatch(/tokens de IA/i);
    const linhaDoResumo = corpo.data.resumo.porCodigo.find((l) => l.codigo === "carteira_de_tokens_esgotada");
    expect(linhaDoResumo?.oQueFazer).not.toBeNull();
  });
});
