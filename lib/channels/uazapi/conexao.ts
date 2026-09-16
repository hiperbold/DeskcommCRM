/**
 * Conexão de uma instância UAZAPI — validar, gravar, ligar a volta e desligar.
 *
 * A rota e a tela não podem nomear o provider (invariante 1 da doutrina), mas
 * precisam de três coisas concretas: se o servidor e o token prestam, onde
 * gravar, e como fazer o servidor mandar as mensagens para cá. As três moram
 * aqui, onde nomear o provider é permitido.
 *
 * ─── A diferença para a conexão do canal intermediado ───────────────────────
 *
 * Lá o operador cola a URL e o segredo no painel do provedor, e o passo mais
 * esquecido é esse. Aqui o CRM registra o webhook SOZINHO pela API da instância,
 * porque ela permite — e o passo que o operador esqueceria deixa de existir.
 *
 * ─── A armadilha do registro de webhook ─────────────────────────────────────
 *
 * `POST /webhook` SEM `action` SUBSTITUI o webhook existente da instância. Uma
 * instância que já alimenta outra automação (um fluxo de relatórios, outro
 * sistema) perderia a dela em silêncio no dia em que alguém a conectasse aqui.
 * Por isso todo registro vai com `action: "add"`, toda remoção com
 * `action: "delete"` e o id do NOSSO webhook, e nada aqui escreve sem `action`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { metadataInicialDoCanal } from "@/lib/ai/elegibilidade/pre-go-live";
import { assertDestinoResolvidoSeguro } from "@/lib/automation/outbound-ip";
import { assertSafeOutboundUrl } from "@/lib/automation/outbound-url";

import { ARCHIVED_AT, queryTolerantToMissingArchived } from "../archived";
import { CHANNEL_PROVIDER_UAZAPI } from "../capabilities";
import { normalizarServidorUazapi } from "./credentials";

/** Como o canal se chama PARA O USUÁRIO. Mora aqui por causa do lint, e porque é dado, não decisão de tela. */
export const UAZAPI_CHANNEL_LABEL = "UAZAPI";

/**
 * Eventos que o CRM assina. `messages` traz a conversa; `messages_update` e
 * `connection` ficam assinados para o desfecho de entrega e a queda da
 * instância chegarem assim que esta entrada os traduzir.
 */
export const UAZAPI_EVENTOS_DO_WEBHOOK = ["messages", "messages_update", "connection"] as const;

/** Chave em `channel_sessions.metadata` com o id do NOSSO webhook no servidor. */
export const UAZAPI_METADATA_WEBHOOK_ID = "uazapi_webhook_id";

const PRAZO_MS = 20_000;

type Json = Record<string, unknown> | null;
const str = (v: unknown): string | null => (typeof v === "string" && v.trim().length > 0 ? v.trim() : null);

export type ValidacaoDaInstancia =
  | {
      ok: true;
      baseUrl: string;
      instanceId: string;
      instanceName: string | null;
      /** E.164 com `+`, quando a instância já está pareada. */
      phoneNumber: string | null;
      profileName: string | null;
      /** Estado no vocabulário do CRM. */
      status: "WORKING" | "SCAN_QR_CODE" | "STOPPED";
    }
  | { ok: false; reason: string };

async function chamar(
  baseUrl: string,
  token: string,
  caminho: string,
  corpo?: Record<string, unknown>,
): Promise<{ res: Response; json: unknown }> {
  const res = await fetch(`${baseUrl}${caminho}`, {
    method: corpo ? "POST" : "GET",
    headers: { token, accept: "application/json", ...(corpo ? { "content-type": "application/json" } : {}) },
    ...(corpo ? { body: JSON.stringify(corpo) } : {}),
    signal: AbortSignal.timeout(PRAZO_MS),
  });
  return { res, json: await res.json().catch(() => null) };
}

/**
 * O servidor e o token prestam, e o que responde é mesmo uma instância?
 *
 * O endereço vem de quem administra, mas o processo vai buscá-lo levando o
 * token: a mesma guarda textual + DNS das outras saídas do repo recusa faixa
 * privada e rebinding antes do primeiro byte.
 */
export async function validarInstanciaUazapi(input: { servidor: string; token: string }): Promise<ValidacaoDaInstancia> {
  const baseUrl = normalizarServidorUazapi(input.servidor);
  if (!baseUrl) return { ok: false, reason: "Endereço do servidor inválido." };
  const token = input.token.trim();
  if (!token) return { ok: false, reason: "Informe o token da instância." };

  try {
    assertSafeOutboundUrl(baseUrl);
    await assertDestinoResolvidoSeguro(new URL(baseUrl).hostname);
  } catch {
    return { ok: false, reason: "Este endereço de servidor não é permitido." };
  }

  let resposta: { res: Response; json: unknown };
  try {
    resposta = await chamar(baseUrl, token, "/instance/status");
  } catch {
    // Rede caída não é token errado, e dizer "token inválido" mandaria o
    // operador trocar um token que estava certo.
    return { ok: false, reason: "Não foi possível falar com o servidor. Confira o endereço e tente de novo." };
  }

  const { res } = resposta;
  if (res.status === 401 || res.status === 403) return { ok: false, reason: "Token recusado pelo servidor." };
  if (!res.ok) return { ok: false, reason: `Servidor respondeu ${res.status}.` };

  const json = resposta.json as Json;
  const instancia = (json?.instance ?? null) as Json;
  const instanceId = str(instancia?.id);
  if (!instanceId) {
    return { ok: false, reason: "O servidor respondeu, mas não como uma instância de WhatsApp. Confira o endereço." };
  }

  const dono = str(instancia?.owner)?.replace(/\D/g, "") ?? "";
  const estado = (str(instancia?.status) ?? "").toLowerCase();

  return {
    ok: true,
    baseUrl,
    instanceId,
    instanceName: str(instancia?.name),
    phoneNumber: dono.length >= 8 ? `+${dono}` : null,
    profileName: str(instancia?.profileName),
    status: estado === "connected" ? "WORKING" : estado === "hibernated" ? "STOPPED" : "SCAN_QR_CODE",
  };
}

/**
 * Registra o NOSSO webhook na instância. Idempotente: se já existe um com esta
 * URL, reaproveita o id em vez de criar um segundo, que duplicaria toda entrega.
 *
 * ─── Por que SEM `excludeMessages: ["wasSentByApi"]` ────────────────────────
 *
 * A doc do servidor recomenda o filtro, e a primeira versão o usava. Só que ele
 * é da INSTÂNCIA, não do remetente: com ele, tudo que OUTRO sistema manda pela
 * mesma instância (um n8n respondendo pelo mesmo número) some da conversa do
 * CRM, e o atendente responde sem ver o que o cliente já recebeu.
 *
 * Sem o filtro o eco do nosso próprio envio volta, e isso já está resolvido
 * onde a informação existe: o envio grava o id que o canal devolveu e apaga a
 * linha que o webhook tenha criado com esse id (`removerEcoDoProprioEnvio`);
 * eco que chega depois bate no unique `(organization_id, external_id)`.
 *
 * Webhook nosso registrado com o filtro (conexões feitas antes disto) é
 * ATUALIZADO pelo id, e não recriado: reconectar basta para migrar.
 */
export async function registrarWebhookUazapi(input: {
  baseUrl: string;
  token: string;
  url: string;
}): Promise<{ ok: true; webhookId: string | null } | { ok: false; reason: string }> {
  const acharNosso = (lista: unknown): Json | null => {
    if (!Array.isArray(lista)) return null;
    return (lista.find((w) => (w as Json)?.url === input.url) as Json | undefined) ?? null;
  };
  const configuracao = {
    enabled: true,
    url: input.url,
    events: [...UAZAPI_EVENTOS_DO_WEBHOOK],
    excludeMessages: [],
    addUrlEvents: false,
    addUrlTypesMessages: false,
  };

  try {
    const existente = await chamar(input.baseUrl, input.token, "/webhook");
    const nosso = existente.res.ok ? acharNosso(existente.json) : null;
    const idDoNosso = str(nosso?.id);
    if (nosso && idDoNosso) {
      if (webhookEstaComoQueremos(nosso)) return { ok: true, webhookId: idDoNosso };
      const { res } = await chamar(input.baseUrl, input.token, "/webhook", {
        action: "update",
        id: idDoNosso,
        ...configuracao,
      });
      if (!res.ok) return { ok: false, reason: `O servidor recusou atualizar o webhook (${res.status}).` };
      return { ok: true, webhookId: idDoNosso };
    }

    const { res, json } = await chamar(input.baseUrl, input.token, "/webhook", { action: "add", ...configuracao });
    if (!res.ok) return { ok: false, reason: `O servidor recusou o webhook (${res.status}).` };
    return { ok: true, webhookId: str(acharNosso(json)?.id) };
  } catch {
    return { ok: false, reason: "Não foi possível registrar o webhook no servidor." };
  }
}

/**
 * O webhook que já existe entrega o que o CRM precisa? Ligado, com todos os
 * nossos eventos e sem filtro de mensagem. Campo ausente conta como o padrão do
 * servidor (ligado, sem filtro); evento ausente não, porque aí algo não chega.
 */
function webhookEstaComoQueremos(w: NonNullable<Json>): boolean {
  if (w.enabled === false) return false;
  const eventos = Array.isArray(w.events) ? (w.events as unknown[]) : [];
  if (!UAZAPI_EVENTOS_DO_WEBHOOK.every((e) => eventos.includes(e))) return false;
  const filtros = Array.isArray(w.excludeMessages) ? (w.excludeMessages as unknown[]) : [];
  return filtros.length === 0;
}

/** Remove SÓ o nosso webhook, pelo id. Os outros da instância ficam intocados. */
export async function removerWebhookUazapi(input: {
  baseUrl: string;
  token: string;
  webhookId: string;
}): Promise<boolean> {
  try {
    const { res } = await chamar(input.baseUrl, input.token, "/webhook", { action: "delete", id: input.webhookId });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Persistência
// ---------------------------------------------------------------------------

export interface ConexaoUazapi {
  id: string;
  displayName: string | null;
  phoneNumber: string | null;
  status: string | null;
  /** Só o host: o endereço completo não precisa voltar para a tela. */
  servidor: string | null;
  instanceId: string | null;
  webhookRegistrado: boolean;
}

interface LinhaDaConexao {
  id: string;
  display_name: string | null;
  phone_number: string | null;
  status: string | null;
  uazapi_base_url: string | null;
  uazapi_instance_id: string | null;
  webhook_path_token: string | null;
  metadata: Record<string, unknown> | null;
  archived_at?: string | null;
}

const COLUNAS =
  "id, display_name, phone_number, status, uazapi_base_url, uazapi_instance_id, webhook_path_token, metadata";

function hostDe(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function paraConexao(l: LinhaDaConexao): ConexaoUazapi {
  return {
    id: l.id,
    displayName: l.display_name,
    phoneNumber: l.phone_number,
    status: l.status,
    servidor: hostDe(l.uazapi_base_url),
    instanceId: l.uazapi_instance_id,
    webhookRegistrado: !!str((l.metadata ?? {})[UAZAPI_METADATA_WEBHOOK_ID]),
  };
}

/** As conexões ATIVAS desta organização, da mais antiga para a mais nova. */
export async function listarConexoesUazapi(admin: SupabaseClient, organizationId: string): Promise<ConexaoUazapi[]> {
  const base = () =>
    admin
      .from("channel_sessions")
      .select(COLUNAS)
      .eq("organization_id", organizationId)
      .eq("provider", CHANNEL_PROVIDER_UAZAPI)
      .order("created_at", { ascending: true });
  const { data, error } = await queryTolerantToMissingArchived(
    () => base().is(ARCHIVED_AT, null),
    () => base(),
  );
  if (error) throw new Error(`uazapi_listar_conexoes_falhou: ${error.message ?? ""}`.trim());
  return ((data ?? []) as unknown as LinhaDaConexao[]).map(paraConexao);
}

/**
 * A linha desta instância nesta organização, ARQUIVADA inclusive: reconectar
 * por cima de uma conexão removida precisa ressuscitá-la, preservando o token
 * da URL do webhook e o histórico de conversas amarrado a ela.
 */
export async function acharConexaoUazapi(
  admin: SupabaseClient,
  organizationId: string,
  filtro: { id: string } | { baseUrl: string; instanceId: string },
): Promise<(LinhaDaConexao & { token_encrypted: unknown }) | null> {
  let q = admin
    .from("channel_sessions")
    .select(`${COLUNAS}, uazapi_token_encrypted`)
    .eq("organization_id", organizationId)
    .eq("provider", CHANNEL_PROVIDER_UAZAPI);
  q = "id" in filtro
    ? q.eq("id", filtro.id)
    : q.eq("uazapi_base_url", filtro.baseUrl).eq("uazapi_instance_id", filtro.instanceId);
  const { data, error } = await q.maybeSingle();
  if (error) throw new Error(`uazapi_achar_conexao_falhou: ${error.code ?? ""} ${error.message ?? ""}`.trim());
  if (!data) return null;
  const linha = data as unknown as LinhaDaConexao & { uazapi_token_encrypted: unknown };
  return { ...linha, token_encrypted: linha.uazapi_token_encrypted };
}

/**
 * Grava (ou ressuscita) a conexão.
 *
 * O token cifrado vai para DUAS colunas, e não é descuido: `uazapi_token_encrypted`
 * é o que o adapter usa para FALAR com o servidor; `webhook_secret_encrypted` é o
 * que a rota neutra decifra para autenticar o que ENTRA — e o que o servidor
 * repete em cada entrega é justamente o token da instância. As duas são
 * escritas sempre juntas, aqui, então não há como divergirem.
 */
export async function salvarConexaoUazapi(
  admin: SupabaseClient,
  input: {
    organizationId: string;
    existente: { id: string; metadata: Record<string, unknown> | null } | null;
    baseUrl: string;
    instanceId: string;
    tokenCifrado: string;
    webhookPathToken: string;
    phoneNumber: string | null;
    displayName: string;
    status: string;
  },
): Promise<{ id: string | null; error: string | null }> {
  const linha = {
    organization_id: input.organizationId,
    provider: CHANNEL_PROVIDER_UAZAPI,
    uazapi_instance_id: input.instanceId,
    uazapi_base_url: input.baseUrl,
    uazapi_token_encrypted: input.tokenCifrado,
    webhook_secret_encrypted: input.tokenCifrado,
    webhook_path_token: input.webhookPathToken,
    phone_number: input.phoneNumber,
    display_name: input.displayName,
    status: input.status,
    archived_at: null,
  };

  const { data, error } = input.existente
    ? await admin
        .from("channel_sessions")
        .update(linha)
        .eq("id", input.existente.id)
        .eq("organization_id", input.organizationId)
        .select("id")
        .maybeSingle()
    : await admin
        .from("channel_sessions")
        .insert({ ...linha, metadata: metadataInicialDoCanal() })
        .select("id")
        .maybeSingle();

  return { id: (data as { id: string } | null)?.id ?? null, error: error?.message ?? null };
}

/** Guarda o id do nosso webhook, sem perder o resto do `metadata` (acesso da IA, números de teste). */
export async function gravarWebhookDaConexao(
  admin: SupabaseClient,
  organizationId: string,
  id: string,
  webhookId: string | null,
): Promise<void> {
  const { data } = await admin
    .from("channel_sessions")
    .select("metadata")
    .eq("organization_id", organizationId)
    .eq("id", id)
    .maybeSingle();
  const atual = ((data as { metadata: Record<string, unknown> | null } | null)?.metadata ?? {}) as Record<string, unknown>;
  await admin
    .from("channel_sessions")
    .update({ metadata: { ...atual, [UAZAPI_METADATA_WEBHOOK_ID]: webhookId } })
    .eq("organization_id", organizationId)
    .eq("id", id);
}

/**
 * Arquiva a conexão. Não apaga: as conversas continuam amarradas a ela, e o
 * histórico de quem atendeu não pode sumir porque um número foi desligado.
 */
export async function arquivarConexaoUazapi(
  admin: SupabaseClient,
  organizationId: string,
  id: string,
): Promise<string | null> {
  const { error } = await admin
    .from("channel_sessions")
    .update({ archived_at: new Date().toISOString(), status: "STOPPED" })
    .eq("organization_id", organizationId)
    .eq("id", id);
  return error?.message ?? null;
}
