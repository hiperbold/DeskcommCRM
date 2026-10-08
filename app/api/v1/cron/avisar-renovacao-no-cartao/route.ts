/**
 * GET/POST /api/v1/cron/avisar-renovacao-no-cartao: o aviso COB-04, "seu plano renova no cartão em N dias".
 *
 * O espelho da régua `avisar-renovacao` (que avisa quem NÃO renova sozinho): aqui entra quem tem assinatura
 * viva no Asaas, cobrada no cartão. Sai uma vez por cobrança, de 1 a 3 dias antes da data. A regra (quem entra,
 * a data da cobrança, o valor e a chave de idempotência) está em
 * `lib/email/conta-e-cobranca/renovacao-no-cartao.ts`; este arquivo só autentica, chama e registra no log.
 *
 * Nunca lança por um contrato. Erro ao LISTAR vira resposta de erro com FRASE FIXA: o texto do Postgres só vai
 * para o log, nunca para o corpo HTTP.
 *
 * Auth: mesmo contrato dos demais crons (Bearer INTERNAL_CRON_SECRET | INTERNAL_SECRET, fail-closed,
 * `lib/auth/cron-auth.ts`).
 *
 * NOTA DE DEPLOY: o agendamento vive no serviço `scheduler` (docker/scheduler/entrypoint.sh), uma vez por dia
 * às 11:05 UTC (08:05 em América/São_Paulo), logo depois da régua `avisar-renovacao`. A imagem
 * `deskcomm-scheduler` precisa ser publicada de novo para o agendamento valer em produção.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { autorizaCron } from "@/lib/auth/cron-auth";
import {
  avisarRenovacoesNoCartao,
  type ResumoDaRenovacaoNoCartao,
} from "@/lib/email/conta-e-cobranca/renovacao-no-cartao";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  let resumo: ResumoDaRenovacaoNoCartao;
  try {
    resumo = await avisarRenovacoesNoCartao(createAdminClient());
  } catch (err) {
    const detalhe = err instanceof Error ? err.message : String(err);
    logger.error("[renovacao-no-cartao] falhou", { error: detalhe, requestId });
    return fail("internal_error", "Falha ao avisar a renovação no cartão.", 500, { requestId });
  }

  if (resumo.falhas > 0 || resumo.restantes > 0) {
    logger.warn("[renovacao-no-cartao] rodada com pendência", { ...resumo, requestId });
  } else {
    logger.info("[renovacao-no-cartao] rodada concluída", { ...resumo, requestId });
  }

  return ok(resumo, { requestId });
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}
