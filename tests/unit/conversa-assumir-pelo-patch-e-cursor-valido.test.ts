/**
 * D-165 (conversas): assumir pelo PATCH não toma a conversa de outro, e o cursor
 * da lista de conversas e o da timeline do lead só aceitam data e uuid.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/types";
import { decodeCursor as decodeTimeline, encodeCursor as encodeTimeline } from "@/lib/leads/timeline-query";
import { ehInstante, ehUuid } from "@/lib/query/cursor-seguro";

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({ rpc: async () => ({ data: null, error: null }) })),
}));

import { listConversationsHandler, patchConversationHandler } from "@/app/api/v1/conversations/_handler";

const ORG = "22222222-2222-4222-8222-222222222222";
const CONVERSA = "33333333-3333-4333-8333-333333333333";
const EU = "11111111-1111-4111-8111-111111111111";
const COLEGA = "44444444-4444-4444-8444-444444444444";

let dono: string | null;
let rpcArgs: Record<string, unknown> | null;
let rpcDevolveLinha: boolean;
let orCalls: string[];

function banco() {
  return {
    from: () => {
      const q: Record<string, unknown> = {
        select: () => q,
        update: () => q,
        eq: () => q,
        or: (e: string) => (orCalls.push(e), q),
        is: () => q,
        gt: () => q,
        lt: () => q,
        order: () => q,
        limit: () => q,
        ilike: () => q,
        in: () => q,
        neq: () => q,
        maybeSingle: async () => ({
          data: { id: CONVERSA, organization_id: ORG, assigned_to_user_id: dono, status: "open", service_revision: 1 },
          error: null,
        }),
        then: (r: (v: unknown) => unknown) => r({ data: [], error: null }),
      };
      return q;
    },
    rpc: async (nome: string, args: Record<string, unknown>) => {
      if (nome === "fn_conversation_assign") {
        rpcArgs = args;
        return { data: rpcDevolveLinha ? [{ id: CONVERSA }] : [], error: null };
      }
      return { data: null, error: null };
    },
  };
}
const ctx = { organization_id: ORG, actor: { type: "user" as const, id: EU }, requestId: "r1" };

beforeEach(() => {
  dono = null;
  rpcArgs = null;
  rpcDevolveLinha = true;
  orCalls = [];
});

describe("assumir pelo PATCH {status:'claimed'}", () => {
  it("conversa de OUTRO atendente: 409 e a função de atribuição nem roda", async () => {
    dono = COLEGA;
    await expect(
      patchConversationHandler(banco() as never, ctx, CONVERSA, { status: "claimed" } as never),
    ).rejects.toMatchObject({ status: 409 });
    expect(rpcArgs).toBeNull();
  });

  it("conversa livre: assume com a trava otimista ligada e o dono lido como esperado", async () => {
    dono = null;
    await patchConversationHandler(banco() as never, ctx, CONVERSA, { status: "claimed" } as never);
    expect(rpcArgs).toMatchObject({ p_enforce_expected: true, p_expected_assignee: null, p_to_user_id: EU });
  });

  it("conversa já minha: segue (idempotente)", async () => {
    dono = EU;
    await patchConversationHandler(banco() as never, ctx, CONVERSA, { status: "claimed" } as never);
    expect(rpcArgs).toMatchObject({ p_enforce_expected: true, p_expected_assignee: EU });
  });

  it("dono mudou entre a leitura e a escrita (a função devolve vazio): 409", async () => {
    rpcDevolveLinha = false;
    const r = patchConversationHandler(banco() as never, ctx, CONVERSA, { status: "claimed" } as never);
    await expect(r).rejects.toBeInstanceOf(ApiError);
    await expect(r).rejects.toMatchObject({ status: 409 });
  });
});

describe("cursor só aceita data e uuid", () => {
  const cursor = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

  it("lista de conversas: sort com condição injetada é 400 e não chega ao filtro", async () => {
    const mau = cursor({ sort: "2026-09-30T10:00:00Z),organization_id.neq.x,and(id.gt.0", id: CONVERSA });
    await expect(
      listConversationsHandler(banco() as never, ctx, { cursor: mau, limit: 10 } as never),
    ).rejects.toMatchObject({ status: 400 });
    expect(orCalls).toHaveLength(0);
  });

  it("lista de conversas: id que não é uuid é 400", async () => {
    const mau = cursor({ sort: "2026-09-30T10:00:00Z", id: "1),x.eq.2" });
    await expect(
      listConversationsHandler(banco() as never, ctx, { cursor: mau, limit: 10 } as never),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("lista de conversas: cursor legítimo vira o filtro de keyset", async () => {
    const bom = cursor({ sort: "2026-09-30T10:00:00.123456+00:00", id: CONVERSA });
    await listConversationsHandler(banco() as never, ctx, { cursor: bom, limit: 10 } as never);
    expect(orCalls[0]).toContain("2026-09-30T10:00:00.123456+00:00");
  });

  it("timeline do lead: o decodificador recusa o valor malformado e aceita o que ele mesmo gera", () => {
    expect(decodeTimeline(cursor({ performed_at: "2026-09-30T10:00:00Z),a.eq.1", id: CONVERSA }))).toBeNull();
    expect(decodeTimeline(cursor({ performed_at: "2026-09-30T10:00:00Z", id: "x,y" }))).toBeNull();
    const c = { performed_at: "2026-09-30 10:00:00.5+00", id: CONVERSA };
    expect(decodeTimeline(encodeTimeline(c))).toEqual(c);
  });

  it("helpers", () => {
    expect(ehInstante("2026-09-30T10:00:00.123456+00:00")).toBe(true);
    expect(ehInstante("2026-09-30 10:00:00+00")).toBe(true);
    expect(ehInstante("amanhã")).toBe(false);
    expect(ehUuid(CONVERSA)).toBe(true);
    expect(ehUuid("1),x")).toBe(false);
  });
});
