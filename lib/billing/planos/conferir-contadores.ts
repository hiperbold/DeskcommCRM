/**
 * A borda para `fn_billing_conferir_contadores()` (migration 0905, Tarefa 5
 * da fase F2): o conferidor diário do contador materializado de leads.
 *
 * A REGRA inteira mora no banco: por organização, a função trava a linha do
 * contador (`select ... for update`), só DEPOIS conta os leads abertos de
 * verdade num comando seguinte e corrige o valor, e devolve quantos
 * contadores estavam divergentes. Aqui é só I/O, mesmo desenho de
 * `podarHistorico` (data-retention) e `sincronizarCatalogo`
 * (sync-model-catalog): a função pura fica isolada da borda HTTP para o
 * teste exercitar a REGRA sem montar request/auth, e para route.ts só
 * exportar os handlers.
 *
 * `execute` nesta função é só para `service_role` (0905, Tarefa 2): por
 * isso ela é chamada com `createAdminClient()`, nunca com o cliente da
 * sessão do usuário.
 *
 * Erro do banco SOBE (não é engolido aqui): quem decide o que fazer com ele
 * é o chamador. Na rota de cron, vira resposta de erro com frase fixa: o
 * texto de dentro do erro do Postgres só vai para o log, nunca para o corpo
 * da resposta HTTP.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Só a superfície que este conferidor usa; o teste injeta uma
 * implementação, como `PodaDb` em data-retention.
 */
export interface ConferidorDeContadoresDb {
  rpc(
    nome: "fn_billing_conferir_contadores",
    args: Record<string, never>,
  ): Promise<{ data: number | null; error: { message: string } | null }>;
}

/**
 * Monta o `ConferidorDeContadoresDb` sobre um `SupabaseClient` de verdade.
 * `fn_billing_conferir_contadores` é nova e não está em
 * `lib/database.types.ts` (gerado a partir de um projeto Supabase vivo),
 * mesmo tratamento que as outras rotas de cron dão a função recém-nascida.
 */
export function conferidorDeContadoresSobre(admin: SupabaseClient): ConferidorDeContadoresDb {
  return {
    async rpc(nome, args) {
      const { data, error } = await admin.rpc(nome as never, args as never);
      return { data: typeof data === "number" ? data : null, error };
    },
  };
}

/**
 * Chama `fn_billing_conferir_contadores()` e devolve quantos contadores
 * estavam divergentes (0 quando nenhum estava).
 */
export async function conferirContadoresDePlano(db: ConferidorDeContadoresDb): Promise<number> {
  const { data, error } = await db.rpc("fn_billing_conferir_contadores", {});
  if (error) {
    // A mensagem do Postgres pode citar nome de coluna/tabela: não é para o
    // corpo da resposta HTTP, só para quem lê o log do servidor.
    throw new Error(`fn_billing_conferir_contadores: ${error.message}`);
  }
  return data ?? 0;
}
