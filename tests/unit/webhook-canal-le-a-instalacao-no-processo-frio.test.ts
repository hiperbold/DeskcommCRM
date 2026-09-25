/**
 * D-043: o mesmo defeito do processo frio (ver
 * `portao-do-webhook-le-a-instalacao-no-processo-frio.test.ts`, o irmão do
 * WAHA), agora na rota genérica de canal.
 *
 * `verifyInboundWebhookSignature` decide "exigir assinatura" lendo a MEMÓRIA
 * do processo, síncrona. A rota `app/api/v1/webhooks/channel/[token]/route.ts`
 * não chamava `carregarComportamentoDaInstalacao()`: até alguém abrir
 * `/admin/sistema` (ou outra tela que carregasse a linha) neste processo, a
 * escolha salva na tela não valia para a entrada de mensagens, e a UAZAPI, que
 * não assina o corpo, continuava aceita mesmo com a opção ligada.
 *
 * Este arquivo chama o `POST` da rota com a memória VAZIA (o estado de um
 * processo recém-subido) e só o banco (mockado) sabe a escolha.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { linhaDaInstalacao, leiturasDaInstalacao } = vi.hoisted(() => ({
  linhaDaInstalacao: { atual: null as Record<string, unknown> | null },
  leiturasDaInstalacao: { n: 0 },
}));

const SESSAO = {
  id: "sess-uazapi-1",
  organization_id: "org-1",
  provider: "uazapi",
  display_name: "Comercial",
  phone_number: "+553599990000",
  webhook_secret_encrypted: "\\x00",
  archived_at: null as string | null,
};

const TOKEN_DA_INSTANCIA = "0a1b2c3d-aa11-4b2c-bbbb-a123b4c5d6e7";

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      if (tabela === "platform_settings") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => {
                leiturasDaInstalacao.n += 1;
                return { data: linhaDaInstalacao.atual, error: null };
              },
            }),
          }),
        };
      }
      throw new Error(`tabela inesperada no teste: ${tabela}`);
    },
  }),
}));

vi.mock("@/lib/channels", () => ({
  CHANNEL_SESSION_REF_COLUMNS: "uazapi_instance_id",
  resolveSessionRef: () => "instance-opaca-1",
}));

vi.mock("@/lib/channels/archived", () => ({
  ARCHIVED_AT: "archived_at",
  queryTolerantToMissingArchived: async () => ({ data: SESSAO, error: null }),
}));

vi.mock("@/lib/channels/arquivo-de-webhook", () => ({
  abrirArquivoDoWebhook: async () => ({ id: "arquivo-1" }),
  fecharArquivoDoWebhook: async () => undefined,
}));

vi.mock("@/lib/webhooks/secrets", () => ({
  // O SEGREDO CERTO da instância: prova que a recusa com a opção ligada não é
  // "faltou segredo", é "este canal não sabe assinar".
  decryptWebhookSecret: async () => TOKEN_DA_INSTANCIA,
}));

import { POST } from "@/app/api/v1/webhooks/channel/[token]/route";
import { esquecerComportamento, comportamentoEmVigor } from "@/lib/instalacao/comportamento";

const ctx = { params: Promise.resolve({ token: "token-da-sessao-uazapi" }) };

function corpoDeMensagem(): Request {
  const corpo = JSON.stringify({
    EventType: "messages",
    instanceName: "comercial",
    owner: "553599990000",
    token: TOKEN_DA_INSTANCIA,
    chat: { wa_chatid: "553591234567@s.whatsapp.net" },
    message: { messageid: "3EB0AAAA1111", fromMe: false, text: "oi" },
  });
  return new Request("http://localhost/api/v1/webhooks/channel/token-da-sessao-uazapi", {
    method: "POST",
    body: corpo,
    headers: { "content-type": "application/json" },
  }) as never;
}

const linha = (exigir: boolean | null) => ({
  orcamento_de_ia: null,
  exigir_assinatura_no_webhook: exigir,
  divulgacao_de_pagamento: null,
  promessa_semantica: null,
});

beforeEach(() => {
  // O processo recém-subido: nenhuma leitura nesta vida do processo.
  esquecerComportamento();
  leiturasDaInstalacao.n = 0;
});

describe("rota de canal: processo frio obedece à instalação, não ao piso do .env", () => {
  it("a tela EXIGE assinatura: mesmo com o TOKEN certo no corpo, a UAZAPI é recusada", async () => {
    linhaDaInstalacao.atual = linha(true);
    expect(comportamentoEmVigor(), "a memória devia começar vazia").toBeNull();

    const res = (await POST(corpoDeMensagem() as never, ctx)) as Response;

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({
      error: { code: "unauthorized", message: "bad_signature" },
    });
    expect(leiturasDaInstalacao.n, "a rota não leu a linha da instalação").toBeGreaterThan(0);
  });

  it("a tela DISPENSA assinatura: o token certo no corpo continua sendo aceito", async () => {
    linhaDaInstalacao.atual = linha(false);

    const res = (await POST(corpoDeMensagem() as never, ctx)) as Response;

    expect(res.status).not.toBe(401);
  });

  it("sem linha (a instalação nunca abriu a tela), vale o piso, o de antes (não exige)", async () => {
    linhaDaInstalacao.atual = null;

    const res = (await POST(corpoDeMensagem() as never, ctx)) as Response;

    expect(res.status).not.toBe(401);
  });
});
