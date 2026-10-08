import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MarcaDeSaida } from "@/lib/branding/saida";

/**
 * CONTA-06, boas-vindas: sai quando a empresa nasce do cadastro do próprio cliente (`ensureTenantForUser`), só
 * para quem a criou. Não sai para quem já tinha empresa, para o provisionamento externo nem quando a criação da
 * empresa falha. O gatilho só ENFILEIRA; o envio em si (destinatário, cópia, idempotência, nova tentativa) é
 * provado em `emails-de-conta-enviar.test.ts`; aqui se prova o gatilho e o conteúdo montado.
 */

const h = vi.hoisted(() => ({
  enviar: vi.fn(),
  vinculado: { valor: false },
  falhaNaOrg: { valor: false },
}));

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/email/conta-e-cobranca/fila", () => ({ enfileirarEmailDeConta: h.enviar }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (nome: string) => {
      if (nome === "organizations") {
        return {
          insert: (linha: Record<string, unknown>) => ({
            select: () => ({
              single: async () =>
                h.falhaNaOrg.valor
                  ? { data: null, error: { code: "XX000", message: "boom" } }
                  : { data: { id: "org-nova", slug: linha.slug }, error: null },
            }),
          }),
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
        };
      }
      return {
        insert: async () => ({ error: null }),
        select: () => ({
          eq: () => ({
            is: () => ({
              limit: () => ({
                maybeSingle: async () => ({
                  data: h.vinculado.valor ? { organization_id: "org-existente" } : null,
                  error: null,
                }),
              }),
            }),
          }),
        }),
      };
    },
    auth: { admin: { createUser: async () => ({ data: { user: { id: "dono-1" } }, error: null }) } },
  }),
}));

const MARCA: MarcaDeSaida = {
  nome: "HiperCRM",
  logoUrl: null,
  accent: "#0139B0",
  accentFg: "#ffffff",
  origens: { nome: "padrao", cor: "padrao" },
};

beforeEach(() => {
  h.enviar.mockReset();
  h.enviar.mockResolvedValue("enfileirado");
  h.vinculado.valor = false;
  h.falhaNaOrg.valor = false;
});

describe("o gatilho no cadastro", () => {
  it("empresa nova do cadastro: avisa quem criou, com a organização como chave e cópia ao operador", async () => {
    const { ensureTenantForUser } = await import("@/lib/auth/provision");
    const r = await ensureTenantForUser({ id: "user-1", email: "pessoa@exemplo.com", user_metadata: { org_name: "Empresa X" } });

    expect(r).toEqual({ provisioned: true, organizationId: "org-nova" });
    expect(h.enviar).toHaveBeenCalledTimes(1);
    expect(h.enviar).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-nova",
        emailId: "CONTA-06",
        chave: "organizacao:org-nova",
        destino: "criador",
        criadorUserId: "user-1",
        copiaParaOperador: true,
        dados: {},
      }),
    );
  });

  it("quem já tem empresa não recebe boas-vindas de novo", async () => {
    h.vinculado.valor = true;
    const { ensureTenantForUser } = await import("@/lib/auth/provision");
    const r = await ensureTenantForUser({ id: "user-1", email: "pessoa@exemplo.com", user_metadata: { org_name: "Empresa X" } });
    expect(r.provisioned).toBe(false);
    expect(h.enviar).not.toHaveBeenCalled();
  });

  it("se a empresa não nasceu, não há e-mail", async () => {
    h.falhaNaOrg.valor = true;
    const { ensureTenantForUser } = await import("@/lib/auth/provision");
    await expect(
      ensureTenantForUser({ id: "user-1", email: "pessoa@exemplo.com", user_metadata: { org_name: "Empresa X" } }),
    ).rejects.toThrow();
    expect(h.enviar).not.toHaveBeenCalled();
  });

  it("o provisionamento externo (integração, script, admin da plataforma) não manda boas-vindas", async () => {
    const { provisionExternalTenant } = await import("@/lib/auth/provision");
    await provisionExternalTenant({
      integration: "clinicfx",
      externalId: "ext-1",
      organizationName: "Clínica",
      ownerEmail: "dono@exemplo.com",
      ownerName: "Dono",
    });
    expect(h.enviar).not.toHaveBeenCalled();
  });

  it("falha do enfileiramento não derruba o cadastro", async () => {
    h.enviar.mockRejectedValue(new Error("banco caiu"));
    const { ensureTenantForUser } = await import("@/lib/auth/provision");
    const r = await ensureTenantForUser({ id: "user-1", email: "pessoa@exemplo.com", user_metadata: { org_name: "Empresa X" } });
    expect(r).toEqual({ provisioned: true, organizationId: "org-nova" });
  });
});

describe("o conteúdo das boas-vindas", () => {
  async function montar(nome: string | null, idioma: "pt-BR" | "es" = "pt-BR") {
    const { avisarBoasVindas } = await import("@/lib/email/conta-e-cobranca/boas-vindas");
    await avisarBoasVindas({ organizationId: "org-1", criadorUserId: "user-1" });
    const { montarEmailDeConta } = await import("@/lib/email/conta-e-cobranca/montar");
    const entrada = h.enviar.mock.calls[0]![0] as { emailId: string; dados: unknown };
    return montarEmailDeConta(entrada.emailId, entrada.dados, {
      organizationId: "org-1",
      empresa: "Empresa X",
      idioma,
      marca: MARCA,
      appUrl: "https://crm.exemplo.com.br",
      nome,
      base: (url: string) => ({ marca: MARCA, idioma, empresa: "Empresa X", url }),
    });
  }

  it("chama a pessoa pelo primeiro nome e leva ao app", async () => {
    const m = await montar("Diego");
    expect(m.subject).toBe("Bem-vindo ao HiperCRM, Diego");
    expect(m.text).toContain("Começar agora: https://crm.exemplo.com.br/app");
  });

  it("sem nome no cadastro, chama pelo nome da empresa", async () => {
    const m = await montar(null);
    expect(m.subject).toBe("Bem-vindo ao HiperCRM, Empresa X");
  });

  it("no espanhol, quando a pessoa é de es", async () => {
    const m = await montar("Diego", "es");
    expect(m.subject).toBe("Te damos la bienvenida a HiperCRM, Diego");
  });
});
