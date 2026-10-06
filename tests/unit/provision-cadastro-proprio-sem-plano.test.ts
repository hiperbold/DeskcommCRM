/**
 * D-094 revisto (06/10/2026): a organização do cadastro do próprio visitante é criada com o
 * marcador `settings.billing_inicio = 'sem_plano'`, que a migration 0940 lê para gravar o contrato
 * suspenso (sem período gratuito). O provisionamento externo NÃO leva o marcador e segue no
 * Ilimitado, como antes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const insertsEmOrganizations: Array<Record<string, unknown>> = [];

function tabela(nome: string) {
  if (nome === "organizations") {
    return {
      insert: (linha: Record<string, unknown>) => {
        insertsEmOrganizations.push(linha);
        return { select: () => ({ single: async () => ({ data: { id: "org-nova", slug: linha.slug }, error: null }) }) };
      },
      // Leitura do replay do provisionamento externo: não existe ainda.
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
    };
  }
  return {
    insert: async () => ({ error: null }),
    select: () => ({
      eq: () => ({
        is: () => ({ limit: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
      }),
    }),
  };
}

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: tabela,
    auth: { admin: { createUser: async () => ({ data: { user: { id: "dono-1" } }, error: null }) } },
  }),
}));

beforeEach(() => {
  insertsEmOrganizations.length = 0;
});

describe("marcador de billing na criação da organização", () => {
  it("o cadastro do próprio visitante grava billing_inicio = sem_plano (e não avaliacao)", async () => {
    const { ensureTenantForUser } = await import("@/lib/auth/provision");
    const r = await ensureTenantForUser({ id: "user-1", email: "pessoa@exemplo.com", user_metadata: { org_name: "Empresa X" } });

    expect(r).toEqual({ provisioned: true, organizationId: "org-nova" });
    expect(insertsEmOrganizations).toHaveLength(1);
    expect(insertsEmOrganizations[0]?.settings).toEqual({ billing_inicio: "sem_plano" });
  });

  it("CONTROLE: o provisionamento externo não leva o marcador de billing (segue no Ilimitado)", async () => {
    const { provisionExternalTenant } = await import("@/lib/auth/provision");
    await provisionExternalTenant({
      integration: "clinicfx",
      externalId: "ext-1",
      organizationName: "Clínica",
      ownerEmail: "dono@exemplo.com",
      ownerName: "Dono",
    });

    expect(insertsEmOrganizations).toHaveLength(1);
    const settings = insertsEmOrganizations[0]?.settings as Record<string, unknown>;
    expect(settings).not.toHaveProperty("billing_inicio");
    expect(settings).toHaveProperty("provisioning");
  });
});
