/**
 * A borda para `fn_billing_conferir_vencimento(p_org)` (migração 0908, fase
 * F4, Tarefa 5): o conferidor diário do vencimento da assinatura.
 *
 * Mesmo desenho de `lib/billing/planos/conferir-contadores.ts` (fase F2,
 * Tarefa 5, o irmão mais simples desta família: uma RPC por organização,
 * sem passos extras como o débito pendente da carteira de tokens): a REGRA
 * de iteração mora AQUI, não só no banco. Lista as organizações
 * (`organizations`, só o `id`, paginado, ordem estável por `id`, página
 * vazia prova o fim) e chama `fn_billing_conferir_vencimento(p_org)` uma por
 * uma. Cada chamada é a SUA PRÓPRIA transação.
 *
 * A função de banco (decisão 4 da fase, comentário completo na migração
 * 0908) já nunca lança: erro interno numa organização vira `raise warning` +
 * `null` DENTRO da própria função. O `error` que este conferidor trata aqui
 * é outra camada, a de transporte (permissão, rede, timeout do Postgres):
 * mesmo assim, uma organização que falha vira `log.warn` e a rodada SEGUE
 * para a próxima (mesmo espírito da decisão 11 da 0905 e do conferidor
 * irmão de contadores).
 *
 * O resumo conta quantas organizações mudaram para CADA estado (o texto que
 * a RPC devolve: `'atrasada'`, `'suspensa'` ou `'cancelada'`; `null` é "não
 * mudou", e não entra em nenhuma contagem). Nunca expõe texto do Postgres no
 * resumo: toda mensagem de erro do banco fica presa no `log.warn`, nunca
 * sobe até a resposta HTTP da rota.
 *
 * Erro ao LISTAR a página de organizações SOBE (não é engolido): sem a lista
 * não há rodada nenhuma para tentar. Uma organização individual que falha
 * (a RPC devolve `error` de transporte) NÃO interrompe a rodada.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

/** Página de listagem de organizações, mesmo desenho dos conferidores irmãos. */
const TAMANHO_DA_PAGINA = 500;

interface ErroRpc {
  message: string;
}

/**
 * Os três estados que `fn_billing_conferir_vencimento` pode devolver quando
 * MUDA algo (decisão 4 da fase, ordem fixa: cancelada por
 * `cancel_at_period_end`, atrasada por período vencido, suspensa por
 * carência vencida). `null` (organização sem mudança) não é um destes três.
 */
const ESTADOS_DE_DESTINO = ["atrasada", "suspensa", "cancelada"] as const;
type EstadoDeDestino = (typeof ESTADOS_DE_DESTINO)[number];

function ehEstadoDeDestino(valor: string): valor is EstadoDeDestino {
  return (ESTADOS_DE_DESTINO as readonly string[]).includes(valor);
}

/**
 * Só a superfície que este conferidor usa; o teste injeta uma implementação,
 * como `ConferidorDeContadoresDb`/`ConferidorDeCarteiraDb` dos irmãos.
 */
export interface ConferidorDeVencimentosDb {
  /** `organizations`, só `id`, ordem estável, página `[de, ate]` inclusive. */
  listarOrganizacoes(
    de: number,
    ate: number,
  ): Promise<{ data: Array<{ id: string }> | null; error: ErroRpc | null }>;
  /** `fn_billing_conferir_vencimento(p_org)`: o estado novo, ou `null` (nada mudou). */
  conferirVencimento(pOrg: string): Promise<{ data: string | null; error: ErroRpc | null }>;
}

/**
 * Monta o `ConferidorDeVencimentosDb` sobre um `SupabaseClient` de verdade.
 * `fn_billing_conferir_vencimento` é nova (migração 0908) e não está em
 * `lib/database.types.ts`, mesmo tratamento que os conferidores irmãos dão a
 * função recém-nascida.
 */
export function conferidorDeVencimentosSobre(admin: SupabaseClient): ConferidorDeVencimentosDb {
  return {
    async listarOrganizacoes(de, ate) {
      const { data, error } = await admin
        .from("organizations")
        .select("id")
        .order("id", { ascending: true })
        .range(de, ate);
      return { data: (data as Array<{ id: string }> | null) ?? null, error };
    },
    async conferirVencimento(pOrg) {
      const { data, error } = await admin.rpc("fn_billing_conferir_vencimento" as never, {
        p_org: pOrg,
      } as never);
      return { data: typeof data === "string" ? data : null, error };
    },
  };
}

/**
 * O que a rodada avisa depois de a RPC mudar um estado (COB-06, conta suspensa). Opcional: sem ele a rodada é a
 * de sempre. O aviso roda logo DEPOIS de a RPC ter gravado a suspensão, dentro do laço, e só ENFILEIRA o e-mail
 * (sem SMTP; o cron `enviar-emails-de-conta` envia). Nunca interrompe a rodada: o gatilho engole a própria
 * falha, e este laço engole a que escapar.
 */
export interface AvisosDeVencimento {
  aoSuspender?: (organizationId: string) => Promise<void>;
}

async function avisarSuspensao(avisos: AvisosDeVencimento, organizationId: string): Promise<void> {
  if (!avisos.aoSuspender) return;
  try {
    await avisos.aoSuspender(organizationId);
  } catch (erro) {
    logger.warn("[conferir-vencimentos] o aviso de conta suspensa falhou, rodada segue", {
      organization_id: organizationId,
      causa: erro instanceof Error ? erro.message.slice(0, 120) : "erro",
    });
  }
}

export interface ResumoDoConferidorDeVencimentos {
  /** Quantas organizações a rodada percorreu (paginação completa). */
  organizacoesVistas: number;
  /** Quantas organizações a RPC moveu para `atrasada` nesta rodada. */
  mudaramParaAtrasada: number;
  /** Quantas organizações a RPC moveu para `suspensa` nesta rodada. */
  mudaramParaSuspensa: number;
  /** Quantas organizações a RPC moveu para `cancelada` nesta rodada. */
  mudaramParaCancelada: number;
  /** Organizações em que a chamada da RPC falhou (erro de transporte). */
  organizacoesQueFalharam: number;
}

/**
 * Lista TODAS as organizações (paginado) e chama
 * `fn_billing_conferir_vencimento(p_org)` uma por uma. Devolve o resumo com
 * quantas organizações mudaram para cada estado.
 *
 * Uma organização que falha (a RPC devolve `error` de transporte) vira
 * `log.warn` e NÃO interrompe a rodada: as demais organizações continuam
 * sendo conferidas. Erro ao listar a PÁGINA de organizações, esse sim, sobe:
 * sem a lista não há o que conferir no resto da rodada.
 */
export async function conferirVencimentos(
  db: ConferidorDeVencimentosDb,
  avisos: AvisosDeVencimento = {},
): Promise<ResumoDoConferidorDeVencimentos> {
  let organizacoesVistas = 0;
  let mudaramParaAtrasada = 0;
  let mudaramParaSuspensa = 0;
  let mudaramParaCancelada = 0;
  let organizacoesQueFalharam = 0;

  for (let pagina = 0; ; pagina++) {
    const de = pagina * TAMANHO_DA_PAGINA;
    const ate = de + TAMANHO_DA_PAGINA - 1;
    const { data: lote, error } = await db.listarOrganizacoes(de, ate);
    if (error) {
      // A mensagem do Postgres pode citar nome de coluna/tabela: não é para
      // o corpo da resposta HTTP, só para quem lê o log do servidor.
      throw new Error(`organizations: ${error.message}`);
    }

    const organizacoes = lote ?? [];
    for (const org of organizacoes) {
      organizacoesVistas++;

      const { data: estadoNovo, error: erroRpc } = await db.conferirVencimento(org.id);
      if (erroRpc) {
        logger.warn("[conferir-vencimentos] organização falhou, rodada segue", {
          organization_id: org.id,
          causa: erroRpc.message,
        });
        organizacoesQueFalharam++;
        continue;
      }

      if (estadoNovo !== null && ehEstadoDeDestino(estadoNovo)) {
        if (estadoNovo === "atrasada") mudaramParaAtrasada++;
        else if (estadoNovo === "suspensa") {
          mudaramParaSuspensa++;
          // COB-06 só quando a transição DEVOLVEU suspensa: o gatilho lê o contrato agora, no instante da
          // suspensão, e enfileira o e-mail com o período que foi suspenso.
          await avisarSuspensao(avisos, org.id);
        } else mudaramParaCancelada++;
      }
    }

    // Página vazia = não há mais organização. Vale mesmo sem count exato.
    if (organizacoes.length < TAMANHO_DA_PAGINA) break;
  }

  return {
    organizacoesVistas,
    mudaramParaAtrasada,
    mudaramParaSuspensa,
    mudaramParaCancelada,
    organizacoesQueFalharam,
  };
}
