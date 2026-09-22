import { DEFAULT_CHANNEL_PROVIDER } from "@/lib/channels";
import { describe, it, expect, vi } from "vitest";
import { tool } from "@/lib/agent-engine/edge/llm/run-model-call";
import { z } from "zod";
import {
  applyPreviewPolicy,
  newPreviewResult,
  scenarioContext,
  type TurnPreview,
} from "@/lib/agent-engine/agent/preview";
import type { GateContext } from "@/lib/agent-engine/guardrails/before-send";
import { PACING_DEFAULTS } from "@/lib/agent-engine/pacing/defaults";
import { SPINNING_DEFAULTS } from "@/lib/agent-engine/spinning/defaults";

/**
 * A prévia (botão Testar) executa a ferramenta externa DE VERDADE quando ela
 * chega até `applyPreviewPolicy` — mas a política NUNCA decide sozinha que um
 * id `mcp_*` é de consulta (achado H): ela só libera o que está no conjunto
 * `externasDeConsulta` que a montagem do turno (`buildExternalMcpTools` com
 * `readOnly`, filtrando por `somente_leitura_confirmado === true`) já
 * aprovou. Um id `mcp_*` bem formado mas de fora do conjunto cai no mesmo
 * fail-closed `unknown_preview_tool` de qualquer nome desconhecido.
 */
const gate = (): GateContext => ({
  now: new Date("2026-09-21T15:00:00Z"),
  body: "Olá, posso ajudar?",
  optedOut: false,
  provider: DEFAULT_CHANNEL_PROVIDER,
  messagingWindow: { lastInboundAt: new Date("2026-09-21T14:00:00Z") },
  pacing: {
    knobs: PACING_DEFAULTS,
    state: { lastSentAt: null, sentToday: 0, numberActivatedAt: null },
    crmDailyLimit: null,
  },
  spinning: { knobs: SPINNING_DEFAULTS, window: [] },
  promise: { table: null },
  semanticPromise: null,
  disclosure: { template: null, isFirstOutbound: false, mode: "inject" },
  lgpd: null,
  casesEnabled: false,
  hasOpenCase: false,
  openedCaseThisTurn: false,
});
const preview = () =>
  ({
    kind: "sandbox",
    organizationId: "real-org",
    runId: "preview-run",
    contactId: null,
    channelId: null,
    agent: {},
    context: scenarioContext([]),
    result: newPreviewResult(),
  }) as TurnPreview;
const definition = (execute: (args: unknown) => unknown) =>
  tool({
    inputSchema: z.object({ bairro: z.string().optional() }),
    execute: async (args) => execute(args),
  });
async function executar(t: ReturnType<typeof applyPreviewPolicy>, name: string, args: unknown = {}) {
  return t[name]!.execute!(args, { toolCallId: "test", messages: [], context: undefined });
}

describe("a prévia roda a ferramenta MCP de consulta que a montagem deixou passar", () => {
  it("chama o execute original de um id mcp_* que está em externasDeConsulta, sem cair em unknown_preview_tool", async () => {
    const executarOriginal = vi.fn(async () => ({ ok: true, dados: "3 imóveis em Centro" }));
    const p = preview();

    const tools = applyPreviewPolicy(
      { mcp_n8n__buscar: definition(executarOriginal) },
      p,
      gate(),
      () => [],
      undefined,
      undefined,
      new Set(["mcp_n8n__buscar"]),
    );
    const resultado = await executar(tools, "mcp_n8n__buscar", { bairro: "Centro" });

    expect(executarOriginal).toHaveBeenCalledOnce();
    expect(resultado).toEqual({ ok: true, dados: "3 imóveis em Centro" });
    expect(p.result.impediments).toEqual([]);
  });

  it("(H) id mcp_* bem formado mas FORA de externasDeConsulta cai no fail-closed — a política nunca decide sozinha", async () => {
    const spy = vi.fn();
    const p = preview();

    // A montagem aprovou uma OUTRA ferramenta, não esta: `mcp_n8n__buscar`
    // não está no conjunto, então mesmo sendo um id `mcp_*` válido ele não
    // passa — só o conjunto que veio da decisão do admin manda.
    const tools = applyPreviewPolicy(
      { mcp_n8n__buscar: definition(spy) },
      p,
      gate(),
      () => [],
      undefined,
      undefined,
      new Set(["mcp_n8n__outra"]),
    );
    await executar(tools, "mcp_n8n__buscar");

    expect(spy).not.toHaveBeenCalled();
    expect(p.result.impediments[0]?.code).toBe("unknown_preview_tool");
  });

  it("sem o conjunto (default vazio, fail-closed): nenhum mcp_* passa", async () => {
    const spy = vi.fn();
    const p = preview();

    const tools = applyPreviewPolicy({ mcp_n8n__buscar: definition(spy) }, p, gate(), () => []);
    await executar(tools, "mcp_n8n__buscar");

    expect(spy).not.toHaveBeenCalled();
    expect(p.result.impediments[0]?.code).toBe("unknown_preview_tool");
  });

  it("id que não bate com mcp_<apelido>__<nome> continua caindo no fail-closed padrão, mesmo estando em externasDeConsulta", async () => {
    const spy = vi.fn();
    const p = preview();

    const tools = applyPreviewPolicy(
      { mcp_sem_apelido_valido: definition(spy) },
      p,
      gate(),
      () => [],
      undefined,
      undefined,
      new Set(["mcp_sem_apelido_valido"]),
    );
    await executar(tools, "mcp_sem_apelido_valido");

    expect(spy).not.toHaveBeenCalled();
    expect(p.result.impediments[0]?.code).toBe("unknown_preview_tool");
  });
});
