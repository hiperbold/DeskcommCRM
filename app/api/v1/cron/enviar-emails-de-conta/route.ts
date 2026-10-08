/**
 * GET/POST /api/v1/cron/enviar-emails-de-conta: esvazia a fila dos e-mails de conta e de cobrança
 * (`billing_emails_enviados`, migration 0952).
 *
 * Os gatilhos (pagamento aplicado, cancelamento, suspensão, cadastro, renovação no cartão, tokens acabando) só
 * enfileiram, com os dados do momento do evento. Esta rota reserva um lote pequeno (20) pela
 * `fn_billing_emails_reservar_lote` (claim atômico), envia pelo SMTP ou pela Resend e grava o desfecho:
 * enviado, nova tentativa com espera crescente (1, 5, 15, 60 e 240 min; 6 tentativas), falhou ou sem
 * destinatário. Sem SMTP nem Resend configurados nada é reservado e nenhuma tentativa é gasta. A regra completa
 * está em `lib/email/conta-e-cobranca/enviar.ts`; este arquivo só autentica, chama e registra no log.
 *
 * Orçamento de tempo interno de 40 s (`ORCAMENTO_DA_RODADA_MS`) para o teto de 55 s do curl no scheduler: ao
 * estourar, o que ainda não começou volta à fila sem gastar tentativa.
 *
 * Erro ao reservar o lote vira resposta de erro com FRASE FIXA: o texto do Postgres só vai para o log, nunca
 * para o corpo HTTP. Nenhum endereço de e-mail aparece no log nem na resposta.
 *
 * Auth: mesmo contrato dos demais crons (Bearer INTERNAL_CRON_SECRET | INTERNAL_SECRET, fail-closed,
 * `lib/auth/cron-auth.ts`).
 *
 * NOTA DE DEPLOY: o agendamento vive no serviço `scheduler` (docker/scheduler/entrypoint.sh), a cada minuto. A
 * imagem `deskcomm-scheduler` precisa ser publicada de novo para o agendamento valer em produção.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { enviarFilaDeEmails, type ResumoDaFila } from "@/lib/email/conta-e-cobranca/enviar";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  let resumo: ResumoDaFila;
  try {
    resumo = await enviarFilaDeEmails();
  } catch (err) {
    const detalhe = err instanceof Error ? err.message : String(err);
    logger.error("[enviar-emails-de-conta] falhou", { error: detalhe, requestId });
    return fail("internal_error", "Falha ao enviar os e-mails de conta.", 500, { requestId });
  }

  if (resumo.repetir > 0 || resumo.falhados > 0) {
    logger.warn("[enviar-emails-de-conta] rodada com pendência", { ...resumo, requestId });
  } else if (resumo.reservados > 0) {
    logger.info("[enviar-emails-de-conta] rodada concluída", { ...resumo, requestId });
  }

  return ok(resumo, { requestId });
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}
