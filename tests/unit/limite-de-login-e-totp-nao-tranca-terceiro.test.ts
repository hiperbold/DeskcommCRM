/**
 * D-102: o limite de tentativas de login e de código TOTP era contornável, e o
 * bloqueio de conta deixava qualquer pessoa trancar a conta de outra.
 *
 *  - TOTP: o contador morava num cookie (apagar o cookie zerava o limite). Agora
 *    é do servidor, por `user_id`: o teste chama `verifyMfa` com um cookie jar
 *    SEMPRE vazio, como quem apaga o cookie a cada tentativa, e o bloqueio vale.
 *  - Login: o contador por conta passou a ser por conta+origem (quem erra tranca a
 *    si mesmo) mais um teto da conta inteira, mais alto, para o ataque distribuído.
 *
 * O limitador é o real (memória do processo, sem Redis); só `next/headers`, o
 * GoTrue e a auditoria são dublês.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const estado = vi.hoisted(() => ({
  ip: "203.0.113.10",
  verify: vi.fn(),
  challenge: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: async () => ({
    get: (k: string) => (k === "x-forwarded-for" ? estado.ip : k === "user-agent" ? "teste" : null),
  }),
  // Cookie jar que nunca guarda nada: é o navegador que apaga o cookie a cada tentativa.
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}));
vi.mock("next/navigation", () => ({
  redirect: (destino: string) => {
    throw new Error(`REDIRECT:${destino}`);
  },
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined), hashEmail: (e: string) => e }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: "user-1" } } }),
      mfa: {
        listFactors: async () => ({ data: { totp: [{ id: "f1", status: "verified" }] } }),
        challenge: estado.challenge,
        verify: estado.verify,
      },
    },
  }),
}));

const EMAIL = "dono@example.com";

beforeEach(() => {
  vi.resetModules();
  estado.ip = "203.0.113.10";
  estado.verify.mockReset().mockResolvedValue({ error: { message: "invalid" } });
  estado.challenge.mockReset().mockResolvedValue({ data: { id: "c1" }, error: null });
});

describe("D-102 login: bloqueio por conta+origem e teto da conta inteira", () => {
  it("quem erra 5 vezes tranca a própria origem, não o dono em outra origem", async () => {
    const { AUTH_LIMITS, registrarFalhaDeLogin, motivoDoBloqueioDeLogin } = await import(
      "@/lib/auth/rate-limit"
    );
    estado.ip = "198.51.100.7"; // quem erra de propósito
    for (let i = 0; i < 5; i++) await registrarFalhaDeLogin(EMAIL, AUTH_LIMITS.login);
    expect(await motivoDoBloqueioDeLogin(EMAIL, AUTH_LIMITS.login)).toBe("origem");

    estado.ip = "203.0.113.99"; // o dono, de outro lugar
    expect(await motivoDoBloqueioDeLogin(EMAIL, AUTH_LIMITS.login)).toBeNull();
  });

  it("falhas espalhadas por muitas origens estouram o teto da conta inteira", async () => {
    const { AUTH_LIMITS, registrarFalhaDeLogin, motivoDoBloqueioDeLogin } = await import(
      "@/lib/auth/rate-limit"
    );
    for (let i = 0; i < AUTH_LIMITS.login.conta; i++) {
      estado.ip = `192.0.2.${i + 1}`; // uma falha por origem: nenhuma passa de 5
      await registrarFalhaDeLogin(EMAIL, AUTH_LIMITS.login);
    }
    estado.ip = "203.0.113.99";
    expect(await motivoDoBloqueioDeLogin(EMAIL, AUTH_LIMITS.login)).toBe("conta");
  });

  it("falhas de uma conta não bloqueiam outra", async () => {
    const { AUTH_LIMITS, registrarFalhaDeLogin, motivoDoBloqueioDeLogin } = await import(
      "@/lib/auth/rate-limit"
    );
    for (let i = 0; i < 5; i++) await registrarFalhaDeLogin(EMAIL, AUTH_LIMITS.login);
    expect(await motivoDoBloqueioDeLogin("outra@example.com", AUTH_LIMITS.login)).toBeNull();
  });

  it("a ação de login devolve o escopo do bloqueio (não é silencioso)", async () => {
    const { AUTH_LIMITS, registrarFalhaDeLogin } = await import("@/lib/auth/rate-limit");
    for (let i = 0; i < 5; i++) await registrarFalhaDeLogin(EMAIL, AUTH_LIMITS.login);
    const { signInWithPassword } = await import("@/app/actions/auth/signInWithPassword");
    const res = await signInWithPassword({ email: EMAIL, password: "qualquer-senha-1" });
    expect(res).toMatchObject({ ok: false, error: "rate_limited", details: { scope: "origem" } });
  });
});

describe("D-102 TOTP: o contador é do servidor, por usuário", () => {
  it("5 códigos errados trancam, mesmo com o cookie apagado a cada tentativa; o 6º nem chega ao GoTrue", async () => {
    const { verifyMfa } = await import("@/app/actions/auth/verifyMfa");
    for (let i = 0; i < 4; i++) {
      expect(await verifyMfa("000000")).toEqual({ ok: false, error: "mfa_invalid" });
    }
    const quinto = await verifyMfa("000000");
    expect(quinto).toMatchObject({ ok: false, error: "mfa_locked" });

    estado.verify.mockClear();
    estado.challenge.mockClear();
    const sexto = await verifyMfa("123456");
    expect(sexto).toMatchObject({ ok: false, error: "mfa_locked" });
    expect(estado.challenge).not.toHaveBeenCalled();
    expect(estado.verify).not.toHaveBeenCalled();
  });

  it("o tempo de espera devolvido é o que falta da janela, e positivo", async () => {
    const { verifyMfa } = await import("@/app/actions/auth/verifyMfa");
    const { MFA_FAILURE_LIMITS } = await import("@/lib/auth/rate-limit");
    let ultimo: unknown;
    for (let i = 0; i < 5; i++) ultimo = await verifyMfa("000000");
    const { retry_in_seconds: espera } = ultimo as { retry_in_seconds: number };
    expect(espera).toBeGreaterThan(0);
    expect(espera).toBeLessThanOrEqual(MFA_FAILURE_LIMITS.windowSec);
  });

  it("o bloqueio é por usuário: outro usuário não é afetado", async () => {
    const { MFA_FAILURE_LIMITS, mfaBloqueadoPorFalhas, registrarFalhaDeMfa } = await import(
      "@/lib/auth/rate-limit"
    );
    for (let i = 0; i < MFA_FAILURE_LIMITS.max; i++) await registrarFalhaDeMfa("user-1");
    expect(await mfaBloqueadoPorFalhas("user-1")).toBe(true);
    expect(await mfaBloqueadoPorFalhas("user-2")).toBe(false);
  });

  it("segundosAteFimDaJanela acompanha a janela fixa", async () => {
    const { segundosAteFimDaJanela } = await import("@/lib/auth/rate-limit");
    expect(segundosAteFimDaJanela(900, 900_000)).toBe(900);
    expect(segundosAteFimDaJanela(900, 1_349_000)).toBe(451);
  });
});
