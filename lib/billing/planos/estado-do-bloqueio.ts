/**
 * "O bloqueio vale para esta organização AGORA, e o quê já está no teto?"
 * (fase F3, tarefa 9, decisões 9 e 10 de hiperbold/planos/fase-F3-tarefas.md).
 *
 * ─── Por que esta leitura existe separada de `bloqueioValeParaOrganizacao` ──
 *
 * `bloqueio-vale.ts` responde só "vale ou não vale?", o suficiente para as
 * pré-checagens de `channels/partner`, `leads/import` e `leads/bulk`. A tela
 * do cliente precisa de mais três coisas que aquela função não expõe: o modo
 * cru (para dizer "desligado" e não simplesmente "não vale"), a data da
 * carência (para dizer "em carência até tal dia") e, quando o bloqueio vale,
 * QUAIS itens estão no teto, com o motivo em português. Por isso esta função
 * lê `billing_settings`/`billing_contracts` de novo, com a MESMA regra (nulo
 * = não bloqueia, data no futuro = carência ainda correndo, modo diferente de
 * `bloquear` sai sem olhar a data) em vez de chamar as duas funções e pagar
 * quatro consultas por duas: só a de `bloqueio-vale.ts` muda, esta muda
 * junto, o comentário de lá está ciente desta função.
 *
 * ─── Modo `avisar` (o de hoje): zero consulta a mais ─────────────────────────
 *
 * Com `vale = false` a função devolve sem ler uso nem limites: nenhuma tela
 * nem servidor pagam o preço de uma consulta a mais enquanto o bloqueio não
 * vale, mesma doutrina de `bloqueio-vale.ts` e do orçamento de IA (decisão 6
 * da fase). Isso também é o que faz o modo `avisar` não desabilitar NADA: sem
 * `itensNoTeto`, nenhum componente encontra motivo para desabilitar um botão.
 *
 * ─── `etapas_por_funil` é o único item POR FUNIL ─────────────────────────────
 *
 * Os outros cinco (funis, leads, membros, conexões, integrações webhook) têm
 * um teto só, por organização: dá para reaproveitar `usoDaOrganizacao` +
 * `planoDaOrganizacao` (a mesma dupla de `app/app/settings/plano/page.tsx`) e
 * ler `estourou` de `linhasDaTelaDePlano`. Etapas por funil é diferente: o
 * teto é por FUNIL, e `fn_billing_uso` só devolve o número do funil com MAIS
 * etapas ativas, não diz QUAL funil, nem serve para decidir se O FUNIL X
 * específico está no teto. Por isso quem chama esta função manda a lista de
 * `pipelineIds` que a tela está desenhando, e só para esses (nunca para toda
 * a organização, que seria uma consulta por funil sem necessidade) ela chama
 * `podeCriar(..., "etapas_por_funil", pipelineId)`, a mesma função que decide
 * o teto de UM funil.
 *
 * ─── Falha de leitura nunca desabilita nada ──────────────────────────────────
 *
 * Cada leitura interna (`usoDaOrganizacao`, `planoDaOrganizacao`, `podeCriar`)
 * já é fail-open e já grita `alarme_planos_leitura` sozinha. Esta função soma
 * os `leituraFalhou` de todas em UM booleano: quando ele é `true`, os itens
 * calculados a partir da leitura que falhou ficam de fora de `itensNoTeto`
 * (nunca aparecem como "no teto" por engano), o mesmo racional de
 * `linhasDaTelaDePlano`, que devolve `estourou: false` para toda leitura que
 * falhou. Uma falha na leitura de `billing_settings`/`billing_contracts` (o
 * PRÓPRIO "vale ou não vale") é mais grave: aí a função devolve `vale: false`
 * direto, igual a `bloqueioValeParaOrganizacao`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Logger } from "@/lib/agent-engine/obs/logger";

import { contaEmModoLeitura } from "@/lib/billing/assinatura/modo-leitura";

import {
  CHAVES_DA_TELA_DE_PLANO,
  linhasDaTelaDePlano,
  type ChaveDaTelaDePlano,
} from "./linhas-da-tela-de-plano";
import { modoDeBillingCacheado } from "./modo-cacheado";
import { podeCriar } from "./pode-criar";
import { planoDaOrganizacao } from "./plano-da-organizacao";
import { usoDaOrganizacao } from "./uso-da-organizacao";

/** As mesmas três chaves de `billing_settings.modo` (ver `bloqueio-da-instalacao.ts`). */
export const MODOS_DE_BLOQUEIO_DA_ORGANIZACAO = ["desligado", "avisar", "bloquear"] as const;
export type ModoDeBloqueioDaOrganizacao = (typeof MODOS_DE_BLOQUEIO_DA_ORGANIZACAO)[number];

/** Um item da organização que já bateu no teto do plano, com o motivo pronto para a tela. */
export interface ItemNoTetoDeBloqueio {
  chave: ChaveDaTelaDePlano;
  /** Só `etapas_por_funil` usa: o funil específico que está no teto. */
  pipelineId: string | null;
  /** "3 de 3 conexões do plano Pro", nunca o texto cru do Postgres. */
  motivo: string;
}

export interface EstadoDoBloqueio {
  /** O bloqueio de verdade vale AGORA para esta organização (modo `bloquear` e carência vencida). */
  vale: boolean;
  /** `billing_settings.modo`, para a tela distinguir "desligado" de "em carência". */
  modo: ModoDeBloqueioDaOrganizacao;
  /** `billing_contracts.bloqueio_a_partir_de`, cru, `null` = sem carência programada. */
  carenciaAte: string | null;
  /** `modo === 'bloquear'`, tem data, e ela ainda não venceu. */
  emCarencia: boolean;
  /** Vazio sempre que `vale` é falso, ou quando a leitura de uso/limites falhou. */
  itensNoTeto: ItemNoTetoDeBloqueio[];
  leituraFalhou: boolean;
  /**
   * Tarefa 2, decisão 5 da fase F4 (`fn_billing_modo_leitura`, migração
   * 0908 parte 2): a conta está em modo leitura de verdade AGORA (modo
   * `bloquear`, carência vencida E `billing_contracts.status` em
   * `suspensa`/`cancelada`). Campo SEPARADO de `vale`/`itensNoTeto` DE
   * PROPÓSITO: `vale` é o bloqueio de TETO do plano (carência vencida, sem
   * olhar `status`), `suspensa` é a conta parada por falta de pagamento;
   * são causas e remédios diferentes (pagar o atrasado vs. contratar mais).
   * Só é lida quando o modo cacheado já é `bloquear` (zero consulta a mais
   * no modo avisar/desligado, os dois early returns abaixo nem chegam a
   * calculá-la), reusando `contaEmModoLeitura`
   * (`lib/billing/assinatura/modo-leitura.ts`), a MESMA leitura
   * fail-open/cacheada que os produtores da Tarefa 7 usam.
   */
  suspensa: boolean;
}

/** O rótulo plural de cada item, para compor "N de M <rótulo> do plano X". */
const ROTULO_PLURAL: Record<ChaveDaTelaDePlano, string> = {
  funis: "funis",
  etapas_por_funil: "etapas neste funil",
  membros: "membros",
  conexoes: "conexões",
  integracoes_webhook: "integrações de webhook",
  leads: "leads",
};

/**
 * A frase fixa de motivo, pronta para tooltip ou texto ao lado do botão.
 * `nomeDoPlano === null` (leitura do plano falhou) só omite o "do plano X" ,
 * o número e o rótulo continuam corretos, porque quem decidiu "está no teto"
 * foi `podeCriar`/`linhasDaTelaDePlano`, não o nome do plano.
 */
export function motivoDoItemNoTeto(
  chave: ChaveDaTelaDePlano,
  atual: number,
  teto: number,
  nomeDoPlano: string | null,
): string {
  const rotulo = ROTULO_PLURAL[chave];
  return nomeDoPlano
    ? `${atual} de ${teto} ${rotulo} do plano ${nomeDoPlano}`
    : `${atual} de ${teto} ${rotulo}`;
}

/**
 * Tarefa 2, decisão 7 da fase F4 (migração 0908 parte 2): os QUATRO gatilhos
 * de criação que `fn_billing_modo_leitura` para: funis, etapas por funil,
 * integrações webhook e convites (`membros`, o único nome que diverge do
 * gatilho: é o item da matriz do plano para "convidar membro"). `conexoes` e
 * `leads` ficam de fora DE PROPÓSITO: a decisão 5 da fase lista canal/conexão
 * e lead como o que CONTINUA na conta suspensa (o chat nunca para, N23).
 */
const CHAVES_PARADAS_NA_CONTA_SUSPENSA: readonly ChaveDaTelaDePlano[] = [
  "funis",
  "etapas_por_funil",
  "integracoes_webhook",
  "membros",
];

/**
 * Frase fixa para os botões parados pela conta suspensa (Tarefa 2, decisão 7
 * da fase F4): texto próprio, nunca a frase de teto de `motivoDoItemNoTeto`
 * (a causa e o remédio são outros: pagar o atrasado, não contratar mais).
 * Exportada para quem for traduzir para espanhol no servidor (`traduzir()`,
 * `lib/i18n/dicionario.ts`) antes de repassar ao componente cliente.
 */
export const MOTIVO_CONTA_SUSPENSA_ASSINATURA =
  "Conta suspensa por falta de pagamento. Fale com o suporte.";

/**
 * O item no teto que casa com `chave` (e, para `etapas_por_funil`, com
 * `pipelineId`), ou `null` quando não há motivo para desabilitar nada. É a
 * função que todo componente de UI chama para decidir `disabled` e o texto do
 * motivo; nenhum componente lê `itensNoTeto` na unha.
 *
 * Tarefa 2, decisão 7 da F4: `estado.suspensa` é conferido ANTES de
 * `estado.vale` para as quatro chaves de `CHAVES_PARADAS_NA_CONTA_SUSPENSA`,
 * mesma ordem do banco (`fn_billing_modo_leitura` roda antes do bloqueio de
 * teto no gatilho, migração 0908). A conta suspensa é motivo suficiente por
 * si só, com ou sem teto de plano estourado.
 */
export function itemNoTeto(
  estado: Pick<EstadoDoBloqueio, "vale" | "itensNoTeto" | "suspensa">,
  chave: ChaveDaTelaDePlano,
  pipelineId?: string,
): ItemNoTetoDeBloqueio | null {
  if (estado.suspensa && CHAVES_PARADAS_NA_CONTA_SUSPENSA.includes(chave)) {
    return {
      chave,
      pipelineId: chave === "etapas_por_funil" ? (pipelineId ?? null) : null,
      motivo: MOTIVO_CONTA_SUSPENSA_ASSINATURA,
    };
  }
  if (!estado.vale) return null;
  return (
    estado.itensNoTeto.find(
      (item) =>
        item.chave === chave &&
        (chave !== "etapas_por_funil" || item.pipelineId === (pipelineId ?? null)),
    ) ?? null
  );
}

function ehModoValido(valor: string | null | undefined): valor is ModoDeBloqueioDaOrganizacao {
  return valor === "desligado" || valor === "avisar" || valor === "bloquear";
}

const ESTADO_EM_FALHA: EstadoDoBloqueio = {
  vale: false,
  modo: "avisar",
  carenciaAte: null,
  emCarencia: false,
  itensNoTeto: [],
  leituraFalhou: true,
  suspensa: false,
};

export interface OpcoesDoEstadoDoBloqueio {
  /**
   * Os funis que a tela está desenhando, só eles têm o teto de
   * `etapas_por_funil` conferido. Omitir (ou lista vazia) é válido para toda
   * tela que não mostra criação de etapa.
   */
  pipelineIds?: string[];
}

export async function estadoDoBloqueio(
  admin: SupabaseClient,
  organizationId: string,
  opcoes: OpcoesDoEstadoDoBloqueio = {},
  log?: Logger,
): Promise<EstadoDoBloqueio> {
  let modo: ModoDeBloqueioDaOrganizacao;
  let carenciaAte: string | null;

  try {
    // Revisão da F3 (achado baixo 4): cacheado 60s por processo, mesmo padrão
    // de `modoDeBillingPeloDb` (run-model-call.ts), sem isto, cada carga da
    // tela (Plano e uso, aba do admin) pagava uma consulta PostgREST a mais
    // para uma linha que quase nunca muda.
    const { modo: modoLido, error: mensagemDeErro } = await modoDeBillingCacheado(admin);
    if (mensagemDeErro) throw new Error(`ler billing_settings: ${mensagemDeErro}`);

    modo = ehModoValido(modoLido) ? modoLido : "avisar";

    if (modo !== "bloquear") {
      // Mesma saída antecipada de `bloqueioValeParaOrganizacao`: modo que não
      // bloqueia não precisa ler `billing_contracts`, e não tem itens no teto.
      // `suspensa` é sempre falso aqui SEM chamar `fn_billing_modo_leitura`
      // nenhuma: ela exige modo='bloquear' (decisão 5, F4), então não há RPC
      // para pagar neste ramo. O "zero consulta a mais no modo avisar" da
      // decisão 8 vale também para esta leitura nova.
      return {
        vale: false,
        modo,
        carenciaAte: null,
        emCarencia: false,
        itensNoTeto: [],
        leituraFalhou: false,
        suspensa: false,
      };
    }

    const { data: contrato, error: erroContrato } = await admin
      .from("billing_contracts")
      .select("bloqueio_a_partir_de")
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (erroContrato) throw new Error(`ler billing_contracts: ${erroContrato.message}`);

    carenciaAte =
      (contrato as { bloqueio_a_partir_de?: string | null } | null)?.bloqueio_a_partir_de ?? null;
  } catch (err) {
    log?.error("alarme_planos_leitura", {
      organization_id: organizationId,
      etapa: "estado_do_bloqueio",
      error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
    });
    return ESTADO_EM_FALHA;
  }

  // Nulo = não bloqueia (carência nunca dada, ou organização anterior ao
  // gatilho de carência). Data no futuro = carência ainda correndo.
  const venceu = carenciaAte !== null && new Date(carenciaAte).getTime() <= Date.now();
  const vale = carenciaAte !== null && venceu;
  const emCarencia = carenciaAte !== null && !venceu;

  // Tarefa 2, decisão 5 e 8 da F4: só chega aqui com modo já 'bloquear' (o
  // early return acima cobre avisar/desligado), então `contaEmModoLeitura`
  // paga no máximo UMA consulta a mais: a RPC `fn_billing_modo_leitura`,
  // que ela mesma decide chamar por já ver o modo cacheado em 'bloquear' (a
  // leitura de billing_settings é cache hit, mesmo cliente admin). Fail-open
  // por conta própria (nunca lança, grita alarme_planos_leitura sozinha):
  // fica FORA do try/catch acima de propósito, para uma falha aqui nunca
  // virar `ESTADO_EM_FALHA` (vale/itensNoTeto) por tabela.
  const suspensa = await contaEmModoLeitura(admin, organizationId);

  if (!vale) {
    return { vale: false, modo, carenciaAte, emCarencia, itensNoTeto: [], leituraFalhou: false, suspensa };
  }

  // Só a partir daqui o bloqueio VALE: as leituras de uso e limites só
  // acontecem quando elas de fato importam para alguma decisão de tela.
  const [usoResultado, planoResultado] = await Promise.all([
    usoDaOrganizacao(admin, organizationId, log),
    planoDaOrganizacao(admin, organizationId, log),
  ]);

  const leituraDoUsoOuPlanoFalhou = usoResultado.leituraFalhou || planoResultado.leituraFalhou;
  const nomeDoPlano = planoResultado.leituraFalhou ? null : planoResultado.plano.name;

  const itensNoTeto: ItemNoTetoDeBloqueio[] = [];

  // Os cinco itens de teto por organização (etapas_por_funil fica fora desta
  // conta: ver o comentário do módulo). `estourou` já é `false` para toda
  // leitura que falhou, não é preciso checar `leituraDoUsoOuPlanoFalhou` de
  // novo aqui.
  for (const linha of linhasDaTelaDePlano(usoResultado.uso, planoResultado.limites, leituraDoUsoOuPlanoFalhou)) {
    if (linha.chave === "etapas_por_funil") continue;
    if (linha.estourou && linha.atual !== null && linha.teto !== null) {
      itensNoTeto.push({
        chave: linha.chave,
        pipelineId: null,
        motivo: motivoDoItemNoTeto(linha.chave, linha.atual, linha.teto, nomeDoPlano),
      });
    }
  }

  // Etapas por funil: só para os funis que a tela pediu, um `podeCriar` por
  // funil (a mesma função que o gatilho do banco espelha).
  const pipelineIds = opcoes.pipelineIds ?? [];
  if (pipelineIds.length > 0) {
    const porFunil = await Promise.all(
      pipelineIds.map((pipelineId) =>
        podeCriar(admin, organizationId, "etapas_por_funil", pipelineId, log).then((resultado) => ({
          pipelineId,
          resultado,
        })),
      ),
    );
    for (const { pipelineId, resultado } of porFunil) {
      if (
        !resultado.leituraFalhou &&
        resultado.motivo === "teto_atingido" &&
        resultado.atual !== null &&
        resultado.teto !== null
      ) {
        itensNoTeto.push({
          chave: "etapas_por_funil",
          pipelineId,
          motivo: motivoDoItemNoTeto("etapas_por_funil", resultado.atual, resultado.teto, nomeDoPlano),
        });
      }
    }
  }

  return {
    vale: true,
    modo,
    carenciaAte,
    emCarencia,
    itensNoTeto,
    leituraFalhou: leituraDoUsoOuPlanoFalhou,
    suspensa,
  };
}

/** Reexportado por conveniência de quem só quer iterar as seis chaves conhecidas. */
export { CHAVES_DA_TELA_DE_PLANO };

/**
 * O par `{ desabilitado, motivo }` que todo componente `use client` recebe
 * como prop, plano o bastante para atravessar a fronteira servidor/cliente
 * sem carregar `EstadoDoBloqueio` inteiro (que ninguém no cliente precisa
 * conhecer por completo). É o formato que `Button disabled={...} title={...}`
 * espera direto.
 */
export interface BloqueioDoBotao {
  desabilitado: boolean;
  /** `null` quando `desabilitado` é falso, nunca um texto vazio. */
  motivo: string | null;
  /**
   * Tarefa 2, decisão 7 da F4: `true` quando `motivo` é
   * `MOTIVO_CONTA_SUSPENSA_ASSINATURA` (conta suspensa), não um teto de
   * plano. A página server component pode usar este sinal para trocar
   * `motivo` pela versão traduzida (`traduzir(MOTIVO_CONTA_SUSPENSA_ASSINATURA,
   * idioma)`) antes de repassar ao componente `use client`: o mesmo padrão
   * que ela já usa para o resto do texto da tela.
   */
  suspensa: boolean;
}

/** Atalho de `itemNoTeto` no formato de prop de botão (ver `BloqueioDoBotao`). */
export function bloqueioDoBotao(
  estado: Pick<EstadoDoBloqueio, "vale" | "itensNoTeto" | "suspensa">,
  chave: ChaveDaTelaDePlano,
  pipelineId?: string,
): BloqueioDoBotao {
  const item = itemNoTeto(estado, chave, pipelineId);
  return {
    desabilitado: item !== null,
    motivo: item?.motivo ?? null,
    suspensa: item?.motivo === MOTIVO_CONTA_SUSPENSA_ASSINATURA,
  };
}
