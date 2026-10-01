import webpush from "web-push";

import { createAdminClient } from "@/lib/supabase/admin";
import { logger } from "@/lib/logger";
import { env } from "@/lib/env";
import { endpointDePushPermitido } from "./endpoint-de-push";
import { vapidPronto, vapidPublica, vapidSubject } from "./vapid";
import type { PushPayload } from "./push_payload";

export type PushSubRow = {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

type Linha = Record<string, unknown>;

type AdminLike = {
  from: (table: string) => {
    select: (cols: string) => {
      eq: (col: string, val: string) => Promise<{ data: Linha[] | null; error: { message: string } | null }>;
    };
    delete: () => {
      eq: (col: string, val: string) => Promise<{ error: { message: string } | null }>;
    };
  };
};

/**
 * Quem pode receber. A inscrição é só um endereço de entrega: o direito de ver o
 * conteúdo vem do vínculo ATIVO com a organização e do papel, e o envio roda com a
 * chave de serviço, que ignora a RLS (D-097).
 */
export type DestinatariosDoPush = {
  /** Só este usuário (aviso pessoal: menção, negócio atribuído). */
  userId?: string;
  /**
   * A conversa a que o push se refere, para respeitar quem pode vê-la. Sem isto o
   * push só exige vínculo ativo (avisos da Central não são de uma conversa).
   */
  conversa?: { assignedToUserId: string | null; modoDeVisibilidade: string | null };
};

/** Mesma regra de `fn_can_view_conversation`: só o papel `agent` é restrito. */
export function papelPodeVerConversa(
  papel: string,
  userId: string,
  conversa: { assignedToUserId: string | null; modoDeVisibilidade: string | null },
): boolean {
  if (papel === "viewer" || papel === "manager" || papel === "admin") return true;
  if (papel !== "agent") return false;
  if (conversa.assignedToUserId === userId) return true;
  switch (conversa.modoDeVisibilidade ?? "own_and_unassigned") {
    case "all":
      return true;
    case "own_and_unassigned":
      return conversa.assignedToUserId === null;
    default:
      return false;
  }
}

function store(admin: AdminLike) {
  return admin.from("push_subscriptions");
}

export async function enviarPushDaOrg(
  organizationId: string,
  payload: PushPayload,
  admin: AdminLike = createAdminClient() as unknown as AdminLike,
  destinatarios: DestinatariosDoPush = {},
): Promise<{ sent: number; gone: number }> {
  if (!vapidPronto()) return { sent: 0, gone: 0 };

  const { data, error } = await store(admin)
    .select("id, user_id, endpoint, p256dh, auth")
    .eq("organization_id", organizationId);
  if (error) {
    logger.warn("push_subscriptions_list_failed", { detail: error.message });
    return { sent: 0, gone: 0 };
  }
  let rows = ((data ?? []) as unknown as PushSubRow[]).filter(
    (r) => destinatarios.userId === undefined || r.user_id === destinatarios.userId,
  );
  if (rows.length === 0) return { sent: 0, gone: 0 };

  // Vínculo ativo e papel de cada dono de inscrição. Falha FECHADA: sem saber quem
  // ainda pertence à organização, não manda para ninguém.
  const { data: vinculos, error: vinculosErr } = await admin
    .from("user_organizations")
    .select("user_id, role, revoked_at")
    .eq("organization_id", organizationId);
  if (vinculosErr) {
    logger.warn("push_membership_list_failed", { detail: vinculosErr.message });
    return { sent: 0, gone: 0 };
  }
  const papelDoUsuario = new Map<string, string>();
  for (const v of vinculos ?? []) {
    if (v.revoked_at === null || v.revoked_at === undefined) {
      papelDoUsuario.set(String(v.user_id), String(v.role));
    }
  }
  rows = rows.filter((r) => {
    const papel = papelDoUsuario.get(r.user_id);
    if (!papel) return false;
    if (destinatarios.conversa && !papelPodeVerConversa(papel, r.user_id, destinatarios.conversa)) return false;
    return true;
  });
  // O endereço também é conferido na hora de chamar: a linha pode ter sido gravada
  // quando a regra de inscrição ainda aceitava qualquer URL.
  rows = rows.filter((r) => {
    if (endpointDePushPermitido(r.endpoint)) return true;
    logger.warn("web_push_endpoint_recusado", { id: r.id });
    return false;
  });
  if (rows.length === 0) return { sent: 0, gone: 0 };

  webpush.setVapidDetails(await vapidSubject(), vapidPublica()!, env.VAPID_PRIVATE_KEY.trim());

  let sent = 0;
  let gone = 0;
  const body = JSON.stringify(payload);

  await Promise.all(
    rows.map(async (row) => {
      try {
        await webpush.sendNotification(
          { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
          body,
        );
        sent += 1;
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          gone += 1;
          await store(admin).delete().eq("id", row.id);
          return;
        }
        logger.warn("web_push_send_failed", { status: status ?? 0 });
      }
    }),
  );

  return { sent, gone };
}

export async function enviarPushAoUsuario(
  organizationId: string,
  userId: string,
  payload: PushPayload,
): Promise<{ sent: number; gone: number }> {
  return enviarPushDaOrg(organizationId, payload, undefined, { userId });
}
