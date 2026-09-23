/**
 * A borda para `fn_billing_conferir_contador(p_org)` (migration 0905, Tarefa
 * 5 da fase F2): o conferidor diário do contador materializado de leads.
 *
 * Achado 3 (revisão fase F2): a função de banco deixou de ser
 * `fn_billing_conferir_contadores()` (sem argumento, todas as organizações
 * numa transação/RPC só, com `for update` de cada linha solto só no commit
 * final) e virou `fn_billing_conferir_contador(p_org)`, uma organização por
 * chamada. Segurar a trava de todas até o fim fazia todo lead criado ou
 * fechado numa organização já conferida esperar, e a sessão `authenticated`
 * tem `lock_timeout` curto, o erro é engolido no gatilho de
 * `fn_billing_trava_crm_leads`, e a contagem se perde: a própria divergência
 * que este conferidor existe para corrigir.
 *
 * Por isso a REGRA de iteração agora mora AQUI, não só no banco: lista as
 * organizações (`organizations`, só o `id`, paginado, mesmo desenho de
 * `lib/mcp/tools/comercio.ts`: página vazia prova o fim, ordem estável por
 * `id`) e chama a RPC nova uma por uma. Cada chamada é a SUA PRÓPRIA
 * transação: não há transação do lado do cliente amarrando várias, e uma
 * organização que falha vira `log.warn` e a rodada SEGUE para a próxima
 * (decisão 11 da 0905, o mesmo espírito de nada aqui travar a operação).
 *
 * `execute` na função de banco é só para `service_role` (0905, Tarefa 2): por
 * isso ela é chamada com `createAdminClient()`, nunca com o cliente da sessão
 * do usuário.
 *
 * Erro ao LISTAR organizações SOBE (não é engolido): sem a lista não há
 * rodada nenhuma para tentar, diferente de uma organização individual
 * falhando no meio dela. Quem decide o que fazer com esse erro é o chamador
 * (a rota de cron, que vira resposta de erro com frase fixa).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

/** Página de listagem de organizações, mesmo desenho de comercio.ts. */
const TAMANHO_DA_PAGINA = 500;

/**
 * Só a superfície que este conferidor usa; o teste injeta uma implementação,
 * como `PodaDb` em data-retention.
 */
export interface ConferidorDeContadoresDb {
  /** `organizations`, só `id`, ordem estável, página `[de, ate]` inclusive. */
  listarOrganizacoes(
    de: number,
    ate: number,
  ): Promise<{ data: Array<{ id: string }> | null; error: { message: string } | null }>;
  rpc(
    nome: "fn_billing_conferir_contador",
    args: { p_org: string },
  ): Promise<{ data: boolean | null; error: { message: string } | null }>;
}

/**
 * Monta o `ConferidorDeContadoresDb` sobre um `SupabaseClient` de verdade.
 * `fn_billing_conferir_contador` é nova e não está em
 * `lib/database.types.ts` (gerado a partir de um projeto Supabase vivo),
 * mesmo tratamento que as outras rotas de cron dão a função recém-nascida.
 */
export function conferidorDeContadoresSobre(admin: SupabaseClient): ConferidorDeContadoresDb {
  return {
    async listarOrganizacoes(de, ate) {
      const { data, error } = await admin
        .from("organizations")
        .select("id")
        .order("id", { ascending: true })
        .range(de, ate);
      return { data: (data as Array<{ id: string }> | null) ?? null, error };
    },
    async rpc(nome, args) {
      const { data, error } = await admin.rpc(nome as never, args as never);
      return { data: typeof data === "boolean" ? data : null, error };
    },
  };
}

/**
 * Lista TODAS as organizações (paginado) e chama
 * `fn_billing_conferir_contador(p_org)` uma por uma. Devolve quantas
 * organizações estavam com o contador divergente (0 quando nenhuma estava).
 *
 * Uma organização que falha (RPC devolve `error`) vira `log.warn` e NÃO
 * interrompe a rodada: as demais organizações continuam sendo conferidas.
 * Erro ao listar a PÁGINA de organizações, esse sim, sobe: sem a lista não
 * há o que conferir no resto da rodada.
 */
export async function conferirContadoresDePlano(db: ConferidorDeContadoresDb): Promise<number> {
  let divergiam = 0;

  for (let pagina = 0; ; pagina++) {
    const de = pagina * TAMANHO_DA_PAGINA;
    const ate = de + TAMANHO_DA_PAGINA - 1;
    const { data: lote, error } = await db.listarOrganizacoes(de, ate);
    if (error) {
      // A mensagem do Postgres pode citar nome de coluna/tabela: não é para o
      // corpo da resposta HTTP, só para quem lê o log do servidor.
      throw new Error(`organizations: ${error.message}`);
    }

    const organizacoes = lote ?? [];
    for (const org of organizacoes) {
      const { data, error: erroRpc } = await db.rpc("fn_billing_conferir_contador", { p_org: org.id });
      if (erroRpc) {
        // Uma organização que falha não derruba a rodada (achado 3): loga e
        // segue para a próxima. O log carrega o texto do Postgres; a chamada
        // desta função nunca lança por causa de uma organização só.
        logger.warn("[conferir-contadores-de-plano] organização falhou, rodada segue", {
          organization_id: org.id,
          causa: erroRpc.message,
        });
        continue;
      }
      if (data === true) divergiam++;
    }

    // Página vazia = não há mais organização. Vale mesmo sem count exato.
    if (organizacoes.length < TAMANHO_DA_PAGINA) break;
  }

  return divergiam;
}
