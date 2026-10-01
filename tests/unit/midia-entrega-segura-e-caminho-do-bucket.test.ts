/**
 * D-095 e D-149: a mídia que sai pela origem do CRM não executa no navegador de
 * quem abre, e o caminho do bucket não escapa do prefixo.
 *
 * Duas camadas:
 *   - funções puras (`isMediaPathOwnedBy`, `isMediaPathOfOrg`, `validateOutboundMedia`,
 *     `mimeInlineSeguro`, `sendMessageSchema`);
 *   - a ROTA `GET /api/v1/messages/[id]/media` de verdade, com a sessão, o banco, o
 *     Storage e o canal falsos: o que se mede é o cabeçalho da resposta e o caminho
 *     que foi assinado.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const ORG = "11111111-1111-4111-8111-111111111111";
const OUTRA = "22222222-2222-4222-8222-222222222222";
const CONV = "33333333-3333-4333-8333-333333333333";
const MSG = "44444444-4444-4444-8444-444444444444";

let linhaDaMensagem: Record<string, unknown> | null = null;
let midiaDoCanal: { buffer: Buffer; mime: string } = { buffer: Buffer.from("x"), mime: "text/html" };
const assinados: { caminho: string; opcoes: unknown }[] = [];

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(async () => ({
    ok: true,
    user: { id: "u1", idioma: "pt-BR" },
    org: { orgId: ORG, role: "viewer" },
  })),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => {
      const q: Record<string, unknown> = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => ({ data: linhaDaMensagem, error: null }),
      };
      return q;
    },
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => {
      const q: Record<string, unknown> = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => ({ data: { provider: "uazapi" }, error: null }),
      };
      return q;
    },
    storage: {
      from: () => ({
        createSignedUrl: async (caminho: string, _ttl: number, opcoes?: unknown) => {
          assinados.push({ caminho, opcoes });
          return { data: { signedUrl: `https://storage.test/${caminho}` }, error: null };
        },
      }),
    },
  }),
}));
vi.mock("@/lib/channels", () => ({
  CHANNEL_SESSION_REF_COLUMNS: "id",
  DEFAULT_CHANNEL_PROVIDER: "uazapi",
  getAdapter: () => ({ fetchInboundMedia: async () => midiaDoCanal }),
  resolveSessionRef: () => ({ ref: true }),
}));

import { GET } from "@/app/api/v1/messages/[id]/media/route";
import { mimeInlineSeguro, cabecalhosDeEntregaSegura } from "@/lib/messaging/media/entrega-segura";
import {
  isMediaPathOfOrg,
  isMediaPathOwnedBy,
  validateOutboundMedia,
} from "@/lib/messaging/media/upload-validation";
import { sendMessageSchema } from "@/lib/schemas/messaging";

function chamar() {
  return GET(new NextRequest(`http://localhost/api/v1/messages/${MSG}/media`), {
    params: Promise.resolve({ id: MSG }),
  });
}

beforeEach(() => {
  assinados.length = 0;
  linhaDaMensagem = null;
});

describe("D-095: o proxy da mídia não serve conteúdo executável pela origem do CRM", () => {
  it("⭐ html vindo da origem sai como binário para baixar, com sandbox e nosniff", async () => {
    linhaDaMensagem = { id: MSG, media_url: "https://atacante.test/x.html", media_mime: null, media_storage_path: null, channel_session_id: "s" };
    midiaDoCanal = { buffer: Buffer.from("<script>alert(1)</script>"), mime: "text/html" };
    const r = await chamar();
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/octet-stream");
    expect(r.headers.get("content-disposition")).toBe("attachment");
    expect(r.headers.get("content-security-policy")).toContain("sandbox");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("⭐ svg também não vai inline", async () => {
    linhaDaMensagem = { id: MSG, media_url: "https://a.test/x.svg", media_mime: null, media_storage_path: null, channel_session_id: "s" };
    midiaDoCanal = { buffer: Buffer.from("<svg onload=alert(1)/>"), mime: "image/svg+xml" };
    const r = await chamar();
    expect(r.headers.get("content-type")).toBe("application/octet-stream");
    expect(r.headers.get("content-disposition")).toBe("attachment");
  });

  it("CONTROLE POSITIVO: imagem, áudio e vídeo seguem inline com o tipo certo", async () => {
    linhaDaMensagem = { id: MSG, media_url: "https://a.test/x.jpg", media_mime: "image/jpeg", media_storage_path: null, channel_session_id: "s" };
    for (const mime of ["image/jpeg", "audio/ogg; codecs=opus", "video/mp4"]) {
      midiaDoCanal = { buffer: Buffer.from("x"), mime };
      const r = await chamar();
      expect(r.headers.get("content-type")).toBe(mime.split(";")[0]);
      expect(r.headers.get("content-disposition")).toBeNull();
    }
  });

  it("arquivo persistido que não é imagem, áudio ou vídeo é assinado para DOWNLOAD", async () => {
    linhaDaMensagem = { id: MSG, media_url: null, media_mime: "text/html", media_storage_path: `${ORG}/${CONV}/${MSG}.html`, channel_session_id: "s" };
    const r = await chamar();
    expect(r.status).toBe(302);
    expect(assinados).toEqual([{ caminho: `${ORG}/${CONV}/${MSG}.html`, opcoes: { download: true } }]);
  });

  it("imagem persistida é assinada sem forçar download", async () => {
    linhaDaMensagem = { id: MSG, media_url: null, media_mime: "image/png", media_storage_path: `${ORG}/${CONV}/${MSG}.png`, channel_session_id: "s" };
    await chamar();
    expect(assinados[0]?.opcoes).toBeUndefined();
  });

  it("mimeInlineSeguro e cabecalhosDeEntregaSegura", () => {
    expect(mimeInlineSeguro("image/svg+xml")).toBe(false);
    expect(mimeInlineSeguro("Image/PNG; x=1")).toBe(true);
    expect(mimeInlineSeguro(null)).toBe(false);
    expect(cabecalhosDeEntregaSegura("application/pdf")["Content-Disposition"]).toBe("attachment");
  });

  it("⭐ o envio não aceita mais media_url sozinha (a URL livre ia para a linha)", () => {
    const r = sendMessageSchema.safeParse({ conversation_id: CONV, type: "document", media_url: "https://atacante.test/x.html" });
    expect(r.success).toBe(false);
  });

  it("SVG não passa no upload de saída; imagem comum passa", () => {
    expect(validateOutboundMedia("image/svg+xml", 100).ok).toBe(false);
    expect(validateOutboundMedia("image/png", 100).ok).toBe(true);
  });
});

describe("D-149: caminho do bucket não escapa do prefixo", () => {
  it("⭐ rota: caminho de outra organização gravado na linha NÃO é assinado", async () => {
    linhaDaMensagem = { id: MSG, media_url: null, media_mime: "image/jpeg", media_storage_path: `${OUTRA}/${CONV}/${MSG}.jpg`, channel_session_id: "s" };
    const r = await chamar();
    expect(assinados).toEqual([]);
    expect(r.status).toBe(404);
  });

  it("⭐ rota: traversal para dentro da outra organização também não é assinado", async () => {
    linhaDaMensagem = { id: MSG, media_url: null, media_mime: "image/jpeg", media_storage_path: `${ORG}/${CONV}/../../${OUTRA}/${CONV}/${MSG}.jpg`, channel_session_id: "s" };
    await chamar();
    expect(assinados).toEqual([]);
  });

  it("CONTROLE POSITIVO: caminho da própria organização é assinado", async () => {
    linhaDaMensagem = { id: MSG, media_url: null, media_mime: "image/jpeg", media_storage_path: `${ORG}/${CONV}/${MSG}.jpg`, channel_session_id: "s" };
    const r = await chamar();
    expect(r.status).toBe(302);
    expect(assinados).toHaveLength(1);
  });

  it("⭐ isMediaPathOwnedBy recusa ../, //, barra invertida, %, ponto e controle, mesmo com o prefixo certo", () => {
    const prefixo = `${ORG}/${CONV}`;
    expect(isMediaPathOwnedBy(`${prefixo}/${MSG}.pdf`, ORG, CONV)).toBe(true);
    expect(isMediaPathOwnedBy(`${prefixo}/out-abc.webm`, ORG, CONV)).toBe(true);
    expect(isMediaPathOwnedBy(`${prefixo}/../../${OUTRA}/${CONV}/${MSG}.pdf`, ORG, CONV)).toBe(false);
    expect(isMediaPathOwnedBy(`${prefixo}//x.pdf`, ORG, CONV)).toBe(false);
    expect(isMediaPathOwnedBy(`${prefixo}/a\\..\\b.pdf`, ORG, CONV)).toBe(false);
    expect(isMediaPathOwnedBy(`${prefixo}/%2e%2e/x.pdf`, ORG, CONV)).toBe(false);
    expect(isMediaPathOwnedBy(`${prefixo}/./x.pdf`, ORG, CONV)).toBe(false);
    expect(isMediaPathOwnedBy(`${prefixo}/x${String.fromCharCode(0)}.pdf`, ORG, CONV)).toBe(false);
    expect(isMediaPathOwnedBy(`${OUTRA}/${CONV}/x.pdf`, ORG, CONV)).toBe(false);
    expect(isMediaPathOwnedBy(`${ORG}x/${CONV}/x.pdf`, ORG, CONV)).toBe(false);
  });

  it("isMediaPathOfOrg confere a organização e a normalização", () => {
    expect(isMediaPathOfOrg(`${ORG}/avatars/c.jpg`, ORG)).toBe(true);
    expect(isMediaPathOfOrg(`${OUTRA}/c/m.jpg`, ORG)).toBe(false);
    expect(isMediaPathOfOrg(`${ORG}/../${OUTRA}/m.jpg`, ORG)).toBe(false);
    expect(isMediaPathOfOrg("platform/logo.png", ORG)).toBe(false);
  });
});
