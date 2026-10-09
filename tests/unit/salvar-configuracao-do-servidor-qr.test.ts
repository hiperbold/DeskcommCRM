import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as OutboundIp from "@/lib/automation/outbound-ip";

/**
 * Gravar as chaves do servidor de QR Code pela tela da instalação.
 *
 * B3: o token de administrador (segredo do grupo WhatsApp) só grava com o segundo fator PROVADO nesta
 *     sessão (aal2), não só "sem dívida de MFA".
 * B3b: o endereço do servidor também exige aal2 (quem o troca decide para onde o token de administrador
 *      viaja), e trocar o endereço apaga o token de administrador guardado (tem de ser digitado de novo).
 * B4: o endereço do servidor passa pela régua de destino de organização e recusa IP privado, link-local
 *     (169.254.169.254, metadados da nuvem) e loopback na hora de gravar. As guardas de saída são as de
 *     verdade; só a resolução de DNS de nomes é um dublê (nome do exemplo resolve para um IP público, o do
 *     "interno" resolve para a rede privada).
 */

const h = vi.hoisted(() => ({
  aal: vi.fn(),
  gravar: vi.fn(),
  estado: vi.fn(),
  audit: vi.fn(),
  valor: vi.fn(),
  voltar: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/env", () => ({ env: { IA_DESTINOS_INTERNOS_PERMITIDOS: "" } }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/auth/portao-de-escrita", () => ({
  requirePlatformAdminFull: async () => ({ user: { id: "admin-plataforma" } }),
}));
vi.mock("@/lib/auth/server", () => ({ sessionAal: h.aal }));
vi.mock("@/lib/instalacao/config", () => ({
  gravarPelaTela: h.gravar,
  voltarAoAmbiente: h.voltar,
  valorDaInstalacao: h.valor,
  estadoParaTela: h.estado,
}));
vi.mock("@/lib/automation/outbound-ip", async (original) => {
  const real = await original<typeof OutboundIp>();
  return {
    ...real,
    // Só o DNS: literais de IP e a lista de faixas especiais continuam sendo os de verdade.
    assertDestinoResolvidoSeguro: async (host: string) => {
      if (host === "interno.exemplo.com") throw new Error("unsafe_url:private_ip");
      if (/^[\d.]+$/.test(host)) return real.assertDestinoResolvidoSeguro(host);
    },
  };
});

import { salvarConfiguracaoDaInstalacao } from "@/app/actions/admin/salvarConfiguracaoDaInstalacao";

beforeEach(() => {
  vi.clearAllMocks();
  h.aal.mockResolvedValue("aal2");
  h.gravar.mockResolvedValue({ ok: true });
  h.estado.mockResolvedValue({ definido: true });
  h.valor.mockResolvedValue({ valor: "https://qr.exemplo.com", fonte: "banco" });
  h.voltar.mockResolvedValue({ ok: true });
});

describe("B3: o segredo do WhatsApp exige o segundo fator provado", () => {
  it.each([
    ["aal1 (só a senha)", "aal1"],
    ["sem nível (sessão sem MFA)", null],
  ])("UAZAPI_ADMIN_TOKEN com sessão %s: recusa e não grava nem audita", async (_nome, nivel) => {
    h.aal.mockResolvedValue(nivel);
    const r = await salvarConfiguracaoDaInstalacao("UAZAPI_ADMIN_TOKEN", "token-novo-123456");
    expect(r).toMatchObject({ ok: false });
    expect(r.ok === false && r.erro).toMatch(/duas etapas/);
    expect(h.gravar).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("com aal2 grava como segredo e audita só os últimos 4 caracteres", async () => {
    const r = await salvarConfiguracaoDaInstalacao("UAZAPI_ADMIN_TOKEN", "token-novo-123456");
    expect(r.ok).toBe(true);
    expect(h.gravar).toHaveBeenCalledWith("UAZAPI_ADMIN_TOKEN", "token-novo-123456", expect.objectContaining({ ehSegredo: true }));
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain("token-novo");
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ last4: "3456" }) }));
  });

  it.each([
    ["aal1 (só a senha)", "aal1"],
    ["sem nível (sessão sem MFA)", null],
  ])("UAZAPI_SERVIDOR_URL com sessão %s: recusa, não grava e não apaga o token", async (_nome, nivel) => {
    h.aal.mockResolvedValue(nivel);
    const r = await salvarConfiguracaoDaInstalacao("UAZAPI_SERVIDOR_URL", "https://outro.exemplo.com");
    expect(r).toMatchObject({ ok: false });
    expect(r.ok === false && r.erro).toMatch(/duas etapas/);
    expect(h.gravar).not.toHaveBeenCalled();
    expect(h.voltar).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("UAZAPI_SERVIDOR_URL com aal2 grava", async () => {
    const r = await salvarConfiguracaoDaInstalacao("UAZAPI_SERVIDOR_URL", "https://qr.exemplo.com");
    expect(r.ok).toBe(true);
    expect(h.gravar).toHaveBeenCalled();
  });

  it("segredo de OUTRO grupo segue como era (aal2 não é cobrado fora do WhatsApp)", async () => {
    h.aal.mockResolvedValue("aal1");
    const r = await salvarConfiguracaoDaInstalacao("RESEND_API_KEY", "re_chave-qualquer-1234");
    expect(r.ok).toBe(true);
    expect(h.aal).not.toHaveBeenCalled();
  });
});

describe("B3b: trocar o endereço do servidor apaga o token de administrador guardado", () => {
  it("endereço diferente: apaga o token ANTES de gravar o endereço, grava, avisa e audita a limpeza", async () => {
    const ordem: string[] = [];
    h.voltar.mockImplementation(async (chave: string) => {
      ordem.push(`apagou:${chave}`);
      return { ok: true };
    });
    h.gravar.mockImplementation(async (chave: string) => {
      ordem.push(`gravou:${chave}`);
      return { ok: true };
    });
    const r = await salvarConfiguracaoDaInstalacao("UAZAPI_SERVIDOR_URL", "https://servidor-do-atacante.exemplo.com");
    expect(r.ok).toBe(true);
    expect(ordem).toEqual(["apagou:UAZAPI_ADMIN_TOKEN", "gravou:UAZAPI_SERVIDOR_URL"]);
    expect(r.ok && r.aviso).toMatch(/senha de administrador guardada foi apagada/);
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ limpou_ao_mudar: ["UAZAPI_ADMIN_TOKEN"] }) }),
    );
  });

  it("o mesmo endereço escrito de outro jeito (maiúsculas, porta padrão, barra no fim) não apaga nada", async () => {
    const r = await salvarConfiguracaoDaInstalacao("UAZAPI_SERVIDOR_URL", "https://QR.exemplo.com:443/");
    expect(r.ok).toBe(true);
    expect(h.voltar).not.toHaveBeenCalled();
    expect(r.ok && r.aviso).toBeUndefined();
  });

  it("sem endereço guardado ainda, gravar o primeiro também apaga o token que já houvesse", async () => {
    h.valor.mockResolvedValue({ valor: null, fonte: "ausente" });
    await salvarConfiguracaoDaInstalacao("UAZAPI_SERVIDOR_URL", "https://qr.exemplo.com");
    expect(h.voltar).toHaveBeenCalledWith("UAZAPI_ADMIN_TOKEN");
  });

  it("se não conseguir apagar o token, o endereço NÃO é gravado", async () => {
    h.voltar.mockResolvedValue({ ok: false, motivo: "banco_recusou", detalhe: "x" });
    const r = await salvarConfiguracaoDaInstalacao("UAZAPI_SERVIDOR_URL", "https://outro.exemplo.com");
    expect(r).toMatchObject({ ok: false });
    expect(h.gravar).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("recusado pela régua de destino (rede interna): nada é apagado", async () => {
    const r = await salvarConfiguracaoDaInstalacao("UAZAPI_SERVIDOR_URL", "https://10.0.0.5");
    expect(r).toMatchObject({ ok: false });
    expect(h.voltar).not.toHaveBeenCalled();
  });

  it("gravar o próprio token não apaga nada", async () => {
    await salvarConfiguracaoDaInstalacao("UAZAPI_ADMIN_TOKEN", "token-novo-123456");
    expect(h.voltar).not.toHaveBeenCalled();
  });
});

describe("B4: o endereço do servidor passa pela régua de destino ao gravar", () => {
  it.each([
    ["metadados da nuvem (link-local)", "https://169.254.169.254"],
    ["IP privado", "https://10.0.0.5"],
    ["IP privado 192.168", "https://192.168.1.10:8443"],
    ["loopback", "https://127.0.0.1"],
    ["nome que resolve para a rede privada", "https://interno.exemplo.com"],
  ])("recusa %s, com frase fixa, sem gravar", async (_nome, endereco) => {
    const r = await salvarConfiguracaoDaInstalacao("UAZAPI_SERVIDOR_URL", endereco);
    expect(r).toMatchObject({ ok: false });
    expect(r.ok === false && r.erro).toMatch(/rede interna/);
    // Nunca o código técnico nem o endereço digitado.
    expect(r.ok === false && r.erro).not.toMatch(/unsafe_url|169\.254|10\.0|interno\.exemplo/);
    expect(h.gravar).not.toHaveBeenCalled();
  });

  it("endereço público em https grava", async () => {
    const r = await salvarConfiguracaoDaInstalacao("UAZAPI_SERVIDOR_URL", "https://qr.exemplo.com");
    expect(r.ok).toBe(true);
    expect(h.gravar).toHaveBeenCalledWith("UAZAPI_SERVIDOR_URL", "https://qr.exemplo.com", expect.anything());
  });

  it("http continua recusado antes de qualquer consulta de rede", async () => {
    const r = await salvarConfiguracaoDaInstalacao("UAZAPI_SERVIDOR_URL", "http://qr.exemplo.com");
    expect(r.ok === false && r.erro).toMatch(/https/);
    expect(h.gravar).not.toHaveBeenCalled();
  });
});
