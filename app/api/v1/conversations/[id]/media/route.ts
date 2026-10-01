import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/conversations/[id]/media — upload outbound (multipart).
 * Storage-first: sobe pro bucket whatsapp-media; o envio da mensagem
 * referencia o storage_path (o WAHA recebe signed URL, nunca base64).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { lerMultipartComTeto } from "@/lib/api/multipart-com-teto";
import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { IDIOMA_PADRAO } from "@/lib/i18n/idiomas";
import { extFromMime, MAX_MEDIA_BYTES } from "@/lib/messaging/media/types";
import { validateOutboundMedia } from "@/lib/messaging/media/upload-validation";
import { transcodificarNotaDeVoz } from "@/lib/messaging/media/voice-transcode";
import { createAdminClient } from "@/lib/supabase/admin";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id: conversationId } = await ctx.params;

  // spec 13 §4: escrita é agent+ (viewer é read-only). Esta rota era a ÚNICA de
  // escrita em conversations/[id]/* sem o gate — e como a policy de SELECT deixa
  // o viewer enxergar toda conversa da org, o papel mais fraco do tenant tinha
  // escrita irrestrita no bucket (50 MB por arquivo, com service_role). A irmã
  // claim/route.ts:35 é o modelo literal.
  // Sessão de navegador OU token de servidor: é o primeiro passo do envio de
  // mídia, e quem envia por token precisa subir o arquivo antes de mandar.
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "conversation_media",
    comDono: true,
    role: "agent",
    scope: "mcp:write",
  });
  if (!authz.ok) return authz.response;
  // O ramo do token não carrega idioma de usuário: cai no padrão do produto.
  const t = (texto: string) => traduzir(texto, authz.idioma ?? IDIOMA_PADRAO);

  // D-155: o que não é contado na rota não é contado em lugar nenhum. Sem o teto,
  // uma chave em laço subia 50 MB por chamada no bucket, sem limite (órfãos e custo).
  const tetoEstourado = await tetoDeEscritaDoToken(authz, "media", requestId);
  if (tetoEstourado) return tetoEstourado;
  const activeOrg = { orgId: authz.organizationId };
  // O client vem de `authz`, não de `createClient()`: no ramo do token NÃO HÁ
  // cookie de sessão, então um client de sessão seria anônimo e a RLS devolveria
  // zero linha — a conversa existente viraria 404 e o upload por token, que é a
  // capacidade que este PR entrega, nunca funcionaria. Quem protege aqui é o
  // filtro explícito de `organization_id` logo abaixo, que vale nos dois ramos.
  const supabase = authz.supabase;

  // RLS (no ramo da sessão) + filtro explícito: a conversa precisa ser da org ativa.
  const { data: conv, error: convErr } = await supabase
    .from("conversations")
    .select("id")
    .eq("id", conversationId)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();
  if (convErr) return fail("internal_error", t("Erro ao validar conversa."), 500, { requestId });
  if (!conv) return fail("not_found", t("Conversa não encontrada."), 404, { requestId });

  // Guard de DoS (D-105): o corpo é lido pelo fluxo com contador e abortado ao
  // passar do teto (50MB mais 1MB de envelope multipart), sem depender do
  // Content-Length, que o envio em pedaços não traz. O check autoritativo
  // continua o file.size pós-parse.
  const leitura = await lerMultipartComTeto(req, MAX_MEDIA_BYTES);
  if (!leitura.ok && leitura.motivo === "grande") {
    return fail("payload_too_large", t("Arquivo acima de 50MB."), 413, { requestId });
  }
  const form = leitura.ok ? leitura.form : null;
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return fail("validation_failed", t("Campo 'file' (multipart) obrigatório."), 422, { requestId });
  }

  const mime = file.type || "application/octet-stream";
  const verdict = validateOutboundMedia(mime, file.size);
  if (!verdict.ok) {
    const status = verdict.code === "payload_too_large" ? 413 : verdict.code === "unsupported_media_type" ? 415 : 422;
    return fail(verdict.code, verdict.message, status, { requestId });
  }

  const bruto = Buffer.from(await file.arrayBuffer());

  // Nota de voz gravada no browser sai em `webm` (o Chrome não grava ogg), e o
  // canal oficial recusa depois de aceitar — `131053 Media upload error`, que
  // culpa a URL quando o problema é o container. Converter AQUI faz todo canal
  // receber um arquivo válido, e o mesmo áudio poder ser reenviado depois sem
  // repetir o trabalho. Falha devolve o original: o canal que converte sozinho
  // continua funcionando como sempre.
  const audio = await transcodificarNotaDeVoz({ buffer: bruto, mime });
  const mimeFinal = audio.mime;
  const buffer = audio.buffer;

  const storagePath = `${activeOrg.orgId}/${conversationId}/out-${randomUUID()}.${extFromMime(mimeFinal)}`;
  const admin = createAdminClient();
  const { error: upErr } = await admin.storage
    .from("whatsapp-media")
    .upload(storagePath, buffer, { contentType: mimeFinal, upsert: false });
  if (upErr) {
    console.error("[conversations.media] upload failed", upErr.message);
    return fail("internal_error", t("Erro ao subir o arquivo."), 500, { requestId });
  }

  return ok(
    {
      storage_path: storagePath,
      // O mime e o tamanho do arquivo QUE FOI GUARDADO, não os que chegaram.
      // Devolver o original seria mandar o canal buscar um `webm` que já não
      // existe — o mesmo defeito, um passo adiante.
      media_mime: mimeFinal,
      media_size_bytes: buffer.length,
      kind: verdict.kind,
    },
    { requestId },
  );
}
