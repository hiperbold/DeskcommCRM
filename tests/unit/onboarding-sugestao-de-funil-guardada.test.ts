/**
 * D-118: a sugestão de funil não chama o modelo a cada render.
 *
 * O banco e o modelo são dublês; o estado do onboarding é um objeto em memória
 * que `patchOnboardingState` realmente altera e `loadOnboardingState` realmente
 * lê, para provar o comportamento de ponta a ponta do passo: recarregar não paga
 * de novo, a chamada deixa telemetria, e carteira/orçamento zerados não gastam.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generateText: vi.fn(),
  telemetria: vi.fn(),
  carteira: vi.fn(),
  orcamento: vi.fn(),
  estado: {} as Record<string, unknown>,
}));

vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("ai", () => ({ generateText: mocks.generateText }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/ai/runtime/agent", () => ({ buildModel: () => ({}), chaveDePlataforma: () => "sk-da-instalacao" }));
vi.mock("@/lib/ai/credentials", () => ({ loadCredential: vi.fn() }));
vi.mock("@/lib/ai/telemetria-sem-custo", () => ({ registrarTelemetriaSemCusto: mocks.telemetria }));
vi.mock("@/lib/ai/gate-de-custo", () => ({
  veredictoDaCarteira: mocks.carteira,
  veredictoDoOrcamento: mocks.orcamento,
}));
vi.mock("@/app/actions/onboarding/_shared", () => ({
  OnboardingError: class OnboardingError extends Error {},
  requireOnboardingCtx: async () => ({ orgId: "org-1", userId: "u-1" }),
  loadOnboardingState: async () => ({ state: mocks.estado, onboardedAt: null }),
  patchOnboardingState: async (_org: string, patch: Record<string, unknown>) => {
    Object.assign(mocks.estado, patch);
  },
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "order"]) q[m] = () => q;
      const dados: Record<string, unknown> = {
        ai_agents: { published_version_id: "v1" },
        ai_agent_versions: { provider: "openai", model: "gpt-x", credential_id: null },
        crm_pipelines: { id: "p1", name: "Pedidos" },
      };
      q.maybeSingle = async () => ({ data: dados[tabela] ?? null, error: null });
      q.then = (ok: (r: unknown) => unknown) => ok({ data: [], error: null });
      return q;
    },
  }),
}));

import { dadosDoPasso } from "@/app/actions/onboarding/montarQuadro";

const JSON_DA_IA = JSON.stringify({
  nome: "Agenda",
  etapas: [
    { nome: "Novo contato", passo: "new" },
    { nome: "Conversando", passo: "contacted" },
    { nome: "Consulta marcada", passo: "qualified" },
    { nome: "Fechou", passo: "won" },
    { nome: "Perdido", passo: "lost" },
  ],
});

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(mocks.estado)) delete mocks.estado[k];
  mocks.estado.welcome = { accepted_at: "x", timezone: "America/Sao_Paulo", display_name: "Clínica Sorriso", o_que_faz: "clínica odontológica" };
  mocks.carteira.mockResolvedValue(null);
  mocks.orcamento.mockResolvedValue(null);
  mocks.generateText.mockResolvedValue({ text: JSON_DA_IA, usage: { inputTokens: 300, outputTokens: 120 } });
});

describe("dadosDoPasso: sugestão de funil guardada", () => {
  it("recarregar o passo N vezes chama o modelo UMA vez", async () => {
    const a = await dadosDoPasso("org-1", "Clínica Sorriso");
    const b = await dadosDoPasso("org-1", "Clínica Sorriso");
    const c = await dadosDoPasso("org-1", "Clínica Sorriso");

    expect(mocks.generateText).toHaveBeenCalledTimes(1);
    expect(a.sugestao.origem).toBe("ia");
    expect(b.sugestao).toEqual(a.sugestao);
    expect(c.sugestao).toEqual(a.sugestao);
  });

  it("a chamada deixa telemetria com tokens e origem da chave", async () => {
    await dadosDoPasso("org-1", "Clínica Sorriso");
    expect(mocks.telemetria).toHaveBeenCalledTimes(1);
    expect(mocks.telemetria).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-1",
        purpose: "onboarding_funil",
        inputTokens: 300,
        outputTokens: 120,
        origemDaChave: "chave_da_instalacao",
      }),
    );
  });

  it("mudou o que o negócio faz: é outra pergunta, gera de novo", async () => {
    await dadosDoPasso("org-1", "Clínica Sorriso");
    (mocks.estado.welcome as { o_que_faz: string }).o_que_faz = "loja de roupas";
    await dadosDoPasso("org-1", "Clínica Sorriso");
    expect(mocks.generateText).toHaveBeenCalledTimes(2);
  });

  it("carteira zerada: nem chama o modelo, entrega o pacote pronto dizendo por quê", async () => {
    mocks.carteira.mockResolvedValue({ acao: "bloquear", motivo: "x", saldo: 0, ciclo: null });
    const r = await dadosDoPasso("org-1", "Clínica Sorriso");
    expect(mocks.generateText).not.toHaveBeenCalled();
    expect(mocks.telemetria).not.toHaveBeenCalled();
    expect(r.sugestao.origem).toBe("pacote");
    if (r.sugestao.origem === "pacote") expect(r.sugestao.porque).toContain("tokens de IA");
  });

  it("orçamento atingido: também não chama o modelo", async () => {
    mocks.orcamento.mockResolvedValue({ acao: "bloquear", porque: "teto_atingido" });
    const r = await dadosDoPasso("org-1", "Clínica Sorriso");
    expect(mocks.generateText).not.toHaveBeenCalled();
    expect(r.sugestao.origem).toBe("pacote");
  });

  it("leitura da carteira que falha não impede a sugestão", async () => {
    mocks.carteira.mockRejectedValue(new Error("banco fora"));
    const r = await dadosDoPasso("org-1", "Clínica Sorriso");
    expect(mocks.generateText).toHaveBeenCalledTimes(1);
    expect(r.sugestao.origem).toBe("ia");
  });

  it("falha do modelo cai no pacote, e uma recarga imediata NÃO paga outra chamada", async () => {
    mocks.generateText.mockRejectedValue(new Error("provedor fora"));
    const a = await dadosDoPasso("org-1", "Clínica Sorriso");
    const b = await dadosDoPasso("org-1", "Clínica Sorriso");
    expect(a.sugestao.origem).toBe("pacote");
    expect(b.sugestao.origem).toBe("pacote");
    expect(mocks.generateText).toHaveBeenCalledTimes(1);
  });
});
