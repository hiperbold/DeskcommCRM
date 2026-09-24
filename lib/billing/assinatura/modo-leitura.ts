/**
 * "A conta desta organização está em MODO LEITURA agora?": Tarefa 7 da fase
 * F4 (decisão 8), usada pelos PRODUTORES que disparam mensagem sozinhos
 * (automação, campanha, prospecção, follow-up) para decidir se o disparo
 * pode sair. NÃO é o mesmo portão de `lib/billing/planos/bloqueio-vale.ts`
 * (que só testa se "o bloqueio vale para a organização", sem reconferir
 * status/carência) nem a checagem da IA (decisão 6, Tarefa 6, separada de
 * propósito em `run-model-call.ts`): aqui a fonte de verdade é a RPC
 * `fn_billing_modo_leitura` (migração 0908, parte 2), que já confere
 * status in ('suspensa','cancelada') e a carência (`bloqueio_a_partir_de`)
 * vencida, o mesmo interruptor que os quatro gatilhos de criação usam no
 * banco.
 *
 * ═══ "SEGUE SEM CONSULTA NENHUMA" NO MODO AVISAR (decisão 8) ═══
 *
 * O modo (`billing_settings.modo`), cacheado 60s (`modoDeBillingCacheado`,
 * a mesma leitura de `bloqueio-vale.ts`), decide sozinho: modo diferente de
 * 'bloquear' sai aqui, ZERO consulta a mais, nem a RPC. Só quando o modo em
 * cache já diz 'bloquear' é que `fn_billing_modo_leitura` é chamada, porque
 * só ela sabe se ESTA organização está suspensa/cancelada com a carência
 * vencida (o cache do modo não carrega essa informação).
 *
 * ═══ Fail-open ═══
 *
 * Mesma doutrina de `bloqueio-vale.ts`/`pode-criar.ts`: leitura que falha
 * NUNCA para um produtor (devolve `false`, "não é modo leitura") e grita
 * `alarme_planos_leitura` no log, a falha não pode passar despercebida.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type pg from "pg";

import { logger } from "@/lib/logger";
import { modoDeBillingCacheado } from "@/lib/billing/planos/modo-cacheado";

/**
 * Variante para quem já tem um `SupabaseClient` de serviço (automação,
 * campanha, os handlers de follow-up e o dreno inline de texto fixo).
 */
export async function contaEmModoLeitura(
  admin: SupabaseClient,
  organizationId: string,
): Promise<boolean> {
  try {
    const { modo, error: mensagemDeErro } = await modoDeBillingCacheado(admin);
    if (mensagemDeErro) {
      throw new Error(`ler billing_settings: ${mensagemDeErro}`);
    }

    // Modo diferente de 'bloquear' (inclusive nulo/inválido, tratado como
    // 'avisar' por `modoDeBillingCacheado`): sai aqui, sem chamar a RPC, o
    // "zero custo a mais" da decisão 8.
    if (modo !== "bloquear") {
      return false;
    }

    const { data, error } = await admin.rpc("fn_billing_modo_leitura", {
      p_org: organizationId,
    });
    if (error) {
      throw new Error(`fn_billing_modo_leitura: ${error.message}`);
    }
    return Boolean(data);
  } catch (err) {
    logger.error("alarme_planos_leitura", {
      organization_id: organizationId,
      etapa: "conta_em_modo_leitura",
      error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
    });
    return false;
  }
}

// ============================================================================
// Variante por pool `pg`: o worker de prospecção (`lib/prospecting/worker.ts`)
// já trabalha inteiro sobre `pg.Pool`/`pg.PoolClient` (o `SupabaseClient` dele
// só aparece nos efeitos que já são HTTP mesmo, como o envio). Mesma regra;
// cache PRÓPRIO por `pg.Pool` (não compartilhado com o cache por
// `SupabaseClient` acima, nem com o de `run-model-call.ts`, que é de outro
// consumidor/processo, mesmo desenho de `modoDeBillingPeloDb`, F3).
// ============================================================================

const TTL_MODO_POOL_MS = 60_000;
const modoPorPool = new WeakMap<pg.Pool, { modo: string | null; expiraEm: number }>();

async function modoDeBillingCacheadoPeloPool(pool: pg.Pool): Promise<string | null> {
  const cache = modoPorPool.get(pool);
  if (cache && cache.expiraEm > Date.now()) return cache.modo;
  const { rows } = await pool.query<{ modo: string | null }>(
    "select modo from public.billing_settings where id = 1",
  );
  const modo = rows[0]?.modo ?? null;
  modoPorPool.set(pool, { modo, expiraEm: Date.now() + TTL_MODO_POOL_MS });
  return modo;
}

export async function contaEmModoLeituraPeloPool(
  pool: pg.Pool,
  organizationId: string,
): Promise<boolean> {
  try {
    const modo = await modoDeBillingCacheadoPeloPool(pool);
    if (modo !== "bloquear") {
      return false;
    }

    const { rows } = await pool.query<{ modo_leitura: boolean | null }>(
      "select public.fn_billing_modo_leitura($1) as modo_leitura",
      [organizationId],
    );
    return Boolean(rows[0]?.modo_leitura);
  } catch (err) {
    logger.error("alarme_planos_leitura", {
      organization_id: organizationId,
      etapa: "conta_em_modo_leitura_pelo_pool",
      error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
    });
    return false;
  }
}
