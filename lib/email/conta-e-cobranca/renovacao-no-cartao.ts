/**
 * COB-04, renovação no cartão chegando: o aviso de que a assinatura com cobrança automática no cartão vai ser
 * cobrada em poucos dias. É o espelho da régua de renovação (`lib/billing/assinatura/avisar-renovacao.ts`, que
 * avisa quem NÃO renova sozinho): aqui entram só os contratos COM assinatura viva no Asaas.
 *
 * ─── Quem entra ─────────────────────────────────────────────────────────────
 *
 * Contrato `ativa`, gateway `asaas`, com `asaas_subscription_id` e sem `asaas_assinatura_encerrada_em` (a
 * mesma regra de `fn_billing_assinatura_viva`, migration 0946), sem `cancel_at_period_end` (quem cancelou não
 * será cobrado), organização ativa. Assinatura viva no CRM é sempre cartão (a assinatura do Asaas só é criada
 * com `billingType: CREDIT_CARD`; Pix e parcelado são cobrança avulsa, sem assinatura).
 *
 * ─── Quando ─────────────────────────────────────────────────────────────────
 *
 * O banco não guarda o `nextDueDate` do Asaas, mas ele é uma conta do período (`fn_billing_asaas_periodo_do_ciclo`):
 * o período pago pela cobrança com vencimento D acaba em D + ciclo + 1 dia (limite exclusivo), e a cobrança
 * seguinte vence em D + ciclo. Logo a data da cobrança é o ÚLTIMO DIA de acesso (`current_period_end` menos um
 * dia, em São Paulo). O aviso sai quando faltam de 1 a 3 dias para essa data: um job que perdeu um dia manda
 * com 2 ou 1 dia em vez de perder o aviso; no próprio dia da cobrança (0) já não sai. A chave
 * `renovacao:<contrato>:<data da cobrança>` garante um aviso por cobrança, mesmo com o job rodando nos 3 dias.
 *
 * ─── O que o e-mail mostra ──────────────────────────────────────────────────
 *
 * Valor: o preço do ciclo na versão do plano que o contrato aponta (a mesma conta que o conferidor de
 * renovação usa para validar a cobrança); sem preço gravado, o contrato é pulado (melhor calar que dizer um
 * valor errado). Cartão: o CRM não guarda os dígitos (quem guarda é o Asaas), então o e-mail sai com "no cartão
 * cadastrado" e sem a linha Cartão. Destinatários: os admins da organização. Sem cópia ao operador.
 *
 * ─── Só enfileira ───────────────────────────────────────────────────────────
 *
 * A rodada não fala com servidor de e-mail: ela ENFILEIRA o aviso (`fila.ts`) com valor, plano, data e dias
 * capturados no momento, e o cron `enviar-emails-de-conta` envia (com nova tentativa se o servidor falhar).
 * Por isso a rodada é barata e tem orçamento de tempo próprio (`ORCAMENTO_DA_RODADA_MS`, como a régua irmã
 * `avisar-renovacao`): estourado, ela para e devolve quantos contratos ficaram para a próxima rodada
 * (`restantes`); como o aviso vale de 1 a 3 dias antes da cobrança, a rodada do dia seguinte ainda alcança.
 *
 * Nunca lança por um contrato: a falha de um vira log e a rodada segue. Só o erro de LISTAR sobe.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { ultimoDiaDoPeriodo } from "@/lib/billing/assinatura/estado-da-assinatura";
import { dataSaoPaulo } from "@/lib/billing/asaas/dinheiro";
import { logger } from "@/lib/logger";

import { enfileirarEmailDeConta, type Enfileirador } from "./fila";

const MS_POR_DIA = 24 * 60 * 60 * 1000;
/** Quantos dias antes da cobrança o aviso passa a valer. */
const DIAS_DE_ANTECEDENCIA = 3;
/** Quantos contratos uma rodada examina. */
const TAMANHO_DO_LOTE = 500;
/** Quanto a rodada trabalha antes de parar (teto do curl no scheduler: 60 s). */
export const ORCAMENTO_DA_RODADA_MS = 45_000;

export interface ContratoNoCartao {
  id: string;
  organization_id: string;
  plan_id: string;
  cycle: string | null;
  current_period_end: string;
}

export interface DepsDaRenovacaoNoCartao {
  /** Injetável nos testes. O padrão é o enfileiramento real. */
  enfileirar?: Enfileirador;
  agora?: () => Date;
  /** Orçamento de tempo da rodada, em ms. */
  orcamentoMs?: number;
  /** Injetável nos testes. O padrão é a consulta real ao banco. */
  listar?: (admin: SupabaseClient, agora: Date, ate: Date) => Promise<ContratoNoCartao[]>;
}

export interface ResumoDaRenovacaoNoCartao {
  /** Contratos que o banco listou na janela. */
  avaliados: number;
  /** Fora da janela de 1 a 3 dias (cobrança hoje, ou ainda longe). */
  foraDaJanela: number;
  /** Pulados: organização inativa, plano ou preço ausente. */
  pulados: number;
  /** Avisos que entraram na fila agora. */
  enfileirados: number;
  /** A chave já estava na fila (ou já saiu) antes: nada novo. */
  jaAvisados: number;
  /** Contratos com falha de banco ou de gravação na fila. */
  falhas: number;
  /** Contratos que o orçamento de tempo deixou para a próxima rodada. */
  restantes: number;
}

interface LinhaDePlano {
  name: string;
  price_monthly_cents: number | null;
  price_semiannual_cents: number | null;
  price_yearly_cents: number | null;
}

async function listarContratos(admin: SupabaseClient, agora: Date, ate: Date): Promise<ContratoNoCartao[]> {
  const { data, error } = await admin
    .from("billing_contracts")
    .select("id, organization_id, plan_id, cycle, current_period_end")
    .eq("status", "ativa")
    .eq("gateway", "asaas")
    .not("asaas_subscription_id", "is", null)
    .is("asaas_assinatura_encerrada_em", null)
    .eq("cancel_at_period_end", false)
    .gt("current_period_end", agora.toISOString())
    .lte("current_period_end", ate.toISOString())
    .order("current_period_end", { ascending: true })
    .limit(TAMANHO_DO_LOTE);
  if (error) throw new Error(`billing_contracts: ${error.message}`);
  return (data as ContratoNoCartao[] | null) ?? [];
}

function precoDoCiclo(plano: LinhaDePlano, ciclo: string | null): number | null {
  const preco =
    ciclo === "monthly"
      ? plano.price_monthly_cents
      : ciclo === "semiannual"
        ? plano.price_semiannual_cents
        : ciclo === "yearly"
          ? plano.price_yearly_cents
          : null;
  return typeof preco === "number" && preco > 0 ? preco : null;
}

/** Dias corridos de `a` até `b`, as duas como `AAAA-MM-DD`. */
function diasEntre(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / MS_POR_DIA);
}

export async function avisarRenovacoesNoCartao(
  admin: SupabaseClient,
  deps: DepsDaRenovacaoNoCartao = {},
): Promise<ResumoDaRenovacaoNoCartao> {
  const enfileirar = deps.enfileirar ?? ((entrada) => enfileirarEmailDeConta(entrada, admin));
  const relogio = deps.agora ?? (() => new Date());
  const agora = relogio();
  const orcamentoMs = deps.orcamentoMs ?? ORCAMENTO_DA_RODADA_MS;
  const listar = deps.listar ?? listarContratos;
  const resumo: ResumoDaRenovacaoNoCartao = {
    avaliados: 0,
    foraDaJanela: 0,
    pulados: 0,
    enfileirados: 0,
    jaAvisados: 0,
    falhas: 0,
    restantes: 0,
  };

  // A cobrança é no último dia de acesso; com 3 dias de antecedência o fim do período chega a 4 dias e um dia
  // de folga do fuso. O filtro exato por data de São Paulo é feito abaixo.
  const ate = new Date(agora.getTime() + (DIAS_DE_ANTECEDENCIA + 2) * MS_POR_DIA);
  const contratos = await listar(admin, agora, ate);
  resumo.avaliados = contratos.length;
  if (contratos.length >= TAMANHO_DO_LOTE) {
    logger.warn("[renovacao-no-cartao] lote cheio, o resto fica para a próxima rodada", { limite: TAMANHO_DO_LOTE });
  }

  const hoje = dataSaoPaulo(agora);
  for (const [i, contrato] of contratos.entries()) {
    // Orçamento esgotado: o resto fica para a próxima rodada (o aviso vale de 1 a 3 dias, então ainda alcança).
    if (relogio().getTime() - agora.getTime() > orcamentoMs) {
      resumo.restantes = contratos.length - i;
      logger.warn("[renovacao-no-cartao] orçamento de tempo esgotado, o resto fica para a próxima rodada", {
        restantes: resumo.restantes,
      });
      break;
    }
    try {
      const cobrancaEm = dataSaoPaulo(ultimoDiaDoPeriodo(contrato.current_period_end));
      const dias = diasEntre(hoje, cobrancaEm);
      if (dias < 1 || dias > DIAS_DE_ANTECEDENCIA) {
        resumo.foraDaJanela++;
        continue;
      }

      const { data: org, error: erroOrg } = await admin
        .from("organizations")
        .select("status")
        .eq("id", contrato.organization_id)
        .maybeSingle();
      if (erroOrg) throw new Error(`organizations: ${erroOrg.message}`);
      if ((org as { status: string } | null)?.status !== "active") {
        resumo.pulados++;
        continue;
      }

      const { data: planoLido, error: erroPlano } = await admin
        .from("billing_plans")
        .select("name, price_monthly_cents, price_semiannual_cents, price_yearly_cents")
        .eq("id", contrato.plan_id)
        .maybeSingle();
      if (erroPlano) throw new Error(`billing_plans: ${erroPlano.message}`);
      const plano = planoLido as LinhaDePlano | null;
      const valor = plano ? precoDoCiclo(plano, contrato.cycle) : null;
      if (!plano || valor === null) {
        logger.warn("[renovacao-no-cartao] contrato sem preço do ciclo, aviso pulado", {
          organization_id: contrato.organization_id,
          ciclo: contrato.cycle,
        });
        resumo.pulados++;
        continue;
      }

      const r = await enfileirar({
        organizationId: contrato.organization_id,
        emailId: "COB-04",
        chave: `renovacao:${contrato.id}:${cobrancaEm}`,
        destino: "admins",
        copiaParaOperador: false,
        dados: { plano: plano.name, valor, cobrancaEm, dias },
      });

      if (r === "enfileirado") resumo.enfileirados++;
      else if (r === "ja_existia") resumo.jaAvisados++;
      else resumo.falhas++;
    } catch (erro) {
      resumo.falhas++;
      logger.warn("[renovacao-no-cartao] contrato falhou, rodada segue", {
        organization_id: contrato.organization_id,
        motivo: erro instanceof Error ? erro.message.slice(0, 120) : "erro",
      });
    }
  }

  return resumo;
}
