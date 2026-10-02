/**
 * D-131: o cron de aniversário vê TODAS as organizações com regra e TODOS os
 * aniversariantes (antes: 100 organizações e 200 contatos, sem ordem, uma vez ao
 * dia; o resto nunca recebia parabéns).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth/cron-auth", () => ({ autorizaCron: () => true }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const estado = vi.hoisted(() => ({
  orgs: [] as string[],
  contatos: [] as string[],
  emitidos: [] as string[],
  orgsConsultadas: new Set<string>(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      const f: Record<string, unknown> = {};
      let limite = Infinity;
      let apos: string | null = null;
      let ids: string[] | null = null;
      const q: Record<string, unknown> = {
        select: () => q,
        eq: (c: string, v: unknown) => ((f[c] = v), q),
        in: (c: string, v: string[]) => ((c === "id" || c === "entity_id") && (ids = v), q),
        not: () => q,
        gte: () => q,
        order: () => q,
        limit: (n: number) => ((limite = n), q),
        gt: (_c: string, v: string) => ((apos = v), q),
        then: (resolve: (v: unknown) => unknown) => {
          let data: unknown[] = [];
          if (tabela === "automation_rules") data = estado.orgs.map((o) => ({ organization_id: o }));
          else if (tabela === "organizations") data = (ids ?? []).map((id) => ({ id, timezone: null }));
          else if (tabela === "contacts") {
            estado.orgsConsultadas.add(f.organization_id as string);
            if (f.organization_id === estado.orgs[0]) {
              data = estado.contatos.filter((c) => apos === null || c > apos).slice(0, limite).map((id) => ({ id }));
            }
          }
          return Promise.resolve({ data, error: null }).then(resolve);
        },
      };
      return q;
    },
    rpc: async (_n: string, args: { p_entity_id: string }) => {
      estado.emitidos.push(args.p_entity_id);
      return { error: null };
    },
  }),
}));

import { GET } from "@/app/api/v1/cron/contact-birthdays/route";

beforeEach(() => {
  vi.useFakeTimers();
  // 9h em America/Sao_Paulo: a hora de parabenizar.
  vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
  estado.orgs = Array.from({ length: 130 }, (_, i) => `org-${String(i).padStart(3, "0")}`);
  estado.contatos = Array.from({ length: 450 }, (_, i) => `c-${String(i).padStart(4, "0")}`);
  estado.emitidos = [];
  estado.orgsConsultadas = new Set();
});
afterEach(() => vi.useRealTimers());

describe("cron de aniversário", () => {
  it("passa por todas as organizações com regra e por todos os contatos da organização grande", async () => {
    const res = await GET(new NextRequest("http://local/api/v1/cron/contact-birthdays"));
    expect(res.status).toBe(200);
    expect(estado.orgsConsultadas.size).toBe(130);
    expect(estado.emitidos).toHaveLength(450);
    expect(new Set(estado.emitidos).size).toBe(450);
  });
});
