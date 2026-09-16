import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Conexão da instância UAZAPI — validar e ligar a volta.
 *
 * O caso que este arquivo existe para vigiar: `POST /webhook` SEM `action`
 * SUBSTITUI o webhook existente da instância. Uma instância que já alimenta
 * outra automação perderia a dela em silêncio. Toda escrita em `/webhook`
 * precisa levar `action`, e a remoção leva o id do NOSSO webhook.
 */

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

vi.mock("@/lib/automation/outbound-url", () => ({ assertSafeOutboundUrl: () => undefined }));
vi.mock("@/lib/automation/outbound-ip", () => ({ assertDestinoResolvidoSeguro: async () => undefined }));
vi.mock("@/lib/ai/elegibilidade/pre-go-live", () => ({ metadataInicialDoCanal: () => ({}) }));

import {
  UAZAPI_EVENTOS_DO_WEBHOOK,
  registrarWebhookUazapi,
  removerWebhookUazapi,
  validarInstanciaUazapi,
} from "@/lib/channels/uazapi/conexao";

const BASE = "https://empresa.uazapi.com";
const URL_NOSSA = "https://crm.exemplo.com.br/api/v1/webhooks/channel/abc123abc123abc123";

function resposta(status: number, json: unknown) {
  return { ok: status >= 200 && status < 300, status, statusText: "", json: async () => json };
}

const chamadas = () =>
  fetchMock.mock.calls.map(([url, init]) => ({
    url: String(url),
    method: (init as { method?: string })?.method ?? "GET",
    body: (init as { body?: string })?.body ? JSON.parse((init as { body: string }).body) : null,
  }));

beforeEach(() => fetchMock.mockReset());

describe("validarInstanciaUazapi", () => {
  it("instância pareada responde WORKING com o número em E.164", async () => {
    fetchMock.mockResolvedValueOnce(
      resposta(200, { instance: { id: "r1a2b3c4", name: "comercial", owner: "553591485627", profileName: "Loja", status: "connected" } }),
    );

    const v = await validarInstanciaUazapi({ servidor: "empresa.uazapi.com/docs", token: " tok " });

    expect(chamadas()[0]).toMatchObject({ url: `${BASE}/instance/status`, method: "GET" });
    expect(v).toEqual({
      ok: true,
      baseUrl: BASE,
      instanceId: "r1a2b3c4",
      instanceName: "comercial",
      phoneNumber: "+553591485627",
      profileName: "Loja",
      status: "WORKING",
    });
  });

  it("instância desconectada ainda conecta, e pede o QR", async () => {
    fetchMock.mockResolvedValueOnce(resposta(200, { instance: { id: "r1", status: "disconnected" } }));
    const v = await validarInstanciaUazapi({ servidor: BASE, token: "tok" });
    expect(v.ok && v.status).toBe("SCAN_QR_CODE");
    expect(v.ok && v.phoneNumber).toBeNull();
  });

  it("distingue token recusado, rede caída e resposta que não é instância", async () => {
    fetchMock.mockResolvedValueOnce(resposta(401, { error: "unauthorized" }));
    expect(await validarInstanciaUazapi({ servidor: BASE, token: "tok" })).toEqual({ ok: false, reason: "Token recusado pelo servidor." });

    fetchMock.mockRejectedValueOnce(new Error("ENOTFOUND"));
    const rede = await validarInstanciaUazapi({ servidor: BASE, token: "tok" });
    expect(!rede.ok && rede.reason).toMatch(/Não foi possível falar com o servidor/);

    fetchMock.mockResolvedValueOnce(resposta(200, { hello: "world" }));
    const outra = await validarInstanciaUazapi({ servidor: BASE, token: "tok" });
    expect(!outra.ok && outra.reason).toMatch(/não como uma instância/);
  });

  it("endereço inválido nem chega a sair", async () => {
    expect((await validarInstanciaUazapi({ servidor: "ftp://x", token: "tok" })).ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("registrarWebhookUazapi", () => {
  it("adiciona com action, sem tocar nos webhooks que já existem", async () => {
    fetchMock
      .mockResolvedValueOnce(resposta(200, [{ id: "outro", url: "https://automacao.exemplo.com/hook" }]))
      .mockResolvedValueOnce(
        resposta(200, [
          { id: "outro", url: "https://automacao.exemplo.com/hook" },
          { id: "nosso", url: URL_NOSSA },
        ]),
      );

    const r = await registrarWebhookUazapi({ baseUrl: BASE, token: "tok", url: URL_NOSSA });

    expect(r).toEqual({ ok: true, webhookId: "nosso" });
    const post = chamadas().find((c) => c.method === "POST");
    expect(post?.body).toMatchObject({
      action: "add",
      url: URL_NOSSA,
      events: [...UAZAPI_EVENTOS_DO_WEBHOOK],
      excludeMessages: [],
    });
  });

  it("webhook nosso registrado COM o filtro antigo é atualizado pelo id, não recriado", async () => {
    fetchMock
      .mockResolvedValueOnce(
        resposta(200, [
          { id: "outro", url: "https://automacao.exemplo.com/hook", excludeMessages: ["wasSentByApi"] },
          { id: "nosso", url: URL_NOSSA, enabled: true, events: [...UAZAPI_EVENTOS_DO_WEBHOOK], excludeMessages: ["wasSentByApi"] },
        ]),
      )
      .mockResolvedValueOnce(resposta(200, []));

    expect(await registrarWebhookUazapi({ baseUrl: BASE, token: "tok", url: URL_NOSSA })).toEqual({ ok: true, webhookId: "nosso" });
    const escritas = chamadas().filter((c) => c.method === "POST");
    expect(escritas).toHaveLength(1);
    expect(escritas[0]?.body).toMatchObject({ action: "update", id: "nosso", url: URL_NOSSA, excludeMessages: [] });
  });

  it("reaproveita o webhook que já aponta para cá em vez de criar um segundo", async () => {
    fetchMock.mockResolvedValueOnce(
      resposta(200, [{ id: "nosso", url: URL_NOSSA, enabled: true, events: [...UAZAPI_EVENTOS_DO_WEBHOOK], excludeMessages: [] }]),
    );
    expect(await registrarWebhookUazapi({ baseUrl: BASE, token: "tok", url: URL_NOSSA })).toEqual({ ok: true, webhookId: "nosso" });
    expect(chamadas().some((c) => c.method === "POST")).toBe(false);
  });

  it("toda escrita em /webhook leva action — nenhuma substitui os outros", async () => {
    fetchMock
      .mockResolvedValueOnce(resposta(200, []))
      .mockResolvedValueOnce(resposta(200, [{ id: "nosso", url: URL_NOSSA }]))
      .mockResolvedValueOnce(resposta(200, []));

    await registrarWebhookUazapi({ baseUrl: BASE, token: "tok", url: URL_NOSSA });
    await removerWebhookUazapi({ baseUrl: BASE, token: "tok", webhookId: "nosso" });

    const escritas = chamadas().filter((c) => c.method === "POST" && c.url.endsWith("/webhook"));
    expect(escritas).toHaveLength(2);
    for (const e of escritas) expect(e.body).toHaveProperty("action");
    expect(escritas[1]?.body).toEqual({ action: "delete", id: "nosso" });
  });
});
