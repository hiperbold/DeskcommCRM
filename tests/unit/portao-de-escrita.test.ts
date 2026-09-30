/**
 * O PORTÃO ÚNICO DAS ACTIONS QUE ESCREVEM CONFIGURAÇÃO (D-093 e D-137).
 *
 * ## O que a auditoria de 30/09/2026 provou
 *
 *  - D-137: `is_platform_admin && papel < admin` (repetido em 12 actions) vale
 *    para QUALQUER linha não revogada de `platform_admins`. Um operador de
 *    suporte `support_readonly` que também era viewer de uma empresa cliente,
 *    na sessão própria (sem modo de acompanhamento), apagava os dados dela.
 *  - D-093: as actions de plataforma (`updateSmtp`, `updateSignupMode`, ...)
 *    chamavam `requirePlatformAdmin()`, que aceita qualquer escopo e não olha
 *    `mfaEmDivida()`: o `support_readonly`, ou uma sessão aal1 de quem tem
 *    fator, trocava o SMTP da instalação e lia os links de redefinição de senha
 *    de todos. As de organização (`atualizarInterfaceDaEmpresa`, Nuvemshop,
 *    `definirExigenciaDeMfa`) também não cobravam o segundo fator.
 *
 * ## O que este arquivo mede
 *
 * Comportamento do helper e de actions REAIS chamadas nos cenários da auditoria.
 * Os dublês são a borda (sessão do GoTrue, leitura de `platform_admins`, banco):
 * o portão, `portaoDeAdminDaOrganizacao` e `requirePlatformAdminFull`, é real.
 *
 * ## Comando
 *
 *     npx vitest run tests/unit/portao-de-escrita.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const USER = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";

const h = vi.hoisted(() => ({
  papel: "viewer" as string,
  ehPlatformAdmin: false,
  escopo: "full" as "full" | "support_readonly" | null,
  mfaEmDivida: false,
  aal: "aal2" as "aal1" | "aal2",
  escritasNoBanco: [] as string[],
  modoGravado: [] as string[],
  exigeMfaGravado: [] as boolean[],
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (destino: string) => {
    throw new Error(`NEXT_REDIRECT:${destino}`);
  },
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/impersonate/support", () => ({
  supportWriteError: () => null,
  authenticatedSessionId: async () => "sessao",
}));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(async () => ({ id: USER, is_platform_admin: h.ehPlatformAdmin })),
  resolveActiveOrg: vi.fn(async () => ({ orgId: ORG, name: "Org", role: h.papel })),
  mfaEmDivida: vi.fn(async () => h.mfaEmDivida),
  sessionAal: vi.fn(async () => h.aal),
}));
/** Leitura da própria linha de `platform_admins` (o que decide o escopo). */
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (tabela: string) => {
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "is"]) b[m] = () => b;
      b.maybeSingle = async () => ({
        data: tabela === "platform_admins" && h.escopo ? { scope: h.escopo } : null,
        error: null,
      });
      return b;
    },
  }),
}));
/** Qualquer ESCRITA pelo cliente admin é registrada; a leitura devolve vazio. */
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async () => ({ data: null, error: null }),
    from: (tabela: string) => {
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "is", "limit"]) b[m] = () => b;
      for (const m of ["insert", "update", "upsert", "delete"]) {
        b[m] = () => {
          h.escritasNoBanco.push(`${tabela}.${m}`);
          return b;
        };
      }
      b.maybeSingle = async () => ({ data: null, error: null });
      b.single = async () => ({ data: null, error: null });
      b.then = (ok: (r: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(ok);
      return b;
    },
  }),
}));
/** O guarda de LEITURA da plataforma: devolve o escopo da linha (ou redireciona, como o real). */
vi.mock("@/lib/auth/requirePlatformAdmin", () => ({
  requirePlatformAdmin: vi.fn(async () => {
    if (!h.escopo) throw new Error("NEXT_REDIRECT:/admin/forbidden");
    return {
      user: { id: USER },
      platformAdmin: { user_id: USER, scope: h.escopo, mfa_required: false },
    };
  }),
}));
vi.mock("@/lib/auth/politica-de-cadastro", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/auth/politica-de-cadastro")>();
  return {
    ...real,
    modoDeCadastro: async () => "aberto",
    gravarModoDeCadastro: async (modo: string) => {
      h.modoGravado.push(modo);
      return true;
    },
  };
});

import { portaoDeAdminDaOrganizacao, requirePlatformAdminFull } from "@/lib/auth/portao-de-escrita";
import { apagarDadosOperacionaisDaOrganizacao } from "@/app/actions/settings/apagarDadosOperacionaisDaOrganizacao";
import { atualizarInterfaceDaEmpresa } from "@/app/actions/settings/atualizarInterfaceDaEmpresa";
import { definirExigenciaDeMfa } from "@/app/actions/auth/politicaDeMfa";
import { disconnectNuvemshop } from "@/app/actions/integrations/disconnectNuvemshop";
import { updateSignupMode } from "@/app/actions/settings/updateSignupMode";
import { updateSmtp } from "@/app/actions/settings/smtp";

const SUPORTE_SO_LEITURA_VIEWER = () => {
  h.papel = "viewer";
  h.ehPlatformAdmin = true;
  h.escopo = "support_readonly";
};

beforeEach(() => {
  h.papel = "admin";
  h.ehPlatformAdmin = false;
  h.escopo = null;
  h.mfaEmDivida = false;
  h.aal = "aal2";
  h.escritasNoBanco.length = 0;
  h.modoGravado.length = 0;
});

describe("portaoDeAdminDaOrganizacao", () => {
  const usuario = () => ({ id: USER, is_platform_admin: h.ehPlatformAdmin });
  const org = () => ({ role: h.papel as never });

  it("admin da empresa passa", async () => {
    expect(await portaoDeAdminDaOrganizacao(usuario(), org())).toEqual({ ok: true });
  });

  for (const papel of ["viewer", "agent", "manager"]) {
    it(`${papel} que não é admin de plataforma é recusado`, async () => {
      h.papel = papel;
      expect(await portaoDeAdminDaOrganizacao(usuario(), org())).toEqual({ ok: false, erro: "forbidden_role" });
    });
  }

  it("⭐ admin de plataforma support_readonly que é só viewer da empresa é recusado (D-137)", async () => {
    SUPORTE_SO_LEITURA_VIEWER();
    expect(await portaoDeAdminDaOrganizacao(usuario(), org())).toEqual({ ok: false, erro: "forbidden_role" });
  });

  it("CONTROLE POSITIVO: o MESMO viewer com escopo full passa", async () => {
    h.papel = "viewer";
    h.ehPlatformAdmin = true;
    h.escopo = "full";
    expect(await portaoDeAdminDaOrganizacao(usuario(), org())).toEqual({ ok: true });
  });

  it("escopo full, mas linha revogada/ausente na leitura, é recusado (falha fechada)", async () => {
    h.papel = "viewer";
    h.ehPlatformAdmin = true;
    h.escopo = null;
    expect(await portaoDeAdminDaOrganizacao(usuario(), org())).toEqual({ ok: false, erro: "forbidden_role" });
  });

  it("admin com fator e sessão aal1 é recusado por MFA (D-093)", async () => {
    h.mfaEmDivida = true;
    expect(await portaoDeAdminDaOrganizacao(usuario(), org())).toEqual({ ok: false, erro: "mfa_required" });
  });

  it("o papel é conferido ANTES do MFA: quem nem tem o papel recebe forbidden_role", async () => {
    h.papel = "viewer";
    h.mfaEmDivida = true;
    expect(await portaoDeAdminDaOrganizacao(usuario(), org())).toEqual({ ok: false, erro: "forbidden_role" });
  });

  it("admin de plataforma full com MFA em dívida também é recusado", async () => {
    h.papel = "viewer";
    h.ehPlatformAdmin = true;
    h.escopo = "full";
    h.mfaEmDivida = true;
    expect(await portaoDeAdminDaOrganizacao(usuario(), org())).toEqual({ ok: false, erro: "mfa_required" });
  });

  it("exigirAal2: sessão aal1 é recusada mesmo sem fator cadastrado; aal2 passa", async () => {
    h.aal = "aal1";
    expect(await portaoDeAdminDaOrganizacao(usuario(), org(), { exigirAal2: true })).toEqual({
      ok: false,
      erro: "mfa_required",
    });
    h.aal = "aal2";
    expect(await portaoDeAdminDaOrganizacao(usuario(), org(), { exigirAal2: true })).toEqual({ ok: true });
  });
});

describe("requirePlatformAdminFull: a instalação só é escrita por escopo full com MFA em dia", () => {
  it("full com MFA em dia devolve o contexto", async () => {
    h.escopo = "full";
    await expect(requirePlatformAdminFull()).resolves.toMatchObject({ platformAdmin: { scope: "full" } });
  });

  it("⭐ support_readonly é mandado para /admin/forbidden", async () => {
    h.escopo = "support_readonly";
    await expect(requirePlatformAdminFull()).rejects.toThrow("NEXT_REDIRECT:/admin/forbidden");
  });

  it("full com sessão aal1 de quem tem fator é mandado para /login/mfa", async () => {
    h.escopo = "full";
    h.mfaEmDivida = true;
    await expect(requirePlatformAdminFull()).rejects.toThrow("NEXT_REDIRECT:/login/mfa?next=/admin");
  });
});

describe("as actions, chamadas como a auditoria chamou", () => {
  it("⭐ apagar dados: support_readonly + viewer da empresa não emite DELETE nenhum", async () => {
    SUPORTE_SO_LEITURA_VIEWER();
    const r = await apagarDadosOperacionaisDaOrganizacao({ confirmNome: "Org" });
    expect(r).toEqual({ ok: false, error: "forbidden_role" });
    expect(h.escritasNoBanco).toEqual([]);
  });

  it("menu da empresa: support_readonly + viewer não grava", async () => {
    SUPORTE_SO_LEITURA_VIEWER();
    const r = await atualizarInterfaceDaEmpresa({ preset: "completa" });
    expect(r).toEqual({ ok: false, error: "forbidden_role" });
    expect(h.escritasNoBanco).toEqual([]);
  });

  it("menu da empresa: admin com fator e sessão aal1 não grava (mfa_required), admin em dia grava", async () => {
    h.papel = "admin";
    h.mfaEmDivida = true;
    expect(await atualizarInterfaceDaEmpresa({ preset: "completa" })).toEqual({
      ok: false,
      error: "mfa_required",
    });
    expect(h.escritasNoBanco).toEqual([]);

    h.mfaEmDivida = false;
    expect((await atualizarInterfaceDaEmpresa({ preset: "completa" })).ok).toBe(true);
    expect(h.escritasNoBanco.length).toBeGreaterThan(0);
  });

  it("Nuvemshop: support_readonly + viewer não desconecta a loja", async () => {
    SUPORTE_SO_LEITURA_VIEWER();
    expect(await disconnectNuvemshop()).toEqual({ ok: false, error: "forbidden" });
    expect(h.escritasNoBanco).toEqual([]);
  });

  it("Nuvemshop: sessão aal1 de quem tem fator não desconecta a loja", async () => {
    h.papel = "admin";
    h.mfaEmDivida = true;
    expect(await disconnectNuvemshop()).toEqual({ ok: false, error: "forbidden" });
    expect(h.escritasNoBanco).toEqual([]);
  });

  it("exigência de MFA da empresa: aal1 de quem tem fator não a derruba", async () => {
    h.papel = "admin";
    h.mfaEmDivida = true;
    const r = await definirExigenciaDeMfa(false);
    expect(r.ok).toBe(false);
    expect(h.escritasNoBanco).toEqual([]);
  });

  it("⭐ cadastro da instalação: support_readonly não muda o modo", async () => {
    h.escopo = "support_readonly";
    await expect(updateSignupMode({ signup_mode: "fechado" as never })).rejects.toThrow("NEXT_REDIRECT");
    expect(h.modoGravado).toEqual([]);
  });

  it("cadastro da instalação: full com MFA em dia muda o modo (controle positivo)", async () => {
    h.escopo = "full";
    const r = await updateSignupMode({ signup_mode: "aberto" as never });
    expect(r).toEqual({ ok: true });
    expect(h.modoGravado).toEqual(["aberto"]);
  });

  it("⭐ SMTP da instalação: support_readonly e aal1 de quem tem fator são barrados antes de qualquer gravação", async () => {
    const entrada = {
      host: "smtp.atacante.test",
      port: 587,
      security: "starttls" as const,
      username: "u",
      password: "p",
      from_email: "x@atacante.test",
      from_name: "X",
    };
    h.escopo = "support_readonly";
    await expect(updateSmtp(entrada)).rejects.toThrow("NEXT_REDIRECT:/admin/forbidden");
    h.escopo = "full";
    h.mfaEmDivida = true;
    await expect(updateSmtp(entrada)).rejects.toThrow("NEXT_REDIRECT:/login/mfa");
  });
});
