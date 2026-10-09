import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  /api/v1/channels/pareamento-qr  — o recurso existe nesta instalação? e há um pareamento em andamento? (só lê)
 * POST /api/v1/channels/pareamento-qr  — INICIA: o CRM cria a instância no servidor e devolve o QR Code.
 *
 * O cliente conecta o WhatsApp sozinho, lendo o QR dentro do CRM. O caminho não
 * cita o provider (o `lint:channels` reprova); quem está do outro lado, as chaves
 * da instalação e a ordem dos passos moram em `lib/channels/pareamento-qr`.
 *
 * Exige admin da organização da sessão. Sem o servidor e o token de
 * administrador configurados na instalação, o GET diz `disponivel: false` e o
 * POST responde 404: o recurso não existe, e tudo segue como sempre.
 *
 * O QR (data URL) só viaja nesta resposta e nas de estado: nunca vai para log,
 * audit ou Sentry. Os tokens (de administrador e da instância) não saem do servidor.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import {
  iniciarPareamentoQr,
  pareamentoQrDisponivel,
  pareamentoQrPendenteDaOrganizacao,
} from "@/lib/channels/pareamento-qr";
import { dentroDoLimiteDoPareamentoQr } from "@/lib/channels/pareamento-qr-limite";
import { urlDoWebhookDeCanal } from "@/lib/channels/url-do-webhook";
import { traduzir } from "@/lib/i18n/dicionario";
import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const iniciarSchema = z.object({
  /** Opcional: com o número, o servidor devolve um código para digitar no celular em vez do QR. */
  telefone: z.string().trim().max(30).nullish(),
});

export async function GET(): Promise<NextResponse> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "channels_pareamento_qr" });
  if (!authz.ok) return authz.response;

  if (!(await pareamentoQrDisponivel())) {
    return ok({ disponivel: false, pendente: null }, { requestId });
  }
  // Só lê: nada é limpo nem concluído numa consulta GET.
  const pendente = await pareamentoQrPendenteDaOrganizacao(createAdminClient(), authz.org.orgId);
  return ok({ disponivel: true, pendente }, { requestId });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "channels_pareamento_qr" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const parsed = iniciarSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return fail("invalid_request", t("Dados inválidos."), 422, { requestId });

  // Cada pedido cria uma instância paga no servidor: freio de taxa por organização.
  if (!(await dentroDoLimiteDoPareamentoQr("iniciar", authz.org.orgId))) {
    return fail(
      "rate_limited",
      t("Muitas tentativas de conectar. Aguarde um pouco antes de gerar outro QR Code."),
      429,
      { requestId, headers: { "Retry-After": "3600" } },
    );
  }

  const r = await iniciarPareamentoQr(createAdminClient(), {
    organizationId: authz.org.orgId,
    telefone: parsed.data.telefone ?? null,
    urlDoWebhook: urlDoWebhookDeCanal(),
    idioma: authz.user.idioma,
  });
  if (!r.ok) return fail(r.codigo, t(r.reason), r.status, { requestId });

  const sessaoId = r.id;
  void audit({
    action: "channel.qr_pairing_started",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "channel_session",
    resourceId: sessaoId,
    requestId,
    ip: ipDoCliente(req.headers),
    userAgent: req.headers.get("user-agent") ?? null,
    // Nunca o QR, o código de pareamento, o número nem os tokens.
    metadata: { via: "qr", com_codigo: !!parsed.data.telefone },
  });
  if (parsed.data.telefone) {
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
    { requestId, status: 201 },
  );
}
