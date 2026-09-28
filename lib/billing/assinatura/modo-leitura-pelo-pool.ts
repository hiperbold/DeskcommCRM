/**
 * Variante por pool `pg` de `contaEmModoLeitura` (`./modo-leitura.ts`), extraída
 * para o PRÓPRIO arquivo (pós-junção, 2026-09-27): `lib/ai/decisao/roteador.ts`
 * (módulo do Jev) importa só esta função, e a cerca
 * `tests/unit/jev-nunca-cala-bloqueia-nem-responde.test.ts` reprova qualquer
 * `.rpc()` alcançável a partir do Jev, mesmo um que o Jev nunca chama, se
 * estiver no MESMO arquivo (a cerca varre o arquivo inteiro, não só o que foi
 * importado). `./modo-leitura.ts` continua tendo `contaEmModoLeitura` (a
 * variante por `SupabaseClient`, que usa `admin.rpc(...)`), e este arquivo
 * nunca a importa nem é importado por ela: os dois ficam sem `.rpc()` nenhum
 * aqui, sem `admin`, sem cliente HTTP.
 *
 * `./modo-leitura.ts` reexporta `contaEmModoLeituraPeloPool` daqui, então todo
 * chamador que já importava pela rota antiga continua igual, só o roteador do
 * Jev passou a importar direto daqui, para nunca alcançar o arquivo com o
 * `.rpc()`.
 *
 * Mesma doutrina de `./modo-leitura.ts`: leitura que falha NUNCA bloqueia um
 * produtor (devolve `false`) e grita `alarme_planos_leitura` no log.
 */
import type pg from "pg";

import { logger } from "@/lib/logger";

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
