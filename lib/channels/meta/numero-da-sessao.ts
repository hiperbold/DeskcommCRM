/**
 * A credencial do canal oficial VIVO da organização, pronta para falar com a Meta (D-174).
 *
 * Mesma busca de `app/api/v1/channels/official/webhook/route.ts`: a sessão não arquivada da
 * organização, escopada por `organization_id` (o cliente é de servidor e ignora a RLS). O token sai
 * decifrado só no retorno, e quem chama não o devolve ao navegador.
 */
import { ARCHIVED_AT, queryTolerantToMissingArchived } from "@/lib/channels/archived";
import { CHANNEL_PROVIDER_META } from "@/lib/channels/capabilities";
import type { createAdminClient } from "@/lib/supabase/admin";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";

export type CredenciaisDoNumero =
  | { ok: true; sessionId: string; phoneNumberId: string; wabaId: string; token: string }
  | { ok: false; erro: "no_meta_channel" | "credencial_ilegivel" };

export async function credenciaisDoCanalOficialVivo(
  admin: ReturnType<typeof createAdminClient>,
  organizationId: string,
): Promise<CredenciaisDoNumero> {
  const consultar = () =>
    admin
      .from("channel_sessions")
      .select("id, meta_phone_number_id, meta_waba_id, meta_token_encrypted")
      .eq("organization_id", organizationId)
      .eq("provider", CHANNEL_PROVIDER_META);

  const { data } = await queryTolerantToMissingArchived(
    () => consultar().is(ARCHIVED_AT, null).maybeSingle(),
    () => consultar().maybeSingle(),
  );
  const sessao = data as {
    id: string;
    meta_phone_number_id: string | null;
    meta_waba_id: string | null;
    meta_token_encrypted: string | null;
  } | null;

  if (!sessao || !sessao.meta_phone_number_id || !sessao.meta_waba_id || !sessao.meta_token_encrypted) {
    return { ok: false, erro: "no_meta_channel" };
  }
  const token = await decryptWebhookSecret(admin, sessao.meta_token_encrypted);
  if (!token) return { ok: false, erro: "credencial_ilegivel" };
  return {
    ok: true,
    sessionId: sessao.id,
    phoneNumberId: sessao.meta_phone_number_id,
    wabaId: sessao.meta_waba_id,
    token,
  };
}
