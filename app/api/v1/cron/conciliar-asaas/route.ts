/**
 * GET/POST /api/v1/cron/conciliar-asaas: a conciliação diária do Asaas (fase
 * F5, Tarefa 16, decisão 21).
 *
 * O webhook (Tarefa 12) e o processador (Tarefa 13) cobrem o caminho feliz.
 * Esta rota é a REDE DE SEGURANÇA para o que escapou dele: pedido
 * `aguardando_pagamento`/`inconclusivo` sem evento aplicado, pedido
 * `processando` travado, assinatura removida no Asaas sem o webhook ter
 * chegado, cobrança `vencida` cuja remoção falhou antes. A REGRA inteira
 * (as cinco etapas, o teto de 200 GET, os alarmes) mora em
 * `lib/billing/asaas/conciliar.ts`; este arquivo só autentica, monta as
 * dependências (banco, cliente Asaas, config) e registra o resumo no log.
 *
 * Sem `ASAAS_ENABLED` (o estado de toda instalação desta fase), a
 * conciliação não toca banco nem rede e devolve contagem zero.
 *
 * `configDoAsaas()` pode LANÇAR (`ASAAS_ENABLED=true` com base/chave
 * incoerentes, decisão 14): erro de CONFIGURAÇÃO, não do chamador do cron. A
 * resposta HTTP traz uma frase fixa; o texto de dentro do erro fica só no
 * log (mesmo padrão de `conferir-vencimentos` e `processar-eventos-asaas`).
 *
 * Auth: mesmo contrato dos demais crons (Bearer INTERNAL_CRON_SECRET |
 * INTERNAL_SECRET, fail-closed, `lib/auth/cron-auth.ts`).
 *
 * NOTA DE DEPLOY: não há `vercel.json` neste repo (self-host). O
 * agendamento vive no serviço `scheduler` (docker/scheduler/entrypoint.sh),
 * 04:30 UTC (decisão 21: "antes do conferidor às 05:40"), timeout de 120s. A
 * imagem `deskcomm-scheduler` precisa ser publicada de novo para o
 * agendamento valer em produção.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { criarClienteAsaas } from "@/lib/billing/asaas/cliente";
import { conciliarAsaas, criarDbConciliarAsaasSobre, type ResumoConciliarAsaas } from "@/lib/billing/asaas/conciliar";
import { configDoAsaas } from "@/lib/billing/asaas/config";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  let resumo: ResumoConciliarAsaas;
  try {
    const config = configDoAsaas();
    const admin = createAdminClient();
    const db = criarDbConciliarAsaasSobre(admin);
    const asaas = criarClienteAsaas({ fetch, config, logger });
    resumo = await conciliarAsaas({ db, asaas, config, logger });
  } catch (err) {
    // O texto do erro (rede, banco, configuração) pode citar detalhe interno:
    // não é para o corpo da resposta HTTP, só para quem lê o log do servidor.
    const detalhe = err instanceof Error ? err.message : String(err);
    logger.error("[conciliar-asaas] falhou", { error: detalhe, requestId });
    return fail("internal_error", "Falha ao conciliar as cobranças do Asaas.", 500, { requestId });
  }

  if (resumo.falhas > 0 || resumo.webhookInterrompido) {
    logger.warn("[conciliar-asaas] rodada com pendência", { ...resumo, requestId });
  } else {
    logger.info("[conciliar-asaas] rodada concluída", { ...resumo, requestId });
  }

  return ok(resumo, { requestId });
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}
