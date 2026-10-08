/**
 * GET/POST /api/v1/cron/avisar-tokens-acabando: o aviso IA-02, "seus tokens de IA estão acabando" (80%) e
 * "acabaram" (100%).
 *
 * Quem detecta o cruzamento é o banco, no débito de cada chamada (`fn_billing_avisar_carteira`, migration 0906):
 * ela grava `limiar:<ciclo>:<80|100>` em `billing_token_avisos_emitidos`. Esta rota só LÊ essas linhas recentes
 * e ENFILEIRA o e-mail aos admins (o envio é do cron enviar-emails-de-conta), uma vez por nível por ciclo. Nada é
 * comparado no caminho quente das mensagens.
 * A regra completa está em `lib/email/conta-e-cobranca/tokens-acabando.ts`; este arquivo só autentica, chama e
 * registra no log.
 *
 * Erro ao LISTAR vira resposta de erro com FRASE FIXA: o texto do Postgres só vai para o log.
 *
 * Auth: mesmo contrato dos demais crons (Bearer INTERNAL_CRON_SECRET | INTERNAL_SECRET, fail-closed,
 * `lib/auth/cron-auth.ts`).
 *
 * NOTA DE DEPLOY: o agendamento vive no serviço `scheduler` (docker/scheduler/entrypoint.sh), a cada 15
 * minutos: o aviso de 100% é urgente (a franquia acabou) e a rodada vazia é uma consulta curta. A imagem
 * `deskcomm-scheduler` precisa ser publicada de novo para o agendamento valer em produção.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { avisarTokensAcabando, type ResumoDosTokensAcabando } from "@/lib/email/conta-e-cobranca/tokens-acabando";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  let resumo: ResumoDosTokensAcabando;
  try {
    resumo = await avisarTokensAcabando(createAdminClient());
  } catch (err) {
    const detalhe = err instanceof Error ? err.message : String(err);
    logger.error("[tokens-acabando] falhou", { error: detalhe, requestId });
    return fail("internal_error", "Falha ao avisar os tokens de IA acabando.", 500, { requestId });
  }

  if (resumo.falhas > 0) {
    logger.warn("[tokens-acabando] rodada com pendência", { ...resumo, requestId });
  } else if (resumo.enfileirados > 0) {
    logger.info("[tokens-acabando] rodada concluída", { ...resumo, requestId });
  }

  return ok(resumo, { requestId });
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}
