/**
 * GET/POST /api/v1/cron/avisar-renovacao: a régua de aviso de renovação do plano que não renova sozinho
 * (D-177, parte 2, migration 0946).
 *
 * O contrato pago parcelado ou no Pix, sem assinatura viva no Asaas, não é cobrado de novo no fim do
 * período. Esta rota avisa o dono e os admins da organização 30, 15, 7 e 1 dia antes do último dia de
 * acesso e no próprio último dia (e-mail e aviso na Central, com push), uma vez por marco e por período. A
 * régua para sozinha quando o cliente renova. A regra (quem entra, qual marco vale, o que revalidar) mora
 * no banco; a ordem das chamadas e o resultado de cada canal estão em
 * `lib/billing/assinatura/avisar-renovacao.ts`; este arquivo só autentica, chama e registra no log.
 *
 * Nunca lança por uma organização: a falha de uma entra na contagem e a rodada segue. Erro ao LISTAR vira
 * resposta de erro com FRASE FIXA: o texto do Postgres só vai para o log, nunca para o corpo HTTP.
 *
 * Auth: mesmo contrato dos demais crons (Bearer INTERNAL_CRON_SECRET | INTERNAL_SECRET, fail-closed,
 * `lib/auth/cron-auth.ts`).
 *
 * NOTA DE DEPLOY: o agendamento vive no serviço `scheduler` (docker/scheduler/entrypoint.sh), uma vez por
 * dia às 11:00 UTC, que são 08:00 em América/São_Paulo. A imagem `deskcomm-scheduler` precisa ser
 * publicada de novo para o agendamento valer em produção.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { avisarRenovacoes, type ResumoDaReguaDeRenovacao } from "@/lib/billing/assinatura/avisar-renovacao";
import { avisadorDeRenovacaoSobre, servicosDeRenovacaoSobre } from "@/lib/billing/assinatura/avisar-renovacao-real";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  let resumo: ResumoDaReguaDeRenovacao;
  try {
    const admin = createAdminClient();
    resumo = await avisarRenovacoes({
      db: avisadorDeRenovacaoSobre(admin),
      servicos: servicosDeRenovacaoSobre(admin),
    });
  } catch (err) {
    const detalhe = err instanceof Error ? err.message : String(err);
    logger.error("[avisar-renovacao] falhou", { error: detalhe, requestId });
    return fail("internal_error", "Falha ao avisar a renovação dos planos.", 500, { requestId });
  }

  const pendencia =
    resumo.organizacoesQueFalharam > 0 ||
    resumo.emailsQueFalharam > 0 ||
    resumo.avisosQueFalharam > 0 ||
    resumo.restantes > 0;
  if (pendencia) {
    logger.warn("[avisar-renovacao] rodada com pendência", { ...resumo, requestId });
  } else {
    logger.info("[avisar-renovacao] rodada concluída", { ...resumo, requestId });
  }

  return ok(resumo, { requestId });
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}
