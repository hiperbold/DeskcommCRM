/**
 * `billing_settings.modo`, cacheado 60s por processo (revisão da F3, achado
 * baixo 4): `estado-do-bloqueio.ts` e `bloqueio-vale.ts` liam essa linha ÚNICA
 * (id = 1) pelo PostgREST a cada carga de tela ou pré-checagem, mesmo ela só
 * mudando quando o admin da plataforma troca o modo pela tela (raro, nunca
 * automático).
 *
 * Mesmo padrão de `modoDeBillingPeloDb`
 * (`lib/agent-engine/edge/llm/run-model-call.ts`, decisão 6 da fase F3: "o
 * modo, lido com cache curto em memória, como a chave do orçamento"), mas por
 * `SupabaseClient` (PostgREST/HTTP), não por `pg.Pool`: aqui não há o
 * invariante de "zero fetch" do caminho do agente que proíbe HTTP
 * (`tests/invariants/autonomia-preview-core.test.ts`), então o `admin` de
 * sempre (`createAdminClient()`, singleton do processo) serve de chave do
 * `WeakMap` sem precisar de nada por `pg.Pool`.
 *
 * `admin` na prática é sempre o MESMO client (singleton), então há UMA
 * entrada de cache em produção; um `admin` diferente (um dublê de teste)
 * ganha seu próprio cache e nunca vaza estado para o de produção, e um client
 * finalizado libera a entrada sozinho (`WeakMap`).
 *
 * Fail-open: leitura que falha NÃO é cacheada (não esconde um erro
 * transitório por 60s) e devolve o erro para quem chama decidir; as duas
 * consumidoras já tratam `modo` nulo/inválido como `avisar`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

const TTL_MS = 60_000;

interface EntradaDeCache {
  modo: string | null;
  expiraEm: number;
}

const cachePorCliente = new WeakMap<SupabaseClient, EntradaDeCache>();

export interface LeituraDoModoDeBilling {
  modo: string | null;
  /** Mensagem crua do Postgres/PostgREST, ou `null` quando a leitura passou. */
  error: string | null;
}

/**
 * Lê `billing_settings.modo` (linha `id = 1`), cacheado 60s por `admin`.
 * Duas chamadas seguidas com o MESMO client fazem uma leitura só.
 */
export async function modoDeBillingCacheado(admin: SupabaseClient): Promise<LeituraDoModoDeBilling> {
  const cache = cachePorCliente.get(admin);
  if (cache && cache.expiraEm > Date.now()) {
    return { modo: cache.modo, error: null };
  }

  const { data, error } = await admin.from("billing_settings").select("modo").eq("id", 1).maybeSingle();
  if (error) {
    return { modo: null, error: error.message };
  }

  const modo = (data as { modo?: string } | null)?.modo ?? null;
  cachePorCliente.set(admin, { modo, expiraEm: Date.now() + TTL_MS });
  return { modo, error: null };
}
