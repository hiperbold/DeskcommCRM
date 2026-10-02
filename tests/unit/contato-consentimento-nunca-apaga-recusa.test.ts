/**
 * D-151: o consentimento do contato não se reescreve pelo PATCH genérico, e a
 * recusa registrada nunca é apagada por nenhuma porta.
 *
 * Cobre as três camadas:
 *  - o schema do PATCH recusa `consent` e `source_metadata` (422), em vez de
 *    descartar em silêncio;
 *  - o merge do handler preserva `declined_at` mesmo para `{marketing:{}}`;
 *  - a rota própria `POST /contacts/{id}/consent`: piso manager, 409 ao dar
 *    consentimento a quem recusou, auditoria com a finalidade.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import {
  mesclarConsentimento,
  registrarConsentimento,
} from "@/lib/contacts/consentimento";
import { contactPatchSchema, contactPatchSchemaDoPais } from "@/lib/schemas/contacts";
import { perfilDoPais } from "@/lib/legal/perfil-do-pais";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

import { POST } from "@/app/api/v1/contacts/[id]/consent/route";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const CONTATO = "33333333-3333-4333-8333-333333333333";
const RECUSA = "2026-05-01T10:00:00.000Z";

describe("PATCH do contato: consent e source_metadata não entram (schema)", () => {
  it("consent no corpo é recusado, e a mensagem aponta a rota própria", () => {
    const r = contactPatchSchema.safeParse({ consent: { marketing: {} } });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("/consent");
  });

  it("source_metadata no corpo é recusado", () => {
    expect(contactPatchSchema.safeParse({ source_metadata: { ad_id: "123" } }).success).toBe(false);
  });

  it("a versão por país recusa igual (é a que a rota usa)", () => {
    const schema = contactPatchSchemaDoPais(perfilDoPais("BR"));
    expect(schema.safeParse({ consent: { marketing: {} } }).success).toBe(false);
    expect(schema.safeParse({ name: "Ana" }).success).toBe(true);
  });

  it("os demais campos de edição continuam valendo", () => {
    const r = contactPatchSchema.safeParse({ name: "Ana", tags: ["VIP"], custom_fields: { a: 1 } });
    expect(r.success).toBe(true);
  });
});

describe("mesclarConsentimento: a recusa registrada sobrevive", () => {
  const anterior = {
    marketing: { granted_at: null, declined_at: RECUSA, source: "whatsapp" },
    transactional: { granted_at: "2026-01-01T00:00:00Z" },
  };

  it.each([
    ["entrada vazia", {}],
    ["entrada nula", null],
    ["declined_at nulo", { declined_at: null }],
    ["concedido por cima", { granted_at: "2026-09-01T00:00:00Z" }],
  ])("%s não apaga declined_at", (_nome, entrada) => {
    const r = mesclarConsentimento(anterior, { marketing: entrada }) as Record<
      string,
      Record<string, unknown>
    >;
    expect(r.marketing?.declined_at).toBe(RECUSA);
    // As outras finalidades ficam como estavam.
    expect(r.transactional).toEqual(anterior.transactional);
  });

  it("finalidade sem recusa continua sendo substituída (revogar vale)", () => {
    const r = mesclarConsentimento(
      { marketing: { granted: true, granted_at: "2026-01-01T00:00:00Z" } },
      { marketing: { granted: false, granted_at: null } },
    ) as Record<string, Record<string, unknown>>;
    expect(r.marketing).toEqual({ granted: false, granted_at: null });
  });
});

describe("registrarConsentimento", () => {
  it("consentimento a quem recusou é negado", () => {
    const r = registrarConsentimento(
      { marketing: { declined_at: RECUSA } },
      { finalidade: "marketing", acao: "grant", origem: "formulário" },
      "2026-10-01T00:00:00.000Z",
    );
    expect(r).toEqual({ ok: false, motivo: "recusa_registrada" });
  });

  it("recusar de novo mantém a data da primeira recusa", () => {
    const r = registrarConsentimento(
      { marketing: { declined_at: RECUSA } },
      { finalidade: "marketing", acao: "decline", origem: "segunda mensagem" },
      "2026-10-01T00:00:00.000Z",
    );
    expect(r.ok && (r.consent.marketing as Record<string, unknown>).declined_at).toBe(RECUSA);
  });
});

interface Banco {
  contato: Record<string, unknown> | null;
  updates: Array<Record<string, unknown>>;
  /** A trava otimista não casa: alguém gravou no meio. */
  updatedAtMudou: boolean;
}

function clienteStub(banco: Banco) {
  const filtros: Record<string, unknown> = {};
  let op: "select" | "update" = "select";
  const q = {
    select: () => q,
    update: (valores: Record<string, unknown>) => {
      op = "update";
      banco.updates.push(valores);
      return q;
    },
    eq: (k: string, v: unknown) => {
      filtros[k] = v;
      return q;
    },
    maybeSingle: async () => {
      if (op === "select") {
        const casa = filtros.id === CONTATO && filtros.organization_id === ORG;
        return { data: casa ? banco.contato : null, error: null };
      }
      return { data: banco.updatedAtMudou ? null : { id: CONTATO }, error: null };
    },
  };
  return { from: () => q };
}

function pedido(corpo: unknown) {
  return new NextRequest(`http://local/api/v1/contacts/${CONTATO}/consent`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(corpo),
  });
}
const contexto = () => ({ params: Promise.resolve({ id: CONTATO }) });

describe("POST /api/v1/contacts/{id}/consent", () => {
  let banco: Banco;
  beforeEach(() => {
    vi.clearAllMocks();
    banco = {
      contato: {
        id: CONTATO,
        is_anonymized: false,
        consent: { marketing: { granted_at: "2026-01-01T00:00:00Z" } },
        updated_at: "2026-09-01T10:00:00.123456+00:00",
      },
      updates: [],
      updatedAtMudou: false,
    };
    vi.mocked(requireRole).mockResolvedValue({
      ok: true,
      user: { id: USER, idioma: "pt-BR" },
      org: { orgId: ORG, role: "manager" },
    } as Awaited<ReturnType<typeof requireRole>>);
    vi.mocked(createClient).mockResolvedValue(clienteStub(banco) as never);
  });

  it("exige manager: agent é negado antes de tocar no banco", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("forbidden_role", "Acesso negado.", 403),
    });
    const res = await POST(pedido({ finalidade: "marketing", acao: "decline", origem: "pedido" }), contexto());
    expect(res.status).toBe(403);
    expect(requireRole).toHaveBeenCalledWith("manager", expect.objectContaining({ resource: "contacts" }));
    expect(banco.updates).toHaveLength(0);
    expect(audit).not.toHaveBeenCalled();
  });

  it("registra a recusa, preserva as outras finalidades e audita com a organização", async () => {
    const res = await POST(
      pedido({ finalidade: "marketing", acao: "decline", origem: "cliente pediu no WhatsApp" }),
      contexto(),
    );
    expect(res.status).toBe(200);
    const consent = banco.updates[0]?.consent as Record<string, Record<string, unknown>>;
    expect(consent.marketing?.declined_at).toEqual(expect.any(String));
    expect(consent.marketing?.source).toBe("cliente pediu no WhatsApp");
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "contact.consent_registered",
        actorUserId: USER,
        organizationId: ORG,
        resourceId: CONTATO,
        metadata: expect.objectContaining({ finalidade: "marketing", acao: "decline" }),
      }),
    );
  });

  it("consentimento a finalidade já recusada: 409 e NADA é gravado", async () => {
    banco.contato = { ...banco.contato, consent: { marketing: { declined_at: RECUSA } } };
    const res = await POST(
      pedido({ finalidade: "marketing", acao: "grant", origem: "agent tentou reabrir" }),
      contexto(),
    );
    expect(res.status).toBe(409);
    expect(banco.updates).toHaveLength(0);
    expect(audit).not.toHaveBeenCalled();
  });

  it("alguém gravou no meio: 409 de conflito, sem auditar um registro que não houve", async () => {
    banco.updatedAtMudou = true;
    const res = await POST(
      pedido({ finalidade: "transactional", acao: "grant", origem: "formulário" }),
      contexto(),
    );
    expect(res.status).toBe(409);
    expect(audit).not.toHaveBeenCalled();
  });

  it("contato anonimizado: 403", async () => {
    banco.contato = { ...banco.contato, is_anonymized: true };
    const res = await POST(
      pedido({ finalidade: "marketing", acao: "decline", origem: "pedido" }),
      contexto(),
    );
    expect(res.status).toBe(403);
    expect(banco.updates).toHaveLength(0);
  });

  it("finalidade fora da lista: 422", async () => {
    const res = await POST(pedido({ finalidade: "qualquer", acao: "grant", origem: "x tres" }), contexto());
    expect(res.status).toBe(422);
    expect(banco.updates).toHaveLength(0);
  });
});
