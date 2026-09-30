/**
 * COM SÓ A SENHA NÃO SE REMOVE A VERIFICAÇÃO EM DUAS ETAPAS DE NINGUÉM (D-136).
 *
 * ## A cadeia que a auditoria de 30/09/2026 provou
 *
 * 1. O atacante tem a senha de um admin com TOTP e entra: a sessão fica em aal1.
 * 2. `regenerateRecoveryCodes()` só conferia que existe um fator verificado:
 *    apagava os códigos antigos e devolvia 10 novos em texto.
 * 3. `useRecoveryCode({ email, code })` (que não exige sessão, é a tela de "perdi
 *    o celular") queimava um código e apagava TODOS os fatores TOTP da vítima.
 *
 * A conta passava a entrar só com senha e o dono perdia os próprios códigos sem
 * aviso. Gerar código de recuperação é operação EQUIVALENTE a MFA: exige o
 * segundo fator provado nesta sessão, como `desativarMfaDaConta` já exigia.
 *
 * ## O que este arquivo mede
 *
 * Comportamento das quatro actions, com `mfaEmDivida` e `sessionAal` REAIS sobre
 * um cliente Supabase de dublê (mockar `mfaEmDivida` seria testar o mock). Os
 * dublês são a borda: sessão do GoTrue, banco, e-mail.
 *
 * ## Comando
 *
 *     npx vitest run tests/unit/mfa-codigos-de-recuperacao-exigem-segundo-fator.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const EMAIL = "dono@empresa.test";

type Chamada = { tabela: string; op: string; filtros: Record<string, unknown>; linhas?: unknown[] };

const h = vi.hoisted(() => ({
  aal: "aal1" as "aal1" | "aal2",
  temFator: true,
  chamadas: [] as Array<{ tabela: string; op: string; filtros: Record<string, unknown>; linhas?: unknown[] }>,
  enviarEmail: vi.fn(),
  fatoresRemovidos: [] as string[],
  falhaAoRemoverFator: false,
  codigoValido: true,
}));

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "user-agent": "vitest", "x-request-id": "req-1" }),
}));
vi.mock("next/navigation", () => ({
  redirect: (destino: string) => {
    throw new Error(`NEXT_REDIRECT:${destino}`);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => undefined),
  isServiceRoleConfigured: () => true,
}));
vi.mock("@/lib/email/roteador", () => ({ sendEmail: h.enviarEmail }));
vi.mock("@/lib/branding/saida", () => ({ marcaDaSaida: async () => ({ nome: "Local" }) }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

/** Banco: registra o que é feito em `user_recovery_codes` (e lê o que as actions leem). */
function tabela(nome: string) {
  const c: Chamada = { tabela: nome, op: "select", filtros: {} };
  const b: Record<string, unknown> = {};
  const resolver = () => {
    h.chamadas.push(c);
    if (nome === "user_recovery_codes" && c.op === "select") {
      return { data: h.codigoValido ? { id: "c1", used_at: null } : null, error: null };
    }
    if (nome === "platform_admins") return { data: null, error: null };
    if (nome === "organizations") return { data: { settings: {} }, error: null };
    return { data: null, error: null };
  };
  for (const m of ["select", "limit", "is"]) b[m] = () => b;
  b.eq = (col: string, val: unknown) => {
    c.filtros[col] = val;
    return b;
  };
  b.delete = () => {
    c.op = "delete";
    return b;
  };
  b.update = () => {
    c.op = "update";
    return b;
  };
  b.insert = (linhas: unknown[]) => {
    c.op = "insert";
    c.linhas = linhas;
    return b;
  };
  b.maybeSingle = async () => resolver();
  b.then = (ok: (r: unknown) => unknown, no?: (e: unknown) => unknown) => Promise.resolve(resolver()).then(ok, no);
  return b;
}

function clienteDeSessao() {
  return {
    auth: {
      getUser: async () => ({ data: { user: { id: USER_ID, email: EMAIL } } }),
      mfa: {
        listFactors: async () => ({
          data: {
            totp: h.temFator ? [{ id: "f1", status: "verified" }] : [],
            all: h.temFator ? [{ id: "f1", status: "verified", factor_type: "totp" }] : [],
          },
          error: null,
        }),
        getAuthenticatorAssuranceLevel: async () => ({
          data: { currentLevel: h.aal, nextLevel: h.temFator ? "aal2" : h.aal },
          error: null,
        }),
        unenroll: async ({ factorId }: { factorId: string }) => {
          h.fatoresRemovidos.push(factorId);
          return { error: null };
        },
        challenge: async () => ({ data: { id: "ch1" }, error: null }),
        verify: async () => ({ error: null }),
      },
    },
    from: (t: string) => tabela(t),
  };
}

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => clienteDeSessao() }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (t: string) => tabela(t),
    auth: {
      admin: {
        listUsers: async () => ({ data: { users: [{ id: USER_ID, email: EMAIL }] }, error: null }),
        mfa: {
          listFactors: async () => ({ data: { factors: [{ id: "f1" }] }, error: null }),
          deleteFactor: async ({ id }: { id: string }) => {
            if (h.falhaAoRemoverFator) throw new Error("falha do GoTrue");
            h.fatoresRemovidos.push(id);
            return { error: null };
          },
        },
      },
    },
  }),
}));
vi.mock("@/lib/auth/server", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/auth/server")>();
  return {
    ...real,
    loadAuthUser: vi.fn(async () => ({ id: USER_ID, email: EMAIL, is_platform_admin: false, organizations: [] })),
    resolveActiveOrg: vi.fn(async () => ({ orgId: ORG_ID, name: "Org", role: "admin" })),
  };
});

import { regenerateRecoveryCodes } from "@/app/actions/settings/regenerateRecoveryCodes";
import { confirmMfaEnroll } from "@/app/actions/auth/confirmMfaEnroll";
import { useRecoveryCode } from "@/app/actions/auth/useRecoveryCode";
import { desativarMfaDaConta } from "@/app/actions/auth/politicaDeMfa";

const sobreCodigos = () => h.chamadas.filter((c) => c.tabela === "user_recovery_codes");
const escritas = () => sobreCodigos().filter((c) => c.op !== "select");

beforeEach(() => {
  h.aal = "aal1";
  h.temFator = true;
  h.chamadas.length = 0;
  h.fatoresRemovidos.length = 0;
  h.falhaAoRemoverFator = false;
  h.codigoValido = true;
  h.enviarEmail.mockReset();
  h.enviarEmail.mockResolvedValue({ ok: true, id: "m1", via: "smtp" });
});

describe("regenerateRecoveryCodes: gerar código é operação equivalente a MFA", () => {
  it("⭐ sessão aal1 de quem TEM fator é recusada: nada é apagado, gerado nem devolvido", async () => {
    h.aal = "aal1";
    const r = await regenerateRecoveryCodes();
    expect(r).toEqual({ ok: false, error: "mfa_required" });
    expect(escritas(), "com só a senha os códigos antigos foram apagados e novos gerados").toEqual([]);
    expect(h.enviarEmail).not.toHaveBeenCalled();
  });

  it("CONTROLE POSITIVO: o MESMO usuário com a sessão aal2 gera 10 códigos, troca os antigos e o dono é avisado", async () => {
    h.aal = "aal2";
    const r = await regenerateRecoveryCodes();
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.recovery_codes).toHaveLength(10);
    expect(escritas().map((c) => c.op)).toEqual(["delete", "insert"]);
    expect(escritas()[1]!.linhas).toHaveLength(10);
    expect(h.enviarEmail).toHaveBeenCalledTimes(1);
    expect(h.enviarEmail.mock.calls[0]![0]).toMatchObject({ to: EMAIL });
    // O aviso não carrega nenhum código em texto.
    for (const codigo of r.recovery_codes) {
      expect(JSON.stringify(h.enviarEmail.mock.calls[0]![0])).not.toContain(codigo);
    }
  });

  it("quem ainda não cadastrou fator continua recebendo mfa_not_enrolled (não há o que regenerar)", async () => {
    h.temFator = false;
    expect(await regenerateRecoveryCodes()).toEqual({ ok: false, error: "mfa_not_enrolled" });
  });

  it("e-mail que não sai não desfaz a regeneração", async () => {
    h.aal = "aal2";
    h.enviarEmail.mockRejectedValue(new Error("smtp fora"));
    expect((await regenerateRecoveryCodes()).ok).toBe(true);
  });
});

describe("useRecoveryCode: usar um código encerra todos os códigos da conta", () => {
  const entrada = { email: EMAIL, code: "ABCD2345" };

  it("remove os fatores E apaga todos os códigos que sobraram, e avisa o dono", async () => {
    await expect(useRecoveryCode(entrada)).rejects.toThrow("NEXT_REDIRECT:/login?recovery_used=1");
    expect(h.fatoresRemovidos).toEqual(["f1"]);
    const apagados = sobreCodigos().filter((c) => c.op === "delete");
    expect(apagados).toHaveLength(1);
    expect(apagados[0]!.filtros).toEqual({ user_id: USER_ID });
    expect(h.enviarEmail).toHaveBeenCalledTimes(1);
    expect(h.enviarEmail.mock.calls[0]![0]).toMatchObject({ to: EMAIL });
  });

  it("se a remoção do fator falhou, os códigos ficam (a pessoa ainda precisa deles)", async () => {
    h.falhaAoRemoverFator = true;
    await expect(useRecoveryCode(entrada)).rejects.toThrow("NEXT_REDIRECT");
    expect(sobreCodigos().filter((c) => c.op === "delete")).toEqual([]);
  });

  it("código inválido não apaga nada nem avisa ninguém", async () => {
    h.codigoValido = false;
    expect(await useRecoveryCode(entrada)).toEqual({ ok: false, error: "invalid_or_used" });
    expect(escritas()).toEqual([]);
    expect(h.enviarEmail).not.toHaveBeenCalled();
  });
});

describe("os códigos de um cadastro não sobrevivem ao seguinte", () => {
  it("confirmMfaEnroll apaga os códigos antigos ANTES de gravar o conjunto novo", async () => {
    const r = await confirmMfaEnroll("123456", "f1");
    expect(r.ok).toBe(true);
    expect(escritas().map((c) => c.op)).toEqual(["delete", "insert"]);
    expect(escritas()[0]!.filtros).toEqual({ user_id: USER_ID });
  });

  it("desativarMfaDaConta (sessão aal2) apaga os códigos junto com os fatores", async () => {
    h.aal = "aal2";
    const r = await desativarMfaDaConta();
    expect(r).toEqual({ ok: true });
    expect(h.fatoresRemovidos).toEqual(["f1"]);
    expect(escritas().map((c) => c.op)).toEqual(["delete"]);
    expect(escritas()[0]!.filtros).toEqual({ user_id: USER_ID });
  });

  it("desativarMfaDaConta em aal1 continua recusada e não apaga código nenhum", async () => {
    h.aal = "aal1";
    const r = await desativarMfaDaConta();
    expect(r.ok).toBe(false);
    expect(escritas()).toEqual([]);
  });
});
