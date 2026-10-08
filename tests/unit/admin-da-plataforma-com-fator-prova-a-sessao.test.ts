/**
 * D-092: o guarda de /admin exige a prova do segundo fator de quem TEM fator, mesmo quando
 * `platform_admins.mfa_required` está desligado. Antes só `mfa_required` mandava: o admin de
 * plataforma que cadastrou o TOTP por vontade própria e teve a coluna desmarcada entrava no /admin
 * com a sessão aal1 (só senha).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const estado = {
  mfaRequired: false,
  nivel: "aal1" as string,
  fatores: [{ status: "verified" }] as Array<{ status: string }>,
  erroNosFatores: false,
};

vi.mock("next/navigation", () => ({
  redirect: (destino: string) => {
    throw new Error(`REDIRECT:${destino}`);
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: "u1" } } }),
      mfa: {
        getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: estado.nivel } }),
        listFactors: async () =>
          estado.erroNosFatores
            ? { data: null, error: new Error("rede") }
            : { data: { totp: estado.fatores }, error: null },
      },
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          is: () => ({
            maybeSingle: async () => ({
              data: { user_id: "u1", scope: "full", mfa_required: estado.mfaRequired, revoked_at: null },
            }),
          }),
        }),
      }),
    }),
  }),
}));

async function destino(): Promise<string | null> {
  const { requirePlatformAdmin } = await import("@/lib/auth/requirePlatformAdmin");
  try {
    await requirePlatformAdmin();
    return null;
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    if (!m.startsWith("REDIRECT:")) throw err;
    return m.slice("REDIRECT:".length);
  }
}

beforeEach(() => {
  estado.mfaRequired = false;
  estado.nivel = "aal1";
  estado.fatores = [{ status: "verified" }];
  estado.erroNosFatores = false;
});

describe("requirePlatformAdmin e o segundo fator", () => {
  it("⭐ mfa_required desligado, mas com fator verificado e sessão aal1: vai para /login/mfa", async () => {
    expect(await destino()).toBe("/login/mfa?next=/admin");
  });

  it("não consegue ler os fatores: falha fechado (lança, nunca libera)", async () => {
    estado.erroNosFatores = true;
    await expect(destino()).rejects.toThrow("rede");
  });

  it("mfa_required ligado e aal1: continua indo para /login/mfa, mesmo sem fator na lista", async () => {
    estado.mfaRequired = true;
    estado.fatores = [];
    expect(await destino()).toBe("/login/mfa?next=/admin");
  });

  it("CONTROLE: com aal2 entra", async () => {
    estado.nivel = "aal2";
    expect(await destino()).toBeNull();
  });

  it("CONTROLE: mfa_required desligado e nenhum fator verificado, em aal1: entra (não é trancado fora)", async () => {
    estado.fatores = [{ status: "unverified" }];
    expect(await destino()).toBeNull();
  });
});
