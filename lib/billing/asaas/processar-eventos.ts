import "server-only";

/**
 * O processador durável dos eventos do webhook do Asaas: fase F5
 * (`hiperbold/planos/fase-F5-tarefas.md`), Tarefa 13, decisões 3 e 20.
 *
 * RESTRIÇÃO ABSOLUTA DESTA FASE: nenhuma chamada real ao Asaas, nem ao
 * sandbox, sai daqui em teste. `processarEventosAsaas` recebe tudo por
 * injeção, num ÚNICO objeto (`db`, `asaas`, `config`, `logger`, `agora`,
 * `orcamentoMs`, `limite`, `leaseSegundos`): o cliente Asaas
 * (`lib/billing/asaas/cliente.ts`, já testado com `fetch` falso) e o banco,
 * por uma interface ESTREITA (`DbEventosAsaas`), no mesmo molde de
 * `DbCompra` (`lib/billing/asaas/compra.ts`, Tarefa 14) e de
 * `ConferidorDeVencimentosDb` (`lib/billing/assinatura/conferir-
 * vencimentos.ts`, fase F4): um método por RPC/leitura, nunca um
 * `SupabaseClient` genérico dentro da função pura. A implementação real
 * (`criarDbEventosAsaasSobre`) mora neste mesmo arquivo, porque a Tarefa 13
 * (ao contrário da Tarefa 14) não tem uma Tarefa 15 separada para escrever o
 * adaptador: a rota de cron (fora desta tarefa: `app/api/v1/cron/processar-
 * eventos-asaas/route.ts`) precisa de algo que já funcione de ponta a ponta.
 *
 * ═══ O que este arquivo FAZ e o que NÃO faz (decisão 3) ═══
 *
 * O webhook (Tarefa 12) só GUARDA o evento. Quem CONFIRMA é este processador:
 * todo evento que mexe em dinheiro consulta o Asaas por `GET /payments/{id}`
 * ANTES de aplicar qualquer coisa, e o que é aplicado é o OBJETO CONFIRMADO
 * (`p_confirmacao`), nunca o corpo do webhook. Um evento forjado sozinho
 * nunca concede acesso: o pior que ele faz é gastar um `GET` (e só isso
 * quando o pré-roteamento, abaixo, decide que vale a pena consultar).
 *
 * ═══ Pré-roteamento pelo payload, ANTES de qualquer GET (decisão 6/M8) ═══
 *
 * Só os TRÊS event_type de dinheiro (`PAYMENT_CONFIRMED`, `PAYMENT_RECEIVED`,
 * `PAYMENT_RECEIVED_IN_CASH`) precisam de um `GET` nesta tarefa: qualquer
 * outro tipo (`PAYMENT_OVERDUE`, `SUBSCRIPTION_DELETED`, `PAYMENT_CREATED`,
 * etc.) é despachado por `fn_billing_asaas_aplicar_evento` só pelo
 * `event_type`, sem olhar `p_confirmacao` (Tarefa 6, "tarefa_6_pendente", ou
 * decisão 10, "ignorado"), então este processador chama a função com
 * `p_confirmacao: null` direto, sem gastar `GET` nenhum.
 *
 * Para os três tipos de dinheiro, `ehCandidatoAoGet` olha o PAYLOAD já salvo
 * do próprio webhook (nunca o Asaas) e só manda fazer o `GET` quando o
 * `externalReference` começa com `HC:`, OU quando `payment.id` (= o
 * `resource_id` da reserva), `payment.subscription` ou `payment.customer` já
 * são conhecidos localmente (consulta barata e indexada em
 * `billing_orders`/`billing_payments`/`billing_contracts`/
 * `billing_customers`). Pulando o `GET`, o evento nunca é aplicado: forjar o
 * payload não abre acesso.
 *
 * ═══ "outro_app" sem GET para evento de dinheiro (M8) ═══
 *
 * Quando `ehCandidatoAoGet` decide que o evento NÃO é nosso, este processador
 * chama `fn_billing_asaas_aplicar_evento` (migração 0909, Tarefa 6) com o
 * SENTINELA `p_confirmacao: {"pre_roteamento":"outro_app"}` (nenhum outro
 * campo): a função fecha o evento como `outro_app` DIRETO, sem despachar para
 * `fn_billing_asaas_aplicar_pagamento` e sem gastar nenhum `GET` - a garantia
 * de segurança da decisão 6/M8/risco 15 continua de pé (pular o `GET` nunca
 * concede nada sozinho). Isto substitui a versão anterior desta tarefa, que
 * mandava `p_confirmacao: null` (o evento ficava `aguardando` para sempre,
 * sem nunca "descansar", porque a função ainda não tinha o ramo do
 * sentinela); com o sentinela, o evento vira `outro_app` de uma vez, fora dos
 * alarmes de dinheiro (decisão 6) e sem custar uma vaga do lote a cada rodada
 * para sempre.
 *
 * ═══ Erro do Asaas nunca segura a rodada inteira (decisão 20) ═══
 *
 * Erro de REDE/5xx/429/resposta inválida num `GET` é POR EVENTO:
 * `fn_billing_asaas_registrar_falha` grava o código (nunca a mensagem crua do
 * Asaas, nunca dado pessoal) e o backoff exponencial já embutido na função de
 * banco decide quando tentar de novo; a rodada segue para o próximo evento.
 * Só erro de CONFIGURAÇÃO (`ErroAsaasException` com `tipo: "configuracao"`,
 * ex.: `ASAAS_ENABLED` ligado com base/chave incoerentes) aborta a rodada
 * INTEIRA: a causa não é do evento, é do ambiente, e tentar o próximo evento
 * só repetiria o mesmo erro.
 *
 * ═══ Orçamento de tempo por rodada (decisão 20) ═══
 *
 * A reserva pega até `limite` eventos (padrão 50) de uma vez com lease de
 * `leaseSegundos` (padrão 300s = 5 min). O laço de processamento confere o
 * relógio ANTES de começar cada evento e para perto de `orcamentoMs` (padrão
 * pouco abaixo de 30s) mesmo com eventos sobrando no lote: o que sobrou
 * continua reservado (lease válido) e não é tocado de novo até o lease
 * expirar (ou até uma rodada seguinte, se a reserva desta rodada nunca
 * terminar de processar tudo).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { ClienteAsaasHttp, LoggerAsaas } from "./cliente";
import type { ConfigAsaas } from "./config";
import { type CobrancaAsaas, envelopeWebhookAsaasSchema } from "./contratos";
import { ErroAsaasException } from "./erros";

// ─── A interface estreita do banco ─────────────────────────────────────────

export interface RpcErro {
  code?: string;
  message?: string;
}

export interface RpcResultado<T> {
  data: T | null;
  error: RpcErro | null;
}

/** O que `fn_billing_asaas_reservar_eventos` devolve por evento reservado. */
export interface EventoReservado {
  id: string;
  eventType: string;
  /** `resource_id` gravado pela rota do webhook: `payment.id ?? subscription.id`. */
  resourceId: string | null;
  leaseToken: string;
}

/** Uma linha de `asaas_webhook_events`, só o payload já guardado (leitura pura). */
export interface EventoComPayload {
  id: string;
  payload: unknown;
}

/** O que `fn_billing_asaas_aplicar_evento` devolve. */
export interface AplicarEventoResultado {
  resultado: string;
  organizationId: string | null;
  alarme: string | null;
}

/** O que `fn_billing_asaas_registrar_falha` devolve. */
export interface RegistrarFalhaResultado {
  tentativas: number;
  resultado: string;
}

export interface DbEventosAsaas {
  /** `fn_billing_asaas_reservar_eventos`. */
  reservarEventos(limite: number, leaseSegundos: number): Promise<RpcResultado<EventoReservado[]>>;
  /** Leitura pura de `asaas_webhook_events.payload`, para o pré-roteamento (decisão 6/M8). */
  lerPayloads(ids: string[]): Promise<RpcResultado<EventoComPayload[]>>;
  /** Leitura pura, barata: `payment.id` já conhecido em `billing_orders`/`billing_payments`? */
  pagamentoConhecido(paymentId: string): Promise<RpcResultado<boolean>>;
  /** Leitura pura, barata: `subscription` já conhecida em `billing_orders`/`billing_contracts`? */
  assinaturaConhecida(subscriptionId: string): Promise<RpcResultado<boolean>>;
  /** Leitura pura, barata: `customer` já conhecido em `billing_customers`? */
  clienteConhecido(customerId: string): Promise<RpcResultado<boolean>>;
  /** `fn_billing_asaas_aplicar_evento`. */
  aplicarEvento(
    eventoId: string,
    leaseToken: string,
    confirmacao: Record<string, unknown> | null,
  ): Promise<RpcResultado<AplicarEventoResultado>>;
  /** `fn_billing_asaas_registrar_falha`. */
  registrarFalha(eventoId: string, leaseToken: string, codigo: string): Promise<RpcResultado<RegistrarFalhaResultado>>;
}

export interface DepsProcessarEventosAsaas {
  db: DbEventosAsaas;
  asaas: ClienteAsaasHttp;
  config: ConfigAsaas;
  logger: LoggerAsaas;
  /** Injetável só para teste; padrão `() => new Date()`. */
  agora?: () => Date;
  /** Milissegundos de orçamento por rodada (decisão 20). Padrão: `ORCAMENTO_MS_PADRAO`. */
  orcamentoMs?: number;
  /** Máximo de eventos reservados por rodada (decisão 20). Padrão: `LIMITE_PADRAO`. */
  limite?: number;
  /** Segundos de validade do lease (decisão 20). Padrão: `LEASE_SEGUNDOS_PADRAO`. */
  leaseSegundos?: number;
}

export interface ResumoProcessarEventosAsaas {
  habilitado: boolean;
  reservados: number;
  processados: number;
  aplicados: number;
  jaAplicados: number;
  ignorados: number;
  outroApp: number;
  semVinculo: number;
  divergentes: number;
  aguardando: number;
  falhas: number;
  removidosCobranca: number;
  cortadoPeloOrcamento: boolean;
}

export const LIMITE_PADRAO = 50;
export const LEASE_SEGUNDOS_PADRAO = 300;
/** Pouco abaixo de 30s (decisão 20: "parando perto de 30 segundos"). */
export const ORCAMENTO_MS_PADRAO = 28_000;

const EVENTOS_DE_DINHEIRO = new Set(["PAYMENT_CONFIRMED", "PAYMENT_RECEIVED", "PAYMENT_RECEIVED_IN_CASH"]);

function resumoZerado(habilitado: boolean): ResumoProcessarEventosAsaas {
  return {
    habilitado,
    reservados: 0,
    processados: 0,
    aplicados: 0,
    jaAplicados: 0,
    ignorados: 0,
    outroApp: 0,
    semVinculo: 0,
    divergentes: 0,
    aguardando: 0,
    falhas: 0,
    removidosCobranca: 0,
    cortadoPeloOrcamento: false,
  };
}

function relogio(deps: DepsProcessarEventosAsaas): Date {
  return (deps.agora ?? (() => new Date()))();
}

function tipoDoErro(err: unknown): string {
  return err instanceof ErroAsaasException ? err.erro.tipo : "desconhecido";
}

function contabilizar(resumo: ResumoProcessarEventosAsaas, categoria: string): void {
  switch (categoria) {
    case "aplicado":
      resumo.aplicados++;
      break;
    case "ja_aplicado":
      resumo.jaAplicados++;
      break;
    case "ignorado":
      resumo.ignorados++;
      break;
    case "outro_app":
      resumo.outroApp++;
      break;
    case "sem_vinculo":
      resumo.semVinculo++;
      break;
    case "divergente":
      resumo.divergentes++;
      break;
    case "aguardando":
      resumo.aguardando++;
      break;
    default:
      // "erro" (aplicação interna falhou no SQL), "falha" (GET falhou),
      // "falha_ao_aplicar" (a RPC de aplicar devolveu erro) e "abortado"
      // (erro de configuração) contam todos como falha da rodada.
      resumo.falhas++;
      break;
  }
}

// ─── Pré-roteamento pelo payload (decisão 6/M8) ────────────────────────────

interface ReferenciaPreRoteamento {
  externalReference: string | null;
  subscriptionId: string | null;
  customerId: string | null;
}

/** Extrai só os campos do PAYLOAD JÁ GUARDADO precisos para o pré-roteamento. Nunca chama o Asaas. */
function extrairReferenciaDoPayload(payload: unknown): ReferenciaPreRoteamento {
  const parsed = envelopeWebhookAsaasSchema.safeParse(payload);
  if (!parsed.success) {
    return { externalReference: null, subscriptionId: null, customerId: null };
  }
  const pagamento = parsed.data.payment;
  const assinatura = parsed.data.subscription;
  return {
    externalReference: pagamento?.externalReference ?? assinatura?.externalReference ?? null,
    subscriptionId: pagamento?.subscription ?? assinatura?.id ?? null,
    customerId: pagamento?.customer ?? assinatura?.customer ?? null,
  };
}

/**
 * Decide se vale a pena consultar o Asaas (decisão 6/M8). `paymentId` é
 * sempre `evento.resourceId` (a rota do webhook já grava `payment.id` ali
 * para todo evento de dinheiro); os outros três campos vêm do payload
 * guardado. Pular o `GET` nunca concede nada sozinho: o pior caso desta
 * função devolver `true` por engano é gastar um `GET` à toa.
 */
async function ehCandidatoAoGet(
  db: DbEventosAsaas,
  paymentId: string | null,
  ref: ReferenciaPreRoteamento,
): Promise<boolean> {
  if (ref.externalReference && ref.externalReference.startsWith("HC:")) return true;

  if (paymentId) {
    const r = await db.pagamentoConhecido(paymentId);
    if (!r.error && r.data) return true;
  }
  if (ref.subscriptionId) {
    const r = await db.assinaturaConhecida(ref.subscriptionId);
    if (!r.error && r.data) return true;
  }
  if (ref.customerId) {
    const r = await db.clienteConhecido(ref.customerId);
    if (!r.error && r.data) return true;
  }
  return false;
}

// ─── Monta o objeto CONFIRMADO (decisão 3, nunca o corpo do webhook) ───────

/**
 * O contrato exato de `p_confirmacao` documentado no comentário da PARTE 5
 * da migração 0909 (`fn_billing_asaas_aplicar_pagamento`): campos do objeto
 * que o `GET /payments/{id}` CONFIRMOU, mais `assinatura_status` (decisão
 * 10/M3) quando este processador também consultou `GET /subscriptions/{id}`.
 */
function confirmacaoDoPagamento(cobranca: CobrancaAsaas, assinaturaStatus: string | null): Record<string, unknown> {
  const confirmacao: Record<string, unknown> = {
    id: cobranca.id,
    status: cobranca.status,
    value: cobranca.value,
    originalValue: cobranca.originalValue ?? null,
    dueDate: cobranca.dueDate,
    paymentDate: cobranca.paymentDate ?? null,
    confirmedDate: cobranca.confirmedDate ?? null,
    customer: cobranca.customer ?? null,
    subscription: cobranca.subscription ?? null,
    externalReference: cobranca.externalReference ?? null,
  };
  if (assinaturaStatus !== null) {
    confirmacao.assinatura_status = assinaturaStatus;
  }
  return confirmacao;
}

// ─── Processa um único evento reservado ────────────────────────────────────

interface ResultadoDeUmEvento {
  categoria: string;
  abortarRodada: boolean;
}

async function aplicarSemConfirmacao(deps: DepsProcessarEventosAsaas, evento: EventoReservado): Promise<ResultadoDeUmEvento> {
  const aplicado = await deps.db.aplicarEvento(evento.id, evento.leaseToken, null);
  return finalizarAplicacao(deps, evento, aplicado);
}

/**
 * Pré-roteamento decidiu, só pelo payload já guardado, que o evento não é
 * nosso (decisão 6/M8): fecha como `outro_app` direto, sem gastar `GET`,
 * pelo sentinela que `fn_billing_asaas_aplicar_evento` (0909, Tarefa 6)
 * reconhece por igualdade estrutural do jsonb.
 */
async function aplicarComoOutroApp(deps: DepsProcessarEventosAsaas, evento: EventoReservado): Promise<ResultadoDeUmEvento> {
  const aplicado = await deps.db.aplicarEvento(evento.id, evento.leaseToken, { pre_roteamento: "outro_app" });
  return finalizarAplicacao(deps, evento, aplicado);
}

async function finalizarAplicacao(
  deps: DepsProcessarEventosAsaas,
  evento: EventoReservado,
  aplicado: RpcResultado<AplicarEventoResultado>,
): Promise<ResultadoDeUmEvento> {
  if (aplicado.error || !aplicado.data) {
    deps.logger.error("asaas_processar_aplicar_evento_falhou", {
      eventoId: evento.id,
      codigo: aplicado.error?.code,
    });
    return { categoria: "falha_ao_aplicar", abortarRodada: false };
  }

  const { resultado, alarme } = aplicado.data;
  if (alarme && alarme.split(",").includes("remover_cobranca_pendente")) {
    await tentarRemoverCobranca(deps, evento);
  }
  return { categoria: resultado, abortarRodada: false };
}

/**
 * O alarme `remover_cobranca_pendente` (Tarefa 6, correção A1) ainda NÃO
 * existe na migração 0909 revisada (fora desta tarefa): `fn_billing_asaas_
 * aplicar_evento` só devolve `divergente_valor` e `pago_fora_do_prazo` hoje.
 * Este ramo fica pronto para quando a Tarefa 6 acrescentar o alarme; até lá,
 * é código morto e inofensivo (a condição nunca bate).
 */
async function tentarRemoverCobranca(deps: DepsProcessarEventosAsaas, evento: EventoReservado): Promise<void> {
  if (!evento.resourceId) return;
  try {
    await deps.asaas.removerCobranca(evento.resourceId);
  } catch (err) {
    // Falha aqui só loga (decisão 10): a conciliação diária (Tarefa 16) refaz.
    deps.logger.warn("asaas_processar_remover_cobranca_falhou", {
      eventoId: evento.id,
      tipoErro: tipoDoErro(err),
    });
  }
}

async function tratarErroDeChamada(
  deps: DepsProcessarEventosAsaas,
  evento: EventoReservado,
  err: unknown,
): Promise<ResultadoDeUmEvento> {
  if (err instanceof ErroAsaasException && err.erro.tipo === "configuracao") {
    // Erro de CONFIGURAÇÃO vale para a rodada INTEIRA: a causa não é deste
    // evento, é do ambiente (ASAAS_ENABLED ligado com base/chave
    // incoerentes). Tentar o próximo evento só repetiria o mesmo erro.
    deps.logger.error("asaas_processar_erro_de_configuracao_abortando_rodada", { eventoId: evento.id });
    return { categoria: "abortado", abortarRodada: true };
  }

  const tipo = tipoDoErro(err);
  const codigo = `asaas_${tipo}`;
  deps.logger.warn("asaas_processar_get_falhou", { eventoId: evento.id, tipoErro: tipo });

  const falha = await deps.db.registrarFalha(evento.id, evento.leaseToken, codigo);
  if (falha.error) {
    deps.logger.error("asaas_processar_registrar_falha_falhou", {
      eventoId: evento.id,
      codigo: falha.error.code,
    });
  }
  return { categoria: "falha", abortarRodada: false };
}

async function processarEventoDeDinheiro(
  deps: DepsProcessarEventosAsaas,
  evento: EventoReservado,
  payload: unknown,
): Promise<ResultadoDeUmEvento> {
  const referencia = extrairReferenciaDoPayload(payload);
  const candidato = await ehCandidatoAoGet(deps.db, evento.resourceId, referencia);
  if (!candidato) {
    // Decisão 6/M8: payload não bate com nada conhecido, e não começa com
    // "HC:". NENHUM GET é feito; fecha como outro_app pelo sentinela (ver o
    // cabeçalho deste arquivo).
    return aplicarComoOutroApp(deps, evento);
  }

  if (!evento.resourceId) {
    // Defensivo: um evento de dinheiro sempre deveria trazer `payment.id`
    // como `resource_id` (a rota do webhook garante isso). Sem ele não há
    // como fazer o GET; a mesma saída segura do ramo acima.
    return aplicarSemConfirmacao(deps, evento);
  }

  let cobranca: Awaited<ReturnType<ClienteAsaasHttp["buscarCobranca"]>>;
  try {
    cobranca = await deps.asaas.buscarCobranca(evento.resourceId);
  } catch (err) {
    return tratarErroDeChamada(deps, evento, err);
  }

  if ("removido" in cobranca) {
    // O recurso já não existe no Asaas (404/deleted:true). Tratar isso como
    // remoção confirmada é escopo da Tarefa 6 (B4); aqui só evita aplicar
    // qualquer coisa - a mesma saída segura acima.
    return aplicarSemConfirmacao(deps, evento);
  }

  let assinaturaStatus: string | null = null;
  if (cobranca.subscription) {
    try {
      const assinatura = await deps.asaas.buscarAssinatura(cobranca.subscription);
      if (!("removido" in assinatura)) {
        assinaturaStatus = assinatura.status;
      }
    } catch (err) {
      // A consulta EXTRA da assinatura (decisão 10/M3) é um refinamento, não
      // a concessão do pagamento em si: uma falha aqui não derruba o
      // pagamento, só segue sem `assinatura_status`.
      deps.logger.warn("asaas_processar_get_assinatura_falhou", {
        eventoId: evento.id,
        tipoErro: tipoDoErro(err),
      });
    }
  }

  const confirmacao = confirmacaoDoPagamento(cobranca, assinaturaStatus);
  const aplicado = await deps.db.aplicarEvento(evento.id, evento.leaseToken, confirmacao);
  return finalizarAplicacao(deps, evento, aplicado);
}

async function processarUmEvento(
  deps: DepsProcessarEventosAsaas,
  evento: EventoReservado,
  payload: unknown,
): Promise<ResultadoDeUmEvento> {
  if (!EVENTOS_DE_DINHEIRO.has(evento.eventType)) {
    // Nenhum GET necessário: fn_billing_asaas_aplicar_evento despacha só
    // pelo event_type para "tarefa_6_pendente" e "ignorado" (decisão 10).
    return aplicarSemConfirmacao(deps, evento);
  }
  return processarEventoDeDinheiro(deps, evento, payload);
}

// ─── A função pública ───────────────────────────────────────────────────

async function carregarPayloads(deps: DepsProcessarEventosAsaas, ids: string[]): Promise<Map<string, unknown>> {
  const mapa = new Map<string, unknown>();
  if (ids.length === 0) return mapa;
  const res = await deps.db.lerPayloads(ids);
  if (res.error || !res.data) {
    deps.logger.warn("asaas_processar_ler_payloads_falhou", { codigo: res.error?.code });
    return mapa;
  }
  for (const linha of res.data) mapa.set(linha.id, linha.payload);
  return mapa;
}

/**
 * Reserva até `deps.limite` eventos pendentes (padrão `LIMITE_PADRAO`) com
 * lease de `deps.leaseSegundos` (padrão `LEASE_SEGUNDOS_PADRAO`) e processa
 * cada um dentro do orçamento de tempo `deps.orcamentoMs` (padrão
 * `ORCAMENTO_MS_PADRAO`). Sem `ASAAS_ENABLED` (decisão 3), não reserva nada e
 * devolve contagem zero - os eventos ficam guardados, `aguardando`, para
 * quando a chave for ligada.
 */
export async function processarEventosAsaas(deps: DepsProcessarEventosAsaas): Promise<ResumoProcessarEventosAsaas> {
  const resumo = resumoZerado(deps.config.habilitado);
  if (!deps.config.habilitado) {
    return resumo;
  }

  const limite = deps.limite ?? LIMITE_PADRAO;
  const leaseSegundos = deps.leaseSegundos ?? LEASE_SEGUNDOS_PADRAO;
  const orcamentoMs = deps.orcamentoMs ?? ORCAMENTO_MS_PADRAO;

  const inicio = relogio(deps).getTime();

  const reserva = await deps.db.reservarEventos(limite, leaseSegundos);
  if (reserva.error) {
    deps.logger.error("asaas_processar_reservar_falhou", { codigo: reserva.error.code });
    return resumo;
  }
  const eventos = reserva.data ?? [];
  resumo.reservados = eventos.length;
  if (eventos.length === 0) return resumo;

  const payloads = await carregarPayloads(
    deps,
    eventos.filter((e) => EVENTOS_DE_DINHEIRO.has(e.eventType)).map((e) => e.id),
  );

  for (const evento of eventos) {
    if (relogio(deps).getTime() - inicio >= orcamentoMs) {
      resumo.cortadoPeloOrcamento = true;
      break;
    }

    const resultado = await processarUmEvento(deps, evento, payloads.get(evento.id) ?? null);
    resumo.processados++;
    contabilizar(resumo, resultado.categoria);

    if (resultado.abortarRodada) break;
  }

  return resumo;
}

// ─── A implementação real sobre o Supabase ─────────────────────────────────

/**
 * Monta o `DbEventosAsaas` sobre um `SupabaseClient` de verdade (o admin,
 * `service_role`). As três tabelas novas (`billing_customers`,
 * `billing_orders`, `asaas_webhook_events`) e as funções da Tarefa 4/5 não
 * estão em `lib/database.types.ts` ainda (mesmo tratamento que os
 * conferidores irmãos dão a peça recém-nascida da migração: `admin.rpc(nome
 * as never, args as never)`, `lib/billing/assinatura/conferir-
 * vencimentos.ts`).
 */
export function criarDbEventosAsaasSobre(admin: SupabaseClient): DbEventosAsaas {
  return {
    async reservarEventos(limite, leaseSegundos) {
      const { data, error } = await admin.rpc("fn_billing_asaas_reservar_eventos" as never, {
        p_limite: limite,
        p_lease_segundos: leaseSegundos,
      } as never);
      if (error) return { data: null, error: { code: error.code, message: error.message } };
      const linhas =
        (data as Array<{ id: string; event_type: string; resource_id: string | null; lease_token: string }> | null) ?? [];
      return {
        data: linhas.map((l) => ({ id: l.id, eventType: l.event_type, resourceId: l.resource_id, leaseToken: l.lease_token })),
        error: null,
      };
    },

    async lerPayloads(ids) {
      const { data, error } = await admin.from("asaas_webhook_events").select("id, payload").in("id", ids);
      if (error) return { data: null, error: { code: error.code, message: error.message } };
      const linhas = (data as Array<{ id: string; payload: unknown }> | null) ?? [];
      return { data: linhas.map((l) => ({ id: l.id, payload: l.payload })), error: null };
    },

    async pagamentoConhecido(paymentId) {
      const [pedido, pagamento] = await Promise.all([
        admin.from("billing_orders").select("id").eq("asaas_payment_id", paymentId).limit(1).maybeSingle(),
        admin.from("billing_payments").select("id").eq("asaas_payment_id", paymentId).limit(1).maybeSingle(),
      ]);
      if (pedido.error) return { data: null, error: { code: pedido.error.code, message: pedido.error.message } };
      if (pagamento.error) return { data: null, error: { code: pagamento.error.code, message: pagamento.error.message } };
      return { data: Boolean(pedido.data) || Boolean(pagamento.data), error: null };
    },

    async assinaturaConhecida(subscriptionId) {
      const [pedido, contrato] = await Promise.all([
        admin.from("billing_orders").select("id").eq("asaas_subscription_id", subscriptionId).limit(1).maybeSingle(),
        admin.from("billing_contracts").select("id").eq("asaas_subscription_id", subscriptionId).limit(1).maybeSingle(),
      ]);
      if (pedido.error) return { data: null, error: { code: pedido.error.code, message: pedido.error.message } };
      if (contrato.error) return { data: null, error: { code: contrato.error.code, message: contrato.error.message } };
      return { data: Boolean(pedido.data) || Boolean(contrato.data), error: null };
    },

    async clienteConhecido(customerId) {
      const { data, error } = await admin
        .from("billing_customers")
        .select("id")
        .eq("asaas_customer_id", customerId)
        .limit(1)
        .maybeSingle();
      if (error) return { data: null, error: { code: error.code, message: error.message } };
      return { data: Boolean(data), error: null };
    },

    async aplicarEvento(eventoId, leaseToken, confirmacao) {
      const { data, error } = await admin.rpc("fn_billing_asaas_aplicar_evento" as never, {
        p_evento: eventoId,
        p_lease_token: leaseToken,
        p_confirmacao: confirmacao,
      } as never);
      if (error) return { data: null, error: { code: error.code, message: error.message } };
      const linha = data as { resultado: string; organization_id: string | null; alarme: string | null };
      return { data: { resultado: linha.resultado, organizationId: linha.organization_id, alarme: linha.alarme }, error: null };
    },

    async registrarFalha(eventoId, leaseToken, codigo) {
      const { data, error } = await admin.rpc("fn_billing_asaas_registrar_falha" as never, {
        p_evento: eventoId,
        p_lease_token: leaseToken,
        p_codigo: codigo,
      } as never);
      if (error) return { data: null, error: { code: error.code, message: error.message } };
      const linha = data as { tentativas: number; resultado: string };
      return { data: { tentativas: linha.tentativas, resultado: linha.resultado }, error: null };
    },
  };
}
