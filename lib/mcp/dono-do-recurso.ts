/**
 * De QUEM é um recurso apontado por id: devolve o `contact_id` dono (ou `null`
 * quando não existe nesta organização). Alimenta `aplicarEscopoDoTurno`.
 *
 * Uma consulta por recurso, sempre com `organization_id`: o id vem do modelo, e
 * o cliente do banco é admin (ignora RLS). Erro de leitura LANÇA: quem chama
 * traduz em "indisponível", nunca em "é de outro cliente".
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { TipoDeRecurso } from "./escopo-do-turno";

const TABELA_COM_CONTATO: Record<"conversa" | "negocio" | "compromisso" | "retorno", string> = {
  conversa: "conversations",
  negocio: "crm_leads",
  compromisso: "calendar_appointments",
  retorno: "cron_jobs",
};

export async function donoDoRecurso(
  supabase: SupabaseClient,
  organizationId: string,
  tipo: Exclude<TipoDeRecurso, "contato">,
  id: string,
): Promise<string | null> {
  if (tipo === "caso") {
    // O caso não guarda o contato: ele é da conversa que o abriu.
    const { data, error } = await supabase
      .from("agent_cases")
      .select("conversation_id")
      .eq("organization_id", organizationId)
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const conversationId = (data as { conversation_id: string | null } | null)?.conversation_id;
    if (!conversationId) return null;
    return donoDoRecurso(supabase, organizationId, "conversa", conversationId);
  }

  const { data, error } = await supabase
    .from(TABELA_COM_CONTATO[tipo])
    .select("contact_id")
    .eq("organization_id", organizationId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as { contact_id: string | null } | null)?.contact_id ?? null;
}
