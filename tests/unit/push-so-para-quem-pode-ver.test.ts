/**
 * D-097: o push só vai para quem ainda é membro da organização e pode ver a
 * conversa, e só chama endereços de serviço de push de navegador.
 *
 * `web-push` (biblioteca externa, a rede) é falso; `enviarPushDaOrg` e as regras de
 * visibilidade rodam de verdade, sobre um banco falso que responde às consultas de
 * inscrição e de vínculo. O que se mede é para QUEM o `sendNotification` foi chamado.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const enviados: string[] = [];

vi.mock("web-push", () => ({
  default: {
    setVapidDetails: () => undefined,
    sendNotification: async (sub: { endpoint: string }) => {
      enviados.push(sub.endpoint);
    },
  },
}));
vi.mock("@/lib/env", () => ({ env: { VAPID_PRIVATE_KEY: "priv", VAPID_PUBLIC_KEY: "pub", NEXT_PUBLIC_APP_URL: "https://x.test" } }));
vi.mock("@/lib/notifications/vapid", () => ({
  vapidPronto: () => true,
  vapidPublica: () => "pub",
  vapidSubject: async () => "mailto:x@y.test",
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import { enviarPushDaOrg, papelPodeVerConversa } from "@/lib/notifications/web_push";
import { endpointDePushPermitido } from "@/lib/notifications/endpoint-de-push";

const ORG = "11111111-1111-4111-8111-111111111111";
const FCM = (n: string) => `https://fcm.googleapis.com/fcm/send/${n}`;

interface Sub { id: string; user_id: string; endpoint: string; p256dh: string; auth: string }
interface Vinculo { user_id: string; role: string; revoked_at: string | null }

function banco(subs: Sub[], vinculos: Vinculo[] | "erro") {
  return {
    from: (tabela: string) => ({
      select: () => ({
        eq: async () =>
          tabela === "push_subscriptions"
            ? { data: subs, error: null }
            : vinculos === "erro"
              ? { data: null, error: { message: "falhou" } }
              : { data: vinculos, error: null },
      }),
      delete: () => ({ eq: async () => ({ error: null }) }),
    }),
  };
}

const sub = (user: string, endpoint = FCM(user)): Sub => ({ id: `s-${user}`, user_id: user, endpoint, p256dh: "k", auth: "a" });
const payload = { title: "t", body: "b", tag: "x", href: "/app/inbox" };

beforeEach(() => {
  enviados.length = 0;
});

describe("enviarPushDaOrg: quem ainda pertence à organização", () => {
  it("CONTROLE POSITIVO: membro ativo recebe", async () => {
    const r = await enviarPushDaOrg(ORG, payload, banco([sub("ativo")], [{ user_id: "ativo", role: "agent", revoked_at: null }]) as never);
    expect(r.sent).toBe(1);
    expect(enviados).toEqual([FCM("ativo")]);
  });

  it("⭐ quem foi revogado da organização não recebe mais, e quem nunca foi membro também não", async () => {
    const r = await enviarPushDaOrg(
      ORG,
      payload,
      banco(
        [sub("revogado"), sub("estranho"), sub("ativo")],
        [
          { user_id: "revogado", role: "agent", revoked_at: "2026-09-01T00:00:00Z" },
          { user_id: "ativo", role: "admin", revoked_at: null },
        ],
      ) as never,
    );
    expect(r.sent).toBe(1);
    expect(enviados).toEqual([FCM("ativo")]);
  });

  it("aviso pessoal: só o usuário pedido, e revogado não recebe nem o aviso pessoal", async () => {
    const vinculos: Vinculo[] = [
      { user_id: "a", role: "agent", revoked_at: null },
      { user_id: "b", role: "agent", revoked_at: "2026-09-01T00:00:00Z" },
    ];
    await enviarPushDaOrg(ORG, payload, banco([sub("a"), sub("b")], vinculos) as never, { userId: "a" });
    expect(enviados).toEqual([FCM("a")]);
    enviados.length = 0;
    await enviarPushDaOrg(ORG, payload, banco([sub("a"), sub("b")], vinculos) as never, { userId: "b" });
    expect(enviados).toEqual([]);
  });

  it("falha ao consultar os vínculos: não manda para ninguém (falha fechada)", async () => {
    const r = await enviarPushDaOrg(ORG, payload, banco([sub("a")], "erro") as never);
    expect(r.sent).toBe(0);
    expect(enviados).toEqual([]);
  });
});

describe("enviarPushDaOrg: quem pode ver a conversa", () => {
  const vinculos: Vinculo[] = [
    { user_id: "dono", role: "agent", revoked_at: null },
    { user_id: "outro-agent", role: "agent", revoked_at: null },
    { user_id: "viewer", role: "viewer", revoked_at: null },
    { user_id: "gerente", role: "manager", revoked_at: null },
  ];
  const subs = () => ["dono", "outro-agent", "viewer", "gerente"].map((u) => sub(u));

  it("⭐ conversa de outro atendente no modo own_and_unassigned: o outro agent não recebe", async () => {
    await enviarPushDaOrg(ORG, payload, banco(subs(), vinculos) as never, {
      conversa: { assignedToUserId: "dono", modoDeVisibilidade: "own_and_unassigned" },
    });
    expect(enviados.sort()).toEqual([FCM("dono"), FCM("gerente"), FCM("viewer")].sort());
  });

  it("modo own: conversa sem dono só vai para quem vê a empresa inteira", async () => {
    await enviarPushDaOrg(ORG, payload, banco(subs(), vinculos) as never, {
      conversa: { assignedToUserId: null, modoDeVisibilidade: "own" },
    });
    expect(enviados.sort()).toEqual([FCM("gerente"), FCM("viewer")].sort());
  });

  it("modo all: todos os agents recebem; conversa sem dono no padrão: todos recebem", async () => {
    await enviarPushDaOrg(ORG, payload, banco(subs(), vinculos) as never, {
      conversa: { assignedToUserId: "dono", modoDeVisibilidade: "all" },
    });
    expect(enviados).toHaveLength(4);
    enviados.length = 0;
    await enviarPushDaOrg(ORG, payload, banco(subs(), vinculos) as never, {
      conversa: { assignedToUserId: null, modoDeVisibilidade: null },
    });
    expect(enviados).toHaveLength(4);
  });

  it("papelPodeVerConversa espelha fn_can_view_conversation e nega papel desconhecido", () => {
    expect(papelPodeVerConversa("agent", "u", { assignedToUserId: "u", modoDeVisibilidade: "own" })).toBe(true);
    expect(papelPodeVerConversa("agent", "u", { assignedToUserId: "x", modoDeVisibilidade: "own" })).toBe(false);
    expect(papelPodeVerConversa("outro", "u", { assignedToUserId: null, modoDeVisibilidade: "all" })).toBe(false);
  });
});

describe("D-097 vizinho: o servidor só chama serviços de push de navegador", () => {
  it("⭐ endereço interno ou http na inscrição não é chamado no envio", async () => {
    const vinculos: Vinculo[] = ["a", "b", "c", "d"].map((u) => ({ user_id: u, role: "admin", revoked_at: null }));
    await enviarPushDaOrg(
      ORG,
      payload,
      banco(
        [
          sub("a", "http://169.254.169.254/latest/meta-data"),
          sub("b", "https://servico-interno.local/hook"),
          sub("c", "https://fcm.googleapis.com.atacante.test/x"),
          sub("d", FCM("d")),
        ],
        vinculos,
      ) as never,
    );
    expect(enviados).toEqual([FCM("d")]);
  });

  it("endpointDePushPermitido", () => {
    expect(endpointDePushPermitido(FCM("x"))).toBe(true);
    expect(endpointDePushPermitido("https://updates.push.services.mozilla.com/wpush/v2/abc")).toBe(true);
    expect(endpointDePushPermitido("https://wns2-par02p.notify.windows.com/w/?token=x")).toBe(true);
    expect(endpointDePushPermitido("https://web.push.apple.com/abc")).toBe(true);
    expect(endpointDePushPermitido("http://fcm.googleapis.com/x")).toBe(false);
    expect(endpointDePushPermitido("https://fcm.googleapis.com:8443/x")).toBe(false);
    expect(endpointDePushPermitido("https://u:p@fcm.googleapis.com/x")).toBe(false);
    expect(endpointDePushPermitido("https://localhost/x")).toBe(false);
    expect(endpointDePushPermitido("não é url")).toBe(false);
  });
});

describe("PUT /api/v1/notifications/push recusa endpoint fora dos serviços de push", () => {
  it("422 para endereço interno; 200 para o do Chrome", async () => {
    vi.resetModules();
    vi.doMock("@/lib/auth/require-role", () => ({
      requireRole: async () => ({ ok: true, user: { id: "u1", idioma: "pt-BR" }, org: { orgId: ORG, role: "viewer" } }),
    }));
    vi.doMock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
    vi.doMock("@/lib/audit", () => ({ audit: vi.fn() }));
    vi.doMock("@/lib/supabase/server", () => ({
      createClient: async () => ({ from: () => ({ upsert: async () => ({ error: null }) }) }),
    }));
    const { PUT } = await import("@/app/api/v1/notifications/push/route");
    const corpo = (endpoint: string) =>
      new NextRequest("http://localhost/api/v1/notifications/push", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ endpoint, keys: { p256dh: "k", auth: "a" } }),
      });
    expect((await PUT(corpo("https://servico-interno.local/hook"))).status).toBe(422);
    expect((await PUT(corpo("http://169.254.169.254/x"))).status).toBe(422);
    expect((await PUT(corpo(FCM("novo")))).status).toBe(200);
  });
});
