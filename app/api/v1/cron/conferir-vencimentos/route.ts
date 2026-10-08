/**
 * GET/POST /api/v1/cron/conferir-vencimentos: o conferidor diário do
 * vencimento da assinatura (fase F4, Tarefa 5).
 *
 * `billing_contracts.status` muda para `atrasada`/`suspensa`/`cancelada` por
 * duas vias: a mão do admin (`app/actions/admin/assinaturaDaOrganizacao.ts`,
 * mesma Tarefa) e o TEMPO passando (período vencido, carência vencida,
 * cancelamento agendado). Esta rota é a segunda via: chama
 * `fn_billing_conferir_vencimento(p_org)` (migração 0908, decisão 4) uma
 * organização por vez, na ordem fixa que a função já aplica (cancelamento
 * agendado antes do atraso, atraso antes da suspensão). Só `service_role`
 * executa a RPC. A regra de iteração e a regra de banco moram em
 * `lib/billing/assinatura/conferir-vencimentos.ts`; este arquivo só
 * autentica, chama e registra no log.
 *
 * Modo `avisar` (o de produção nesta fase, decisão 5 da fase): mover o
 * estado para `atrasada`/`suspensa`/`cancelada` aqui não bloqueia nada
 * sozinho (o bloqueio de verdade é a checagem separada da F3/F4, decisão 5 e
 * 6/7 da fase, que só age quando o modo é `bloquear`). Por isso esta rota
 * não audita: mudar de estado pelo relógio não é uma DECISÃO de negócio de
 * alguém, é o tempo passando, no mesmo espírito de `conferir-contadores-de-
 * plano` e `conferir-carteira-de-tokens` (varredura automática não é
 * mutação auditável); o rastro de "por que este estado mudou" já está na
 * própria linha de `billing_contracts` e no `log.info`/`log.warn` abaixo.
 *
 * Erro da função de banco vira resposta de erro com FRASE FIXA: o texto que
 * o Postgres devolve só vai para o log, nunca para o corpo HTTP.
 *
 * Auth: mesmo contrato dos demais crons (Bearer INTERNAL_CRON_SECRET |
 * INTERNAL_SECRET, fail-closed, `lib/auth/cron-auth.ts`).
 *
 * NOTA DE DEPLOY: não há `vercel.json` neste repo (self-host). O
 * agendamento vive no serviço `scheduler` (docker/scheduler/entrypoint.sh),
 * 05:40 UTC, depois de `conferir-contadores-de-plano` (04:55) e
 * `conferir-carteira-de-tokens` (05:25 UTC, até 90s de execução): 15 minutos
 * de folga depois do irmão mais lento, para as três rodadas diárias de
 * billing não disputarem a mesma janela de I/O no banco. A imagem
 * `deskcomm-scheduler` precisa ser publicada de novo para o agendamento
 * valer em produção.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { autorizaCron } from "@/lib/auth/cron-auth";
import {
  conferidorDeVencimentosSobre,
  conferirVencimentos,
  type ResumoDoConferidorDeVencimentos,
} from "@/lib/billing/assinatura/conferir-vencimentos";
import { criarAvisoDeSuspensaoSobre } from "@/lib/email/conta-e-cobranca/gatilhos-de-conta";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  let resumo: ResumoDoConferidorDeVencimentos;
  try {
    const admin = createAdminClient();
    const db = conferidorDeVencimentosSobre(admin);
    // COB-06: quem a rodada suspende recebe o aviso de conta suspensa (com cópia ao operador).
    resumo = await conferirVencimentos(db, { aoSuspender: criarAvisoDeSuspensaoSobre(admin) });
  } catch (err) {
    const detalhe = err instanceof Error ? err.message : String(err);
    // O texto do erro do banco fica só no log; a resposta HTTP não repete
    // detalhe de schema.
    logger.error("[conferir-vencimentos] falhou", { error: detalhe, requestId });
    return fail("internal_error", "Falha ao conferir o vencimento das assinaturas.", 500, {
      requestId,
    });
  }

  if (resumo.organizacoesQueFalharam > 0) {
    logger.warn("[conferir-vencimentos] rodada com pendência", { ...resumo, requestId });
  } else {
    logger.info("[conferir-vencimentos] rodada concluída", { ...resumo, requestId });
  }

  return ok(resumo, { requestId });
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}
