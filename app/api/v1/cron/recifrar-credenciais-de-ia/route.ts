/**
 * GET/POST /api/v1/cron/recifrar-credenciais-de-ia: leva as credenciais de IA do formato antigo para o novo
 * (D-168, parte 2).
 *
 * Cada rodada recifra um LOTE pequeno (25 por padrão; `?lote=` de 1 a 100) e devolve contagens:
 * `restantes` é quanto do formato antigo ainda falta. O recifrador é idempotente, não atropela uma rotação de
 * chave no meio e nunca lança por uma linha (ver `lib/ai/credenciais/recifrar.ts`). Erro ao LISTAR vira
 * resposta de erro com FRASE FIXA: o texto do banco só vai para o log, nunca para o corpo HTTP.
 *
 * ─── COMO E QUANDO RODAR EM PRODUÇÃO ─────────────────────────────────────────
 * 1. Publicar a imagem nova (a rota e o agendamento diário às 06:30 UTC vêm juntos).
 * 2. Esperar a rodada diária, ou chamar à mão até `restantes: 0` e `falhas: 0`:
 *      curl -fsS -X POST -H "Authorization: Bearer $INTERNAL_CRON_SECRET" \
 *        "https://<dominio>/api/v1/cron/recifrar-credenciais-de-ia?lote=100"
 *    `falhas` maior que zero é linha que não abre com a chave atual (cifrada com outra chave): resolver a
 *    chave ou pedir ao cliente para salvar de novo ANTES do passo 3.
 * 3. Só então ligar `AI_CRED_RECUSAR_LEGADO=1` no ambiente do app e dos workers e reiniciar. Daí em diante a
 *    credencial no formato antigo deixa de ser aceita. Ligado antes de zerar, a IA das organizações que
 *    sobraram para de responder. Desligar a variável volta ao comportamento anterior.
 * `recusaDoLegadoLigada` na resposta diz em que estado o ambiente que respondeu está.
 *
 * Auth: mesmo contrato dos demais crons (Bearer INTERNAL_CRON_SECRET | INTERNAL_SECRET, fail-closed,
 * `lib/auth/cron-auth.ts`). O agendamento vive no serviço `scheduler` (docker/scheduler/entrypoint.sh).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { recusaCredencialLegada } from "@/lib/ai/credenciais/cifra";
import {
  LOTE_PADRAO_DO_RECIFRADOR,
  recifrarCredenciaisLegadas,
  repositorioDeRecifraSobre,
} from "@/lib/ai/credenciais/recifrar";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const LOTE_MAXIMO = 100;

function loteDoPedido(req: NextRequest): number {
  const bruto = Number(req.nextUrl.searchParams.get("lote"));
  if (!Number.isInteger(bruto) || bruto < 1) return LOTE_PADRAO_DO_RECIFRADOR;
  return Math.min(bruto, LOTE_MAXIMO);
}

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  let resumo: Awaited<ReturnType<typeof recifrarCredenciaisLegadas>>;
  try {
    resumo = await recifrarCredenciaisLegadas({
      repo: repositorioDeRecifraSobre(createAdminClient()),
      lote: loteDoPedido(req),
    });
  } catch (err) {
    const detalhe = err instanceof Error ? err.message : String(err);
    logger.error("[recifrar-credenciais-de-ia] falhou", { error: detalhe, requestId });
    return fail("internal_error", "Falha ao recifrar as credenciais de IA.", 500, { requestId });
  }

  if (resumo.falhas > 0 || resumo.restantes > 0) {
    logger.warn("[recifrar-credenciais-de-ia] rodada com pendência", { ...resumo, requestId });
  } else {
    logger.info("[recifrar-credenciais-de-ia] rodada concluída", { ...resumo, requestId });
  }

  return ok({ ...resumo, recusaDoLegadoLigada: recusaCredencialLegada() }, { requestId });
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}
