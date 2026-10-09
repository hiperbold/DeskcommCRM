import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * As rotas do pareamento por QR Code: o que a BORDA faz (guarda, teto de taxa por organização, audit, GET
 * que só lê, estado em POST). O comportamento do pareamento em si está em `pareamento-qr.test.ts`; aqui o
 * módulo de canais é um dublê, e o limitador de taxa é o de verdade (memória do processo, sem Redis).
 */

const h = vi.hoisted(() => ({
  role: vi.fn(),
  support: vi.fn(),
  audit: vi.fn(),
  iniciar: vi.fn(),
  renovar: vi.fn(),
  cancelar: vi.fn(),
  estado: vi.fn(),
  disponivel: vi.fn(),
  pendente: vi.fn(),
}));

vi.mock("@/lib/env", () => ({ env: {} }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: h.role }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: h.support }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ marca: "admin" }) }));
vi.mock("@/lib/channels/pareamento-qr", () => ({
  iniciarPareamentoQr: h.iniciar,
  renovarPareamentoQr: h.renovar,
  cancelarPareamentoQr: h.cancelar,
  estadoDoPareamentoQr: h.estado,
  pareamentoQrDisponivel: h.disponivel,
  pareamentoQrPendenteDaOrganizacao: h.pendente,
}));

import * as colecao from "@/app/api/v1/channels/pareamento-qr/route";
import * as porId from "@/app/api/v1/channels/pareamento-qr/[id]/route";
import * as verificar from "@/app/api/v1/channels/pareamento-qr/[id]/verificar/route";
import { LIMITES_DO_PAREAMENTO_QR } from "@/lib/channels/pareamento-qr-limite";

const ID = "11111111-1111-4111-8111-111111111111";
let contador = 0;
/** Uma organização nova por teste: o limitador de memória é do processo e os baldes não se misturam. */
let org = "";

const req = (corpo: unknown = {}) =>
  new Request("http://localhost/x", { method: "POST", body: JSON.stringify(corpo), headers: { "user-agent": "vitest" } });
const ctx = { params: Promise.resolve({ id: ID }) };
const chamar = <T,>(f: (...a: never[]) => T, ...a: unknown[]) => (f as unknown as (...x: unknown[]) => T)(...a);

beforeEach(() => {
  vi.clearAllMocks();
  org = `org-${++contador}-${Math.random().toString(16).slice(2)}`;
  h.role.mockResolvedValue({ ok: true, org: { orgId: org }, user: { id: "u1", idioma: "pt-BR" } });
  h.support.mockResolvedValue(null);
  h.disponivel.mockResolvedValue(true);
  h.pendente.mockResolvedValue(null);
  h.iniciar.mockResolvedValue({ ok: true, id: ID, estado: "aguardando", qr: "data:image/png;base64,AA==", codigo: null, expira_em: "2026-10-09T00:00:00Z" });
  h.renovar.mockResolvedValue({ id: ID, estado: "aguardando", qr: null, codigo: "ABCD-1234", expira_em: "2026-10-09T00:00:00Z" });
  h.cancelar.mockResolvedValue({ ok: true, instanciaApagada: true });
  h.estado.mockResolvedValue({ id: ID, estado: "aguardando", qr: null, codigo: null, expira_em: "2026-10-09T00:00:00Z" });
});

describe("B2: o estado é POST e a consulta GET só lê", () => {
  it("a rota por id não tem GET (o que conclui e desfaz não pode ser um GET); o estado é POST em /verificar", () => {
    expect((porId as Record<string, unknown>).GET).toBeUndefined();
    expect(typeof porId.POST).toBe("function");
    expect(typeof porId.DELETE).toBe("function");
    expect((verificar as Record<string, unknown>).GET).toBeUndefined();
    expect(typeof verificar.POST).toBe("function");
  });

  it("verificar exige escrita fora do modo somente leitura do suporte: negado, nem chega ao pareamento", async () => {
    h.support.mockResolvedValue(new Response(null, { status: 403 }));
    const r = await chamar(verificar.POST, req(), ctx);
    expect((r as Response).status).toBe(403);
    expect(h.estado).not.toHaveBeenCalled();
  });

  it("verificar usa a organização da sessão (nunca a do corpo) e devolve o estado", async () => {
    const r = (await chamar(verificar.POST, req({ organization_id: "outra" }), ctx)) as Response;
    expect(r.status).toBe(200);
    expect(h.estado).toHaveBeenCalledWith({ marca: "admin" }, expect.objectContaining({ organizationId: org, id: ID }));
    expect((await r.json()).data).toMatchObject({ estado: "aguardando" });
  });

  it("verificar que conclui gera o audit de conexão uma vez, e a repetição não", async () => {
    h.estado.mockResolvedValueOnce({
      id: ID,
      estado: "conectado",
      conexao: { id: ID, displayName: "Loja", phoneNumber: "+5511988887777", status: "WORKING" },
      webhook: { registrado: true, aviso: null },
      concluiuAgora: true,
    });
    await chamar(verificar.POST, req(), ctx);
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "channel.connected", organizationId: org, resourceId: ID }));
    h.audit.mockClear();
    // Outra organização: o limite de 1 consulta por segundo é por organização e esta é a mesma chamada de cima.
    h.role.mockResolvedValue({ ok: true, org: { orgId: `${org}-repeticao` }, user: { id: "u1", idioma: "pt-BR" } });
    h.estado.mockResolvedValueOnce({
      id: ID,
      estado: "conectado",
      conexao: { id: ID, displayName: "Loja", phoneNumber: "+5511988887777", status: "WORKING" },
      webhook: { registrado: true, aviso: null },
      concluiuAgora: false,
    });
    const repeticao = (await chamar(verificar.POST, req(), ctx)) as Response;
    expect(repeticao.status).toBe(200);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("o GET da coleção só lê: consulta o pendente com (cliente, organização) e nada mais, sem concluir nem limpar", async () => {
    const r = (await chamar(colecao.GET)) as Response;
    expect(r.status).toBe(200);
    expect(h.pendente).toHaveBeenCalledTimes(1);
    expect(h.pendente.mock.calls[0]).toEqual([{ marca: "admin" }, org]);
    expect(h.estado).not.toHaveBeenCalled();
    expect(h.iniciar).not.toHaveBeenCalled();
    expect(h.cancelar).not.toHaveBeenCalled();
  });
});

describe("A1: teto de taxa por organização", () => {
  it("iniciar: depois de 10 por hora a 11ª é 429 com Retry-After, sem criar nada; outra organização não é afetada", async () => {
    const { max } = LIMITES_DO_PAREAMENTO_QR.iniciar;
    expect(max).toBe(10);
    for (let i = 0; i < max; i++) {
      expect(((await chamar(colecao.POST, req())) as Response).status).toBe(201);
    }
    const barrada = (await chamar(colecao.POST, req())) as Response;
    expect(barrada.status).toBe(429);
    expect(barrada.headers.get("retry-after")).toBe("3600");
    expect(h.iniciar).toHaveBeenCalledTimes(max);

    h.role.mockResolvedValue({ ok: true, org: { orgId: `${org}-outra` }, user: { id: "u2", idioma: "pt-BR" } });
    expect(((await chamar(colecao.POST, req())) as Response).status).toBe(201);
  });

  it("renovar: o teto da ação vale e conta por organização", async () => {
    const { max } = LIMITES_DO_PAREAMENTO_QR.renovar;
    for (let i = 0; i < max; i++) {
      expect(((await chamar(porId.POST, req(), ctx)) as Response).status).toBe(200);
    }
    const barrada = (await chamar(porId.POST, req(), ctx)) as Response;
    expect(barrada.status).toBe(429);
    expect(h.renovar).toHaveBeenCalledTimes(max);
  });

  it("cancelar: criar e cancelar em laço bate no teto de cancelamentos", async () => {
    const { max } = LIMITES_DO_PAREAMENTO_QR.cancelar;
    for (let i = 0; i < max; i++) {
      expect(((await chamar(porId.DELETE, req(), ctx)) as Response).status).toBe(200);
    }
    const barrada = (await chamar(porId.DELETE, req(), ctx)) as Response;
    expect(barrada.status).toBe(429);
    expect(h.cancelar).toHaveBeenCalledTimes(max);
  });

  it("os baldes de cada ação são separados (esgotar iniciar não impede cancelar)", async () => {
    for (let i = 0; i < LIMITES_DO_PAREAMENTO_QR.iniciar.max + 1; i++) await chamar(colecao.POST, req());
    expect(((await chamar(porId.DELETE, req(), ctx)) as Response).status).toBe(200);
  });
});

describe("B2: verificar tem limite de frequência", () => {
  // O contador é de janela fixa de 1 s: com o relógio parado no meio de uma janela, a segunda chamada seguida
  // cai sempre na mesma janela da primeira (sem isto o teste falharia quando as duas cruzassem a virada do segundo).
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-09T12:00:00.400Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("1 consulta por segundo por organização: a segunda seguida é 429 com Retry-After, sem consultar o pareamento", async () => {
    expect(LIMITES_DO_PAREAMENTO_QR.verificar).toEqual({ max: 1, janelaSeg: 1 });
    const primeira = (await chamar(verificar.POST, req(), ctx)) as Response;
    expect(primeira.status).toBe(200);
    expect(h.estado).toHaveBeenCalledTimes(1);

    const barrada = (await chamar(verificar.POST, req(), ctx)) as Response;
    expect(barrada.status).toBe(429);
    expect(barrada.headers.get("retry-after")).toBe("1");
    expect((await barrada.json()).error).toMatchObject({ code: "rate_limited" });
    expect(h.estado).toHaveBeenCalledTimes(1);
  });

  it("outra organização não é afetada, e o balde de verificar não esgota o de cancelar", async () => {
    await chamar(verificar.POST, req(), ctx);
    expect(((await chamar(verificar.POST, req(), ctx)) as Response).status).toBe(429);
    expect(((await chamar(porId.DELETE, req(), ctx)) as Response).status).toBe(200);

    h.role.mockResolvedValue({ ok: true, org: { orgId: `${org}-outra` }, user: { id: "u2", idioma: "pt-BR" } });
    expect(((await chamar(verificar.POST, req(), ctx)) as Response).status).toBe(200);
  });

  it("o ritmo da tela (uma consulta a cada 3 s) nunca esbarra no limite", async () => {
    for (let i = 0; i < 5; i++) {
      expect(((await chamar(verificar.POST, req(), ctx)) as Response).status).toBe(200);
      vi.setSystemTime(Date.now() + 3_000);
    }
  });
});

describe("M3: audit do pedido de código de pareamento", () => {
  it("iniciar com número audita channel.pairing_code_requested sem o número nem o código", async () => {
    await chamar(colecao.POST, req({ telefone: "5511999999999" }));
    const acoes = h.audit.mock.calls.map((c) => (c[0] as { action: string }).action);
    expect(acoes).toContain("channel.qr_pairing_started");
    expect(acoes).toContain("channel.pairing_code_requested");
    expect(JSON.stringify(h.audit.mock.calls)).not.toMatch(/99999|ABCD/);
  });

  it("iniciar sem número não audita pedido de código", async () => {
    await chamar(colecao.POST, req({}));
    expect(h.audit.mock.calls.map((c) => (c[0] as { action: string }).action)).not.toContain("channel.pairing_code_requested");
  });

  it("renovar com número audita, sem PII; o 429 do limite do código volta com Retry-After e não audita", async () => {
    await chamar(porId.POST, req({ telefone: "5511999999999" }), ctx);
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "channel.pairing_code_requested", resourceId: ID, organizationId: org }));
    expect(JSON.stringify(h.audit.mock.calls)).not.toMatch(/99999|ABCD/);

    h.audit.mockClear();
    h.renovar.mockResolvedValue({ ok: false, status: 429, codigo: "rate_limited", reason: "Aguarde 30 segundos para pedir outro código." });
    const r = (await chamar(porId.POST, req({ telefone: "5511999999999" }), ctx)) as Response;
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("30");
    expect(h.audit).not.toHaveBeenCalled();
  });
});
