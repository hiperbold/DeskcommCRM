/**
 * D-092, achado 7: quando `listFactors` falha em `/login/mfa`, a página tratava "sem dados" como "sem fator" e
 * redirecionava para `/app`; o layout (que conhece o fator) devolvia a pessoa para `/login/mfa`, num vaivém.
 * Agora o erro mostra uma tela de erro, e só a ausência REAL de fator (lista lida, sem fator verificado)
 * segue para `/app`.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const estado = {
  usuario: { id: "u1", user_metadata: {} } as null | { id: string; user_metadata: Record<string, unknown> },
  fatores: { data: { totp: [{ status: "verified" }] } as unknown, error: null as unknown },
};

vi.mock("next/navigation", () => ({
  redirect: (destino: string) => {
    throw new Error(`REDIRECT:${destino}`);
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: estado.usuario } }),
      mfa: { listFactors: async () => estado.fatores },
    },
  }),
}));
vi.mock("@/components/auth/MfaForm", () => ({ MfaForm: () => "FORMULARIO-MFA" }));
vi.mock("@/lib/i18n/idiomaAnonimo", () => ({ idiomaDoVisitante: async () => "pt-BR" }));

import MfaChallengePage from "@/app/(public)/login/mfa/page";

async function renderiza(): Promise<string> {
  const el = await MfaChallengePage({ searchParams: Promise.resolve({}) });
  return renderToStaticMarkup(el);
}

beforeEach(() => {
  estado.usuario = { id: "u1", user_metadata: {} };
  estado.fatores = { data: { totp: [{ status: "verified" }] }, error: null };
});

describe("/login/mfa", () => {
  it("⭐ erro ao listar os fatores: mostra a tela de erro e NÃO redireciona para /app", async () => {
    estado.fatores = { data: null, error: { message: "falha de rede" } };
    const html = await renderiza();
    expect(html).toContain("mfa-erro-ao-listar");
    expect(html).not.toContain("FORMULARIO-MFA");
    expect(html).not.toContain("falha de rede");
  });

  it("sem fator verificado de verdade (lista lida): segue para /app", async () => {
    estado.fatores = { data: { totp: [] }, error: null };
    await expect(renderiza()).rejects.toThrow("REDIRECT:/app");
  });

  it("com fator verificado: mostra o formulário", async () => {
    expect(await renderiza()).toContain("FORMULARIO-MFA");
  });

  it("sem sessão: vai para /login", async () => {
    estado.usuario = null;
    await expect(renderiza()).rejects.toThrow("REDIRECT:/login");
  });
});
