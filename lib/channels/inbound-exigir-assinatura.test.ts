/**
 * D-043: "exigir assinatura no webhook" (`platform_settings.exigir_assinatura_no_webhook`,
 * gravada em `/admin/sistema`) não alcançava `verifyInboundWebhookSignature`, o
 * portão da rota genérica de canal. A UAZAPI não assina o corpo: o que ela tem
 * é um token repetido dentro do payload, e só para o evento `messages`, então
 * com a opção ligada o admin acreditava que toda entrada exigia assinatura, e a
 * UAZAPI seguia entrando sem.
 *
 * Este arquivo prova o portão sozinho, manipulando a MEMÓRIA do processo do
 * jeito que `carregarComportamento` a preenche (o mesmo caminho real da rota,
 * sem precisar montar o banco inteiro). Ver
 * `lib/instalacao/comportamento.ts` e `tests/unit/portao-do-webhook-le-a-instalacao-no-processo-frio.test.ts`
 * para o defeito irmão (WAHA) que motivou o padrão.
 */
import { createHmac } from "node:crypto";

import { beforeEach, describe, expect, it } from "vitest";

import { CHANNEL_PROVIDER_UAZAPI, CHANNEL_PROVIDER_ZERNIO } from "@/lib/channels/capabilities";
import { verifyInboundWebhookSignature } from "@/lib/channels/inbound";
import {
  carregarComportamento,
  esquecerComportamento,
  type ComportamentoDaInstalacao,
} from "@/lib/instalacao/comportamento";

const TOKEN = "0a1b2c3d-aa11-4b2c-bbbb-a123b4c5d6e7";
const ZERNIO_SECRET = "segredo-zernio-bem-longo-o-suficiente";

const PISO: ComportamentoDaInstalacao = {
  orcamento_de_ia: "off",
  exigir_assinatura_no_webhook: false,
  divulgacao_de_pagamento: "inject",
  promessa_semantica: true,
};

/** Instala no processo o valor que a tela de /admin/sistema teria gravado. */
async function ligarExigenciaDeAssinatura(exigir: boolean): Promise<void> {
  await carregarComportamento(
    async () => ({ exigir_assinatura_no_webhook: exigir }),
    PISO,
  );
}

function corpoDeMensagemUazapi(token: string | null = TOKEN): string {
  return JSON.stringify({
    EventType: "messages",
    instanceName: "comercial",
    owner: "553599990000",
    token,
    chat: { wa_chatid: "553591234567@s.whatsapp.net" },
    message: { messageid: "3EB0AAAA1111", fromMe: false, text: "oi" },
  });
}

function assinaturaZernio(raw: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(raw, "utf8").digest("hex")}`;
}

beforeEach(() => {
  // Processo recém-subido: nenhuma leitura nesta vida do processo.
  esquecerComportamento();
});

describe("opção LIGADA: a UAZAPI não sabe assinar, então é recusada", () => {
  it("evento de mensagem com token CERTO no corpo ainda assim é recusado", async () => {
    await ligarExigenciaDeAssinatura(true);
    const raw = corpoDeMensagemUazapi();

    expect(verifyInboundWebhookSignature(CHANNEL_PROVIDER_UAZAPI, raw, new Headers(), TOKEN)).toBe(
      false,
    );
  });

  it("evento que antes passava sem token nenhum (`connection`) também é recusado", async () => {
    await ligarExigenciaDeAssinatura(true);
    const raw = JSON.stringify({ EventType: "connection", owner: "553599990000" });

    expect(verifyInboundWebhookSignature(CHANNEL_PROVIDER_UAZAPI, raw, new Headers(), TOKEN)).toBe(
      false,
    );
  });

  it("um provider que JÁ assina (Zernio) continua aceitando assinatura válida", async () => {
    await ligarExigenciaDeAssinatura(true);
    const raw = JSON.stringify({ event: "message" });
    const headers = new Headers({ "x-zernio-signature": assinaturaZernio(raw, ZERNIO_SECRET) });

    expect(
      verifyInboundWebhookSignature(CHANNEL_PROVIDER_ZERNIO, raw, headers, ZERNIO_SECRET),
    ).toBe(true);
  });

  it("e o mesmo provider recusa assinatura errada, como sempre recusou", async () => {
    await ligarExigenciaDeAssinatura(true);
    const raw = JSON.stringify({ event: "message" });
    const headers = new Headers({ "x-zernio-signature": "sha256=" + "0".repeat(64) });

    expect(
      verifyInboundWebhookSignature(CHANNEL_PROVIDER_ZERNIO, raw, headers, ZERNIO_SECRET),
    ).toBe(false);
  });
});

describe("opção DESLIGADA: comportamento de antes, sem mudança", () => {
  it("UAZAPI com token certo no evento de mensagem passa, como sempre passou", async () => {
    await ligarExigenciaDeAssinatura(false);
    const raw = corpoDeMensagemUazapi();

    expect(verifyInboundWebhookSignature(CHANNEL_PROVIDER_UAZAPI, raw, new Headers(), TOKEN)).toBe(
      true,
    );
  });

  it("UAZAPI com token errado no evento de mensagem continua recusada pela camada fraca", async () => {
    await ligarExigenciaDeAssinatura(false);
    const raw = corpoDeMensagemUazapi(TOKEN.replace(/a/g, "b"));

    expect(verifyInboundWebhookSignature(CHANNEL_PROVIDER_UAZAPI, raw, new Headers(), TOKEN)).toBe(
      false,
    );
  });
});

describe("processo frio: sem NENHUMA leitura da instalação nesta vida do processo", () => {
  it("o piso (sem linha no banco) é NÃO exigir: mantém o comportamento de sempre", () => {
    // Nem `carregarComportamento` foi chamado: é exatamente o estado de um
    // processo recém-subido antes de qualquer rota rodar.
    const raw = corpoDeMensagemUazapi();
    expect(verifyInboundWebhookSignature(CHANNEL_PROVIDER_UAZAPI, raw, new Headers(), TOKEN)).toBe(
      true,
    );
  });
});
