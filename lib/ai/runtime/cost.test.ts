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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let catalogoLinhas: Array<{
  provider: string;
  model_id: string;
  input_price_per_million_cents: number | null;
  output_price_per_million_cents: number | null;
  deprecated_at?: string | null;
}> = [];
let catalogoDeveFalhar = false;
/** Item 11 da revisão: quando não nulo, o mock demora este tanto antes de responder. */
let catalogoAtrasoMs: number | null = null;

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      if (tabela !== "ai_models") throw new Error(`tabela inesperada no mock: ${tabela}`);
      return {
        select: async () => {
          if (catalogoAtrasoMs !== null) {
            await new Promise((resolve) => setTimeout(resolve, catalogoAtrasoMs!));
          }
          if (catalogoDeveFalhar) return { data: null, error: { message: "conexão com o catálogo recusada" } };
          return { data: catalogoLinhas, error: null };
        },
      };
    },
  }),
}));

import { _resetRuntimeCostCacheForTests, computeCostCents, criarResolvedorDeCatalogo, precoDoCatalogoOuNull } from "./cost";

beforeEach(() => {
  catalogoLinhas = [];
  catalogoDeveFalhar = false;
  catalogoAtrasoMs = null;
  _resetRuntimeCostCacheForTests();
});

afterEach(() => {
  vi.useRealTimers();
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

/**
 * Item 10 da revisão (23/09/2026, regressão): o cron `sync-model-catalog`
 * (`lib/ai/catalogo/openrouter.ts`) grava modelo da OpenRouter como
 * `provider = 'openrouter'` e `model_id` COM o prefixo do fabricante
 * (`openai/gpt-5.6-luna`). A versão antiga só tentava `(provider, modelo sem
 * prefixo)`, e nunca achava essa linha. Os quatro formatos abaixo são os
 * citados no briefing da revisão.
 */
describe("precoDoCatalogoOuNull, ordem de busca da OpenRouter (item 10 da revisão)", () => {
  const PRECO_LUNA = { inputCentsPerMillion: 20, outputCentsPerMillion: 120 };

  it("openai + gpt-5.6-luna, com linha direta do provider (passo 1)", async () => {
    catalogoLinhas = [
      { provider: "openai", model_id: "gpt-5.6-luna", input_price_per_million_cents: 20, output_price_per_million_cents: 120 },
    ];
    const resultado = await precoDoCatalogoOuNull("openai", "gpt-5.6-luna");
    expect(resultado).toEqual({ preco: PRECO_LUNA, falhou: false });
  });

  it("openai + openai/gpt-5.6-luna, só com a linha da OpenRouter (passo 3: modelo como chegou)", async () => {
    catalogoLinhas = [
      { provider: "openrouter", model_id: "openai/gpt-5.6-luna", input_price_per_million_cents: 20, output_price_per_million_cents: 120 },
    ];
    const resultado = await precoDoCatalogoOuNull("openai", "openai/gpt-5.6-luna");
    expect(resultado).toEqual({ preco: PRECO_LUNA, falhou: false });
  });

  it("openrouter + openai/gpt-5.6-luna, chave exata (passo 1)", async () => {
    catalogoLinhas = [
      { provider: "openrouter", model_id: "openai/gpt-5.6-luna", input_price_per_million_cents: 20, output_price_per_million_cents: 120 },
    ];
    const resultado = await precoDoCatalogoOuNull("openrouter", "openai/gpt-5.6-luna");
    expect(resultado).toEqual({ preco: PRECO_LUNA, falhou: false });
  });

  it("openai + gpt-5.6-luna SEM prefixo, só existe a linha prefixada da OpenRouter (passo 4: soma o prefixo)", async () => {
    catalogoLinhas = [
      { provider: "openrouter", model_id: "openai/gpt-5.6-luna", input_price_per_million_cents: 20, output_price_per_million_cents: 120 },
    ];
    const resultado = await precoDoCatalogoOuNull("openai", "gpt-5.6-luna");
    expect(resultado).toEqual({ preco: PRECO_LUNA, falhou: false });
  });

  it("modelo em lugar nenhum do catálogo: preco null, falhou false", async () => {
    catalogoLinhas = [
      { provider: "openrouter", model_id: "outro-fabricante/outro-modelo", input_price_per_million_cents: 1, output_price_per_million_cents: 1 },
    ];
    const resultado = await precoDoCatalogoOuNull("openai", "gpt-5.6-luna");
    expect(resultado).toEqual({ preco: null, falhou: false });
  });

  it("qualquer provider com o mesmo model_id, comportamento antigo mantido por último (passo 5/6)", async () => {
    catalogoLinhas = [
      { provider: "fabricante-inesperado", model_id: "gpt-5.6-luna", input_price_per_million_cents: 20, output_price_per_million_cents: 120 },
    ];
    const resultado = await precoDoCatalogoOuNull("openai", "gpt-5.6-luna");
    expect(resultado).toEqual({ preco: PRECO_LUNA, falhou: false });
  });

  it("linha depreciada (deprecated_at preenchido) não conta, mesmo model_id ativo em outro provider ganha", async () => {
    catalogoLinhas = [
      {
        provider: "openai",
        model_id: "gpt-5.6-luna",
        input_price_per_million_cents: 999,
        output_price_per_million_cents: 999,
        deprecated_at: "2026-01-01T00:00:00Z",
      },
      { provider: "outro-fabricante", model_id: "gpt-5.6-luna", input_price_per_million_cents: 20, output_price_per_million_cents: 120 },
    ];
    const resultado = await precoDoCatalogoOuNull("openai", "gpt-5.6-luna");
    expect(resultado).toEqual({ preco: PRECO_LUNA, falhou: false });
  });
});

/**
 * Item 11 da revisão (23/09/2026): prazo de 2s na leitura do catálogo, cache
 * velho como resposta de uma falha (quando existe) e backoff de 60s antes de
 * tentar de novo. Relógio falso: os prazos são medidos em tempo real, e um
 * teste com `setTimeout` de verdade seria lento e instável.
 */
describe("carregarCatalogo, prazo de 2s e backoff de 60s (item 11 da revisão)", () => {
  it("consulta que demora mais que 2s conta como falha; sem cache, falhou true", async () => {
    vi.useFakeTimers();
    catalogoAtrasoMs = 5000;
    const promessa = precoDoCatalogoOuNull("openai", "gpt-5.6-luna");
    await vi.advanceTimersByTimeAsync(2001);
    await expect(promessa).resolves.toEqual({ preco: null, falhou: true });
  });

  it("falha com cache velho disponível: falhou false, usa o preço do cache antigo", async () => {
    // Primeira leitura bem-sucedida, povoa o cache.
    catalogoLinhas = [
      { provider: "openai", model_id: "gpt-5.6-luna", input_price_per_million_cents: 20, output_price_per_million_cents: 120 },
    ];
    const primeira = await precoDoCatalogoOuNull("openai", "gpt-5.6-luna");
    expect(primeira.falhou).toBe(false);

    // TTL de 5 min vencido, nova tentativa falha: cache velho ainda serve o
    // mesmo preço, e falhou vira false porque o preço É conhecido.
    vi.useFakeTimers();
    vi.advanceTimersByTime(6 * 60 * 1000);
    catalogoDeveFalhar = true;
    const segunda = await precoDoCatalogoOuNull("openai", "gpt-5.6-luna");
    expect(segunda).toEqual({
      preco: { inputCentsPerMillion: 20, outputCentsPerMillion: 120 },
      falhou: false,
    });
  });

  it("depois de uma falha, não tenta de novo por 60s mesmo com o catálogo já consertado", async () => {
    vi.useFakeTimers();
    catalogoDeveFalhar = true;
    const primeira = await precoDoCatalogoOuNull("openai", "gpt-5.6-luna");
    expect(primeira).toEqual({ preco: null, falhou: true });

    // "Conserta" o catálogo, mas ainda dentro da janela de 60s de backoff.
    catalogoDeveFalhar = false;
    catalogoLinhas = [
      { provider: "openai", model_id: "gpt-5.6-luna", input_price_per_million_cents: 20, output_price_per_million_cents: 120 },
    ];
    vi.advanceTimersByTime(59_000);
    const segunda = await precoDoCatalogoOuNull("openai", "gpt-5.6-luna");
    // Ainda em backoff: nem tentou de novo, continua sem cache.
    expect(segunda).toEqual({ preco: null, falhou: true });

    vi.advanceTimersByTime(2_000); // total 61s: backoff passou.
    const terceira = await precoDoCatalogoOuNull("openai", "gpt-5.6-luna");
    expect(terceira).toEqual({
      preco: { inputCentsPerMillion: 20, outputCentsPerMillion: 120 },
      falhou: false,
    });
  });
});

/**
 * Revisão de 23/09/2026 (achado do invariante de preview,
 * `tests/invariants/autonomia-preview-core.test.ts`): a leitura do catálogo
 * era amarrada ao carregador HTTP (`createAdminClient`), e o resolvedor de
 * custo do `run-model-call.ts` precisa ler pelo `pg.Pool` (`db`) que já tem em
 * mãos, sem abrir `fetch` nenhum, o preview exige zero `fetch`. Este bloco
 * prova a FÁBRICA `criarResolvedorDeCatalogo` isolada do resolvedor padrão
 * (HTTP) deste arquivo: um carregador injetado qualquer (aqui, um objeto que
 * simula `db.query`) tem cache, prazo e ordem de busca IDÊNTICOS, e nunca
 * compartilha estado com o resolvedor HTTP acima.
 */
describe("criarResolvedorDeCatalogo, o carregador injetado (revisão de 23/09/2026)", () => {
  function poolFalso(linhas: typeof catalogoLinhas) {
    const query = vi.fn(async () => ({ rows: linhas }));
    return { query };
  }

  it("resolve pelo carregador injetado, sem tocar o carregador HTTP (createAdminClient)", async () => {
    const linhasDoDb = [
      { provider: "openai", model_id: "gpt-5.6-luna", input_price_per_million_cents: 20, output_price_per_million_cents: 120 },
    ];
    const pool = poolFalso(linhasDoDb);
    const resolvedor = criarResolvedorDeCatalogo(async () => {
      const { rows } = await pool.query();
      return rows;
    });

    // Catálogo HTTP (mock de `@/lib/supabase/admin`) fica VAZIO de propósito:
    // se o resolvedor pelo `db` acidentalmente caísse para o HTTP, o preço
    // sumiria em vez de aparecer.
    catalogoLinhas = [];

    const resultado = await resolvedor.precoDoCatalogoOuNull("openai", "gpt-5.6-luna");
    expect(resultado).toEqual({
      preco: { inputCentsPerMillion: 20, outputCentsPerMillion: 120 },
      falhou: false,
    });
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it("cache do resolvedor injetado é ISOLADO do resolvedor HTTP padrão", async () => {
    // Povoa o cache do resolvedor HTTP com um preço.
    catalogoLinhas = [
      { provider: "openai", model_id: "gpt-5.6-luna", input_price_per_million_cents: 999, output_price_per_million_cents: 999 },
    ];
    const doHttp = await precoDoCatalogoOuNull("openai", "gpt-5.6-luna");
    expect(doHttp.preco).toEqual({ inputCentsPerMillion: 999, outputCentsPerMillion: 999 });

    // O resolvedor NOVO, com carregador próprio vazio, não enxerga o cache do
    // HTTP: cada `criarResolvedorDeCatalogo` tem seu próprio estado.
    const pool = poolFalso([]);
    const resolvedorNovo = criarResolvedorDeCatalogo(async () => {
      const { rows } = await pool.query();
      return rows;
    });
    const doNovo = await resolvedorNovo.precoDoCatalogoOuNull("openai", "gpt-5.6-luna");
    expect(doNovo).toEqual({ preco: null, falhou: false });
  });

  it("carregador que lança: falhou true, sem cache; com cache velho, serve o preço antigo", async () => {
    let deveLancar = false;
    const resolvedor = criarResolvedorDeCatalogo(async () => {
      if (deveLancar) throw new Error("db indisponível");
      return [
        { provider: "openai", model_id: "gpt-5.6-luna", input_price_per_million_cents: 20, output_price_per_million_cents: 120 },
      ];
    });

    const primeira = await resolvedor.precoDoCatalogoOuNull("openai", "gpt-5.6-luna");
    expect(primeira.falhou).toBe(false);

    vi.useFakeTimers();
    vi.advanceTimersByTime(6 * 60 * 1000); // TTL de 5 min vencido.
    deveLancar = true;
    const segunda = await resolvedor.precoDoCatalogoOuNull("openai", "gpt-5.6-luna");
    // Cache velho ainda serve o mesmo preço: falhou vira false.
    expect(segunda).toEqual({
      preco: { inputCentsPerMillion: 20, outputCentsPerMillion: 120 },
      falhou: false,
    });
  });

  it("_resetCacheParaTestes descarta só o cache DESTE resolvedor", async () => {
    const resolvedor = criarResolvedorDeCatalogo(async () => [
      { provider: "openai", model_id: "gpt-5.6-luna", input_price_per_million_cents: 20, output_price_per_million_cents: 120 },
    ]);
    await resolvedor.precoDoCatalogoOuNull("openai", "gpt-5.6-luna");
    resolvedor._resetCacheParaTestes();

    // Depois do reset, uma nova leitura acontece (não serve cache velho); a
    // prova indireta é que o mapa devolvido reflete o carregador de novo, sem
    // erro nem resquício do backoff.
    const depois = await resolvedor.precoDoCatalogoOuNull("openai", "gpt-5.6-luna");
    expect(depois).toEqual({
      preco: { inputCentsPerMillion: 20, outputCentsPerMillion: 120 },
      falhou: false,
    });
  });
});
