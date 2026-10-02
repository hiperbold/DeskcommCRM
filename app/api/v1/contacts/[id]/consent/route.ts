/**
 * POST /api/v1/contacts/{id}/consent: registra um consentimento ou uma recusa.
 *
 * É a única porta HTTP que escreve `contacts.consent` (D-151). O PATCH genérico
 * do contato deixou de aceitar o campo: um agente ou token `mcp:write` que
 * mandasse `{"consent":{"marketing":{}}}` trocava a entrada de marketing e
 * apagava a recusa (`declined_at`), e a guarda de automação e a de prospecção
 * voltavam a liberar o envio.
 *
 * Aqui só se REGISTRA: a recusa nunca é desfeita (dar consentimento a uma
 * finalidade já recusada é 409), recusar de novo mantém a data da primeira. O
 * piso é `manager`, e toda chamada fica na auditoria com a finalidade, a ação e
 * a origem declarada.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ApiError } from "@/lib/api/types";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import {
  FINALIDADES_DE_CONSENTIMENTO,
  registrarConsentimento,
} from "@/lib/contacts/consentimento";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { validateRequest } from "@/lib/schemas";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

const registroSchema = z.object({
  finalidade: z.enum(FINALIDADES_DE_CONSENTIMENTO),
  acao: z.enum(["grant", "decline"]),
  /** De onde veio a manifestação do titular: vai para `consent.<finalidade>.source`. */
  origem: z.string().trim().min(3).max(200),
});

export async function POST(req: NextRequest, ctx: Context): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;

  const authz = await requireRole("manager", { requestId, resource: "contacts" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;

  if (!z.uuid().safeParse(id).success) {
    return fail("validation_failed", t("Contato inválido."), 422, { requestId });
  }

  let input;
  try {
    input = await validateRequest(registroSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  const supabase = await createClient();
  const { data: contato, error: selErr } = await supabase
    .from("contacts")
    .select("id, is_anonymized, consent, updated_at")
    .eq("organization_id", orgId)
    .eq("id", id)
    .maybeSingle();
  if (selErr) return fail("internal_error", t("Não foi possível ler o contato."), 500, { requestId });
  if (!contato) return fail("not_found", t("Contato não encontrado."), 404, { requestId });
  if (contato.is_anonymized) {
    return fail(
      "lgpd_anonymization_irreversible",
      t("Contato anonimizado — edição bloqueada (LGPD)."),
      403,
      { requestId },
    );
  }

  const agora = new Date().toISOString();
  const registro = registrarConsentimento(contato.consent, input, agora);
  if (!registro.ok) {
    return fail(
      "consent_decline_registered",
      t("Este contato recusou essa finalidade. A recusa registrada não é desfeita por aqui."),
      409,
      { requestId },
    );
  }

  // Trava otimista: duas gravações simultâneas leriam o mesmo `consent` e a
  // segunda apagaria a finalidade que a primeira acabou de registrar.
  const { data: gravado, error: updErr } = await supabase
    .from("contacts")
    .update({ consent: registro.consent, updated_at: agora })
    .eq("organization_id", orgId)
    .eq("id", id)
    .eq("updated_at", contato.updated_at)
    .select("id")
    .maybeSingle();
  if (updErr) {
    return fail("internal_error", t("Não foi possível registrar o consentimento."), 500, { requestId });
  }
  if (!gravado) {
    return fail(
      "state_conflict",
      t("O contato mudou enquanto você registrava. Recarregue e tente de novo."),
      409,
      { requestId },
    );
  }

  await audit({
    action: "contact.consent_registered",
    actorUserId: authz.user.id,
    organizationId: orgId,
    resourceType: "contact",
    resourceId: id,
    requestId,
    metadata: {
      contact_id: id,
      finalidade: input.finalidade,
      acao: input.acao,
      origem: input.origem,
    },
  });

  return ok({ contact_id: id, finalidade: input.finalidade, entrada: registro.entrada }, { requestId });
}
