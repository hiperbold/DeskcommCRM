/**
 * A TRAVA DO REGISTRO DO NÚMERO NA API OFICIAL (D-174).
 *
 * Dois pedidos de registro da mesma sessão de canal ao mesmo tempo (duplo clique, duas abas, dois admins)
 * gastariam tentativas do PIN na Meta e, sem PIN informado, gerariam dois PINs diferentes: o que a Meta
 * aceitou primeiro vale, e o que a tela mostrou por último pode ser o outro. O segundo pedido tem de ser
 * recusado ANTES de falar com a Meta.
 *
 * É um advisory lock de SESSÃO do Postgres, com a mesma forma de `withProspectingLock`
 * (`lib/prospecting/store.ts`): vale enquanto a conexão que o tomou existe, então se o processo morrer no
 * meio da chamada à Meta a trava cai junto, sem prazo a vencer nem linha órfã para limpar. Se a conexão
 * não soltar o lock (falha ao soltar), ela é destruída em vez de devolvida ao pool.
 */
import type pg from "pg";

export type ResultadoDaTrava<T> = { ocupado: true } | { ocupado: false; valor: T };

export async function comTravaDeRegistro<T>(
  pool: pg.Pool,
  sessionId: string,
  fn: () => Promise<T>,
): Promise<ResultadoDaTrava<T>> {
  const chave = `registro-numero-oficial:${sessionId}`;
  const db = await pool.connect();
  let tomou = false;
  let destruir = false;
  try {
    const r = await db.query<{ locked: boolean }>("select pg_try_advisory_lock(hashtextextended($1,0)) as locked", [
      chave,
    ]);
    tomou = r.rows[0]?.locked === true;
    if (!tomou) return { ocupado: true };
    return { ocupado: false, valor: await fn() };
  } finally {
    try {
      if (tomou) await db.query("select pg_advisory_unlock(hashtextextended($1,0))", [chave]);
    } catch {
      // Sem conseguir soltar, a única forma de garantir que a trava cai é fechar a conexão.
      destruir = true;
    } finally {
      db.release(destruir);
    }
  }
}
