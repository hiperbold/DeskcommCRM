/**
 * Entrada da instância UAZAPI — autenticação e leitura do payload.
 *
 * PURO de propósito, como o irmão do canal intermediado: nada aqui toca banco,
 * rede ou relógio. A rota e a ingestão fazem o efeito; aqui só se decide o que o
 * payload diz. É o que permite provar os casos difíceis (token errado, grupo,
 * contato só com id opaco, envio feito pelo celular) sem subir infraestrutura.
 */
import { timingSafeEqual } from "node:crypto";

import type { UazapiEnvelope, UazapiMessage } from "./envelope";

/**
 * O token repetido no evento é o da instância desta sessão?
 *
 * Tempo constante e comprimento conferido ANTES: `timingSafeEqual` lança com
 * tamanhos diferentes, e um throw viraria 500 em vez de 401. Sem token de um
 * dos lados NÃO é "passa": é "não dá para verificar", e isso recusa.
 */
export function tokenDoEventoConfere(tokenDoEvento: string | null | undefined, tokenDaSessao: string | null): boolean {
  if (!tokenDoEvento || !tokenDaSessao) return false;
  const a = Buffer.from(tokenDoEvento, "utf8");
  const b = Buffer.from(tokenDaSessao, "utf8");
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

/** Vocabulário de `messages.type` que esta entrada produz. */
export type UazapiTipoDeMensagem = "text" | "image" | "video" | "audio" | "document" | "sticker";

export interface UazapiMensagemLida {
  /** `outbound` = saiu pela instância: digitada no aparelho, mandada por outro sistema pela API, ou o eco do nosso próprio envio. */
  direction: "inbound" | "outbound";
  /**
   * A saída foi mandada pela API da instância (`wasSentByApi`), e não digitada
   * no aparelho. Pode ser o eco do CRM ou outro sistema no mesmo número: quem
   * separa os dois é a ingestão, que enxerga os envios em voo.
   */
  viaApi: boolean;
  /** `messageid` do WhatsApp — chave de idempotência. */
  externalId: string;
  /** Chat da conversa (`...@s.whatsapp.net` ou `...@lid`). */
  chatId: string;
  /** E.164 com `+`, quando o evento revela o telefone do contato. */
  phone: string | null;
  /** Dígitos do `@lid` do contato, quando houver. */
  lid: string | null;
  displayName: string | null;
  text: string | null;
  tipo: UazapiTipoDeMensagem;
  /** Mime declarado no evento, quando a mensagem é de mídia. Dica, não verdade. */
  mime: string | null;
  sentAt: string | null;
  /** Id da mensagem citada, quando é resposta. */
  quotedExternalId: string | null;
}

export type LeituraDaMensagem =
  | { ok: true; msg: UazapiMensagemLida }
  /** O motivo vai para o arquivo do webhook: é o que se lê quando "sumiu". */
  | { ok: false; motivo: string };

type Bruto = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === "string" && v.trim().length > 0 ? v.trim() : null);
const obj = (v: unknown): Bruto | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Bruto) : null);

/** `553591485627@s.whatsapp.net` → `+553591485627`; qualquer outro domínio → null. */
function telefoneDoJid(jid: string | null): string | null {
  if (!jid) return null;
  const [usuario, dominio] = jid.split("@");
  if (dominio !== "s.whatsapp.net" && dominio !== "c.us") return null;
  const digitos = (usuario ?? "").split(":")[0]?.replace(/\D/g, "") ?? "";
  return digitos.length >= 8 ? `+${digitos}` : null;
}

/** `123456789012345@lid` → `123456789012345`; outro domínio → null. */
function lidDoJid(jid: string | null): string | null {
  if (!jid) return null;
  const [usuario, dominio] = jid.split("@");
  if (dominio !== "lid") return null;
  const digitos = (usuario ?? "").split(":")[0]?.replace(/\D/g, "") ?? "";
  return digitos.length > 0 ? digitos : null;
}

/**
 * `messageType` do servidor → tipo do CRM. `null` = mensagem que não é conteúdo
 * de conversa (reação, protocolo, edição) ou que esta entrada ainda não traduz.
 */
function tipoDaMensagem(m: UazapiMessage): UazapiTipoDeMensagem | null {
  const t = (str(m.messageType) ?? "").toLowerCase();
  if (t === "conversation" || t === "extendedtextmessage") return "text";
  if (t.startsWith("image")) return "image";
  if (t.startsWith("video")) return "video";
  if (t.startsWith("audio") || t === "pttmessage") return "audio";
  if (t.startsWith("document")) return "document";
  if (t.startsWith("sticker")) return "sticker";
  return null;
}

/** Milissegundos ou segundos → ISO. O servidor manda ms; segundos não custam aceitar. */
function carimbo(v: unknown): string | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n < 1e12 ? n * 1000 : n).toISOString();
}

/**
 * Lê o evento `messages`. Não lança: evento que não interessa devolve o motivo,
 * e a rota responde 200 para o servidor não reentregar para sempre.
 */
export function parseUazapiMensagem(env: UazapiEnvelope): LeituraDaMensagem {
  if (str(env.EventType) !== "messages") return { ok: false, motivo: "evento_sem_interesse" };

  const m = env.message;
  if (!m) return { ok: false, motivo: "evento_sem_mensagem" };

  const chatId = str(m.chatid);
  const externalId = str(m.messageid);
  if (!chatId || !externalId) return { ok: false, motivo: "mensagem_sem_identificador" };

  // Grupo NÃO vira contato nem conversa de CRM: mesma regra do canal por QR
  // (`CLAUDE.md`, seção WAHA). Um grupo inteiro não é um lead.
  if (m.isGroup === true || chatId.endsWith("@g.us")) return { ok: false, motivo: "grupo" };

  // O que saiu pela API NÃO é descartado aqui. Pode ser outro sistema falando
  // pelo mesmo número, e essa mensagem precisa aparecer na conversa. O eco do
  // próprio CRM se resolve com o id: ver `registrarWebhookUazapi`.
  const saida = m.fromMe === true;
  const chat = env.chat ?? null;

  // ─── De quem é o CONTATO, e por que depende da direção ─────────────────────
  //
  // O chat é SEMPRE a conversa com o contato, nas duas direções — então o
  // telefone sai dele primeiro. Quando o chat é um `@lid`, o telefone só está no
  // `sender_pn`, e numa mensagem de saída o remetente somos NÓS: usá-lo criaria
  // um contato com o número da própria empresa.
  const phone =
    telefoneDoJid(chatId) ??
    telefoneDoJid(str(chat?.wa_chatid)) ??
    (!saida ? telefoneDoJid(str(m.sender_pn)) : null);
  const lid =
    lidDoJid(chatId) ??
    lidDoJid(str(m.chatlid)) ??
    lidDoJid(str(chat?.wa_chatlid)) ??
    (!saida ? lidDoJid(str(m.sender_lid)) ?? lidDoJid(str(m.sender)) : null);

  const displayName = saida
    ? str(chat?.wa_contactName) ?? str(chat?.wa_name) ?? str(chat?.name)
    : str(m.senderName) ?? str(chat?.wa_contactName) ?? str(chat?.wa_name);

  const conteudo = m.content;
  const conteudoObj = obj(conteudo);
  const text =
    str(m.text) ??
    (typeof conteudo === "string" ? str(conteudo) : null) ??
    str(conteudoObj?.caption) ??
    str(conteudoObj?.text);

  // ─── O tipo vem DEPOIS do texto, e não antes ──────────────────────────────
  //
  // Medido num webhook real: chegou uma `TemplateMessage` de empresa, numa
  // conversa individual, com `text` preenchido. Decidir só pelo `messageType`
  // fazia essa mensagem — e as de botão, lista e interativas — serem
  // descartadas como "tipo não suportado": sumiam com carimbo de normalidade,
  // que é o pior desfecho possível para a mensagem de um cliente.
  //
  // Então: tipo que a gente traduz, vale o que ele diz. Tipo desconhecido QUE
  // TRAZ TEXTO entra como texto, porque é isso que ele é para quem atende. E os
  // que nunca são conteúdo de conversa ficam de fora mesmo com texto junto —
  // uma reação não é uma mensagem nova, e gravá-la duplicaria a conversa.
  const semConteudoDeConversa = new Set(["reaction", "protocol", "edited", "pollupdate", "keepinchat"]);
  const rotuloDoTipo = (str(m.messageType) ?? "").toLowerCase();
  const tipo =
    tipoDaMensagem(m) ??
    ([...semConteudoDeConversa].some((t) => rotuloDoTipo.startsWith(t)) || !text ? null : "text");
  if (!tipo) return { ok: false, motivo: `tipo_nao_suportado:${str(m.messageType) ?? "vazio"}` };

  return {
    ok: true,
    msg: {
      direction: saida ? "outbound" : "inbound",
      viaApi: saida && m.wasSentByApi === true,
      externalId,
      chatId,
      phone,
      lid,
      displayName,
      text: tipo === "text" || text ? text : null,
      tipo,
      mime: tipo === "text" ? null : str(conteudoObj?.mimetype) ?? str(conteudoObj?.mimeType),
      sentAt: carimbo(m.messageTimestamp),
      quotedExternalId: str(m.quoted),
    },
  };
}
