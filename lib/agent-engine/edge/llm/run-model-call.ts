import { guardServiceTools } from "@/lib/atendimento/fronteira-server";
/**
 * SEAM ÚNICO de chamada de modelo: TODA chamada de LLM do harness passa por
 * runModelCall — agente, classificadores auxiliares e compaction usam esta MESMA
 * função (nenhum call site instancia provider).
 *
 * Por chamada: resolve a config da org no DB (BYOK em ai_provider_credentials +
 * knobs em organizations.settings->'llm'; troca de modelo/provider = UPDATE na
 * config, vale no run seguinte, sem restart) → checa o budget mensal ANTES de
 * sair byte para o provider → generateText do AI SDK → grava usage/custo em
 * llm_calls. A chave da org nunca entra em prompt, tool result ou log — ela só
 * cruza a fronteira na instância do provider.
 *
 * Shape do usage: `LanguageModelUsage` (node_modules/ai/dist/index.d.ts):
 * inputTokens/outputTokens totais + inputTokenDetails.{cacheReadTokens,
 * cacheWriteTokens}. Validado no ai@7 via scripts/smoke-llm.sh (modelo real) —
 * upgrade de major re-valida esses paths pelo mesmo gate (regra dura 16).
 */
import { generateText, stepCountIs, type ModelMessage, type ToolSet } from 'ai';
import type pg from 'pg';
import { z } from 'zod';

import { PONTO_POR_ID } from '@/lib/ai/pontos/registro';
import { criarResolvedorDeCatalogo, type ModelPricingRow } from '@/lib/ai/runtime/cost';
import { scrubMessage } from '@/lib/sentry/scrub';

import type { Logger } from '../../obs/logger';
import { decidirParaOSeam } from './binding-do-ponto';
import { resolveOrgLlmConfig, type LlmEdgeConfig, type OrcamentoDaOrg, type OrigemDaChaveLlm } from './credentials';
import {
  AVISO_CORPO,
  AVISO_TITULO,
  BLOQUEIO_TITULO,
  corpoDoBloqueio,
  decidirOrcamento,
  normalizarModoDeOrcamento,
  LIMIAR_PADRAO_PCT,
  PURPOSES_ISENTOS,
  SQL_ORCAMENTO,
  type ChaveDeOrcamento,
} from './orcamento';
import {
  aplicarChaveNoVeredicto,
  carteiraBloqueioTitulo,
  corpoDoBloqueioDaCarteira,
  deveConsultarCarteira,
  interpretarVeredictoDaCarteira,
  normalizarModoDeBilling,
  SQL_MODO_DE_BILLING,
  type ModoDeBilling,
  type VeredictoDaCarteira,
} from './carteira';
import {
  corpoDaSuspensaoDeAssinatura,
  deveConsultarAssinatura,
  PURPOSES_ISENTOS_DA_ASSINATURA,
  TITULO_ASSINATURA_SUSPENSA,
} from './assinatura';
import { custoCentsComCatalogo } from './pricing';
import { chaveDeOrcamentoDaInstalacao } from '../../../instalacao/comportamento';
import { createDefaultRegistry, type ProviderRegistry } from './providers';
import { buildStablePrefix } from './stable-prefix';
import {
  degrauDoEnderecoProprio,
  prazoLegivel,
  RECUSA_A_PARTIR_DE,
} from './prazo-do-endereco-proprio';

// Call sites FORA da camada importam os tipos daqui — nunca de 'ai' direto
// (o seam é a única porta). `tool` idem: é como o agente define ToolSet sem
// tocar no SDK.
export { tool } from 'ai';
export type { ModelMessage, ToolSet } from 'ai';
export type { LlmEdgeConfig } from './credentials';
export { llmEdgeConfigFromEnv, LlmNotConfiguredError } from './credentials';

/** Teto mensal da org esgotado — runs recusados ANTES do provider (zero tokens). */
export class LlmBudgetExceededError extends Error {
  // Tipo alargado para `string` (em vez do literal inferido) só para permitir a
  // subclasse `LlmCarteiraEsgotadaError` (fase F3, decisão 7) sobrescrever com o
  // próprio literal: sem isto o TypeScript recusa o `override` por variância de
  // literal, mesmo o valor em si nunca mudando de tipo em runtime.
  override readonly name: string = 'llm_budget_exceeded';
  /**
   * Veto PERMANENTE de negócio, não incidente de sistema — tentar de novo daqui
   * a um minuto dá o mesmo resultado, porque o gasto não diminui sozinho.
   *
   * Quem lê isto é a fila (`workers/agent-worker/main.ts`), para mandar o job
   * ao `cancelJob` em vez do `failJob`: sem isso, um bloqueio produz N conversas
   * × `max_attempts` tentativas e N alertas CRÍTICOS `job_dead` sem dedup,
   * afogando o único `budget_exceeded` — que é o alerta que explica. O
   * REPONTAMENTO da fila é da onda seguinte; o rótulo entra aqui, com o erro.
   */
  readonly terminal = true;
  constructor() {
    super('orçamento mensal de IA da organização atingido — chamada recusada antes de sair byte para o provedor; ajuste o teto em Uso de IA › Orçamento, desligue a proteção, ou aguarde a virada do mês (agent_inbox_items kind=budget_exceeded)');
  }
}

/**
 * Carteira de tokens de IA da organização esgotada: decisão 7 da fase F3
 * (`hiperbold/planos/fase-F3-tarefas.md`). SUBCLASSE, de propósito: a fila
 * (`workers/agent-worker/main.ts`) lê `terminal` por herança e cancela em vez de
 * repetir, e a escolta de handoff (`comHandoffSeOrcamentoAcabar`, `inbound-turn.ts`)
 * reconhece pela CLASSE-MÃE: os dois desfechos já certos do orçamento em dólar
 * valem aqui sem duplicar nenhum dos dois. `name` e `message` são sobrescritos
 * porque este é um veto DIFERENTE (carteira de tokens do plano, não teto de gasto
 * escolhido pela organização), e as duas tabelas que leem o erro
 * (`llm_calls.error_message`, o `job_dead` da fila) mostram o texto: confundir os
 * dois motivos mandaria quem lê consertar o campo errado (Uso de IA › Orçamento em
 * vez de Configurações › Plano e uso).
 */
export class LlmCarteiraEsgotadaError extends LlmBudgetExceededError {
  override readonly name = 'llm_carteira_esgotada';
  constructor(saldoTokens: number | null) {
    super();
    this.message =
      `carteira de tokens de IA da organização esgotada neste ciclo` +
      (saldoTokens === null ? '' : ` (saldo: ${saldoTokens} tokens)`) +
      ': chamada recusada antes de sair byte para o provedor; contrate mais tokens em ' +
      'Configurações › Plano e uso (agent_inbox_items ref_kind=billing_carteira)';
  }
}

/**
 * Conta em MODO LEITURA (assinatura suspensa/cancelada, bloqueio ligado e
 * carência vencida): decisões 5 e 6 da fase F4 (`hiperbold/planos/fase-F4-
 * tarefas.md`, Tarefa 6). SUBCLASSE de propósito, IRMÃ de
 * `LlmCarteiraEsgotadaError` (as duas estendem `LlmBudgetExceededError`
 * diretamente, nunca uma a outra): a fila lê `terminal` por herança e cancela
 * em vez de repetir, e a escolta de handoff (`comHandoffSeOrcamentoAcabar`,
 * `inbound-turn.ts`) reconhece pela classe-mãe. `name` e `message` são
 * sobrescritos porque este é um veto de NEGÓCIO diferente dos outros dois
 * (mensalidade não paga, não gasto nem carteira do plano) — confundir os três
 * mandaria quem lê consertar o campo errado.
 */
export class LlmAssinaturaSuspensaError extends LlmBudgetExceededError {
  override readonly name = 'llm_assinatura_suspensa';
  constructor() {
    super();
    this.message =
      'a assinatura desta organização está suspensa (modo leitura, pagamento em atraso além da ' +
      'carência): chamada recusada antes de sair byte para o provedor; regularize o pagamento em ' +
      'Configurações › Plano e uso (agent_inbox_items ref_kind=billing_assinatura)';
  }
}

/** Provider da config sem entrada no registry — erro de config, nunca fallback. */
export class LlmProviderUnknownError extends Error {
  override readonly name = 'llm_provider_unknown';
  constructor(provider: string) {
    super(`provider LLM desconhecido na config da org: ${provider}`);
  }
}

/** Modelo pedido fora de enabled_models da org. */
export class LlmModelNotEnabledError extends Error {
  override readonly name = 'llm_model_not_enabled';
  constructor(model: string) {
    super(`modelo não habilitado para a org (enabled_models): ${model}`);
  }
}

/**
 * Endereço próprio escolhido pela ORGANIZAÇÃO + chave da INSTALAÇÃO: a chamada
 * é recusada antes de sair byte (decisão 22-a do dono do produto).
 *
 * A mensagem é a instrução, numa linha só, porque é ela que chega a quem opera
 * por três caminhos: a tela de Execuções (via `llm_calls.error_message`), o
 * ensaio do agente (que mostra o erro na tela) e o `job_dead` da fila, que
 * guarda a primeira linha de `last_error` no corpo do aviso.
 *
 * NÃO é `terminal`, e isso é escolha: `terminal` manda a fila cancelar o job
 * sem retry, e a fila só pode fazer isso com segurança porque o orçamento tem
 * a escolta de handoff em `runAgentTurn` — este erro não tem. Sem a escolta, o
 * job cancelado deixaria a conversa sem resposta e sem ninguém. Como erro
 * comum, ele segue o mesmo caminho dos irmãos de configuração
 * (`LlmNotConfiguredError`, `LlmModelNotEnabledError`): a fila tenta de novo
 * com espera crescente — quem corrigir a configuração nesse intervalo tem a
 * conversa respondida — e, esgotadas as tentativas, o `job_dead` leva esta
 * frase como motivo.
 */
export class LlmEnderecoExigeChaveDaEmpresaError extends Error {
  override readonly name = 'llm_endereco_exige_chave_da_empresa';
  constructor() {
    super(
      'o endereço de IA configurado para esta empresa só é usado com a chave dela, e ela não tem chave cadastrada para este provedor — a chave da instalação não é enviada a endereço escolhido pela empresa; cadastre a chave da empresa em Agente de IA › Provedores, ou tire o endereço próprio para voltar ao provedor padrão da instalação',
    );
  }
}

/**
 * O título do aviso na Central. Constante exportada porque é também a chave de
 * dedup: o aviso usa `kind='other'` sem referência (ver `recusarEndereco…`).
 */
export const TITULO_ENDERECO_SEM_CHAVE_DA_EMPRESA =
  'A IA recusou usar o endereço próprio desta empresa sem a chave dela';

/**
 * O título da fase de AVISO — antes do prazo, a chamada SEGUE, e dizer
 * "recusou" seria falso na tela de quem administra. Título diferente também
 * separa a dedup: o aviso do prazo e a recusa de depois são dois itens, e é
 * assim que a Central conta a história em vez de sobrescrevê-la.
 */
export const TITULO_ENDERECO_SEM_CHAVE_PRAZO =
  `A IA vai deixar de usar o endereço próprio desta empresa sem a chave dela em ${prazoLegivel()}`;

/** O corpo do aviso — só o HOST do endereço, nunca a URL inteira. */
export function corpoDoAvisoDeEnderecoSemChave(d: {
  purpose: string;
  provider: string;
  baseUrl: string;
  /** `avisa` antes do prazo (a chamada seguiu), `recusa` depois dele. */
  degrau: 'avisa' | 'recusa';
}): string {
  const ponto = PONTO_POR_ID.get(d.purpose)?.rotulo ?? d.purpose;
  // Só o host: uma URL pode carregar usuário e senha (`https://u:s@host`) ou um
  // token na query, e este corpo é lido por qualquer pessoa da equipe.
  let destino = 'um endereço próprio';
  try {
    destino = `um endereço próprio (${new URL(d.baseUrl).host})`;
  } catch {
    // Endereço que nem é URL: o aviso segue sem o host, que é detalhe.
  }
  return (
    `O ponto "${ponto}" está configurado em Agente de IA › Provedores para ${destino}, ` +
    `mas esta empresa não tem chave de ${d.provider} cadastrada e validada. ` +
    `A chave de IA da instalação — a que paga a conta de todas as empresas deste servidor — ` +
    `não é enviada a um endereço escolhido por uma empresa. ` +
    (d.degrau === 'recusa'
      ? `A chamada foi recusada antes de sair. Enquanto isso não for corrigido, as chamadas desse ponto ` +
        `continuam recusadas; quando o ponto faz parte do atendimento, o agente deixa de responder aos ` +
        `clientes desta empresa. `
      : `A chamada SEGUIU desta vez, mas isso tem prazo: a partir de ${prazoLegivel()} ela passa a ser ` +
        `recusada, e quando o ponto faz parte do atendimento o agente deixa de responder aos clientes ` +
        `desta empresa. Corrija antes dessa data. `) +
    `Para resolver: cadastre a chave da empresa em Agente de IA › Provedores, ` +
    `ou tire o endereço próprio para voltar ao provedor padrão da instalação.`
  );
}

// Whitelist de params da org (jsonb livre no DB → só o que o seam entende passa).
const paramsSchema = z
  .object({
    temperature: z.number().optional(),
    topP: z.number().optional(),
    topK: z.number().int().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
  })
  .passthrough();

export interface RunModelCallInput {
  tenantId: string;
  leadId?: string | null;
  jobId?: string | null;
  variantId?: string | null;
  /**
   * De QUEM é esta execução — `ai_agents.id` do agente publicado que está no
   * turno. Vai para `llm_calls.agent_id`, a coluna que existia com FK e nunca
   * era escrita (medido em produção: 0 de 130 linhas de `agent_turn`).
   *
   * Sem ela a aba "Execuções" da tela do agente não tem como filtrar o que
   * mostrar — e era por isso que ela dizia "Nenhuma execução ainda" enquanto o
   * agente respondia. Opcional porque a maioria dos chamadores é auxiliar
   * (classificador, compaction, flywheel) e não pertence a um agente.
   */
  agentId?: string | null;
  /** atribuição de custo: 'agent_turn' (default) | 'classifier' | 'compaction' | 'connection_test' */
  purpose?: string;
  system?: string;
  messages: ModelMessage[];
  tools?: ToolSet;
  /**
   * Override do modelo default da org — é como classificador/compaction usam um
   * modelo pequeno pela MESMA camada. Sujeito a enabled_models quando a lista
   * não é vazia. NUNCA um id hardcoded: o valor vem de config de quem chama.
   */
  model?: string;
  /**
   * Teto do loop de tool-calls do generateText (vira stopWhen: stepCountIs). Sem
   * ele o SDK para no 1º step (default stepCountIs(1)) — tools executam mas o
   * modelo não vê o resultado. Quem chama passa o knob (ex.: AGENT_MAX_STEPS do
   * agente), nunca constante.
   */
  maxSteps?: number;
  /**
   * Encerra o loop quando o predicado for verdadeiro ao fim de uma etapa (além
   * do teto de `maxSteps`). É predicado, e não nome de tool, de propósito: o
   * rascunho assistido para quando há resposta ACEITA, não quando o modelo
   * chamou `send_message` — um envio vetado devolve o erro ao modelo para ele
   * reescrever na etapa seguinte, e parar ali entregava rascunho vazio.
   */
  pararQuando?: () => boolean;
  /** Teto por chamada auxiliar; nunca aumenta o limite configurado pela organização. */
  maxOutputTokens?: number;
  /** Cancelamento propagado pelo chamador; a falha continua registrada em llm_calls. */
  abortSignal?: AbortSignal;
  /**
   * Override de provider/credencial vindo da versão PUBLICADA do agente (Fase
   * 2B) — resolvido no seam, nunca no call site. Sem ele, config da org.
   */
  llmOverride?: import('./credentials').LlmResolveOverride;
}

export interface RunModelCallDeps {
  registry?: ProviderRegistry;
  log?: Logger;
  /**
   * O relógio, injetável por causa do degrau de `./prazo-do-endereco-proprio`:
   * sem ele a virada do prazo nunca é exercitada em teste e o dia do corte vira
   * surpresa em produção.
   */
  agora?: Date;
}

/**
 * Texto do aviso de limiar. É PONTEIRO, não retrato: manda ver os números na
 * tela em vez de congelar um "80%" que envelhece no mesmo minuto em que o gasto
 * sobe. O statement do gate insere este item de dentro do banco, junto com a
 * leitura, e por isso os números do momento ainda não existem em JS quando o
 * texto é montado — a escolha do ponteiro transforma essa limitação em acerto.
 *
 * A cópia mora em `./orcamento` porque o caminho legado
 * (`workers/ai-response-worker.ts`) abre os MESMOS dois itens e não pode
 * importar este arquivo (ele arrastaria `pg` e o SDK para o bundle do Next).
 */

/** O que o statement do gate devolve — uma ida ao banco, um snapshot. */
interface LinhaDoOrcamento {
  teto: number | string | null;
  modo: string | null;
  efetivo_em: Date | null;
  limiar_pct: number | string | null;
  /** `numeric` do Postgres chega como STRING no node-pg. Sempre coagir. */
  gasto: string | number | null;
  avisado_antes: boolean | null;
}

/**
 * O GATE — lê o estado, deixa `decidirOrcamento` decidir, e executa o veredito.
 *
 * ═══ POR QUE ELE NÃO DECIDE NADA POR CONTA PRÓPRIA ═══
 *
 * A regra inteira mora em `./orcamento.ts`, pura e testável sem banco. Aqui só
 * há I/O: uma query, um insert quando bloqueia, um log. As duas condições
 * repetidas abaixo (`modo === 'off'` e `chave === 'off'`) NÃO são uma segunda
 * cópia da regra — são um atalho de CUSTO, e o que as autoriza é que a função
 * pura devolve `seguir` para as duas sob qualquer outro valor de entrada. Essa
 * concordância é cobrada por teste; se alguém mudar a função e não o atalho, o
 * teste vermelhece antes do cliente.
 *
 * ═══ O CUSTO NO CAMINHO QUENTE ═══
 *
 * Com `enforcement_mode = 'off'` — 100% das organizações no dia do upgrade,
 * porque a coluna nasce assim por DEFAULT — o gate volta ANTES de qualquer
 * query. É estritamente menos trabalho que o `assertBudget` de antes, que ia ao
 * banco somar `llm_calls` sempre que o jsonb tivesse um número.
 *
 * ═══ FALHA ABERTA NA AÇÃO, ABERTA NA INFORMAÇÃO ═══
 *
 * Erro na leitura do orçamento NUNCA bloqueia: o cliente não pode perder o
 * agente porque uma query falhou. Mas a causa vai para o log, nomeada — a frase
 * tranquilizadora sozinha é o que faz um defeito viver meses.
 */
async function aplicarOrcamento(d: {
  db: pg.Pool;
  organizationId: string;
  /** Só para o atalho de custo. A decisão usa o snapshot de `SQL_ORCAMENTO`. */
  orcamentoDaConfig: OrcamentoDaOrg;
  orcamentoIndisponivelPorque: string | null;
  chave: ChaveDeOrcamento;
  purpose: string;
  provider: string;
  model: string;
  origem: string;
  /** 0906 (carteira de tokens): de quem é a chave, repassado à linha de falha. */
  origemDaChave: OrigemDaChaveLlm;
  input: RunModelCallInput;
  log?: Logger;
}): Promise<void> {
  const comum = { organization_id: d.organizationId, purpose: d.purpose };

  if (d.orcamentoIndisponivelPorque !== null) {
    d.log?.warn('llm: orçamento não pôde ser lido — a chamada SEGUE sem teto', {
      ...comum,
      causa: d.orcamentoIndisponivelPorque,
    });
    return;
  }
  if (d.orcamentoDaConfig.modo === 'off' || d.chave === 'off') {
    return;
  }

  const inicio = Date.now();
  let linha: LinhaDoOrcamento | undefined;
  try {
    const { rows } = await d.db.query<LinhaDoOrcamento>(SQL_ORCAMENTO, [
      d.organizationId,
      AVISO_TITULO,
      AVISO_CORPO,
    ]);
    linha = rows[0];
  } catch (err) {
    d.log?.warn('llm: consulta de orçamento falhou — a chamada SEGUE sem teto', {
      ...comum,
      ...normalizarErro(err),
    });
    return;
  }
  if (linha === undefined) {
    // `select` de CTEs escalares sempre devolve uma linha; zero linhas aqui é
    // um mundo que não deveria existir, e nele a resposta segue sendo a frouxa.
    d.log?.warn('llm: consulta de orçamento não devolveu linha — a chamada SEGUE', comum);
    return;
  }

  const gastoCents = Number(linha.gasto ?? 0);
  const tetoCents = Number(linha.teto ?? 0);
  const veredito = decidirOrcamento({
    modo: normalizarModoDeOrcamento(linha.modo),
    tetoCents,
    gastoCents,
    efetivoEm: linha.efetivo_em ?? null,
    agora: new Date(),
    purpose: d.purpose,
    chave: d.chave,
    limiarPct: Number(linha.limiar_pct ?? LIMIAR_PADRAO_PCT),
    avisadoNesteMes: linha.avisado_antes === true,
  });

  if (veredito.acao === 'seguir') {
    return;
  }
  if (veredito.acao === 'avisar_e_seguir') {
    // O item da Central já foi aberto pelo próprio statement (CTE `avisa`), no
    // mesmo snapshot que decidiu — aqui só sobra o log.
    d.log?.warn('llm: gasto de IA passou do aviso — a chamada SEGUE', {
      ...comum,
      porque: veredito.porque,
      gasto_cents: gastoCents,
      teto_cents: tetoCents,
    });
    return;
  }

  const erro = new LlmBudgetExceededError();
  // `ref_kind`/`ref_id` existem para que ALGUÉM possa fechar este item: o
  // insert anterior não gravava ref nenhum, e por isso nenhum auto-resolvedor
  // o alcançava — virava o mês, a IA voltava, e o alerta crítico continuava
  // aceso. Estado falso é pior que ausente, porque quem lê age sobre ele.
  await d.db.query(
    `insert into agent_inbox_items (organization_id, kind, severity, title, body, ref_kind, ref_id)
     select $1, 'budget_exceeded', 'critical', $2, $3, 'ai_budget', $1
     where not exists (
       select 1 from agent_inbox_items
       where organization_id = $1 and kind = 'budget_exceeded' and status = 'open'
     )`,
    [d.organizationId, BLOQUEIO_TITULO, corpoDoBloqueio(gastoCents, tetoCents)],
  );
  // A recusa vira LINHA em llm_calls. A tela /app/ai/runs nasceu porque
  // "llm_calls só registrava sucesso — a tabela ficava vazia exatamente no caso
  // que precisava de explicação", e o único caso em que o agente para DE
  // PROPÓSITO era justamente o que continuava invisível: o `throw` de antes
  // caía fora do `try` que grava a falha. É o irmão que não foi replantado
  // quando a 0128 consertou a classe.
  await registrarFalha(d.db, {
    input: d.input,
    purpose: d.purpose,
    provider: d.provider,
    model: d.model,
    origem: d.origem,
    origemDaChave: d.origemDaChave,
    latencyMs: Date.now() - inicio,
    erro,
  }).catch(() => {
    // Gravar a recusa não pode impedir a recusa.
  });
  d.log?.warn('llm: chamada recusada por orçamento', {
    ...comum,
    provider: d.provider,
    model: d.model,
    gasto_cents: gastoCents,
    teto_cents: tetoCents,
  });
  throw erro;
}

/**
 * `billing_settings.modo`, cacheado 60s POR POOL (decisão 6 da fase F3: "o modo,
 * lido com cache curto em memória, como a chave do orçamento"). `WeakMap<pg.Pool,…>`
 * pelo MESMO motivo do `resolvedoresDeCatalogoPorPool` abaixo: cada pool ganha seu
 * próprio cache, dois pools de teste nunca vazam estado entre si, e um pool
 * finalizado libera a entrada sozinho.
 *
 * 60s (e não os 30s do memo de `comportamentoEmVigor`) porque este é OUTRO dado:
 * `billing_settings` é tabela do fork Hiperbold, lida pelo `db` (pg.Pool) do
 * próprio `run-model-call`, nunca pelo Supabase admin client (HTTP): o invariante
 * `tests/invariants/autonomia-preview-core.test.ts` exige ZERO `fetch` no caminho
 * do ensaio do agente, e ler `billing_settings` por HTTP quebraria exatamente isso.
 */
const CACHE_MODO_DE_BILLING_TTL_MS = 60_000;
const modoDeBillingPorPool = new WeakMap<pg.Pool, { modo: ModoDeBilling; expiraEm: number }>();

async function modoDeBillingPeloDb(db: pg.Pool): Promise<ModoDeBilling> {
  const cache = modoDeBillingPorPool.get(db);
  if (cache && cache.expiraEm > Date.now()) return cache.modo;
  const { rows } = await db.query<{ modo: string | null }>(SQL_MODO_DE_BILLING);
  const modo = normalizarModoDeBilling(rows[0]?.modo ?? null);
  modoDeBillingPorPool.set(db, { modo, expiraEm: Date.now() + CACHE_MODO_DE_BILLING_TTL_MS });
  return modo;
}

/**
 * O GATE DA ASSINATURA SUSPENSA (MODO LEITURA): decisões 5 e 6 da fase F4
 * (`hiperbold/planos/fase-F4-tarefas.md`, Tarefa 6). Roda ANTES de
 * `aplicarCarteira` no seam (chamado primeiro em `runModelCall`, logo abaixo) e
 * ANTES dos atalhos de origem de chave e de propósito que `aplicarCarteira` tem
 * — aqui a isenção é a estreita de `./assinatura.ts` (só os dois guardrails de
 * segurança), sem o atalho de `origemDaChave` (a suspensão vale para BYOK e
 * chave da instalação igual, decisão 6).
 *
 * "Zero consulta a mais" no modo avisar/desligado: usa a MESMA leitura cacheada
 * de `billing_settings.modo` que a carteira (`modoDeBillingPeloDb`, 60s por
 * pool) — as duas nunca pagam duas leituras da mesma linha na mesma janela de
 * 60s. `fn_billing_modo_leitura`, a única consulta não cacheada, só roda quando
 * `deveConsultarAssinatura` (a decisão pura, sem I/O) já confirmou que vale a
 * pena.
 */
async function aplicarAssinatura(d: {
  db: pg.Pool;
  organizationId: string;
  chave: ChaveDeOrcamento;
  purpose: string;
  provider: string;
  model: string;
  origem: string;
  origemDaChave: OrigemDaChaveLlm;
  input: RunModelCallInput;
  log?: Logger;
}): Promise<void> {
  const comum = { organization_id: d.organizationId, purpose: d.purpose };

  // Atalhos de custo #1 e #2: SÓ a chave de emergência e o propósito (ambos já
  // em memória) decidem SE vale a pena ler o modo cacheado — nenhum toca o
  // banco. Decisão 6: aqui NÃO há atalho de `origemDaChave` (o terceiro atalho
  // que `aplicarCarteira` tem) — é a diferença que separa este gate do dela,
  // ver o cabeçalho de `./assinatura.ts`.
  if (d.chave === 'off') return;
  if ((PURPOSES_ISENTOS_DA_ASSINATURA as readonly string[]).includes(d.purpose)) return;

  let modo: ModoDeBilling;
  try {
    modo = await modoDeBillingPeloDb(d.db);
  } catch (err) {
    d.log?.warn('llm: leitura de billing_settings.modo falhou (gate de assinatura) — a chamada SEGUE', {
      ...comum,
      ...normalizarErro(err),
    });
    return;
  }

  if (!deveConsultarAssinatura({ chave: d.chave, modoDoBanco: modo, purpose: d.purpose })) {
    return;
  }

  let leitura = false;
  try {
    const { rows } = await d.db.query<{ leitura: boolean | null }>(
      'select public.fn_billing_modo_leitura($1) as leitura',
      [d.organizationId],
    );
    leitura = rows[0]?.leitura === true;
  } catch (err) {
    d.log?.warn('llm: consulta de fn_billing_modo_leitura falhou — a chamada SEGUE sem checagem de assinatura', {
      ...comum,
      ...normalizarErro(err),
    });
    return;
  }

  if (!leitura) return;

  if (d.chave === 'avisar') {
    // A chave de emergência só sabe AFROUXAR (mesma doutrina do orçamento e da
    // carteira): 'avisar' rebaixa o bloqueio para um log, nunca para um throw.
    d.log?.warn('llm: conta suspensa (modo leitura) — chamada SEGUE por PLANOS_BLOQUEIO=avisar', comum);
    return;
  }

  const erro = new LlmAssinaturaSuspensaError();
  // Mesmo molde de `aplicarCarteira`: dedup por TÍTULO ABERTO (sem período
  // embutido, ver o cabeçalho de `TITULO_ASSINATURA_SUSPENSA` sobre por que —
  // `billing_token_avisos_emitidos` não é concedida ao papel que executa este
  // seam). `ref_kind = 'billing_assinatura'` é o que entra nas três proteções
  // contra o membro (migration 0908 parte 2).
  await d.db
    .query(
      `insert into agent_inbox_items (organization_id, kind, severity, title, body, ref_kind, ref_id)
       select $1, 'other', 'critical', $2, $3, 'billing_assinatura', $1
       where not exists (
         select 1 from agent_inbox_items
         where organization_id = $1 and kind = 'other' and ref_kind = 'billing_assinatura' and title = $2 and status = 'open'
       )`,
      [d.organizationId, TITULO_ASSINATURA_SUSPENSA, corpoDaSuspensaoDeAssinatura()],
    )
    .catch((err: unknown) => {
      d.log?.warn('llm: aviso de assinatura suspensa não pôde ser aberto na Central — a recusa segue', {
        ...comum,
        ...normalizarErro(err),
      });
    });
  await registrarFalha(d.db, {
    input: d.input,
    purpose: d.purpose,
    provider: d.provider,
    model: d.model,
    origem: d.origem,
    origemDaChave: d.origemDaChave,
    latencyMs: 0,
    erro,
  }).catch(() => {
    // Gravar a recusa não pode impedir a recusa.
  });
  d.log?.warn('llm: chamada recusada: conta suspensa (modo leitura)', comum);
  throw erro;
}

/**
 * O GATE DA CARTEIRA DE TOKENS: decisões 6 e 7 da fase F3
 * (`hiperbold/planos/fase-F3-tarefas.md`). Roda logo depois de `aplicarOrcamento`,
 * no MESMO ponto (antes de sair byte para o provedor): os dois vetos são
 * independentes (ver o cabeçalho de `./carteira.ts`) e por isso um não substitui o
 * outro.
 *
 * ═══ "SEGUE SEM CONSULTA NENHUMA" É LITERAL ═══
 *
 * As quatro condições de `deveConsultarCarteira` são checadas ANTES de qualquer
 * leitura de banco, inclusive antes de `modoDeBillingPeloDb`, que já é cacheada:
 * a variável (`d.chave`), a origem da chave e o propósito estão todos em memória, e
 * só quando as três permitem é que a leitura (cacheada) do modo acontece. Só
 * quando o modo também permite é que a RPC `fn_billing_ia_pode_responder`, a
 * única consulta desta função que não é cacheada, porque o saldo muda a cada
 * resposta, é chamada. No modo `avisar` (billing_settings) e com
 * `PLANOS_BLOQUEIO=off`, zero consulta a mais: nem a de `modoDeBillingPeloDb`
 * quando as três primeiras já bastam para decidir.
 *
 * Mídia (transcrição, visão, embedding) não passa por este gate (decisão 8 da
 * fase): nenhum desses caminhos chama `runModelCall`, então a exclusão é por
 * construção, não por um `if` aqui.
 */
async function aplicarCarteira(d: {
  db: pg.Pool;
  organizationId: string;
  chave: ChaveDeOrcamento;
  origemDaChave: OrigemDaChaveLlm;
  purpose: string;
  provider: string;
  model: string;
  origem: string;
  input: RunModelCallInput;
  log?: Logger;
}): Promise<void> {
  const comum = { organization_id: d.organizationId, purpose: d.purpose };

  // Atalhos de custo #1 a #3: nenhum toca o banco. `deveConsultarCarteira` não
  // recebe o modo ainda (ele é o quarto atalho, e o único que exige I/O), porque a
  // função pura precisa do modo já resolvido; aqui ele entra com o valor mais
  // frouxo possível ('desligado') só para as três primeiras condições decidirem
  // sozinhas: se elas já bastarem para recusar a consulta, o modo nunca é lido.
  if (
    d.chave === 'off' ||
    d.origemDaChave !== 'chave_da_instalacao' ||
    (PURPOSES_ISENTOS as readonly string[]).includes(d.purpose)
  ) {
    return;
  }

  let modo: ModoDeBilling;
  try {
    modo = await modoDeBillingPeloDb(d.db);
  } catch (err) {
    d.log?.warn('llm: leitura de billing_settings.modo falhou: a chamada SEGUE sem teto de carteira', {
      ...comum,
      ...normalizarErro(err),
    });
    return;
  }

  if (!deveConsultarCarteira({ chave: d.chave, modoDoBanco: modo, origemDaChave: d.origemDaChave, purpose: d.purpose })) {
    return;
  }

  let veredito: VeredictoDaCarteira;
  try {
    const { rows } = await d.db.query<{ veredito: unknown }>(
      'select public.fn_billing_ia_pode_responder($1) as veredito',
      [d.organizationId],
    );
    veredito = interpretarVeredictoDaCarteira(rows[0]?.veredito);
  } catch (err) {
    d.log?.warn('llm: consulta da carteira de tokens falhou: a chamada SEGUE sem teto de carteira', {
      ...comum,
      ...normalizarErro(err),
    });
    return;
  }

  veredito = aplicarChaveNoVeredicto(veredito, d.chave);

  if (veredito.acao === 'seguir') {
    return;
  }
  if (veredito.acao === 'avisar_e_seguir') {
    // O aviso de fim de saldo já é da PRÓPRIA carteira (fn_billing_avisar_carteira,
    // 0906, Central), não duplica aqui (decisão 7 da fase F3).
    d.log?.warn('llm: saldo da carteira de tokens abaixo do limiar: a chamada SEGUE', {
      ...comum,
      motivo: veredito.motivo,
      saldo: veredito.saldo,
    });
    return;
  }

  const erro = new LlmCarteiraEsgotadaError(veredito.saldo);
  // `kind='other'`, não `'budget_exceeded'`: o CHECK de `agent_inbox_items.kind` é
  // vocabulário fechado (tests/invariants/vocabulario-banco-x-typescript.test.ts) e
  // esta tarefa não abre migração nova. `ref_kind='billing_carteira'` é o que
  // garante a dedup PRÓPRIA (decisão 7: "não se misturar com o budget_exceeded do
  // orçamento em dólar"), mesmo padrão de `billing_limite` (0905/0907), que
  // também vive em `kind='other'` com `ref_kind` próprio.
  //
  // Revisão da F3 (achado baixo 7): a dedup por SÓ "existe item aberto" fazia
  // um aviso de um mês anterior, nunca fechado, impedir o aviso do mês atual
  // de nascer. `carteiraBloqueioTitulo(veredito.ciclo)` embute o ciclo no
  // título (mesmo molde do aviso de limiar em `fn_billing_avisar_carteira`,
  // 0906, que embute o mês para o mesmo fim); a dedup agora é por
  // ref_kind + TÍTULO + status='open', então um aviso de agosto aberto não
  // impede o de setembro.
  const titulo = carteiraBloqueioTitulo(veredito.ciclo);
  await d.db.query(
    `insert into agent_inbox_items (organization_id, kind, severity, title, body, ref_kind, ref_id)
     select $1, 'other', 'critical', $2, $3, 'billing_carteira', $1
     where not exists (
       select 1 from agent_inbox_items
       where organization_id = $1 and kind = 'other' and ref_kind = 'billing_carteira' and title = $2 and status = 'open'
     )`,
    [d.organizationId, titulo, corpoDoBloqueioDaCarteira(veredito.saldo)],
  );
  await registrarFalha(d.db, {
    input: d.input,
    purpose: d.purpose,
    provider: d.provider,
    model: d.model,
    origem: d.origem,
    origemDaChave: d.origemDaChave,
    latencyMs: 0,
    erro,
  }).catch(() => {
    // Gravar a recusa não pode impedir a recusa.
  });
  d.log?.warn('llm: chamada recusada: carteira de tokens de IA esgotada', {
    ...comum,
    motivo: veredito.motivo,
    saldo: veredito.saldo,
  });
  throw erro;
}

/**
 * Deixa o rastro da recusa por endereço da empresa com chave da instalação e
 * DEVOLVE o erro — quem chama o lança (`throw await …`), para a recusa ficar
 * visível no ponto em que acontece.
 *
 * Três rastros, cada um para um leitor:
 *
 *  - **Aviso na Central**, para quem administra a empresa, com a instrução.
 *    `kind='other'` sem referência, e não um kind próprio: kind novo exige
 *    reconstruir o CHECK de `agent_inbox_items.kind` (migration + bloco único do
 *    baseline), o mesmo custo que `pacing/aviso-de-janela.ts` recusou pelo mesmo
 *    motivo. SEM referência de propósito: com `ref_kind` fora da política de
 *    `other`, a Central mostraria "Este contexto não está disponível para
 *    você", frase falsa aqui; sem referência ela mostra a orientação do kind. A
 *    dedup é pelo TÍTULO aberto — uma rajada de conversas vira UM aviso.
 *  - **Linha em `llm_calls`**, para a tela de Execuções dizer o que fazer
 *    (`error_code='endereco_exige_chave_da_empresa'`). A tabela que explica o
 *    silêncio não pode ficar vazia justamente numa recusa nossa.
 *  - **Log**, para quem lê o contêiner.
 *
 * Nenhum dos três pode impedir a recusa: falha ao gravar vira log, e o erro
 * devolvido é sempre o da recusa.
 */
async function registrarRecusaDeEnderecoSemChave(d: {
  db: pg.Pool;
  input: RunModelCallInput;
  purpose: string;
  provider: string;
  model: string;
  origem: string;
  /** 0906 (carteira de tokens): sempre 'chave_da_instalacao' neste caminho (é a condição que leva a esta recusa), repassado à linha de falha. */
  origemDaChave: OrigemDaChaveLlm;
  baseUrl: string;
  /** `avisa` antes do prazo (a chamada segue), `recusa` depois dele. */
  degrau: 'avisa' | 'recusa';
  log?: Logger;
}): Promise<LlmEnderecoExigeChaveDaEmpresaError | null> {
  const erro = new LlmEnderecoExigeChaveDaEmpresaError();
  const comum = {
    organization_id: d.input.tenantId,
    purpose: d.purpose,
    provider: d.provider,
    model: d.model,
  };

  try {
    await d.db.query(
      `insert into agent_inbox_items (organization_id, kind, severity, title, body)
       select $1, 'other', 'critical', $2, $3
       where not exists (
         select 1 from agent_inbox_items
         where organization_id = $1 and kind = 'other' and title = $2 and status = 'open'
       )`,
      [
        d.input.tenantId,
        d.degrau === 'recusa' ? TITULO_ENDERECO_SEM_CHAVE_DA_EMPRESA : TITULO_ENDERECO_SEM_CHAVE_PRAZO,
        corpoDoAvisoDeEnderecoSemChave({
          purpose: d.purpose,
          provider: d.provider,
          baseUrl: d.baseUrl,
          degrau: d.degrau,
        }),
      ],
    );
  } catch (err) {
    d.log?.warn('llm: o aviso da recusa por endereço sem chave da empresa não abriu — a recusa segue', {
      ...comum,
      ...normalizarErro(err),
    });
  }

  if (d.degrau === 'avisa') {
    // A chamada SEGUE até o prazo: gravar uma linha de FALHA em `llm_calls`
    // para uma chamada que vai acontecer seria mentira na tela de Execuções —
    // ela vira a linha normal da chamada, logo abaixo, como qualquer outra.
    d.log?.warn(
      'llm: endereço da empresa com a chave da instalação — a chamada SEGUE até o prazo',
      { ...comum, recusa_a_partir_de: RECUSA_A_PARTIR_DE },
    );
    return null;
  }

  await registrarFalha(d.db, {
    input: d.input,
    purpose: d.purpose,
    provider: d.provider,
    model: d.model,
    origem: d.origem,
    origemDaChave: d.origemDaChave,
    latencyMs: 0,
    erro,
  }).catch(() => {
    // Gravar a recusa não pode impedir a recusa.
  });

  d.log?.warn('llm: chamada recusada — endereço escolhido pela empresa com a chave da instalação', comum);
  return erro;
}

/**
 * Um resolvedor de catálogo POR POOL. Revisão de 23/09/2026 (achado do
 * invariante de preview): antes, o custo de `llm_calls` sempre passava pelo
 * catálogo HTTP (`precoDoCatalogoOuNull`, `lib/ai/runtime/cost.ts`), que abre
 * `fetch` para o PostgREST (`createAdminClient`). `runAgentPreview` (o ensaio
 * do agente) exige ZERO `fetch`, e este seam já recebe um `pg.Pool` (`db`)
 * para tudo o mais. O resolvedor abaixo lê `ai_models` pelo MESMO `db`, com o
 * mesmo cache de 5 min, o mesmo prazo de 2s e o mesmo backoff de 60s da leitura
 * HTTP (a lógica é compartilhada, `criarResolvedorDeCatalogo`; só a FONTE
 * muda).
 *
 * `WeakMap<pg.Pool, …>` em vez de uma variável de módulo única: cada `db`
 * (normalmente um único `pg.Pool` por processo, ver `lib/agent-engine/db/pool.ts`)
 * ganha seu PRÓPRIO cache. Dois `Pool` diferentes (produção vs. um teste que
 * cria um pool novo) nunca compartilham nem vazam estado entre si, e um pool
 * finalizado libera o resolvedor sozinho (`WeakMap` não retém).
 *
 * A consulta usa `Promise.race` (dentro de `criarResolvedorDeCatalogo`) para o
 * prazo de 2s, não `SET LOCAL statement_timeout`, de propósito: `SET LOCAL`
 * só vale dentro de uma transação, e fora dela vira `SET` de sessão, que uma
 * conexão do pool levaria para a PRÓXIMA consulta de outro chamador. Sem
 * transação aqui (é um único `select`), `Promise.race` dá o mesmo prazo sem
 * abrir esse risco.
 */
const resolvedoresDeCatalogoPorPool = new WeakMap<
  pg.Pool,
  ReturnType<typeof criarResolvedorDeCatalogo>
>();

function resolvedorDeCatalogoPeloDb(db: pg.Pool) {
  const existente = resolvedoresDeCatalogoPorPool.get(db);
  if (existente) return existente;
  const resolvedor = criarResolvedorDeCatalogo(async () => {
    const { rows } = await db.query<ModelPricingRow>(
      `select provider, model_id, input_price_per_million_cents, output_price_per_million_cents, deprecated_at
         from ai_models`,
    );
    return rows;
  });
  resolvedoresDeCatalogoPorPool.set(db, resolvedor);
  return resolvedor;
}

export async function runModelCall(db: pg.Pool, cfg: LlmEdgeConfig, input: RunModelCallInput, deps: RunModelCallDeps = {}) {
  // O knob do raciocínio da DeepSeek entra pela fábrica: `deepseekThinking` só é
  // lido pela fábrica `deepseek`, então os outros provedores não têm como mudar.
  const registry = deps.registry ?? createDefaultRegistry({ deepseekThinking: cfg.deepseekThinking });
  const purpose = input.purpose ?? 'agent_turn';

  // A config da org é lida ANTES da decisão porque o resolvedor precisa dela
  // como último degrau da precedência (o padrão, quando ninguém mais opinou).
  const padrao = await resolveOrgLlmConfig(db, cfg, input.tenantId, input.llmOverride);

  // O painel de provedores entra AQUI, e é o que faz `purpose` deixar de ser
  // só um rótulo de custo e virar decisão. Sem binding configurado, `decisao`
  // reproduz exatamente o comportamento anterior — a origem volta como
  // 'variavel_de_ambiente' ou 'padrao_da_organizacao'.
  const decisao = await decidirParaOSeam(db, {
    organizationId: input.tenantId,
    purpose,
    modeloDoCallSite: input.model,
    overrideDoAgente:
      input.llmOverride === undefined
        ? null
        : {
            provider: input.llmOverride.provider ?? padrao.provider,
            credentialId: input.llmOverride.credentialId ?? null,
            model: input.model,
          },
    padraoDaOrganizacao: { provider: padrao.provider, defaultModel: padrao.defaultModel },
  }, deps.log ? { log: deps.log } : {});

  // Só re-resolve a credencial quando a decisão aponta para OUTRA que não a já
  // carregada — decifrar duas vezes a mesma chave é custo puro no caminho
  // quente, e cada decifragem é mais um instante com plaintext em memória.
  //
  // A condição olha para o QUE FOI DECIDIDO, nunca para o rótulo da origem. Ela
  // já foi `decisao.origem === 'binding' && (…)`, e amarrar a correção a um
  // rótulo é o que permite decisão e execução divergirem: qualquer ramo que
  // devolvesse um provider fora do já resolvido saía com a chave do outro —
  // silenciosamente, porque `factory` usa `config.provider` e não
  // `decisao.provider`. `padrao` foi resolvido com `input.llmOverride`, então
  // comparar contra ele é comparar contra o que de fato está carregado.
  const credencialJaCarregada = input.llmOverride?.credentialId ?? null;
  const precisaOutraCredencial =
    decisao.provider !== padrao.provider ||
    (decisao.credentialId !== null && decisao.credentialId !== credencialJaCarregada);

  const config = precisaOutraCredencial
    ? await resolveOrgLlmConfig(db, cfg, input.tenantId, {
        provider: decisao.provider,
        credentialId: decisao.credentialId,
      })
    : padrao;

  const model = decisao.modelId;
  if (model === null || model === undefined) {
    throw new Error(
      'modelo LLM não definido — configure o ponto no painel de provedores, ' +
        'organizations.settings.llm.default_model, ou passe input.model',
    );
  }
  if (config.enabledModels.length > 0 && !config.enabledModels.includes(model)) {
    throw new LlmModelNotEnabledError(model);
  }
  const factory = registry[config.provider];
  if (factory === undefined) {
    throw new LlmProviderUnknownError(config.provider);
  }
  const parsedParams = paramsSchema.safeParse(config.params);
  if (!parsedParams.success) {
    throw new Error('params inválidos em organizations.settings.llm.params — corrija a config da org');
  }
  const { temperature, topP, topK, maxOutputTokens } = parsedParams.data;

  // ═══ A CHAVE DA INSTALAÇÃO NÃO VAI PARA O ENDEREÇO DA EMPRESA ═══
  //
  // `decisao.baseUrl` só existe quando o ponto tem endereço próprio, e ele vem
  // de `ai_purpose_bindings` — tabela POR ORGANIZAÇÃO, editada por quem a
  // administra. `config.origemDaChave` diz se a chave carregada é dela ou é o
  // `.env` que paga a conta de todas as empresas do servidor. Juntos, os dois
  // mandariam a chave da instalação para um endereço que UMA empresa escolheu.
  // Decisão 22-a do dono do produto: endereço próprio exige chave própria.
  //
  // A condição olha para o que foi DECIDIDO e CARREGADO, nunca para o rótulo
  // `decisao.origem` — mesma regra de `precisaOutraCredencial` acima. E vem
  // antes do teto: é recusa de configuração, e consultar gasto para uma chamada
  // que não vai sair seria custo à toa. O mesmo corte vale no worker de mídia
  // (`workers/media-derive-worker.ts`), pela mesma fonte.
  //
  // ═══ EM DOIS TEMPOS, E O SEGUNDO ENTRA SOZINHO ═══
  //
  // Recusar no instante da atualização obrigaria quem opera a agir ANTES de
  // atualizar — o que, pela régua de versionamento, é major, e major só sai
  // quando o dono do produto pede (decisão dele, 19/09/2026, doc 40). Então
  // até `RECUSA_A_PARTIR_DE` a chamada SEGUE e o aviso na Central traz a DATA;
  // a partir dela, a recusa entra sem ninguém precisar reabrir o assunto.
  // A regra e o relógio injetável moram em `./prazo-do-endereco-proprio.ts`.
  if (decisao.baseUrl && config.origemDaChave === 'chave_da_instalacao') {
    const erroOuNulo = await registrarRecusaDeEnderecoSemChave({
      db,
      input,
      purpose,
      provider: config.provider,
      model,
      origem: decisao.origem,
      origemDaChave: config.origemDaChave,
      baseUrl: decisao.baseUrl,
      degrau: degrauDoEnderecoProprio(deps.agora ?? new Date()),
      ...(deps.log ? { log: deps.log } : {}),
    });
    if (erroOuNulo) throw erroOuNulo;
  }

  // ═══ O TETO, LOGO ANTES DE SAIR BYTE ═══
  //
  // Fica DEPOIS da resolução de modelo/provider, e não antes como o
  // `assertBudget` de origem, por uma razão de informação: a recusa agora vira
  // linha em `llm_calls`, e aquela tabela tem `model text not null`. Chamado no
  // ponto antigo, o gate teria de inventar um nome de modelo para gravar — e um
  // valor inventado numa tabela de auditoria é pior que a linha faltando.
  // Continua ANTES de qualquer byte ao provedor, que é a propriedade que
  // importa: bloqueio custa zero token.
  await aplicarOrcamento({
    db,
    organizationId: input.tenantId,
    orcamentoDaConfig: config.orcamento,
    orcamentoIndisponivelPorque: config.orcamentoIndisponivelPorque,
    // A chave EFETIVA da instalação: a linha escrita na tela de admin vence, e
    // o valor do `.env` (que veio na config) é o PISO. A leitura é feita AQUI,
    // a cada chamada, porque é aqui que a decisão acontece — um snapshot no
    // boot faria o kill switch da tela só valer depois de reiniciar o worker
    // (issue #1034). Sem banco lido nesta vida do processo, isto é o de hoje.
    chave: chaveDeOrcamentoDaInstalacao(cfg.budgetEnforcement ?? 'on'),
    purpose,
    provider: config.provider,
    model,
    origem: decisao.origem,
    origemDaChave: config.origemDaChave,
    input,
    ...(deps.log ? { log: deps.log } : {}),
  });

  // ═══ A ASSINATURA SUSPENSA (MODO LEITURA), ANTES DA CARTEIRA ═══
  //
  // Decisões 5 e 6 da fase F4 (`hiperbold/planos/fase-F4-tarefas.md`, Tarefa
  // 6): veto de NEGÓCIO diferente e ANTERIOR aos dois abaixo — uma conta que
  // não paga a mensalidade não tem carteira nem orçamento que a salve. Mesma
  // chave `PLANOS_BLOQUEIO` (`cfg.bloqueioDePlanos`) da carteira, e pelo mesmo
  // motivo dela: `billing_settings.modo` (não a chave sozinha) é quem de fato
  // manda, lido dentro de `aplicarAssinatura` (mesmo cache, 60s por pool).
  await aplicarAssinatura({
    db,
    organizationId: input.tenantId,
    chave: cfg.bloqueioDePlanos ?? 'on',
    purpose,
    provider: config.provider,
    model,
    origem: decisao.origem,
    origemDaChave: config.origemDaChave,
    input,
    ...(deps.log ? { log: deps.log } : {}),
  });

  // ═══ A CARTEIRA DE TOKENS, LOGO EM SEGUIDA ═══
  //
  // Mesmo ponto (antes de qualquer byte ao provedor), mesma razão. É um veto
  // INDEPENDENTE do orçamento em dólar acima (decisões 6 e 7 da fase F3, ver o
  // cabeçalho de `./carteira.ts`): uma organização pode estourar só um dos dois, e
  // os dois precisam poder recusar sem que um mascare o outro no log nem na Central.
  //
  // `cfg.bloqueioDePlanos` NÃO passa por `lib/instalacao/comportamento.ts` (ao
  // contrário da chave de orçamento, que tem override por `platform_settings`):
  // a decisão 1 da fase declara `PLANOS_BLOQUEIO` uma chave só de `.env`, sem linha
  // de banco própria: o modo que de fato manda é `billing_settings.modo`, lido
  // dentro de `aplicarCarteira` (cacheado, 60s por pool).
  await aplicarCarteira({
    db,
    organizationId: input.tenantId,
    chave: cfg.bloqueioDePlanos ?? 'on',
    purpose,
    provider: config.provider,
    model,
    origem: decisao.origem,
    origemDaChave: config.origemDaChave,
    input,
    ...(deps.log ? { log: deps.log } : {}),
  });

  // Disciplina de cache: o prefixo estável org-wide (system do playbook + tools
  // em ordem determinística) ganha os breakpoints AQUI, no seam — call sites
  // passam system/tools crus. Tudo por-lead vive em input.messages, DEPOIS do
  // breakpoint. TTL: knob LLM_CACHE_TTL; '1h' é a doutrina.
  const prefix = buildStablePrefix({
    system: input.system,
    tools: input.tools,
    cacheTtl: cfg.cacheTtl ?? '1h',
  });

  const startedAt = Date.now();
  // O que os passos JÁ CONCLUÍDOS custaram ao provedor (D-156). Num laço de
  // ferramentas, uma falha no passo 3 não desfaz o que os passos 1 e 2 gastaram:
  // sem esta soma a linha de falha saía com zero token, e llm_calls, carteira e
  // orçamento deixavam de contar dinheiro já pago (e o job, ao tentar de novo,
  // repetia o gasto sem que ninguém o visse).
  const pagos = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let result: Awaited<ReturnType<typeof generateText>>;
  try {
    input.abortSignal?.throwIfAborted();
    // `system` aceita SystemModelMessage (com providerOptions de cache) — igual
    // em v6 e v7 (smoke prova que o cacheControl continua virando cache_control).
    result = await generateText({
      // `decisao.baseUrl` só é preenchido quando o painel apontou um endpoint
      // (gateway OpenAI-compatível, ou modelo local). Providers canônicos
      // ignoram o terceiro argumento e vão ao endpoint intrínseco.
      // `config.baseUrl` é o da PRÓPRIA credencial e só o provedor personalizado
      // (#1642) tem um: o endereço nasce junto da chave, então o agente
      // publicado nele alcança o mesmo gateway que a tela testou ao salvar.
      model: factory(config.apiKey, model, decisao.baseUrl ?? config.baseUrl ?? undefined),
      system: prefix.system,
      messages: input.messages,
      abortSignal: input.abortSignal,
      tools: guardServiceTools(prefix.tools),
      stopWhen:
        input.maxSteps === undefined
          ? undefined
          : input.pararQuando === undefined
            ? stepCountIs(input.maxSteps)
            : [stepCountIs(input.maxSteps), input.pararQuando],
      onStepFinish: (passo) => {
        pagos.inputTokens += passo.usage?.inputTokens ?? 0;
        pagos.outputTokens += passo.usage?.outputTokens ?? 0;
        pagos.cacheReadTokens += passo.usage?.inputTokenDetails?.cacheReadTokens ?? 0;
        pagos.cacheWriteTokens += passo.usage?.inputTokenDetails?.cacheWriteTokens ?? 0;
      },
      temperature,
      topP,
      topK,
      maxOutputTokens: input.maxOutputTokens === undefined
        ? maxOutputTokens
        : Math.min(maxOutputTokens ?? Infinity, input.maxOutputTokens),
    });
  } catch (err) {
    // ─── A LINHA QUE FALTAVA ────────────────────────────────────────────────
    //
    // Até aqui o INSERT em llm_calls vivia só DEPOIS desta chamada, sem `try`
    // em volta. Provedor recusou a chave, modelo não existe, conta sem saldo? A
    // exceção subia e NADA ficava gravado. A tabela que deveria explicar era
    // justamente a que ficava vazia no caso que precisa de explicação — e é a
    // causa direta de "o agente não responde e não aparece erro em lugar
    // nenhum".
    //
    // Grava e RELANÇA: quem chama continua decidindo o que fazer com a falha
    // (o worker reagenda, o dry-run mostra na tela). Engolir aqui trocaria uma
    // falha invisível por uma silenciosa, que é pior.
    const jaPagou = pagos.inputTokens + pagos.outputTokens > 0;
    await registrarFalha(db, {
      input,
      purpose,
      provider: config.provider,
      model,
      origem: decisao.origem,
      origemDaChave: config.origemDaChave,
      latencyMs: Date.now() - startedAt,
      erro: err,
      ...(jaPagou
        ? {
            usoParcial: {
              ...pagos,
              // Preço desconhecido continua nulo, nunca zero; a falha em calcular não
              // pode impedir a gravação da linha.
              custoCents: await custoCentsComCatalogo(
                config.provider,
                model,
                pagos,
                cfg.cacheTtl ?? '1h',
                deps.log,
                resolvedorDeCatalogoPeloDb(db).precoDoCatalogoOuNull,
              ).catch(() => null),
            },
          }
        : {}),
    }).catch(() => {
      // O log da falha não pode causar uma segunda falha. Se o próprio INSERT
      // de erro falhar, o erro ORIGINAL é o que interessa a quem chamou.
    });
    deps.log?.error('llm: chamada falhou', {
      organization_id: input.tenantId,
      purpose,
      provider: config.provider,
      model,
      origem_da_escolha: decisao.origem,
      ...normalizarErro(err),
    });
    throw err;
  }
  const latencyMs = Date.now() - startedAt;

  const usage = {
    inputTokens: result.usage.inputTokens ?? 0,
    outputTokens: result.usage.outputTokens ?? 0,
    cacheReadTokens: result.usage.inputTokenDetails.cacheReadTokens ?? 0,
    cacheWriteTokens: result.usage.inputTokenDetails.cacheWriteTokens ?? 0,
  };
  // O TTL é o MESMO que gravou o prefixo estável acima: a gravação de cache custa
  // 1.25× a entrada em 5m e 2× em 1h, e supor a doutrina superfaturaria 60% da
  // parcela de cache write em quem usa o knob.
  //
  // D-050: modelo fora da tabela de Anthropic (ex.: `gpt-5.6-luna`) cai para o
  // catálogo `ai_models` em vez de virar `cost_cents` nulo para sempre, ver o
  // resolvedor único em `./pricing`. Revisão de 23/09/2026: a leitura do
  // catálogo aqui é pelo `db` (pg.Pool), nunca HTTP; ver o comentário do
  // resolvedor acima.
  const cost = await custoCentsComCatalogo(
    config.provider,
    model,
    usage,
    cfg.cacheTtl ?? '1h',
    deps.log,
    resolvedorDeCatalogoPeloDb(db).precoDoCatalogoOuNull,
  );

  const { rows } = await db.query<{ id: string }>(
    `insert into llm_calls
       (organization_id, contact_id, job_id, variant_id, purpose, provider, model,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_cents, latency_ms,
        status, origem_da_escolha, agent_id, origem_da_chave)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'ok', $14, $15, $16)
     returning id`,
    [
      input.tenantId,
      input.leadId ?? null,
      input.jobId ?? null,
      input.variantId ?? null,
      purpose,
      config.provider,
      model,
      usage.inputTokens,
      usage.outputTokens,
      usage.cacheReadTokens,
      usage.cacheWriteTokens,
      cost,
      latencyMs,
      decisao.origem,
      input.agentId ?? null,
      // 0906 (carteira de tokens): de quem é a chave desta chamada bem-sucedida.
      config.origemDaChave,
    ],
  );

  // Só métricas — nunca conteúdo de mensagem (PII) nem chave.
  deps.log?.info('llm: chamada concluída', {
    organization_id: input.tenantId,
    provider: config.provider,
    model,
    purpose,
    // POR QUE este modelo, e não só QUAL: é a diferença entre um log que
    // confirma o que aconteceu e um que explica uma configuração que não
    // pegou. Vira coluna em llm_calls na frente de logs.
    origem_da_escolha: decisao.origem,
    ...usage,
    cost_cents: cost,
    latency_ms: latencyMs,
  });
  for (const aviso of decisao.avisos) {
    deps.log?.warn('llm: configuração do ponto tem incoerência', {
      organization_id: input.tenantId,
      purpose,
      aviso,
    });
  }

  return {
    result,
    callId: rows[0]?.id ?? null,
    provider: config.provider,
    model,
    usage,
    costCents: cost,
    latencyMs,
    /** De onde veio a escolha — o painel lê isto para explicar cada ponto. */
    origem: decisao.origem,
    avisos: decisao.avisos,
  };
}

/**
 * Classifica o erro do provedor num vocabulário nosso.
 *
 * Existe porque provedores diferentes relatam o MESMO problema de formas
 * diferentes: a mesma chave inválida vira `AI_APICallError` num, `401
 * Unauthorized` noutro e `authentication_error` num terceiro. Sem normalizar, a
 * tela de execuções mostraria três textos distintos e o operador não saberia
 * que os três são a mesma conversa — "a chave está errada".
 *
 * Os baldes são escolhidos pela AÇÃO que cada um exige de quem instalou:
 * trocar a chave, escolher outro modelo, esperar/pagar, ou aguardar o provedor.
 */
/**
 * Exportada para o diagnóstico da instalação usar a MESMA régua. Sem isto,
 * "por que o funcionário não responde" teria uma classificação própria, e as
 * duas telas dariam nomes diferentes ao mesmo erro do provedor.
 */
export function normalizarErro(err: unknown): {
  error_code: string;
  error_message: string;
  http_status: number | null;
} {
  const bruto = err instanceof Error ? err.message : String(err);
  const status =
    (err as { statusCode?: number; status?: number })?.statusCode ??
    (err as { statusCode?: number; status?: number })?.status ??
    null;

  // O único erro deste seam que NÃO vem do provedor: a recusa é NOSSA, e é
  // deliberada. Casada pela CLASSE e não por regex, porque aqui não há três
  // grafias de fornecedor para reconciliar — há um objeto que nós mesmos
  // construímos. Sem este ramo a tela de Execuções mostraria "Não conseguimos
  // classificar esta falha" no caso mais bem explicado do produto.
  // A subclasse ANTES da mãe: `LlmCarteiraEsgotadaError extends
  // LlmBudgetExceededError` (decisão 7 da fase F3): sem este ramo primeiro, o
  // `instanceof` de baixo casaria as duas e a carteira esgotada gravaria em
  // `llm_calls.error_code` o MESMO código do orçamento em dólar, apontando quem lê
  // para o campo errado (Uso de IA › Orçamento em vez de Plano e uso).
  if (err instanceof LlmCarteiraEsgotadaError) {
    return {
      error_code: 'carteira_de_tokens_esgotada',
      error_message: redigirMensagemDoProvedor(bruto),
      http_status: null,
    };
  }
  // Mesma doutrina do ramo acima, IRMÃ (não mãe/filha) de `LlmCarteiraEsgotadaError`:
  // as duas estendem `LlmBudgetExceededError` diretamente, então o `instanceof`
  // de uma nunca casa a outra — mas as duas precisam vir ANTES do ramo genérico
  // logo abaixo, senão a assinatura suspensa gravaria em `llm_calls.error_code`
  // o código do orçamento em dólar (fase F4, decisão 6, Tarefa 6).
  if (err instanceof LlmAssinaturaSuspensaError) {
    return {
      error_code: 'assinatura_suspensa',
      error_message: redigirMensagemDoProvedor(bruto),
      http_status: null,
    };
  }
  if (err instanceof LlmBudgetExceededError) {
    return { error_code: 'orcamento_esgotado', error_message: redigirMensagemDoProvedor(bruto), http_status: null };
  }
  // A outra recusa nossa: endereço da empresa com a chave da instalação.
  if (err instanceof LlmEnderecoExigeChaveDaEmpresaError) {
    return {
      error_code: 'endereco_exige_chave_da_empresa',
      error_message: redigirMensagemDoProvedor(bruto),
      http_status: null,
    };
  }

  let codigo = 'erro_desconhecido';
  if (status === 401 || status === 403 || /unauthor|invalid.*api.?key|authentication|incorrect api key/i.test(bruto)) {
    codigo = 'credencial_recusada';
  } else if (status === 404 || /model.*not.*found|does not exist/i.test(bruto)) {
    codigo = 'modelo_inexistente';
  } else if (status === 429 || /rate.?limit|quota|insufficient.*credit|credit balance is too low/i.test(bruto)) {
    // A Anthropic diz "sem crédito" com 400 ("Your credit balance is too low…"),
    // o mesmo status de um pedido malformado — só a frase distingue. Sem ela a
    // tela de Execuções mostrava "erro desconhecido" no caso mais fácil de
    // resolver (recarregar). A espera pela recarga é da fila: `espera-de-saldo.ts`.
    codigo = 'limite_ou_saldo';
  } else if ((status !== null && status >= 500) || /timeout|ECONNREFUSED|fetch failed|network/i.test(bruto)) {
    codigo = 'provedor_indisponivel';
  } else if (/tool|function.?call/i.test(bruto)) {
    codigo = 'modelo_sem_ferramentas';
  }

  return {
    error_code: codigo,
    // Redigida E truncada. O comentário anterior dizia "sem
    // prompt/resposta/chave" e o único tratamento era o `slice` — a garantia
    // estava escrita e não existia, que é pior que não existir e ninguém
    // achar que existe.
    //
    // A mensagem crua do provedor vai para `llm_calls.error_message`, sai no
    // JSON de `GET /api/v1/ai/runs` e é renderizada na tela de Execuções para
    // qualquer `manager` da organização. Um endpoint OpenAI-compatível
    // apontado por `base_url` — caminho que o painel de provedores abre — pode
    // ecoar no corpo de erro o header de autorização ou o prompt recebido.
    error_message: redigirMensagemDoProvedor(bruto),
    http_status: typeof status === 'number' ? status : null,
  };
}

/**
 * Tira da mensagem do provedor o que não pode aparecer numa tela: segredo e
 * dado do titular. Trunca DEPOIS de redigir — cortar antes deixaria meia chave
 * passar, e meia chave ainda identifica de quem ela é.
 *
 * Os padrões de chave (`sk-…`, `Bearer …`) vêm daqui e não do
 * `lib/sentry/scrub.ts` porque lá o alvo é PII de titular; os dois se somam.
 */
export function redigirMensagemDoProvedor(bruto: string): string {
  const semSegredo = bruto
    // Chaves de API dos provedores que este produto fala: `sk-ant-…`,
    // `sk-or-v1-…`, `sk-proj-…`, `sk-…`, e as do Google (`AIza…`).
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[CHAVE]')
    .replace(/\bAIza[A-Za-z0-9_-]{10,}/g, '[CHAVE]')
    // A do Jev (`apikey_<hex>_<hex>`), que não tem `sk-` e aparece solta.
    .replace(/\bapikey_[A-Za-z0-9_]{16,}/g, '[CHAVE]')
    // O header inteiro, em qualquer caixa, com ou sem `Authorization:` na
    // frente — é assim que ele costuma aparecer ecoado num corpo de erro.
    .replace(/\b[Bb]earer\s+[A-Za-z0-9._-]{8,}/g, 'Bearer [CHAVE]')
    .replace(/\b(x-api-key|api[-_]?key|authorization)\b\s*[:=]\s*\S+/gi, '$1: [CHAVE]');
  return scrubMessage(semSegredo).slice(0, 500);
}

/**
 * Grava a chamada que FALHOU, na MESMA tabela do sucesso.
 *
 * Mesma tabela de propósito: a tela de execuções conta a história de um ponto em
 * ordem, e separar erros noutra tabela faria a leitura precisar de dois lugares
 * — que é exatamente como um dos dois para de ser olhado.
 *
 * Tokens ficam em zero e o custo em NULL: a chamada não consumiu nada, e `null`
 * é "não sei", nunca "de graça" — mesma doutrina da coluna `cost_cents`.
 */
async function registrarFalha(
  db: pg.Pool,
  d: {
    input: RunModelCallInput;
    purpose: string;
    provider: string;
    model: string;
    origem: string;
    /** 0906 (carteira de tokens): de quem é a chave desta chamada que falhou. */
    origemDaChave: OrigemDaChaveLlm;
    latencyMs: number;
    erro: unknown;
    /**
     * O que os passos concluídos antes da falha já custaram (D-156). Ausente em
     * toda recusa nossa (orçamento, carteira, assinatura): nelas nada saiu para o
     * provedor e os tokens ficam em zero.
     */
    usoParcial?: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      custoCents: number | null;
    };
  },
): Promise<void> {
  const { error_code, error_message, http_status } = normalizarErro(d.erro);
  if (d.usoParcial) {
    const u = d.usoParcial;
    await db.query(
      `insert into llm_calls
         (organization_id, contact_id, job_id, variant_id, purpose, provider, model,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_cents, latency_ms,
          status, error_code, error_message, http_status, origem_da_escolha, agent_id, origem_da_chave)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'erro', $14, $15, $16, $17, $18, $19)`,
      [
        d.input.tenantId,
        d.input.leadId ?? null,
        d.input.jobId ?? null,
        d.input.variantId ?? null,
        d.purpose,
        d.provider,
        d.model,
        u.inputTokens,
        u.outputTokens,
        u.cacheReadTokens,
        u.cacheWriteTokens,
        u.custoCents,
        d.latencyMs,
        error_code,
        error_message,
        http_status,
        d.origem,
        d.input.agentId ?? null,
        d.origemDaChave,
      ],
    );
    return;
  }
  await db.query(
    `insert into llm_calls
       (organization_id, contact_id, job_id, variant_id, purpose, provider, model,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_cents, latency_ms,
        status, error_code, error_message, http_status, origem_da_escolha, agent_id, origem_da_chave)
     values ($1, $2, $3, $4, $5, $6, $7, 0, 0, 0, 0, null, $8, 'erro', $9, $10, $11, $12, $13, $14)`,
    [
      d.input.tenantId,
      d.input.leadId ?? null,
      d.input.jobId ?? null,
      d.input.variantId ?? null,
      d.purpose,
      d.provider,
      d.model,
      d.latencyMs,
      error_code,
      error_message,
      http_status,
      d.origem,
      d.input.agentId ?? null,
      d.origemDaChave,
    ],
  );
}
