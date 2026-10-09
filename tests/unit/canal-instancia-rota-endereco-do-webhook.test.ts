import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/v1/channels/instancia (conectar por servidor e token do cliente): o endereço de volta que o CRM
 * registra no servidor de WhatsApp vem SÓ de NEXT_PUBLIC_APP_URL (`urlDoWebhookDeCanal`), nunca do
 * cabeçalho `Origin` nem do host da requisição, que são escolhidos por quem chama. Sem o endereço
 * configurado a rota recusa antes de validar o servidor ou gravar qualquer coisa.
 *
 * O `conectarPorInstancia` é um dublê que só guarda a função de URL que a rota lhe entregou: o que se
 * prova é QUE ENDEREÇO a rota monta, que é o que o servidor de WhatsApp passa a usar para entregar.
 */

const h = vi.hoisted(() => ({ role: vi.fn(), conectar: vi.fn(), audit: vi.fn() }));
const envFalso = vi.hoisted(() => ({}) as { NEXT_PUBLIC_APP_URL?: string });

vi.mock("@/lib/env", () => ({ env: envFalso }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: h.role }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/channels/instancia", () => ({
  INSTANCE_CHANNEL_LABEL: "WhatsApp",
  conectarPorInstancia: h.conectar,
  listarConexoesPorInstancia: vi.fn(),
  removerConexaoPorInstancia: vi.fn(),
}));

import { NextRequest } from "next/server";

import { POST } from "@/app/api/v1/channels/instancia/route";

const ORG = "22222222-2222-4222-8222-222222222222";

const pedido = () =>
  new NextRequest("https://atacante.exemplo.com/api/v1/channels/instancia", {
    method: "POST",
    headers: { origin: "https://atacante.exemplo.com", host: "atacante.exemplo.com", "content-type": "application/json" },
    body: JSON.stringify({ servidor: "https://qr.exemplo.com", token: "token-da-instancia-1" }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  delete envFalso.NEXT_PUBLIC_APP_URL;
  h.role.mockResolvedValue({ ok: true, org: { orgId: ORG }, user: { id: "u1", idioma: "pt-BR" } });
  h.conectar.mockResolvedValue({
    ok: true,
    conexao: { id: "c1", displayName: "WhatsApp", phoneNumber: null, status: "WORKING" },
    webhook: { registrado: true, aviso: null },
  });
});

describe("conectar por instância: o endereço do webhook", () => {
  it("vem da configuração da instalação, nunca do Origin nem do host da requisição", async () => {
    envFalso.NEXT_PUBLIC_APP_URL = "https://crm.exemplo.com/";

    const res = await POST(pedido());

    expect(res.status).toBe(200);
    const { urlDoWebhook } = h.conectar.mock.calls[0]![1] as { urlDoWebhook: (t: string) => string };
    expect(urlDoWebhook("abc123")).toBe("https://crm.exemplo.com/api/v1/webhooks/channel/abc123");
    expect(urlDoWebhook("abc123")).not.toContain("atacante");
  });

  it.each([
    ["sem a variável", undefined],
    ["com o placeholder de build", "https://placeholder.invalid"],
  ])("%s: recusa com a frase do endereço público, sem validar o servidor nem gravar", async (_nome, valor) => {
    if (valor) envFalso.NEXT_PUBLIC_APP_URL = valor;

    const res = await POST(pedido());

    expect(res.status).toBe(422);
    const corpo = await res.json();
    expect(JSON.stringify(corpo)).toMatch(/O endereço público do CRM não está configurado/);
    expect(JSON.stringify(corpo)).not.toContain("atacante");
    expect(h.conectar).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });
});
