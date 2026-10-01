/**
 * "Só os meus" também vale para a chave de API (D-148).
 *
 * A visibilidade por atendente (`organizations.settings.visibility_mode`) vive na
 * RLS, e a RLS só enxerga sessão de pessoa. O caminho do token (REST dual e MCP)
 * roda com o cliente admin: uma chave `role:agent` lia e escrevia negócio e
 * conversa de qualquer atendente, mesmo numa empresa que escolheu "só os meus".
 *
 * Regra, a mais conservadora que não quebra integração em empresa que nunca
 * mexeu na configuração: só o modo explícito `own` restringe, e restringe o
 * token de papel abaixo de gerente nas capacidades com dono (negócio, conversa,
 * mensagem, atendimento, retorno). Uma chave não é uma pessoa e não tem "os meus";
 * para operar nesse modo ela precisa de `role:manager` ou superior, que é o
 * mesmo degrau que a RLS dá à visão da empresa inteira.
 *
 * Os dois modos mais soltos (`all` e `own_and_unassigned`, o padrão) ficam como
 * estavam: decisão de produto registrada no relatório (restringir o padrão
 * quebraria toda integração que atualiza negócio de atendente).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { McpAuthError } from "@/lib/mcp/auth";
import type { Role } from "@/lib/auth/types";
import { ROLE_RANK } from "@/lib/auth/types";

/**
 * Capacidades MCP que leem ou escrevem dado com DONO (negócio, conversa,
 * mensagem, caso de atendimento, retorno). Toda ferramenta do catálogo precisa
 * estar nesta lista OU em `FERRAMENTAS_SEM_DONO`: o teste
 * `tests/unit/visibilidade-do-token-modo-own.test.ts` reprova a ferramenta nova
 * que ninguém classificou.
 */
export const FERRAMENTAS_COM_DONO: ReadonlySet<string> = new Set([
  "crm_list_conversations",
  "crm_get_conversation",
  "crm_get_conversation_history",
  "crm_create_conversation_draft",
  "crm_assign_conversation",
  "crm_manage_tags",
  "crm_get_queue_status",
  "crm_request_human_handoff",
  "crm_list_leads",
  "crm_get_lead",
  "crm_create_lead",
  "crm_update_lead",
  "crm_move_lead_stage",
  "crm_retomar_lead",
  "crm_send_whatsapp_message",
  "crm_start_conversation_and_send",
  "crm_list_at_risk_leads",
  "crm_get_pipeline_forecast",
  "crm_list_human_cases",
  "crm_get_human_case",
  "crm_add_case_note",
  "crm_close_human_case",
  "crm_resume_ai_attendance",
  "crm_close_demand",
  "crm_schedule_followup",
  "crm_cancel_followup",
  "crm_list_followups",
  "crm_enroll_followup_flow",
  "crm_propose_reactivation",
]);

/** Capacidades sem dono por atendente: catálogo, agenda, conhecimento, configuração. */
export const FERRAMENTAS_SEM_DONO: ReadonlySet<string> = new Set([
  "crm_list_event_types",
  "crm_find_free_slots",
  "crm_list_appointments",
  "crm_book_appointment",
  "crm_find_and_book_appointment",
  "crm_reschedule_appointment",
  "crm_cancel_appointment",
  "crm_confirm_appointment",
  "crm_set_appointment_outcome",
  "crm_list_contact_orders",
  "crm_search_products",
  "crm_search_contacts",
  "crm_get_contact",
  "crm_propose_contact_field",
  "crm_describe_external_data",
  "crm_query_external_data",
  "crm_list_available_attendants",
  "crm_search_knowledge",
  "crm_list_knowledge_sources",
  "crm_list_improvement_proposals",
  "crm_get_org_memory",
  "crm_save_org_memory",
  "crm_list_stages",
  "crm_create_stage",
  "crm_update_stage",
  "crm_archive_stage",
  "crm_list_tags",
  "crm_list_message_templates",
  "crm_render_message_template",
  "crm_list_webhook_sources",
  "crm_list_webhook_source_events",
  "crm_create_webhook_source",
  "crm_set_webhook_source_active",
  "crm_list_automation_rules",
  "crm_list_automation_runs",
  "crm_set_automation_rule_active",
  "crm_list_team_members",
  "crm_list_pipelines",
  "crm_list_privacy_requests",
]);

const MENSAGEM =
  "This organization restricts each attendant to their own records (own visibility): this token needs role:manager or higher to use this capability.";

/**
 * Recusa (403) o token de papel abaixo de gerente quando a organização está em
 * visibilidade `own`. Falha de leitura da configuração recusa também: decisão de
 * acesso não trata leitura que não aconteceu como "pode".
 */
export async function exigirVisibilidadeDoToken(
  supabase: SupabaseClient,
  organizationId: string,
  role: Role,
): Promise<void> {
  if (ROLE_RANK[role] >= ROLE_RANK.manager) return;
  const { data, error } = await supabase
    .from("organizations")
    .select("settings")
    .eq("id", organizationId)
    .maybeSingle();
  if (error) {
    throw new McpAuthError(-32603, 500, "Could not read the organization visibility setting.");
  }
  const modo = (data?.settings as { visibility_mode?: unknown } | null | undefined)?.visibility_mode;
  if (modo === "own") throw new McpAuthError(-32002, 403, MENSAGEM);
}
