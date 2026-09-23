/**
 * GET/POST /api/v1/cron/conferir-contadores-de-plano: o conferidor diário
 * (fase F2, Tarefa 5).
 *
 * O contador de leads (`billing_usage_counters`, item 'leads') é
 * materializado pelos gatilhos da migration 0905 (decisão de desenho 7 e 11
 * da fase): eles somam e subtraem a cada transição de `status`, capturam
 * qualquer erro e nunca derrubam a operação do usuário. É exatamente essa
 * tolerância que pode deixar um contador desalinhado: um gatilho que
 * engoliu um erro, um `truncate` (que não dispara gatilho de linha nenhum,
 * ver "Para a F3" no `hiperbold/planos/fase-F2-tarefas.md`), uma corrida rara.
 *
 * Esta rota é a rede de segurança: chama `fn_billing_conferir_contadores()`
 * (só `service_role` executa), que por organização trava a linha do
 * contador, conta os leads abertos de verdade num comando seguinte e
 * corrige o que estiver errado. A regra inteira mora no banco e em
 * `lib/billing/planos/conferir-contadores.ts`; este arquivo só autentica,
 * chama e registra no log.
 *
 * Nesta fase a trava do plano só AVISA (a organização passa do teto, nasce
 * um item na Central, a operação segue): corrigir o contador aqui não é
 * mutação de negócio nenhuma, só faz o número voltar a bater. Por isso esta
 * rota não audita: divergência vira `log.warn`, e uma rodada sem
 * divergência nenhuma não deixa rastro, no mesmo espírito de
 * `data-retention` e `sync-model-catalog` (varredura sem efeito não é
 * mutação).
 *
 * Erro da função vira resposta de erro com FRASE FIXA: o texto que o
 * Postgres devolve só vai para o log, nunca para o corpo HTTP.
 *
 * Auth: mesmo contrato dos demais crons (Bearer INTERNAL_CRON_SECRET |
 * INTERNAL_SECRET, fail-closed, `lib/auth/cron-auth.ts`).
 *
 * NOTA DE DEPLOY: não há `vercel.json` neste repo (self-host). O
 * agendamento vive no serviço `scheduler` (docker/scheduler/entrypoint.sh),
 * 04:55, depois de `sync-model-catalog` (04:15) e `data-retention` (04:40).
 * A imagem `deskcomm-scheduler` precisa ser publicada de novo para o
 * agendamento valer em produção (registrado no status da fase).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { autorizaCron } from "@/lib/auth/cron-auth";
import {
  conferidorDeContadoresSobre,
  conferirContadoresDePlano,
} from "@/lib/billing/planos/conferir-contadores";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  let divergiam: number;
  try {
    const db = conferidorDeContadoresSobre(createAdminClient());
    divergiam = await conferirContadoresDePlano(db);
  } catch (err) {
    const detalhe = err instanceof Error ? err.message : String(err);
    // O texto do erro do banco fica só no log; a resposta HTTP não repete
    // detalhe de schema.
    logger.error("[conferir-contadores-de-plano] falhou", { error: detalhe, requestId });
    return fail("internal_error", "Falha ao conferir os contadores de uso.", 500, { requestId });
  }

  if (divergiam > 0) {
    logger.warn("[conferir-contadores-de-plano] contadores divergentes corrigidos", {
      divergiam,
      requestId,
    });
  } else {
    logger.info("[conferir-contadores-de-plano] nenhum contador divergia", { requestId });
  }

  return ok({ divergiam }, { requestId });
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}
