import { describe, expect, it } from "vitest";

import { lerEnvelopeUazapi, type UazapiEnvelope } from "@/lib/channels/uazapi/envelope";
import { parseUazapiMensagem, tokenDoEventoConfere } from "@/lib/channels/uazapi/webhook";

/**
 * Leitura do webhook da instância UAZAPI — puro, sem banco nem rede.
 *
 * A forma dos payloads abaixo segue os webhooks REAIS capturados na instalação
 * (evento `messages`): `EventType`, `token` da instância, `chat` e `message`,
 * com `messageid` como id do WhatsApp e `sender_pn` trazendo o telefone quando o
 * remetente aparece por `@lid`. Os valores são inventados: nenhum dado de
 * cliente entra no repositório.
 */

const TOKEN = "0a1b2c3d-aa11-4b2c-bbbb-a123b4c5d6e7";

function evento(message: Record<string, unknown>, extra: Record<string, unknown> = {}): UazapiEnvelope {
  const bruto = {
    EventType: "messages",
    BaseUrl: "https://empresa.uazapi.com",
    instanceName: "comercial",
    owner: "553599990000",
    token: TOKEN,
    chat: { wa_chatid: message.chatid, wa_name: "Cliente Teste" },
    message: {
      messageid: "3EB0AAAA1111",
      chatid: "553591234567@s.whatsapp.net",
      isGroup: false,
      fromMe: false,
      wasSentByApi: false,
      messageType: "Conversation",
      messageTimestamp: 1_789_500_000_000,
      senderName: "Maria",
      text: "quero um orçamento",
      ...message,
    },
    ...extra,
  };
  const leitura = lerEnvelopeUazapi(JSON.stringify(bruto));
  if (!leitura.ok) throw new Error("payload de teste fora do contrato");
  return leitura.envelope;
}

describe("tokenDoEventoConfere", () => {
  it("só passa com o token exato da instância", () => {
    expect(tokenDoEventoConfere(TOKEN, TOKEN)).toBe(true);
    expect(tokenDoEventoConfere(TOKEN.replace("a", "b"), TOKEN)).toBe(false);
    expect(tokenDoEventoConfere("curto", TOKEN)).toBe(false);
  });

  it("sem token de um dos lados recusa, não deixa passar", () => {
    expect(tokenDoEventoConfere(null, TOKEN)).toBe(false);
    expect(tokenDoEventoConfere(TOKEN, null)).toBe(false);
    expect(tokenDoEventoConfere("", "")).toBe(false);
  });
});

describe("parseUazapiMensagem", () => {
  it("texto de conversa individual vira entrada com telefone, nome e hora", () => {
    const r = parseUazapiMensagem(evento({}));
    expect(r).toEqual({
      ok: true,
      msg: {
        direction: "inbound",
        viaApi: false,
        externalId: "3EB0AAAA1111",
        chatId: "553591234567@s.whatsapp.net",
        phone: "+553591234567",
        lid: null,
        displayName: "Maria",
        text: "quero um orçamento",
        tipo: "text",
        mime: null,
        sentAt: new Date(1_789_500_000_000).toISOString(),
        quotedExternalId: null,
      },
    });
  });

  it("grupo é ignorado: um grupo inteiro não é um lead", () => {
    expect(parseUazapiMensagem(evento({ chatid: "120363000000000000@g.us", isGroup: true }))).toEqual({
      ok: false,
      motivo: "grupo",
    });
  });

  it("remetente por @lid pega o telefone do sender_pn e guarda o lid", () => {
    const r = parseUazapiMensagem(
      evento({ chatid: "111122223333444@lid", sender: "111122223333444@lid", sender_pn: "553591234567@s.whatsapp.net" }),
    );
    expect(r.ok && r.msg.phone).toBe("+553591234567");
    expect(r.ok && r.msg.lid).toBe("111122223333444");
  });

  it("envio pelo aparelho NÃO usa o sender_pn, que é o número da própria empresa", () => {
    const r = parseUazapiMensagem(
      evento(
        { chatid: "111122223333444@lid", fromMe: true, sender_pn: "553599990000@s.whatsapp.net", senderName: "Empresa" },
        { chat: { wa_chatid: "111122223333444@lid", wa_contactName: "Maria da Loja" } },
      ),
    );
    expect(r.ok && r.msg.direction).toBe("outbound");
    expect(r.ok && r.msg.phone).toBeNull();
    expect(r.ok && r.msg.lid).toBe("111122223333444");
    expect(r.ok && r.msg.displayName).toBe("Maria da Loja");
  });

  /**
   * D-023: a primeira versão descartava tudo que saiu pela API como "eco do
   * próprio envio". Só que outro sistema no mesmo número também manda pela API,
   * e essas mensagens sumiam da conversa do CRM.
   */
  it("saída mandada pela API ENTRA, marcada como via API", () => {
    const r = parseUazapiMensagem(evento({ fromMe: true, wasSentByApi: true, text: "seu pedido saiu" }));
    expect(r.ok).toBe(true);
    expect(r.ok && r.msg.direction).toBe("outbound");
    expect(r.ok && r.msg.viaApi).toBe(true);
  });

  it("digitada no aparelho não é via API, e entrada nunca é", () => {
    const aparelho = parseUazapiMensagem(evento({ fromMe: true, wasSentByApi: false }));
    expect(aparelho.ok && aparelho.msg.viaApi).toBe(false);
    // Flag incoerente do servidor (entrada marcada como API) não vira saída de ninguém.
    const entrada = parseUazapiMensagem(evento({ fromMe: false, wasSentByApi: true }));
    expect(entrada.ok && entrada.msg.viaApi).toBe(false);
  });

  it("imagem com legenda traz o tipo, o texto da legenda e o mime", () => {
    const r = parseUazapiMensagem(
      evento({ messageType: "ImageMessage", text: "", content: { caption: "veja a foto", mimetype: "image/jpeg" } }),
    );
    expect(r.ok && r.msg.tipo).toBe("image");
    expect(r.ok && r.msg.text).toBe("veja a foto");
    expect(r.ok && r.msg.mime).toBe("image/jpeg");
  });

  it("áudio sem texto não inventa corpo", () => {
    const r = parseUazapiMensagem(evento({ messageType: "AudioMessage", text: "", content: { mimetype: "audio/ogg; codecs=opus" } }));
    expect(r.ok && r.msg.tipo).toBe("audio");
    expect(r.ok && r.msg.text).toBeNull();
  });

  it("reação, protocolo e edição ficam de fora: não são conteúdo de conversa", () => {
    for (const t of ["ReactionMessage", "ProtocolMessage", "EditedMessage", "PollUpdateMessage"]) {
      expect(parseUazapiMensagem(evento({ messageType: t }))).toEqual({
        ok: false,
        motivo: `tipo_nao_suportado:${t}`,
      });
    }
  });

  /**
   * Medido num webhook real da instalação: chegou uma `TemplateMessage` de
   * empresa, com `text` preenchido, numa conversa individual. A primeira versão
   * a descartava por não reconhecer o tipo — a mensagem do cliente sumia com
   * carimbo de normalidade, que é o defeito que o canal intermediado já pagou.
   */
  it("tipo desconhecido COM texto entra como texto, em vez de sumir", () => {
    const r = parseUazapiMensagem(evento({ messageType: "TemplateMessage", text: "sua consulta foi confirmada" }));
    expect(r.ok && r.msg.tipo).toBe("text");
    expect(r.ok && r.msg.text).toBe("sua consulta foi confirmada");
  });

  it("tipo desconhecido SEM texto continua ignorado, com o tipo nomeado", () => {
    expect(parseUazapiMensagem(evento({ messageType: "LocationMessage", text: "" }))).toEqual({
      ok: false,
      motivo: "tipo_nao_suportado:LocationMessage",
    });
  });

  it("evento que não é de mensagem não é lido como mensagem", () => {
    expect(parseUazapiMensagem(evento({}, { EventType: "connection" }))).toEqual({
      ok: false,
      motivo: "evento_sem_interesse",
    });
  });
});
