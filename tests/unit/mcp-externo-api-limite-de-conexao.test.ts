/**
 * Limite de tentativas de conexão MCP (ajuste da auditoria da Tarefa 7):
 * 10 tentativas a cada 10 minutos por organização+pessoa, SOMADAS entre
 * `POST /api/v1/ai/mcp/conexoes` (criar) e `POST /api/v1/ai/mcp/conexoes/
 * [id]/atualizar` (reconectar) — as duas rotas que abrem uma sessão de
 * verdade contra um servidor escolhido por quem preenche o formulário.
 *
 * Ao contrário de `mcp-externo-api-rotas.test.ts` (que MOCKA o limitador para
 * ficar imune a ele), este arquivo exercita `checkRateLimit` de verdade
 * (`lib/ai/dispatcher/rate-limit.ts`, já usado pelo dispatcher de IA e pelo
 * rate limit de auth) — é o que prova que a integração das rotas com ele
 * funciona, não só que a rota confia num booleano.
 *
 * O Redis é forçado a ficar INDISPONÍVEL (`@/lib/env` com as duas variáveis
 * vazias), mesmo padrão de `redis-malformado-nao-vira-ida-a-rede.test.ts`:
 * sem isto, o teste dependeria do Redis local de verdade (`docker ps` mostra
 * um rodando neste ambiente) e ficaria preso à janela de 10 minutos entre
 * execuções — rodar a suíte duas vezes seguidas faria a segunda reprovar por
 * "sobra" da primeira. Em memória, cada org usa um `randomUUID()` próprio por
 * teste, então nem entre `it()`s do mesmo arquivo há interferência.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";

import { requireRole } from "@/lib/auth/require-role";
import { atualizarFerramentas, criarConexao, listarConexoes } from "@/lib/ai/mcp-externo/conexoes";
import type { ConexaoPublica } from "@/lib/ai/mcp-externo/tipos";
import type { AuthUser } from "@/lib/auth/types";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({ loadAuthUser: vi.fn(), resolveActiveOrg: vi.fn() }));
vi.mock("@/lib/ai/mcp-externo/conexoes", () => ({
  listarConexoes: vi.fn(),
  criarConexao: vi.fn(),
  editarConexao: vi.fn(),
  removerConexao: vi.fn(),
  atualizarFerramentas: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/env", () => ({
  env: { UPSTASH_REDIS_REST_URL: "", UPSTASH_REDIS_REST_TOKEN: "" },
}));

const USER_ID = "user-1";

function sessaoAdmin(orgId: string): void {
  const user = { id: USER_ID, email: "u@example.com", idioma: "pt-BR" } as unknown as AuthUser;
  vi.mocked(requireRole).mockResolvedValue({ ok: true, user, org: { orgId, name: "Org", role: "admin" } });
}

function conexaoBase(): ConexaoPublica {
  return {
    id: randomUUID(),
    apelido: "n8n",
    nome: "n8n de produção",
    url: "https://n8n.hiperbold.com.br",
    tem_cabecalho: false,
    cabecalho_nome: null,
    ativa: true,
    ferramentas: [],
    ferramentas_atualizadas_em: null,
    ultimo_erro: null,
    atualizada_em: "2026-01-01T00:00:00.000Z",
  };
}

function corpoValido() {
  return { apelido: "n8n", nome: "n8n de produção", url: "https://n8n.hiperbold.com.br" };
}

function reqCriar(): NextRequest {
  return new NextRequest("http://localhost/api/v1/ai/mcp/conexoes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(corpoValido()),
  });
}

function reqAtualizar(id: string): NextRequest {
  return new NextRequest(`http://localhost/api/v1/ai/mcp/conexoes/${id}/atualizar`, { method: "POST" });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("limite de tentativas de conexão (10 a cada 10 min, somado entre criar e atualizar)", () => {
  it("a 11ª tentativa da mesma organização+pessoa, somando as duas rotas, dá 429", async () => {
    const orgId = randomUUID();
    sessaoAdmin(orgId);
    const conexao = conexaoBase();
    vi.mocked(criarConexao).mockResolvedValue({ ok: true, conexao });
    vi.mocked(atualizarFerramentas).mockResolvedValue({ ok: true, conexao });
    vi.mocked(listarConexoes).mockResolvedValue([conexao]);

    const { POST: criar } = await import("@/app/api/v1/ai/mcp/conexoes/route");
    const { POST: atualizar } = await import("@/app/api/v1/ai/mcp/conexoes/[id]/atualizar/route");
    const ctx = { params: Promise.resolve({ id: conexao.id }) };

    const status: number[] = [];
    // 6 tentativas de criar + 5 de atualizar = 11, na mesma org+pessoa.
    for (let i = 0; i < 6; i++) status.push((await criar(reqCriar())).status);
    for (let i = 0; i < 5; i++) status.push((await atualizar(reqAtualizar(conexao.id), ctx)).status);

    // As 10 primeiras (o orçamento inteiro) passam.
    expect(status.slice(0, 10)).toEqual([201, 201, 201, 201, 201, 201, 200, 200, 200, 200]);
    // A 11ª (a última, uma chamada de atualizar) estoura o orçamento.
    expect(status[10]).toBe(429);
  });

  it("a resposta do estouro é 429 com a mensagem fixa, e o repositório não é chamado", async () => {
    const orgId = randomUUID();
    sessaoAdmin(orgId);
    const conexao = conexaoBase();
    vi.mocked(criarConexao).mockResolvedValue({ ok: true, conexao });

    const { POST: criar } = await import("@/app/api/v1/ai/mcp/conexoes/route");
    for (let i = 0; i < 10; i++) await criar(reqCriar());
    vi.mocked(criarConexao).mockClear();

    const res = await criar(reqCriar());
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("Muitas tentativas de conexão. Espere alguns minutos.");
    // A tentativa recusada pelo LIMITADOR nunca chega no repositório — não é
    // a mesma coisa que a "tentativa recusada pelo repositório" (409/422).
    expect(criarConexao).not.toHaveBeenCalled();
  });

  it("outra organização não é afetada pelo limite estourado da primeira", async () => {
    const orgEstourada = randomUUID();
    const orgLivre = randomUUID();
    const conexao = conexaoBase();
    vi.mocked(criarConexao).mockResolvedValue({ ok: true, conexao });

    const { POST: criar } = await import("@/app/api/v1/ai/mcp/conexoes/route");

    sessaoAdmin(orgEstourada);
    for (let i = 0; i < 10; i++) await criar(reqCriar());
    const onzeAvaDaOrgEstourada = await criar(reqCriar());
    expect(onzeAvaDaOrgEstourada.status).toBe(429);

    sessaoAdmin(orgLivre);
    const primeiraDaOutraOrg = await criar(reqCriar());
    expect(primeiraDaOutraOrg.status).toBe(201);
  });

  it("uma tentativa que o repositório recusa (409/422) TAMBÉM consome o orçamento", async () => {
    const orgId = randomUUID();
    sessaoAdmin(orgId);
    vi.mocked(criarConexao).mockResolvedValue({
      ok: false,
      status: 409,
      motivo: "Já existe uma conexão com este apelido",
    });

    const { POST: criar } = await import("@/app/api/v1/ai/mcp/conexoes/route");
    // 10 tentativas, todas recusadas pelo repositório (409) — nenhuma cria de
    // fato, mas cada uma É uma tentativa de conexão de verdade.
    for (let i = 0; i < 10; i++) {
      const res = await criar(reqCriar());
      expect(res.status).toBe(409);
    }

    const onzeAva = await criar(reqCriar());
    expect(onzeAva.status).toBe(429);
  });
});
