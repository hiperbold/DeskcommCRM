/**
 * D-043: o processo frio (ver
 * `portao-do-webhook-le-a-instalacao-no-processo-frio.test.ts`, o irmão do
 * WAHA), agora na rota genérica de canal.
 *
 * A rota `app/api/v1/webhooks/channel/[token]/route.ts` chama
 * `carregarComportamentoDaInstalacao()` ANTES de `verifyInboundWebhookSignature`
 *, sem isso, um processo recém-subido responderia com o piso do `.env` até
 * alguém abrir outra tela que carregasse a linha, e a escolha feita em
 * `/admin/sistema` não valeria enquanto isso. Este conserto continua valendo
 * e é o que este arquivo prova (`leiturasDaInstalacao.n > 0`).
 *
 * O que MUDOU: "exigir assinatura no webhook" NÃO se aplica à UAZAPI (decisão
 * revisada de D-043, ver `lib/channels/inbound.ts`). A UAZAPI não assina o
 * corpo, nunca assinou,, e sua proteção estrutural (token do evento +
 * conferência de dono) não muda com esta opção, ligada ou desligada. Por
 * isso os três cenários abaixo aceitam o token certo da UAZAPI
 * independentemente do valor da linha: o que este arquivo prova agora é que
 * a leitura fria acontece, não que ela derruba o canal.
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

describe("rota de canal: a leitura fria acontece, mas a opção não alcança a UAZAPI", () => {
  it("a tela EXIGE assinatura: mesmo assim, o TOKEN certo no corpo da UAZAPI é aceito, e a rota LEU a linha", async () => {
    linhaDaInstalacao.atual = linha(true);
    expect(comportamentoEmVigor(), "a memória devia começar vazia").toBeNull();

    const res = (await POST(corpoDeMensagem() as never, ctx)) as Response;

    expect(res.status).not.toBe(401);
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
