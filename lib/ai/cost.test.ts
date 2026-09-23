/**
 * D-050 (`hiperbold/DEBITO.md`, decisão do Filipe em 23/09/2026): `computeCost`
 * passou a devolver `null` (nunca 0) quando não sabe o preço, e a delegar a
 * consulta ao catálogo `ai_models` para `precoDoCatalogoOuNull`
 * (`lib/ai/runtime/cost.ts`), a mesma leitura cacheada usada em
 * `lib/agent-engine/edge/llm/pricing.ts`. `ai_pricing` (a tabela legada
 * escrita à mão) continua tendo prioridade, este arquivo prova que isso não
 * mudou, e que o caminho novo (catálogo) cobre o que `ai_pricing` não conhece.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

interface LinhaAiPricing {
  model: string;
  prompt_cents_per_million_tokens: number | null;
  completion_cents_per_million_tokens: number | null;
  embedding_cents_per_million_tokens: number | null;
}

interface LinhaAiModels {
  provider: string;
  model_id: string;
  input_price_per_million_cents: number | null;
  output_price_per_million_cents: number | null;
}

let aiPricingLinhas: LinhaAiPricing[] = [];
let aiModelsLinhas: LinhaAiModels[] = [];
let aiModelsDeveFalhar = false;

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      if (tabela === "ai_pricing") {
        return {
          select: () => ({
            is: async () => ({ data: aiPricingLinhas, error: null }),
          }),
        };
      }
      if (tabela === "ai_models") {
        return {
          select: async () => {
            if (aiModelsDeveFalhar) return { data: null, error: { message: "conexão com o catálogo recusada" } };
            return { data: aiModelsLinhas, error: null };
          },
        };
      }
      throw new Error(`tabela inesperada no mock de cost.test.ts: ${tabela}`);
    },
  }),
}));

import { _resetRuntimeCostCacheForTests } from "@/lib/ai/runtime/cost";

import { _resetPricingCacheForTests, computeCost } from "./cost";

beforeEach(() => {
  aiPricingLinhas = [];
  aiModelsLinhas = [];
  aiModelsDeveFalhar = false;
  _resetPricingCacheForTests();
  _resetRuntimeCostCacheForTests();
});

describe("computeCost, ai_pricing continua com prioridade (comportamento de hoje, inalterado)", () => {
  it("modelo com linha em ai_pricing usa a tarifa de lá, mesmo existindo no catálogo", async () => {
    aiPricingLinhas = [
      {
        model: "gpt-4o-mini",
        prompt_cents_per_million_tokens: 15,
        completion_cents_per_million_tokens: 60,
        embedding_cents_per_million_tokens: null,
      },
    ];
    aiModelsLinhas = [
      { provider: "openai", model_id: "gpt-4o-mini", input_price_per_million_cents: 999, output_price_per_million_cents: 999 },
    ];
    const cents = await computeCost({ model: "gpt-4o-mini", promptTokens: 1000, completionTokens: 200 });
    // (1000*15 + 200*60)/1e6 = 0,027 → arredondado para cima = 1. Se tivesse
    // usado o catálogo (999/999), o resultado seria muito maior, a asserção
    // de igualdade é o que prova a prioridade.
    expect(cents).toBe(1);
  });
});

describe("computeCost, Luna (fora de ai_pricing) ganha custo pelo catálogo", () => {
  it("resolve pelo catálogo quando ai_pricing não conhece o modelo", async () => {
    aiModelsLinhas = [
      { provider: "openai", model_id: "gpt-5.6-luna", input_price_per_million_cents: 20, output_price_per_million_cents: 120 },
    ];
    const cents = await computeCost({ model: "gpt-5.6-luna", promptTokens: 1000, completionTokens: 200 });
    // (1000*20 + 200*120)/1e6 = 0,044 → arredondado para cima = 1.
    expect(cents).toBe(1);
  });

  it("também resolve quando o id chega com o prefixo do provedor colado", async () => {
    aiModelsLinhas = [
      { provider: "openai", model_id: "gpt-5.6-luna", input_price_per_million_cents: 20, output_price_per_million_cents: 120 },
    ];
    const cents = await computeCost({ model: "openai/gpt-5.6-luna", promptTokens: 1000, completionTokens: 200 });
    expect(cents).toBe(1);
  });
});

describe("computeCost, preço desconhecido é null, NUNCA zero (D-050)", () => {
  it("modelo fora de ai_pricing e fora do catálogo devolve null", async () => {
    const cents = await computeCost({ model: "modelo-que-nao-existe-em-lugar-nenhum", promptTokens: 1000, completionTokens: 200 });
    expect(cents).toBeNull();
  });

  it("falha na leitura do catálogo devolve null e não lança", async () => {
    aiModelsDeveFalhar = true;
    await expect(
      computeCost({ model: "gpt-5.6-luna", promptTokens: 1000, completionTokens: 200 }),
    ).resolves.toBeNull();
  });
});
