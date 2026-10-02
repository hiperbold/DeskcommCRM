/**
 * D-156: o caminho legado de resposta consulta a carteira de tokens ANTES de
 * chamar o modelo. Molde de `ai-response-worker-assinatura-veto.test.ts`: Supabase
 * falso por tabela e rpc; a decisão em si (`deveConsultarCarteira`) é a real.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ triggerHandoff: vi.fn() }));
vi.mock("@/lib/ai/handoff/orchestrator", () => ({ triggerHandoff: mocks.triggerHandoff }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { createAdminClient } from "@/lib/supabase/admin";
import { __test_vetoPorCarteiraDeTokens } from "@/workers/ai-response-worker";

const ORG = "22222222-2222-4222-8222-222222222222";
const ALVO = { orgId: ORG, conversationId: "conv-1", leadId: "lead-1" };

function fakeAdmin(opts: { modo: string; veredito: unknown }) {
  let rpcs = 0;
  const inserts: Array<Record<string, unknown>> = [];
  const admin = {
    from: (tabela: string) => {
      if (tabela === "billing_settings") {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { modo: opts.modo }, error: null }) }) }) };
      }
      if (tabela === "agent_inbox_items") {
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: () => chain,
          insert: async (row: Record<string, unknown>) => {
            inserts.push(row);
            return { error: null };
          },
          then: (ok: (v: unknown) => unknown) => Promise.resolve({ count: 0, error: null }).then(ok),
        };
        return chain;
      }
      throw new Error(`tabela não esperada: ${tabela}`);
    },
    rpc: async (nome: string) => {
      if (nome !== "fn_billing_ia_pode_responder") throw new Error(`rpc não esperada: ${nome}`);
      rpcs += 1;
      return { data: opts.veredito, error: null };
    },
  };
  return { admin: admin as never, rpcs: () => rpcs, inserts };
}

const ZERADA = { acao: "bloquear", motivo: "saldo zerado", saldo: 0, ciclo: "2026-10-01" };

const ORIGINAL = process.env.PLANOS_BLOQUEIO;
afterEach(() => {
  vi.clearAllMocks();
  if (ORIGINAL === undefined) delete process.env.PLANOS_BLOQUEIO;
  else process.env.PLANOS_BLOQUEIO = ORIGINAL;
});

describe("vetoPorCarteiraDeTokens (ai-response-worker, caminho legado)", () => {
  it("chave da instalação, modo bloquear, carteira zerada: recusa, avisa a Central e passa à fila humana", async () => {
    delete process.env.PLANOS_BLOQUEIO;
    const { admin, inserts } = fakeAdmin({ modo: "bloquear", veredito: ZERADA });
    vi.mocked(createAdminClient).mockReturnValue(admin);

    const r = await __test_vetoPorCarteiraDeTokens({ ...ALVO, origemDaChave: "chave_da_instalacao" });

    expect(r).toMatchObject({ kind: "skip", reason: "carteira_de_tokens_esgotada" });
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({ kind: "other", ref_kind: "billing_carteira", severity: "critical" });
    expect(mocks.triggerHandoff).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG, conversationId: "conv-1" }),
    );
  });

  it("chave da própria organização: nem consulta a carteira", async () => {
    const { admin, rpcs } = fakeAdmin({ modo: "bloquear", veredito: ZERADA });
    vi.mocked(createAdminClient).mockReturnValue(admin);
    const r = await __test_vetoPorCarteiraDeTokens({ ...ALVO, origemDaChave: "credencial_da_organizacao" });
    expect(r).toBeNull();
    expect(rpcs()).toBe(0);
    expect(mocks.triggerHandoff).not.toHaveBeenCalled();
  });

  it("modo avisar: nenhuma consulta, segue", async () => {
    delete process.env.PLANOS_BLOQUEIO;
    const { admin, rpcs } = fakeAdmin({ modo: "avisar", veredito: ZERADA });
    vi.mocked(createAdminClient).mockReturnValue(admin);
    expect(await __test_vetoPorCarteiraDeTokens({ ...ALVO, origemDaChave: "chave_da_instalacao" })).toBeNull();
    expect(rpcs()).toBe(0);
  });

  it("carteira com saldo: segue", async () => {
    delete process.env.PLANOS_BLOQUEIO;
    const { admin } = fakeAdmin({
      modo: "bloquear",
      veredito: { acao: "seguir", motivo: "ok", saldo: 5000, ciclo: "2026-10-01" },
    });
    vi.mocked(createAdminClient).mockReturnValue(admin);
    expect(await __test_vetoPorCarteiraDeTokens({ ...ALVO, origemDaChave: "chave_da_instalacao" })).toBeNull();
    expect(mocks.triggerHandoff).not.toHaveBeenCalled();
  });

  it("PLANOS_BLOQUEIO=avisar rebaixa o bloqueio: segue", async () => {
    process.env.PLANOS_BLOQUEIO = "avisar";
    const { admin } = fakeAdmin({ modo: "bloquear", veredito: ZERADA });
    vi.mocked(createAdminClient).mockReturnValue(admin);
    expect(await __test_vetoPorCarteiraDeTokens({ ...ALVO, origemDaChave: "chave_da_instalacao" })).toBeNull();
  });
});
