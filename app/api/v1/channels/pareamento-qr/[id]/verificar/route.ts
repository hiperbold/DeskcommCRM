import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/channels/pareamento-qr/[id]/verificar  — o estado do pareamento: aguardando (com o QR
 * atualizado), conectado ou expirado.
 *
 * É POST porque TEM efeito: quando o número conecta, é esta chamada que conclui a conexão
 * (status, número e nome do perfil) e liga a volta das mensagens; quando o prazo passou sem
 * conectar, ela apaga a instância no servidor e arquiva a sessão. Um GET com esses efeitos
 * poderia ser disparado por pré-busca, imagem ou link, sem a intenção de quem o recebe.
 * A tela chama a cada poucos segundos enquanto o cliente lê o QR.
 *
 * Exige admin da organização da sessão. A sessão é procurada SEMPRE com o `organization_id` da
 * sessão autenticada (nunca do path nem do corpo): o id de outra organização responde 404,
 * igual a um id que não existe.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { estadoDoPareamentoQr } from "@/lib/channels/pareamento-qr";
import { dentroDoLimiteDoPareamentoQr } from "@/lib/channels/pareamento-qr-limite";
import { urlDoWebhookDeCanal } from "@/lib/channels/url-do-webhook";
import { traduzir } from "@/lib/i18n/dicionario";
import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const idSchema = z.string().uuid();

type Contexto = { params: Promise<{ id: string }> };

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

  // 1 consulta por segundo por organização; a tela consulta a cada 3 s e, se levar 429, só tenta no próximo ciclo.
  if (!(await dentroDoLimiteDoPareamentoQr("verificar", authz.org.orgId))) {
    return fail("rate_limited", t("Consultas demais. Aguarde um instante e tente de novo."), 429, {
      requestId,
      headers: { "Retry-After": "1" },
    });
  }

  const r = await estadoDoPareamentoQr(createAdminClient(), {
    organizationId: authz.org.orgId,
    id: sessaoId,
    urlDoWebhook: urlDoWebhookDeCanal(),
  });
  if ("ok" in r) return fail(r.codigo, t(r.reason), r.status, { requestId });

  if (r.estado === "conectado") {
    if (r.concluiuAgora) {
      void audit({
        action: "channel.connected",
        actorUserId: authz.user.id,
        organizationId: authz.org.orgId,
        resourceType: "channel_session",
        resourceId: sessaoId,
        requestId,
        ip: ipDoCliente(req.headers),
        userAgent: req.headers.get("user-agent") ?? null,
        metadata: { via: "qr", status: r.conexao.status, webhook_registrado: r.webhook.registrado },
      });
    }
    return ok(
      {
        id: r.id,
        estado: r.estado,
        conexao: {
          id: r.conexao.id,
          display_name: r.conexao.displayName,
          phone_number: r.conexao.phoneNumber,
          status: r.conexao.status,
        },
        webhook: r.webhook,
      },
      { requestId },
    );
  }

  return ok(
    { id: r.id, estado: r.estado, qr: r.qr, codigo: r.codigo, expira_em: r.expira_em },
    { requestId },
  );
}
