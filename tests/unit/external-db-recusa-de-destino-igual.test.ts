import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * D-084, M3 (banco externo): a recusa do host não pode distinguir "o nome não
 * resolve" de "resolve para a rede interna". Se distinguir, a rota vira oráculo
 * de nomes que existem dentro da rede do servidor: o admin de uma organização
 * testa `banco-interno.compose` e lê pela resposta se o nome existe.
 *
 * Roda as três rotas que julgam o host (POST e PATCH da conexão, e o /test) com
 * o DNS simulado e compara o corpo INTEIRO da resposta.
 */

// DNS simulado: `some.exemplo` não existe; `interno.exemplo` resolve para a rede
// interna; `publico.exemplo` resolve para um IP público.
vi.mock("node:dns/promises", () => {
  const mapa: Record<string, string[]> = {
    "interno.exemplo": ["10.0.0.9"],
    "metadata.exemplo": ["169.254.169.254"],
    "publico.exemplo": ["8.8.8.8"],
  };
  const lookup = vi.fn(async (nome: string) => {
    const ips = mapa[nome];
    if (!ips) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
    return ips.map((address) => ({ address, family: 4 }));
  });
  return { lookup, default: { lookup } };
});

const aviso = vi.hoisted(() => vi.fn());
vi.mock("@/lib/logger", () => ({
  logger: { warn: aviso, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: async () => true }));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async () => ({
    ok: true,
    user: { id: "user-1", idioma: "pt-BR" },
    org: { orgId: "org-1" },
  }),
}));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: async () => ({ allowed: true }) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@/lib/audit", () => ({ audit: async () => undefined }));

const estado = vi.hoisted(() => ({ host: "publico.exemplo" }));
vi.mock("@/lib/external-db/credenciais", async () => {
  const real = (await vi.importActual("@/lib/external-db/credenciais")) as Record<string, unknown>;
  return {
    ...real,
    carregarConexao: async () => ({
      ok: true,
      conexao: {
        id: "conn-1",
        organizationId: "org-1",
        label: "X",
        host: estado.host,
        port: 5432,
        database: "db",
        username: "u",
        password: "p",
        sslMode: "require",
        maxRows: 200,
        maxFilters: 20,
        maxResponseBytes: 30_000,
        versao: "v1",
      },
    }),
  };
});

const { POST: criar } = await import("@/app/api/v1/external-db/connections/route");
const { PATCH: editar } = await import("@/app/api/v1/external-db/connections/[id]/route");
const { POST: testar } = await import("@/app/api/v1/external-db/connections/[id]/test/route");

const CORPO = {
  label: "Banco",
  database_name: "db",
  username: "u",
  password: "segredo",
  ssl_mode: "require",
};
const json = (corpo: unknown) =>
  new NextRequest("http://localhost/api/v1/external-db/connections", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(corpo),
  });
const ctx = { params: Promise.resolve({ id: "conn-1" }) };

/** O que o cliente vê: status e corpo, sem o requestId (que muda a cada chamada). */
async function visto(resposta: Response): Promise<{ status: number; corpo: Record<string, unknown> }> {
  const corpo = (await resposta.json()) as { error?: Record<string, unknown> };
  const erro = { ...(corpo.error ?? {}) };
  delete erro.requestId;
  delete erro.request_id;
  return { status: resposta.status, corpo: erro };
}

const HOSTS_RECUSADOS = ["some.exemplo", "interno.exemplo", "metadata.exemplo", "10.0.0.9", "127.0.0.1"];

beforeEach(() => aviso.mockClear());

describe("recusa de host: a mesma resposta para qualquer motivo", () => {
  it("POST /connections", async () => {
    const respostas = [];
    for (const host of HOSTS_RECUSADOS) respostas.push(await visto(await criar(json({ ...CORPO, host }))));

    for (const r of respostas) {
      expect(r.status).toBe(422);
      expect(r.corpo.code).toBe("external_db_destino_bloqueado");
      expect(r.corpo).not.toHaveProperty("details");
      expect(JSON.stringify(r.corpo)).not.toMatch(/dns_falhou|dns_vazio|ip_especial|host_invalido|resolver/);
    }
    expect(new Set(respostas.map((r) => JSON.stringify(r))).size).toBe(1);
  });

  it("PATCH /connections/:id", async () => {
    const respostas = [];
    for (const host of HOSTS_RECUSADOS) respostas.push(await visto(await editar(json({ host }), ctx)));

    for (const r of respostas) {
      expect(r.status).toBe(422);
      expect(r.corpo.code).toBe("external_db_destino_bloqueado");
      expect(r.corpo).not.toHaveProperty("details");
    }
    expect(new Set(respostas.map((r) => JSON.stringify(r))).size).toBe(1);
  });

  it("POST /connections/:id/test", async () => {
    const respostas = [];
    for (const host of HOSTS_RECUSADOS) {
      estado.host = host;
      respostas.push(await visto(await testar(json({}), ctx)));
    }

    for (const r of respostas) {
      expect(r.status).toBe(422);
      expect(r.corpo.code).toBe("external_db_destino_bloqueado");
      expect(r.corpo).not.toHaveProperty("details");
    }
    expect(new Set(respostas.map((r) => JSON.stringify(r))).size).toBe(1);
  });

  it("o motivo real fica no log do servidor, distinto por caso", async () => {
    await criar(json({ ...CORPO, host: "some.exemplo" }));
    await criar(json({ ...CORPO, host: "interno.exemplo" }));

    const motivos = aviso.mock.calls.map((c) => (c[1] as { motivo: string }).motivo);
    expect(motivos).toEqual(["dns_falhou", "ip_especial"]);
  });

  it("rede privada é recusada mesmo em literal de RFC1918 (a lista da instalação não vale para organização)", async () => {
    for (const host of ["10.1.2.3", "172.16.5.5", "192.168.0.10"]) {
      const r = await visto(await criar(json({ ...CORPO, host })));
      expect(r.status).toBe(422);
      expect(r.corpo.code).toBe("external_db_destino_bloqueado");
    }
  });
});
