/**
 * A GUARDA DE PÁGINA DA ORGANIZAÇÃO SEM PLANO, provada EXECUTANDO o layout de /app e a entrada /app
 * (D-094 revisto, 06/10/2026).
 *
 * A organização do cadastro próprio nasce com o contrato suspenso, sem período e sem ciclo. Quem
 * entra em /app nessa organização vai para a tela de assinatura; a própria tela de assinatura, as
 * configurações básicas e o onboarding (que vem antes) não redirecionam, e portanto não há laço.
 * Fora do modo `bloquear`, com plano, ou na conta de suporte, nada muda.
 */
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const estado = {
  caminho: "/app/inbox",
  modo: "bloquear" as string | null,
  contrato: null as null | Record<string, unknown>,
  onboardedAt: "2026-01-01" as string | null,
  support: null as null | Record<string, unknown>,
  leiturasDoContrato: 0,
};

const SEM_PLANO = {
  status: "suspensa",
  cycle: null,
  current_period_end: null,
  bloqueio_a_partir_de: "2026-01-01T00:00:00Z",
};

const adminClient = {
  from(tabela: string) {
    if (tabela === "billing_contracts") estado.leiturasDoContrato++;
    return {
      select: () => ({
        eq: () => ({
          maybeSingle: async () => {
            if (tabela === "organizations") {
              return { data: { onboarded_at: estado.onboardedAt, status: "active", settings: null }, error: null };
            }
            if (tabela === "billing_settings") return { data: { modo: estado.modo }, error: null };
            return { data: estado.contrato, error: null };
          },
        }),
      }),
    };
  },
};

vi.mock("@/lib/channels/health", () => ({ listarConexoesCaidas: async () => [] }));
// Um cliente novo a cada chamada: o modo de billing é cacheado por cliente, e o teste o troca.
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: adminClient.from }) }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: async () => ({
    id: "user-1",
    idioma: "pt-BR",
    is_platform_admin: false,
    support: estado.support,
    organizations: [],
  }),
  requireAuth: async () => ({ id: "user-1", idioma: "pt-BR", is_platform_admin: false, support: estado.support }),
  resolveActiveOrg: async () => ({ orgId: "org-1", role: "admin", interface_settings: null }),
  isMfaEnrolled: async () => true,
  // D-092: quem tem fator precisa tê-lo provado; aqui a sessão está em aal2.
  sessionAal: async () => "aal2",
  requiresMfa: async () => false,
}));
vi.mock("@/lib/auth/vinculo-revogado", () => ({ acessoFoiRevogado: async () => false }));
vi.mock("@/lib/navigation/interface", () => ({ homeDaInterface: () => "/app/inbox" }));
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
  estado.modo = "bloquear";
  estado.contrato = SEM_PLANO;
  estado.onboardedAt = "2026-01-01";
  estado.support = null;
  estado.leiturasDoContrato = 0;
});

describe("layout de /app: organização sem plano", () => {
  it("abrir qualquer tela do produto leva à assinatura", async () => {
    for (const caminho of ["/app", "/app/inbox", "/app/kanban"]) {
      estado.caminho = caminho;
      expect(await destinoDoLayout(), caminho).toBe("/app/settings/plano/assinar");
    }
  });

  it("SEM LAÇO: a assinatura, o pedido e as configurações básicas abrem, sem sequer ler o contrato", async () => {
    for (const caminho of [
      "/app/settings/plano/assinar",
      "/app/settings/plano",
      "/app/settings/plano/pedido/abc",
      "/app/settings/profile",
      "/app/settings",
    ]) {
      estado.caminho = caminho;
      expect(await destinoDoLayout(), caminho).toBeNull();
    }
    expect(estado.leiturasDoContrato).toBe(0);
  });

  it("o onboarding vem antes: sem concluí-lo o destino é /onboarding, não a assinatura", async () => {
    estado.onboardedAt = null;
    expect(await destinoDoLayout()).toBe("/onboarding");
  });

  it("CONTROLE: com plano ativo, ou fora do modo bloquear, ou na conta de suporte, nada redireciona", async () => {
    estado.contrato = { ...SEM_PLANO, status: "ativa" };
    expect(await destinoDoLayout()).toBeNull();

    estado.contrato = SEM_PLANO;
    estado.modo = "avisar";
    expect(await destinoDoLayout()).toBeNull();

    estado.modo = "bloquear";
    estado.support = { organization_id: "org-1", name: "X", expires_at: "2099-01-01", access_mode: "read" };
    expect(await destinoDoLayout()).toBeNull();
  });

  it("suspensa por falta de pagamento (tem período e ciclo) não é sem plano: a página abre", async () => {
    estado.contrato = { ...SEM_PLANO, cycle: "monthly", current_period_end: "2026-09-01T03:00:00Z" };
    expect(await destinoDoLayout()).toBeNull();
  });
});

describe("entrada /app", () => {
  it("sem plano vai para a assinatura; com plano segue para a home da interface", async () => {
    const { default: AppHome } = await import("@/app/app/page");
    await expect(AppHome()).rejects.toThrow("REDIRECT:/app/settings/plano/assinar");

    estado.contrato = { ...SEM_PLANO, status: "ativa" };
    await expect(AppHome()).rejects.toThrow("REDIRECT:/app/inbox");
  });
});
