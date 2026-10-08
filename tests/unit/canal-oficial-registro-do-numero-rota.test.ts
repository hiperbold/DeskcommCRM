/**
 * D-174: as rotas que mostram o estado do número na Meta e o registram (só admin da organização).
 * O Graph é um dublê de `fetch`; o banco, a autorização e a cifra são dublês simples. O que se prova:
 * o papel, o que vai para a Meta, o que volta ao navegador (o PIN gerado UMA vez, nunca no GET, nunca
 * no audit nem no log) e que número que não está PENDING não é registrado.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const estado = {
  papelOk: true,
  sessao: { id: "s1", meta_phone_number_id: "111", meta_waba_id: "222", meta_token_encrypted: "CIFRADO" } as
    | null
    | Record<string, string>,
  token: "TOKEN-EM-CLARO" as string | null,
};
const audit = vi.fn();
const logs: string[] = [];
const fetchMock = vi.fn();

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async () =>
    estado.papelOk
      ? { ok: true, user: { id: "u1" }, org: { orgId: "o1", role: "admin" } }
      : {
          ok: false,
          response: new Response(JSON.stringify({ error: { code: "forbidden_role" } }), { status: 403 }),
        },
}));
vi.mock("@/lib/audit", () => ({ audit: (...a: unknown[]) => audit(...a) }));
vi.mock("@/lib/logger", () => ({
  logger: {
    info: (...a: unknown[]) => logs.push(JSON.stringify(a)),
    warn: (...a: unknown[]) => logs.push(JSON.stringify(a)),
    error: (...a: unknown[]) => logs.push(JSON.stringify(a)),
  },
}));
vi.mock("@/lib/webhooks/secrets", () => ({ decryptWebhookSecret: async () => estado.token }));
vi.mock("@/lib/channels/archived", () => ({
  ARCHIVED_AT: "archived_at",
  queryTolerantToMissingArchived: async (principal: () => Promise<unknown>) => principal(),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    const cadeia: Record<string, unknown> = {};
    for (const n of ["select", "eq", "is"]) cadeia[n] = () => cadeia;
    cadeia.maybeSingle = async () => ({ data: estado.sessao, error: null });
    return { from: () => cadeia };
  },
}));

function resposta(status: number, corpo: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => corpo } as Response;
}

const get = () => new NextRequest("http://localhost/api/v1/channels/official/numero");
const post = (corpo: unknown) =>
  new NextRequest("http://localhost/api/v1/channels/official/registrar", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(corpo),
  });

beforeEach(() => {
  estado.papelOk = true;
  estado.sessao = { id: "s1", meta_phone_number_id: "111", meta_waba_id: "222", meta_token_encrypted: "CIFRADO" };
  estado.token = "TOKEN-EM-CLARO";
  audit.mockReset();
  logs.length = 0;
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

describe("GET /api/v1/channels/official/numero", () => {
  it("⭐ só admin: quem não é recebe a resposta do portão e a Meta nem é chamada", async () => {
    estado.papelOk = false;
    const { GET } = await import("@/app/api/v1/channels/official/numero/route");
    const res = await GET(get());
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("devolve o estado do número, sem token e sem PIN", async () => {
    fetchMock.mockResolvedValue(resposta(200, { status: "PENDING", code_verification_status: "VERIFIED" }));
    const { GET } = await import("@/app/api/v1/channels/official/numero/route");
    const res = await GET(get());
    const corpo = await res.json();
    expect(corpo.data).toMatchObject({ disponivel: true, status: "PENDING", precisaRegistrar: true });
    expect(JSON.stringify(corpo)).not.toContain("TOKEN-EM-CLARO");
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
  });

  it("canal oficial não conectado: 422 no_meta_channel", async () => {
    estado.sessao = null;
    const { GET } = await import("@/app/api/v1/channels/official/numero/route");
    expect((await GET(get())).status).toBe(422);
  });

  it("a Meta recusa: 200 com o motivo em português (o estado é a informação)", async () => {
    fetchMock.mockResolvedValue(resposta(401, { error: { code: 190, message: "expired" } }));
    const { GET } = await import("@/app/api/v1/channels/official/numero/route");
    const corpo = await (await GET(get())).json();
    expect(corpo.data).toMatchObject({ disponivel: false });
    expect(corpo.data.motivo).toMatch(/token/i);
  });
});

describe("POST /api/v1/channels/official/registrar", () => {
  it("⭐ só admin: a Meta não é chamada", async () => {
    estado.papelOk = false;
    const { POST } = await import("@/app/api/v1/channels/official/registrar/route");
    expect((await POST(post({}))).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("⭐ número PENDING sem PIN informado: o CRM gera, registra e devolve o PIN UMA vez", async () => {
    fetchMock
      .mockResolvedValueOnce(resposta(200, { status: "PENDING" }))
      .mockResolvedValueOnce(resposta(200, { success: true }));
    const { POST } = await import("@/app/api/v1/channels/official/registrar/route");
    const res = await POST(post({}));
    const corpo = await res.json();

    expect(corpo.data.registrado).toBe(true);
    expect(corpo.data.pinGerado).toBe(true);
    expect(corpo.data.pin).toMatch(/^\d{6}$/);
    expect(res.headers.get("cache-control")).toMatch(/no-store/);

    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toMatch(/\/111\/register$/);
    expect(JSON.parse(String(init.body))).toEqual({ messaging_product: "whatsapp", pin: corpo.data.pin });
  });

  it("⭐ o PIN não vai para o audit nem para o log", async () => {
    fetchMock
      .mockResolvedValueOnce(resposta(200, { status: "PENDING" }))
      .mockResolvedValueOnce(resposta(200, { success: true }));
    const { POST } = await import("@/app/api/v1/channels/official/registrar/route");
    const corpo = await (await POST(post({}))).json();
    const pin = corpo.data.pin as string;

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "channel.number_registered", organizationId: "o1", actorUserId: "u1" }),
    );
    expect(JSON.stringify(audit.mock.calls)).not.toContain(pin);
    expect(logs.join("\n")).not.toContain(pin);
  });

  it("PIN informado pelo admin: é usado e NÃO volta na resposta", async () => {
    fetchMock
      .mockResolvedValueOnce(resposta(200, { status: "PENDING" }))
      .mockResolvedValueOnce(resposta(200, { success: true }));
    const { POST } = await import("@/app/api/v1/channels/official/registrar/route");
    const res = await POST(post({ pin: "246810" }));
    const texto = await res.text();

    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(String(init.body)).pin).toBe("246810");
    expect(JSON.parse(texto).data).toMatchObject({ registrado: true, pinGerado: false, pin: null });
    expect(texto).not.toContain("246810");
  });

  it("PIN informado que não tem seis dígitos: 422 e nada vai para a Meta", async () => {
    const { POST } = await import("@/app/api/v1/channels/official/registrar/route");
    expect((await POST(post({ pin: "12345" }))).status).toBe(422);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("⭐ número que já está CONNECTED não é registrado de novo: 409, sem POST /register", async () => {
    fetchMock.mockResolvedValueOnce(resposta(200, { status: "CONNECTED" }));
    const { POST } = await import("@/app/api/v1/channels/official/registrar/route");
    expect((await POST(post({}))).status).toBe(409);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a Meta recusa o registro (PIN diferente): 200 com o motivo traduzido, sem PIN na resposta", async () => {
    fetchMock
      .mockResolvedValueOnce(resposta(200, { status: "PENDING" }))
      .mockResolvedValueOnce(resposta(400, { error: { code: 133005, message: "PIN mismatch" } }));
    const { POST } = await import("@/app/api/v1/channels/official/registrar/route");
    const corpo = await (await POST(post({ pin: "246810" }))).json();
    expect(corpo.data).toMatchObject({ registrado: false, pin: null, codigo: "pin_incorreto" });
    expect(corpo.data.erro).toMatch(/PIN/);
    expect(audit).not.toHaveBeenCalled();
  });

  it("credencial ilegível nesta instalação: 422, sem chamar a Meta", async () => {
    estado.token = null;
    const { POST } = await import("@/app/api/v1/channels/official/registrar/route");
    expect((await POST(post({}))).status).toBe(422);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
