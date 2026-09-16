import { describe, expect, it } from "vitest";

import {
  aplicarStatusUazapi,
  lerAtualizacaoUazapi,
  parseUazapiAtualizacao,
  type UazapiAtualizacao,
} from "@/lib/channels/uazapi/status";

/**
 * Confirmação de entrega da instância UAZAPI (`messages_update`).
 *
 * A forma vem dos eventos REAIS capturados na instalação: `state` com
 * "Delivered"/"Read", `type` "ReadReceipt" e `event.MessageIDs` — uma LISTA, que
 * num recibo de leitura chega com várias mensagens de uma vez. Os valores são
 * inventados: nenhum dado de cliente entra no repositório.
 */

function atualizacao(extra: Record<string, unknown>): UazapiAtualizacao {
  const bruto = {
    EventType: "messages_update",
    BaseUrl: "https://empresa.uazapi.com",
    instanceName: "comercial",
    owner: "553599990000",
    state: "Delivered",
    type: "ReadReceipt",
    event: {
      Chat: "553591234567@s.whatsapp.net",
      Sender: "553591234567@s.whatsapp.net",
      IsFromMe: true,
      IsGroup: false,
      MessageIDs: ["3EB0AAAA1111"],
      Type: "Delivered",
    },
    ...extra,
  };
  const leitura = lerAtualizacaoUazapi(JSON.stringify(bruto));
  if (!leitura.ok) throw new Error("payload de teste fora do contrato");
  return leitura.envelope;
}

/** Cliente de banco falso: registra a cadeia chamada e devolve o que o teste mandar. */
function bancoFalso(linhas: { id: string }[]) {
  const chamadas: unknown[][] = [];
  const q: Record<string, unknown> = {};
  for (const metodo of ["update", "eq", "in", "not"]) {
    q[metodo] = (...args: unknown[]) => {
      chamadas.push([metodo, ...args]);
      return q;
    };
  }
  q.select = (...args: unknown[]) => {
    chamadas.push(["select", ...args]);
    return Promise.resolve({ data: linhas, error: null });
  };
  return {
    admin: {
      from: (tabela: string) => {
        chamadas.push(["from", tabela]);
        return q;
      },
    },
    chamadas,
  };
}

describe("parseUazapiAtualizacao", () => {
  it("entrega e leitura viram desfecho; áudio ouvido conta como leitura", () => {
    expect(parseUazapiAtualizacao(atualizacao({}))).toEqual({
      ok: true,
      atualizacao: { externalIds: ["3EB0AAAA1111"], status: "delivered" },
    });
    expect(parseUazapiAtualizacao(atualizacao({ state: "Read" }))).toMatchObject({
      ok: true,
      atualizacao: { status: "read" },
    });
    expect(parseUazapiAtualizacao(atualizacao({ state: "Played" }))).toMatchObject({
      ok: true,
      atualizacao: { status: "read" },
    });
  });

  it("um recibo confirma VÁRIAS mensagens, sem repetir id", () => {
    const r = parseUazapiAtualizacao(
      atualizacao({
        state: "Read",
        event: { MessageIDs: ["3EB0A", "3EB0B", "3EB0A"], Chat: "553591234567@s.whatsapp.net" },
      }),
    );
    expect(r.ok && r.atualizacao.externalIds).toEqual(["3EB0A", "3EB0B"]);
  });

  it("mídia guardada pelo servidor não é desfecho de entrega, e diz isso", () => {
    expect(parseUazapiAtualizacao(atualizacao({ state: "FileDownloaded", type: "FileDownloadedMessage" }))).toEqual({
      ok: false,
      motivo: "estado_sem_interesse:FileDownloaded",
    });
  });

  it("recibo sem mensagem nenhuma é ignorado com o motivo nomeado", () => {
    expect(parseUazapiAtualizacao(atualizacao({ event: { MessageIDs: [] } }))).toEqual({
      ok: false,
      motivo: "atualizacao_sem_mensagem",
    });
  });

  it("evento de mensagem não entra por aqui", () => {
    expect(parseUazapiAtualizacao(atualizacao({ EventType: "messages" }))).toEqual({
      ok: false,
      motivo: "evento_sem_interesse",
    });
  });
});

describe("aplicarStatusUazapi", () => {
  it("atualiza pelas chaves da organização e NÃO rebaixa quem já foi lida", async () => {
    const { admin, chamadas } = bancoFalso([{ id: "m1" }]);

    const r = await aplicarStatusUazapi(admin as never, {
      organizationId: "org-1",
      externalIds: ["3EB0A", "3EB0B"],
      status: "delivered",
    });

    expect(r).toEqual({ atualizadas: 1 });
    expect(chamadas).toEqual([
      ["from", "messages"],
      ["update", { status: "delivered" }],
      ["eq", "organization_id", "org-1"],
      ["in", "external_id", ["3EB0A", "3EB0B"]],
      ["not", "status", "in", "(read)"],
      ["select", "id"],
    ]);
  });

  it("nenhuma linha afetada não é erro: o recibo pode ser de mensagem que não é nossa", async () => {
    const { admin } = bancoFalso([]);
    expect(await aplicarStatusUazapi(admin as never, { organizationId: "org-1", externalIds: ["x"], status: "read" })).toEqual({
      atualizadas: 0,
    });
  });
});
