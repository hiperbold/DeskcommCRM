/**
 * `verificarTurnstile` e as chaves do Turnstile (D-173).
 *
 * Só o `fetch` para a Cloudflare é simulado. Chaves de TESTE oficiais da Cloudflare:
 * site `1x00000000000000000000AA`, secretas `1x…AA` (passa) e `2x…AA` (falha).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { logger } from "@/lib/logger";
import {
  captacaoExigeTurnstile,
  captchaRecusadoPeloGoTrue,
  reiniciarAvisoDoTurnstile,
  turnstileSiteKey,
  verificarTurnstile,
} from "@/lib/security/turnstile";

const SITE_DE_TESTE = "1x00000000000000000000AA";
const SECRETA_QUE_PASSA = "1x0000000000000000000000000000000AA";
const fetchMock = vi.fn();

const json = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  fetchMock.mockReset();
  vi.mocked(logger.warn).mockClear();
  reiniciarAvisoDoTurnstile();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("TURNSTILE_SECRET_KEY", SECRETA_QUE_PASSA);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("chaves lidas em runtime", () => {
  it("a chave pública some quando a variável está vazia ou em branco", () => {
    vi.stubEnv("TURNSTILE_SITE_KEY", "");
    expect(turnstileSiteKey()).toBeNull();
    vi.stubEnv("TURNSTILE_SITE_KEY", "   ");
    expect(turnstileSiteKey()).toBeNull();
  });

  it("a chave pública aparece quando configurada", () => {
    vi.stubEnv("TURNSTILE_SITE_KEY", SITE_DE_TESTE);
    expect(turnstileSiteKey()).toBe(SITE_DE_TESTE);
  });

  it("a captação só exige o token com TURNSTILE_CAPTACAO_EXIGIR=1 ou true", () => {
    vi.stubEnv("TURNSTILE_CAPTACAO_EXIGIR", "");
    expect(captacaoExigeTurnstile()).toBe(false);
    vi.stubEnv("TURNSTILE_CAPTACAO_EXIGIR", "1");
    expect(captacaoExigeTurnstile()).toBe(true);
    vi.stubEnv("TURNSTILE_CAPTACAO_EXIGIR", "TRUE");
    expect(captacaoExigeTurnstile()).toBe(true);
    vi.stubEnv("TURNSTILE_CAPTACAO_EXIGIR", "0");
    expect(captacaoExigeTurnstile()).toBe(false);
  });
});

describe("verificarTurnstile", () => {
  it("sucesso da Cloudflare: ok e verificado, com segredo, token e IP no corpo do POST", async () => {
    fetchMock.mockResolvedValue(json({ success: true }));

    const r = await verificarTurnstile("token-1", "198.51.100.4");

    expect(r).toEqual({ ok: true, verificado: true });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
    expect(init.method).toBe("POST");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const corpo = new URLSearchParams(String(init.body));
    expect(corpo.get("secret")).toBe(SECRETA_QUE_PASSA);
    expect(corpo.get("response")).toBe("token-1");
    expect(corpo.get("remoteip")).toBe("198.51.100.4");
  });

  it("sem IP legível o remoteip não é enviado", async () => {
    fetchMock.mockResolvedValue(json({ success: true }));

    await verificarTurnstile("token-1", null);

    const corpo = new URLSearchParams(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    expect(corpo.has("remoteip")).toBe(false);
  });

  it("a Cloudflare recusou: invalido", async () => {
    fetchMock.mockResolvedValue(json({ success: false, "error-codes": ["timeout-or-duplicate"] }));

    expect(await verificarTurnstile("token-usado")).toEqual({ ok: false, motivo: "invalido" });
  });

  it("token ausente, vazio ou que não é texto: ausente, sem falar com a rede", async () => {
    expect(await verificarTurnstile(undefined)).toEqual({ ok: false, motivo: "ausente" });
    expect(await verificarTurnstile("   ")).toEqual({ ok: false, motivo: "ausente" });
    expect(await verificarTurnstile({ x: 1 })).toEqual({ ok: false, motivo: "ausente" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("token maior que o teto da Cloudflare: invalido, sem falar com a rede", async () => {
    expect(await verificarTurnstile("a".repeat(2049))).toEqual({ ok: false, motivo: "invalido" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("erro de rede: indisponivel (quem chama recusa)", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));

    expect(await verificarTurnstile("token-1")).toEqual({ ok: false, motivo: "indisponivel" });
  });

  it("timeout: indisponivel", async () => {
    fetchMock.mockRejectedValue(new DOMException("The operation was aborted due to timeout", "TimeoutError"));

    expect(await verificarTurnstile("token-1")).toEqual({ ok: false, motivo: "indisponivel" });
  });

  it("HTTP de erro, corpo que não é JSON e internal-error: indisponivel", async () => {
    fetchMock.mockResolvedValueOnce(json({}, 502));
    expect(await verificarTurnstile("t")).toEqual({ ok: false, motivo: "indisponivel" });

    fetchMock.mockResolvedValueOnce(new Response("<html>oops</html>", { status: 200 }));
    expect(await verificarTurnstile("t")).toEqual({ ok: false, motivo: "indisponivel" });

    fetchMock.mockResolvedValueOnce(json({ success: false, "error-codes": ["internal-error"] }));
    expect(await verificarTurnstile("t")).toEqual({ ok: false, motivo: "indisponivel" });
  });

  it("sem a secreta: não verifica, deixa passar e avisa no log uma vez só", async () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "");

    const a = await verificarTurnstile("token-1");
    const b = await verificarTurnstile(undefined);

    expect(a).toEqual({ ok: true, verificado: false });
    expect(b).toEqual({ ok: true, verificado: false });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});

describe("captchaRecusadoPeloGoTrue", () => {
  it("reconhece o código do GoTrue e a mensagem das versões antigas", () => {
    expect(captchaRecusadoPeloGoTrue({ code: "captcha_failed", message: "x" })).toBe(true);
    expect(captchaRecusadoPeloGoTrue({ message: "captcha verification process failed" })).toBe(true);
  });

  it("não confunde senha errada, limite ou ausência de erro com captcha", () => {
    expect(captchaRecusadoPeloGoTrue({ message: "Invalid login credentials" })).toBe(false);
    expect(captchaRecusadoPeloGoTrue({ code: "over_request_rate_limit", message: "rate" })).toBe(false);
    expect(captchaRecusadoPeloGoTrue(null)).toBe(false);
    expect(captchaRecusadoPeloGoTrue(undefined)).toBe(false);
  });
});
