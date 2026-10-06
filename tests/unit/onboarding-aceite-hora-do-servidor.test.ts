/**
 * B4 (auditoria do lote 16): o aceite do onboarding gravava `input.accepted_terms_at ?? agora`, e o
 * campo do schema é opcional e veio pelo parse. A data do aceite, que fica ao lado da versão dos
 * Termos como prova, tem que ser SEMPRE a hora do servidor, qualquer que seja o valor que o parse
 * devolva (formulário adulterado, schema que passe a aceitar o campo do cliente).
 *
 * O schema é dublado para devolver uma data do passado no campo `accepted_terms_at`, o pior caso de
 * um valor vindo do navegador chegar ao `input`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  patches: [] as Array<Record<string, unknown>>,
}));

vi.mock("next/navigation", () => ({
  redirect: (destino: string) => {
    throw new Error(`NEXT_REDIRECT:${destino}`);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/schemas/onboarding", () => ({
  welcomeSchema: {
    parse: (raw: Record<string, unknown>) => ({ ...raw, accepted_terms_at: "1999-01-01T00:00:00.000Z" }),
  },
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

beforeEach(() => {
  h.patches.length = 0;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-06T18:00:00.000Z"));
});
afterEach(() => vi.useRealTimers());

describe("acceptWelcome: a data do aceite é a hora do servidor", () => {
  it("ignora a data que o parse devolve (valor do navegador) e grava a do servidor", async () => {
    const form = new FormData();
    form.set("display_name", "Minha Loja");
    form.set("timezone", "America/Sao_Paulo");
    form.set("accepted_terms_at", "1999-01-01T00:00:00.000Z");

    await expect(acceptWelcome(form)).rejects.toThrow("NEXT_REDIRECT:/onboarding");

    const welcome = h.patches[0]!.welcome as Record<string, unknown>;
    expect(welcome.accepted_at).toBe("2026-10-06T18:00:00.000Z");
  });
});
