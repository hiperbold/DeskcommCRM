import { type NextRequest } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { exigeAcompanhamentoAtivo } from "@/lib/impersonate/leitura-com-suporte";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// GET /api/v1/admin/inbox/conversations/[id]
// ---------------------------------------------------------------------------

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const requestId = randomUUID();
  const { id } = await params;

  let adminCtx: Awaited<ReturnType<typeof requirePlatformAdmin>>;
  try {
    adminCtx = await requirePlatformAdmin();
  } catch {
    return fail("forbidden", "Platform admin required", 403, { requestId });
  }

  const admin = createAdminClient();

  // Só a organização do acompanhamento ativo (D-152). O filtro de organização
  // entra na própria busca: id de conversa de outra organização é "não achei",
  // sem confirmar que ele existe.
  const acompanhamento = await exigeAcompanhamentoAtivo(null, requestId);
  if (!acompanhamento.ok) return acompanhamento.response;
  const organizationId = acompanhamento.support.organization_id;

  const { data: conversation, error: convError } = await admin
    .from("conversations")
    .select(`
      id,
      organization_id,
      contact_id,
      channel,
      status,
      assigned_to_user_id,
      last_inbound_at,
      last_message_at,
      last_message_preview,
      unread_count_for_assignee,
      created_at,
      updated_at
    `)
    .eq("organization_id", organizationId)
    .eq("id", id)
    .maybeSingle();

  if (convError) {
    return fail("internal_error", "Query failed", 500, { requestId, details: convError.message });
  }
  if (!conversation) {
    return fail("not_found", "Conversation not found", 404, { requestId });
  }

  // Load organization
  const { data: organization } = await admin
    .from("organizations")
    .select("id, display_name, slug, status")
    .eq("id", organizationId)
    .maybeSingle();

  // Load contact
  const { data: contact } = conversation.contact_id
    ? await admin
        .from("contacts")
        .select("id, name, phone_number, email, is_anonymized, is_blocked")
        .eq("organization_id", organizationId)
        .eq("id", conversation.contact_id)
        .maybeSingle()
    : { data: null };
  // Contato anonimizado não devolve identificação nem pelo painel da plataforma.
  const contatoParaAdmin =
    contact && contact.is_anonymized
      ? { ...contact, name: null, phone_number: null, email: null }
      : contact;

  // Load last 50 messages (desc — client reverses for display)
  const { data: messages, error: msgError } = await admin
    .from("messages")
    .select(`
      id,
      conversation_id,
      organization_id,
      direction,
      type,
      status,
      body,
      media_url,
      media_mime,
      sent_via,
      sent_at,
      read_at,
      delivered_at,
      error_code,
      error_message,
      ack,
      sent_by_user_id,
      created_at
    `)
    .eq("organization_id", organizationId)
    .eq("conversation_id", id)
    .order("created_at", { ascending: false })
    .limit(50);

  if (msgError) {
    return fail("internal_error", "Messages query failed", 500, {
      requestId,
      details: msgError.message,
    });
  }

  // Audit — tenant_id only, no PII. Esperada antes da resposta (D-152).
  await audit({
    action: "platform_admin.conversation_viewed",
    actorUserId: adminCtx.user.id,
    actingAsPlatformAdmin: true,
    bypassedRls: true,
    requestId,
    organizationId,
    resourceType: "conversation",
    resourceId: id,
    metadata: { tenant_id: organizationId, support_session_id: acompanhamento.support.id },
  });

  return ok(
    {
      conversation,
      organization: organization ?? null,
      contact: contatoParaAdmin ?? null,
      messages: messages ?? [],
    },
    { requestId },
  );
}
