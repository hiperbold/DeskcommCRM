/**
 * A borda para os conferidores diários da carteira de tokens de IA (fase
 * F2-B, Tarefa 8, migração 0906 Parte 4): débito pendente (decisão 12),
 * carteira materializada (decisão 8) e teto da instalação (decisão 15).
 *
 * Mesmo desenho de `lib/billing/planos/conferir-contadores.ts` (fase F2,
 * Tarefa 5): a REGRA de iteração mora aqui, não só no banco. Lista as
 * organizações (`organizations`, só o `id`, paginado, ordem estável por
 * `id`, mesmo desenho de `comercio.ts`: página vazia prova o fim) e, por
 * organização, chama as RPCs da carteira. Cada RPC é a SUA PRÓPRIA
 * transação: não há transação do lado do cliente amarrando várias.
 *
 * ─── Por que os passos (a) e (b) andam JUNTOS por organização ─────────────
 *
 * `fn_billing_debitos_pendentes` e `fn_billing_debitar_chamada` (decisão 12)
 * recuperam chamada que deveria ter debitado e não debitou (gatilho que
 * perdeu a corrida pela trava, erro engolido, etc.); `fn_billing_conferir_
 * carteira` (decisão 8) confere o SALDO MATERIALIZADO contra o livro-caixa.
 * Rodar o débito pendente ANTES da conferência de carteira, na mesma
 * organização, evita o conferidor de carteira corrigir um saldo que já ia
 * mudar de novo no minuto seguinte por causa de um débito atrasado que
 * ficou para trás.
 *
 * Uma organização que falha (qualquer uma das RPCs devolve `error`) vira
 * `log.warn` e a rodada SEGUE para a próxima (mesmo espírito da decisão 11
 * da 0905): o restante dos passos dessa organização é abandonado nesta
 * rodada (o conferidor de amanhã tenta de novo do zero), mas as demais
 * organizações continuam sendo conferidas.
 *
 * ─── O limite de voltas por organização (débitos pendentes) ───────────────
 *
 * `fn_billing_debitos_pendentes(p_org, p_limite)` devolve no máximo
 * `p_limite` ids por chamada (anti-join, decisão 12); enquanto a página
 * vier CHEIA (== p_limite), pode haver mais. Sem um teto de voltas, uma
 * organização com um volume de pendência fora do normal (por exemplo um
 * defeito que travou o gatilho por dias) prenderia a rodada inteira
 * debitando só ela, e as demais organizações ficariam sem conferidor
 * naquele dia. `MAX_VOLTAS_DE_DEBITOS_POR_ORGANIZACAO` limita isso: ao
 * bater no teto, a organização fica com o QUE JÁ FOI recuperado nesta
 * rodada, um `log.warn` marca o corte, e o resto entra na rodada seguinte
 * (o anti-join da própria RPC garante que o que já foi debitado não volta
 * a aparecer).
 *
 * ─── O teto da instalação (decisão 15), depois das organizações ───────────
 *
 * Nunca dentro do laço por organização: comparar o consumo de TODAS as
 * organizações com um teto único é uma pergunta sobre a instalação inteira,
 * não sobre uma organização, e fazê-la por organização repetiria a mesma
 * soma N vezes à toa. Lê `billing_settings.teto_instalacao_tokens_dia`
 * (nulo = desligado, decisão 15) e, quando ligado, soma o consumo do DIA
 * ANTERIOR COMPLETO no fuso `America/Sao_Paulo` (`fn_billing_consumo_da_
 * instalacao_no_dia`, decisão 4: o dia do agregado usa o mesmo fuso do
 * ciclo, nunca UTC).
 *
 * Item 12 da revisão (23/09/2026): o scheduler roda em UTC
 * (`docker-compose.prod.yml`, `TZ: UTC`) e este cron dispara às 05:25 UTC
 * (`docker/scheduler/entrypoint.sh`), que são 02:25 em São Paulo, ainda
 * dentro do MESMO dia civil paulista, só que com 2h25 dele decorridas.
 * Conferir "hoje" (`hojeNoFusoDaCarteira`) comparava o teto DIÁRIO contra um
 * dia que mal começou, e nunca contra um dia inteiro: a checagem nunca via o
 * consumo real de nenhum dia completo. O dia que de fato TERMINOU e tem
 * consumo fechado para comparar às 02:25 é o ANTERIOR
 * (`diaAnteriorNoFusoDaCarteira`, abaixo).
 *
 * Passou do teto: alarme em log (prefixo `alarme_planos_...`, a mesma
 * família de `alarme_planos_leitura` já usada em toda `lib/billing/`) e
 * `tetoDaInstalacaoPassou: true` no resumo. NESTA FASE só avisa (decisão
 * 15): não há bloqueio nenhum aqui, e o destino de alarme próprio da
 * plataforma citado na decisão 15 ainda não existe (registrado no DEBITO).
 * Falha ao LER o teto (settings ou a soma) não derruba a rodada: já é tarde
 * demais para as organizações, que foram conferidas com sucesso; vira o
 * mesmo `alarme_planos_leitura` das irmãs de `lib/billing/tokens/`.
 *
 * ─── Nunca expõe texto do Postgres no resumo ───────────────────────────────
 *
 * O resumo devolvido por `conferirCarteiraDeTokens` só tem números e
 * booleanos; toda mensagem de erro do banco fica presa no `log.warn`/
 * `log.error`, nunca sobe até a resposta HTTP da rota.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

/** Página de listagem de organizações, mesmo desenho de conferir-contadores.ts. */
const TAMANHO_DA_PAGINA = 500;

/**
 * `p_limite` de `fn_billing_debitos_pendentes` por volta, o próprio padrão
 * da função no banco (migração 0906, item 24).
 */
const LIMITE_DE_DEBITOS_POR_VOLTA = 500;

/**
 * Teto de voltas de `fn_billing_debitos_pendentes` por organização, POR
 * RODADA. 20 voltas × 500 = até 10.000 débitos pendentes recuperados por
 * organização por dia, folgado para o que este conferidor existe para
 * pegar (o gatilho já debita quase tudo em tempo real; isto é só o que
 * escapou dele), sem deixar uma organização com defeito grave prender a
 * rodada por tempo indefinido.
 */
const MAX_VOLTAS_DE_DEBITOS_POR_ORGANIZACAO = 20;

/** O fuso do ciclo e do agregado diário (decisão 4 da fase F2-B). */
const FUSO_DA_CARTEIRA = "America/Sao_Paulo";

interface ErroRpc {
  message: string;
}

/**
 * Só a superfície que este conferidor usa; o teste injeta uma implementação,
 * como `ConferidorDeContadoresDb` em conferir-contadores.ts.
 */
export interface ConferidorDeCarteiraDb {
  /** `organizations`, só `id`, ordem estável, página `[de, ate]` inclusive. */
  listarOrganizacoes(
    de: number,
    ate: number,
  ): Promise<{ data: Array<{ id: string }> | null; error: ErroRpc | null }>;
  /** `fn_billing_debitos_pendentes(p_org, p_limite)`: ids de `llm_calls` sem débito. */
  debitosPendentes(
    pOrg: string,
    pLimite: number,
  ): Promise<{ data: string[] | null; error: ErroRpc | null }>;
  /** `fn_billing_debitar_chamada(p_llm_call_id)`: `true` só quando debitou agora. */
  debitarChamada(pLlmCallId: string): Promise<{ data: boolean | null; error: ErroRpc | null }>;
  /** `fn_billing_conferir_carteira(p_org)`: quantas linhas de saldo divergiam (0 = íntegra). */
  conferirCarteira(pOrg: string): Promise<{ data: number | null; error: ErroRpc | null }>;
  /** `billing_settings.teto_instalacao_tokens_dia` (linha única, id = 1). Nulo = desligado. */
  tetoDaInstalacao(): Promise<{ data: number | null; error: ErroRpc | null }>;
  /** `fn_billing_consumo_da_instalacao_no_dia(p_dia)`: soma do dia, todas as organizações. */
  consumoDaInstalacaoNoDia(dia: string): Promise<{ data: number | null; error: ErroRpc | null }>;
}

/** `bigint`/`numeric` do Postgres pode voltar como `number` OU `string` pelo PostgREST. */
function comoNumero(valor: unknown): number | null {
  if (typeof valor === "number") return valor;
  if (typeof valor === "string" && valor.trim() !== "") {
    const n = Number(valor);
    if (!Number.isNaN(n)) return n;
  }
  return null;
}

/**
 * Monta o `ConferidorDeCarteiraDb` sobre um `SupabaseClient` de verdade.
 * As quatro funções da Parte 4 da migração 0906 são novas e não estão em
 * `lib/database.types.ts`, mesmo tratamento que as outras rotas de cron dão
 * a função recém-nascida (ver conferir-contadores.ts).
 */
export function conferidorDeCarteiraSobre(admin: SupabaseClient): ConferidorDeCarteiraDb {
  return {
    async listarOrganizacoes(de, ate) {
      const { data, error } = await admin
        .from("organizations")
        .select("id")
        .order("id", { ascending: true })
        .range(de, ate);
      return { data: (data as Array<{ id: string }> | null) ?? null, error };
    },
    async debitosPendentes(pOrg, pLimite) {
      const { data, error } = await admin.rpc("fn_billing_debitos_pendentes" as never, {
        p_org: pOrg,
        p_limite: pLimite,
      } as never);
      return { data: Array.isArray(data) ? (data as string[]) : null, error };
    },
    async debitarChamada(pLlmCallId) {
      const { data, error } = await admin.rpc("fn_billing_debitar_chamada" as never, {
        p_llm_call_id: pLlmCallId,
      } as never);
      return { data: typeof data === "boolean" ? data : null, error };
    },
    async conferirCarteira(pOrg) {
      const { data, error } = await admin.rpc("fn_billing_conferir_carteira" as never, {
        p_org: pOrg,
      } as never);
      return { data: comoNumero(data), error };
    },
    async tetoDaInstalacao() {
      const { data, error } = await admin
        .from("billing_settings")
        .select("teto_instalacao_tokens_dia")
        .eq("id", 1)
        .maybeSingle();
      const linha = data as { teto_instalacao_tokens_dia: unknown } | null;
      return { data: linha ? comoNumero(linha.teto_instalacao_tokens_dia) : null, error };
    },
    async consumoDaInstalacaoNoDia(dia) {
      const { data, error } = await admin.rpc("fn_billing_consumo_da_instalacao_no_dia" as never, {
        p_dia: dia,
      } as never);
      return { data: comoNumero(data), error };
    },
  };
}

/** "Hoje", `YYYY-MM-DD`, no fuso da carteira (decisão 4/15), nunca UTC. */
function hojeNoFusoDaCarteira(agora: Date): string {
  const partes = new Intl.DateTimeFormat("en-CA", {
    timeZone: FUSO_DA_CARTEIRA,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(agora);
  const ano = partes.find((p) => p.type === "year")?.value;
  const mes = partes.find((p) => p.type === "month")?.value;
  const dia = partes.find((p) => p.type === "day")?.value;
  if (!ano || !mes || !dia) {
    throw new Error("não foi possível calcular o dia local para o teto da instalação");
  }
  return `${ano}-${mes}-${dia}`;
}

/**
 * O dia ANTERIOR completo, `YYYY-MM-DD`, no fuso da carteira. Item 12 da
 * revisão: o scheduler dispara às 05:25 UTC = 02:25 em São Paulo, ainda
 * dentro do dia civil paulista corrente (só que com 2h25 dele decorridas).
 * O teto da instalação é DIÁRIO: o dia que já fechou e tem consumo completo
 * para comparar nesse horário é o de ONTEM, não o de hoje. Subtrai sobre o
 * texto `YYYY-MM-DD` (via `Date.UTC`, sem fuso) em vez de subtrair 24h do
 * `Date` de `agora`: subtrair horas de um instante e só depois formatar no
 * fuso local pode acertar o dia errado perto de uma transição de horário de
 * verão (Brasil não tem mais DST, mas o cálculo fica correto mesmo assim).
 */
function diaAnteriorNoFusoDaCarteira(agora: Date): string {
  const hoje = hojeNoFusoDaCarteira(agora);
  const [ano, mes, dia] = hoje.split("-").map(Number);
  const ontem = new Date(Date.UTC(ano!, mes! - 1, dia! - 1));
  const anoOntem = String(ontem.getUTCFullYear());
  const mesOntem = String(ontem.getUTCMonth() + 1).padStart(2, "0");
  const diaOntem = String(ontem.getUTCDate()).padStart(2, "0");
  return `${anoOntem}-${mesOntem}-${diaOntem}`;
}

export interface ResumoDoConferidorDeCarteira {
  /** Quantas organizações a rodada percorreu (paginação completa). */
  organizacoesVistas: number;
  /** Soma de `debitarChamada` que devolveu `true` em todas as organizações. */
  debitosRecuperados: number;
  /**
   * Quantas ORGANIZAÇÕES tinham a carteira divergente (`fn_billing_conferir_
   * carteira` devolveu > 0), não a soma bruta de linhas corrigidas: o
   * resumo conta organização, o mesmo grão de `divergiam` no conferidor de
   * contadores irmão.
   */
  carteirasCorrigidas: number;
  /** Organizações em que alguma RPC falhou (débito pendente ou conferência). */
  organizacoesQueFalharam: number;
  /** Teto da instalação (decisão 15) ligado e ultrapassado hoje. */
  tetoDaInstalacaoPassou: boolean;
}

/**
 * Recupera os débitos pendentes de UMA organização, em voltas de até
 * `LIMITE_DE_DEBITOS_POR_VOLTA`, até `MAX_VOLTAS_DE_DEBITOS_POR_ORGANIZACAO`.
 * Devolve quantos débitos recuperou e se a organização falhou (RPC com
 * `error`); falha nesta etapa pula direto para a próxima organização, sem
 * chamar `fn_billing_conferir_carteira` (o saldo dela pode estar velho por
 * causa do débito que não terminou de rodar).
 */
async function debitarPendentesDaOrganizacao(
  db: ConferidorDeCarteiraDb,
  organizationId: string,
): Promise<{ recuperados: number; falhou: boolean }> {
  let recuperados = 0;

  for (let volta = 1; volta <= MAX_VOLTAS_DE_DEBITOS_POR_ORGANIZACAO; volta++) {
    const { data: pendentes, error } = await db.debitosPendentes(
      organizationId,
      LIMITE_DE_DEBITOS_POR_VOLTA,
    );
    if (error) {
      logger.warn("[conferir-carteira-de-tokens] débitos pendentes falhou, organização pulada", {
        organization_id: organizationId,
        causa: error.message,
      });
      return { recuperados, falhou: true };
    }

    const ids = pendentes ?? [];
    for (const id of ids) {
      const { data: debitou, error: erroDebito } = await db.debitarChamada(id);
      if (erroDebito) {
        logger.warn(
          "[conferir-carteira-de-tokens] débito de chamada pendente falhou, organização pulada",
          { organization_id: organizationId, llm_call_id: id, causa: erroDebito.message },
        );
        return { recuperados, falhou: true };
      }
      if (debitou === true) recuperados++;
    }

    // Página não veio cheia: não há mais pendente para esta organização.
    if (ids.length < LIMITE_DE_DEBITOS_POR_VOLTA) break;

    if (volta === MAX_VOLTAS_DE_DEBITOS_POR_ORGANIZACAO) {
      logger.warn(
        "[conferir-carteira-de-tokens] organização bateu no limite de voltas de débitos " +
          "pendentes, o resto fica para a próxima rodada",
        { organization_id: organizationId, voltas: MAX_VOLTAS_DE_DEBITOS_POR_ORGANIZACAO },
      );
    }
  }

  return { recuperados, falhou: false };
}

/**
 * Confere o teto da instalação (decisão 15): lê `teto_instalacao_tokens_dia`
 * e, se ligado, compara com o consumo do DIA ANTERIOR COMPLETO (fuso da
 * carteira) de TODAS as organizações (item 12 da revisão: às 02:25 em São
 * Paulo, horário em que este cron roda, "hoje" mal começou; "ontem" é o
 * único dia com consumo fechado para comparar contra um teto diário). Nunca
 * lança: falha de leitura vira `alarme_planos_leitura` e a checagem
 * simplesmente não roda nesta rodada (o cron de amanhã tenta de novo).
 * Devolve `true` só quando o teto está ligado E foi ultrapassado.
 */
async function confereTetoDaInstalacao(db: ConferidorDeCarteiraDb, agora: Date): Promise<boolean> {
  try {
    const { data: teto, error: erroTeto } = await db.tetoDaInstalacao();
    if (erroTeto) throw new Error(`billing_settings: ${erroTeto.message}`);
    if (teto === null) return false; // decisão 15: nulo = desligado.

    // Item 12 da revisão: o dia ANTERIOR completo, não "hoje" (ver o
    // comentário do bloco "O teto da instalação" no topo do arquivo e de
    // `diaAnteriorNoFusoDaCarteira`).
    const dia = diaAnteriorNoFusoDaCarteira(agora);
    const { data: consumo, error: erroConsumo } = await db.consumoDaInstalacaoNoDia(dia);
    if (erroConsumo) {
      throw new Error(`fn_billing_consumo_da_instalacao_no_dia: ${erroConsumo.message}`);
    }
    const consumoDoDia = consumo ?? 0;

    if (consumoDoDia > teto) {
      // Prefixo `alarme_` da família já usada em `lib/billing/` (ver
      // `alarme_planos_leitura`). Nesta fase só o log: a aba própria da
      // plataforma para este alarme não existe (decisão 15, registrado no
      // DEBITO).
      logger.error("alarme_planos_teto_instalacao", {
        dia,
        teto_instalacao_tokens_dia: teto,
        consumo_do_dia: consumoDoDia,
      });
      return true;
    }
    return false;
  } catch (err) {
    logger.error("alarme_planos_leitura", {
      contexto: "teto_instalacao",
      error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
    });
    return false;
  }
}

/**
 * Lista TODAS as organizações (paginado) e, uma por uma: recupera débitos
 * pendentes (decisão 12) e confere a carteira materializada (decisão 8).
 * Depois de percorrer todas, confere o teto da instalação (decisão 15).
 *
 * `agora` é PARÂMETRO (não `new Date()` interno) para o teste controlar o
 * dia do teto da instalação sem mockar relógio global.
 *
 * Erro ao LISTAR a página de organizações SOBE (não é engolido): sem a
 * lista não há rodada nenhuma para tentar. Uma organização individual que
 * falha vira `log.warn` e NÃO interrompe a rodada.
 */
export async function conferirCarteiraDeTokens(
  db: ConferidorDeCarteiraDb,
  agora: Date = new Date(),
): Promise<ResumoDoConferidorDeCarteira> {
  let organizacoesVistas = 0;
  let debitosRecuperados = 0;
  let carteirasCorrigidas = 0;
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

      const { recuperados, falhou } = await debitarPendentesDaOrganizacao(db, org.id);
      debitosRecuperados += recuperados;
      if (falhou) {
        organizacoesQueFalharam++;
        continue;
      }

      const { data: divergiam, error: erroCarteira } = await db.conferirCarteira(org.id);
      if (erroCarteira) {
        logger.warn("[conferir-carteira-de-tokens] conferir carteira falhou, organização pulada", {
          organization_id: org.id,
          causa: erroCarteira.message,
        });
        organizacoesQueFalharam++;
        continue;
      }
      if ((divergiam ?? 0) > 0) carteirasCorrigidas++;
    }

    // Página vazia = não há mais organização. Vale mesmo sem count exato.
    if (organizacoes.length < TAMANHO_DA_PAGINA) break;
  }

  const tetoDaInstalacaoPassou = await confereTetoDaInstalacao(db, agora);

  return {
    organizacoesVistas,
    debitosRecuperados,
    carteirasCorrigidas,
    organizacoesQueFalharam,
    tetoDaInstalacaoPassou,
  };
}
