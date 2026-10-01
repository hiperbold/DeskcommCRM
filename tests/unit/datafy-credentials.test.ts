import { createHmac } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { validateGraphPartnerCredentials } from "@/lib/channels/graph-parceiro/validate-credentials";
import { verifyGraphPartnerSignature } from "@/lib/channels/graph-parceiro/webhook";

/** Canal Datafy (recorte do #1130, @vgamkt): descoberta pelo token e assinatura do webhook. */
afterEach(() => {
  vi.restoreAllMocks();
});

describe("validateGraphPartnerCredentials — descoberta via /me", () => {
  it("descobre número e WABA pelo token e confirma o número", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ phone_number_id: "106540352242922", waba_id: "366634483210360" }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ display_phone_number: "5531999998888", verified_name: "Loja" }), {
          status: 200,
        }),
      );

    const r = await validateGraphPartnerCredentials({ token: "sk_live_x", rootUrl: "https://cloud.example.test/" });

    expect(r).toEqual({
      ok: true,
      phoneNumberId: "106540352242922",
      wabaId: "366634483210360",
      displayPhoneNumber: "5531999998888",
      verifiedName: "Loja",
    });
    expect(String(fetchSpy.mock.calls[0]![0])).toBe("https://cloud.example.test/me");
    expect(String(fetchSpy.mock.calls[1]![0])).toContain("/v1/106540352242922?fields=");
    // O token vai no header, nunca na URL.
    for (const [url, init] of fetchSpy.mock.calls) {
      expect(String(url)).not.toContain("sk_live_x");
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer sk_live_x");
    }
  });

  it("401 vira recusa de token; rede caída NÃO vira 'token inválido'", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("{}", { status: 401 }));
    expect(await validateGraphPartnerCredentials({ token: "x", rootUrl: "https://x" })).toEqual({
      ok: false,
      motivo: "Token recusado pelo Datafy.",
    });

    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("boom"));
    const r = await validateGraphPartnerCredentials({ token: "x", rootUrl: "https://x" });
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.motivo).not.toMatch(/recusado/);
  });

  it("token sem phone_number_id no /me é recusado", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({ waba_id: "1" }), { status: 200 }));
    expect((await validateGraphPartnerCredentials({ token: "x", rootUrl: "https://x" })).ok).toBe(false);
  });

  it("perfil do número indisponível não derruba a conexão — o /me já provou o essencial", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ phone_number_id: "1", waba_id: "2" }), { status: 200 }))
      .mockRejectedValueOnce(new Error("timeout"));
    expect(await validateGraphPartnerCredentials({ token: "x", rootUrl: "https://x" })).toMatchObject({
      ok: true,
      displayPhoneNumber: null,
    });
  });
});

describe("verifyGraphPartnerSignature", () => {
  const secret = "whsec_test_1234567890";
  const ts = "1700000000";
  const body = '{"object":"whatsapp_business_account"}';
  const assinar = (s: string) => "sha256=" + createHmac("sha256", s).update(`${ts}.${body}`).digest("hex");
  // O carimbo tem de estar dentro de 5 minutos do relógio (D-130): o "agora" destes casos é o dele.
  const agora = 1700000000 * 1000;

  it("aceita a assinatura correta (HMAC de timestamp.corpo)", () => {
    expect(verifyGraphPartnerSignature(body, assinar(secret), ts, secret, agora)).toBe(true);
  });

  it("recusa assinatura errada, peça ausente, algoritmo trocado e corpo alterado", () => {
    const sig = assinar(secret);
    expect(verifyGraphPartnerSignature(body, sig, ts, "whsec_outro_segredo_123", agora)).toBe(false);
    expect(verifyGraphPartnerSignature(body, null, ts, secret, agora)).toBe(false);
    expect(verifyGraphPartnerSignature(body, sig, null, secret, agora)).toBe(false);
    expect(verifyGraphPartnerSignature(body, "sha1=abc", ts, secret, agora)).toBe(false);
    expect(verifyGraphPartnerSignature(`${body} `, sig, ts, secret, agora)).toBe(false);
    expect(verifyGraphPartnerSignature(body, sig, "1700000001", secret, agora)).toBe(false);
  });

  it("carimbo fora de 5 minutos do relógio é recusado, mesmo com a assinatura correta (D-130)", () => {
    const sig = assinar(secret);
    expect(verifyGraphPartnerSignature(body, sig, ts, secret, agora + 4 * 60 * 1000)).toBe(true);
    expect(verifyGraphPartnerSignature(body, sig, ts, secret, agora + 6 * 60 * 1000)).toBe(false);
    expect(verifyGraphPartnerSignature(body, sig, ts, secret, agora - 6 * 60 * 1000)).toBe(false);
    // Sem o quinto argumento vale o relógio real: o carimbo de 2023 é um replay.
    expect(verifyGraphPartnerSignature(body, sig, ts, secret)).toBe(false);
  });

  it("carimbo que não é número é recusado", () => {
    const sigDeLixo = "sha256=" + createHmac("sha256", secret).update(`abc.${body}`).digest("hex");
    expect(verifyGraphPartnerSignature(body, sigDeLixo, "abc", secret, agora)).toBe(false);
  });

  it("segredo que não é do painel (o provisório da conexão) nunca confere — nem assinado com ele", () => {
    const provisorio = "a".repeat(64);
    expect(verifyGraphPartnerSignature(body, assinar(provisorio), ts, provisorio, agora)).toBe(false);
    expect(verifyGraphPartnerSignature(body, assinar(secret), ts, null, agora)).toBe(false);
  });
});
