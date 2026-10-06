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
 * todo evento que mexe em dinheiro ou contrato consulta o Asaas por `GET`
 * ANTES de aplicar qualquer coisa, e o que é aplicado é o OBJETO CONFIRMADO
 * (`p_confirmacao`), nunca o corpo do webhook. Um evento forjado sozinho
 * nunca concede acesso: o pior que ele faz é gastar um `GET` (e só isso
 * quando o pré-roteamento, abaixo, decide que vale a pena consultar).
 *
 * ═══ Três famílias de evento, cada uma com o GET certo (revisão da fase) ═══
 *
 * `PAYMENT_CONFIRMED`/`PAYMENT_RECEIVED`/`PAYMENT_RECEIVED_IN_CASH`
 * (`EVENTOS_DE_DINHEIRO`): `GET /payments/{id}` e o contrato de
 * `fn_billing_asaas_aplicar_pagamento` (Tarefa 5).
 *
 * `PAYMENT_REFUNDED`/`PAYMENT_PARTIALLY_REFUNDED`/`PAYMENT_CHARGEBACK_
 * REQUESTED`/`PAYMENT_CHARGEBACK_DISPUTE`/`PAYMENT_AWAITING_CHARGEBACK_
 * REVERSAL`/`PAYMENT_OVERDUE`/`PAYMENT_DELETED` (`EVENTOS_DE_COBRANCA_GET`):
 * também `GET /payments/{id}`, mas o contrato de `p_confirmacao` é o de
 * `fn_billing_asaas_aplicar_estorno` (o primeiro grupo, `EVENTOS_DE_
 * ESTORNO`) ou de `fn_billing_asaas_aplicar_fim_da_assinatura` para
 * `PAYMENT_OVERDUE`/`PAYMENT_DELETED` (comentário da PARTE 6 da migração
 * 0909): campos diferentes do contrato de pagamento confirmado, por isso os
 * dois grupos têm uma função de montagem própria (`confirmacaoDeEstorno` e
 * `confirmacaoDoFimDoPagamento`).
 *
 * `SUBSCRIPTION_DELETED`/`SUBSCRIPTION_INACTIVATED`/`SUBSCRIPTION_UPDATED`
 * (`EVENTOS_DE_ASSINATURA_GET`): `GET /subscriptions/{id}`, contrato também
 * de `fn_billing_asaas_aplicar_fim_da_assinatura`.
 *
 * Qualquer outro `event_type` (`PAYMENT_CREATED`, `SUBSCRIPTION_CREATED`,
 * `CHECKOUT_*`, um tipo novo que o Asaas venha a mandar) não precisa de GET
 * nenhum: `fn_billing_asaas_aplicar_evento` só registra (`ignorado`, decisão
 * 10), e este processador chama a função com `p_confirmacao: null` direto.
 *
 * ═══ Pré-roteamento pelo payload, ANTES de qualquer GET (decisão 6/M8) ═══
 *
 * As TRÊS famílias acima (dinheiro, cobrança e assinatura) passam pelo MESMO
 * pré-roteamento: `ehCandidatoAoGet` olha o PAYLOAD já salvo do próprio
 * webhook (nunca o Asaas) e só manda fazer o `GET` quando o
 * `externalReference` começa com `HC:`, OU quando `payment.id`/`payment.
 * subscription`/`payment.customer` (ou o equivalente do lado de
 * `subscription`) já são conhecidos localmente (consulta barata e indexada
 * em `billing_orders`/`billing_payments`/`billing_contracts`/
 * `billing_customers`). Pulando o `GET`, o evento nunca é aplicado: forjar o
 * payload não abre acesso.
 *
 * Uma falha de INFRAESTRUTURA nessas consultas baratas (erro do banco, não
 * "não achei nada") NUNCA é tratada como "não é candidato": o evento é
 * jogado fora do pré-roteamento sem certeza nenhuma, e fechar como
 * `outro_app` esconderia um evento legítimo para sempre. Por isso
 * `ehCandidatoAoGet` devolve um resultado de três valores (`candidato`/
 * `falhou`), e o mesmo vale para a leitura do payload em si (`lerPayloads`):
 * qualquer falha aqui vira uma FALHA do evento, registrada com
 * `fn_billing_asaas_registrar_falha` (o mesmo backoff exponencial de um GET
 * que falhou), nunca um fechamento silencioso.
 *
 * ═══ "outro_app" sem GET para evento candidato a dinheiro/cobrança/assinatura (M8) ═══
 *
 * Quando `ehCandidatoAoGet` decide (com certeza, sem falha) que o evento NÃO
 * é nosso, este processador chama `fn_billing_asaas_aplicar_evento` (migração
 * 0909, Tarefa 6) com o SENTINELA `p_confirmacao: {"pre_roteamento":"outro_app"}`
 * (nenhum outro campo): a função fecha o evento como `outro_app` DIRETO, sem
 * despachar para nenhuma das funções de aplicação e sem gastar nenhum `GET` -
 * a garantia de segurança da decisão 6/M8/risco 15 continua de pé (pular o
 * `GET` nunca concede nada sozinho).
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
 * Uma falha da PRÓPRIA `fn_billing_asaas_aplicar_evento` (RPC com erro, não a
 * confirmação em si) também nunca fica só no log: registra a falha com o
 * MESMO lease, para o backoff exponencial decidir quando tentar de novo, em
 * vez de deixar o evento preso até o lease expirar sozinho sem escalonar as
 * tentativas.
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

import type { audit } from "@/lib/audit";

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
  idDoRecurso: string | null;
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

/** O que `fn_billing_asaas_marcar_assinatura_encerrada` devolve. */
export interface MarcarAssinaturaEncerradaResultado {
  jaRegistrado: boolean;
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
  /**
   * `fn_billing_asaas_marcar_assinatura_encerrada` (decisão 22): chamada
   * depois de `removerAssinatura` confirmar a remoção no Asaas (alarme
   * `remover_assinatura_pendente`, Tarefa 6). `billing_assinatura_nao_
   * confere`/contrato não encontrado (o contrato já não tem mais esta
   * assinatura) não é uma falha de infraestrutura: quem chama decide o que
   * fazer com o `error` devolvido.
   */
  marcarAssinaturaEncerrada(
    organizationId: string,
    asaasSubscriptionId: string,
  ): Promise<RpcResultado<MarcarAssinaturaEncerradaResultado>>;
}

/**
 * O registro de auditoria do corte por estorno total (D-086): quem age é o
 * processador, sem usuário. Injetável (a rota do cron passa `audit`); sem ele, o
 * corte acontece do mesmo jeito e só não deixa a linha em `api_audit_log` (o
 * rastro de banco, `billing_contract_eventos` e o livro-caixa, continua).
 */
export type AuditoriaDoCorteDeEstorno = Parameters<typeof audit>[0];

export interface DepsProcessarEventosAsaas {
  db: DbEventosAsaas;
  /** Auditoria do corte por estorno total; nunca lança, nunca bloqueia (fire-and-forget). */
  auditar?: (entrada: AuditoriaDoCorteDeEstorno) => Promise<void>;
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

/** Contrato de `fn_billing_asaas_aplicar_estorno` (decisão 9, N31/N32/N43). */
const EVENTOS_DE_ESTORNO = new Set([
  "PAYMENT_REFUNDED",
  "PAYMENT_PARTIALLY_REFUNDED",
  "PAYMENT_CHARGEBACK_REQUESTED",
  "PAYMENT_CHARGEBACK_DISPUTE",
  "PAYMENT_AWAITING_CHARGEBACK_REVERSAL",
]);

/** Contrato de `fn_billing_asaas_aplicar_fim_da_assinatura` pelo lado do PAGAMENTO avulso (decisão 10, N39). */
const EVENTOS_DE_FIM_DE_PAGAMENTO = new Set(["PAYMENT_OVERDUE", "PAYMENT_DELETED"]);

/** Os dois grupos acima juntos: todos fazem `GET /payments/{id}`. */
const EVENTOS_DE_COBRANCA_GET = new Set([...EVENTOS_DE_ESTORNO, ...EVENTOS_DE_FIM_DE_PAGAMENTO]);

/** Contrato de `fn_billing_asaas_aplicar_fim_da_assinatura` pelo lado da ASSINATURA (decisão 10/22). */
const EVENTOS_DE_ASSINATURA_GET = new Set(["SUBSCRIPTION_DELETED", "SUBSCRIPTION_INACTIVATED", "SUBSCRIPTION_UPDATED"]);

/** Qualquer evento destas três famílias precisa do payload salvo para o pré-roteamento (decisão 6/M8). */
function precisaDeGet(eventType: string): boolean {
  return EVENTOS_DE_DINHEIRO.has(eventType) || EVENTOS_DE_COBRANCA_GET.has(eventType) || EVENTOS_DE_ASSINATURA_GET.has(eventType);
}

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
      // "erro" (aplicação interna falhou no SQL), "falha" (GET ou
      // pré-roteamento falharam), "falha_ao_aplicar" (a RPC de aplicar
      // devolveu erro) e "abortado" (erro de configuração) contam todos
      // como falha da rodada.
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

interface ResultadoPreRoteamento {
  candidato: boolean;
  /**
   * `true` quando uma das consultas baratas (`pagamentoConhecido`/
   * `assinaturaConhecida`/`clienteConhecido`) devolveu ERRO (infraestrutura),
   * não "não achei nada". Uma falha aqui NUNCA vira `outro_app`: quem chama
   * precisa registrar a falha com backoff e tentar de novo, porque fechar
   * como `outro_app` esconderia um evento legítimo para sempre.
   */
  falhou: boolean;
}

/**
 * Decide se vale a pena consultar o Asaas (decisão 6/M8). `paymentId` é
 * `evento.idDoRecurso` só para os eventos cujo `resource_id` é mesmo um
 * `payment.id` (dinheiro e cobrança); para os eventos de assinatura,
 * `paymentId` vem `null` (o `idDoRecurso` ali é um `subscription.id`, e o
 * `subscriptionId` de `ref` já cobre o roteamento). Os outros três campos
 * vêm do payload guardado. Pular o `GET` nunca concede nada sozinho: o pior
 * caso desta função devolver `candidato: true` por engano é gastar um `GET`
 * à toa.
 */
async function ehCandidatoAoGet(
  db: DbEventosAsaas,
  paymentId: string | null,
  ref: ReferenciaPreRoteamento,
): Promise<ResultadoPreRoteamento> {
  if (ref.externalReference && ref.externalReference.startsWith("HC:")) {
    return { candidato: true, falhou: false };
  }

  if (paymentId) {
    const r = await db.pagamentoConhecido(paymentId);
    if (r.error) return { candidato: false, falhou: true };
    if (r.data) return { candidato: true, falhou: false };
  }
  if (ref.subscriptionId) {
    const r = await db.assinaturaConhecida(ref.subscriptionId);
    if (r.error) return { candidato: false, falhou: true };
    if (r.data) return { candidato: true, falhou: false };
  }
  if (ref.customerId) {
    const r = await db.clienteConhecido(ref.customerId);
    if (r.error) return { candidato: false, falhou: true };
    if (r.data) return { candidato: true, falhou: false };
  }
  return { candidato: false, falhou: false };
}

// ─── Monta o objeto CONFIRMADO (decisão 3, nunca o corpo do webhook) ───────

/**
 * O contrato exato de `p_confirmacao` documentado no comentário da PARTE 5
 * da migração 0909 (`fn_billing_asaas_aplicar_pagamento`): campos do objeto
 * que o `GET /payments/{id}` CONFIRMOU, mais `assinatura_status` (decisão
 * 10/M3) quando este processador também consultou `GET /subscriptions/{id}`.
 */
function confirmacaoDoPagamento(
  cobranca: CobrancaAsaas,
  assinaturaStatus: string | null,
  parcelamento: { total: number; parcelas: number } | null = null,
): Record<string, unknown> {
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
  // D-177: parcela de um parcelamento. O banco confere o TOTAL do parcelamento (GET /installments/{id})
  // contra o pedido, nunca o valor da parcela contra o preço do plano.
  if (cobranca.installment) {
    confirmacao.installment = cobranca.installment;
    if (parcelamento) {
      confirmacao.parcelamento_total = parcelamento.total;
      confirmacao.parcelamento_parcelas = parcelamento.parcelas;
    }
  }
  return confirmacao;
}

/**
 * O contrato de `p_confirmacao` de `fn_billing_asaas_aplicar_estorno`
 * (comentário da PARTE 6 da migração 0909, decisão 9): `id` é sempre o MESMO
 * id do pagamento original (o Asaas representa o estorno como mudança de
 * status do mesmo objeto). `value` é obrigatório no contrato; sem ele
 * (recurso removido no Asaas, caso não previsto pela decisão 9) quem chama
 * envia `null` em vez desta função, e o evento fica `aguardando` com backoff.
 */
function confirmacaoDeEstorno(cobranca: CobrancaAsaas): Record<string, unknown> {
  return {
    id: cobranca.id,
    status: cobranca.status,
    value: cobranca.value,
    originalValue: cobranca.originalValue ?? null,
    paymentDate: cobranca.paymentDate ?? null,
    confirmedDate: cobranca.confirmedDate ?? null,
    subscription: cobranca.subscription ?? null,
    externalReference: cobranca.externalReference ?? null,
  };
}

/**
 * O contrato de `p_confirmacao` de `fn_billing_asaas_aplicar_fim_da_
 * assinatura` para `PAYMENT_OVERDUE`/`PAYMENT_DELETED` (comentário da PARTE 6
 * da migração 0909, decisão 10): `status` só importa para `PAYMENT_OVERDUE`
 * (confirma só quando igual a `OVERDUE`); `removida` só importa para
 * `PAYMENT_DELETED` (confirma a remoção, 404/`deleted:true`). Um `GET` que
 * devolveu o recurso REMOVIDO para um `PAYMENT_OVERDUE` não pode confirmar o
 * status `OVERDUE` (o recurso já não existe): fica sem o campo `status`, e o
 * evento volta `aguardando` com backoff em vez de aplicar algo incerto.
 */
function confirmacaoDoFimDoPagamento(
  eventType: string,
  idDoRecurso: string,
  cobranca: Awaited<ReturnType<ClienteAsaasHttp["buscarCobranca"]>>,
): Record<string, unknown> {
  if ("removido" in cobranca) {
    return eventType === "PAYMENT_DELETED" ? { id: idDoRecurso, removida: true } : { id: idDoRecurso };
  }
  return {
    id: cobranca.id,
    status: cobranca.status,
    removida: false,
    subscription: cobranca.subscription ?? null,
    externalReference: cobranca.externalReference ?? null,
    installment: cobranca.installment ?? null,
  };
}

/**
 * O contrato de `p_confirmacao` de `fn_billing_asaas_aplicar_fim_da_
 * assinatura` para `SUBSCRIPTION_DELETED`/`SUBSCRIPTION_INACTIVATED`/
 * `SUBSCRIPTION_UPDATED` (comentário da PARTE 6, decisões 10/22): `removida`
 * é a fonte da verdade da remoção (404/`deleted:true`), qualquer que seja o
 * `event_type` que disparou a checagem.
 */
function confirmacaoDeAssinatura(
  idDoRecurso: string,
  assinatura: Awaited<ReturnType<ClienteAsaasHttp["buscarAssinatura"]>>,
): Record<string, unknown> {
  if ("removido" in assinatura) {
    return { id: idDoRecurso, removida: true };
  }
  return { id: assinatura.id, status: assinatura.status ?? null, removida: false };
}

// ─── Processa um único evento reservado ────────────────────────────────────

interface ResultadoDeUmEvento {
  categoria: string;
  abortarRodada: boolean;
}

async function aplicarSemConfirmacao(deps: DepsProcessarEventosAsaas, evento: EventoReservado): Promise<ResultadoDeUmEvento> {
  const aplicado = await deps.db.aplicarEvento(evento.id, evento.leaseToken, null);
  return finalizarAplicacao(deps, evento, aplicado, null);
}

/**
 * Pré-roteamento decidiu, só pelo payload já guardado, que o evento não é
 * nosso (decisão 6/M8): fecha como `outro_app` direto, sem gastar `GET`,
 * pelo sentinela que `fn_billing_asaas_aplicar_evento` (0909, Tarefa 6)
 * reconhece por igualdade estrutural do jsonb.
 */
async function aplicarComoOutroApp(deps: DepsProcessarEventosAsaas, evento: EventoReservado): Promise<ResultadoDeUmEvento> {
  const aplicado = await deps.db.aplicarEvento(evento.id, evento.leaseToken, { pre_roteamento: "outro_app" });
  return finalizarAplicacao(deps, evento, aplicado, null);
}

/**
 * A leitura do payload ou uma das consultas baratas do pré-roteamento
 * falhou (infraestrutura, não "não achei nada"): registra a falha com
 * backoff, o MESMO caminho de um `GET` que falhou (decisão 20). Nunca fecha
 * como `outro_app`: isso esconderia um evento legítimo para sempre.
 */
async function registrarFalhaDePreRoteamento(
  deps: DepsProcessarEventosAsaas,
  evento: EventoReservado,
): Promise<ResultadoDeUmEvento> {
  deps.logger.warn("asaas_processar_pre_roteamento_falhou", { eventoId: evento.id });
  const falha = await deps.db.registrarFalha(evento.id, evento.leaseToken, "asaas_pre_roteamento_falhou");
  if (falha.error) {
    deps.logger.error("asaas_processar_registrar_falha_falhou", {
      eventoId: evento.id,
      codigo: falha.error.code,
    });
  }
  return { categoria: "falha", abortarRodada: false };
}

/** `billing_assinatura_nao_confere` (22023) ou contrato não encontrado (P0002, decisão 22/4): o contrato já não tem mais esta assinatura, e a remoção no Asaas já bastou. Não é uma falha de infraestrutura. */
function ehAssinaturaJaDesvinculadaDoContrato(erro: RpcErro | null | undefined): boolean {
  if (!erro) return false;
  if (erro.code === "P0002") return true;
  return Boolean(erro.message?.includes("billing_assinatura_nao_confere"));
}

/**
 * Alarme `remover_assinatura_pendente` (Tarefa 6, decisão 10/22, N39): a
 * assinatura nunca recebeu o primeiro pagamento (ou o pagamento de renovação
 * venceu sem pagar) e o pedido é de tipo `assinatura`. `removerAssinatura` é
 * idempotente em 404 (o cliente HTTP já trata isso, `lib/billing/asaas/
 * cliente.ts`). Depois de remover, `fn_billing_asaas_marcar_assinatura_
 * encerrada` grava o marcador (decisão 22) só quando o CONTRATO ainda aponta
 * para esta mesma assinatura; se o contrato já trocou de assinatura (ou não
 * existe mais), a remoção no Asaas já bastou e nada mais precisa acontecer.
 *
 * Correção 9 (revisão da fase): `subscriptionId` chega `null` quando o `GET
 * /payments/{id}` já veio com o recurso REMOVIDO (404/`deleted:true`,
 * `confirmacaoDoFimDoPagamento`) - não há como saber a que assinatura aquele
 * pagamento pertencia, então um `DELETE /subscriptions/{id}` está fora de
 * alcance. Em vez de não fazer nada (o comportamento antigo, que deixava uma
 * cobrança potencialmente viva sem ninguém tentando removê-la), cai para
 * remover a COBRANÇA pelo `asaas_payment_id` do próprio evento
 * (`evento.idDoRecurso`), idempotente em 404 (decisão 10): sem o id da
 * assinatura, não há o que marcar em `marcarAssinaturaEncerrada` aqui - a
 * conciliação diária (Tarefa 16), que conhece o `asaas_subscription_id`
 * gravado em `billing_contracts`, cuida do marcador quando conseguir
 * confirmar a remoção de verdade.
 */
async function tentarRemoverAssinatura(
  deps: DepsProcessarEventosAsaas,
  evento: EventoReservado,
  subscriptionId: string | null,
  organizationId: string | null,
): Promise<void> {
  if (!subscriptionId) {
    if (!evento.idDoRecurso) return;
    try {
      await deps.asaas.removerCobranca(evento.idDoRecurso);
    } catch (err) {
      // Mesma doutrina de tentarRemoverCobranca (decisão 10): só loga; a
      // conciliação diária (Tarefa 16) refaz.
      deps.logger.warn("asaas_processar_remover_cobranca_fallback_de_assinatura_falhou", {
        eventoId: evento.id,
        tipoErro: tipoDoErro(err),
      });
    }
    return;
  }
  try {
    await deps.asaas.removerAssinatura(subscriptionId);
  } catch (err) {
    // Falha aqui só loga (mesma doutrina de tentarRemoverCobranca, decisão
    // 10): a conciliação diária (Tarefa 16) refaz.
    deps.logger.warn("asaas_processar_remover_assinatura_falhou", {
      eventoId: evento.id,
      tipoErro: tipoDoErro(err),
    });
    return;
  }

  if (!organizationId) return;

  const marcado = await deps.db.marcarAssinaturaEncerrada(organizationId, subscriptionId);
  if (marcado.error && !ehAssinaturaJaDesvinculadaDoContrato(marcado.error)) {
    deps.logger.warn("asaas_processar_marcar_assinatura_encerrada_falhou", {
      eventoId: evento.id,
      codigo: marcado.error.code,
    });
  }
}

/**
 * D-086: o estorno total cortou o acesso (assinatura) ou retirou os tokens do
 * pacote. O banco avisa pelos alarmes `estorno_cortou_acesso` e
 * `estorno_removeu_tokens_do_pacote`; aqui vira a linha de auditoria, com o
 * motivo. Falha de auditoria só loga: nunca desfaz nem atrasa o corte.
 */
function registrarAlarmesDoEstorno(
  deps: DepsProcessarEventosAsaas,
  evento: EventoReservado,
  organizationId: string | null,
  alarmes: string[],
): void {
  // O banco fechou o evento como aplicado, mas o corte do estorno total NÃO aconteceu: sem
  // este log o defeito ficaria só na coluna `alarme`. A tela do admin também conta.
  if (alarmes.includes("estorno_corte_falhou")) {
    deps.logger.error("alarme_asaas_estorno_corte_falhou", { eventoId: evento.id, organizationId });
  }
  // Estorno total de cobrança que não é a do período vigente: nada foi cortado, o admin decide.
  if (alarmes.includes("estorno_de_periodo_antigo")) {
    deps.logger.warn("alarme_asaas_estorno_de_periodo_antigo", { eventoId: evento.id, organizationId });
  }
  // Estorno total de um dos pagamentos EMPILHADOS (0942): o período do contrato encolheu para o fim
  // do maior pagamento que sobrou, mas ainda cobre o futuro. O acesso e a assinatura seguem, o admin
  // confere.
  if (alarmes.includes("estorno_encurtou_periodo")) {
    deps.logger.warn("alarme_asaas_estorno_encurtou_periodo", { eventoId: evento.id, organizationId });
  }
}

async function auditarCorteDeEstorno(
  deps: DepsProcessarEventosAsaas,
  evento: EventoReservado,
  organizationId: string | null,
  alarmes: string[],
): Promise<void> {
  const cortouAssinatura = alarmes.includes("estorno_cortou_acesso");
  const retirouPacote = alarmes.includes("estorno_removeu_tokens_do_pacote");
  if (!cortouAssinatura && !retirouPacote) return;
  if (alarmes.includes("estorno_corte_falhou")) return;

  deps.logger.warn("asaas_processar_estorno_total_cortou", {
    eventoId: evento.id,
    tipo: retirouPacote ? "pacote_tokens" : "assinatura",
  });
  if (!deps.auditar) return;
  try {
    await deps.auditar({
      action: "billing.asaas_refund_cut",
      organizationId,
      // `api_audit_log.resource_id` é uuid: o recurso é a organização, e o id da
      // cobrança (pay_...) vai no metadata.
      resourceType: "organization",
      resourceId: organizationId,
      metadata: {
        motivo: "estorno_total",
        pagamento_asaas: evento.idDoRecurso,
        tipo: retirouPacote ? "pacote_tokens" : "assinatura",
        evento_id: evento.id,
        assinatura_removida_no_asaas_pedida: alarmes.includes("remover_assinatura_pendente"),
      },
    });
  } catch (err) {
    deps.logger.warn("asaas_processar_auditoria_do_corte_falhou", { eventoId: evento.id, tipoErro: tipoDoErro(err) });
  }
}

async function finalizarAplicacao(
  deps: DepsProcessarEventosAsaas,
  evento: EventoReservado,
  aplicado: RpcResultado<AplicarEventoResultado>,
  subscriptionId: string | null,
  installmentId: string | null = null,
): Promise<ResultadoDeUmEvento> {
  if (aplicado.error || !aplicado.data) {
    deps.logger.error("asaas_processar_aplicar_evento_falhou", {
      eventoId: evento.id,
      codigo: aplicado.error?.code,
    });
    // A RPC de aplicar em si falhou (não a confirmação, a CHAMADA): registra
    // a falha com o MESMO lease para o backoff exponencial decidir quando
    // tentar de novo, em vez de deixar o evento preso até o lease expirar
    // sozinho, sem escalonar as tentativas.
    const falha = await deps.db.registrarFalha(
      evento.id,
      evento.leaseToken,
      `asaas_aplicar_evento_${aplicado.error?.code ?? "falhou"}`,
    );
    if (falha.error) {
      deps.logger.error("asaas_processar_registrar_falha_falhou", {
        eventoId: evento.id,
        codigo: falha.error.code,
      });
    }
    return { categoria: "falha_ao_aplicar", abortarRodada: false };
  }

  const { resultado, organizationId, alarme } = aplicado.data;
  const alarmes = alarme ? alarme.split(",") : [];
  registrarAlarmesDoEstorno(deps, evento, organizationId, alarmes);
  await auditarCorteDeEstorno(deps, evento, organizationId, alarmes);
  if (alarmes.includes("remover_cobranca_pendente")) {
    await tentarRemoverCobranca(deps, evento, installmentId);
  }
  if (alarmes.includes("remover_assinatura_pendente")) {
    await tentarRemoverAssinatura(deps, evento, subscriptionId, organizationId);
  }
  return { categoria: resultado, abortarRodada: false };
}

/**
 * O alarme `remover_cobranca_pendente` (Tarefa 6, correção A1): `PAYMENT_
 * OVERDUE` confirmado de um pedido AVULSO (não assinatura) marca o pedido
 * como vencido e pede a remoção da cobrança no Asaas, para um pedido novo
 * poder nascer sem cobrar a mais (decisão 10, decisão 11 do pedido aberto
 * único).
 */
async function tentarRemoverCobranca(
  deps: DepsProcessarEventosAsaas,
  evento: EventoReservado,
  installmentId: string | null = null,
): Promise<void> {
  if (!evento.idDoRecurso) return;
  try {
    if (installmentId) {
      // D-177: pedido parcelado vencido: remove o parcelamento INTEIRO. Remover só esta parcela deixaria as
      // outras pendentes, cobrando mês a mês.
      await deps.asaas.removerParcelamento(installmentId);
    } else {
      await deps.asaas.removerCobranca(evento.idDoRecurso);
    }
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
  payloadFalhou: boolean,
): Promise<ResultadoDeUmEvento> {
  if (payloadFalhou) return registrarFalhaDePreRoteamento(deps, evento);

  const referencia = extrairReferenciaDoPayload(payload);
  const roteamento = await ehCandidatoAoGet(deps.db, evento.idDoRecurso, referencia);
  if (roteamento.falhou) return registrarFalhaDePreRoteamento(deps, evento);
  if (!roteamento.candidato) {
    // Decisão 6/M8: payload não bate com nada conhecido, e não começa com
    // "HC:". NENHUM GET é feito; fecha como outro_app pelo sentinela (ver o
    // cabeçalho deste arquivo).
    return aplicarComoOutroApp(deps, evento);
  }

  if (!evento.idDoRecurso) {
    // Defensivo: um evento de dinheiro sempre deveria trazer `payment.id`
    // como `resource_id` (a rota do webhook garante isso). Sem ele não há
    // como fazer o GET; a mesma saída segura do ramo acima.
    return aplicarSemConfirmacao(deps, evento);
  }

  let cobranca: Awaited<ReturnType<ClienteAsaasHttp["buscarCobranca"]>>;
  try {
    cobranca = await deps.asaas.buscarCobranca(evento.idDoRecurso);
  } catch (err) {
    return tratarErroDeChamada(deps, evento, err);
  }

  if ("removido" in cobranca) {
    // O recurso já não existe no Asaas (404/deleted:true). Tratar isso como
    // remoção confirmada é escopo dos eventos de fim de pagamento (B4); aqui
    // só evita aplicar qualquer coisa - a mesma saída segura acima.
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

  // D-177: parcela de parcelamento. O total vem de GET /installments/{id}; sem ele o evento volta a tentar
  // (nunca confere o valor da parcela contra o preço).
  let parcelamento: { total: number; parcelas: number } | null = null;
  if (cobranca.installment) {
    try {
      const r = await deps.asaas.buscarParcelamento(cobranca.installment);
      if ("removido" in r) return aplicarSemConfirmacao(deps, evento);
      parcelamento = { total: r.value, parcelas: r.installmentCount };
    } catch (err) {
      return tratarErroDeChamada(deps, evento, err);
    }
  }

  const confirmacao = confirmacaoDoPagamento(cobranca, assinaturaStatus, parcelamento);
  const aplicado = await deps.db.aplicarEvento(evento.id, evento.leaseToken, confirmacao);
  return finalizarAplicacao(deps, evento, aplicado, cobranca.subscription ?? null);
}

/**
 * Estorno/chargeback/`PAYMENT_OVERDUE`/`PAYMENT_DELETED` (`EVENTOS_DE_
 * COBRANCA_GET`): mesmo `GET /payments/{id}` do grupo de dinheiro, mas o
 * contrato de `p_confirmacao` é o de `fn_billing_asaas_aplicar_estorno`
 * (grupo `EVENTOS_DE_ESTORNO`) ou de `fn_billing_asaas_aplicar_fim_da_
 * assinatura` (grupo `EVENTOS_DE_FIM_DE_PAGAMENTO`).
 */
async function processarEventoDeCobranca(
  deps: DepsProcessarEventosAsaas,
  evento: EventoReservado,
  payload: unknown,
  payloadFalhou: boolean,
): Promise<ResultadoDeUmEvento> {
  if (payloadFalhou) return registrarFalhaDePreRoteamento(deps, evento);

  const referencia = extrairReferenciaDoPayload(payload);
  const roteamento = await ehCandidatoAoGet(deps.db, evento.idDoRecurso, referencia);
  if (roteamento.falhou) return registrarFalhaDePreRoteamento(deps, evento);
  if (!roteamento.candidato) return aplicarComoOutroApp(deps, evento);

  if (!evento.idDoRecurso) {
    return aplicarSemConfirmacao(deps, evento);
  }

  let cobranca: Awaited<ReturnType<ClienteAsaasHttp["buscarCobranca"]>>;
  try {
    cobranca = await deps.asaas.buscarCobranca(evento.idDoRecurso);
  } catch (err) {
    return tratarErroDeChamada(deps, evento, err);
  }

  let confirmacao: Record<string, unknown> | null;
  if (EVENTOS_DE_ESTORNO.has(evento.eventType)) {
    // O contrato de fn_billing_asaas_aplicar_estorno exige `value` (decisão
    // 9): sem o objeto (removido no Asaas, caso não previsto), manda `null`
    // em vez de um confirmação incompleta - o evento fica aguardando com
    // backoff, nunca aplica algo incerto.
    confirmacao = "removido" in cobranca ? null : confirmacaoDeEstorno(cobranca);
  } else {
    confirmacao = confirmacaoDoFimDoPagamento(evento.eventType, evento.idDoRecurso, cobranca);
  }

  const aplicado = await deps.db.aplicarEvento(evento.id, evento.leaseToken, confirmacao);
  const subscriptionId = "removido" in cobranca ? null : (cobranca.subscription ?? null);
  const installmentId = "removido" in cobranca ? null : (cobranca.installment ?? null);
  return finalizarAplicacao(deps, evento, aplicado, subscriptionId, installmentId);
}

/**
 * `SUBSCRIPTION_DELETED`/`SUBSCRIPTION_INACTIVATED`/`SUBSCRIPTION_UPDATED`
 * (`EVENTOS_DE_ASSINATURA_GET`): `GET /subscriptions/{id}`, contrato de
 * `fn_billing_asaas_aplicar_fim_da_assinatura` pelo lado da assinatura.
 */
async function processarEventoDeAssinatura(
  deps: DepsProcessarEventosAsaas,
  evento: EventoReservado,
  payload: unknown,
  payloadFalhou: boolean,
): Promise<ResultadoDeUmEvento> {
  if (payloadFalhou) return registrarFalhaDePreRoteamento(deps, evento);

  const referencia = extrairReferenciaDoPayload(payload);
  // `paymentId: null` de propósito: o `resource_id` de um evento de
  // assinatura é um `subscription.id`, não um `payment.id` - o roteamento
  // por assinatura já é coberto por `referencia.subscriptionId`.
  const roteamento = await ehCandidatoAoGet(deps.db, null, referencia);
  if (roteamento.falhou) return registrarFalhaDePreRoteamento(deps, evento);
  if (!roteamento.candidato) return aplicarComoOutroApp(deps, evento);

  if (!evento.idDoRecurso) {
    return aplicarSemConfirmacao(deps, evento);
  }

  let assinatura: Awaited<ReturnType<ClienteAsaasHttp["buscarAssinatura"]>>;
  try {
    assinatura = await deps.asaas.buscarAssinatura(evento.idDoRecurso);
  } catch (err) {
    return tratarErroDeChamada(deps, evento, err);
  }

  const confirmacao = confirmacaoDeAssinatura(evento.idDoRecurso, assinatura);
  const aplicado = await deps.db.aplicarEvento(evento.id, evento.leaseToken, confirmacao);
  return finalizarAplicacao(deps, evento, aplicado, null);
}

async function processarUmEvento(
  deps: DepsProcessarEventosAsaas,
  evento: EventoReservado,
  payload: unknown,
  payloadFalhou: boolean,
): Promise<ResultadoDeUmEvento> {
  if (EVENTOS_DE_DINHEIRO.has(evento.eventType)) {
    return processarEventoDeDinheiro(deps, evento, payload, payloadFalhou);
  }
  if (EVENTOS_DE_COBRANCA_GET.has(evento.eventType)) {
    return processarEventoDeCobranca(deps, evento, payload, payloadFalhou);
  }
  if (EVENTOS_DE_ASSINATURA_GET.has(evento.eventType)) {
    return processarEventoDeAssinatura(deps, evento, payload, payloadFalhou);
  }
  // Nenhum GET necessário: fn_billing_asaas_aplicar_evento só registra
  // (ignorado, decisão 10).
  return aplicarSemConfirmacao(deps, evento);
}

// ─── A função pública ───────────────────────────────────────────────────

interface ResultadoPayloads {
  encontrados: Map<string, unknown>;
  /**
   * A leitura em LOTE falhou (infraestrutura): NENHUM dos ids pedidos tem
   * payload confiável nesta rodada. Diferente de "achei o evento mas o
   * payload é `null`": aqui não sabemos nada, e por isso `falhouCarregar`
   * nunca pode virar um `outro_app` silencioso (decisão 6/M8 estendida).
   */
  falhouCarregar: boolean;
}

async function carregarPayloads(deps: DepsProcessarEventosAsaas, ids: string[]): Promise<ResultadoPayloads> {
  const encontrados = new Map<string, unknown>();
  if (ids.length === 0) return { encontrados, falhouCarregar: false };
  const res = await deps.db.lerPayloads(ids);
  if (res.error || !res.data) {
    deps.logger.warn("asaas_processar_ler_payloads_falhou", { codigo: res.error?.code });
    return { encontrados, falhouCarregar: true };
  }
  for (const linha of res.data) encontrados.set(linha.id, linha.payload);
  return { encontrados, falhouCarregar: false };
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

  const payloadsResultado = await carregarPayloads(
    deps,
    eventos.filter((e) => precisaDeGet(e.eventType)).map((e) => e.id),
  );

  for (const evento of eventos) {
    if (relogio(deps).getTime() - inicio >= orcamentoMs) {
      resumo.cortadoPeloOrcamento = true;
      break;
    }

    const payload = payloadsResultado.encontrados.get(evento.id) ?? null;
    const payloadFalhou = precisaDeGet(evento.eventType) && payloadsResultado.falhouCarregar;
    const resultado = await processarUmEvento(deps, evento, payload, payloadFalhou);
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
 * `billing_orders`, `asaas_webhook_events`) e as funções da Tarefa 4/5/6 não
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
        data: linhas.map((l) => ({ id: l.id, eventType: l.event_type, idDoRecurso: l.resource_id, leaseToken: l.lease_token })),
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

    async marcarAssinaturaEncerrada(organizationId, asaasSubscriptionId) {
      const { data, error } = await admin.rpc("fn_billing_asaas_marcar_assinatura_encerrada" as never, {
        p_org: organizationId,
        p_asaas_subscription_id: asaasSubscriptionId,
        p_actor: null,
      } as never);
      if (error) return { data: null, error: { code: error.code, message: error.message } };
      const linha = data as { ja_registrado: boolean };
      return { data: { jaRegistrado: linha.ja_registrado }, error: null };
    },
  };
}
