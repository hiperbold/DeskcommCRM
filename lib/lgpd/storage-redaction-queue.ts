/**
 * Storage redaction queue — drains `storage_redaction_queue` rows enqueued by
 * the cascade RPC and removes the underlying objects from Supabase Storage.
 *
 * Idempotent: rows are claimed by status transition pending → processing
 * (we set processed_at + attempts++) and finalized to deleted | failed |
 * skipped. Re-runs ignore terminal rows.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { logger } from "@/lib/logger";
import { isMediaPathOfOrg } from "@/lib/messaging/media/upload-validation";

export interface DrainStats {
  attempted: number;
  deleted: number;
  failed: number;
  skipped: number;
}

interface QueueRow {
  id: string;
  organization_id: string;
  bucket: string;
  object_path: string;
  attempts: number;
}

/**
 * Buckets que a fila pode esvaziar. Fechada de propósito (D-099): a linha tem
 * `bucket` e `object_path` livres, e o cron apaga com a chave de serviço. Todo
 * enfileirador legítimo (cascata de LGPD, poda de mídia, foto de perfil) mexe só em
 * `whatsapp-media`, sob `{organization_id}/`.
 */
const BUCKETS_PERMITIDOS = new Set(["whatsapp-media"]);

const MAX_ATTEMPTS = 3;
const DEFAULT_BATCH = 50;

/**
 * Pull up to `limit` pending rows and process them sequentially.
 *
 * Caller responsibility: throttle invocation via cron. The function returns
 * after one batch — repeat invocation drains the rest.
 */
export async function drainStorageRedactionQueue(
  opts: { limit?: number } = {},
): Promise<DrainStats> {
  const admin = createAdminClient();
  const limit = opts.limit ?? DEFAULT_BATCH;

  const stats: DrainStats = { attempted: 0, deleted: 0, failed: 0, skipped: 0 };

  const { data: rows, error } = await admin
    .from("storage_redaction_queue")
    .select("id, organization_id, bucket, object_path, attempts")
    .eq("status", "pending")
    .order("enqueued_at", { ascending: true })
    .limit(limit);

  if (error) {
    logger.error("[lgpd-redact-worker] queue select failed", {
      error_message: error.message,
    });
    return stats;
  }

  const queueRows = (rows ?? []) as QueueRow[];

  for (const row of queueRows) {
    stats.attempted++;
    const nextAttempts = row.attempts + 1;

    // D-099: só apaga o que é da organização que pediu, num bucket da lista.
    // A linha pode ter sido escrita por um membro (a tabela já foi gravável pelo
    // PostgREST) apontando para a logo da instalação ou o arquivo de outra empresa.
    // Terminal: não adianta tentar de novo.
    if (!BUCKETS_PERMITIDOS.has(row.bucket) || !isMediaPathOfOrg(row.object_path, row.organization_id)) {
      await admin
        .from("storage_redaction_queue")
        .update({
          status: "skipped",
          attempts: nextAttempts,
          processed_at: new Date().toISOString(),
          error_message: "fora_do_escopo_da_organizacao",
        })
        .eq("id", row.id);
      stats.skipped++;
      logger.warn("[lgpd-redact-worker] linha fora do escopo da organização, não apagada", {
        queue_id: row.id,
        organization_id: row.organization_id,
        bucket: row.bucket,
      });
      continue;
    }

    try {
      const { error: removeErr } = await admin.storage
        .from(row.bucket)
        .remove([row.object_path]);

      if (removeErr) {
        // Treat "not found" as deleted (idempotent / object already gone).
        const msg = removeErr.message ?? "";
        const notFound = /not\s+found|not_found|no such/i.test(msg);
        if (notFound) {
          await admin
            .from("storage_redaction_queue")
            .update({
              status: "skipped",
              attempts: nextAttempts,
              processed_at: new Date().toISOString(),
              error_message: "object_not_found",
            })
            .eq("id", row.id);
          stats.skipped++;
          continue;
        }
        throw new Error(msg || "storage_remove_failed");
      }

      await admin
        .from("storage_redaction_queue")
        .update({
          status: "deleted",
          attempts: nextAttempts,
          processed_at: new Date().toISOString(),
          error_message: null,
        })
        .eq("id", row.id);
      stats.deleted++;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const terminal = nextAttempts >= MAX_ATTEMPTS;
      await admin
        .from("storage_redaction_queue")
        .update({
          status: terminal ? "failed" : "pending",
          attempts: nextAttempts,
          processed_at: terminal ? new Date().toISOString() : null,
          error_message: detail.slice(0, 500),
        })
        .eq("id", row.id);
      if (terminal) stats.failed++;
      logger.warn("[lgpd-redact-worker] media remove failed", {
        queue_id: row.id,
        organization_id: row.organization_id,
        attempts: nextAttempts,
        terminal,
      });
    }
  }

  return stats;
}
