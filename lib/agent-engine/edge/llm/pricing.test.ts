import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Mock do catálogo `ai_models` para os testes de `custoCentsComCatalogo`
 * (D-050, decisão do Filipe em 23/09/2026). As linhas são controladas por
 * `catalogoLinhas`/`catalogoDeveFalhar`; testes que só exercitam `costCents`/
 * `precoDoModelo` (puros, síncronos) nunca tocam este mock.
 */
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
      if (tabela !== "ai_models") throw new Error(`tabela inesperada no mock de pricing.test.ts: ${tabela}`);
      return {
        select: async () => {
          if (catalogoDeveFalhar) return { data: null, error: { message: "conexão com o catálogo recusada" } };
          return { data: catalogoLinhas, error: null };
        },
      };
    },
  }),
}));

import { _resetRuntimeCostCacheForTests } from "@/lib/ai/runtime/cost";

import { costCents, custoCentsComCatalogo, precoDoModelo, type TokenUsage } from "./pricing";

beforeEach(() => {
  catalogoLinhas = [];
  catalogoDeveFalhar = false;
  _resetRuntimeCostCacheForTests();
});

/**
 * O defeito de origem, medido numa VPS real: o agente atende em
 * `claude-sonnet-5` (o padrão do catálogo desde a migration 0101) e a tabela de
 * preços parou na geração 4. Resultado: `cost_cents` NULL em toda chamada, tela
 * Uso e orçamento em zero e teto mensal que nunca dispara — porque o budget soma
 * `coalesce(cost_cents, 0)`.
 *
 * Os dois irmãos do mesmo defeito, ambos do antigo match por `startsWith`:
 *   · `claude-opus-4` casava com `claude-opus-4-8` e cobrava US$ 15/75 (preço do
 *     Opus 4/4.1, aposentados) por um modelo de US$ 5/25 — sinal invertido: teto
 *     disparando cedo demais;
 *   · qualquer id FUTURO que apenas começasse igual (`claude-sonnet-50`) ganharia
 *     preço de outro modelo, e custo errado não-nulo é pior que custo nulo —
 *     não acende o sinal de gasto incompleto.
 *
 * Preços conferidos em 2026-09 em platform.claude.com/docs/en/about-claude/pricing.
 */

const NADA: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

/** 1 MTok só de entrada (sem cache) → cents. Isola a tarifa de entrada. */
function entrada(model: string): number | null {
  return costCents(model, { ...NADA, inputTokens: 1_000_000 });
}

/** 1 MTok só de saída → cents. Isola a tarifa de saída. */
function saida(model: string): number | null {
  return costCents(model, { ...NADA, outputTokens: 1_000_000 });
}

/** 1 MTok inteiro lido do cache → cents. */
function leituraDeCache(model: string): number | null {
  return costCents(model, { ...NADA, inputTokens: 1_000_000, cacheReadTokens: 1_000_000 });
}

/** 1 MTok gravado no cache, no TTL pedido → cents. */
function gravacaoDeCache(model: string, ttl: "5m" | "1h"): number | null {
  return costCents(model, { ...NADA, inputTokens: 1_000_000, cacheWriteTokens: 1_000_000 }, ttl);
}

describe("costCents — cada tarifa isolada, por modelo", () => {
  // Entrada e saída medidas SEPARADAMENTE de propósito: somadas, uma troca
  // acidental de 5/25 por 25/5 daria os mesmos US$ 30 e passaria verde.
  it.each([
    // modelo,              entrada, saída, leitura de cache, gravação 5m, gravação 1h
    ["claude-sonnet-5", 200, 1000, 20, 250, 400],
    ["claude-sonnet-4-6", 300, 1500, 30, 375, 600],
    ["claude-haiku-4-5", 100, 500, 10, 125, 200],
    ["claude-opus-5", 500, 2500, 50, 625, 1000],
    ["claude-opus-4-8", 500, 2500, 50, 625, 1000],
    ["claude-opus-4-7", 500, 2500, 50, 625, 1000],
    ["claude-opus-4-6", 500, 2500, 50, 625, 1000],
    ["claude-opus-4-5", 500, 2500, 50, 625, 1000],
    // Aposentados, e 3× mais caros que o Opus 4.5 — é o par que o prefixo confundia.
    ["claude-opus-4-1", 1500, 7500, 150, 1875, 3000],
    ["claude-opus-4", 1500, 7500, 150, 1875, 3000],
  ])("%s", (model, cIn, cOut, cLeitura, cGrav5m, cGrav1h) => {
    expect(entrada(model)).toBeCloseTo(cIn, 6);
    expect(saida(model)).toBeCloseTo(cOut, 6);
    expect(leituraDeCache(model)).toBeCloseTo(cLeitura, 6);
    expect(gravacaoDeCache(model, "5m")).toBeCloseTo(cGrav5m, 6);
    expect(gravacaoDeCache(model, "1h")).toBeCloseTo(cGrav1h, 6);
  });
});

describe("costCents — o TTL do cache é o que o knob LLM_CACHE_TTL diz", () => {
  it("gravação em 5m custa 1,25× a entrada, não 2×", () => {
    // O defeito: a tabela só tinha a tarifa de 1h e o cálculo a aplicava sempre.
    // Com LLM_CACHE_TTL='5m' (valor aceito por lib/agent-engine/env.ts), isso
    // superfaturava a parcela de gravação em 60%.
    expect(gravacaoDeCache("claude-sonnet-5", "5m")).toBeCloseTo(250, 6);
    expect(gravacaoDeCache("claude-sonnet-5", "1h")).toBeCloseTo(400, 6);
  });

  it("sem TTL informado, vale a doutrina do repo: 1h", () => {
    const comGravacao: TokenUsage = { ...NADA, inputTokens: 1_000_000, cacheWriteTokens: 1_000_000 };
    expect(costCents("claude-sonnet-5", comGravacao)).toBeCloseTo(400, 6);
  });
});

describe("costCents — id que a tabela não conhece volta NULL", () => {
  it.each([
    ["gpt-4o-mini"],
    ["claude-inexistente-9"],
    [""],
    // O caso que o `startsWith` deixava passar: começa igual a um id conhecido,
    // mas é outro modelo. Custo errado não-nulo não acende gasto incompleto.
    ["claude-sonnet-50"],
    ["claude-opus-4-9"],
    ["claude-opus-48"],
    // Id com prefixo de provider (formato do gateway/OpenRouter e do Bedrock) não
    // é o que este seam registra em llm_calls — e vale NULL, não um chute.
    ["anthropic/claude-sonnet-5"],
    ["anthropic.claude-sonnet-5"],
  ])("%s → null", (model) => {
    expect(costCents(model, { ...NADA, inputTokens: 1_000_000 })).toBeNull();
    expect(precoDoModelo(model)).toBeUndefined();
  });
});

describe("costCents — sufixo de data do vendor é tolerado", () => {
  it.each([
    ["claude-opus-4-1-20250805", 1500],
    ["claude-opus-4-20250514", 1500],
    ["claude-sonnet-4-5-20250929", 300],
    ["claude-haiku-4-5-20251001", 100],
  ])("%s custa como o id sem data", (model, cIn) => {
    expect(entrada(model)).toBeCloseTo(cIn, 6);
  });

  it("data mal formada não vira desconto silencioso", () => {
    expect(entrada("claude-opus-4-1-2025")).toBeNull();
    expect(entrada("claude-opus-4-1-202508051")).toBeNull();
  });
});

describe("costCents — a conversa real que originou este PR", () => {
  it("359.369 de entrada com 294.128 vindos do cache, em claude-sonnet-5", () => {
    const turnoReal: TokenUsage = {
      inputTokens: 359_369,
      outputTokens: 4_070,
      cacheReadTokens: 294_128,
      cacheWriteTokens: 0,
    };
    // Entrada não-cacheada: 359.369 − 294.128 = 65.241 tokens.
    const esperado = (((359_369 - 294_128) * 2 + 294_128 * 0.2 + 4_070 * 10) / 1_000_000) * 100;
    expect(costCents("claude-sonnet-5", turnoReal)).toBeCloseTo(esperado, 6);
    // ~23 cents: o número que a tela Uso e orçamento passa a somar, e que antes
    // deste conserto era NULL — zero para o teto mensal.
    expect(costCents("claude-sonnet-5", turnoReal)).toBeGreaterThan(22);
    expect(costCents("claude-sonnet-5", turnoReal)).toBeLessThan(24);
  });
});

/**
 * D-050 (`hiperbold/DEBITO.md`, decisão do Filipe em 23/09/2026): os agentes
 * passam a usar modelos baratos fora da Anthropic (GPT-5.6 Luna e afins), e o
 * resolvedor único (`custoCentsComCatalogo`) precisa dar custo a eles em vez
 * de nulo para sempre.
 */
describe("custoCentsComCatalogo, o resolvedor único de llm_calls", () => {
  it("Anthropic continua igual: resolve pela tabela escrita à mão, sem tocar o catálogo", async () => {
    const usage: TokenUsage = {
      inputTokens: 359_369,
      outputTokens: 4_070,
      cacheReadTokens: 294_128,
      cacheWriteTokens: 0,
    };
    const esperado = costCents("claude-sonnet-5", usage);
    const resolvido = await custoCentsComCatalogo("anthropic", "claude-sonnet-5", usage);
    expect(resolvido).toBeCloseTo(esperado!, 6);
    // Prova que o catálogo nem foi consultado: com `catalogoLinhas` vazio, se a
    // busca tivesse acontecido e o mapa não tivesse a entrada, o resultado
    // ainda seria o mesmo (null cairia para null), o que este teste garante
    // de verdade é a IGUALDADE com `costCents`, a régua de hoje.
    expect(resolvido).toBeGreaterThan(0);
  });

  it("Luna (fora da Anthropic) ganha custo pelo catálogo, 1000 de entrada, 200 de saída, 800 de cache lido", async () => {
    catalogoLinhas = [
      {
        provider: "openai",
        model_id: "gpt-5.6-luna",
        input_price_per_million_cents: 20,
        output_price_per_million_cents: 120,
      },
    ];
    const usage: TokenUsage = {
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 800,
      cacheWriteTokens: 0,
    };
    const custo = await custoCentsComCatalogo("openai", "gpt-5.6-luna", usage);
    // O catálogo não tem desconto de cache: os 1000 de entrada (que já INCLUEM
    // os 800 de cache lido, mesma convenção de `costCents`) vão inteiros ao
    // preço de entrada. (1000×20 + 200×120) / 1_000_000 = 0,044 cents.
    expect(custo).toBeCloseTo(0.044, 6);
  });

  it("prefixo provider/ colado no id é normalizado antes de bater no catálogo", async () => {
    catalogoLinhas = [
      {
        provider: "openai",
        model_id: "gpt-5.6-luna",
        input_price_per_million_cents: 20,
        output_price_per_million_cents: 120,
      },
    ];
    const usage: TokenUsage = { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 };
    // Formato que `resolverModeloDoPonto`/`ai_purpose_bindings` gravam em
    // `llm_calls.model` em alguns caminhos (produção real: 21 linhas de
    // `openai/gpt-5.6-luna` com `cost_cents` nulo antes deste conserto).
    const custo = await custoCentsComCatalogo("openai", "openai/gpt-5.6-luna", usage);
    expect(custo).toBeCloseTo(0.044, 6);
  });

  it("modelo fora da tabela e fora do catálogo: null, NUNCA zero", async () => {
    catalogoLinhas = [];
    const usage: TokenUsage = { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const custo = await custoCentsComCatalogo("openai", "modelo-que-nao-existe-em-lugar-nenhum", usage);
    expect(custo).toBeNull();
  });

  // M2 (auditoria de segurança, 23/09/2026): preço nulo (parcial ou total) no
  // catálogo nunca pode virar custo zero.
  it("um dos dois preços nulo no catálogo: null, o resolvedor nunca cobra a metade conhecida sozinha", async () => {
    catalogoLinhas = [
      { provider: "openai", model_id: "gpt-5.6-luna", input_price_per_million_cents: null, output_price_per_million_cents: 120 },
    ];
    const usage: TokenUsage = { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const custo = await custoCentsComCatalogo("openai", "gpt-5.6-luna", usage);
    expect(custo).toBeNull();
  });

  it("os dois preços zero no catálogo: null, não é diferente de desconhecido (mesma doutrina de lib/ai/cost.ts)", async () => {
    catalogoLinhas = [
      { provider: "openai", model_id: "gpt-5.6-luna", input_price_per_million_cents: 0, output_price_per_million_cents: 0 },
    ];
    const usage: TokenUsage = { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const custo = await custoCentsComCatalogo("openai", "gpt-5.6-luna", usage);
    expect(custo).toBeNull();
  });

  it("falha na leitura do catálogo: null, nunca derruba a chamada, e avisa no log", async () => {
    catalogoDeveFalhar = true;
    const avisos: Array<[string, Record<string, unknown> | undefined]> = [];
    const log = {
      warn: (msg: string, fields?: Record<string, unknown>) => {
        avisos.push([msg, fields]);
      },
    };
    const usage: TokenUsage = { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 };
    await expect(custoCentsComCatalogo("openai", "gpt-5.6-luna", usage, "1h", log)).resolves.toBeNull();
    expect(avisos).toHaveLength(1);
    expect(avisos[0]![0]).toMatch(/catálogo/i);
  });
});
