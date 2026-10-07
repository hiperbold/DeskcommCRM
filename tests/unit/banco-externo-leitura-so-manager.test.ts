/**
 * D-146 (vizinho): a leitura de DADOS e do CATÁLOGO do banco externo é de manager para cima.
 *
 * O defeito: as duas rotas pediam só `viewer`. Um membro "Somente leitura" paginava qualquer tabela do ERP
 * (CPF, cartão, endereço) e listava o catálogo inteiro, sem lista de tabelas liberadas pelo administrador.
 * Roda os Route Handlers REAIS com as fronteiras dubladas; `requireRole` é dublado COM a regra de rank, então
 * o que se prova é o comportamento (viewer e agent barrados, manager e admin lendo), não a chamada ao helper.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { fail } from "@/lib/api/wrappers";
import { ROLE_RANK, type Role } from "@/lib/auth/types";

const CONEXAO = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";

let papelDoUsuario: Role = "viewer";

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(async (min: Role, opts: { requestId?: string }) => {
    if (ROLE_RANK[papelDoUsuario] < ROLE_RANK[min]) {
      return { ok: false, response: fail("forbidden_role", "Sem permissão.", 403, { requestId: opts.requestId }) };
    }
    return {
      ok: true,
      user: { id: "u1", idioma: "pt-BR" },
      org: { orgId: ORG, role: papelDoUsuario },
    };
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: vi.fn(async () => ({ allowed: true })) }));
vi.mock("@/app/api/v1/external-db/_falha", () => ({
  seModuloDesligado: vi.fn(async () => null),
  respostaDeAcesso: vi.fn(),
}));
vi.mock("@/lib/external-db/acesso", () => ({
  abrirAcesso: vi.fn(async () => ({ ok: true, pool: {}, conexao: { maxRows: 100 } })),
}));
vi.mock("@/lib/external-db/introspeccao", () => ({
  listarTabelas: vi.fn(async () => [{ schema: "public", tabela: "clientes" }]),
  colunasDaTabela: vi.fn(async () => [{ nome: "cpf", tipo: "text" }]),
}));
vi.mock("@/lib/external-db/leitura", async () => {
  const real = (await vi.importActual("@/lib/external-db/leitura")) as Record<string, unknown>;
  return {
    ...real,
    lerTabela: vi.fn(async () => ({ colunas: ["cpf"], linhas: [{ cpf: "123" }], limite: 10, offset: 0 })),
  };
});

import { abrirAcesso } from "@/lib/external-db/acesso";
import { GET as lerDados } from "@/app/api/v1/external-db/connections/[id]/tables/[schema]/[tabela]/route";
import { GET as lerCatalogo } from "@/app/api/v1/external-db/connections/[id]/schemas/route";

function dados(): Promise<Response> {
  return lerDados(new NextRequest(`http://local/api/v1/external-db/connections/${CONEXAO}/tables/public/clientes`), {
    params: Promise.resolve({ id: CONEXAO, schema: "public", tabela: "clientes" }),
  });
}

function catalogo(): Promise<Response> {
  return lerCatalogo(new NextRequest(`http://local/api/v1/external-db/connections/${CONEXAO}/schemas`), {
    params: Promise.resolve({ id: CONEXAO }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  papelDoUsuario = "viewer";
});

describe.each([
  ["dados da tabela", dados],
  ["catálogo de tabelas", catalogo],
])("leitura do banco externo: %s", (_nome, chamar) => {
  it.each<Role>(["viewer", "agent"])("%s é barrado com 403 e a conexão nem chega a abrir", async (papel) => {
    papelDoUsuario = papel;
    const res = await chamar();

    expect(res.status).toBe(403);
    expect(abrirAcesso).not.toHaveBeenCalled();
  });

  it.each<Role>(["manager", "admin"])("%s lê (controle positivo: o gate não fechou para todo mundo)", async (papel) => {
    papelDoUsuario = papel;
    const res = await chamar();

    expect(res.status).toBe(200);
    expect(abrirAcesso).toHaveBeenCalledTimes(1);
  });
});
