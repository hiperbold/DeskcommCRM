/**
 * GET /api/v1/cron/pareamento-qr-limpeza
 *
 * Limpa os pareamentos por QR Code que ficaram pendentes há mais de 30 minutos:
 * se o número conectou no meio tempo (o cliente leu o QR e fechou a aba), a
 * conexão é concluída; senão a instância é apagada no servidor e a sessão
 * arquivada. Sem esta rodada, o cliente que desistiu deixaria um WhatsApp parado
 * no servidor e uma vaga do plano ocupada até voltar à tela.
 *
 * Varre todas as organizações, um lote por chamada, cada pendência isolada das
 * outras. Barata: sem pendência, é uma consulta curta.
 *
 * Auth: Bearer INTERNAL_CRON_SECRET|INTERNAL_SECRET (fail-closed), como os demais.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, falhaInterna, ok } from "@/lib/api/wrappers";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { limparPareamentosQrVencidos } from "@/lib/channels/pareamento-qr";
import { urlDoWebhookDeCanal } from "@/lib/channels/url-do-webhook";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  try {
    const r = await limparPareamentosQrVencidos(createAdminClient(), {
      urlDoWebhook: urlDoWebhookDeCanal(),
    });
    return ok(r, { requestId });
  } catch (erro) {
    logger.error("[pareamento-qr-limpeza] a rodada falhou", {
      requestId,
      detail: erro instanceof Error ? erro.message : "erro",
    });
    return falhaInterna("internal_error", erro, { requestId });
  }
}

export const GET = handle;
export const POST = handle;
