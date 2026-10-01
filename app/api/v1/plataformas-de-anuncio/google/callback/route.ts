/**
 * GET /api/v1/plataformas-de-anuncio/google/callback — a volta do
 * consentimento do Google Ads.
 *
 * Confere o `state`, troca o código por tokens, cifra e grava só o refresh
 * token. Irmã de `app/api/v1/agenda/google/callback/route.ts`, mais enxuta:
 * não há vínculo de conta por cookie (a conexão é da organização, provada
 * pelo `state`), não há escopo opcional para conferir (um só, obrigatório) e
 * não há descoberta de conta primária — a conta e a ação de conversão são
 * digitadas à mão na tela, depois deste passo.
 *
 * É retorno de NAVEGADOR: todo desfecho volta para
 * `/app/settings/conversoes` com `?erro=<código>` ou `?ok=1`, nunca JSON.
 *
 * ─── A ORDEM DOS PASSOS É CONTRATO — mesma disciplina do irmão ────────────
 * 1. `error` na query ANTES de tudo: "Cancelar" não é falha.
 * 2. `state` ANTES do `code`: sem organização não há o que auditar.
 * 3. troca do código DEPOIS da verificação do `state`: nunca gasta o `code`
 *    (uso único) antes de saber que o retorno é legítimo.
 * 4. cifra ANTES do upsert: gravar o refresh token em claro por um instante
 *    é gravá-lo em claro.
 *
 * ─── QUEM VOLTOU É QUEM SAIU (D-119) ──────────────────────────────────────
 * O `state` é assinado, mas quem o apresenta pode ser outra pessoa que recebeu a URL de
 * consentimento de um admin: o refresh token dela iria para a organização dele. Por isso,
 * depois de o `state` valer e ANTES de trocar o código, o cookie de vínculo posto pelo
 * `connect` precisa casar com o nonce do `state` (o navegador de quem recebeu o link não o
 * tem), e o nonce é queimado em `calendar_oauth_nonces` (uso único; o replay dentro dos dez
 * minutos é recusado). A sessão do produto é `strict` e não viaja nesta volta, então o que se
 * prova é o NAVEGADOR, não a pessoa (ver `lib/agenda/google/vinculo.ts`). A limpeza do
 * cookie mora em `voltar`, que toda saída atravessa.
 */
import { NextResponse, type NextRequest } from "next/server";

import { NOME_DO_VINCULO, vinculoConfere } from "@/lib/agenda/google/vinculo";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { configuracaoDoGoogleAds } from "@/lib/plataformas-de-anuncio/google/config";
import {
  CAMINHO_DO_CALLBACK_DE_ADS,
  verificarEstado,
} from "@/lib/plataformas-de-anuncio/google/estado";
import { trocarCodigoPorToken } from "@/lib/plataformas-de-anuncio/google/token";
import { createAdminClient } from "@/lib/supabase/admin";
import { cookieSecure } from "@/lib/supabase/cookie-secure";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";

export const dynamic = "force-dynamic";

function voltar(base: string, params: Record<string, string>): NextResponse {
  const url = new URL("/app/settings/conversoes", base || "http://localhost:3000");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const resposta = NextResponse.redirect(url);
  // O vínculo morre com o fluxo, sucesso ou erro: não sobra cookie vivo até o prazo.
  resposta.cookies.set(NOME_DO_VINCULO, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: cookieSecure(),
    path: CAMINHO_DO_CALLBACK_DE_ADS,
    maxAge: 0,
  });
  return resposta;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const base = env.NEXT_PUBLIC_APP_URL;
  const url = new URL(req.url);

  // 1. Cancelamento não é erro.
  if (url.searchParams.get("error")) {
    return voltar(base, { erro: "cancelado" });
  }

  // 2. `state` antes do `code`.
  const estado = verificarEstado(url.searchParams.get("state"), {
    segredo: env.INTERNAL_SECRET,
    agora: new Date(),
  });
  if (!estado) return voltar(base, { erro: "estado_invalido" });

  // Quem voltou é o navegador que saiu: sem o cookie de vínculo, ou com o de outro fluxo,
  // nada é gasto (nem o nonce, nem o código do Google).
  if (!vinculoConfere(req.cookies.get(NOME_DO_VINCULO)?.value, estado.nonce, env.INTERNAL_SECRET)) {
    return voltar(base, { erro: "estado_invalido" });
  }

  const code = url.searchParams.get("code");
  if (!code) return voltar(base, { erro: "sem_codigo" });

  const app = configuracaoDoGoogleAds(estado.api);
  if (!app) return voltar(base, { erro: "google_ads_nao_configurado" });

  // Queima do nonce ANTES de gastar o código (uso único do `code`): replay do mesmo `state`
  // viola a chave primária. Falha de gravação também recusa, porque sem o guarda não há
  // como garantir uso único.
  const admin = createAdminClient();
  const { error: erroDoNonce } = await admin.from("calendar_oauth_nonces").insert({
    nonce: estado.nonce,
    organization_id: estado.organizationId,
    user_id: estado.userId,
    expira_em: new Date(estado.expiraEmMs).toISOString(),
  });
  if (erroDoNonce) return voltar(base, { erro: "estado_invalido" });

  // 3. Troca — só depois do state confirmado.
  const leitura = await trocarCodigoPorToken(app, code, { agora: new Date() });
  if (!leitura.ok) {
    logger.error("[plataformas-de-anuncio.google.callback] troca de código falhou", {
      organizationId: estado.organizationId,
      motivo: leitura.motivo,
      detalhe: leitura.detalhe.slice(0, 300),
    });
    return voltar(base, { erro: "troca_falhou" });
  }
  if (!leitura.token.refresh_token) {
    // Reconexão sem `prompt=consent` ter funcionado (extremamente raro, já que
    // sempre pedimos): sem refresh token não há o que gravar — a conexão
    // funcionaria por uma hora e morreria calada.
    return voltar(base, { erro: "sem_refresh_token" });
  }

  // 4. Cifra antes do upsert.
  const cifrado = await encryptWebhookSecret(admin, leitura.token.refresh_token);
  if (!cifrado) return voltar(base, { erro: "cifra_indisponivel" });

  const { error } = await admin.from("ad_platform_connections").upsert(
    {
      organization_id: estado.organizationId,
      platform: "google_ads",
      google_refresh_token_encrypted: cifrado,
      google_api: estado.api,
      updated_by: estado.userId,
    },
    { onConflict: "organization_id,platform" },
  );
  if (error) {
    logger.error("[plataformas-de-anuncio.google.callback] upsert falhou", {
      organizationId: estado.organizationId,
      detalhe: error.message,
    });
    return voltar(base, { erro: "erro_ao_gravar" });
  }

  await audit({
    action: "ad_platform_connection.updated",
    actorUserId: estado.userId,
    organizationId: estado.organizationId,
    resourceType: "ad_platform_connections",
    resourceId: null,
    metadata: { platform: "google_ads" },
  });

  return voltar(base, { ok: "1" });
}
