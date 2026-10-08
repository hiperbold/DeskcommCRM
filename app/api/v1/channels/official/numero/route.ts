/**
 * GET /api/v1/channels/official/numero: o estado do número na Meta (D-174).
 *
 * `status` (CONNECTED, PENDING...) e `code_verification_status`, lidos AO VIVO no Graph com o token
 * guardado na sessão. `precisaRegistrar` é verdadeiro no `PENDING`: o número foi verificado mas nunca
 * registrado, e a Meta não deixa enviar. Só admin da organização. O token nunca volta.
 *
 * A Meta recusar a leitura NÃO é erro de requisição: a resposta é 200 com `disponivel: false` e o
 * motivo em português, que é a informação que a tela precisa mostrar.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { credenciaisDoCanalOficialVivo } from "@/lib/channels/meta/numero-da-sessao";
import { lerEstadoDoNumero } from "@/lib/channels/meta/registro-do-numero";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "cache-control": "no-store, max-age=0" } as const;

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "channels_official_numero" });
  if (!authz.ok) return authz.response;

  const cred = await credenciaisDoCanalOficialVivo(createAdminClient(), authz.org.orgId);
  if (!cred.ok) {
    return fail("invalid_request", cred.erro, 422, { requestId, headers: NO_STORE });
  }

  const estado = await lerEstadoDoNumero({ phoneNumberId: cred.phoneNumberId, token: cred.token });
  if (!estado.ok) {
    return ok({ disponivel: false as const, motivo: estado.motivo }, { requestId, headers: NO_STORE });
  }
  return ok(
    {
      disponivel: true as const,
      status: estado.status,
      codeVerificationStatus: estado.codeVerificationStatus,
      displayPhoneNumber: estado.displayPhoneNumber,
      verifiedName: estado.verifiedName,
      qualityRating: estado.qualityRating,
      precisaRegistrar: estado.precisaRegistrar,
    },
    { requestId, headers: NO_STORE },
  );
}
