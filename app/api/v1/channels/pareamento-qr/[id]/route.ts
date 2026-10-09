import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST   /api/v1/channels/pareamento-qr/[id]  — gera outro QR (ou código) na mesma instância.
 * DELETE /api/v1/channels/pareamento-qr/[id]  — cancela: apaga a instância no servidor e arquiva a sessão.
 *
 * O ESTADO (aguardando, conectado, expirado) é `POST .../[id]/verificar`: ele conclui ou
 * desfaz o pareamento, então não pode ser um GET.
 *
 * Exige admin da organização da sessão. A sessão é procurada SEMPRE com o
 * `organization_id` da sessão autenticada (nunca do path nem do corpo): o id de
 * outra organização responde 404, igual a um id que não existe.
 *
 * Cada pedido tem teto por organização (`lib/channels/pareamento-qr-limite.ts`), e o
 * código de pareamento por telefone tem o seu: um a cada 30 s e no máximo 5 por
 * pareamento, contados no banco.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { cancelarPareamentoQr, renovarPareamentoQr } from "@/lib/channels/pareamento-qr";
import { dentroDoLimiteDoPareamentoQr } from "@/lib/channels/pareamento-qr-limite";
import { traduzir } from "@/lib/i18n/dicionario";
import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const idSchema = z.string().uuid();
const renovarSchema = z.object({ telefone: z.string().trim().max(30).nullish() });

type Contexto = { params: Promise<{ id: string }> };

const FRASE_MUITAS_TENTATIVAS =
  "Muitas tentativas de conectar. Aguarde um pouco antes de gerar outro QR Code.";

export async function POST(req: NextRequest, { params }: Contexto): Promise<NextResponse> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "channels_pareamento_qr" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const id = idSchema.safeParse((await params).id);
  if (!id.success) return fail("invalid_request", t("id da conexão inválido"), 422, { requestId });
  const sessaoId = id.data;
  const corpo = renovarSchema.safeParse(await req.json().catch(() => ({})));
  if (!corpo.success) return fail("invalid_request", t("Dados inválidos."), 422, { requestId });

  if (!(await dentroDoLimiteDoPareamentoQr("renovar", authz.org.orgId))) {
    return fail("rate_limited", t(FRASE_MUITAS_TENTATIVAS), 429, {
      requestId,
      headers: { "Retry-After": "3600" },
    });
  }

  const r = await renovarPareamentoQr(createAdminClient(), {
    organizationId: authz.org.orgId,
    id: sessaoId,
    telefone: corpo.data.telefone ?? null,
  });
  if ("ok" in r) {
    return fail(r.codigo, t(r.reason), r.status, {
      requestId,
      ...(r.status === 429 ? { headers: { "Retry-After": "30" } } : {}),
    });
  }

  if (corpo.data.telefone) {
    void audit({
      action: "channel.pairing_code_requested",
      actorUserId: authz.user.id,
      organizationId: authz.org.orgId,
      resourceType: "channel_session",
      resourceId: sessaoId,
      requestId,
      ip: ipDoCliente(req.headers),
      userAgent: req.headers.get("user-agent") ?? null,
      // Nunca o número nem o código.
      metadata: { via: "qr" },
    });
  }

  return ok(
    { id: r.id, estado: r.estado, qr: r.qr, codigo: r.codigo, expira_em: r.expira_em },
    { requestId },
  );
}

export async function DELETE(req: NextRequest, { params }: Contexto): Promise<NextResponse> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "channels_pareamento_qr" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const id = idSchema.safeParse((await params).id);
  if (!id.success) return fail("invalid_request", t("id da conexão inválido"), 422, { requestId });
  const sessaoId = id.data;

  if (!(await dentroDoLimiteDoPareamentoQr("cancelar", authz.org.orgId))) {
    return fail("rate_limited", t(FRASE_MUITAS_TENTATIVAS), 429, {
      requestId,
      headers: { "Retry-After": "3600" },
    });
  }

  const r = await cancelarPareamentoQr(createAdminClient(), {
    organizationId: authz.org.orgId,
    id: sessaoId,
  });
  if (!r.ok) return fail(r.codigo, t(r.reason), r.status, { requestId });

  void audit({
    action: "channel.archived",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "channel_session",
    resourceId: sessaoId,
    requestId,
    ip: ipDoCliente(req.headers),
    userAgent: req.headers.get("user-agent") ?? null,
    metadata: { via: "qr", motivo: "cancelado", instancia_apagada: r.instanciaApagada },
  });

  return ok({ cancelado: true, instancia_apagada: r.instanciaApagada }, { requestId });
}
