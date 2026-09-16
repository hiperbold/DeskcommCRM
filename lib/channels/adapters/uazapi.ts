/**
 * Adapter da instância UAZAPI — o quinto transporte.
 *
 * Burro como os irmãos: traduz formato e nada mais. Janela, cap diário,
 * horário e throttle são da cadeia `before_send` (doutrina
 * `restricao-de-canal.md`); se aparecer aqui um `if` de negócio, o desenho vazou.
 *
 * ─── O que o diferencia dos outros quatro ───────────────────────────────────
 *
 * - Autentica por header `token` (o da INSTÂNCIA), não por Bearer nem por
 *   `X-Api-Key`, e o servidor é da CONEXÃO (`uazapi_base_url`), não da
 *   instalação. As duas coisas vêm da sessão, cifrada.
 * - Endereça por telefone em dígitos ou por chatid (`...@g.us`, `...@lid`),
 *   como o canal por QR. Não há thread do provider a guardar.
 *
 * ─── A mídia que SAI ────────────────────────────────────────────────────────
 *
 * A mídia do envelope aponta para o nosso storage. O servidor da instância está
 * em outra rede e nem sempre alcança esse endereço (instalação com storage
 * local, bucket privado atrás de firewall). Então, quando a URL é do NOSSO
 * storage, os bytes são lidos aqui e vão em base64, que a API aceita no mesmo
 * campo. URL de qualquer outro host é repassada como veio, e quem baixa é o
 * servidor da instância: o nosso processo não sai buscando endereço que chegou
 * de fora, que é a porta de SSRF que os irmãos fecham do mesmo jeito.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { assertDestinoResolvidoSeguro } from "@/lib/automation/outbound-ip";
import { assertSafeOutboundUrl } from "@/lib/automation/outbound-url";
import type { FetchedMedia } from "@/lib/messaging/media/types";

import { resolveUazapiCreds, type UazapiCredentials } from "../uazapi/credentials";
import { saudeDoEstadoUazapi } from "../uazapi/saude";
import type {
  ChannelAdapter,
  ChannelHealth,
  ChannelTenantScope,
  OutboundEnvelope,
  RecipientInput,
} from "../types";

/**
 * Prefixo do `messages.media_url` quando a ingestão só conhece o id da
 * mensagem, e não um link. O worker de persistência repassa o valor sem
 * interpretar; quem sabe o que fazer com ele é `fetchInboundMedia`, abaixo.
 */
export const UAZAPI_REFERENCIA_DE_MIDIA = "uazapi-mensagem:";

/** Teto dos bytes que este processo lê para mandar em base64. */
const TETO_DE_MIDIA_BYTES = 16 * 1024 * 1024;

/** Teto de espera por chamada: servidor que pendura não pode pendurar o worker junto. */
const PRAZO_MS = 30_000;

type Json = Record<string, unknown> | null;

async function credenciais(scope: ChannelTenantScope & { sessionRef: string }): Promise<UazapiCredentials> {
  const creds = await resolveUazapiCreds(createAdminClient(), {
    organizationId: scope.organizationId,
    instanceId: scope.sessionRef,
  });
  // LANÇA, não devolve null: `isConfigured` é sempre true (ver abaixo), então
  // quem desiste é este ponto, e `{externalId: null}` faria o handler gravar
  // `sent` para algo que nunca saiu.
  if (!creds) {
    throw new Error("uazapi_not_configured: a sessão não tem servidor e token utilizáveis para esta instância.");
  }
  return creds;
}

async function chamar(
  creds: UazapiCredentials,
  caminho: string,
  corpo?: Record<string, unknown>,
  metodo: "GET" | "POST" = "POST",
): Promise<{ res: Response; json: Json }> {
  const res = await fetch(`${creds.baseUrl}${caminho}`, {
    method: metodo,
    headers: {
      token: creds.token,
      accept: "application/json",
      ...(corpo ? { "content-type": "application/json" } : {}),
    },
    ...(corpo ? { body: JSON.stringify(corpo) } : {}),
    signal: AbortSignal.timeout(PRAZO_MS),
  });
  const json = (await res.json().catch(() => null)) as Json;
  return { res, json };
}

/** O motivo que o servidor deu, sem nunca ecoar o token. */
function motivo(json: Json, res: Response): string {
  const texto = typeof json?.error === "string" ? json.error : typeof json?.message === "string" ? json.message : "";
  return `${res.status} ${texto || res.statusText}`.trim();
}

/** Só dígitos. `+55 (35) 9148-5627` → `553591485627`. */
function digitos(bruto: string): string {
  return bruto.replace(/\D/g, "");
}

/** `kind` do envelope → o `type` que o envio de mídia espera. */
function tipoDaMidia(kind: OutboundEnvelope["kind"]): string | null {
  switch (kind) {
    case "image":
      return "image";
    case "video":
      return "video";
    case "audio":
      // Mensagem de voz: o servidor converte, e é o que a capability
      // `voiceNote: "server-convert"` declara.
      return "ptt";
    case "document":
      return "document";
    case "sticker":
      return "sticker";
    default:
      return null;
  }
}

/** A URL é do nosso storage? Só essas o processo lê para mandar em base64. */
function ehDoNossoStorage(url: string): boolean {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  if (!base) return false;
  try {
    return new URL(url).host === new URL(base).host;
  } catch {
    return false;
  }
}

async function arquivoParaEnvio(url: string, mime: string): Promise<string> {
  if (!ehDoNossoStorage(url)) return url;

  const res = await fetch(url, { signal: AbortSignal.timeout(PRAZO_MS) });
  if (!res.ok) throw new Error(`uazapi_media_read_failed: ${res.status} ao ler a mídia do storage.`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.byteLength > TETO_DE_MIDIA_BYTES) {
    throw new Error(`uazapi_media_too_large: ${buffer.byteLength} bytes, teto de ${TETO_DE_MIDIA_BYTES}.`);
  }
  const tipo = res.headers.get("content-type")?.split(";")[0]?.trim() || mime || "application/octet-stream";
  return `data:${tipo};base64,${buffer.toString("base64")}`;
}

/** O id da mensagem na resposta do envio, nas formas que o servidor usa. */
function idDaMensagem(json: Json): string | null {
  if (!json) return null;
  const candidatos = [json.messageid, json.messageId, json.id, (json.key as Json)?.id];
  for (const c of candidatos) {
    if (typeof c === "string" && c.length > 0) return c;
  }
  return null;
}

async function baixarComGuarda(url: string, dica: string | null | undefined): Promise<FetchedMedia> {
  // A URL de download vem do servidor da instância, e em última análise de um
  // payload externo. O par textual + DNS é o mesmo do canal intermediado: recusa
  // esquema, faixa privada e rebinding antes de o processo buscar qualquer coisa.
  assertSafeOutboundUrl(url);
  await assertDestinoResolvidoSeguro(new URL(url).hostname);

  const res = await fetch(url, { signal: AbortSignal.timeout(PRAZO_MS) });
  if (!res.ok) throw new Error(`uazapi_media_failed: ${res.status} ${res.statusText}`.trim());
  const buffer = Buffer.from(await res.arrayBuffer());
  const mime = res.headers.get("content-type")?.split(";")[0]?.trim() || dica || "application/octet-stream";
  return { buffer, mime };
}

export const uazapiAdapter: ChannelAdapter = {
  provider: "uazapi",

  /**
   * Telefone em dígitos, chatid de grupo, ou o `@lid` quando só há identidade
   * opaca. `null` só quando não há endereço nenhum.
   */
  resolveRecipient(input: RecipientInput): string | null {
    if (input.isGroup) {
      return input.groupChatId && input.groupChatId.endsWith("@g.us") ? input.groupChatId : null;
    }

    const doIdentity = input.waIdentity?.startsWith("phone:")
      ? input.waIdentity.slice("phone:".length)
      : null;
    const telefone = digitos(doIdentity ?? input.phoneNumber ?? "");
    if (telefone.length >= 8) return telefone;

    const lid = input.waLid ?? (input.waIdentity?.startsWith("lid:") ? input.waIdentity.slice(4) : null);
    const lidDigitos = lid ? digitos(lid) : "";
    return lidDigitos.length > 0 ? `${lidDigitos}@lid` : null;
  },

  /**
   * SEMPRE `true`, pelo mesmo motivo do canal intermediado: a credencial vive na
   * SESSÃO, cifrada, e este método é síncrono e não consulta o banco. Quem
   * desiste sem credencial é `send`, que LANÇA com o motivo.
   */
  isConfigured(): boolean {
    return true;
  },

  async send(envelope: OutboundEnvelope): Promise<{ externalId: string | null }> {
    const creds = await credenciais(envelope);
    const citacao = envelope.replyToExternalId ? { replyid: envelope.replyToExternalId } : {};

    let caminho: string;
    let corpo: Record<string, unknown>;

    if (envelope.media) {
      const tipo = tipoDaMidia(envelope.kind);
      if (!tipo) {
        throw new Error(`uazapi_kind_not_supported: envio de ${envelope.kind} não suportado neste canal.`);
      }
      caminho = "/send/media";
      corpo = {
        number: envelope.to,
        type: tipo,
        file: await arquivoParaEnvio(envelope.media.url, envelope.media.mime),
        ...(envelope.media.caption ? { text: envelope.media.caption } : {}),
        ...(tipo === "document" && envelope.media.filename ? { docName: envelope.media.filename } : {}),
        ...citacao,
      };
    } else if (envelope.kind === "text") {
      caminho = "/send/text";
      corpo = { number: envelope.to, text: envelope.body ?? "", ...citacao };
    } else {
      throw new Error(`uazapi_kind_not_supported: envio de ${envelope.kind} não suportado neste canal.`);
    }

    await envelope.beforeSend?.();
    const { res, json } = await chamar(creds, caminho, corpo);
    if (!res.ok) throw new Error(`uazapi_send_failed: ${motivo(json, res)}`);

    return { externalId: idDaMensagem(json) };
  },

  async signalTyping(input: ChannelTenantScope & { sessionRef: string; recipient: string }): Promise<void> {
    const creds = await credenciais(input);
    // O servidor mantém o indicador aceso sozinho e o apaga quando a mensagem
    // sai; o `delay` só limita quanto tempo ele fica aceso se nada sair.
    const { res, json } = await chamar(creds, "/message/presence", {
      number: input.recipient,
      presence: "composing",
      delay: 15_000,
    });
    if (!res.ok) throw new Error(`uazapi_presence_failed: ${motivo(json, res)}`);
  },

  /**
   * O estado da instância segundo o servidor.
   *
   *   401/403        → o token não vale mais. FAILED: a credencial existe e foi recusada.
   *   `connected`    → WORKING.
   *   `connecting` e `disconnected` → SCAN_QR_CODE: nos dois casos o aparelho
   *                    precisa ser pareado de novo, que é a ação que o aviso pede.
   *   `hibernated`   → STOPPED: pausada no servidor, credencial preservada.
   *   rede/timeout   → `reachable: false`, sem status: não deu para perguntar
   *                    não é o mesmo que estar fora do ar.
   */
  async checkHealth(input: ChannelTenantScope & { sessionRef: string }): Promise<ChannelHealth> {
    let creds: UazapiCredentials;
    try {
      creds = await credenciais(input);
    } catch {
      return { reachable: false, status: null, detail: "sem_credencial_para_a_sessao" };
    }

    let res: Response;
    let json: Json;
    try {
      ({ res, json } = await chamar(creds, "/instance/status", undefined, "GET"));
    } catch (err) {
      const detail = err instanceof Error ? err.message : "erro_desconhecido";
      return { reachable: false, status: null, detail: detail.slice(0, 200) };
    }

    if (res.status === 401 || res.status === 403) {
      return { reachable: true, status: "FAILED", detail: "token_da_instancia_recusado" };
    }
    if (!res.ok) return { reachable: false, status: null, detail: `servidor_respondeu_${res.status}` };

    // A tradução mora em `../uazapi/saude`: o evento `connection` lê o MESMO
    // vocabulário, e duas cópias divergindo fariam a Central piscar sozinha.
    return saudeDoEstadoUazapi(String((json?.instance as Json)?.status ?? ""));
  },

  /** Foto do contato. URL assinada e temporária: quem chama baixa e guarda. */
  async fetchProfilePictureUrl(input: ChannelTenantScope & { sessionRef: string; recipient: string }): Promise<string | null> {
    const creds = await credenciais(input);
    const { res, json } = await chamar(creds, "/chat/details", { number: input.recipient, preview: false });
    if (!res.ok) return null;
    const url = [json?.image, json?.imagePreview].find((v) => typeof v === "string" && v.startsWith("http"));
    return (url as string | undefined) ?? null;
  },

  /**
   * Baixa a mídia que o cliente mandou.
   *
   * Aceita as duas formas que a ingestão pode gravar: um link já pronto, ou a
   * referência `uazapi-mensagem:<id>`, quando o evento não traz link. No segundo
   * caso o servidor gera o link público na hora (`/message/download`), e é esse
   * link que se baixa.
   */
  async fetchInboundMedia(input: ChannelTenantScope & {
    sessionRef: string;
    url: string;
    hintMime?: string | null;
  }): Promise<FetchedMedia> {
    if (!input.url.startsWith(UAZAPI_REFERENCIA_DE_MIDIA)) {
      return baixarComGuarda(input.url, input.hintMime);
    }

    const creds = await credenciais(input);
    const id = input.url.slice(UAZAPI_REFERENCIA_DE_MIDIA.length);
    const { res, json } = await chamar(creds, "/message/download", {
      id,
      return_link: true,
      return_base64: false,
      // Áudio no formato original (ogg/opus): é o que o player da tela toca, e
      // converter para mp3 no servidor custaria qualidade sem ganho aqui.
      generate_mp3: false,
    });
    if (!res.ok) throw new Error(`uazapi_media_failed: ${motivo(json, res)}`);

    const link = typeof json?.fileURL === "string" ? json.fileURL : null;
    if (!link) throw new Error("uazapi_media_failed: o servidor não devolveu link para a mídia.");
    const dica = typeof json?.mimetype === "string" ? json.mimetype : input.hintMime;
    return baixarComGuarda(link, dica);
  },

  codes: {
    notConfigured: "uazapi_not_configured",
    sendFailed: "uazapi_error",
    unknownError: "uazapi_unknown",
  },
};
