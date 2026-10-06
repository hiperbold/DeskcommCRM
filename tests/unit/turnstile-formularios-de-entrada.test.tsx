/**
 * Telas de entrada com o Turnstile (D-173): `/login`, `/signup` e `/login/forgot`.
 *
 * O widget da Cloudflare é simulado pelo `window.turnstile` (o script real é de outro
 * domínio); o resto, formulário, hook do captcha e fiação com a server action, roda de verdade.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const acoes = vi.hoisted(() => ({
  signInWithPassword: vi.fn(),
  signUp: vi.fn(),
  requestPasswordReset: vi.fn(),
}));

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));
vi.mock("@/app/actions/auth/signInWithPassword", () => ({ signInWithPassword: acoes.signInWithPassword }));
vi.mock("@/app/actions/auth/signUp", () => ({ signUp: acoes.signUp }));
vi.mock("@/app/actions/auth/requestPasswordReset", () => ({
  requestPasswordReset: acoes.requestPasswordReset,
}));

import { ForgotPasswordForm } from "@/components/auth/ForgotPasswordForm";
import { LoginForm } from "@/components/auth/LoginForm";
import { SignupForm } from "@/components/auth/SignupForm";

const SITE_DE_TESTE = "1x00000000000000000000AA";

interface OpcoesDoWidget {
  sitekey: string;
  callback: (token: string) => void;
  "expired-callback": () => void;
  "error-callback": () => void;
}

const api = { render: vi.fn(), reset: vi.fn(), remove: vi.fn() };
let opcoes: OpcoesDoWidget;

/** O que o widget faz quando a pessoa resolve o desafio. */
const resolverDesafio = (token: string) => act(() => opcoes.callback(token));

beforeEach(() => {
  for (const f of [...Object.values(acoes), api.render, api.reset, api.remove]) f.mockReset();
  api.render.mockImplementation((_el: HTMLElement, o: OpcoesDoWidget) => {
    opcoes = o;
    return "widget-1";
  });
  (window as unknown as { turnstile?: typeof api }).turnstile = api;
});

afterEach(() => {
  delete (window as unknown as { turnstile?: unknown }).turnstile;
  document.head.querySelectorAll("script").forEach((s) => s.remove());
});

function preencherLogin() {
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ana@exemplo.test" } });
  fireEvent.change(screen.getByLabelText("Senha"), { target: { value: "SenhaForte!2026" } });
}

describe("LoginForm", () => {
  it("sem chave configurada a tela não muda: sem widget, sem script e botão habilitado", async () => {
    acoes.signInWithPassword.mockResolvedValue({ ok: false, error: "invalid_credentials" });
    render(<LoginForm />);

    expect(screen.queryByTestId("turnstile-widget")).toBeNull();
    expect(document.head.querySelector('script[src*="challenges.cloudflare.com"]')).toBeNull();
    const botao = screen.getByRole("button", { name: "Entrar" });
    expect(botao).toBeEnabled();

    preencherLogin();
    fireEvent.click(botao);
    await waitFor(() => expect(acoes.signInWithPassword).toHaveBeenCalledTimes(1));
    expect(acoes.signInWithPassword).toHaveBeenCalledWith(
      { email: "ana@exemplo.test", password: "SenhaForte!2026" },
      undefined,
      undefined,
    );
  });

  it("com chave: o widget é desenhado com a chave pública e o botão só habilita com o token", async () => {
    render(<LoginForm turnstileSiteKey={SITE_DE_TESTE} />);

    await waitFor(() => expect(api.render).toHaveBeenCalledTimes(1));
    expect(opcoes.sitekey).toBe(SITE_DE_TESTE);
    const botao = screen.getByRole("button", { name: "Entrar" });
    expect(botao).toBeDisabled();

    await resolverDesafio("token-1");
    expect(botao).toBeEnabled();

    act(() => opcoes["expired-callback"]());
    expect(botao).toBeDisabled();
  });

  it("com chave: o token vai na chamada de login e, depois da falha, o widget é renovado", async () => {
    acoes.signInWithPassword.mockResolvedValue({ ok: false, error: "invalid_credentials" });
    render(<LoginForm next="/app/leads" turnstileSiteKey={SITE_DE_TESTE} />);
    await waitFor(() => expect(api.render).toHaveBeenCalled());
    await resolverDesafio("token-1");
    preencherLogin();

    fireEvent.click(screen.getByRole("button", { name: "Entrar" }));

    await waitFor(() => expect(acoes.signInWithPassword).toHaveBeenCalledTimes(1));
    expect(acoes.signInWithPassword).toHaveBeenCalledWith(
      { email: "ana@exemplo.test", password: "SenhaForte!2026" },
      "/app/leads",
      "token-1",
    );
    // Token de uso único: gasto na tentativa, o widget gera outro e o botão trava até lá.
    await waitFor(() => expect(api.reset).toHaveBeenCalledWith("widget-1"));
    expect(screen.getByRole("button", { name: "Entrar" })).toBeDisabled();

    await resolverDesafio("token-2");
    expect(screen.getByRole("button", { name: "Entrar" })).toBeEnabled();
  });

  it("captcha recusado pelo servidor mostra a mensagem de verificação, não a de senha", async () => {
    acoes.signInWithPassword.mockResolvedValue({ ok: false, error: "captcha_failed" });
    render(<LoginForm turnstileSiteKey={SITE_DE_TESTE} />);
    await waitFor(() => expect(api.render).toHaveBeenCalled());
    await resolverDesafio("token-1");
    preencherLogin();

    fireEvent.click(screen.getByRole("button", { name: "Entrar" }));

    expect(
      await screen.findByText("Não foi possível confirmar a verificação de segurança. Tente novamente."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Email ou senha incorretos.")).toBeNull();
  });

  it("o script da Cloudflare só é carregado quando a tela tem chave, e o widget nasce quando ele chega", async () => {
    delete (window as unknown as { turnstile?: unknown }).turnstile;
    render(<LoginForm turnstileSiteKey={SITE_DE_TESTE} />);

    const script = await waitFor(() => {
      const el = document.head.querySelector<HTMLScriptElement>('script[src^="https://challenges.cloudflare.com/turnstile/v0/api.js"]');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(api.render).not.toHaveBeenCalled();

    (window as unknown as { turnstile?: typeof api }).turnstile = api;
    act(() => script.onload?.(new Event("load")));
    await waitFor(() => expect(api.render).toHaveBeenCalledTimes(1));
  });
});

describe("ForgotPasswordForm", () => {
  it("sem chave a tela não muda", () => {
    render(<ForgotPasswordForm />);

    expect(screen.queryByTestId("turnstile-widget")).toBeNull();
    expect(screen.getByRole("button", { name: "Enviar link de redefinição" })).toBeEnabled();
  });

  it("com chave: o token vai no pedido e, depois de falhar, o widget é renovado", async () => {
    acoes.requestPasswordReset.mockResolvedValue({ ok: false, error: "captcha_failed" });
    render(<ForgotPasswordForm turnstileSiteKey={SITE_DE_TESTE} />);
    await waitFor(() => expect(api.render).toHaveBeenCalled());
    const botao = screen.getByRole("button", { name: "Enviar link de redefinição" });
    expect(botao).toBeDisabled();
    await resolverDesafio("token-1");
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ana@exemplo.test" } });

    fireEvent.click(botao);

    await waitFor(() => expect(acoes.requestPasswordReset).toHaveBeenCalledWith({ email: "ana@exemplo.test" }, "token-1"));
    await waitFor(() => expect(api.reset).toHaveBeenCalledWith("widget-1"));
    expect(
      await screen.findByText("Não foi possível confirmar a verificação de segurança. Tente novamente."),
    ).toBeInTheDocument();
  });
});

describe("SignupForm", () => {
  function preencherCadastro() {
    fireEvent.change(screen.getByLabelText("Nome da empresa"), { target: { value: "Plata Iphones" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ana@exemplo.test" } });
    fireEvent.change(screen.getByLabelText("Senha"), { target: { value: "SenhaForte!2026" } });
    fireEvent.change(screen.getByLabelText("Confirmar senha"), { target: { value: "SenhaForte!2026" } });
  }

  it("sem chave a tela não muda", () => {
    render(<SignupForm />);

    expect(screen.queryByTestId("turnstile-widget")).toBeNull();
    expect(screen.getByRole("button", { name: "Criar conta" })).toBeEnabled();
  });

  it("com chave: o token vai como terceiro argumento do signUp", async () => {
    acoes.signUp.mockResolvedValue({ ok: false, error: "signup_failed" });
    render(<SignupForm turnstileSiteKey={SITE_DE_TESTE} />);
    await waitFor(() => expect(api.render).toHaveBeenCalled());
    const botao = screen.getByRole("button", { name: "Criar conta" });
    expect(botao).toBeDisabled();
    await resolverDesafio("token-1");
    preencherCadastro();

    fireEvent.click(botao);

    await waitFor(() => expect(acoes.signUp).toHaveBeenCalledTimes(1));
    const [, convite, token] = acoes.signUp.mock.calls[0]!;
    expect(convite).toBeUndefined();
    expect(token).toBe("token-1");
    await waitFor(() => expect(api.reset).toHaveBeenCalledWith("widget-1"));
  });
});
