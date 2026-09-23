/**
 * GET/POST /api/v1/cron/conferir-carteira-de-tokens: o conferidor diário da
 * carteira de tokens de IA (fase F2-B, Tarefa 8).
 *
 * A carteira debita pelo GATILHO `after insert` em `llm_calls` (decisão 11
 * da fase) e mantém o saldo materializado atualizado dentro da mesma
 * transação do livro-caixa (decisão 8). É exatamente essa dependência de
 * um gatilho que pode deixar a carteira desalinhada: a trava por
 * organização é `pg_try_advisory_xact_lock` SEM ESPERA (decisão 11), então
 * uma disputa faz o gatilho sair sem debitar, e o corpo inteiro do gatilho
 * está sob `exception when others` (nunca derruba o insert em `llm_calls`,
 * mas também nunca reexecuta sozinho).
 *
 * Esta rota é a rede de segurança, três peças (decisões 8, 12 e 15 da
 * fase): (a) recupera chamada que deveria ter debitado e não debitou
 * (`fn_billing_debitos_pendentes` + `fn_billing_debitar_chamada`, a mesma
 * peça de débito que o gatilho usa); (b) confere o saldo materializado
 * contra o livro-caixa (`fn_billing_conferir_carteira`) e corrige a
 * divergência; (c) confere o teto da instalação por dia
 * (`fn_billing_consumo_da_instalacao_no_dia`, decisão 15), NUNCA dentro do
 * gatilho: um total de todas as organizações serializaria toda escrita da
 * instalação. Só `service_role` executa as quatro RPCs. A regra de
 * iteração e a regra de banco moram em `lib/billing/tokens/conferir-
 * carteira.ts`; este arquivo só autentica, chama e registra no log.
 *
 * Nesta fase nada bloqueia (a trava de verdade é a F3): o conferidor mede,
 * corrige o que estiver visivelmente errado e avisa. Por isso esta rota não
 * audita: divergência vira `log.warn`/`log.error`, e uma rodada sem nada a
 * corrigir não deixa rastro, no mesmo espírito de `conferir-contadores-de-
 * plano` e `data-retention` (varredura sem efeito não é mutação).
 *
 * Erro da função de banco vira resposta de erro com FRASE FIXA: o texto que
 * o Postgres devolve só vai para o log, nunca para o corpo HTTP.
 *
 * Auth: mesmo contrato dos demais crons (Bearer INTERNAL_CRON_SECRET |
 * INTERNAL_SECRET, fail-closed, `lib/auth/cron-auth.ts`).
 *
 * NOTA DE DEPLOY: não há `vercel.json` neste repo (self-host). O
 * agendamento vive no serviço `scheduler` (docker/scheduler/entrypoint.sh),
 * 05:25, depois de `conferir-contadores-de-plano` (04:55). A imagem
 * `deskcomm-scheduler` precisa ser publicada de novo para o agendamento
 * valer em produção (registrado no débito, D-059).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { autorizaCron } from "@/lib/auth/cron-auth";
import {
  conferidorDeCarteiraSobre,
  conferirCarteiraDeTokens,
  type ResumoDoConferidorDeCarteira,
} from "@/lib/billing/tokens/conferir-carteira";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  let resumo: ResumoDoConferidorDeCarteira;
  try {
    const db = conferidorDeCarteiraSobre(createAdminClient());
    resumo = await conferirCarteiraDeTokens(db);
  } catch (err) {
    const detalhe = err instanceof Error ? err.message : String(err);
    // O texto do erro do banco fica só no log; a resposta HTTP não repete
    // detalhe de schema.
    logger.error("[conferir-carteira-de-tokens] falhou", { error: detalhe, requestId });
    return fail("internal_error", "Falha ao conferir a carteira de tokens de IA.", 500, {
      requestId,
    });
  }

  if (resumo.organizacoesQueFalharam > 0 || resumo.tetoDaInstalacaoPassou) {
    logger.warn("[conferir-carteira-de-tokens] rodada com pendência", { ...resumo, requestId });
  } else {
    logger.info("[conferir-carteira-de-tokens] rodada concluída", { ...resumo, requestId });
  }

  return ok(resumo, { requestId });
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}
