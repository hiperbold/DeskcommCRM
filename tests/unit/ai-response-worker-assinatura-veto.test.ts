/**
 * Tarefa 7/6, fase F4: `vetoPorAssinaturaSuspensa` (workers/ai-response-worker.ts),
 * o gate de assinatura suspensa do caminho LEGADO do worker.
 *
 * A função não é exportada (é detalhe interno do pipeline) e hoje não é
 * alcançável por `processMessageReceived`: `elegivelParaWorkerLegado` devolve
 * `false` sempre (`lib/ai/agents/no-ar.ts`), então este worker está desligado
 * do tráfego real. O gate precisa de teste do mesmo jeito, é código vivo, só
 * não é hoje alcançável por este ponto de entrada, daí o export de teste
 * `__test_vetoPorAssinaturaSuspensa` (mesmo padrão de
 * `lib/agent-engine/edge/crm/get-lead-context.ts:__test_fitToBudget`).
 *
 * Molde de `tests/unit/automacao-modo-leitura.test.ts` /
 * `tests/unit/assinatura-gate-executa-o-veredito.test.ts`: Supabase falso
 * casado por tabela + `.rpc`, e o controle positivo é o handoff disparado.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ triggerHandoff: vi.fn() }));
vi.mock("@/lib/ai/handoff/orchestrator", () => ({ triggerHandoff: mocks.triggerHandoff }));

import { __test_vetoPorAssinaturaSuspensa } from "@/workers/ai-response-worker";
import {
  HANDOFF_REASON_ASSINATURA,
  TITULO_ASSINATURA_SUSPENSA,
} from "@/lib/agent-engine/edge/llm/assinatura";

const ORG = "22222222-2222-4222-8222-222222222222";
const ALVO = { orgId: ORG, conversationId: "conv-1", leadId: "lead-1" };

/** Supabase falso: billing_settings (modo cacheado), rpc fn_billing_modo_leitura,
 *  agent_inbox_items (dedupe + insert do aviso). */
function fakeAdmin(opts: { modo: string | null | "erro"; modoLeitura: boolean | "erro" }) {
  let chamadasRpc = 0;
  const inserts: Array<Record<string, unknown>> = [];
  const admin = {
    from: (tabela: string) => {
      if (tabela === "billing_settings") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () =>
                opts.modo === "erro"
                  ? { data: null, error: { message: "conexão recusada" } }
                  : { data: { modo: opts.modo }, error: null },
            }),
          }),
        };
      }
      if (tabela === "agent_inbox_items") {
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: () => chain,
          insert: (row: Record<string, unknown>) => {
            inserts.push(row);
            return { then: (resolve: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(resolve) };
          },
          then: (resolve: (v: unknown) => unknown) =>
            Promise.resolve({ count: 0, error: null }).then(resolve),
        };
        return chain;
      }
      throw new Error(`tabela não esperada no teste: ${tabela}`);
    },
    rpc: async (nome: string) => {
      if (nome === "fn_billing_modo_leitura") {
        chamadasRpc += 1;
        if (opts.modoLeitura === "erro") throw new Error("banco fora");
        return { data: opts.modoLeitura, error: null };
      }
      throw new Error(`rpc não esperada no teste: ${nome}`);
    },
  };
  return { admin: admin as never, contarRpc: () => chamadasRpc, inserts };
}

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
import { createAdminClient } from "@/lib/supabase/admin";

const PLANOS_BLOQUEIO_ORIGINAL = process.env.PLANOS_BLOQUEIO;
afterEach(() => {
  vi.clearAllMocks();
  if (PLANOS_BLOQUEIO_ORIGINAL === undefined) delete process.env.PLANOS_BLOQUEIO;
  else process.env.PLANOS_BLOQUEIO = PLANOS_BLOQUEIO_ORIGINAL;
});

describe("vetoPorAssinaturaSuspensa (ai-response-worker, caminho legado)", () => {
  it("modo bloquear + RPC true: recusa, abre aviso, dispara handoff para a fila humana", async () => {
    delete process.env.PLANOS_BLOQUEIO;
    const { admin, inserts, contarRpc } = fakeAdmin({ modo: "bloquear", modoLeitura: true });
    vi.mocked(createAdminClient).mockReturnValue(admin);

    const resultado = await __test_vetoPorAssinaturaSuspensa(ALVO);

    expect(resultado).toMatchObject({ kind: "skip", reason: "assinatura_suspensa" });
    expect(contarRpc()).toBe(1);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({ title: TITULO_ASSINATURA_SUSPENSA });
    expect(mocks.triggerHandoff).toHaveBeenCalledTimes(1);
    expect(mocks.triggerHandoff).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG, reason: HANDOFF_REASON_ASSINATURA }),
    );
  });

  it("modo avisar: NENHUMA consulta a mais, a RPC de modo leitura nunca é chamada, segue (null)", async () => {
    delete process.env.PLANOS_BLOQUEIO;
    const { admin, contarRpc } = fakeAdmin({ modo: "avisar", modoLeitura: true });
    vi.mocked(createAdminClient).mockReturnValue(admin);

    const resultado = await __test_vetoPorAssinaturaSuspensa(ALVO);

    expect(resultado).toBeNull();
    expect(contarRpc()).toBe(0);
    expect(mocks.triggerHandoff).not.toHaveBeenCalled();
  });

  it("modo bloquear + RPC false (carência não vencida, ou status ativo): segue (null)", async () => {
    delete process.env.PLANOS_BLOQUEIO;
    const { admin } = fakeAdmin({ modo: "bloquear", modoLeitura: false });
    vi.mocked(createAdminClient).mockReturnValue(admin);

    const resultado = await __test_vetoPorAssinaturaSuspensa(ALVO);

    expect(resultado).toBeNull();
    expect(mocks.triggerHandoff).not.toHaveBeenCalled();
  });

  it("PLANOS_BLOQUEIO=avisar (chave de emergência): mesmo com RPC true, SEGUE, nunca lança/veta", async () => {
    process.env.PLANOS_BLOQUEIO = "avisar";
    const { admin, inserts } = fakeAdmin({ modo: "bloquear", modoLeitura: true });
    vi.mocked(createAdminClient).mockReturnValue(admin);

    const resultado = await __test_vetoPorAssinaturaSuspensa(ALVO);

    expect(resultado).toBeNull();
    expect(inserts).toHaveLength(0);
    expect(mocks.triggerHandoff).not.toHaveBeenCalled();
  });

  it("PLANOS_BLOQUEIO=off: nem cria o admin client, segue direto", async () => {
    process.env.PLANOS_BLOQUEIO = "off";

    const resultado = await __test_vetoPorAssinaturaSuspensa(ALVO);

    expect(resultado).toBeNull();
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("billing_settings inacessível: SEGUE (fail-open)", async () => {
    delete process.env.PLANOS_BLOQUEIO;
    const { admin } = fakeAdmin({ modo: "erro", modoLeitura: true });
    vi.mocked(createAdminClient).mockReturnValue(admin);

    const resultado = await __test_vetoPorAssinaturaSuspensa(ALVO);

    expect(resultado).toBeNull();
    expect(mocks.triggerHandoff).not.toHaveBeenCalled();
  });

  it("fn_billing_modo_leitura falhando: SEGUE (fail-open)", async () => {
    delete process.env.PLANOS_BLOQUEIO;
    const { admin } = fakeAdmin({ modo: "bloquear", modoLeitura: "erro" });
    vi.mocked(createAdminClient).mockReturnValue(admin);

    const resultado = await __test_vetoPorAssinaturaSuspensa(ALVO);

    expect(resultado).toBeNull();
    expect(mocks.triggerHandoff).not.toHaveBeenCalled();
  });
});
