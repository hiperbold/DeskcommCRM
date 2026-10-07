import type { EventHandler } from "@/lib/event-log/dispatcher";
import { createAdminClient } from "@/lib/supabase/admin";
import { motivoDeNaoProduzir } from "@/lib/billing/assinatura/pode-produzir";

export const followupGatilhoPresencaHandler: EventHandler = {
  key: "followup-gatilho-presenca.v1",
  events: ["appointment.outcome_confirmed"],
  async handle(row) {
    const admin = createAdminClient();
    // D-091: a recuperação de presença matricula follow-up; organização suspensa ou com a cobrança
    // em modo leitura não produz mensagem sozinha (mesmo portão dos outros gatilhos).
    const motivo = await motivoDeNaoProduzir(admin, row.organization_id);
    if (motivo) return { consumer_key: this.key, status: "skipped", detail: motivo };
    const { data, error } = await admin.rpc("fn_appointment_recover", {
      p_org: row.organization_id,
      p_event: row.id,
    });
    return {
      consumer_key: this.key,
      status: error ? "error" : "ok",
      detail: error ? `Recuperação indisponível: ${error.message}` : String(data?.result),
    };
  },
};
