import "server-only";

/**
 * A conciliação diária do Asaas: fase F5 (`hiperbold/planos/fase-F5-
 * tarefas.md`), Tarefa 16, decisão 21.
 *
 * RESTRIÇÃO ABSOLUTA DESTA FASE: nenhuma chamada real ao Asaas, nem ao
 * sandbox, sai daqui em teste. `conciliarAsaas` recebe tudo por injeção, num
 * único objeto (`db`, `asaas`, `config`, `logger`, mais limites opcionais),
 * no mesmo molde de `processarEventosAsaas`
 * (`lib/billing/asaas/processar-eventos.ts`, Tarefa 13): uma interface
 * ESTREITA para o banco (`DbConciliarAsaas`), nunca um `SupabaseClient`
 * genérico dentro da função pura. A implementação real
 * (`criarDbConciliarAsaasSobre`) mora neste mesmo arquivo.
 *
 * ═══ O que esta rodada FAZ (decisão 21) ═══
 *
 * O webhook (Tarefa 12) e o processador (Tarefa 13) cobrem o caminho feliz:
 * evento chega, é confirmado por GET e aplicado. A conciliação é a REDE DE
 * SEGURANÇA para quando um evento nunca chegou (webhook perdido, fila do
 * Asaas pausada) ou quando o próprio processador ficou preso num passo
 * (remoção de cobrança que falhou). Ela roda uma vez ao dia, ANTES do
 * conferidor de vencimento (05:40 UTC), e faz cinco coisas, sempre pelo MESMO
 * caminho de aplicação que o webhook usa (nunca um atalho que aplique direto):
 *
 *   1. Pedidos `aguardando_pagamento` ou `inconclusivo`, mais os `processando`
 *      travados há mais de 15 minutos (posse atômica que nunca terminou o
 *      POST, decisão 25): compara o que o Asaas mostra com o banco e injeta
 *      um evento SINTÉTICO (`event_id = 'conc:<id>:<status>'`,
 *      `origem = 'conciliacao'`) por `fn_billing_asaas_registrar_evento` - a
 *      MESMA função que o webhook usa. O processador (Tarefa 13) é quem
 *      aplica, na rodada seguinte dele; esta função NUNCA chama
 *      `fn_billing_asaas_aplicar_evento` diretamente.
 *   2. Assinaturas Asaas ativas (`billing_contracts.asaas_subscription_id`
 *      preenchido, `asaas_assinatura_encerrada_em` nulo): confere se a
 *      assinatura ainda existe no Asaas; se sumiu (404/`deleted:true`),
 *      injeta o evento sintético `SUBSCRIPTION_DELETED`.
 *   3. Pedido `vencido` com `asaas_payment_id` ou `asaas_subscription_id`
 *      ainda gravado: refaz `removerCobranca` (pedido avulso) ou
 *      `removerAssinatura` (pedido de tipo `assinatura` com
 *      `asaas_subscription_id`, decisão 4/10) - idempotente (um recurso já
 *      removido não lança), para quando a tentativa do processador tiver
 *      falhado antes.
 *   4. Poda: `fn_billing_asaas_podar_eventos(180)` (N38).
 *   5. Alarmes: os CONTADORES de `lib/billing/asaas/leitura.ts`
 *      (`contadoresDeAlarmeAsaas`, reaproveitados aqui em vez de
 *      reimplementados) mais `GET /webhooks/{ASAAS_WEBHOOK_ID}` - `interrupted`
 *      vira alarme (M6). Cada alarme sai por `logger.error` com um código
 *      fixo.
 *
 * ═══ Teto de 200 GET por rodada (decisão 21) ═══
 *
 * Só os passos 1 e 2 gastam `GET` no Asaas (o passo 3 é `DELETE`, e não entra
 * no teto: é idempotente e a chamada isolada é barata). `podeGastarGet` conta
 * TODO `GET` feito nos passos 1 e 2; ao esgotar o teto, a rodada para de
 * consultar o Asaas (o que sobrou fica para a rodada seguinte) mas ainda
 * roda os passos 3 a 5.
 *
 * ═══ Desligada sem ASAAS_ENABLED (decisão 21) ═══
 *
 * Com `config.habilitado` falso, a função devolve o resumo zerado sem tocar
 * banco nem rede: mesma doutrina de `processarEventosAsaas`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { ClienteAsaasHttp, LoggerAsaas } from "./cliente";
import type { AmbienteAsaas, ConfigAsaas } from "./config";
import type { CobrancaAsaas } from "./contratos";
import { ErroAsaasException } from "./erros";
import { contadoresDeAlarmeAsaas, type ContadoresDeAlarmeAsaas } from "./leitura";

// ─── A interface estreita do banco ─────────────────────────────────────────

export interface RpcErro {
  code?: string;
  message?: string;
}

export interface RpcResultado<T> {
  data: T | null;
  error: RpcErro | null;
}

/** Uma linha de `billing_orders` candidata à conciliação (decisão 21). */
export interface PedidoParaConciliar {
  id: string;
  organizationId: string;
  ambiente: "sandbox" | "producao";
  tipo: string;
  status: string;
  externalReference: string;
  asaasPaymentId: string | null;
  asaasSubscriptionId: string | null;
}

/**
 * Um pedido `vencido` com cobrança ou assinatura ainda gravada (decisão 10,
 * correção A1/4). Pedido de tipo `assinatura` com `asaasSubscriptionId`
 * refaz `removerAssinatura`, nunca `removerCobranca` (a assinatura inteira
 * precisa sair, não só a cobrança avulsa do ciclo vencido).
 */
export interface PedidoVencidoParaRemocao {
  id: string;
  organizationId: string;
  tipo: string;
  asaasPaymentId: string | null;
  asaasSubscriptionId: string | null;
}

/** Uma assinatura Asaas ainda ativa localmente (decisão 21). */
export interface AssinaturaAtivaParaConciliar {
  organizationId: string;
  asaasSubscriptionId: string;
}

export interface RegistrarEventoSinteticoInput {
  eventId: string;
  eventType: string;
  idDoRecurso: string | null;
  ambiente: "sandbox" | "producao";
  payload: Record<string, unknown>;
}

export interface DbConciliarAsaas {
  /** Pedidos `aguardando_pagamento`/`inconclusivo`/`processando` travado (decisão 21). */
  listarPedidosPendentes(limite: number): Promise<RpcResultado<PedidoParaConciliar[]>>;
  /** Pedidos `vencido` com `asaas_payment_id` ainda gravado (decisão 10, A1). */
  listarPedidosVencidosParaRemocao(limite: number): Promise<RpcResultado<PedidoVencidoParaRemocao[]>>;
  /** `billing_contracts` com assinatura Asaas ativa (decisão 21). */
  listarAssinaturasAtivas(limite: number): Promise<RpcResultado<AssinaturaAtivaParaConciliar[]>>;
  /**
   * `billing_customers.asaas_customer_id` da organização, para montar o
   * payload sintético de `SUBSCRIPTION_DELETED`. Filtra pelo AMBIENTE
   * (decisão 6/risco 12): uma organização pode ter cliente Asaas em sandbox
   * e em produção ao longo do tempo, e o `customer` do payload sintético
   * precisa ser o da MESMA base que o resto do evento, senão o roteamento
   * (`payment.customer confirmado tem de ser o billing_customers.asaas_
   * customer_id da mesma organização e do mesmo ambiente`) trata como
   * `divergente` sem nunca ter sido de fato.
   */
  clienteAsaasDaOrganizacao(organizationId: string, ambiente: AmbienteAsaas): Promise<RpcResultado<string | null>>;
  /** `fn_billing_pedido_marcar(p_status = 'inconclusivo')`: destrava o `processando` velho. */
  marcarPedidoInconclusivo(organizationId: string, pedidoId: string, motivo: string): Promise<RpcResultado<unknown>>;
  /** `fn_billing_asaas_registrar_evento` com `p_origem = 'conciliacao'` (mesmo caminho do webhook). */
  registrarEventoSintetico(input: RegistrarEventoSinteticoInput): Promise<RpcResultado<{ novo: boolean }>>;
  /** `fn_billing_asaas_podar_eventos(p_dias)` (N38). */
  podarEventos(dias: number): Promise<RpcResultado<{ podados: number }>>;
  /** Os contadores de alarme de `lib/billing/asaas/leitura.ts` (decisão 21), reaproveitados aqui. Nunca lança (mesma doutrina de `leitura.ts`): erro de leitura vira `leituraFalhou: true`. */
  contadoresDeAlarme(): Promise<{ contadores: ContadoresDeAlarmeAsaas; leituraFalhou: boolean }>;
}

export interface DepsConciliarAsaas {
  db: DbConciliarAsaas;
  asaas: ClienteAsaasHttp;
  config: ConfigAsaas;
  logger: LoggerAsaas;
  /** Máximo de `GET` ao Asaas nos passos 1 e 2 (decisão 21). Padrão: `LIMITE_GETS_PADRAO`. */
  limiteGets?: number;
  /** Máximo de pedidos pendentes lidos do banco por rodada. Padrão: `LIMITE_PEDIDOS_PADRAO`. */
  limitePedidos?: number;
  /** Máximo de assinaturas ativas lidas do banco por rodada. Padrão: `LIMITE_ASSINATURAS_PADRAO`. */
  limiteAssinaturas?: number;
  /** Máximo de pedidos `vencido` cuja remoção é refeita por rodada. Padrão: `LIMITE_VENCIDOS_PADRAO`. */
  limiteVencidos?: number;
  /** Dias de retenção do payload antes da poda (N38). Padrão: `DIAS_DE_PODA_PADRAO` (180). */
  diasDePoda?: number;
}

export interface ResumoConciliarAsaas {
  habilitado: boolean;
  pedidosAnalisados: number;
  assinaturasAnalisadas: number;
  eventosSinteticos: number;
  pedidosMarcadosInconclusivo: number;
  semCobrancaEncontrada: number;
  cobrancasRemovidas: number;
  falhas: number;
  podados: number;
  webhookInterrompido: boolean;
  cortadoPeloTetoDeGets: boolean;
  contadores: ContadoresDeAlarmeAsaas;
}

export const LIMITE_GETS_PADRAO = 200;
export const LIMITE_PEDIDOS_PADRAO = 200;
export const LIMITE_ASSINATURAS_PADRAO = 200;
export const LIMITE_VENCIDOS_PADRAO = 200;
export const DIAS_DE_PODA_PADRAO = 180;

const CONTADORES_ZERADOS: ContadoresDeAlarmeAsaas = {
  pendenteHaMaisDeUmaHora: 0,
  erroUltimas24h: 0,
  divergenteUltimas24h: 0,
  semVinculoUltimas24h: 0,
  semEventoHa3DiasComAssinaturaAtiva: 0,
};

function resumoZerado(habilitado: boolean): ResumoConciliarAsaas {
  return {
    habilitado,
    pedidosAnalisados: 0,
    assinaturasAnalisadas: 0,
    eventosSinteticos: 0,
    pedidosMarcadosInconclusivo: 0,
    semCobrancaEncontrada: 0,
    cobrancasRemovidas: 0,
    falhas: 0,
    podados: 0,
    webhookInterrompido: false,
    cortadoPeloTetoDeGets: false,
    contadores: CONTADORES_ZERADOS,
  };
}

function tipoDoErro(err: unknown): string {
  return err instanceof ErroAsaasException ? err.erro.tipo : "desconhecido";
}

function ehErroDeConfiguracao(err: unknown): boolean {
  return err instanceof ErroAsaasException && err.erro.tipo === "configuracao";
}

// ─── Mapeia o status confirmado da cobrança para o event_type sintético ────

const EVENT_TYPE_POR_STATUS_DE_PAGAMENTO: Record<string, string> = {
  CONFIRMED: "PAYMENT_CONFIRMED",
  RECEIVED: "PAYMENT_RECEIVED",
  RECEIVED_IN_CASH: "PAYMENT_RECEIVED_IN_CASH",
  OVERDUE: "PAYMENT_OVERDUE",
};

const STATUS_PAGO_ESPERADO = new Set(["PAYMENT_CONFIRMED", "PAYMENT_RECEIVED", "PAYMENT_RECEIVED_IN_CASH"]);

/**
 * As TRÊS divergências da decisão 21: "cobrança paga sem evento aplicado"
 * (pedido ainda não `pago`, mas o Asaas confirma um dos três status de
 * dinheiro) e "cobrança vencida" (pedido ainda não `vencido`, mas o Asaas
 * confirma `OVERDUE`). Fora dessas duas comparações, nada diverge: o banco já
 * está de acordo com o Asaas (ex.: cobrança ainda `PENDING` e pedido ainda
 * `aguardando_pagamento`), e nenhum evento é criado.
 */
function eventoSinteticoDaCobranca(pedidoStatus: string, cobranca: CobrancaAsaas): string | null {
  const eventType = EVENT_TYPE_POR_STATUS_DE_PAGAMENTO[cobranca.status];
  if (!eventType) return null;
  if (STATUS_PAGO_ESPERADO.has(eventType)) return pedidoStatus === "pago" ? null : eventType;
  if (eventType === "PAYMENT_OVERDUE") return pedidoStatus === "vencido" ? null : eventType;
  return null;
}

// ─── Passo 1: pedidos aguardando_pagamento/inconclusivo/processando ────────

interface OrcamentoDeGets {
  restante(): boolean;
  gastar(): void;
}

/**
 * Estado compartilhado entre os passos: um erro de CONFIGURAÇÃO (`ASAAS_
 * ENABLED` ligado com base/chave incoerentes) não é do item, é do ambiente -
 * uma vez visto, os passos seguintes que falam com o Asaas (incluindo a
 * remoção de cobrança do passo 3) nem tentam, porque repetiriam o mesmo erro.
 */
interface EstadoDaRodada {
  configInvalida: boolean;
}

function criarOrcamentoDeGets(limite: number): OrcamentoDeGets {
  let usados = 0;
  return {
    restante: () => usados < limite,
    gastar: () => {
      usados += 1;
    },
  };
}

/**
 * Acha a cobrança do pedido para comparar com o banco. Ordem: pelo
 * `asaas_payment_id` já gravado; senão pelo `asaas_subscription_id` (pega a
 * mais recente das cobranças da assinatura); senão pela `externalReference`
 * do próprio pedido (o caso do pedido travado que nunca chegou a gravar um
 * id) - e, para pedido de assinatura, tenta achar a ASSINATURA pela
 * referência antes de listar as cobranças dela. Sem achar nada, devolve
 * `null`: para um pedido `inconclusivo` isso não é erro, é exatamente o caso
 * "sem cobrança achada pela referência volta a poder ser retomado" (decisão
 * 21) - `fn_billing_pedido_tomar` já aceita retomar um pedido `inconclusivo`
 * sem nenhuma mudança de estado necessária aqui.
 */
async function acharCobrancaDoPedido(
  asaas: ClienteAsaasHttp,
  pedido: PedidoParaConciliar,
  orcamento: OrcamentoDeGets,
): Promise<CobrancaAsaas | null> {
  if (pedido.asaasPaymentId) {
    orcamento.gastar();
    const r = await asaas.buscarCobranca(pedido.asaasPaymentId);
    return "removido" in r ? null : r;
  }

  if (pedido.asaasSubscriptionId) {
    orcamento.gastar();
    const cobrancas = await asaas.listarCobrancasDaAssinatura(pedido.asaasSubscriptionId);
    return cobrancas[0] ?? null;
  }

  orcamento.gastar();
  const porReferencia = await asaas.buscarCobrancaPorReferencia(pedido.externalReference);
  if (porReferencia) return porReferencia;

  if (pedido.tipo === "assinatura") {
    orcamento.gastar();
    const assinatura = await asaas.buscarAssinaturaPorReferencia(pedido.externalReference);
    if (!assinatura) return null;
    orcamento.gastar();
    const cobrancas = await asaas.listarCobrancasDaAssinatura(assinatura.id);
    return cobrancas[0] ?? null;
  }

  return null;
}

async function processarPedidosPendentes(
  deps: DepsConciliarAsaas,
  resumo: ResumoConciliarAsaas,
  orcamento: OrcamentoDeGets,
  estado: EstadoDaRodada,
): Promise<void> {
  const limite = deps.limitePedidos ?? LIMITE_PEDIDOS_PADRAO;
  const pendentes = await deps.db.listarPedidosPendentes(limite);
  if (pendentes.error) {
    deps.logger.error("asaas_conciliar_listar_pedidos_falhou", { codigo: pendentes.error.code });
    resumo.falhas++;
    return;
  }
  const pedidos = pendentes.data ?? [];
  resumo.pedidosAnalisados = pedidos.length;

  for (const pedido of pedidos) {
    // Pedido travado em `processando` (posse atômica que nunca terminou o
    // POST, decisão 25): não gasta GET, só destrava para `fn_billing_pedido_
    // tomar` poder pegar de novo.
    if (pedido.status === "processando") {
      const marcado = await deps.db.marcarPedidoInconclusivo(
        pedido.organizationId,
        pedido.id,
        "conciliacao: pedido travado em processando ha mais de 15 minutos",
      );
      if (marcado.error) {
        deps.logger.error("asaas_conciliar_marcar_inconclusivo_falhou", {
          pedidoId: pedido.id,
          codigo: marcado.error.code,
        });
        resumo.falhas++;
      } else {
        resumo.pedidosMarcadosInconclusivo++;
      }
      continue;
    }

    if (!orcamento.restante()) {
      resumo.cortadoPeloTetoDeGets = true;
      break;
    }

    let cobranca: CobrancaAsaas | null;
    try {
      cobranca = await acharCobrancaDoPedido(deps.asaas, pedido, orcamento);
    } catch (err) {
      if (ehErroDeConfiguracao(err)) {
        deps.logger.error("asaas_conciliar_erro_de_configuracao_abortando", { pedidoId: pedido.id });
        estado.configInvalida = true;
        return;
      }
      deps.logger.warn("asaas_conciliar_get_pagamento_falhou", { pedidoId: pedido.id, tipoErro: tipoDoErro(err) });
      resumo.falhas++;
      continue;
    }

    if (!cobranca) {
      // Decisão 21: sem cobrança achada pela referência, o pedido
      // `inconclusivo` já pode ser retomado (`fn_billing_pedido_tomar` aceita
      // `inconclusivo` de partida); nada precisa mudar no banco.
      resumo.semCobrancaEncontrada++;
      continue;
    }

    const eventType = eventoSinteticoDaCobranca(pedido.status, cobranca);
    if (!eventType) continue;

    const eventId = `conc:${cobranca.id}:${cobranca.status}`;
    const registrado = await deps.db.registrarEventoSintetico({
      eventId,
      eventType,
      idDoRecurso: cobranca.id,
      ambiente: pedido.ambiente,
      payload: { id: eventId, event: eventType, payment: cobranca },
    });
    if (registrado.error) {
      deps.logger.error("asaas_conciliar_registrar_evento_falhou", {
        pedidoId: pedido.id,
        codigo: registrado.error.code,
      });
      resumo.falhas++;
    } else if (registrado.data?.novo) {
      resumo.eventosSinteticos++;
    }
  }
}

// ─── Passo 2: assinaturas Asaas ativas ──────────────────────────────────────

async function processarAssinaturasAtivas(
  deps: DepsConciliarAsaas,
  resumo: ResumoConciliarAsaas,
  orcamento: OrcamentoDeGets,
  estado: EstadoDaRodada,
): Promise<void> {
  const limite = deps.limiteAssinaturas ?? LIMITE_ASSINATURAS_PADRAO;
  const ativas = await deps.db.listarAssinaturasAtivas(limite);
  if (ativas.error) {
    deps.logger.error("asaas_conciliar_listar_assinaturas_falhou", { codigo: ativas.error.code });
    resumo.falhas++;
    return;
  }
  const assinaturas = ativas.data ?? [];
  resumo.assinaturasAnalisadas = assinaturas.length;

  for (const contrato of assinaturas) {
    if (!orcamento.restante()) {
      resumo.cortadoPeloTetoDeGets = true;
      break;
    }

    let removida: boolean;
    try {
      orcamento.gastar();
      const r = await deps.asaas.buscarAssinatura(contrato.asaasSubscriptionId);
      removida = "removido" in r;
    } catch (err) {
      if (ehErroDeConfiguracao(err)) {
        deps.logger.error("asaas_conciliar_erro_de_configuracao_abortando", {
          organizationId: contrato.organizationId,
        });
        estado.configInvalida = true;
        return;
      }
      deps.logger.warn("asaas_conciliar_get_assinatura_falhou", {
        organizationId: contrato.organizationId,
        tipoErro: tipoDoErro(err),
      });
      resumo.falhas++;
      continue;
    }

    if (!removida) continue;

    const clienteRes = await deps.db.clienteAsaasDaOrganizacao(contrato.organizationId, deps.config.ambiente);
    if (clienteRes.error || !clienteRes.data) {
      deps.logger.error("asaas_conciliar_cliente_da_organizacao_falhou", {
        organizationId: contrato.organizationId,
      });
      resumo.falhas++;
      continue;
    }

    const eventId = `conc:${contrato.asaasSubscriptionId}:DELETED`;
    const registrado = await deps.db.registrarEventoSintetico({
      eventId,
      eventType: "SUBSCRIPTION_DELETED",
      idDoRecurso: contrato.asaasSubscriptionId,
      // O ambiente da assinatura é o da CONFIGURAÇÃO corrente (mesma
      // doutrina do webhook, `app/api/v1/webhooks/asaas/route.ts`): o
      // contrato não guarda uma coluna própria de ambiente.
      ambiente: deps.config.ambiente,
      payload: {
        id: eventId,
        event: "SUBSCRIPTION_DELETED",
        subscription: {
          id: contrato.asaasSubscriptionId,
          customer: clienteRes.data,
          status: "INACTIVE",
          deleted: true,
        },
      },
    });
    if (registrado.error) {
      deps.logger.error("asaas_conciliar_registrar_evento_falhou", {
        organizationId: contrato.organizationId,
        codigo: registrado.error.code,
      });
      resumo.falhas++;
    } else if (registrado.data?.novo) {
      resumo.eventosSinteticos++;
    }
  }
}

// ─── Passo 3: refaz a remoção de cobrança/assinatura de pedido vencido (decisão 10, A1/4) ─

async function refazerRemocaoDeCobrancaVencida(
  deps: DepsConciliarAsaas,
  resumo: ResumoConciliarAsaas,
  estado: EstadoDaRodada,
): Promise<void> {
  if (estado.configInvalida) return;

  const limite = deps.limiteVencidos ?? LIMITE_VENCIDOS_PADRAO;
  const vencidos = await deps.db.listarPedidosVencidosParaRemocao(limite);
  if (vencidos.error) {
    deps.logger.error("asaas_conciliar_listar_vencidos_falhou", { codigo: vencidos.error.code });
    resumo.falhas++;
    return;
  }

  for (const pedido of vencidos.data ?? []) {
    // Pedido de assinatura vencido remove a ASSINATURA inteira, nunca só a
    // cobrança avulsa do ciclo (decisão 4/10, correção item 4): removerCobranca
    // deixaria a assinatura viva no Asaas, cobrando de novo no ciclo seguinte.
    const usaAssinatura = pedido.tipo === "assinatura" && Boolean(pedido.asaasSubscriptionId);
    if (!usaAssinatura && !pedido.asaasPaymentId) continue;

    try {
      if (usaAssinatura) {
        await deps.asaas.removerAssinatura(pedido.asaasSubscriptionId as string);
      } else {
        await deps.asaas.removerCobranca(pedido.asaasPaymentId as string);
      }
      resumo.cobrancasRemovidas++;
    } catch (err) {
      if (ehErroDeConfiguracao(err)) {
        deps.logger.error("asaas_conciliar_erro_de_configuracao_abortando", { pedidoId: pedido.id });
        estado.configInvalida = true;
        return;
      }
      // Alarme com o MESMO código que `fn_billing_asaas_aplicar_evento`
      // devolve (correção A1/4): a remoção continua pendente.
      deps.logger.error(
        usaAssinatura ? "alarme_asaas_remover_assinatura_pendente" : "alarme_asaas_remover_cobranca_pendente",
        {
          pedidoId: pedido.id,
          organizationId: pedido.organizationId,
          tipoErro: tipoDoErro(err),
        },
      );
      resumo.falhas++;
    }
  }
}

// ─── Passo 5: alarmes (decisão 21) ─────────────────────────────────────────

function alarmarContadores(logger: LoggerAsaas, contadores: ContadoresDeAlarmeAsaas): void {
  if (contadores.pendenteHaMaisDeUmaHora > 0) {
    logger.error("alarme_asaas_evento_pendente_ha_mais_de_uma_hora", { quantidade: contadores.pendenteHaMaisDeUmaHora });
  }
  if (contadores.erroUltimas24h > 0) {
    logger.error("alarme_asaas_evento_em_erro_ultimas_24h", { quantidade: contadores.erroUltimas24h });
  }
  if (contadores.divergenteUltimas24h > 0) {
    logger.error("alarme_asaas_evento_divergente_ultimas_24h", { quantidade: contadores.divergenteUltimas24h });
  }
  if (contadores.semVinculoUltimas24h > 0) {
    logger.error("alarme_asaas_evento_sem_vinculo_ultimas_24h", { quantidade: contadores.semVinculoUltimas24h });
  }
  if (contadores.semEventoHa3DiasComAssinaturaAtiva > 0) {
    logger.error("alarme_asaas_sem_evento_ha_3_dias_com_assinatura_ativa", {
      quantidade: contadores.semEventoHa3DiasComAssinaturaAtiva,
    });
  }
}

// ─── A função pública ───────────────────────────────────────────────────────

/**
 * A rodada diária de conciliação (decisão 21). Sem `ASAAS_ENABLED`, devolve o
 * resumo zerado sem tocar banco nem rede. Nunca lança: cada passo captura o
 * próprio erro, conta em `resumo.falhas` e segue para o passo seguinte (erro
 * de CONFIGURAÇÃO é a única exceção, que aborta o passo em andamento - a
 * causa não é do item, é do ambiente).
 */
export async function conciliarAsaas(deps: DepsConciliarAsaas): Promise<ResumoConciliarAsaas> {
  const resumo = resumoZerado(deps.config.habilitado);
  if (!deps.config.habilitado) return resumo;

  const orcamento = criarOrcamentoDeGets(deps.limiteGets ?? LIMITE_GETS_PADRAO);
  const estado: EstadoDaRodada = { configInvalida: false };

  await processarPedidosPendentes(deps, resumo, orcamento, estado);
  if (!estado.configInvalida && orcamento.restante()) {
    await processarAssinaturasAtivas(deps, resumo, orcamento, estado);
  }

  await refazerRemocaoDeCobrancaVencida(deps, resumo, estado);

  const poda = await deps.db.podarEventos(deps.diasDePoda ?? DIAS_DE_PODA_PADRAO);
  if (poda.error) {
    deps.logger.error("asaas_conciliar_podar_falhou", { codigo: poda.error.code });
    resumo.falhas++;
  } else {
    resumo.podados = poda.data?.podados ?? 0;
  }

  const contadoresRes = await deps.db.contadoresDeAlarme();
  resumo.contadores = contadoresRes.contadores;
  if (contadoresRes.leituraFalhou) {
    deps.logger.error("asaas_conciliar_contadores_de_alarme_falhou", {});
    resumo.falhas++;
  }
  alarmarContadores(deps.logger, resumo.contadores);

  if (deps.config.webhookId) {
    try {
      const webhook = await deps.asaas.buscarWebhook(deps.config.webhookId);
      if (webhook.interrupted) {
        resumo.webhookInterrompido = true;
        // Código fixo (M6): a tela do admin e um alerta externo podem casar
        // com este texto sem depender do corpo do webhook.
        deps.logger.error("alarme_asaas_webhook_interrompido", { webhookId: deps.config.webhookId });
      }
    } catch (err) {
      deps.logger.warn("asaas_conciliar_get_webhook_falhou", { tipoErro: tipoDoErro(err) });
    }
  }

  return resumo;
}

// ─── A implementação real sobre o Supabase ─────────────────────────────────

interface LinhaDePedidoCru {
  id: string;
  organization_id: string;
  ambiente: "sandbox" | "producao";
  tipo: string;
  status: string;
  external_reference: string;
  asaas_payment_id: string | null;
  asaas_subscription_id: string | null;
}

/**
 * Monta o `DbConciliarAsaas` sobre um `SupabaseClient` de verdade (o admin,
 * `service_role`). Mesmo tratamento de peça recém-nascida da migração 0909
 * que `criarDbEventosAsaasSobre` (`lib/billing/asaas/processar-eventos.ts`)
 * já dá: `admin.rpc(nome as never, args as never)` até `lib/database.
 * types.ts` ser regenerado.
 */
export function criarDbConciliarAsaasSobre(admin: SupabaseClient): DbConciliarAsaas {
  return {
    async listarPedidosPendentes(limite) {
      const quinzeMinutosAtras = new Date(Date.now() - 15 * 60 * 1000).toISOString();
      const { data, error } = await admin
        .from("billing_orders")
        .select("id, organization_id, ambiente, tipo, status, external_reference, asaas_payment_id, asaas_subscription_id")
        .or(
          `status.eq.aguardando_pagamento,status.eq.inconclusivo,and(status.eq.processando,updated_at.lt.${quinzeMinutosAtras})`,
        )
        .order("updated_at", { ascending: true })
        .limit(limite);
      if (error) return { data: null, error: { code: error.code, message: error.message } };
      const linhas = (data ?? []) as unknown as LinhaDePedidoCru[];
      return {
        data: linhas.map((l) => ({
          id: l.id,
          organizationId: l.organization_id,
          ambiente: l.ambiente,
          tipo: l.tipo,
          status: l.status,
          externalReference: l.external_reference,
          asaasPaymentId: l.asaas_payment_id,
          asaasSubscriptionId: l.asaas_subscription_id,
        })),
        error: null,
      };
    },

    async listarPedidosVencidosParaRemocao(limite) {
      const { data, error } = await admin
        .from("billing_orders")
        .select("id, organization_id, tipo, asaas_payment_id, asaas_subscription_id")
        .eq("status", "vencido")
        .or("asaas_payment_id.not.is.null,asaas_subscription_id.not.is.null")
        .limit(limite);
      if (error) return { data: null, error: { code: error.code, message: error.message } };
      const linhas = (data ?? []) as unknown as Array<{
        id: string;
        organization_id: string;
        tipo: string;
        asaas_payment_id: string | null;
        asaas_subscription_id: string | null;
      }>;
      return {
        data: linhas.map((l) => ({
          id: l.id,
          organizationId: l.organization_id,
          tipo: l.tipo,
          asaasPaymentId: l.asaas_payment_id,
          asaasSubscriptionId: l.asaas_subscription_id,
        })),
        error: null,
      };
    },

    async listarAssinaturasAtivas(limite) {
      const { data, error } = await admin
        .from("billing_contracts")
        .select("organization_id, asaas_subscription_id")
        .not("asaas_subscription_id", "is", null)
        .is("asaas_assinatura_encerrada_em", null)
        .limit(limite);
      if (error) return { data: null, error: { code: error.code, message: error.message } };
      const linhas = (data ?? []) as unknown as Array<{ organization_id: string; asaas_subscription_id: string }>;
      return {
        data: linhas.map((l) => ({ organizationId: l.organization_id, asaasSubscriptionId: l.asaas_subscription_id })),
        error: null,
      };
    },

    async clienteAsaasDaOrganizacao(organizationId, ambiente) {
      const { data, error } = await admin
        .from("billing_customers")
        .select("asaas_customer_id")
        .eq("organization_id", organizationId)
        .eq("ambiente", ambiente)
        .limit(1)
        .maybeSingle();
      if (error) return { data: null, error: { code: error.code, message: error.message } };
      const linha = data as { asaas_customer_id: string } | null;
      return { data: linha?.asaas_customer_id ?? null, error: null };
    },

    async marcarPedidoInconclusivo(organizationId, pedidoId, motivo) {
      const { data, error } = await admin.rpc("fn_billing_pedido_marcar" as never, {
        p_org: organizationId,
        p_pedido: pedidoId,
        p_status: "inconclusivo",
        p_motivo: motivo,
      } as never);
      if (error) return { data: null, error: { code: error.code, message: error.message } };
      return { data, error: null };
    },

    async registrarEventoSintetico(input) {
      const { data, error } = await admin.rpc("fn_billing_asaas_registrar_evento" as never, {
        p_event_id: input.eventId,
        p_event_type: input.eventType,
        p_resource_id: input.idDoRecurso,
        p_ambiente: input.ambiente,
        p_origem: "conciliacao",
        p_payload: input.payload,
      } as never);
      if (error) return { data: null, error: { code: error.code, message: error.message } };
      const linha = data as { novo: boolean };
      return { data: { novo: linha.novo }, error: null };
    },

    async podarEventos(dias) {
      const { data, error } = await admin.rpc("fn_billing_asaas_podar_eventos" as never, { p_dias: dias } as never);
      if (error) return { data: null, error: { code: error.code, message: error.message } };
      const linha = data as { podados: number };
      return { data: { podados: linha.podados }, error: null };
    },

    async contadoresDeAlarme() {
      return contadoresDeAlarmeAsaas(admin);
    },
  };
}
