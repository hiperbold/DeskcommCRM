/**
 * D-155: o upload de mídia e a abertura de conversa por telefone, quando chamados
 * por chave de API, passam pelo teto de escrita por token. Antes nenhuma das duas
 * contava: uma chave em laço subia 50 MB por chamada no bucket e criava contatos sem
 * limite. As rotas rodam de verdade; a autenticação e o contador (o Redis do
 * limite) são falsos, e o que se mede é a RESPOSTA da rota depois que o contador
 * diz "estourou", e que a sessão de pessoa não é contada.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONV = "33333333-3333-4333-8333-333333333333";

let via: "token" | "session" = "token";
let permitido = true;
const baldes: string[] = [];
const abertas: unknown[] = [];

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({
  checkRateLimit: vi.fn(async (chave: string) => {
    baldes.push(chave);
    return { allowed: permitido };
  }),
}));
vi.mock("@/lib/api/auth-dual", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  resolveAuthDual: vi.fn(async () => ({
    ok: true,
    organizationId: ORG,
    actor: { type: "api_token", id: "tok-1" },
    supabase: {
      from: () => {
        const q: Record<string, unknown> = {
          select: () => q,
          eq: () => q,
          maybeSingle: async () => ({ data: { id: CONV }, error: null }),
        };
        return q;
      },
    },
    via,
    scopes: ["mcp:write"],
    idioma: "pt-BR",
  })),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/messaging/open-shared-contact-conversation", () => ({
  openSharedContactConversation: vi.fn(async (_a: unknown, _o: unknown, input: unknown) => {
    abertas.push(input);
    return { conversation_id: CONV };
  }),
}));

import { POST as upload } from "@/app/api/v1/conversations/[id]/media/route";
import { POST as abrir } from "@/app/api/v1/conversations/open-with-contact/route";

beforeEach(() => {
  via = "token";
  permitido = true;
  baldes.length = 0;
  abertas.length = 0;
});

const reqUpload = () => {
  const form = new FormData();
  form.append("file", new File([new Uint8Array(10)], "a.png", { type: "image/png" }));
  return new NextRequest(`http://localhost/api/v1/conversations/${CONV}/media`, { method: "POST", body: form });
};
const reqAbrir = () =>
  new NextRequest("http://localhost/api/v1/conversations/open-with-contact", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ phone_number: "+5511999990000", channel_session_id: "55555555-5555-4555-8555-555555555555" }),
  });

describe("upload de mídia por chave de API", () => {
  it("⭐ estourado o teto, a rota responde 429 antes de olhar a conversa ou o arquivo", async () => {
    permitido = false;
    const r = await upload(reqUpload(), { params: Promise.resolve({ id: CONV }) });
    expect(r.status).toBe(429);
    expect(baldes[0]).toBe("media:tok:tok-1");
  });

  it("sessão de pessoa não é contada (devolve sem tocar no contador)", async () => {
    via = "session";
    permitido = false;
    await upload(reqUpload(), { params: Promise.resolve({ id: CONV }) });
    expect(baldes).toEqual([]);
  });
});

describe("abertura de conversa por chave de API", () => {
  it("⭐ estourado o teto, responde 429 e NÃO cria contato nem conversa", async () => {
    permitido = false;
    const r = await abrir(reqAbrir());
    expect(r.status).toBe(429);
    expect(abertas).toEqual([]);
    expect(baldes[0]).toBe("open:tok:tok-1");
  });

  it("CONTROLE POSITIVO: dentro do teto abre a conversa", async () => {
    const r = await abrir(reqAbrir());
    expect(r.status).toBe(200);
    expect(abertas).toHaveLength(1);
  });

  it("erro interno não devolve a mensagem crua do banco (vizinho do D-155)", async () => {
    const { openSharedContactConversation } = await import("@/lib/messaging/open-shared-contact-conversation");
    vi.mocked(openSharedContactConversation).mockRejectedValueOnce(new Error('duplicate key value violates unique constraint "contacts_pkey"'));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const r = await abrir(reqAbrir());
    expect(r.status).toBe(500);
    expect(JSON.stringify(await r.json())).not.toContain("duplicate key");
  });
});
