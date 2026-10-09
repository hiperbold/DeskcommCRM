import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * B1: o endereço de volta que o CRM registra no servidor de WhatsApp vem SÓ de NEXT_PUBLIC_APP_URL.
 * O cabeçalho `Origin` e o host da requisição são escolhidos por quem chama; usá-los deixaria um admin
 * apontar a entrega das mensagens do cliente para um endereço dele. Sem a variável: `null`.
 */

const envFalso = vi.hoisted(() => ({}) as { NEXT_PUBLIC_APP_URL?: string });
vi.mock("@/lib/env", () => ({ env: envFalso }));

import { urlDoWebhookDeCanal } from "@/lib/channels/url-do-webhook";

afterEach(() => {
  delete envFalso.NEXT_PUBLIC_APP_URL;
});

const pedidoComOrigin = {
  headers: { get: (nome: string) => (nome.toLowerCase() === "origin" ? "https://atacante.exemplo.com" : null) },
  nextUrl: { protocol: "https:", host: "atacante.exemplo.com" },
};

describe("urlDoWebhookDeCanal", () => {
  it("sem NEXT_PUBLIC_APP_URL devolve null, mesmo que alguém passe uma requisição com Origin", () => {
    const comRequisicao = urlDoWebhookDeCanal as unknown as (req: unknown) => ReturnType<typeof urlDoWebhookDeCanal>;
    expect(comRequisicao(pedidoComOrigin)).toBeNull();
    expect(urlDoWebhookDeCanal()).toBeNull();
  });

  it("com o placeholder de build também é null", () => {
    envFalso.NEXT_PUBLIC_APP_URL = "https://placeholder.invalid";
    expect(urlDoWebhookDeCanal()).toBeNull();
  });

  it("com a variável configurada, monta a URL dela (sem barra no fim) e ignora o Origin", () => {
    envFalso.NEXT_PUBLIC_APP_URL = "https://crm.exemplo.com/";
    const comRequisicao = urlDoWebhookDeCanal as unknown as (req: unknown) => ReturnType<typeof urlDoWebhookDeCanal>;
    expect(comRequisicao(pedidoComOrigin)!("abc123")).toBe("https://crm.exemplo.com/api/v1/webhooks/channel/abc123");
  });
});
