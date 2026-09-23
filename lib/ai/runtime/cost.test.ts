/**
 * D-050 (`hiperbold/DEBITO.md`, decisão do Filipe em 23/09/2026): a leitura
 * cacheada do catálogo `ai_models` que este arquivo já tinha para
 * `computeCostCents` (usada só por `lib/ai/runtime/agent.ts`, o runtime
 * `@deprecated`) passou a ser reaproveitada pelo resolvedor único de
 * `llm_calls` (`custoCentsComCatalogo`, `lib/agent-engine/edge/llm/pricing.ts`,
 * `lib/ai/cost.ts`). Este arquivo prova as duas coisas que não podem quebrar
 * nessa reorganização:
 *
 *  - `computeCostCents` continua devolvendo 0 para modelo desconhecido, o
 *    contrato que `lib/ai/runtime/agent.ts` já espera hoje.
 *  - `precoDoCatalogoOuNull`, a leitura nova, devolve `null` (nunca 0) e sinaliza
 *    a falha de leitura separadamente, normalizando o prefixo `provider/`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

let catalogoLinhas: Array<{
  provider: string;
  model_id: string;
  input_price_per_million_cents: number | null;
  output_price_per_million_cents: number | null;
}> = [];
let catalogoDeveFalhar = false;

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      if (tabela !== "ai_models") throw new Error(`tabela inesperada no mock: ${tabela}`);
      return {
        select: async () => {
          if (catalogoDeveFalhar) return { data: null, error: { message: "conexão com o catálogo recusada" } };
          return { data: catalogoLinhas, error: null };
        },
      };
    },
  }),
}));

import { _resetRuntimeCostCacheForTests, computeCostCents, precoDoCatalogoOuNull } from "./cost";

beforeEach(() => {
  catalogoLinhas = [];
  catalogoDeveFalhar = false;
  _resetRuntimeCostCacheForTests();
});

describe("computeCostCents, contrato de hoje, inalterado (lib/ai/runtime/agent.ts espera isto)", () => {
  it("modelo desconhecido devolve 0, não null", async () => {
    const cents = await computeCostCents({ provider: "openai", model: "modelo-nunca-catalogado", inputTokens: 1000, outputTokens: 200 });
    expect(cents).toBe(0);
  });

  it("modelo conhecido no catálogo devolve o custo em cents, arredondado para cima", async () => {
    catalogoLinhas = [
      { provider: "openai", model_id: "gpt-5.6-luna", input_price_per_million_cents: 20, output_price_per_million_cents: 120 },
    ];
    const cents = await computeCostCents({ provider: "openai", model: "gpt-5.6-luna", inputTokens: 1000, outputTokens: 200 });
    // (1000*20 + 200*120)/1e6 = 0,044 → arredondado para cima = 1.
    expect(cents).toBe(1);
  });
});

describe("precoDoCatalogoOuNull, a leitura nova (D-050): null nunca é zero", () => {
  it("modelo fora do catálogo: preco null, falhou false", async () => {
    const resultado = await precoDoCatalogoOuNull("openai", "modelo-que-nao-existe");
    expect(resultado).toEqual({ preco: null, falhou: false });
  });

  it("modelo no catálogo: devolve as duas tarifas exatas", async () => {
    catalogoLinhas = [
      { provider: "openai", model_id: "gpt-5.6-luna", input_price_per_million_cents: 20, output_price_per_million_cents: 120 },
    ];
    const resultado = await precoDoCatalogoOuNull("openai", "gpt-5.6-luna");
    expect(resultado).toEqual({
      preco: { inputCentsPerMillion: 20, outputCentsPerMillion: 120 },
      falhou: false,
    });
  });

  it("normaliza o prefixo provider/ antes de bater no catálogo", async () => {
    catalogoLinhas = [
      { provider: "openai", model_id: "gpt-5.6-luna", input_price_per_million_cents: 20, output_price_per_million_cents: 120 },
    ];
    const resultado = await precoDoCatalogoOuNull("openai", "openai/gpt-5.6-luna");
    expect(resultado.preco).toEqual({ inputCentsPerMillion: 20, outputCentsPerMillion: 120 });
  });

  it("leitura que falha: preco null, falhou true, nunca lança", async () => {
    catalogoDeveFalhar = true;
    await expect(precoDoCatalogoOuNull("openai", "gpt-5.6-luna")).resolves.toEqual({
      preco: null,
      falhou: true,
    });
  });

  // M2 (auditoria de segurança, 23/09/2026): preço PARCIALMENTE nulo no
  // catálogo não pode virar custo zero na metade que falta.
  it("preço de entrada nulo no catálogo: preco null inteiro, não {inputCentsPerMillion: 0, ...}", async () => {
    catalogoLinhas = [
      { provider: "openai", model_id: "gpt-5.6-luna", input_price_per_million_cents: null, output_price_per_million_cents: 120 },
    ];
    const resultado = await precoDoCatalogoOuNull("openai", "gpt-5.6-luna");
    expect(resultado).toEqual({ preco: null, falhou: false });
  });

  it("preço de saída nulo no catálogo: preco null inteiro", async () => {
    catalogoLinhas = [
      { provider: "openai", model_id: "gpt-5.6-luna", input_price_per_million_cents: 20, output_price_per_million_cents: null },
    ];
    const resultado = await precoDoCatalogoOuNull("openai", "gpt-5.6-luna");
    expect(resultado).toEqual({ preco: null, falhou: false });
  });
});
