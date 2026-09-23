/**
 * Cost computation for ai_agent_runs (S-13.08).
 *
 * Looks up the curated `ai_models` catalog (Spec 10 §2.2) and converts token
 * usage into cents, rounded up. Cached in-memory for 5 min — stale catalog data
 * never crashes; missing entries simply mean cost=0 for that run.
 *
 * IMPORTANT: distinct from `lib/ai/cost.ts` which still serves the legacy
 * `ai_pricing` table used by the EPIC-06 RAG worker.
 *
 * D-050 (`hiperbold/DEBITO.md`, decisão do Filipe em 23/09/2026): a leitura
 * cacheada do catálogo desta arquivo passou a ser REAPROVEITADA pelo
 * resolvedor de custo de `llm_calls` (`lib/agent-engine/edge/llm/pricing.ts` →
 * `custoCentsComCatalogo`, e `lib/ai/cost.ts` → `computeCost`), uma única ida
 * ao banco, com o mesmo cache de 5 minutos, para os três caminhos que gravam
 * `llm_calls`. `computeCostCents` abaixo NÃO mudou: continua devolvendo 0
 * quando o modelo é desconhecido, porque `lib/ai/runtime/agent.ts` (o único
 * chamador) já espera esse contrato e mudar aqui quebraria o runtime
 * `@deprecated` sem necessidade. Quem precisa do contrato NOVO (null nunca
 * zero) usa `precoDoCatalogoOuNull`, exportada logo abaixo.
 *
 * D-050 (revisão de 23/09/2026, achado do invariante de preview): a leitura
 * cacheada/com prazo/com backoff era amarrada AO CLIENTE HTTP do Supabase
 * (`createAdminClient`). O sandbox de ensaio (`runAgentPreview`) precisa de
 * ZERO `fetch`, e o seam de `run-model-call.ts` já recebe um `pg.Pool`: dois
 * `fetch` por preview vinham exatamente daqui. A lógica de cache/prazo/backoff
 * agora é `criarResolvedorDeCatalogo`, uma FÁBRICA que recebe um `carregador`
 * (a fonte das linhas, injetada) e devolve um resolvedor com seu PRÓPRIO
 * estado (cache, prazo, backoff) isolado: dois resolvedores nunca compartilham
 * cache um do outro. `precoDoCatalogoOuNull`/`_resetRuntimeCostCacheForTests`
 * abaixo continuam existindo, agora como o resolvedor PADRÃO (carregador HTTP,
 * o de sempre), nenhum chamador antigo muda. `run-model-call.ts` cria o SEU
 * PRÓPRIO resolvedor com um carregador que lê pelo `db` (pg.Pool) recebido.
 */
import { createAdminClient } from "@/lib/supabase/admin";

export interface ModelPricingRow {
  provider: string;
  model_id: string;
  input_price_per_million_cents: number | null;
  output_price_per_million_cents: number | null;
  /**
   * Item 10 da revisão (23/09/2026): modelo que saiu do catálogo (cron
   * `sync-model-catalog`, `lib/ai/catalogo/sincronizar.ts`) ganha esta data e
   * nunca é apagado, a linha continua servindo o histórico de custo. Preço de
   * HOJE não pode vir de uma linha depreciada. Opcional porque nem todo mock
   * de teste seleciona a coluna, ausente é tratado como "não depreciada".
   */
  deprecated_at?: string | null;
}

const TTL_MS = 5 * 60 * 1000;
/**
 * Item 11 da revisão: prazo da consulta ao catálogo. Sem prazo, o REST fora
 * do ar prendia toda chamada de IA pelo tempo do timeout do driver (bem mais
 * que isto), porque cada `computeCostCents`/`precoDoCatalogoOuNull` tentava
 * de novo do zero.
 */
const QUERY_TIMEOUT_MS = 2000;
/**
 * Item 11: depois de uma falha (erro OU estouro do prazo acima), não insiste
 * de novo por 60s. Sem isto, com o REST fora do ar, cada chamada de IA que
 * passa por aqui vira uma tentativa nova, e cada uma delas espera os 2s
 * inteiros do prazo antes de cair no cache velho.
 */
const BACKOFF_MS = 60 * 1000;

function key(provider: string, modelId: string): string {
  return `${provider}:${modelId}`;
}

/**
 * `Promise.race` contra um temporizador, mesmo padrão de
 * `lib/ai/mcp-externo/cliente.ts` (`comPrazo`). `finally` derruba o timer
 * quando a consulta real vence, para não deixar um reject tardio sem ninguém
 * escutando.
 */
function comPrazo<T>(p: PromiseLike<T>, ms: number): Promise<T> {
  let temporizador: ReturnType<typeof setTimeout>;
  const limite = new Promise<T>((_, rej) => {
    temporizador = setTimeout(() => rej(new Error(`catálogo ai_models: consulta excedeu ${ms}ms`)), ms);
  });
  return Promise.race([Promise.resolve(p), limite]).finally(() => clearTimeout(temporizador));
}

interface LeituraDoCatalogo {
  mapa: Map<string, ModelPricingRow>;
  /** Mesmas linhas de `mapa`, em lista, ver comentário de `linhasAtivas` (dentro da fábrica). */
  linhas: ModelPricingRow[];
  /**
   * Item 11 da revisão (23/09/2026): antes, `falhou` era sempre `true` numa
   * falha, mesmo servindo cache velho. Agora só é `true` quando NÃO há cache
   * nenhum para servir (preço realmente desconhecido); com cache velho
   * disponível o preço É conhecido (só não é o mais recente), então
   * `falhou: false`: quem chama usa esse preço em vez de desistir e gravar
   * custo nulo por causa de uma leitura que, para o modelo em questão, nem
   * mudou de valor.
   */
  falhou: boolean;
}

export interface PrecoDoCatalogo {
  inputCentsPerMillion: number;
  outputCentsPerMillion: number;
}

export interface LeituraDePrecoDoCatalogo {
  /** `null` = modelo fora do catálogo OU leitura falhou (ver `falhou`). */
  preco: PrecoDoCatalogo | null;
  falhou: boolean;
}

/** A fonte das linhas do catálogo, injetada, para o resolvedor não saber HTTP nem SQL. */
export type CarregadorDeLinhasDoCatalogo = () => Promise<ModelPricingRow[]>;

export interface ResolvedorDeCatalogo {
  /**
   * Preço do catálogo, tentando `provider` + `model_id` na ordem abaixo,
   * reaproveitando o cache de 5 min do resolvedor.
   *
   * Item 10 da revisão (23/09/2026, regressão): a versão antiga só tentava
   * `(provider, modelo sem prefixo)`, e o cron `sync-model-catalog`
   * (`lib/ai/catalogo/openrouter.ts`) grava modelo da OpenRouter como
   * `provider = 'openrouter'` e `model_id` COM o prefixo do fabricante
   * (`openai/gpt-5.6-luna`), nunca sob o provider real. Toda chamada com
   * `provider = 'openai'` errava o catálogo em silêncio e voltava "não achei"
   * mesmo com o preço cadastrado. A ordem abaixo é a MESMA da RPC
   * `fn_billing_margem_do_ciclo` (migration 0906, Parte 6, item 1c da
   * revisão), para o painel de margem e o custo por chamada nunca discordarem
   * sobre o preço do mesmo modelo:
   *
   *   1. `(provider, modelo exato)`;
   *   2. `(provider, modelo sem o prefixo "provider/" colado)`;
   *   3. `('openrouter', modelo como chegou)`, cobre o caso comum, quando quem
   *      gravou `llm_calls.model` já colou o prefixo do fabricante;
   *   4. modelo SEM prefixo: `('openrouter', "<provider>/<modelo>")`, cobre o
   *      caso em que `llm_calls.model` veio sem prefixo (o comum) mas o único
   *      preço conhecido é a linha da OpenRouter, que guarda o id prefixado;
   *   5/6. qualquer provider com este `model_id`, com ou sem prefixo,
   *      comportamento antigo de `lib/ai/cost.ts`, mantido por último.
   *
   * Linha com `deprecated_at` preenchido já saiu do `mapa`/`linhas` na leitura
   * do catálogo: nunca chega aqui.
   *
   * Devolve `{ preco: null, falhou: true }` quando a consulta falhou E não há
   * cache algum para servir (item 11); quem chama decide como logar (aqui só o
   * sinal, sem acoplar a um logger).
   */
  precoDoCatalogoOuNull(provider: string, model: string): Promise<LeituraDePrecoDoCatalogo>;
  /** Só a leitura crua com cache, usada pelo `computeCostCents` legado (contrato de hoje). */
  carregarMapa(): Promise<Map<string, ModelPricingRow>>;
  /** Test-only: descarta o cache e o backoff DESTE resolvedor (não afeta outros). */
  _resetCacheParaTestes(): void;
}

/**
 * Fábrica: cada chamada cria um resolvedor com seu PRÓPRIO cache, prazo de
 * consulta e backoff, estado isolado por CLOSURE, nunca módulo compartilhado.
 * É o que permite `run-model-call.ts` ter um resolvedor pelo `db` (pg.Pool)
 * SEM ele dividir cache (e sem ele herdar o `fetch` HTTP) com o resolvedor
 * padrão deste arquivo, usado pelos chamadores antigos.
 *
 * `carregarLinhas` é a única responsabilidade da fonte de dados: devolver as
 * linhas cruas de `ai_models`, ou LANÇAR em caso de falha (erro de rede, erro
 * do banco, ou o timeout do `comPrazo` abaixo, que envolve a chamada). Toda a
 * disciplina de cache/prazo/backoff/filtragem de `deprecated_at` mora aqui,
 * uma vez só, para as duas fontes (HTTP e `db`) nunca divergirem.
 */
export function criarResolvedorDeCatalogo(
  carregarLinhas: CarregadorDeLinhasDoCatalogo,
): ResolvedorDeCatalogo {
  let cache: Map<string, ModelPricingRow> | null = null;
  /**
   * As MESMAS linhas do `cache` acima, em lista, filtradas por `deprecated_at`.
   * O `cache` indexa por `provider:model_id` para o caso comum (chave exata);
   * o passo 5/6 da ordem de busca do item 10 ("qualquer provedor com este
   * model_id") não tem chave fixa para indexar, por isso precisa varrer.
   */
  let linhasAtivas: ModelPricingRow[] = [];
  let cacheAt = 0;
  /** 0 = sem falha recente. Item 11: controla o backoff de 60s acima. */
  let falhaEm = 0;

  async function carregarCatalogo(): Promise<LeituraDoCatalogo> {
    const now = Date.now();
    if (cache && now - cacheAt < TTL_MS) return { mapa: cache, linhas: linhasAtivas, falhou: false };

    // Item 11: dentro da janela de backoff depois de uma falha recente, nem
    // tenta de novo, devolve o que já tem (cache velho, ou vazio se nunca
    // carregou) sem gastar o prazo de 2s outra vez.
    if (falhaEm > 0 && now - falhaEm < BACKOFF_MS) {
      return { mapa: cache ?? new Map(), linhas: linhasAtivas, falhou: cache === null };
    }

    try {
      const linhas = await comPrazo(carregarLinhas(), QUERY_TIMEOUT_MS);
      const ativas = linhas.filter((row) => !row.deprecated_at);
      const map = new Map<string, ModelPricingRow>();
      for (const row of ativas) {
        map.set(key(row.provider, row.model_id), row);
      }
      cache = map;
      linhasAtivas = ativas;
      cacheAt = now;
      falhaEm = 0;
      return { mapa: map, linhas: ativas, falhou: false };
    } catch {
      // Falha do carregador (erro do provedor de dados, OU o prazo de
      // `comPrazo` acima): cai no cache antigo (se houver) e entra em
      // backoff. Nunca lança: uma consulta de preço não pode derrubar a
      // chamada de IA que está tentando se registrar.
      falhaEm = now;
      return { mapa: cache ?? new Map(), linhas: linhasAtivas, falhou: cache === null };
    }
  }

  async function precoDoCatalogoOuNull(
    provider: string,
    model: string,
  ): Promise<LeituraDePrecoDoCatalogo> {
    const { mapa, linhas, falhou } = await carregarCatalogo();
    if (falhou) return { preco: null, falhou: true };

    const temPrefixo = model.startsWith(`${provider}/`);
    const semPrefixo = temPrefixo ? model.slice(provider.length + 1) : model;

    const row =
      mapa.get(key(provider, model)) ??
      mapa.get(key(provider, semPrefixo)) ??
      mapa.get(key("openrouter", model)) ??
      (!temPrefixo ? mapa.get(key("openrouter", `${provider}/${model}`)) : undefined) ??
      linhas.find((r) => r.model_id === model) ??
      linhas.find((r) => r.model_id === semPrefixo);

    if (!row) return { preco: null, falhou: false };
    // M2 (auditoria de segurança, 23/09/2026): preço PARCIALMENTE nulo no
    // catálogo (só entrada ou só saída cadastrada) não pode virar custo zero na
    // metade que falta: `?? 0` fazia exatamente isso. Qualquer um dos dois
    // nulo é "preço inteiro desconhecido" (D-050): nunca inventa metade de graça.
    if (row.input_price_per_million_cents === null || row.output_price_per_million_cents === null) {
      return { preco: null, falhou: false };
    }
    return {
      preco: {
        inputCentsPerMillion: Number(row.input_price_per_million_cents),
        outputCentsPerMillion: Number(row.output_price_per_million_cents),
      },
      falhou: false,
    };
  }

  async function carregarMapa(): Promise<Map<string, ModelPricingRow>> {
    return (await carregarCatalogo()).mapa;
  }

  function _resetCacheParaTestes(): void {
    cache = null;
    linhasAtivas = [];
    cacheAt = 0;
    falhaEm = 0; // item 11: sem isto, um teste de falha vazaria backoff para o próximo.
  }

  return { precoDoCatalogoOuNull, carregarMapa, _resetCacheParaTestes };
}

/**
 * O carregador HTTP de sempre, via `createAdminClient` (PostgREST). Usado
 * pelo resolvedor PADRÃO abaixo, o que os chamadores antigos (`lib/ai/cost.ts`,
 * `lib/ai/telemetria-sem-custo.ts` → `pricing.ts`) continuam usando sem saber
 * que a fonte agora é injetável.
 */
async function carregarLinhasPorHttp(): Promise<ModelPricingRow[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("ai_models")
    .select("provider, model_id, input_price_per_million_cents, output_price_per_million_cents, deprecated_at");
  if (error) throw new Error(error.message);
  return (data ?? []) as ModelPricingRow[];
}

const resolvedorPadrao = criarResolvedorDeCatalogo(carregarLinhasPorHttp);

/** Contrato de hoje, inalterado: `lib/ai/runtime/agent.ts` é quem lê isto (via `computeCostCents`). */
async function loadPricing(): Promise<Map<string, ModelPricingRow>> {
  return resolvedorPadrao.carregarMapa();
}

export const precoDoCatalogoOuNull = resolvedorPadrao.precoDoCatalogoOuNull;

export interface ComputeCostInput {
  provider: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
}

/** Returns cost in cents (rounded up). 0 if model not in catalog. */
export async function computeCostCents(input: ComputeCostInput): Promise<number> {
  const pricing = await loadPricing();
  const row = pricing.get(key(input.provider, input.model));
  if (!row) return 0;
  const inputRate = Number(row.input_price_per_million_cents ?? 0);
  const outputRate = Number(row.output_price_per_million_cents ?? 0);
  const cents =
    ((input.inputTokens ?? 0) * inputRate) / 1_000_000 +
    ((input.outputTokens ?? 0) * outputRate) / 1_000_000;
  return Math.ceil(cents);
}

/** Test-only: drop the in-memory pricing cache do resolvedor PADRÃO (HTTP). */
export function _resetRuntimeCostCacheForTests(): void {
  resolvedorPadrao._resetCacheParaTestes();
}
