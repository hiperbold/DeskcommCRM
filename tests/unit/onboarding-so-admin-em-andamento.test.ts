/**
 * O ONBOARDING É ATO DE ADMINISTRADOR, EM ORGANIZAÇÃO AINDA NÃO CONCLUÍDA
 * (D-089 e D-090 da auditoria de 30/09/2026).
 *
 * ## O defeito
 *
 * `requireOnboardingCtx` só conferia sessão, organização ativa e suporte. As
 * server actions do onboarding escrevem com service role, e o id de cada uma
 * está no bundle do formulário: um viewer ou agent chamava
 * `sendOnboardingInvites({ invitations: [{ email, role: "admin" }] })`, a action
 * assinava o token com papel admin SEM gravar `team_invites` (invisível na tela
 * de Equipe, não revogável, fora do teto de membros do plano) e, com o e-mail
 * falhando, devolvia o link de aceite. A segunda conta virava admin. As demais
 * actions renomeavam a empresa, religavam o agente padrão e apagavam o prompt.
 *
 * ## O que este arquivo mede
 *
 * COMPORTAMENTO, não implementação: o que cada papel consegue fazer chamando a
 * action de verdade. O único dublê é a borda (auth/sessão, banco e e-mail); o
 * portão, `emitirConvite`, `issueInvite` e a assinatura do token são os reais.
 *
 * ## Comando
 *
 *     npx vitest run tests/unit/onboarding-so-admin-em-andamento.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "33333333-3333-4333-8333-333333333333";
const USER = "11111111-1111-4111-8111-111111111111";

const h = vi.hoisted(() => ({
  papel: "admin" as string,
  mfaEmDivida: false,
  onboardedAt: null as string | null,
  planoRecusa: false,
  enviarEmail: vi.fn(),
  inseridos: [] as Array<Record<string, unknown>>,
  atualizacoesDeOrg: [] as Array<Record<string, unknown>>,
  redirecionou: [] as string[],
}));

vi.mock("@/lib/env", () => ({ env: { NEXT_PUBLIC_APP_URL: "http://localhost:3000" } }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/email/roteador", () => ({ sendEmail: h.enviarEmail }));
vi.mock("@/lib/branding/saida", () => ({ marcaDaSaida: async () => ({ nome: "Local", cor: "#000000" }) }));
vi.mock("@/lib/email/templates/invite", () => ({
  buildInviteEmail: () => ({ subject: "Convite", html: "Convite", text: "Convite" }),
}));
vi.mock("next/navigation", () => ({
  redirect: (destino: string) => {
    h.redirecionou.push(destino);
    throw new Error(`NEXT_REDIRECT:${destino}`);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ supportWriteError: () => null }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(async () => ({ id: USER, email: "membro@qa.local", full_name: "Membro" })),
  resolveActiveOrg: vi.fn(async () => ({ orgId: ORG, name: "QA", role: h.papel })),
  mfaEmDivida: vi.fn(async () => h.mfaEmDivida),
}));

/** Banco no formato do PostgREST: encadeável e thenable, só o que as actions tocam. */
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      let op: "select" | "insert" | "update" = "select";
      let payload: Record<string, unknown> = {};
      const b: Record<string, unknown> = {};
      const resolver = () => {
        if (tabela === "organizations") {
          if (op === "update") {
            h.atualizacoesDeOrg.push(payload);
            return { data: null, error: null };
          }
          return {
            data: { onboarding_state: {}, onboarded_at: h.onboardedAt },
            error: null,
          };
        }
        if (tabela === "team_invites") {
          if (op === "insert") {
            if (h.planoRecusa) {
              return {
                data: null,
                error: { code: "PT402", message: "Limite do plano atingido", details: "membros" },
              };
            }
            h.inseridos.push(payload);
            return {
              data: {
                ...payload,
                resend_count: 0,
                last_sent_at: new Date().toISOString(),
              },
              error: null,
            };
          }
          return { data: null, error: null };
        }
        throw new Error(`tabela não dublada: ${tabela}`);
      };
      for (const m of ["eq", "is", "select", "limit"]) b[m] = () => b;
      b.insert = (p: Record<string, unknown>) => {
        op = "insert";
        payload = p;
        return b;
      };
      b.update = (p: Record<string, unknown>) => {
        op = "update";
        payload = p;
        return b;
      };
      b.single = async () => resolver();
      b.maybeSingle = async () => resolver();
      b.then = (ok: (r: unknown) => unknown, no?: (e: unknown) => unknown) =>
        Promise.resolve(resolver()).then(ok, no);
      return b;
    },
  }),
}));

import { requireOnboardingCtx, OnboardingError } from "@/app/actions/onboarding/_shared";
import { sendOnboardingInvites } from "@/app/actions/onboarding/sendOnboardingInvites";
import { acceptWelcome } from "@/app/actions/onboarding/acceptWelcome";
import { skipAi } from "@/app/actions/onboarding/createDefaultAgent";
import { finishOnboarding } from "@/app/actions/onboarding/finishOnboarding";
import { verifyInviteToken } from "@/lib/auth/invite-token";

const CONVITE_DE_ADMIN = { invitations: [{ email: "Segunda.Conta@Qa.Local", role: "admin" as const }] };

async function codigoDeRecusa(chamada: () => Promise<unknown>): Promise<string | null> {
  try {
    await chamada();
    return null;
  } catch (err) {
    return err instanceof OnboardingError ? err.code : `outro:${String(err)}`;
  }
}

beforeEach(() => {
  h.papel = "admin";
  h.mfaEmDivida = false;
  h.onboardedAt = null;
  h.planoRecusa = false;
  h.inseridos.length = 0;
  h.atualizacoesDeOrg.length = 0;
  h.redirecionou.length = 0;
  h.enviarEmail.mockReset();
  h.enviarEmail.mockResolvedValue({ ok: false, error: "not_configured" });
});

describe("requireOnboardingCtx: quem pode conduzir o onboarding", () => {
  it("administrador de organização em andamento passa", async () => {
    const ctx = await requireOnboardingCtx();
    expect(ctx).toMatchObject({ userId: USER, orgId: ORG, role: "admin" });
  });

  for (const papel of ["viewer", "agent", "manager"]) {
    it(`${papel} é recusado (forbidden), e a organização não é tocada`, async () => {
      h.papel = papel;
      expect(await codigoDeRecusa(() => requireOnboardingCtx())).toBe("forbidden");
    });
  }

  it("admin com fator cadastrado e sessão aal1 é recusado (mfa_required)", async () => {
    h.mfaEmDivida = true;
    expect(await codigoDeRecusa(() => requireOnboardingCtx())).toBe("mfa_required");
  });

  it("organização JÁ concluída (onboarded_at) recusa até o admin", async () => {
    h.onboardedAt = "2026-09-01T10:00:00Z";
    expect(await codigoDeRecusa(() => requireOnboardingCtx())).toBe("forbidden");
  });

  it("permitirConcluido deixa o admin passar (o segundo clique de 'concluir'), mas segue exigindo admin", async () => {
    h.onboardedAt = "2026-09-01T10:00:00Z";
    await expect(requireOnboardingCtx({ permitirConcluido: true })).resolves.toMatchObject({ role: "admin" });
    h.papel = "viewer";
    expect(await codigoDeRecusa(() => requireOnboardingCtx({ permitirConcluido: true }))).toBe("forbidden");
  });
});

describe("D-089: convite do onboarding não vira admin por quem não é admin", () => {
  for (const papel of ["viewer", "agent"]) {
    it(`${papel} chamando a action com role admin: nada é assinado, gravado nem enviado`, async () => {
      h.papel = papel;
      const r = await sendOnboardingInvites(CONVITE_DE_ADMIN);
      expect(r).toEqual({ ok: false, error: "forbidden" });
      expect(h.enviarEmail).not.toHaveBeenCalled();
      expect(h.inseridos).toEqual([]);
    });
  }

  it("o link de aceite NÃO é devolvido a quem não é admin, mesmo com o e-mail falhando", async () => {
    h.papel = "viewer";
    const r = await sendOnboardingInvites(CONVITE_DE_ADMIN);
    expect(JSON.stringify(r)).not.toContain("accept-invite");
  });

  it("admin: o convite vira LINHA em team_invites (visível e revogável) e o token carrega o convidador", async () => {
    const r = await sendOnboardingInvites(CONVITE_DE_ADMIN);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(h.inseridos).toHaveLength(1);
    expect(h.inseridos[0]).toMatchObject({
      organization_id: ORG,
      email: "segunda.conta@qa.local",
      role: "admin",
      invited_by: USER,
    });
    const token = r.undelivered![0]!.accept_url.split("/").at(-1)!;
    const payload = verifyInviteToken(token);
    expect(payload).toMatchObject({
      invite_id: h.inseridos[0]!.id,
      organization_id: ORG,
      role: "admin",
      invited_by: USER,
    });
  });

  it("o teto do plano recusa o item, e a frase fixa volta para a tela (não o texto do banco)", async () => {
    h.planoRecusa = true;
    const r = await sendOnboardingInvites(CONVITE_DE_ADMIN);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.failed).toBe(1);
    expect(r.recusados?.[0]?.motivo).toMatch(/limite de membros/);
    expect(JSON.stringify(r)).not.toContain("Limite do plano atingido");
  });

  it("e-mail entregue em todos: segue para o próximo passo do wizard", async () => {
    h.enviarEmail.mockResolvedValue({ ok: true, id: "m1", via: "smtp" });
    await expect(sendOnboardingInvites(CONVITE_DE_ADMIN)).rejects.toThrow("NEXT_REDIRECT:/onboarding");
    expect(h.inseridos).toHaveLength(1);
  });
});

describe("D-090: dadosDoPasso recebia o orgId por argumento (endpoint público)", () => {
  it("viewer não lê o quadro nem gasta a chave de IA de uma organização", async () => {
    const { dadosDoPasso } = await import("@/app/actions/onboarding/montarQuadro");
    h.papel = "viewer";
    await expect(dadosDoPasso(ORG, "Empresa")).rejects.toMatchObject({ code: "forbidden" });
  });

  it("admin com o orgId de OUTRA organização é recusado antes de qualquer leitura", async () => {
    const { dadosDoPasso } = await import("@/app/actions/onboarding/montarQuadro");
    await expect(
      dadosDoPasso("99999999-9999-4999-8999-999999999999", "Empresa"),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("D-090: as demais actions do onboarding também são de admin em andamento", () => {
  it("acceptWelcome: viewer não renomeia a empresa nem muda o fuso", async () => {
    h.papel = "viewer";
    const form = new FormData();
    form.set("display_name", "Empresa Sequestrada");
    form.set("timezone", "Asia/Tokyo");
    const r = await acceptWelcome(form);
    expect(r).toEqual({ ok: false, error: "forbidden" });
    expect(h.atualizacoesDeOrg).toEqual([]);
  });

  it("acceptWelcome: admin em andamento grava", async () => {
    const form = new FormData();
    form.set("display_name", "Minha Empresa");
    form.set("timezone", "America/Sao_Paulo");
    await expect(acceptWelcome(form)).rejects.toThrow("NEXT_REDIRECT:/onboarding");
    expect(h.atualizacoesDeOrg.length).toBeGreaterThan(0);
  });

  it("skipAi: agent é recusado antes de escrever o estado do onboarding", async () => {
    h.papel = "agent";
    await expect(skipAi()).rejects.toMatchObject({ code: "forbidden" });
    expect(h.atualizacoesDeOrg).toEqual([]);
  });

  it("skipAi: depois de concluído nem o admin roda a action de novo", async () => {
    h.onboardedAt = "2026-09-01T10:00:00Z";
    await expect(skipAi()).rejects.toMatchObject({ code: "forbidden" });
    expect(h.atualizacoesDeOrg).toEqual([]);
  });

  it("finishOnboarding: viewer não marca a organização como concluída", async () => {
    h.papel = "viewer";
    const r = await finishOnboarding();
    expect(r).toEqual({ ok: false, error: "forbidden" });
    expect(h.atualizacoesDeOrg).toEqual([]);
  });

  it("finishOnboarding: o admin que clica de novo depois de concluído cai no redirect, sem erro", async () => {
    h.onboardedAt = "2026-09-01T10:00:00Z";
    await expect(finishOnboarding()).rejects.toThrow("NEXT_REDIRECT:/app/inbox");
  });
});
