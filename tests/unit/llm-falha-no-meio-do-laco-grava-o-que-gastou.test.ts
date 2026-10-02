/**
 * D-156: uma chamada que falha no meio do laço de ferramentas não pode ser
 * gravada com zero token. Os passos anteriores já foram pagos ao provedor; sem
 * a soma, llm_calls, carteira e orçamento deixavam de contar esse dinheiro.
 */
import { describe, expect, it, vi } from "vitest";
import { tool } from "ai";
import { z } from "zod";

import { runModelCall } from "@/lib/agent-engine/edge/llm/run-model-call";

const ORG = "44444444-4444-4444-8444-444444444444";

function pool() {
  const inserts: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("settings->'llm'")) {
      return {
        rows: [
          { llm: { provider: "anthropic", default_model: "claude-padrao", params: {}, enabled_models: [], monthly_budget_cents: null } },
        ],
      };
    }
    if (sql.includes("insert into llm_calls")) {
      inserts.push({ sql, params });
      return { rows: [{ id: "call-1" }] };
    }
    return { rows: [] };
  });
  return { pool: { query } as never, inserts };
}

function registry(passos: Array<"ferramenta" | "falha">) {
  let i = 0;
  const fabrica = () =>
    ({
      specificationVersion: "v3",
      provider: "anthropic",
      modelId: "claude-padrao",
      doGenerate: async () => {
        const passo = passos[i++] ?? "falha";
        if (passo === "falha") throw new Error("503 service unavailable");
        return {
          content: [{ type: "tool-call", toolCallId: `t${i}`, toolName: "eco", input: "{}" }],
          finishReason: { unified: "tool-calls", raw: undefined },
          usage: {
            inputTokens: { total: 1000, noCache: 1000, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 50, text: 50, reasoning: 0 },
          },
          warnings: [],
        };
      },
    }) as never;
  return { anthropic: fabrica, openai: fabrica, google: fabrica, openrouter: fabrica };
}

const eco = tool({ description: "eco", inputSchema: z.object({}), execute: async () => "ok" });
const cfg = { anthropicApiKey: "sk-teste", cacheTtl: "1h" as const };

async function rodar(passos: Array<"ferramenta" | "falha">) {
  const { pool: p, inserts } = pool();
  let lancou: unknown = null;
  try {
    await runModelCall(
      p,
      cfg,
      { tenantId: ORG, purpose: "agent_turn", messages: [{ role: "user", content: "oi" }], tools: { eco }, maxSteps: 5 },
      { registry: registry(passos) },
    );
  } catch (e) {
    lancou = e;
  }
  return { inserts, lancou };
}

describe("D-156: falha no meio do laço grava o que os passos anteriores gastaram", () => {
  it("dois passos pagos e o terceiro falha: a linha de erro leva 2000 de entrada e 100 de saída", async () => {
    const { inserts, lancou } = await rodar(["ferramenta", "ferramenta", "falha"]);
    expect(lancou).toBeInstanceOf(Error);
    expect(inserts).toHaveLength(1);
    const linha = inserts[0]!;
    expect(linha.sql).toContain("'erro'");
    // input_tokens, output_tokens: índices 7 e 8 do insert de falha parcial.
    expect(linha.params[7]).toBe(2000);
    expect(linha.params[8]).toBe(100);
  });

  it("falha no primeiro passo (nada pago) continua com tokens zero e custo nulo", async () => {
    const { inserts } = await rodar(["falha"]);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.sql).toMatch(/0, 0, 0, 0, null/);
  });
});
