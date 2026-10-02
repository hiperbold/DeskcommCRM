/**
 * D-153 e a parte financeira do D-132.
 *
 * D-153: as chamadas `audit()` do financeiro não passavam `actorUserId` nem
 * `organizationId`, e `lib/audit` grava nulo. A tela de auditoria da empresa
 * (filtra por organização) nunca mostrava um estorno ou um cancelamento, e não
 * havia como saber quem fez.
 *
 * D-132: as buscas por id (`.eq("id")`) dependiam só da RLS. Agora cada uma leva
 * `organization_id` da organização ativa.
 *
 * Roda os Route Handlers REAIS; só as fronteiras (sessão, cliente Supabase,
 * audit) são dublês. O dublê do banco registra os filtros `.eq()` por tabela.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

const auditSpy = vi.fn(async (_evento: Record<string, unknown>) => undefined);
vi.mock("@/lib/audit", () => ({
  audit: auditSpy,
  isServiceRoleConfigured: () => false,
  hashEmail: (e: string) => e,
}));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/billing/assinatura/recusa-de-escrita", () => ({
  recusarEscritaEmModoLeitura: vi.fn(async () => null),
}));

const ORG = "f1a1ce00-0000-4000-8000-000000000001";
const USUARIO = "f1a1ce00-0000-4000-8000-0000000000a1";
const COMANDA = "f1a1ce00-0000-4000-8000-0000000000c1";
const CONTATO = "f1a1ce00-0000-4000-8000-0000000000d1";
const ITEM = "f1a1ce00-0000-4000-8000-0000000000e1";
const LANCAMENTO = "f1a1ce00-0000-4000-8000-0000000000f1";
const CONTA = "f1a1ce00-0000-4000-8000-0000000000b1";
const FORMA = "f1a1ce00-0000-4000-8000-0000000000b2";
const AGENDAMENTO = "f1a1ce00-0000-4000-8000-0000000000b3";

interface Registro {
  tabela: string;
  eqs: Record<string, unknown>;
}
let registros: Registro[];

const RESPOSTAS: Record<string, unknown> = {
  sales: { id: COMANDA, status: "open", number: 5 },
  sale_items: { id: ITEM },
  financial_entries: {
    id: LANCAMENTO,
    status: "pending",
    origin: "manual",
    amount_cents: 1000,
    direction: "in",
    entry_date: "2026-10-01",
  },
  loyalty_ledger: { id: ITEM, points: 10, reason: "x", created_at: "2026-10-01T00:00:00Z" },
  commission_rules: [],
  calendar_appointments: [
    {
      id: AGENDAMENTO,
      title: "Consulta",
      contact_id: null,
      event_type_id: null,
      status: "confirmed",
      calendar_event_types: { name: "Consulta", default_price_cents: 1000 },
    },
  ],
};
const RPCS: Record<string, unknown> = {
  fn_proximo_numero_de_comanda: 5,
  fn_estornar_comanda: { sale_id: COMANDA },
  fn_finalizar_comanda: { sale_id: COMANDA },
  fn_saldo_de_fidelidade: 10,
};

function banco() {
  return {
    from: (tabela: string) => {
      const registro: Registro = { tabela, eqs: {} };
      registros.push(registro);
      const resposta = { data: RESPOSTAS[tabela] ?? null, error: null };
      const q: unknown = new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === "then") {
              return (ok: (v: unknown) => unknown) => Promise.resolve(resposta).then(ok);
            }
            if (prop === "eq") {
              return (coluna: string, valor: unknown) => {
                registro.eqs[coluna] = valor;
                return q;
              };
            }
            if (prop === "maybeSingle" || prop === "single") return async () => resposta;
            return () => q;
          },
        },
      );
      return q;
    },
    rpc: async (nome: string) => ({ data: RPCS[nome] ?? null, error: null }),
  };
}

function sessao() {
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: {
      id: USUARIO,
      email: "g@example.com",
      full_name: null,
      avatar_url: null,
      is_platform_admin: false,
      idioma: "pt-BR" as const,
      organizations: [{ organization_id: ORG, organization_name: "Org", role: "manager" }],
    },
    org: { orgId: ORG, name: "Org", role: "manager" },
  });
  vi.mocked(createClient).mockResolvedValue(banco() as never);
}

const req = (corpo: unknown, metodo: string) =>
  new NextRequest("http://localhost/api/v1/financeiro/x", {
    method: metodo,
    body: metodo === "GET" || metodo === "DELETE" ? undefined : JSON.stringify(corpo),
  });
const ctxComanda = { params: Promise.resolve({ id: COMANDA }) };
const ctxItem = { params: Promise.resolve({ id: COMANDA, itemId: ITEM }) };
const ctxLancamento = { params: Promise.resolve({ id: LANCAMENTO }) };

/** O evento de audit da ação, com ator e organização preenchidos. */
function auditou(action: string) {
  const evento = auditSpy.mock.calls.map(([e]) => e).find((e) => e.action === action);
  expect(evento, `a rota não auditou "${action}"`).toBeDefined();
  expect(evento).toMatchObject({ actorUserId: USUARIO, organizationId: ORG });
}

/** Toda consulta a `tabela` que busca por id/contato leva o filtro da organização. */
function filtrouPorOrganizacao(tabelas: string[]) {
  const alvo = registros.filter((r) => tabelas.includes(r.tabela));
  expect(alvo.length).toBeGreaterThan(0);
  for (const r of alvo) {
    expect(r.eqs, `consulta a ${r.tabela} sem filtro de organização`).toMatchObject({
      organization_id: ORG,
    });
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  registros = [];
  sessao();
});

describe("D-153: o audit do financeiro leva ator e organização", () => {
  it("lançamento criado", async () => {
    const { POST } = await import("@/app/api/v1/financeiro/lancamentos/route");
    const res = await POST(
      req(
        { account_id: CONTA, direction: "in", amount_cents: 1000, description: "x", entry_date: "2026-10-01" },
        "POST",
      ),
    );
    expect(res.status).toBe(200);
    auditou("financeiro.lancamento_criado");
  });

  it("lançamento pago e removido", async () => {
    const { PATCH, DELETE } = await import("@/app/api/v1/financeiro/lancamentos/[id]/route");
    expect((await PATCH(req({ pay: true }, "PATCH"), ctxLancamento)).status).toBe(200);
    auditou("financeiro.lancamento_pago");
    expect((await DELETE(req({}, "DELETE"), ctxLancamento)).status).toBe(200);
    auditou("financeiro.lancamento_removido");
  });

  it("comanda aberta, alterada, cancelada", async () => {
    const { POST } = await import("@/app/api/v1/financeiro/comandas/route");
    expect((await POST(req({}, "POST"))).status).toBe(200);
    auditou("comanda.aberta");

    const { PATCH } = await import("@/app/api/v1/financeiro/comandas/[id]/route");
    expect((await PATCH(req({ discount_cents: 100 }, "PATCH"), ctxComanda)).status).toBe(200);
    auditou("comanda.alterada");
    expect((await PATCH(req({ cancel: true }, "PATCH"), ctxComanda)).status).toBe(200);
    auditou("comanda.cancelada");
  });

  it("comanda finalizada e estornada", async () => {
    const { POST: finalizar } = await import("@/app/api/v1/financeiro/comandas/[id]/finalizar/route");
    expect((await finalizar(req({ payment_method_id: FORMA }, "POST"), ctxComanda)).status).toBe(200);
    auditou("comanda.finalizada");

    const { POST: estornar } = await import("@/app/api/v1/financeiro/comandas/[id]/estornar/route");
    expect((await estornar(req({ reason: "pagou em dobro" }, "POST"), ctxComanda)).status).toBe(200);
    auditou("comanda.estornada");
  });

  it("item incluído e removido", async () => {
    const { POST } = await import("@/app/api/v1/financeiro/comandas/[id]/itens/route");
    const incluido = await POST(
      req({ description: "Consulta", quantity: 1, unit_price_cents: 1000 }, "POST"),
      ctxComanda,
    );
    expect(incluido.status).toBe(200);
    auditou("comanda.item_incluido");

    const { DELETE } = await import("@/app/api/v1/financeiro/comandas/[id]/itens/[itemId]/route");
    expect((await DELETE(req({}, "DELETE"), ctxItem)).status).toBe(200);
    auditou("comanda.item_removido");
  });

  it("faturamento em lote", async () => {
    const { POST } = await import("@/app/api/v1/financeiro/comandas/faturar-lote/route");
    const res = await POST(req({ appointment_ids: [AGENDAMENTO], payment_method_id: FORMA }, "POST"));
    expect(res.status).toBe(200);
    auditou("comanda.faturada_em_lote");
  });

  it("pontos de fidelidade", async () => {
    const { POST } = await import("@/app/api/v1/financeiro/fidelidade/route");
    const res = await POST(req({ contact_id: CONTATO, points: 10, reason: "indicou" }, "POST"));
    expect(res.status).toBe(200);
    auditou("fidelidade.ponto_dado");
  });
});

describe("D-132: a busca por id leva o filtro da organização", () => {
  it("lançamento: pagar e apagar", async () => {
    const { PATCH, DELETE } = await import("@/app/api/v1/financeiro/lancamentos/[id]/route");
    await PATCH(req({ pay: true }, "PATCH"), ctxLancamento);
    await DELETE(req({}, "DELETE"), ctxLancamento);
    filtrouPorOrganizacao(["financial_entries"]);
    // Leitura, atualização e exclusão: as quatro idas ao banco.
    expect(registros.filter((r) => r.tabela === "financial_entries")).toHaveLength(4);
  });

  it("comanda: ler, alterar e cancelar", async () => {
    const { GET, PATCH } = await import("@/app/api/v1/financeiro/comandas/[id]/route");
    await GET(req({}, "GET"), ctxComanda);
    await PATCH(req({ cancel: true }, "PATCH"), ctxComanda);
    filtrouPorOrganizacao(["sales"]);
    expect(registros.filter((r) => r.tabela === "sales")).toHaveLength(3);
  });

  it("itens: incluir e remover", async () => {
    const { POST } = await import("@/app/api/v1/financeiro/comandas/[id]/itens/route");
    await POST(req({ description: "Consulta", quantity: 1, unit_price_cents: 1000 }, "POST"), ctxComanda);
    const { DELETE } = await import("@/app/api/v1/financeiro/comandas/[id]/itens/[itemId]/route");
    await DELETE(req({}, "DELETE"), ctxItem);
    // `sale_items` do insert já levava a organização no corpo; o que importa são
    // as buscas e a exclusão.
    filtrouPorOrganizacao(["sales", "commission_rules"]);
    const exclusao = registros.filter((r) => r.tabela === "sale_items" && "id" in r.eqs);
    expect(exclusao).toHaveLength(1);
    expect(exclusao[0]?.eqs).toMatchObject({ organization_id: ORG, id: ITEM, sale_id: COMANDA });
  });

  it("extrato de fidelidade", async () => {
    const { GET } = await import("@/app/api/v1/financeiro/fidelidade/route");
    await GET(new NextRequest(`http://localhost/api/v1/financeiro/fidelidade?contact_id=${CONTATO}`));
    filtrouPorOrganizacao(["loyalty_ledger"]);
  });
});
