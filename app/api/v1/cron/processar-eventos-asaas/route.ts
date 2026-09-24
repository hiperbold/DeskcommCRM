/**
 * GET/POST /api/v1/cron/processar-eventos-asaas: o processador durável dos
 * eventos do webhook do Asaas (fase F5, Tarefa 13, decisões 3 e 20).
 *
 * `app/api/v1/webhooks/asaas/route.ts` (Tarefa 12) só GUARDA o evento; esta
 * rota é quem CONFIRMA e APLICA, uma vez por minuto (linha no scheduler,
 * `docker/scheduler/entrypoint.sh`): reserva até 50 eventos pendentes com
 * lease de 5 minutos, consulta o Asaas por `GET` só quando o pré-roteamento
 * (decisão 6/M8) manda, e aplica o objeto CONFIRMADO por
 * `fn_billing_asaas_aplicar_evento`. A REGRA inteira (reserva, pré-
 * roteamento, `GET`, aplicação, orçamento de tempo) mora em
 * `lib/billing/asaas/processar-eventos.ts`; este arquivo só autentica, monta
 * as dependências (banco, cliente Asaas, config) e registra o resumo no log.
 *
 * Sem `ASAAS_ENABLED` (o estado de toda instalação desta fase), o
 * processador não reserva nada e devolve contagem zero: os eventos
 * continuam guardados, `aguardando`, prontos para quando a chave for ligada.
 *
 * `configDoAsaas()` pode LANÇAR (`ASAAS_ENABLED=true` com base/chave
 * incoerentes, decisão 14 de `lib/billing/asaas/config.ts`): erro de
 * CONFIGURAÇÃO, não do chamador do cron. A resposta HTTP traz uma frase
 * fixa; o texto de dentro do erro fica só no log (mesmo padrão de
 * `conferir-vencimentos`, F4 Tarefa 5).
 *
 * Auth: mesmo contrato dos demais crons (Bearer INTERNAL_CRON_SECRET |
 * INTERNAL_SECRET, fail-closed, `lib/auth/cron-auth.ts`).
 *
 * NOTA DE DEPLOY: não há `vercel.json` neste repo (self-host). O
 * agendamento vive no serviço `scheduler` (docker/scheduler/entrypoint.sh),
 * `* * * * *` (todo minuto, decisão 20), timeout de 45s por chamada (o
 * orçamento interno do processador já para perto de 30s; a folga cobre o
 * tempo de rede da própria chamada HTTP do cron). A imagem
 * `deskcomm-scheduler` precisa ser publicada de novo para o agendamento
 * valer em produção.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { criarClienteAsaas } from "@/lib/billing/asaas/cliente";
import { configDoAsaas } from "@/lib/billing/asaas/config";
import {
  criarDbEventosAsaasSobre,
  processarEventosAsaas,
  type ResumoProcessarEventosAsaas,
} from "@/lib/billing/asaas/processar-eventos";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  let resumo: ResumoProcessarEventosAsaas;
  try {
    const config = configDoAsaas();
    const admin = createAdminClient();
    const db = criarDbEventosAsaasSobre(admin);
    const asaas = criarClienteAsaas({ fetch, config, logger });
    resumo = await processarEventosAsaas({ db, asaas, config, logger });
  } catch (err) {
    // O texto do erro (rede, banco, configuração) pode citar detalhe interno:
    // não é para o corpo da resposta HTTP, só para quem lê o log do servidor.
    const detalhe = err instanceof Error ? err.message : String(err);
    logger.error("[processar-eventos-asaas] falhou", { error: detalhe, requestId });
    return fail("internal_error", "Falha ao processar os eventos do Asaas.", 500, { requestId });
  }

  if (resumo.falhas > 0) {
    logger.warn("[processar-eventos-asaas] rodada com falha", { ...resumo, requestId });
  } else {
    logger.info("[processar-eventos-asaas] rodada concluída", { ...resumo, requestId });
  }

  return ok(resumo, { requestId });
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}
