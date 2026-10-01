/**
 * D-154: o modo leitura da assinatura só valia na tela e nos produtores
 * automáticos. As rotas de escrita em massa e do financeiro seguiam gravando
 * para uma conta cancelada (estorno total, 0916) ou suspensa.
 *
 * Prova: com a conta em modo leitura, cada rota responde 402
 * `plano_limite_atingido` ANTES de tocar no banco; com a conta em dia, a mesma
 * chamada passa do portão. O atendimento (mensagens) fica de fora de propósito:
 * a decisão de 0908 é que o chat nunca para.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const estado = vi.hoisted(() => ({ emLeitura: false, consultas: [] as string[] }));

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async () => ({
    ok: true,
    user: { id: "u-1", idioma: "pt-BR" },
    org: { orgId: "org-1", role: "admin" },
  }),
}));
vi.mock("@/lib/billing/assinatura/modo-leitura", () => ({
  contaEmModoLeitura: async () => estado.emLeitura,
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

function bancoQueRegistra() {
  const proxy: unknown = new Proxy(() => proxy, {
    get(_t, prop) {
      if (prop === "then") {
        return (ok: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(ok);
      }
      return () => proxy;
    },
    apply: () => proxy,
  });
  return {
    from: (tabela: string) => {
      estado.consultas.push(tabela);
      return proxy;
    },
    rpc: async (fn: string) => {
      estado.consultas.push(`rpc:${fn}`);
      return { data: null, error: null };
    },
  };
}
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => bancoQueRegistra() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => bancoQueRegistra() }));

const ID = "33333333-3333-4333-8333-333333333333";
const ctx = { params: Promise.resolve({ id: ID }) };

function formComArquivo(url: string) {
  const form = new FormData();
  form.append("file", new File(["nome,email\nA,a@a.com\n"], "c.csv", { type: "text/csv" }));
  return new NextRequest(`http://localhost${url}`, { method: "POST", body: form });
}
const json = (url: string, method: string, corpo: unknown = {}) =>
  new NextRequest(`http://localhost${url}`, {
    method,
    body: JSON.stringify(corpo),
    headers: { "content-type": "application/json" },
  });

type Rota = [string, () => Promise<Response>];
const ROTAS: Rota[] = [
  ["POST contacts/import", async () => (await import("@/app/api/v1/contacts/import/route")).POST(formComArquivo("/api/v1/contacts/import"))],
  ["POST products/import", async () => (await import("@/app/api/v1/products/import/route")).POST(formComArquivo("/api/v1/products/import"))],
  ["POST leads/import", async () => (await import("@/app/api/v1/leads/import/route")).POST(formComArquivo("/api/v1/leads/import"))],
  ["POST financeiro/lancamentos", async () => (await import("@/app/api/v1/financeiro/lancamentos/route")).POST(json("/api/v1/financeiro/lancamentos", "POST"))],
  ["PATCH financeiro/lancamentos/[id]", async () => (await import("@/app/api/v1/financeiro/lancamentos/[id]/route")).PATCH(json(`/api/v1/financeiro/lancamentos/${ID}`, "PATCH", { pay: true }), ctx)],
  ["DELETE financeiro/lancamentos/[id]", async () => (await import("@/app/api/v1/financeiro/lancamentos/[id]/route")).DELETE(json(`/api/v1/financeiro/lancamentos/${ID}`, "DELETE"), ctx)],
];

beforeEach(() => {
  estado.emLeitura = false;
  estado.consultas.length = 0;
});

describe("D-154 portão de escrita do modo leitura na API", () => {
  it.each(ROTAS)("%s: conta em modo leitura leva 402 e não toca no banco", async (_n, chamar) => {
    estado.emLeitura = true;
    const res = await chamar();
    expect(res.status).toBe(402);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("plano_limite_atingido");
    expect(estado.consultas, "a rota gravou/leu antes do portão").toEqual([]);
  });

  it.each(ROTAS)("%s: conta em dia passa do portão (não é 402)", async (_n, chamar) => {
    estado.emLeitura = false;
    const res = await chamar();
    expect(res.status).not.toBe(402);
  });
});
