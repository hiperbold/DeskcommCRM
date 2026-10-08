/**
 * D-092: O LAYOUT DE /app EXIGE A PROVA DO SEGUNDO FATOR DE QUEM TEM FATOR, provado EXECUTANDO o layout.
 *
 * O layout só olhava se a pessoa JÁ CADASTROU o fator (`isMfaEnrolled`), nunca o nível da sessão. A
 * sessão aal1 (só senha) de um admin com TOTP renderizava toda tela de `/app` (inbox, contatos, leads)
 * com dados lidos pelo servidor. Agora quem tem fator verificado e está em aal1 vai para
 * `/login/mfa`, com o caminho de volta; quem prova (aal2) e quem não tem fator seguem como antes.
 */
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const estado = {
  caminho: "/app/inbox",
  matriculado: true,
  nivel: "aal1" as "aal1" | "aal2" | null,
  temOrganizacao: true,
};

const adminClient = {
  from() {
    return {
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: { onboarded_at: "2026-01-01", status: "active", settings: null },
            error: null,
          }),
        }),
      }),
    };
  },
};

vi.mock("@/lib/channels/health", () => ({ listarConexoesCaidas: async () => [] }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: adminClient.from }) }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: async () => ({
    id: "user-1",
    idioma: "pt-BR",
    is_platform_admin: false,
    support: null,
    organizations: [],
  }),
  requireAuth: async () => ({ id: "user-1", idioma: "pt-BR", is_platform_admin: false, support: null }),
  resolveActiveOrg: async () =>
    estado.temOrganizacao ? { orgId: "org-1", role: "admin", interface_settings: null } : null,
  isMfaEnrolled: async () => estado.matriculado,
  sessionAal: async () => estado.nivel,
  requiresMfa: async () => false,
}));
vi.mock("@/lib/auth/vinculo-revogado", () => ({ acessoFoiRevogado: async () => false }));
vi.mock("@/lib/billing/assinatura/sem-plano", () => ({ destinoDaGuardaSemPlano: async () => null }));
vi.mock("next/navigation", () => ({
  redirect: (destino: string) => {
    throw new Error(`REDIRECT:${destino}`);
  },
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers({ "x-pathname": estado.caminho }),
}));
vi.mock("@/lib/branding/instalacao", () => ({ marcaDaInstalacao: async () => ({}) }));
vi.mock("@/lib/branding/organizacao", () => ({
  resolverMarcaDaOrganizacao: () => ({
    name: "Deskcomm",
    logoUrl: null,
    cor: "#000000",
    origens: { nome: "instalacao", logoUrl: "instalacao", cor: "instalacao" },
  }),
}));

async function destinoDoLayout(): Promise<string | null> {
  const { default: AppLayout } = await import("@/app/app/layout");
  try {
    const arvore = (await AppLayout({ children: null })) as ReactElement;
    expect(arvore).toBeTruthy();
    return null;
  } catch (err) {
    const mensagem = err instanceof Error ? err.message : String(err);
    if (!mensagem.startsWith("REDIRECT:")) throw err;
    return mensagem.slice("REDIRECT:".length);
  }
}

beforeEach(() => {
  estado.caminho = "/app/inbox";
  estado.matriculado = true;
  estado.nivel = "aal1";
  estado.temOrganizacao = true;
});

describe("layout de /app: sessão aal1 de quem tem fator", () => {
  it("⭐ vai para /login/mfa, com o caminho de volta, em vez de renderizar a tela", async () => {
    expect(await destinoDoLayout()).toBe("/login/mfa?next=%2Fapp%2Finbox");
  });

  it("⭐ vale também sem organização ativa (o ramo de quem ainda não escolheu empresa)", async () => {
    estado.temOrganizacao = false;
    expect(await destinoDoLayout()).toBe("/login/mfa?next=%2Fapp%2Finbox");
  });

  it("nível ilegível (null) também é dívida: falha fechado", async () => {
    estado.nivel = null;
    expect(await destinoDoLayout()).toBe("/login/mfa?next=%2Fapp%2Finbox");
  });

  it("o caminho de volta nunca sai de /app (cabeçalho adulterado cai em /app)", async () => {
    estado.caminho = "//evil.example/app";
    expect(await destinoDoLayout()).toBe("/login/mfa?next=%2Fapp");
    estado.caminho = "";
    expect(await destinoDoLayout()).toBe("/login/mfa?next=%2Fapp");
  });
});

describe("layout de /app: quem não está em dívida segue como antes", () => {
  it("CONTROLE: com a prova do fator (aal2) a tela renderiza", async () => {
    estado.nivel = "aal2";
    expect(await destinoDoLayout()).toBeNull();
  });

  it("CONTROLE: quem nunca cadastrou fator, mesmo em aal1, não é trancado fora", async () => {
    estado.matriculado = false;
    estado.nivel = "aal1";
    expect(await destinoDoLayout()).toBeNull();
  });
});
