/**
 * O push da régua de renovação (D-177, parte 2): só os marcos de ação (severidade warn) vão ao celular,
 * e só o aviso que a régua criou (linha em `billing_avisos_de_renovacao`); o aviso de plano que não é da
 * régua (modo leitura) segue sem push. Molde: `tests/unit/push-dos-avisos.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/notifications/vapid", () => ({ vapidPronto: () => true, vapidPublica: () => "pub", vapidSubject: async () => "mailto:x@y" }));
vi.mock("@/lib/notifications/web_push", () => ({
  enviarPushDaOrg: vi.fn().mockResolvedValue({ sent: 1, gone: 0 }),
  enviarPushAoUsuario: vi.fn().mockResolvedValue({ sent: 1, gone: 0 }),
}));

import { createAdminClient } from "@/lib/supabase/admin";
import { enviarPushDaOrg } from "@/lib/notifications/web_push";
import { webPushInboundHandler } from "@/lib/notifications/push.handler";
import type { EventRow } from "@/lib/event-log/dispatcher";

const ORG = "11111111-1111-4111-8111-111111111111";
const filtros: Array<[string, string, unknown]> = [];

function banco(linhas: Record<string, Record<string, unknown> | null>) {
  return {
    from(tabela: string) {
      const q = {
        select: () => q,
        eq: (coluna: string, valor: unknown) => {
          filtros.push([tabela, coluna, valor]);
          return q;
        },
        maybeSingle: async () => ({ data: linhas[tabela] ?? null, error: null }),
      };
      return q;
    },
  };
}

const evento = (payload: Record<string, unknown>): EventRow => ({
  id: "evt", organization_id: ORG, event_type: "central.aviso_criado", entity_kind: "agent_inbox_item", entity_id: null,
  payload, metadata: {}, consumed_by: [], attempts: 0, created_at: new Date().toISOString(),
});

const aviso = (severity: string) => ({
  id: "i1", kind: "other", ref_kind: "billing_assinatura", ref_id: ORG, severity,
  title: "Falta 1 dia para o fim do seu plano Pro", body: "O acesso vai até 06/11/2026.",
});

beforeEach(() => {
  vi.mocked(enviarPushDaOrg).mockClear();
  filtros.length = 0;
});

describe("aviso de renovação → celular", () => {
  it("marco de ação (warn): título e corpo do aviso, abrindo Plano e uso", async () => {
    vi.mocked(createAdminClient).mockReturnValue(banco({
      agent_inbox_items: aviso("warn"),
      billing_avisos_de_renovacao: { id: "r1" },
    }) as never);
    const r = await webPushInboundHandler.handle(evento({ item_id: "i1" }));
    expect(r.status).toBe("ok");
    expect(vi.mocked(enviarPushDaOrg).mock.calls[0]![1]).toEqual({
      title: "Falta 1 dia para o fim do seu plano Pro",
      body: "O acesso vai até 06/11/2026.",
      tag: "aviso:i1",
      href: "/app/settings/plano",
    });
    expect(filtros).toContainEqual(["billing_avisos_de_renovacao", "organization_id", ORG]);
    expect(filtros).toContainEqual(["billing_avisos_de_renovacao", "inbox_item_id", "i1"]);
  });

  it("30 e 15 dias (info): fica na Central e no e-mail, sem push", async () => {
    vi.mocked(createAdminClient).mockReturnValue(banco({
      agent_inbox_items: aviso("info"),
      billing_avisos_de_renovacao: { id: "r1" },
    }) as never);
    const r = await webPushInboundHandler.handle(evento({ item_id: "i1" }));
    expect(r.status).toBe("skipped");
    expect(enviarPushDaOrg).not.toHaveBeenCalled();
  });

  it("aviso de plano que não é da régua (modo leitura): sem push, como sempre foi", async () => {
    vi.mocked(createAdminClient).mockReturnValue(banco({
      agent_inbox_items: aviso("critical"),
      billing_avisos_de_renovacao: null,
    }) as never);
    const r = await webPushInboundHandler.handle(evento({ item_id: "i1" }));
    expect(r.status).toBe("skipped");
    expect(enviarPushDaOrg).not.toHaveBeenCalled();
  });
});
