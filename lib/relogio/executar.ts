import { recoverStuckMessages } from "@/app/api/v1/cron/recover-stuck-messages/route";
import { idsDoContatoEGemeos } from "@/lib/channels/contato-por-telefone";
import { drainEventLog } from "@/lib/event-log/drain";
import { ensureHandlersRegistered } from "@/lib/event-log/register-handlers";
import { createSupabaseFollowupGateDb } from "@/lib/followup/agent-followup-gate";
import { inboundEhDestaPergunta } from "@/lib/followup/aplicar-inbound";
import {
  aplicarRespostaInbound,
  createSupabaseAdminClient,
  runFollowupTick,
  type FollowupJobRequest,
  type TickDeps,
} from "@/lib/followup/engine";
import { encerrarRoteirosVencidos } from "@/lib/followup/atendimento";
import { enviarTextoFixoPendente } from "@/lib/followup/enviar-texto-fixo";
import type { EnrollmentRow } from "@/lib/followup/node-handlers";
import { createSupabaseSilenceSweepDb, runSilenceSweep } from "@/lib/followup/silence-sweep";
import { logger } from "@/lib/logger";
import { runRoutingWorker } from "@/lib/routing/worker";
import { createAdminClient } from "@/lib/supabase/admin";
import type { SupabaseClient } from "@supabase/supabase-js";
import { contaBloqueadaParaProduzir, motivoDeNaoProduzir } from "@/lib/billing/assinatura/pode-produzir";
import { encerrarEnrollmentPorAssinaturaSuspensa } from "@/lib/followup/encerrar-por-assinatura-suspensa";

export type ResultadoDeTarefa = {
  id: string;
  ok: boolean;
  detalhe?: string;
};

/**
 * Achado 1 da revisão (F4): o relógio HTTP tem o próprio `enqueueJob`, sem o
 * portão que o cron (`app/api/v1/cron/followup-flow-worker/route.ts`) já tem.
 * Mesmo portão aqui: organização em modo leitura não enfileira o turno, e o
 * enrollment é encerrado (`cancelled`/`assinatura_suspensa`), achado 3, em
 * vez de ficar esperando um turno que nunca chega.
 */
async function enfileirarFollowup(job: FollowupJobRequest): Promise<void> {
  const admin = createAdminClient();
  const motivoDoBloqueio = await motivoDeNaoProduzir(admin, job.organization_id);
  if (motivoDoBloqueio) {
    logger.info("[relogio] turno não enfileirado: organização não pode produzir", {
      motivo: motivoDoBloqueio,
      organization_id: job.organization_id,
      contact_id: job.contact_id,
      followup_enrollment_id: job.payload.followup_enrollment_id,
    });
    await encerrarEnrollmentPorAssinaturaSuspensa(
      admin,
      job.organization_id,
      job.payload.followup_enrollment_id,
      motivoDoBloqueio,
    );
    return;
  }
  const { error } = await admin.from("job_queue").insert({
    organization_id: job.organization_id,
    contact_id: job.contact_id,
    kind: "followup_turn",
    payload: job.payload,
  });
  if (error) throw new Error(error.message);
}

/**
 * O claim do worker só pega `next_eval_at <= agora`. `match_reply` estaciona
 * com 15 min de graça — o SIM do lead chega ANTES disso e o relógio passava
 * batido. Aqui lemos a última inbound (gêmeos de telefone inclusive) e
 * avançamos quem já respondeu.
 */
/** Tamanho da página e teto de linhas por tick do relógio HTTP (D-131). */
export const PAGINA_DE_AGUARDANDO_RESPOSTA = 200;
export const TETO_DE_AGUARDANDO_RESPOSTA = 2000;

/**
 * Todos os `waiting_reply`, em páginas por id (ordem estável). Antes lia só 40
 * sem ordem: com mais de 40 aguardando, os mesmos 40 podiam ocupar a janela e o
 * resto nunca era visto por este relógio. O teto evita um tick sem fim; passar
 * dele fica no log, e o worker do follow-up cobre o resto.
 */
export async function lerAguardandoResposta(admin: SupabaseClient): Promise<unknown[]> {
  const linhas: unknown[] = [];
  for (let de = 0; de < TETO_DE_AGUARDANDO_RESPOSTA; de += PAGINA_DE_AGUARDANDO_RESPOSTA) {
    const { data, error } = await admin
      .from("followup_enrollments")
      .select("*")
      .in("status", ["waiting_reply"])
      .order("id", { ascending: true })
      .range(de, de + PAGINA_DE_AGUARDANDO_RESPOSTA - 1);
    if (error) throw new Error(error.message);
    const pagina = data ?? [];
    linhas.push(...pagina);
    if (pagina.length < PAGINA_DE_AGUARDANDO_RESPOSTA) return linhas;
  }
  logger.warn("[relogio] mais aguardando resposta do que o teto por tick", {
    teto: TETO_DE_AGUARDANDO_RESPOSTA,
  });
  return linhas;
}

async function aplicarRespostasQueChegaram(admin: SupabaseClient, deps: TickDeps): Promise<number> {
  const aguardando = await lerAguardandoResposta(admin);
  let n = 0;
  for (const row of aguardando) {
    const enrollment = row as EnrollmentRow;
    const ids = await idsDoContatoEGemeos(admin, enrollment.organization_id, enrollment.contact_id);
    const { data: msg, error: msgErr } = await admin
      .from("messages")
      .select("body, sent_at")
      .eq("organization_id", enrollment.organization_id)
      .in("contact_id", ids)
      .eq("direction", "inbound")
      .order("sent_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (msgErr) throw new Error(msgErr.message);
    const texto = typeof msg?.body === "string" ? msg.body.trim() : "";
    if (!texto) continue;
    const enviada = typeof msg?.sent_at === "string" ? msg.sent_at : "";
    if (enviada && !inboundEhDestaPergunta(enviada, enrollment.updated_at)) continue;
    await aplicarRespostaInbound(deps, enrollment, texto);
    n++;
  }
  return n;
}

/**
 * Roda as tarefas de minuto neste processo — sem depender do contêiner
 * `scheduler` do compose nem de um cron da hospedagem.
 */
export async function executarTickDoRelogio(): Promise<{
  tarefas: ResultadoDeTarefa[];
  mexeu: boolean;
}> {
  const admin = createAdminClient();
  const tarefas: ResultadoDeTarefa[] = [];
  let mexeu = false;

  const uma = async (id: string, fn: () => Promise<unknown>): Promise<void> => {
    try {
      const r = await fn();
      tarefas.push({ id, ok: true, detalhe: r === undefined ? undefined : JSON.stringify(r).slice(0, 400) });
    } catch (err) {
      const detalhe = err instanceof Error ? err.message : String(err);
      logger.warn("[relogio] tarefa falhou", { id, error: detalhe });
      tarefas.push({ id, ok: false, detalhe });
    }
  };

  await uma("event-log-drain", async () => {
    ensureHandlersRegistered();
    const summary = await drainEventLog(admin);
    if (summary.done > 0 || summary.failed > 0 || summary.dead > 0) mexeu = true;
    return summary;
  });

  await uma("followup-flow-worker", async () => {
    const deps: TickDeps = {
      db: createSupabaseAdminClient(admin),
      clock: () => new Date(),
      enqueueJob: enfileirarFollowup,
    };
    const acordados = await aplicarRespostasQueChegaram(admin, deps);
    if (acordados > 0) {
      mexeu = true;
      // Sem esta linha o SIM que a ingestão do canal gravou e nenhum tick
      // processou some do radar — o sintoma é "Aguardando resposta" com
      // mensagem na inbox.
      logger.info("[relogio] follow-up avancou por resposta inbound", { acordados });
    }
    const summary = await runFollowupTick(deps);
    if (
      summary.claim_falhou ||
      summary.claimed ||
      summary.advanced ||
      summary.scheduled ||
      summary.failed ||
      summary.dead
    ) {
      mexeu = true;
    }
    try {
      const sweep = await runSilenceSweep({
        db: createSupabaseSilenceSweepDb(admin),
        gateDb: createSupabaseFollowupGateDb(admin),
        clock: () => new Date(),
        // Achado 1 da revisão (F4): faltava aqui, e só existia no cron
        // (app/api/v1/cron/followup-flow-worker/route.ts). Sem isto, o
        // relógio HTTP enrollava contato silencioso de organização suspensa.
        contaEmModoLeitura: (organizationId) => contaBloqueadaParaProduzir(admin, organizationId),
      });
      if (sweep.enrolled || sweep.pointers_gated_out || sweep.skipped_existing) mexeu = true;
    } catch (err) {
      logger.warn("[relogio] silence sweep falhou", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    try {
      const expirados = await encerrarRoteirosVencidos(admin);
      if (expirados > 0) {
        mexeu = true;
        logger.info("[relogio] roteiros de atendimento encerrados por prazo", { expirados });
      }
    } catch (err) {
      logger.warn("[relogio] prazo dos roteiros falhou", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    const enviados = await enviarTextoFixoPendente(admin);
    if (enviados > 0) mexeu = true;
    return summary;
  });

  await uma("routing-worker", async () => {
    const summary = await runRoutingWorker();
    return summary;
  });

  await uma("recover-stuck-messages", async () => {
    const summary = await recoverStuckMessages(admin, new Date(), "relogio");
    if (summary.failed > 0) mexeu = true;
    return summary;
  });

  return { tarefas, mexeu };
}
