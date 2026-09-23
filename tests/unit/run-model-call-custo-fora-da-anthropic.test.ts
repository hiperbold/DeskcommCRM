/**
 * D-050 (`hiperbold/DEBITO.md`, decisão do Filipe em 23/09/2026): os agentes
 * passam a usar modelos baratos fora da Anthropic (GPT-5.6 Luna e afins), e a
 * linha de SUCESSO que `runModelCall` grava em `llm_calls` precisa ter
 * `cost_cents` real para esses modelos, não nulo para sempre.
 *
 * Este arquivo prova a ponta a ponta: `runModelCall` com `provider=openai` e
 * `model=gpt-5.6-luna` grava `cost_cents` calculado pelo catálogo `ai_models`
 * (mockado aqui), exatamente como `custoCentsComCatalogo` calcularia sozinho
 * (provado em `lib/agent-engine/edge/llm/pricing.test.ts`).
 *
 * Revisão de 23/09/2026 (achado do invariante de preview): a leitura do
 * catálogo dentro de `runModelCall` deixou de ser HTTP (`createAdminClient`) e
 * passou a ser pelo MESMO `db` (pg.Pool) que o seam já recebe, por isso o
 * catálogo abaixo é servido pelo `pool.query` (`select ... from ai_models`),
 * não mais pelo mock de `@/lib/supabase/admin`. O mock de `@/lib/supabase/admin`
 * continua aqui só porque `lib/ai/runtime/cost.ts` (importado transitivamente
 * por `./pricing`) ainda importa `createAdminClient` no topo do módulo. Sem
 * o mock, essa importação exigiria env vars reais de Supabase só para o
 * módulo carregar, mesmo a função nunca sendo chamada neste caminho.
 */
import { describe, expect, it, vi } from "vitest";

let catalogoLinhas: Array<{
  provider: string;
  model_id: string;
  input_price_per_million_cents: number | null;
  output_price_per_million_cents: number | null;
}> = [];

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      if (tabela !== "ai_models") throw new Error(`tabela inesperada no mock: ${tabela}`);
      return {
        select: async () => ({ data: catalogoLinhas, error: null }),
      };
    },
  }),
}));

import { _resetRuntimeCostCacheForTests } from "@/lib/ai/runtime/cost";
import { runModelCall } from "@/lib/agent-engine/edge/llm/run-model-call";

const ORG = "33333333-3333-4333-8333-333333333333";

function poolComProvedorOpenAI() {
  const inserts: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("settings->'llm'")) {
      return {
        rows: [
          {
            llm: {
              provider: "openai",
              default_model: "gpt-5.6-luna",
              params: {},
              enabled_models: [],
              monthly_budget_cents: null,
            },
          },
        ],
      };
    }
    if (sql.includes("from ai_purpose_bindings")) return { rows: [] };
    if (sql.includes("from ai_provider_credentials")) return { rows: [] };
    // O resolvedor de custo pelo `db` (`run-model-call.ts`, revisão de
    // 23/09/2026): mesma tabela, mesmas colunas do carregador HTTP acima,
    // agora servida pelo pool em vez do admin do Supabase.
    if (sql.includes("from ai_models")) return { rows: catalogoLinhas };
    if (sql.includes("insert into llm_calls")) {
      inserts.push({ sql, params });
      return { rows: [{ id: "call-1" }] };
    }
    return { rows: [] };
  });
  return { pool: { query } as never, inserts };
}

describe("runModelCall grava cost_cents pelo catálogo para modelo fora da Anthropic (D-050)", () => {
  it("openai/gpt-5.6-luna: 1000 de entrada, 200 de saída, 800 de cache lido", async () => {
    catalogoLinhas = [
      {
        provider: "openai",
        model_id: "gpt-5.6-luna",
        input_price_per_million_cents: 20,
        output_price_per_million_cents: 120,
      },
    ];
    _resetRuntimeCostCacheForTests();

    const { pool, inserts } = poolComProvedorOpenAI();
    const cfg = { openaiApiKey: "sk-openai-de-teste", cacheTtl: "1h" as const };
    const okRegistry = {
      openai: () =>
        ({
          specificationVersion: "v3",
          provider: "openai",
          modelId: "gpt-5.6-luna",
          doGenerate: async () => ({
            content: [{ type: "text", text: "ok" }],
            finishReason: { unified: "stop", raw: undefined },
            usage: {
              inputTokens: { total: 1000, noCache: 200, cacheRead: 800, cacheWrite: 0 },
              outputTokens: { total: 200, text: 200, reasoning: 0 },
            },
            warnings: [],
          }),
        }) as never,
    };

    await runModelCall(
      pool,
      cfg,
      { tenantId: ORG, purpose: "agent_turn", messages: [{ role: "user", content: "oi" }] },
      { registry: okRegistry },
    );

    expect(inserts).toHaveLength(1);
    const params = inserts[0]!.params;
    // cost_cents é o 12º parâmetro do insert de sucesso (ver o SQL em
    // run-model-call.ts: organization_id..purpose, provider, model,
    // input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
    // cost_cents é o índice 11, zero-based).
    const custoGravado = params[11];
    // (1000×20 + 200×120) / 1_000_000 = 0,044 cents.
    expect(custoGravado).toBeCloseTo(0.044, 6);
    expect(params).toContain("openai");
    expect(params).toContain("gpt-5.6-luna");
  });

  it("lê o catálogo pelo db (pool.query), nunca por fetch: zero fetch na chamada inteira", async () => {
    // Revisão de 23/09/2026: a prova direta do que o invariante de preview
    // (`tests/invariants/autonomia-preview-core.test.ts`) exige em ponta a
    // ponta com banco real, aqui isolado, com um pool falso e um espião de
    // `fetch` global.
    catalogoLinhas = [
      {
        provider: "openai",
        model_id: "gpt-5.6-luna",
        input_price_per_million_cents: 20,
        output_price_per_million_cents: 120,
      },
    ];
    _resetRuntimeCostCacheForTests();

    const { pool } = poolComProvedorOpenAI();
    const cfg = { openaiApiKey: "sk-openai-de-teste", cacheTtl: "1h" as const };
    const okRegistry = {
      openai: () =>
        ({
          specificationVersion: "v3",
          provider: "openai",
          modelId: "gpt-5.6-luna",
          doGenerate: async () => ({
            content: [{ type: "text", text: "ok" }],
            finishReason: { unified: "stop", raw: undefined },
            usage: {
              inputTokens: { total: 1000, noCache: 200, cacheRead: 800, cacheWrite: 0 },
              outputTokens: { total: 200, text: 200, reasoning: 0 },
            },
            warnings: [],
          }),
        }) as never,
    };

    const fetchEspiao = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("fetch_proibido_no_teste"));
    try {
      await runModelCall(
        pool,
        cfg,
        { tenantId: ORG, purpose: "agent_turn", messages: [{ role: "user", content: "oi" }] },
        { registry: okRegistry },
      );
      expect(fetchEspiao).not.toHaveBeenCalled();
      // A prova positiva de que a leitura ACONTECEU, só que pelo pool: sem
      // isto, "zero fetch" também passaria se o catálogo nunca fosse
      // consultado, o que esconderia uma regressão diferente (custo sempre
      // nulo).
      const chamadasAoPool = (pool as { query: ReturnType<typeof vi.fn> }).query.mock.calls as unknown[][];
      expect(chamadasAoPool.some((args) => String(args[0]).includes("from ai_models"))).toBe(true);
    } finally {
      fetchEspiao.mockRestore();
    }
  });
});
