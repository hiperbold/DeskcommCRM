/**
 * Tarefa 7/6, fase F4: `vetoPorAssinaturaSuspensaEnsaio` (lib/ai/runtime/agent.ts),
 * o gate de assinatura suspensa do runtime `@deprecated` (ensaio/preview).
 *
 * Extraído do corpo de `runAgent` (Tarefa 7) exatamente para ser testável sem
 * montar o run inteiro (linha, versão, credencial, token MCP, tool set):
 * nenhuma dessas peças participa desta decisão, e arrastá-las para o teste
 * mediria a montagem, não o gate. Export de teste
 * `__test_vetoPorAssinaturaSuspensaEnsaio`, mesmo padrão de
 * `lib/agent-engine/edge/crm/get-lead-context.ts:__test_fitToBudget`.
 *
 * Molde de `tests/unit/ai-response-worker-assinatura-veto.test.ts` (irmã
 * deste gate no caminho legado do worker).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ finalizeHandoff: vi.fn() }));
vi.mock("@/lib/ai/runtime/handoff", () => ({ finalizeHandoff: mocks.finalizeHandoff }));

import { __test_vetoPorAssinaturaSuspensaEnsaio } from "@/lib/ai/runtime/agent";
import { HANDOFF_REASON_ASSINATURA } from "@/lib/agent-engine/edge/llm/assinatura";

const ORG = "33333333-3333-4333-8333-333333333333";
const INPUT_BASE = {
  runId: "run-1",
  organizationId: ORG,
  conversationIdForHandoff: "conv-1",
  isDryRun: false,
  startedAt: Date.now(),
  waSessionName: "session-1",
  chatId: "chat-1",
};

function fakeAdmin(opts: { modo: string | null | "erro"; modoLeitura: boolean | "erro" }) {
  let chamadasRpc = 0;
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
  return { admin: admin as never, contarRpc: () => chamadasRpc };
}

const PLANOS_BLOQUEIO_ORIGINAL = process.env.PLANOS_BLOQUEIO;
afterEach(() => {
  vi.clearAllMocks();
  if (PLANOS_BLOQUEIO_ORIGINAL === undefined) delete process.env.PLANOS_BLOQUEIO;
  else process.env.PLANOS_BLOQUEIO = PLANOS_BLOQUEIO_ORIGINAL;
});

describe("vetoPorAssinaturaSuspensaEnsaio (lib/ai/runtime/agent.ts, runtime @deprecated)", () => {
  it("modo bloquear + RPC true: devolve resultado de handoff, dispara finalizeHandoff", async () => {
    delete process.env.PLANOS_BLOQUEIO;
    const { admin, contarRpc } = fakeAdmin({ modo: "bloquear", modoLeitura: true });

    const resultado = await __test_vetoPorAssinaturaSuspensaEnsaio({ ...INPUT_BASE, admin: admin as never });

    expect(resultado).toMatchObject({
      run_id: "run-1",
      status: "handoff",
      abort_reason: `billing:${HANDOFF_REASON_ASSINATURA}`,
      would_send_to: { session: "session-1", chat_id: "chat-1" },
    });
    expect(contarRpc()).toBe(1);
    expect(mocks.finalizeHandoff).toHaveBeenCalledTimes(1);
    expect(mocks.finalizeHandoff).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        organizationId: ORG,
        reason: HANDOFF_REASON_ASSINATURA,
        source: "billing",
      }),
    );
  });

  it("cobre o is_dry_run (ensaio) também: mesma recusa, sem exceção para preview", async () => {
    delete process.env.PLANOS_BLOQUEIO;
    const { admin } = fakeAdmin({ modo: "bloquear", modoLeitura: true });

    const resultado = await __test_vetoPorAssinaturaSuspensaEnsaio({
      ...INPUT_BASE,
      admin: admin as never,
      isDryRun: true,
    });

    expect(resultado?.status).toBe("handoff");
    expect(mocks.finalizeHandoff).toHaveBeenCalledWith(expect.objectContaining({ isDryRun: true }));
  });

  it("modo avisar: NENHUMA consulta a mais, a RPC de modo leitura nunca é chamada, segue (null)", async () => {
    delete process.env.PLANOS_BLOQUEIO;
    const { admin, contarRpc } = fakeAdmin({ modo: "avisar", modoLeitura: true });

    const resultado = await __test_vetoPorAssinaturaSuspensaEnsaio({ ...INPUT_BASE, admin: admin as never });

    expect(resultado).toBeNull();
    expect(contarRpc()).toBe(0);
    expect(mocks.finalizeHandoff).not.toHaveBeenCalled();
  });

  it("modo bloquear + RPC false: segue (null)", async () => {
    delete process.env.PLANOS_BLOQUEIO;
    const { admin } = fakeAdmin({ modo: "bloquear", modoLeitura: false });

    const resultado = await __test_vetoPorAssinaturaSuspensaEnsaio({ ...INPUT_BASE, admin: admin as never });

    expect(resultado).toBeNull();
  });

  it("PLANOS_BLOQUEIO=avisar: mesmo com RPC true, SEGUE, a chave de emergência só afrouxa", async () => {
    process.env.PLANOS_BLOQUEIO = "avisar";
    const { admin } = fakeAdmin({ modo: "bloquear", modoLeitura: true });

    const resultado = await __test_vetoPorAssinaturaSuspensaEnsaio({ ...INPUT_BASE, admin: admin as never });

    expect(resultado).toBeNull();
    expect(mocks.finalizeHandoff).not.toHaveBeenCalled();
  });

  it("PLANOS_BLOQUEIO=off: segue direto (o admin nem é consultado)", async () => {
    process.env.PLANOS_BLOQUEIO = "off";
    const admin = {
      from: () => {
        throw new Error("billing_settings não deveria ser consultado com PLANOS_BLOQUEIO=off");
      },
      rpc: () => {
        throw new Error("rpc não deveria rodar com PLANOS_BLOQUEIO=off");
      },
    };

    const resultado = await __test_vetoPorAssinaturaSuspensaEnsaio({ ...INPUT_BASE, admin: admin as never });

    expect(resultado).toBeNull();
  });

  it("billing_settings inacessível: SEGUE (fail-open)", async () => {
    delete process.env.PLANOS_BLOQUEIO;
    const { admin } = fakeAdmin({ modo: "erro", modoLeitura: true });

    const resultado = await __test_vetoPorAssinaturaSuspensaEnsaio({ ...INPUT_BASE, admin: admin as never });

    expect(resultado).toBeNull();
  });

  it("fn_billing_modo_leitura falhando: SEGUE (fail-open)", async () => {
    delete process.env.PLANOS_BLOQUEIO;
    const { admin } = fakeAdmin({ modo: "bloquear", modoLeitura: "erro" });

    const resultado = await __test_vetoPorAssinaturaSuspensaEnsaio({ ...INPUT_BASE, admin: admin as never });

    expect(resultado).toBeNull();
  });
});
