/**
 * D-152: o admin da plataforma só lê conversa de cliente com acompanhamento
 * (sessão de suporte) ativo na organização.
 *
 * Roda os Route Handlers REAIS de `admin/inbox/conversations` (lista e detalhe)
 * com o Supabase dublado. O dublê de `fn_support_context` devolve o que o banco
 * devolveria: nada (sem acompanhamento), `revoked` (aal2 perdido) ou `active`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/requirePlatformAdmin", () => ({ requirePlatformAdmin: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

import { GET as LISTA } from "@/app/api/v1/admin/inbox/conversations/route";
import { GET as DETALHE } from "@/app/api/v1/admin/inbox/conversations/[id]/route";

const ADMIN = "11111111-1111-4111-8111-111111111111";
const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CONVERSA_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CONVERSA_B = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const CONTATO = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

interface Estado {
  suporte: Record<string, unknown> | null;
  auditoriaTerminou: boolean;
  /** Filtros que o service role recebeu, por tabela. */
  filtros: Record<string, Array<[string, unknown]>>;
  orCalls: string[];
  contatoAnonimizado: boolean;
  usouAdmin: boolean;
}

function suporte(org: string, status = "active") {
  return {
    id: "99999999-9999-4999-8999-999999999999",
    organization_id: org,
    actor_user_id: ADMIN,
    auth_session_id: "88888888-8888-4888-8888-888888888888",
    previous_organization_id: null,
    expires_at: "2026-10-02T15:00:00.000Z",
    name: "Org",
    locale: null,
    access_mode: "support_readonly",
    status,
  };
}

const CONVERSAS = {
  [CONVERSA_A]: { id: CONVERSA_A, organization_id: ORG_A, contact_id: CONTATO },
  [CONVERSA_B]: { id: CONVERSA_B, organization_id: ORG_B, contact_id: null },
} as Record<string, Record<string, unknown>>;

function adminStub(estado: Estado) {
  return {
    from: (tabela: string) => {
      estado.usouAdmin = true;
      const filtros = (estado.filtros[tabela] ??= []);
      const q = {
        select: () => q,
        eq: (k: string, v: unknown) => (filtros.push([k, v]), q),
        order: () => q,
        limit: () => q,
        ilike: () => q,
        is: () => q,
        or: (expr: string) => (estado.orCalls.push(expr), q),
        maybeSingle: async () => {
          const f = Object.fromEntries(filtros);
          if (tabela === "conversations") {
            const c = CONVERSAS[String(f.id)];
            // O service role não tem RLS: só o filtro de organização separa os clientes.
            const casa = c && (f.organization_id === undefined || f.organization_id === c.organization_id);
            return { data: casa ? c : null, error: null };
          }
          if (tabela === "contacts") {
            return {
              data: {
                id: CONTATO,
                name: "Maria",
                phone_number: "+5511999990000",
                email: "m@x.com",
                is_anonymized: estado.contatoAnonimizado,
                is_blocked: false,
              },
              error: null,
            };
          }
          if (tabela === "organizations") return { data: { id: f.id, display_name: "Org" }, error: null };
          return { data: null, error: null };
        },
        then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
          Promise.resolve({ data: [], error: null }).then(onF, onR),
      };
      return q;
    },
  };
}

let estado: Estado;

beforeEach(() => {
  vi.clearAllMocks();
  estado = {
    suporte: suporte(ORG_A),
    auditoriaTerminou: false,
    filtros: {},
    orCalls: [],
    contatoAnonimizado: false,
    usouAdmin: false,
  };
  vi.mocked(requirePlatformAdmin).mockResolvedValue({ user: { id: ADMIN } } as never);
  vi.mocked(createClient).mockResolvedValue({
    rpc: async (nome: string) => (nome === "fn_support_context" ? { data: estado.suporte, error: null } : { data: null, error: null }),
  } as never);
  vi.mocked(createAdminClient).mockImplementation(() => adminStub(estado) as never);
  vi.mocked(audit).mockImplementation(
    () =>
      new Promise<void>((resolve) =>
        setTimeout(() => {
          estado.auditoriaTerminou = true;
          resolve();
        }, 15),
      ),
  );
});

const lista = (qs = "") => new NextRequest(`http://local/api/v1/admin/inbox/conversations${qs}`);
const detalhe = (id: string) => DETALHE(new NextRequest("http://local/x"), { params: Promise.resolve({ id }) });

describe("lista de conversas do admin", () => {
  it("sem acompanhamento: 403 e o service role nem é tocado", async () => {
    estado.suporte = null;
    const res = await LISTA(lista());
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("support_session_required");
    expect(estado.usouAdmin).toBe(false);
    expect(audit).not.toHaveBeenCalled();
  });

  it("acompanhamento que perdeu o aal2 (revoked) também é 403", async () => {
    estado.suporte = suporte(ORG_A, "revoked");
    expect((await LISTA(lista())).status).toBe(403);
    expect(estado.usouAdmin).toBe(false);
  });

  it("tenant_id de OUTRA organização que a acompanhada: 403", async () => {
    const res = await LISTA(lista(`?tenant_id=${ORG_B}`));
    expect(res.status).toBe(403);
    expect(estado.usouAdmin).toBe(false);
  });

  it("com acompanhamento: lê só a organização acompanhada e audita COM a organização, esperando", async () => {
    const res = await LISTA(lista());
    expect(res.status).toBe(200);
    expect(estado.filtros.conversations).toContainEqual(["organization_id", ORG_A]);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "platform_admin.inbox_listed", organizationId: ORG_A, actorUserId: ADMIN }),
    );
    // A resposta só sai depois de a gravação terminar.
    expect(estado.auditoriaTerminou).toBe(true);
  });

  it("cursor com condição extra injetada é recusado, e nada é consultado", async () => {
    const cursor = Buffer.from(
      JSON.stringify({ last_inbound_at: "2026-09-30T10:00:00Z),organization_id.neq.x,and(id.gt.0", id: CONVERSA_A }),
    ).toString("base64url");
    const res = await LISTA(lista(`?cursor=${cursor}`));
    expect(res.status).toBe(400);
    expect(estado.orCalls).toHaveLength(0);
  });

  it("cursor com id que não é uuid é recusado", async () => {
    const cursor = Buffer.from(
      JSON.stringify({ last_inbound_at: "2026-09-30T10:00:00Z", id: "1),organization_id.neq.x" }),
    ).toString("base64url");
    expect((await LISTA(lista(`?cursor=${cursor}`))).status).toBe(400);
  });

  it("cursor legítimo (data do Postgres com fuso) vira o filtro de keyset", async () => {
    const cursor = Buffer.from(
      JSON.stringify({ last_inbound_at: "2026-09-30T10:00:00.123456+00:00", id: CONVERSA_A }),
    ).toString("base64url");
    const res = await LISTA(lista(`?cursor=${cursor}`));
    expect(res.status).toBe(200);
    expect(estado.orCalls[0]).toContain("last_inbound_at.lt.2026-09-30T10:00:00.123456+00:00");
  });
});

describe("detalhe da conversa do admin", () => {
  it("sem acompanhamento: 403 e nada é lido", async () => {
    estado.suporte = null;
    const res = await detalhe(CONVERSA_A);
    expect(res.status).toBe(403);
    expect(estado.usouAdmin).toBe(false);
    expect(audit).not.toHaveBeenCalled();
  });

  it("conversa de outra organização que a acompanhada: 404, sem vazar que existe", async () => {
    const res = await detalhe(CONVERSA_B);
    expect(res.status).toBe(404);
    expect(audit).not.toHaveBeenCalled();
  });

  it("conversa da organização acompanhada: devolve, filtra mensagens por organização e audita esperando", async () => {
    const res = await detalhe(CONVERSA_A);
    expect(res.status).toBe(200);
    expect(estado.filtros.messages).toContainEqual(["organization_id", ORG_A]);
    expect(estado.filtros.contacts).toContainEqual(["organization_id", ORG_A]);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "platform_admin.conversation_viewed",
        organizationId: ORG_A,
        resourceId: CONVERSA_A,
      }),
    );
    expect(estado.auditoriaTerminou).toBe(true);
  });

  it("contato anonimizado não devolve nome, telefone nem e-mail", async () => {
    estado.contatoAnonimizado = true;
    const res = await detalhe(CONVERSA_A);
    const corpo = (await res.json()) as { data: { contact: Record<string, unknown> } };
    expect(corpo.data.contact).toMatchObject({ name: null, phone_number: null, email: null, is_anonymized: true });
  });
});
