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
 */
import { createAdminClient } from "@/lib/supabase/admin";

interface ModelPricingRow {
  provider: string;
  model_id: string;
  input_price_per_million_cents: number | null;
  output_price_per_million_cents: number | null;
}

const TTL_MS = 5 * 60 * 1000;
let cache: Map<string, ModelPricingRow> | null = null;
let cacheAt = 0;

function key(provider: string, modelId: string): string {
  return `${provider}:${modelId}`;
}

interface LeituraDoCatalogo {
  mapa: Map<string, ModelPricingRow>;
  /**
   * true = a consulta a `ai_models` FALHOU nesta chamada (rede, banco fora do
   * ar, etc.), mesmo que `mapa` venha preenchida com o cache antigo, que é o
   * que `loadPricing`/`computeCostCents` (contrato de hoje) continuam usando.
   * `precoDoCatalogoOuNull` usa este sinal para distinguir "não achei o
   * modelo" (falhou=false) de "não consegui nem perguntar" (falhou=true), os
   * dois viram `null` no resolvedor de `llm_calls`, mas só o segundo pede log.
   */
  falhou: boolean;
}

async function carregarCatalogo(): Promise<LeituraDoCatalogo> {
  const now = Date.now();
  if (cache && now - cacheAt < TTL_MS) return { mapa: cache, falhou: false };
  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("ai_models")
      .select("provider, model_id, input_price_per_million_cents, output_price_per_million_cents");
    if (error) {
      return { mapa: cache ?? new Map(), falhou: true };
    }
    const map = new Map<string, ModelPricingRow>();
    for (const row of (data ?? []) as ModelPricingRow[]) {
      map.set(key(row.provider, row.model_id), row);
    }
    cache = map;
    cacheAt = now;
    return { mapa: map, falhou: false };
  } catch {
    // Fetch que rejeita (rede fora do ar) em vez de devolver `{error}`, mesmo
    // desfecho do `if (error)` acima: cai no cache antigo (se houver) e avisa
    // que a leitura falhou. Nunca lança: uma consulta de preço não pode
    // derrubar a chamada de IA que está tentando se registrar.
    return { mapa: cache ?? new Map(), falhou: true };
  }
}

/** Contrato de hoje, inalterado: `lib/ai/runtime/agent.ts` é quem lê isto. */
async function loadPricing(): Promise<Map<string, ModelPricingRow>> {
  return (await carregarCatalogo()).mapa;
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

/**
 * Preço do catálogo por `provider` + `model_id` EXATOS, a chave real de
 * `ai_models` (migration 0104), reaproveitando o cache de 5 min acima.
 *
 * `model` às vezes chega com o prefixo do provedor colado
 * (`openai/gpt-5.6-luna`, formato que `resolverModeloDoPonto`/
 * `ai_purpose_bindings` gravam em `llm_calls.model` em alguns caminhos, ver
 * D-050 em `hiperbold/DEBITO.md`), mas `ai_models.model_id` é gravado SEM
 * prefixo pelo cron `sync-model-catalog`. O prefixo é removido antes de bater
 * no mapa; sem essa normalização, todo id prefixado erraria o catálogo em
 * silêncio e voltaria "não achei" em vez de achar o preço real.
 *
 * Devolve `{ preco: null, falhou: true }` quando a consulta falhou, quem
 * chama decide como logar (aqui só o sinal, sem acoplar a um logger).
 */
export async function precoDoCatalogoOuNull(
  provider: string,
  model: string,
): Promise<LeituraDePrecoDoCatalogo> {
  const { mapa, falhou } = await carregarCatalogo();
  if (falhou) return { preco: null, falhou: true };
  const semPrefixo = model.startsWith(`${provider}/`) ? model.slice(provider.length + 1) : model;
  const row = mapa.get(key(provider, semPrefixo));
  if (!row) return { preco: null, falhou: false };
  return {
    preco: {
      inputCentsPerMillion: Number(row.input_price_per_million_cents ?? 0),
      outputCentsPerMillion: Number(row.output_price_per_million_cents ?? 0),
    },
    falhou: false,
  };
}

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

/** Test-only: drop the in-memory pricing cache. */
export function _resetRuntimeCostCacheForTests(): void {
  cache = null;
  cacheAt = 0;
}
