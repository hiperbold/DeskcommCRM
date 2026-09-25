/**
 * `GET /api/v1/billing/pedidos/[id]` (fase F5, Tarefa 15).
 *
 * `requireRole` e `dbCompraSupabase` são dublês: nenhuma chamada real sai
 * daqui, nem ao Supabase nem ao Asaas (a rota em si nunca chama o Asaas,
 * ver o comentário do próprio arquivo da rota). O foco é o CONTRATO: 404
 * idêntico para "não existe" e "é de outra organização" (decisão 17 da
 * fase), nenhum dado do pagador na resposta, e o `organization_id` usado na
 * leitura é sempre o da SESSÃO (nunca o `id` do path).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { dbCompraSupabase } from "@/lib/billing/asaas/db-compra-supabase";
import type { PedidoLinha } from "@/lib/billing/asaas/compra";
import type { ActiveOrg, AuthUser } from "@/lib/auth/types";
import { fail } from "@/lib/api/wrappers";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/billing/asaas/db-compra-supabase", () => ({ dbCompraSupabase: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

const ORG = "22222222-2222-4222-8222-222222222222";
const OUTRA_ORG = "33333333-3333-4333-8333-333333333333";
const USER = "11111111-1111-4111-8111-111111111111";
const PEDIDO_ID = "55555555-5555-4555-8555-555555555555";

const usuario: AuthUser = {
  id: USER,
  email: "ana@clinica.com.br",
  full_name: "Ana",
  avatar_url: null,
  is_platform_admin: false,
  idioma: "pt-BR" as const,
  organizations: [{ organization_id: ORG, organization_name: "Clínica", role: "viewer" }],
};
const orgAtiva: ActiveOrg = { orgId: ORG, name: "Clínica", role: "viewer" };

function pedidoBase(overrides: Partial<PedidoLinha> = {}): PedidoLinha {
  return {
    id: PEDIDO_ID,
    status: "aguardando_pagamento",
    tipo: "assinatura",
    ambiente: "sandbox",
    metodo: "CREDIT_CARD",
    amountCents: 19900,
    externalReference: `HC:ord:${PEDIDO_ID}`,
    asaasPaymentId: "pay_fake123",
    asaasSubscriptionId: "sub_fake123",
    invoiceUrl: "https://sandbox.asaas.com/i/fake123",
    ciclo: "monthly",
    planoNome: "Pro",
    pacoteNome: null,
    planCode: "pro",
    pacoteCode: null,
    atualizadoEm: "2026-09-24T12:00:00Z",
    ...overrides,
  };
}

/**
 * Dublê de `DbCompra.lerPedido`: só devolve a linha quando o `org` recebido
 * bate com `PEDIDO_ORG` E o `id` bate com `PEDIDO_ID`, a MESMA forma que a
 * função real (`fn_billing_criar_pedido`/leitura filtrada) usa, e é essa
 * simetria que prova o "mesmo 404" sem precisar de dois caminhos de código.
 */
function dbFalso(pedidoOrg: string | null, linha: PedidoLinha | null, erro: { code?: string; message?: string } | null = null) {
  return {
    lerPedido: vi.fn(async (org: string, id: string) => {
      if (erro) return { data: null, error: erro };
      if (!linha || org !== pedidoOrg || id !== PEDIDO_ID) return { data: null, error: null };
      return { data: linha, error: null };
    }),
  } as unknown as ReturnType<typeof dbCompraSupabase>;
}

async function chamarRota(id: string) {
  const { GET } = await import("@/app/api/v1/billing/pedidos/[id]/route");
  const request = new Request(`http://localhost/api/v1/billing/pedidos/${id}`);
  return GET(request, { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  vi.mocked(requireRole).mockResolvedValue({ ok: true, user: usuario, org: orgAtiva });
});

describe("GET /api/v1/billing/pedidos/[id]: autorização", () => {
  it("sem sessão/papel suficiente: devolve a resposta que requireRole decidiu, sem tocar no banco", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("forbidden_tenant", "Sem organização ativa.", 403, { requestId: "req-1" }),
    });
    vi.mocked(dbCompraSupabase).mockReturnValue(dbFalso(ORG, pedidoBase()));

    const res = await chamarRota(PEDIDO_ID);
    expect(res.status).toBe(403);
    expect(vi.mocked(dbCompraSupabase)).not.toHaveBeenCalled();
  });

  it("exige o papel admin (N41/correção 6), o mesmo das ações de compra", async () => {
    vi.mocked(dbCompraSupabase).mockReturnValue(dbFalso(ORG, pedidoBase()));
    await chamarRota(PEDIDO_ID);
    expect(vi.mocked(requireRole)).toHaveBeenCalledWith("admin", expect.objectContaining({ resource: "billing_orders" }));
  });
});

describe("GET /api/v1/billing/pedidos/[id]: 404 igual para 'não existe' e 'é de outra organização'", () => {
  it("pedido inexistente: 404 genérico", async () => {
    vi.mocked(dbCompraSupabase).mockReturnValue(dbFalso(ORG, null));
    const res = await chamarRota(PEDIDO_ID);
    expect(res.status).toBe(404);
    const corpo = await res.json();
    expect(corpo.error.code).toBe("not_found");
  });

  it("pedido de OUTRA organização: o MESMO 404, byte a byte", async () => {
    // A leitura é feita com o org da SESSÃO (ORG); o pedido pertence a
    // OUTRA_ORG, então o dublê nunca devolve a linha, exatamente como a
    // consulta real filtrada por organization_id faria.
    vi.mocked(dbCompraSupabase).mockReturnValue(dbFalso(OUTRA_ORG, pedidoBase()));

    const resNaoExiste = await chamarRota(PEDIDO_ID);
    vi.mocked(dbCompraSupabase).mockReturnValue(dbFalso(ORG, null));
    const resInexistente = await chamarRota(PEDIDO_ID);

    expect(resNaoExiste.status).toBe(404);
    expect(resInexistente.status).toBe(404);
    const corpoA = await resNaoExiste.json();
    const corpoB = await resInexistente.json();
    expect(corpoA).toEqual(corpoB);
  });

  it("id mal formado: 404, sem nunca chamar o banco", async () => {
    const db = dbFalso(ORG, pedidoBase());
    vi.mocked(dbCompraSupabase).mockReturnValue(db);

    const res = await chamarRota("nao-e-um-uuid");
    expect(res.status).toBe(404);
    expect(db.lerPedido).not.toHaveBeenCalled();
  });

  it("a leitura usa SEMPRE o organization_id da sessão, nunca um valor do path", async () => {
    const db = dbFalso(ORG, pedidoBase());
    vi.mocked(dbCompraSupabase).mockReturnValue(db);

    await chamarRota(PEDIDO_ID);
    expect(db.lerPedido).toHaveBeenCalledWith(ORG, PEDIDO_ID);
  });
});

describe("GET /api/v1/billing/pedidos/[id]: resposta sem dado do pagador", () => {
  it("200 traz só status, tipo e url", async () => {
    vi.mocked(dbCompraSupabase).mockReturnValue(dbFalso(ORG, pedidoBase()));
    const res = await chamarRota(PEDIDO_ID);
    expect(res.status).toBe(200);
    const corpo = await res.json();
    expect(corpo.data).toEqual({
      status: "aguardando_pagamento",
      tipo: "assinatura",
      url: "https://sandbox.asaas.com/i/fake123",
    });
    expect(Object.keys(corpo.data)).toEqual(["status", "tipo", "url"]);
  });

  it("pedido pago: status reflete o banco, sem inventar nada", async () => {
    vi.mocked(dbCompraSupabase).mockReturnValue(
      dbFalso(ORG, pedidoBase({ status: "pago", invoiceUrl: null })),
    );
    const res = await chamarRota(PEDIDO_ID);
    const corpo = await res.json();
    expect(corpo.data.status).toBe("pago");
    expect(corpo.data.url).toBeNull();
  });
});

describe("GET /api/v1/billing/pedidos/[id]: erro do banco nunca vira 200 nem expõe detalhe", () => {
  it("erro na leitura: 500 genérico", async () => {
    vi.mocked(dbCompraSupabase).mockReturnValue(
      dbFalso(ORG, null, { code: "XX000", message: "coluna secreta_do_schema não existe" }),
    );
    const res = await chamarRota(PEDIDO_ID);
    expect(res.status).toBe(500);
    const corpo = await res.json();
    expect(JSON.stringify(corpo)).not.toContain("secreta_do_schema");
  });
});
