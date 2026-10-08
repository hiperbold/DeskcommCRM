/**
 * Os gatilhos dos e-mails de conta que nascem de uma AÇÃO ou do RELÓGIO, e não de um evento do Asaas:
 * COB-07 (cancelamento confirmado) e COB-06 (conta suspensa). Mesmo contrato dos gatilhos de cobrança
 * (`gatilhos-de-cobranca.ts`): quem chama já gravou o fato no banco; o gatilho só ENFILEIRA (`fila.ts`), com o
 * estado lido naquele instante, e o envio é do cron `enviar-emails-de-conta`. O aviso nunca desfaz nem atrasa o
 * fato, então tudo aqui engole a própria falha (log estruturado) e a idempotência é a chave de
 * `billing_emails_enviados`.
 *
 * ─── COB-07, cancelamento confirmado ────────────────────────────────────────
 *
 * Disparado por `cancelarAssinaturaDoCliente` (`lib/billing/asaas/compra.ts`) DEPOIS do cancelamento gravado
 * (assinatura removida no Asaas e `fn_billing_asaas_marcar_assinatura_encerrada` com sucesso, ou o pedido de
 * assinatura agendada cancelado). Chave `cancelamento:<id da organização>:<current_period_end>`: UM aviso por
 * organização por período. Cancelar de novo a mesma assinatura (o DELETE é idempotente) não manda outro, e assinar
 * e cancelar várias assinaturas no mesmo período também não (cada cancelamento escreveria ao cliente e ao operador,
 * então a chave não pode depender de algo que o cliente cria à vontade). Período novo, aviso novo.
 * "Acesso até" é o último dia do período pago (`current_period_end` é exclusivo). Botão: tela de assinar.
 *
 * Quem cancela: a mesma função serve ao cliente (`cancelarAssinatura`) e ao admin da plataforma
 * (`cancelarAssinaturaNoAsaas`). O texto do e-mail é neutro ("o plano foi cancelado e não haverá novas
 * cobranças"; não diz "você cancelou"), e o efeito para o cliente é o mesmo nos dois casos, então os dois
 * mandam. O operador recebe cópia em ambos (vê quando foi o suporte quem cancelou).
 *
 * ─── COB-06, conta suspensa ─────────────────────────────────────────────────
 *
 * Disparado por `conferirVencimentos` (`lib/billing/assinatura/conferir-vencimentos.ts`) quando a RPC leva o
 * contrato a `suspensa`. Chave `suspensao:<id do contrato>:<current_period_end>`: o mesmo período suspenso
 * avisa uma vez; quem regulariza, renova e suspende de novo num período novo recebe de novo.
 * Suspensão manual do admin da plataforma não passa por aqui (não é o relógio). Com cópia ao operador.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { ultimoDiaDoPeriodo } from "@/lib/billing/assinatura/estado-da-assinatura";
import { logger } from "@/lib/logger";

import { enfileirarEmailDeConta, type Enfileirador } from "./fila";

export interface DepsDosGatilhosDeConta {
  /** Injetável nos testes. O padrão é o enfileiramento real. */
  enfileirar?: Enfileirador;
}

interface LinhaDeContrato {
  id: string;
  plan_id: string;
  current_period_end: string | null;
}

async function lerContrato(admin: SupabaseClient, organizationId: string): Promise<LinhaDeContrato | null> {
  const { data, error } = await admin
    .from("billing_contracts")
    .select("id, plan_id, current_period_end")
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as LinhaDeContrato | null) ?? null;
}

async function nomeDoPlano(admin: SupabaseClient, planId: string): Promise<string | null> {
  const { data, error } = await admin.from("billing_plans").select("name").eq("id", planId).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as { name: string } | null)?.name ?? null;
}

function motivo(erro: unknown): string {
  return erro instanceof Error ? erro.message.slice(0, 120) : "erro";
}

/** O que `cancelarAssinaturaDoCliente` entrega ao aviso, depois do cancelamento gravado. */
export interface CancelamentoGravado {
  organizationId: string;
  /** O id da assinatura no Asaas que foi cancelada. Só informativo: a chave de idempotência é a organização + período. */
  asaasSubscriptionId: string;
}

export type AvisoDeCancelamento = (cancelamento: CancelamentoGravado) => Promise<void>;

export function criarAvisoDeCancelamentoSobre(
  admin: SupabaseClient,
  deps: DepsDosGatilhosDeConta = {},
): AvisoDeCancelamento {
  const enfileirar = deps.enfileirar ?? ((entrada) => enfileirarEmailDeConta(entrada, admin));
  return async ({ organizationId }) => {
    try {
      const contrato = await lerContrato(admin, organizationId);
      // Sem fim de período não há "acesso até" a dizer: melhor não mandar do que mandar uma data inventada.
      if (!contrato?.current_period_end) return;
      const plano = await nomeDoPlano(admin, contrato.plan_id);
      if (!plano) return;
      const acessoAte = ultimoDiaDoPeriodo(contrato.current_period_end).toISOString();

      await enfileirar({
        organizationId,
        emailId: "COB-07",
        chave: `cancelamento:${organizationId}:${contrato.current_period_end}`,
        destino: "admins",
        copiaParaOperador: true,
        dados: { plano, acessoAte },
      });
    } catch (erro) {
      logger.warn("[email-de-conta] o aviso de cancelamento falhou", {
        organization_id: organizationId,
        motivo: motivo(erro),
      });
    }
  };
}

export type AvisoDeSuspensao = (organizationId: string) => Promise<void>;

export function criarAvisoDeSuspensaoSobre(
  admin: SupabaseClient,
  deps: DepsDosGatilhosDeConta = {},
): AvisoDeSuspensao {
  const enfileirar = deps.enfileirar ?? ((entrada) => enfileirarEmailDeConta(entrada, admin));
  return async (organizationId) => {
    try {
      const contrato = await lerContrato(admin, organizationId);
      if (!contrato?.current_period_end) return;

      await enfileirar({
        organizationId,
        emailId: "COB-06",
        chave: `suspensao:${contrato.id}:${contrato.current_period_end}`,
        destino: "admins",
        copiaParaOperador: true,
        dados: {},
      });
    } catch (erro) {
      logger.warn("[email-de-conta] o aviso de conta suspensa falhou", {
        organization_id: organizationId,
        motivo: motivo(erro),
      });
    }
  };
}
