/**
 * D-097: o push de mensagem recebida entrega ao envio quem é o dono da conversa e o
 * modo de visibilidade da organização, para o envio filtrar quem não a veria. O envio
 * é falso aqui (a regra em si está em `push-so-para-quem-pode-ver.test.ts`); o que
 * se mede é o que o handler LEU do banco e passou adiante.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/notifications/vapid", () => ({ vapidPronto: () => true, vapidPublica: () => "pub", vapidSubject: async () => "mailto:x@y" }));
vi.mock("@/lib/branding/saida", () => ({ marcaDaSaida: async () => ({ nome: "Marca" }) }));
vi.mock("@/lib/notifications/web_push", () => ({
  enviarPushDaOrg: vi.fn().mockResolvedValue({ sent: 1, gone: 0 }),
  enviarPushAoUsuario: vi.fn().mockResolvedValue({ sent: 1, gone: 0 }),
}));

import { createAdminClient } from "@/lib/supabase/admin";
import { enviarPushDaOrg } from "@/lib/notifications/web_push";
import { webPushInboundHandler } from "@/lib/notifications/push.handler";
import type { EventRow } from "@/lib/event-log/dispatcher";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONVERSA = "33333333-3333-4333-8333-333333333333";

function banco(linhas: Record<string, Record<string, unknown> | null>) {
  return {
    from(tabela: string) {
      const q = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => ({ data: linhas[tabela] ?? null, error: null }),
      };
      return q;
    },
    storage: { from: () => ({ createSignedUrl: async () => ({ data: null }) }) },
  };
}

const evento = (payload: Record<string, unknown>): EventRow =>
  ({
    id: "e1",
    organization_id: ORG,
    event_type: "message.received",
    entity_kind: "message",
    entity_id: "m1",
    payload,
    metadata: {},
    consumed_by: [],
    attempts: 0,
  }) as unknown as EventRow;

beforeEach(() => {
  vi.mocked(enviarPushDaOrg).mockClear();
});

describe("push de mensagem recebida × visibilidade", () => {
  it("passa o dono da conversa e o modo da organização ao envio", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      banco({
        conversations: { assigned_to_user_id: "dono-1" },
        organizations: { settings: { visibility_mode: "own" } },
      }) as never,
    );
    await webPushInboundHandler.handle(evento({ conversation_id: CONVERSA, body_preview: "oi", type: "text" }));
    const opcoes = vi.mocked(enviarPushDaOrg).mock.calls[0]![3];
    expect(opcoes).toEqual({ conversa: { assignedToUserId: "dono-1", modoDeVisibilidade: "own" } });
  });

  it("conversa que não se acha entra como a mais fechada (só quem vê a empresa inteira)", async () => {
    vi.mocked(createAdminClient).mockReturnValue(banco({ organizations: { settings: {} } }) as never);
    await webPushInboundHandler.handle(evento({ conversation_id: CONVERSA, body_preview: "oi", type: "text" }));
    expect(vi.mocked(enviarPushDaOrg).mock.calls[0]![3]).toEqual({
      conversa: { assignedToUserId: null, modoDeVisibilidade: "own" },
    });
  });
});
