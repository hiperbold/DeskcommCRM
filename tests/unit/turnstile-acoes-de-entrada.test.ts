/**
 * O token do Turnstile chega ao Supabase Auth como `captchaToken` (D-173).
 *
 * Com a proteção ligada no GoTrue, `signUp`, `signInWithPassword`, `resetPasswordForEmail`
 * e o `resend` do cadastro por convite exigem o token. Este arquivo guarda a fiação dos
 * três caminhos que o app chama e o desfecho de quando o GoTrue recusa por captcha.
 * Sem token (proteção desligada) as chamadas continuam EXATAMENTE como eram.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { modoDeCadastro } from "@/lib/auth/politica-de-cadastro";

const admin = vi.hoisted(() => ({ createUser: vi.fn(), deleteUser: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({
    auth: { admin: { createUser: admin.createUser, deleteUser: admin.deleteUser } },
  })),
}));
vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/auth/politica-de-cadastro", () => ({ modoDeCadastro: vi.fn(async () => "aberto") }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  audit: vi.fn(async () => undefined),
}));

const CAPTCHA_RECUSADO = {
  message: "captcha verification process failed",
  code: "captcha_failed",
  status: 400,
};

const signIn = vi.fn();
const signUpDoProvedor = vi.fn();
const resetar = vi.fn();
const resend = vi.fn();

let n = 0;
const proximo = () => ++n;
const email = () => `captcha-${proximo()}-${Date.now()}@exemplo.test`;

beforeEach(() => {
  vi.resetModules();
  for (const f of [signIn, signUpDoProvedor, resetar, resend, admin.createUser, admin.deleteUser]) f.mockReset();
  vi.mocked(headers).mockResolvedValue({
    get: (k: string) => (k === "x-forwarded-for" ? `192.0.2.${(n % 250) + 1}` : null),
  } as never);
  vi.mocked(createClient).mockResolvedValue({
    auth: {
      signInWithPassword: signIn,
      signUp: signUpDoProvedor,
      resetPasswordForEmail: resetar,
      resend,
      mfa: { listFactors: vi.fn(async () => ({ data: { totp: [] } })) },
    },
  } as never);
  vi.mocked(modoDeCadastro).mockResolvedValue("aberto");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("login", () => {
  const senhaErrada = { data: { user: null, session: null }, error: { message: "Invalid login credentials", status: 400 } };

  it("manda o token em options.captchaToken", async () => {
    signIn.mockResolvedValue(senhaErrada);
    const { signInWithPassword } = await import("@/app/actions/auth/signInWithPassword");

    await signInWithPassword({ email: email(), password: "SenhaForte!2026" }, undefined, "token-do-widget");

    expect(signIn).toHaveBeenCalledWith(
      expect.objectContaining({ options: { captchaToken: "token-do-widget" } }),
    );
  });

  it("sem token (proteção desligada) a chamada ao GoTrue não ganha options", async () => {
    signIn.mockResolvedValue(senhaErrada);
    const { signInWithPassword } = await import("@/app/actions/auth/signInWithPassword");

    await signInWithPassword({ email: email(), password: "SenhaForte!2026" });

    const argumento = signIn.mock.calls[0]![0] as Record<string, unknown>;
    expect(argumento).not.toHaveProperty("options");
  });

  it("captcha recusado pelo GoTrue vira captcha_failed e NÃO gasta o limite de tentativas da conta", async () => {
    const { signInWithPassword } = await import("@/app/actions/auth/signInWithPassword");
    const conta = { email: email(), password: "SenhaForte!2026" };

    signIn.mockResolvedValue({ data: { user: null, session: null }, error: CAPTCHA_RECUSADO });
    const recusas = [];
    // Bem mais que o teto de 5 falhas por conta: se contassem, a sétima seria rate_limited.
    for (let i = 0; i < 7; i++) recusas.push(await signInWithPassword(conta, undefined, `t-${i}`));
    expect(recusas.every((r) => r.error === "captcha_failed")).toBe(true);

    signIn.mockResolvedValue(senhaErrada);
    const depois = await signInWithPassword(conta, undefined, "t-novo");
    expect(depois.error).toBe("invalid_credentials");
  });

  it("senha errada continua sendo invalid_credentials (não vira captcha)", async () => {
    signIn.mockResolvedValue(senhaErrada);
    const { signInWithPassword } = await import("@/app/actions/auth/signInWithPassword");

    const res = await signInWithPassword({ email: email(), password: "SenhaForte!2026" }, undefined, "t");

    expect(res.error).toBe("invalid_credentials");
  });
});

describe("recuperação de senha", () => {
  it("manda o token em captchaToken junto do redirectTo", async () => {
    resetar.mockResolvedValue({ error: null });
    const { requestPasswordReset } = await import("@/app/actions/auth/requestPasswordReset");

    const res = await requestPasswordReset({ email: email() }, "token-do-widget");

    expect(res).toEqual({ ok: true });
    expect(resetar).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ captchaToken: "token-do-widget", redirectTo: expect.stringContaining("/auth/confirm") }),
    );
  });

  it("sem token, não envia captchaToken", async () => {
    resetar.mockResolvedValue({ error: null });
    const { requestPasswordReset } = await import("@/app/actions/auth/requestPasswordReset");

    await requestPasswordReset({ email: email() });

    expect(resetar.mock.calls[0]![1]).not.toHaveProperty("captchaToken");
  });

  it("captcha recusado pelo GoTrue vira captcha_failed", async () => {
    resetar.mockResolvedValue({ error: CAPTCHA_RECUSADO });
    const { requestPasswordReset } = await import("@/app/actions/auth/requestPasswordReset");

    const res = await requestPasswordReset({ email: email() }, "token-vencido");

    expect(res).toEqual({ ok: false, error: "captcha_failed" });
  });
});

describe("cadastro", () => {
  const dados = () => ({
    org_name: "Plata Iphones",
    email: email(),
    password: "SenhaForte!2026",
    password_confirm: "SenhaForte!2026",
  });

  it("manda o token em options.captchaToken, sem perder o resto das options", async () => {
    signUpDoProvedor.mockResolvedValue({ data: { user: { id: "u-1" }, session: null }, error: null });
    const { signUp } = await import("@/app/actions/auth/signUp");

    const res = await signUp(dados(), undefined, "token-do-widget");

    expect(res).toEqual({ ok: true, sessao_ativa: false });
    expect(signUpDoProvedor).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          captchaToken: "token-do-widget",
          emailRedirectTo: expect.stringContaining("/auth/confirm"),
          data: { org_name: "Plata Iphones" },
        }),
      }),
    );
  });

  it("sem token, as options são as de sempre", async () => {
    signUpDoProvedor.mockResolvedValue({ data: { user: { id: "u-1" }, session: null }, error: null });
    const { signUp } = await import("@/app/actions/auth/signUp");

    await signUp(dados());

    const options = (signUpDoProvedor.mock.calls[0]![0] as { options: Record<string, unknown> }).options;
    expect(options).not.toHaveProperty("captchaToken");
  });

  it("captcha recusado pelo GoTrue vira captcha_failed, não signup_failed", async () => {
    signUpDoProvedor.mockResolvedValue({ data: { user: null, session: null }, error: CAPTCHA_RECUSADO });
    const { signUp } = await import("@/app/actions/auth/signUp");

    const res = await signUp(dados(), undefined, "token-vencido");

    expect(res).toEqual({ ok: false, error: "captcha_failed" });
  });

  describe("convite com o GoTrue de cadastro fechado (o resend também exige captcha)", () => {
    async function convite() {
      const { signInviteToken, INVITE_TTL_SECONDS } = await import("@/lib/auth/invite-token");
      const endereco = email();
      const token = signInviteToken({
        invite_id: "00000000-0000-4000-8000-000000000004",
        email: endereco,
        organization_id: "00000000-0000-4000-8000-000000000001",
        role: "agent",
        exp: Math.floor(Date.now() / 1000) + INVITE_TTL_SECONDS,
      });
      return {
        token,
        corpo: {
          full_name: "Convidada da Silva",
          email: endereco,
          password: "SenhaForte!2026",
          password_confirm: "SenhaForte!2026",
        },
      };
    }

    beforeEach(() => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({ ok: true, json: async () => ({ disable_signup: true }) }) as Response),
      );
      admin.createUser.mockResolvedValue({ data: { user: { id: "u-9" } }, error: null });
      admin.deleteUser.mockResolvedValue({ error: null });
    });

    it("o token vai no resend", async () => {
      resend.mockResolvedValue({ error: null });
      const { token, corpo } = await convite();
      const { signUp } = await import("@/app/actions/auth/signUp");

      const res = await signUp(corpo, token, "token-do-widget");

      expect(res).toEqual({ ok: true, sessao_ativa: false });
      expect(resend).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "signup",
          options: expect.objectContaining({ captchaToken: "token-do-widget" }),
        }),
      );
    });

    it("captcha recusado no resend: a conta recém-criada é desfeita e a tela recebe captcha_failed", async () => {
      resend.mockResolvedValue({ error: CAPTCHA_RECUSADO });
      const { token, corpo } = await convite();
      const { signUp } = await import("@/app/actions/auth/signUp");

      const res = await signUp(corpo, token, "token-vencido");

      expect(res).toEqual({ ok: false, error: "captcha_failed" });
      expect(admin.deleteUser).toHaveBeenCalledWith("u-9");
    });
  });
});
