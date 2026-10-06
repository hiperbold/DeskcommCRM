/**
 * D-133: o aceite do onboarding guarda QUAL versão dos Termos de Uso foi aceita, além da data. A
 * versão é a do servidor, nunca texto vindo do formulário.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  patches: [] as Array<Record<string, unknown>>,
  auditadas: [] as Array<Record<string, unknown>>,
}));

vi.mock("next/navigation", () => ({
  redirect: (destino: string) => {
    throw new Error(`NEXT_REDIRECT:${destino}`);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async (e: Record<string, unknown>) => {
    h.auditadas.push(e);
  }),
}));
vi.mock("@/app/actions/onboarding/_shared", () => ({
  OnboardingError: class OnboardingError extends Error {
    code = "db_error";
  },
  requireOnboardingCtx: vi.fn(async () => ({ userId: "u1", orgId: "o1" })),
  patchOnboardingState: vi.fn(async (_org: string, patch: Record<string, unknown>) => {
    h.patches.push(patch);
  }),
}));

import { acceptWelcome } from "@/app/actions/onboarding/acceptWelcome";
import { VERSAO_DOS_TERMOS } from "@/lib/legal/versao-dos-termos";

beforeEach(() => {
  h.patches.length = 0;
  h.auditadas.length = 0;
});

describe("acceptWelcome grava a versão dos Termos aceita", () => {
  it("no estado do onboarding e na auditoria, com a versão do servidor", async () => {
    const form = new FormData();
    form.set("display_name", "Minha Loja");
    form.set("timezone", "America/Sao_Paulo");
    form.set("terms_version", "1999-01-01");

    await expect(acceptWelcome(form)).rejects.toThrow("NEXT_REDIRECT:/onboarding");

    const welcome = h.patches[0]!.welcome as Record<string, unknown>;
    expect(welcome.terms_version).toBe(VERSAO_DOS_TERMOS);
    expect(typeof welcome.accepted_at).toBe("string");
    expect((h.auditadas[0]!.metadata as Record<string, unknown>).terms_version).toBe(VERSAO_DOS_TERMOS);
  });
});
