import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

/**
 * Fase F4, achado 3 (revisão dos produtores): encerra um enrollment de
 * follow-up direto, por causa da conta suspensa, em vez do `return` silencioso
 * que os quatro portões de modo leitura faziam antes (cron, relógio, dreno de
 * texto fixo e o consumidor do job `followup_turn`).
 *
 * O `return` silencioso deixava o enrollment "esperando" um turno que nunca
 * seria enfileirado de novo. Depois de `MAX_ACTION_RECHECKS`
 * (`lib/followup/node-handlers.ts`) o dead-man do motor marcava o enrollment
 * como `dead` sozinho, com um motivo falso (`action_turn_never_completed`) e
 * abria um aviso `followup_dead` na Central, um por enrollment: um alarme
 * falso, porque o worker estava vivo e o motivo real era a assinatura.
 *
 * `cancelled`/`assinatura_suspensa` já existe no vocabulário do CHECK de
 * `followup_enrollments` (`supabase/baseline.sql`); nenhuma migração nova.
 * Compare-and-set: só mexe em quem ainda está num estado não terminal, então
 * dois portões concorrentes (por exemplo o cron e o consumidor, no mesmo
 * enrollment) não se pisam.
 */
export const MOTIVO_ASSINATURA_SUSPENSA = "assinatura_suspensa";

const STATUS_TERMINAIS = "(completed,cancelled,dead)";

export async function encerrarEnrollmentPorAssinaturaSuspensa(
  admin: SupabaseClient,
  organizationId: string,
  enrollmentId: string,
  /** M1: organização suspensa/arquivada encerra com `organizacao_inativa`; o padrão é a cobrança. */
  motivo: string = MOTIVO_ASSINATURA_SUSPENSA,
): Promise<void> {
  const { error } = await admin
    .from("followup_enrollments")
    .update({
      status: "cancelled",
      cancel_reason: motivo,
      next_eval_at: null,
      claimed_until: null,
      completed_at: new Date().toISOString(),
    })
    .eq("organization_id", organizationId)
    .eq("id", enrollmentId)
    .not("status", "in", STATUS_TERMINAIS);
  if (error) {
    logger.error("[followup] encerrar por assinatura suspensa falhou", {
      organization_id: organizationId,
      enrollment_id: enrollmentId,
      error: error.message,
    });
  }
}
