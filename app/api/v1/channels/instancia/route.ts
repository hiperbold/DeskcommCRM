import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET    /api/v1/channels/instancia       — as conexões por instância desta organização.
 * POST   /api/v1/channels/instancia       — VALIDA servidor e token, grava e liga a volta.
 * DELETE /api/v1/channels/instancia?id=   — desliga a volta no servidor e arquiva.
 *
 * O caminho e o corpo desta rota não citam o canal: quem está do outro lado,
 * como se chamam as colunas e como se registra o webhook moram em
 * `lib/channels/instancia`. Nome de provider numa rota é a feature sabendo com
 * quem fala, e o `lint:channels` reprova.
 *
 * O token **nunca volta num GET**, nem mascarado: a tela mostra que a conexão
 * existe e em que estado está, não com que chave.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import {
  INSTANCE_CHANNEL_LABEL,
  conectarPorInstancia,
  listarConexoesPorInstancia,
  removerConexaoPorInstancia,
} from "@/lib/channels/instancia";
import { env } from "@/lib/env";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const conectarSchema = z.object({
  servidor: z.string().trim().min(4).max(300),
  token: z.string().trim().min(8).max(500),
  nome: z.string().trim().max(80).nullish(),
});

const idSchema = z.string().uuid();

/**
 * Endereço público desta instalação, pela mesma regra da conexão por parceiro:
 * `env.*` em runtime (a imagem genérica nasce com um placeholder de build), e o
 * host da requisição só como último recurso.
 */
function baseDoCrm(req: NextRequest): string {
  const configurada = env.NEXT_PUBLIC_APP_URL;
  const usavel = configurada && !configurada.includes("placeholder.invalid") ? configurada : null;
  return (usavel ?? req.headers.get("origin") ?? `${req.nextUrl.protocol}//${req.nextUrl.host}`).replace(/\/+$/, "");
}

function contextoDaRequisicao(req: NextRequest) {
  return {
    ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    userAgent: req.headers.get("user-agent") ?? null,
  };
}

export async function GET(): Promise<NextResponse> {
  const requestId = randomUUID();
  // Conectar número expõe a conta da empresa: é decisão de quem administra.
  const authz = await requireRole("admin", { requestId, resource: "channels_instancia" });
  if (!authz.ok) return authz.response;

  const conexoes = await listarConexoesPorInstancia(createAdminClient(), authz.org.orgId);
  return ok(
    {
      label: INSTANCE_CHANNEL_LABEL,
      conexoes: conexoes.map((c) => ({
        id: c.id,
        display_name: c.displayName,
        phone_number: c.phoneNumber,
        status: c.status,
        servidor: c.servidor,
        webhook_registrado: c.webhookRegistrado,
      })),
    },
    { requestId },
  );
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "channels_instancia" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;

  const parsed = conectarSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("invalid_request", t("servidor e token são obrigatórios"), 422, { requestId });
  }

  const base = baseDoCrm(req);
  const r = await conectarPorInstancia(createAdminClient(), {
    organizationId: orgId,
    servidor: parsed.data.servidor,
    token: parsed.data.token,
    nome: parsed.data.nome ?? null,
    urlDoWebhook: (pathToken) => `${base}/api/v1/webhooks/channel/${pathToken}`,
  });
  if (!r.ok) {
    return fail(r.status === 422 ? "invalid_request" : "internal_error", r.reason, r.status, { requestId });
  }

  void audit({
    action: "channel.connected",
    actorUserId: authz.user.id,
    organizationId: orgId,
    resourceType: "channel_session",
    resourceId: r.conexao.id,
    requestId,
    ...contextoDaRequisicao(req),
    // Nunca o token nem o servidor: só o que diz se a conexão ficou completa.
    metadata: { via: "instancia", status: r.conexao.status, webhook_registrado: r.webhook.registrado },
  });

  return ok(
    {
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

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "channels_instancia" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const parametro = idSchema.safeParse(req.nextUrl.searchParams.get("id"));
  if (!parametro.success) return fail("invalid_request", t("id da conexão inválido"), 422, { requestId });
  // O uuid num nome que TERMINA em `id`: `api_audit_log.resource_id` é uuid e a
  // varredura de `tests/unit/audit-resource-id-e-uuid.test.ts` julga a expressão
  // pelo texto, porque o valor só existe em runtime.
  const conexaoId = parametro.data;

  const r = await removerConexaoPorInstancia(createAdminClient(), authz.org.orgId, conexaoId);
  if (!r.ok) {
    return fail(r.status === 404 ? "not_found" : "internal_error", r.reason, r.status, { requestId });
  }

  void audit({
    action: "channel.archived",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "channel_session",
    resourceId: conexaoId,
    requestId,
    ...contextoDaRequisicao(req),
    metadata: { via: "instancia", webhook_removido: r.webhookRemovido },
  });

  return ok({ removida: true, webhook_removido: r.webhookRemovido }, { requestId });
}
