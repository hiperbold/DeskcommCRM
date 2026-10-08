/**
 * POST /api/v1/channels/official/registrar: registra o número `PENDING` na API oficial da Meta (D-174).
 *
 * `POST /{phone_number_id}/register` com `messaging_product: whatsapp` e um PIN de seis dígitos (a
 * verificação em duas etapas do número). Só admin da organização.
 *
 * ─── O fluxo do PIN, e por que é este ────────────────────────────────────────
 * Sem `pin` no corpo, o CRM GERA um (aleatório criptográfico) e o devolve UMA vez nesta resposta, para
 * o admin guardar: é o PIN que a Meta passa a exigir se o número for registrado de novo. Com `pin`, o
 * admin usa o que já tem (número que já teve verificação em duas etapas), e ele NÃO volta. Em nenhum dos
 * casos o PIN é gravado, auditado, logado ou devolvido por outra rota: perdê-lo se resolve redefinindo o
 * PIN no WhatsApp Manager, e guardá-lo seria criar um segredo a mais para vazar.
 *
 * Só registra número `PENDING` (lido na Meta agora). Número `CONNECTED` não é registrado de novo: com
 * PIN diferente do cadastrado a Meta recusa, e sem ele a chamada só gastaria o limite de tentativas.
 *
 * A Meta recusar o registro NÃO é erro de requisição: 200 com `registrado: false` e o motivo traduzido.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { credenciaisDoCanalOficialVivo } from "@/lib/channels/meta/numero-da-sessao";
import {
  gerarPinDeRegistro,
  lerEstadoDoNumero,
  registrarNumero,
} from "@/lib/channels/meta/registro-do-numero";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "cache-control": "no-store, max-age=0" } as const;

const corpoSchema = z.object({ pin: z.string().regex(/^[0-9]{6}$/).optional() }).strict();

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "channels_official_registrar" });
  if (!authz.ok) return authz.response;

  const bruto = await req.json().catch(() => ({}));
  const parsed = corpoSchema.safeParse(bruto ?? {});
  if (!parsed.success) {
    // Sem `details`: o erro do schema ecoaria o valor recebido, e o valor pode ser o PIN.
    return fail("validation_failed", "O PIN precisa ter exatamente seis dígitos.", 422, {
      requestId,
      headers: NO_STORE,
    });
  }

  const cred = await credenciaisDoCanalOficialVivo(createAdminClient(), authz.org.orgId);
  if (!cred.ok) {
    return fail("invalid_request", cred.erro, 422, { requestId, headers: NO_STORE });
  }

  const estado = await lerEstadoDoNumero({ phoneNumberId: cred.phoneNumberId, token: cred.token });
  if (!estado.ok) {
    return ok(
      { registrado: false as const, pin: null, pinGerado: false, codigo: "estado_indisponivel", erro: estado.motivo },
      { requestId, headers: NO_STORE },
    );
  }
  if (!estado.precisaRegistrar) {
    return fail("state_conflict", "number_not_pending", 409, { requestId, headers: NO_STORE });
  }

  const pinGerado = parsed.data.pin === undefined;
  const pin = parsed.data.pin ?? gerarPinDeRegistro();
  const r = await registrarNumero({ phoneNumberId: cred.phoneNumberId, token: cred.token, pin });

  if (!r.ok) {
    return ok(
      { registrado: false as const, pin: null, pinGerado: false, codigo: r.codigo, erro: r.motivo },
      { requestId, headers: NO_STORE },
    );
  }

  // O audit leva QUEM registrou e QUAL número; nunca o PIN, nem se foi gerado ou informado.
  await audit({
    action: "channel.number_registered",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "channel_session",
    resourceId: cred.sessionId,
    requestId,
    metadata: { phone_number_id: cred.phoneNumberId },
  });

  return ok(
    { registrado: true as const, pin: pinGerado ? pin : null, pinGerado, codigo: null, erro: null },
    { requestId, headers: NO_STORE },
  );
}
