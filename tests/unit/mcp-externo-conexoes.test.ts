/**
 * `lib/ai/mcp-externo/conexoes.ts` — o repositório que só grava depois de
 * conectar (Tarefa 6).
 *
 * O dublê de banco abaixo aplica filtros, contagem e retorno de verdade (no
 * molde de `tests/helpers/stages-db-double.ts`): um estado fixo faria "11ª
 * conexão recusa" e "apelido repetido recusa" passarem mesmo com o `eq`
 * errado ou a contagem nunca lida.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// Cifra falsa em base64 (não é `fn_encrypt_oauth` de verdade, mas transforma o
// byte a ponto de o texto claro NÃO aparecer como substring do resultado,
// diferente de um prefixo literal, que deixaria "nunca grava em claro" passar
// mesmo com o valor plano dentro do que foi gravado).
vi.mock("@/lib/webhooks/secrets", () => ({
  encryptWebhookSecret: vi.fn(
    async (_admin: unknown, valor: string) => `cifrado:${Buffer.from(valor, "utf8").toString("base64")}`,
  ),
  decryptWebhookSecret: vi.fn(async (_admin: unknown, valor: string) =>
    valor.startsWith("cifrado:") ? Buffer.from(valor.slice("cifrado:".length), "base64").toString("utf8") : null,
  ),
}));

import { decryptWebhookSecret, encryptWebhookSecret } from "@/lib/webhooks/secrets";
import { listarFerramentas, type Sessao } from "@/lib/ai/mcp-externo/cliente";
import {
  MAXIMO_DE_CONEXOES,
  atualizarFerramentas,
  carregarParaOTurno,
  criarConexao,
  editarConexao,
  listarConexoes,
  mascararUrl,
  paraPublica,
  removerConexao,
} from "@/lib/ai/mcp-externo/conexoes";
import type { FerramentaEmCache } from "@/lib/ai/mcp-externo/tipos";
import { servidorDeTeste } from "./_helpers/servidor-mcp-de-teste";

const ORG = "org-1";
const OUTRA_ORG = "org-2";

// ─── Dublê de `ai_mcp_connections` ──────────────────────────────────────────

interface LinhaSeed {
  id?: string;
  organization_id: string;
  slug: string;
  name: string;
  url: string;
  auth_header_name?: string | null;
  auth_header_value_encrypted?: string | null;
  is_active?: boolean;
  tools_cache?: FerramentaEmCache[];
  tools_refreshed_at?: string | null;
  last_error?: string | null;
  created_by?: string | null;
  created_at?: string;
  updated_at?: string;
}

function linhaCompleta(seed: LinhaSeed, indice: number): Record<string, unknown> {
  const carimbo = `2026-01-01T00:00:${String(indice).padStart(2, "0")}.000Z`;
  return {
    id: seed.id ?? `linha-${indice}`,
    organization_id: seed.organization_id,
    slug: seed.slug,
    name: seed.name,
    url: seed.url,
    auth_header_name: seed.auth_header_name ?? null,
    auth_header_value_encrypted: seed.auth_header_value_encrypted ?? null,
    is_active: seed.is_active ?? true,
    tools_cache: seed.tools_cache ?? [],
    tools_refreshed_at: seed.tools_refreshed_at ?? null,
    last_error: seed.last_error ?? null,
    created_by: seed.created_by ?? null,
    created_at: seed.created_at ?? carimbo,
    // M1: valor estável e previsível por padrão, pra a maioria dos testes
    // nem pensar em `updated_at` — só quem testa a trava otimista o define.
    updated_at: seed.updated_at ?? carimbo,
  };
}

interface Escrita {
  tipo: "insert" | "update" | "delete";
  patch?: Record<string, unknown>;
  filtros: [string, unknown][];
}

interface OpcoesDoAdminFalso {
  /**
   * M1: chamado bem antes de aplicar o PRIMEIRO update casado por filtro,
   * simulando "outra pessoa gravou a linha entre a leitura e esta escrita".
   * Muda `linhas` diretamente (por referência) — é o mesmo objeto que o
   * `.eq("updated_at", …)` da escrita em curso vai filtrar EM SEGUIDA.
   */
  antesDoUpdate?: (linhas: Record<string, unknown>[]) => void;
  /** B2: injeta um erro do Postgres (ex.: `23505`) na próxima escrita do tipo dado. */
  erroDeEscrita?: (tipo: Escrita["tipo"]) => { code: string; message: string } | null;
}

function criarAdminFalso(seed: LinhaSeed[] = [], opts: OpcoesDoAdminFalso = {}) {
  const linhas: Record<string, unknown>[] = seed.map(linhaCompleta);
  const escritas: Escrita[] = [];
  let proximoIndice = linhas.length;
  let updateJaInterceptado = false;

  function builder() {
    const filtros: [string, unknown][] = [];
    const pertinencias: [string, unknown[]][] = [];
    let colunas: string[] | null = null;
    let contar = false;
    let head = false;
    let ordem: string | null = null;
    let patch: Record<string, unknown> | null = null;
    let novaLinha: Record<string, unknown> | null = null;
    let apagar = false;

    const casam = () =>
      linhas
        .filter((r) => filtros.every(([c, v]) => r[c] === v))
        .filter((r) => pertinencias.every(([c, vs]) => vs.includes(r[c])));

    const projetar = (rows: Record<string, unknown>[]) =>
      colunas ? rows.map((r) => Object.fromEntries(colunas!.map((c) => [c, r[c]]))) : rows.map((r) => ({ ...r }));

    function ler() {
      let rows = casam();
      if (ordem) rows = [...rows].sort((a, b) => String(a[ordem!]).localeCompare(String(b[ordem!])));
      return projetar(rows);
    }

    async function run(): Promise<{ data: unknown; error: unknown; count: number | null }> {
      if (apagar) {
        const erro = opts.erroDeEscrita?.("delete") ?? null;
        escritas.push({ tipo: "delete", filtros: [...filtros] });
        if (erro) return { data: null, error: erro, count: null };
        const alvos = casam();
        for (const alvo of alvos) linhas.splice(linhas.indexOf(alvo), 1);
        return { data: null, error: null, count: null };
      }
      if (patch) {
        const erro = opts.erroDeEscrita?.("update") ?? null;
        escritas.push({ tipo: "update", patch, filtros: [...filtros] });
        if (erro) return { data: null, error: erro, count: null };
        // M1: só na PRIMEIRA escrita casada por update — senão a própria
        // trava otimista (que relê `linhas` a cada chamada) nunca convergiria
        // e todo teste com mais de um update no mesmo admin falso quebraria.
        if (!updateJaInterceptado) {
          updateJaInterceptado = true;
          opts.antesDoUpdate?.(linhas);
        }
        const alvos = casam();
        for (const alvo of alvos) Object.assign(alvo, patch);
        return { data: projetar(alvos), error: null, count: null };
      }
      if (novaLinha) {
        const erro = opts.erroDeEscrita?.("insert") ?? null;
        escritas.push({ tipo: "insert", patch: novaLinha, filtros: [] });
        if (erro) return { data: null, error: erro, count: null };
        const linha = linhaCompleta(novaLinha as unknown as LinhaSeed, ++proximoIndice);
        linhas.push(linha);
        return { data: projetar([linha]), error: null, count: null };
      }
      if (head) return { data: null, error: null, count: casam().length };
      if (contar) return { data: ler(), error: null, count: casam().length };
      return { data: ler(), error: null, count: null };
    }

    const b = {
      select: (cols?: string, opts?: { count?: string; head?: boolean }) => {
        colunas = cols ? cols.split(",").map((c) => c.trim()) : null;
        if (opts?.count) contar = true;
        if (opts?.head) head = true;
        return b;
      },
      insert: (obj: Record<string, unknown>) => {
        novaLinha = obj;
        return b;
      },
      update: (obj: Record<string, unknown>) => {
        patch = obj;
        return b;
      },
      delete: () => {
        apagar = true;
        return b;
      },
      eq: (c: string, v: unknown) => {
        filtros.push([c, v]);
        return b;
      },
      in: (c: string, vs: unknown[]) => {
        pertinencias.push([c, vs]);
        return b;
      },
      order: (c: string) => {
        ordem = c;
        return b;
      },
      maybeSingle: async () => {
        const r = await run();
        return { data: (r.data as unknown[] | null)?.[0] ?? null, error: r.error };
      },
      single: async () => {
        const r = await run();
        const linha = (r.data as unknown[] | null)?.[0] ?? null;
        // Real PostgREST: `.single()` sem NENHUMA linha casada é erro
        // (PGRST116), não sucesso com `data: null` — é esse erro que M1 usa
        // pra distinguir "a trava otimista bloqueou a escrita" de "gravou".
        if (!r.error && !linha) return { data: null, error: { code: "PGRST116", message: "no rows" } };
        return { data: linha, error: r.error };
      },
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => run().then(res, rej),
    };
    return b;
  }

  return { admin: { from: () => builder() } as never, linhas, escritas };
}

// ─── Sessões de teste ────────────────────────────────────────────────────────

/** Sessão cuja listagem de ferramentas falha sempre, e que registra o fechamento. */
function sessaoQueFalha(fecharSpy: () => void): () => Promise<Sessao> {
  return async () => ({
    client: { listTools: () => Promise.reject(new Error("boom_de_teste")) } as unknown as Sessao["client"],
    fechar: async () => {
      fecharSpy();
    },
  });
}

/** O servidor MCP em memória, com o fechamento da sessão espionado. */
function servidorEspionado(fecharSpy: () => void): () => Promise<Sessao> {
  return async () => {
    const sessao = await servidorDeTeste();
    return {
      client: sessao.client,
      fechar: async () => {
        fecharSpy();
        await sessao.fechar();
      },
    };
  };
}

beforeEach(() => {
  vi.mocked(encryptWebhookSecret).mockClear();
  vi.mocked(decryptWebhookSecret).mockClear();
});

// ─── Regras 1-7 ──────────────────────────────────────────────────────────────

describe("criarConexao", () => {
  const entradaBase = { apelido: "imoveis", nome: "Imóveis Ltda", url: "https://mcp.exemplo.com", cabecalho: null };

  it("regra 1: apelido inválido recusa com 422, sem tocar banco nem rede", async () => {
    const { admin, escritas } = criarAdminFalso();
    const r = await criarConexao(admin, ORG, "user-1", { ...entradaBase, apelido: "A" });
    expect(r).toEqual({ ok: false, status: 422, motivo: "O apelido usa só letras minúsculas e números, de 2 a 12" });
    expect(escritas).toHaveLength(0);
  });

  it("regra 2: apelido repetido na organização recusa com 409", async () => {
    const { admin, escritas } = criarAdminFalso([
      { organization_id: ORG, slug: "imoveis", name: "Já existe", url: "https://a.exemplo.com" },
    ]);
    const r = await criarConexao(admin, ORG, "user-1", entradaBase);
    expect(r).toEqual({ ok: false, status: 409, motivo: "Já existe uma conexão com este apelido" });
    expect(escritas.filter((e) => e.tipo === "insert")).toHaveLength(0);
  });

  it("o mesmo apelido em OUTRA organização não conflita (o `eq` de org está certo)", async () => {
    const { admin } = criarAdminFalso([
      { organization_id: OUTRA_ORG, slug: "imoveis", name: "De outro tenant", url: "https://a.exemplo.com" },
    ]);
    const abrir = servidorEspionado(() => {});
    const r = await criarConexao(admin, ORG, "user-1", entradaBase, { abrir });
    expect(r.ok).toBe(true);
  });

  it("regra 3: a 11ª conexão recusa com 422 de limite", async () => {
    const dez = Array.from({ length: MAXIMO_DE_CONEXOES }, (_, i) => ({
      organization_id: ORG,
      slug: `conexao${i}`,
      name: `Conexão ${i}`,
      url: "https://a.exemplo.com",
    }));
    const { admin, escritas } = criarAdminFalso(dez);
    const r = await criarConexao(admin, ORG, "user-1", { ...entradaBase, apelido: "novaconexa" });
    expect(r).toEqual({ ok: false, status: 422, motivo: "Limite de 10 conexões por organização" });
    expect(escritas.filter((e) => e.tipo === "insert")).toHaveLength(0);
  });

  it("a 10ª conexão (dentro do limite) passa da checagem de limite", async () => {
    const nove = Array.from({ length: MAXIMO_DE_CONEXOES - 1 }, (_, i) => ({
      organization_id: ORG,
      slug: `conexao${i}`,
      name: `Conexão ${i}`,
      url: "https://a.exemplo.com",
    }));
    const { admin } = criarAdminFalso(nove);
    const abrir = servidorEspionado(() => {});
    const r = await criarConexao(admin, ORG, "user-1", entradaBase, { abrir });
    expect(r.ok).toBe(true);
  });

  it("regra 4: cifra indisponível recusa com 422 e não grava nada", async () => {
    vi.mocked(encryptWebhookSecret).mockResolvedValueOnce(null);
    const { admin, escritas } = criarAdminFalso();
    const r = await criarConexao(admin, ORG, "user-1", {
      ...entradaBase,
      cabecalho: { nome: "Authorization", valor: "Bearer abc" },
    });
    expect(r).toEqual({
      ok: false,
      status: 422,
      motivo: "cifra indisponível nesta instalação, o cabeçalho não foi gravado",
    });
    expect(escritas).toHaveLength(0);
  });

  it("achado: cabeçalho fora de Authorization/X-* recusa ANTES de conectar, sem gravar", async () => {
    const { admin, escritas } = criarAdminFalso();
    const abrir = vi.fn(servidorEspionado(() => {}));
    const r = await criarConexao(
      admin,
      ORG,
      "user-1",
      { ...entradaBase, cabecalho: { nome: "Cookie", valor: "abc" } },
      { abrir },
    );
    expect(r).toEqual({
      ok: false,
      status: 422,
      motivo: "Este nome de cabeçalho não é permitido (use Authorization ou X-*).",
    });
    expect(abrir).not.toHaveBeenCalled();
    expect(escritas).toHaveLength(0);
  });

  it("achado: valor de cabeçalho com quebra de linha recusa ANTES de conectar, sem gravar", async () => {
    const { admin, escritas } = criarAdminFalso();
    const abrir = vi.fn(servidorEspionado(() => {}));
    const r = await criarConexao(
      admin,
      ORG,
      "user-1",
      { ...entradaBase, cabecalho: { nome: "Authorization", valor: "Bearer abc\nX-Evil: 1" } },
      { abrir },
    );
    expect(r).toEqual({
      ok: false,
      status: 422,
      motivo: "A chave de acesso tem caracteres inválidos (quebra de linha ou espaço no início). Cole de novo.",
    });
    expect(abrir).not.toHaveBeenCalled();
    expect(escritas).toHaveLength(0);
  });

  it("regra 5 e 6: servidor recusa a conexão vira 422 com motivo legível, nada grava, e a sessão fecha", async () => {
    const fecharSpy = vi.fn();
    const { admin, escritas } = criarAdminFalso();
    const r = await criarConexao(admin, ORG, "user-1", entradaBase, { abrir: sessaoQueFalha(fecharSpy) });
    expect(r).toEqual({ ok: false, status: 422, motivo: "Não foi possível conectar ao servidor MCP." });
    expect(escritas).toHaveLength(0);
    expect(fecharSpy).toHaveBeenCalledTimes(1);
  });

  it("achado: o motivo nunca é a mensagem crua do erro (pode vir do servidor de terceiro)", async () => {
    const abrir = async (): Promise<Sessao> => {
      throw new Error("Bearer sk-super-secreto-do-cliente vazou aqui");
    };
    const { admin } = criarAdminFalso();
    const r = await criarConexao(admin, ORG, "user-1", entradaBase, { abrir });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).not.toMatch(/sk-super-secreto/);
  });

  it("regra 5: unsafe_url vira 'Este endereço não é permitido'", async () => {
    const abrir = async (): Promise<Sessao> => {
      throw new Error("unsafe_url:ip_interno");
    };
    const { admin } = criarAdminFalso();
    const r = await criarConexao(admin, ORG, "user-1", entradaBase, { abrir });
    expect(r).toMatchObject({ ok: false, status: 422, motivo: expect.stringContaining("Este endereço não é permitido") });
  });

  it("regra 5: falha de rede vira 'O servidor não respondeu a tempo.'", async () => {
    const abrir = async (): Promise<Sessao> => {
      throw new Error("mcp_conexao_sem_resposta");
    };
    const { admin } = criarAdminFalso();
    const r = await criarConexao(admin, ORG, "user-1", entradaBase, { abrir });
    expect(r).toEqual({ ok: false, status: 422, motivo: "O servidor não respondeu a tempo." });
  });

  it("cria com sucesso: grava as ferramentas com somente_leitura_confirmado null e fecha a sessão de teste", async () => {
    const fecharSpy = vi.fn();
    const { admin, linhas } = criarAdminFalso();
    const r = await criarConexao(admin, ORG, "user-42", entradaBase, { abrir: servidorEspionado(fecharSpy) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.conexao.apelido).toBe("imoveis");
    expect(r.conexao.ferramentas.length).toBeGreaterThan(0);
    // achado: TODA ferramenta nova nasce sem decisão do admin.
    expect(r.conexao.ferramentas.every((f) => f.somente_leitura_confirmado === null)).toBe(true);
    expect(fecharSpy).toHaveBeenCalledTimes(1);
    // grava created_by, e não em claro no cabeçalho (aqui sem cabeçalho mesmo).
    expect(linhas[0]).toMatchObject({ created_by: "user-42", organization_id: ORG });
  });

  it("cifra o cabeçalho antes de gravar (nunca em claro)", async () => {
    const { admin, linhas } = criarAdminFalso();
    const r = await criarConexao(
      admin,
      ORG,
      "user-1",
      { ...entradaBase, cabecalho: { nome: "Authorization", valor: "Bearer segredo-123" } },
      { abrir: servidorEspionado(() => {}) },
    );
    expect(r.ok).toBe(true);
    expect(linhas[0]?.auth_header_value_encrypted).toBe(
      `cifrado:${Buffer.from("Bearer segredo-123", "utf8").toString("base64")}`,
    );
    expect(JSON.stringify(linhas[0])).not.toContain("segredo-123");
  });

  it("M2: URL com usuário e senha embutidos recusa com 422, sem tocar rede nem banco", async () => {
    const { admin, escritas } = criarAdminFalso();
    const abrir = vi.fn(servidorEspionado(() => {}));
    const r = await criarConexao(
      admin,
      ORG,
      "user-1",
      { ...entradaBase, url: "https://usuario:senha@mcp.exemplo.com" },
      { abrir },
    );
    expect(r).toEqual({
      ok: false,
      status: 422,
      motivo: "Não coloque usuário e senha no endereço. Use o campo de cabeçalho.",
    });
    expect(abrir).not.toHaveBeenCalled();
    expect(escritas).toHaveLength(0);
  });

  it("B2: violação de unique no insert (corrida) vira 409 de apelido repetido, não 500", async () => {
    const { admin } = criarAdminFalso([], {
      erroDeEscrita: (tipo) =>
        tipo === "insert" ? { code: "23505", message: 'duplicate key value violates unique constraint "ai_mcp_connections_org_slug_key"' } : null,
    });
    const r = await criarConexao(admin, ORG, "user-1", entradaBase, { abrir: servidorEspionado(() => {}) });
    expect(r).toEqual({ ok: false, status: 409, motivo: "Já existe uma conexão com este apelido" });
  });

  it("B3: nome curto demais (depois do trim) recusa com 422, sem gravar", async () => {
    const { admin, escritas } = criarAdminFalso();
    const abrir = vi.fn(servidorEspionado(() => {}));
    const r = await criarConexao(admin, ORG, "user-1", { ...entradaBase, nome: " a " }, { abrir });
    expect(r).toEqual({ ok: false, status: 422, motivo: "O nome precisa ter de 2 a 80 caracteres" });
    expect(abrir).not.toHaveBeenCalled();
    expect(escritas).toHaveLength(0);
  });

  it("B3: nome longo demais (81 caracteres) recusa com 422, sem gravar", async () => {
    const { admin, escritas } = criarAdminFalso();
    const nome = "a".repeat(81);
    const r = await criarConexao(admin, ORG, "user-1", { ...entradaBase, nome });
    expect(r).toEqual({ ok: false, status: 422, motivo: "O nome precisa ter de 2 a 80 caracteres" });
    expect(escritas).toHaveLength(0);
  });

  it("B3: grava o nome já com trim aplicado", async () => {
    const { admin, linhas } = criarAdminFalso();
    const r = await criarConexao(
      admin,
      ORG,
      "user-1",
      { ...entradaBase, nome: "  Imóveis Ltda  " },
      { abrir: servidorEspionado(() => {}) },
    );
    expect(r.ok).toBe(true);
    expect(linhas[0]?.name).toBe("Imóveis Ltda");
  });

  it("B4: fechar() da sessão de teste rejeitando não derruba a criação (a listagem já funcionou)", async () => {
    const abrir = async (): Promise<Sessao> => {
      const sessao = await servidorDeTeste();
      return {
        client: sessao.client,
        fechar: async () => {
          await sessao.fechar();
          throw new Error("fechar quebrado de propósito");
        },
      };
    };
    const { admin } = criarAdminFalso();
    const r = await criarConexao(admin, ORG, "user-1", entradaBase, { abrir });
    expect(r.ok).toBe(true);
  });
});

describe("mascararUrl", () => {
  it("origem com caminho ou busca vira origem + '/…'", () => {
    expect(mascararUrl("https://h.com/mcp/abc123?k=x")).toBe("https://h.com/…");
  });

  it("origem sem caminho (ou só '/') fica como está", () => {
    expect(mascararUrl("https://h.com")).toBe("https://h.com");
    expect(mascararUrl("https://h.com/")).toBe("https://h.com");
  });

  it("preserva a porta quando não é a padrão", () => {
    expect(mascararUrl("https://h.com:8443/mcp")).toBe("https://h.com:8443/…");
  });
});

// ─── `atualizarFerramentas` ─────────────────────────────────────────────────

describe("atualizarFerramentas", () => {
  async function ferramentasReais(): Promise<FerramentaEmCache[]> {
    const sessao = await servidorDeTeste();
    const lista = await listarFerramentas(sessao, "imoveis");
    await sessao.fechar();
    return lista;
  }

  it("achado: mantém a confirmação quando nome, descrição E esquema não mudaram", async () => {
    const reais = await ferramentasReais();
    const cacheAnterior = reais.map((f) =>
      f.nome === "buscar_imoveis" ? { ...f, somente_leitura_confirmado: true } : { ...f, somente_leitura_confirmado: null },
    );
    const { admin } = criarAdminFalso([
      {
        id: "conexao-1",
        organization_id: ORG,
        slug: "imoveis",
        name: "Imóveis Ltda",
        url: "https://mcp.exemplo.com",
        tools_cache: cacheAnterior,
        tools_refreshed_at: "2026-01-01T00:00:00.000Z",
      },
    ]);
    const r = await atualizarFerramentas(admin, ORG, "conexao-1", { abrir: servidorEspionado(() => {}) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const busca = r.conexao.ferramentas.find((f) => f.nome === "buscar_imoveis");
    expect(busca?.somente_leitura_confirmado).toBe(true);
  });

  it("achado: a confirmação volta a null quando a descrição mudou desde a última aprovação", async () => {
    const reais = await ferramentasReais();
    const cacheAnterior = reais.map((f) =>
      f.nome === "buscar_imoveis"
        ? { ...f, descricao: "Descrição antiga, já mudou no servidor", somente_leitura_confirmado: true }
        : { ...f, somente_leitura_confirmado: true },
    );
    const { admin } = criarAdminFalso([
      {
        id: "conexao-1",
        organization_id: ORG,
        slug: "imoveis",
        name: "Imóveis Ltda",
        url: "https://mcp.exemplo.com",
        tools_cache: cacheAnterior,
      },
    ]);
    const r = await atualizarFerramentas(admin, ORG, "conexao-1", { abrir: servidorEspionado(() => {}) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const busca = r.conexao.ferramentas.find((f) => f.nome === "buscar_imoveis");
    expect(busca?.somente_leitura_confirmado).toBeNull();
    // as ferramentas que NÃO mudaram continuam com a confirmação anterior.
    const visita = r.conexao.ferramentas.find((f) => f.nome === "cadastrar_visita");
    expect(visita?.somente_leitura_confirmado).toBe(true);
  });

  it("achado: ferramenta nova (ausente do cache anterior) entra com somente_leitura_confirmado null", async () => {
    const { admin } = criarAdminFalso([
      {
        id: "conexao-1",
        organization_id: ORG,
        slug: "imoveis",
        name: "Imóveis Ltda",
        url: "https://mcp.exemplo.com",
        tools_cache: [], // conexão criada antes de nenhuma ferramenta ter sido lida
      },
    ]);
    const r = await atualizarFerramentas(admin, ORG, "conexao-1", { abrir: servidorEspionado(() => {}) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.conexao.ferramentas.every((f) => f.somente_leitura_confirmado === null)).toBe(true);
  });

  it("falha do servidor grava last_error legível e MANTÉM o cache anterior", async () => {
    const cacheAnterior: FerramentaEmCache[] = [
      {
        nome: "buscar_imoveis",
        descricao: "Busca imóveis por bairro",
        input_schema: { type: "object" },
        somente_leitura: true,
        id: "mcp_imoveis__buscar_imoveis",
        recusada: null,
        somente_leitura_confirmado: true,
      },
    ];
    const { admin } = criarAdminFalso([
      {
        id: "conexao-1",
        organization_id: ORG,
        slug: "imoveis",
        name: "Imóveis Ltda",
        url: "https://mcp.exemplo.com",
        tools_cache: cacheAnterior,
        tools_refreshed_at: "2026-01-01T00:00:00.000Z",
      },
    ]);
    const r = await atualizarFerramentas(admin, ORG, "conexao-1", { abrir: sessaoQueFalha(() => {}) });
    expect(r).toEqual({ ok: false, status: 422, motivo: "Não foi possível conectar ao servidor MCP." });

    const [linha] = await listarConexoes(admin, ORG);
    expect(linha).toBeDefined();
    expect(linha?.ultimo_erro).toBe("Não foi possível conectar ao servidor MCP.");
    expect(linha?.ferramentas).toEqual(cacheAnterior);
    expect(linha?.ferramentas_atualizadas_em).toBe("2026-01-01T00:00:00.000Z");
  });

  it("regra 6: a sessão de teste fecha mesmo quando a listagem falha", async () => {
    const fecharSpy = vi.fn();
    const { admin } = criarAdminFalso([
      { id: "conexao-1", organization_id: ORG, slug: "imoveis", name: "Imóveis", url: "https://mcp.exemplo.com" },
    ]);
    await atualizarFerramentas(admin, ORG, "conexao-1", { abrir: sessaoQueFalha(fecharSpy) });
    expect(fecharSpy).toHaveBeenCalledTimes(1);
  });

  it("M1: escrita concorrente entre a leitura e a gravação recusa com 409 e preserva a confirmação alheia", async () => {
    const cacheOriginal: FerramentaEmCache[] = [
      {
        nome: "buscar_imoveis",
        descricao: "Busca imóveis por bairro",
        input_schema: { type: "object" },
        somente_leitura: true,
        id: "mcp_imoveis__buscar_imoveis",
        recusada: null,
        somente_leitura_confirmado: null,
      },
    ];
    // O que "outra pessoa" grava no meio da chamada de rede (ex.: o admin
    // confirmou "só consulta" pela tela da Tarefa 11) — é isto que a trava
    // otimista tem que preservar em vez de sobrescrever.
    const cacheDaOutraPessoa: FerramentaEmCache[] = [
      { ...cacheOriginal[0]!, somente_leitura_confirmado: true },
    ];
    const { admin, linhas } = criarAdminFalso(
      [
        {
          id: "conexao-1",
          organization_id: ORG,
          slug: "imoveis",
          name: "Imóveis Ltda",
          url: "https://mcp.exemplo.com",
          tools_cache: cacheOriginal,
          updated_at: "2026-01-01T00:00:00.000Z",
        },
      ],
      {
        antesDoUpdate: (linhas) => {
          const linha = linhas.find((l) => l.id === "conexao-1")!;
          linha.updated_at = "2026-01-01T00:05:00.000Z"; // mudou depois que `buscarLinha` já tinha lido
          linha.tools_cache = cacheDaOutraPessoa;
        },
      },
    );
    const r = await atualizarFerramentas(admin, ORG, "conexao-1", { abrir: servidorEspionado(() => {}) });
    expect(r).toEqual({
      ok: false,
      status: 409,
      motivo: "A conexão foi alterada por outra pessoa enquanto atualizava. Tente de novo.",
    });
    const linha = linhas.find((l) => l.id === "conexao-1");
    expect(linha?.tools_cache).toEqual(cacheDaOutraPessoa);
  });

  it("B1: chave de acesso salva que não decifra recusa com 422, grava last_error, e NÃO tenta conectar", async () => {
    const { admin, linhas } = criarAdminFalso([
      {
        id: "conexao-1",
        organization_id: ORG,
        slug: "imoveis",
        name: "Imóveis Ltda",
        url: "https://mcp.exemplo.com",
        auth_header_name: "Authorization",
        auth_header_value_encrypted: "isto-nao-comeca-com-o-prefixo-da-cifra-falsa",
      },
    ]);
    const abrir = vi.fn(servidorEspionado(() => {}));
    const r = await atualizarFerramentas(admin, ORG, "conexao-1", { abrir });
    expect(r).toEqual({
      ok: false,
      status: 422,
      motivo: "A chave de acesso salva não pôde ser lida. Cadastre a chave de novo.",
    });
    expect(abrir).not.toHaveBeenCalled();
    const linha = linhas.find((l) => l.id === "conexao-1");
    expect(linha?.last_error).toBe("A chave de acesso salva não pôde ser lida. Cadastre a chave de novo.");
  });

  it("404 quando a conexão não existe nesta organização", async () => {
    const { admin } = criarAdminFalso([
      { id: "conexao-1", organization_id: OUTRA_ORG, slug: "imoveis", name: "Imóveis", url: "https://mcp.exemplo.com" },
    ]);
    const r = await atualizarFerramentas(admin, ORG, "conexao-1");
    expect(r).toEqual({ ok: false, status: 404, motivo: "Conexão não encontrada" });
  });
});

// ─── `editarConexao` ─────────────────────────────────────────────────────────

describe("editarConexao", () => {
  function seedBase(): LinhaSeed[] {
    return [
      { id: "conexao-1", organization_id: ORG, slug: "imoveis", name: "Imóveis Ltda", url: "https://mcp.exemplo.com" },
    ];
  }

  it("achado: recusa cabeçalho proibido, sem gravar", async () => {
    const { admin, escritas } = criarAdminFalso(seedBase());
    const r = await editarConexao(admin, ORG, "conexao-1", { cabecalho: { nome: "Cookie", valor: "x" } });
    expect(r).toEqual({
      ok: false,
      status: 422,
      motivo: "Este nome de cabeçalho não é permitido (use Authorization ou X-*).",
    });
    expect(escritas.filter((e) => e.tipo === "update")).toHaveLength(0);
  });

  it("achado: recusa valor de cabeçalho com espaço no início, sem gravar", async () => {
    const { admin, escritas } = criarAdminFalso(seedBase());
    const r = await editarConexao(admin, ORG, "conexao-1", { cabecalho: { nome: "Authorization", valor: " Bearer x" } });
    expect(r).toEqual({
      ok: false,
      status: 422,
      motivo: "A chave de acesso tem caracteres inválidos (quebra de linha ou espaço no início). Cole de novo.",
    });
    expect(escritas.filter((e) => e.tipo === "update")).toHaveLength(0);
  });

  it("regra 4: cifra indisponível na edição recusa e não grava", async () => {
    vi.mocked(encryptWebhookSecret).mockResolvedValueOnce(null);
    const { admin, escritas } = criarAdminFalso(seedBase());
    const r = await editarConexao(admin, ORG, "conexao-1", { cabecalho: { nome: "Authorization", valor: "Bearer x" } });
    expect(r).toEqual({
      ok: false,
      status: 422,
      motivo: "cifra indisponível nesta instalação, o cabeçalho não foi gravado",
    });
    expect(escritas.filter((e) => e.tipo === "update")).toHaveLength(0);
  });

  it("edita nome, ativa e cabeçalho com sucesso, cifrando o novo valor", async () => {
    const { admin, linhas } = criarAdminFalso(seedBase());
    const r = await editarConexao(admin, ORG, "conexao-1", {
      nome: "Novo nome",
      ativa: false,
      cabecalho: { nome: "Authorization", valor: "Bearer novo" },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.conexao).toMatchObject({ nome: "Novo nome", ativa: false, tem_cabecalho: true, cabecalho_nome: "Authorization" });
    expect(linhas[0]?.auth_header_value_encrypted).toBe(`cifrado:${Buffer.from("Bearer novo", "utf8").toString("base64")}`);
  });

  it("remove o cabeçalho quando o patch manda `cabecalho: null`", async () => {
    const { admin } = criarAdminFalso([
      {
        id: "conexao-1",
        organization_id: ORG,
        slug: "imoveis",
        name: "Imóveis",
        url: "https://mcp.exemplo.com",
        auth_header_name: "Authorization",
        auth_header_value_encrypted: "cifrado:Bearer velho",
      },
    ]);
    const r = await editarConexao(admin, ORG, "conexao-1", { cabecalho: null });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.conexao.tem_cabecalho).toBe(false);
    expect(r.conexao.cabecalho_nome).toBeNull();
  });

  it("404 quando a conexão é de outra organização", async () => {
    const { admin } = criarAdminFalso([
      { id: "conexao-1", organization_id: OUTRA_ORG, slug: "imoveis", name: "Imóveis", url: "https://mcp.exemplo.com" },
    ]);
    const r = await editarConexao(admin, ORG, "conexao-1", { nome: "Tentativa" });
    expect(r).toEqual({ ok: false, status: 404, motivo: "Conexão não encontrada" });
  });

  it("B3: nome curto demais (depois do trim) recusa com 422, sem gravar", async () => {
    const { admin, escritas } = criarAdminFalso(seedBase());
    const r = await editarConexao(admin, ORG, "conexao-1", { nome: "  a  " });
    expect(r).toEqual({ ok: false, status: 422, motivo: "O nome precisa ter de 2 a 80 caracteres" });
    expect(escritas.filter((e) => e.tipo === "update")).toHaveLength(0);
  });

  it("B3: nome longo demais (81 caracteres) recusa com 422, sem gravar", async () => {
    const { admin, escritas } = criarAdminFalso(seedBase());
    const r = await editarConexao(admin, ORG, "conexao-1", { nome: "a".repeat(81) });
    expect(r).toEqual({ ok: false, status: 422, motivo: "O nome precisa ter de 2 a 80 caracteres" });
    expect(escritas.filter((e) => e.tipo === "update")).toHaveLength(0);
  });

  it("B3: grava o nome já com trim aplicado", async () => {
    const { admin, linhas } = criarAdminFalso(seedBase());
    const r = await editarConexao(admin, ORG, "conexao-1", { nome: "  Novo Nome  " });
    expect(r.ok).toBe(true);
    expect(linhas[0]?.name).toBe("Novo Nome");
  });
});

// ─── `removerConexao` ────────────────────────────────────────────────────────

describe("removerConexao", () => {
  it("remove a linha da organização certa", async () => {
    const { admin, linhas } = criarAdminFalso([
      { id: "conexao-1", organization_id: ORG, slug: "imoveis", name: "Imóveis", url: "https://mcp.exemplo.com" },
    ]);
    const r = await removerConexao(admin, ORG, "conexao-1");
    expect(r).toEqual({ ok: true });
    expect(linhas).toHaveLength(0);
  });

  it("404 sem apagar quando a conexão é de outra organização", async () => {
    const { admin, linhas } = criarAdminFalso([
      { id: "conexao-1", organization_id: OUTRA_ORG, slug: "imoveis", name: "Imóveis", url: "https://mcp.exemplo.com" },
    ]);
    const r = await removerConexao(admin, ORG, "conexao-1");
    expect(r).toEqual({ ok: false, status: 404, motivo: "Conexão não encontrada" });
    expect(linhas).toHaveLength(1);
  });
});

// ─── `paraPublica` e `listarConexoes` ───────────────────────────────────────

describe("paraPublica", () => {
  it("M2: também mascara a URL (só a origem, sem caminho nem busca)", () => {
    const publica = paraPublica({
      id: "conexao-1",
      slug: "imoveis",
      name: "Imóveis",
      url: "https://mcp.exemplo.com/tenant/abc123?token=segredo",
      auth_header_name: null,
      auth_header_value_encrypted: null,
      is_active: true,
      tools_cache: [],
      tools_refreshed_at: null,
      last_error: null,
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    expect(publica.url).toBe("https://mcp.exemplo.com/…");
    expect(publica.url).not.toContain("tenant/abc123");
    expect(publica.url).not.toContain("segredo");
  });

  it("regra 7: nunca inclui auth_header_value_encrypted", () => {
    const publica = paraPublica({
      id: "conexao-1",
      slug: "imoveis",
      name: "Imóveis",
      url: "https://mcp.exemplo.com",
      auth_header_name: "Authorization",
      auth_header_value_encrypted: "cifrado:Bearer segredo-super-secreto",
      is_active: true,
      tools_cache: [],
      tools_refreshed_at: null,
      last_error: null,
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    expect(publica).not.toHaveProperty("auth_header_value_encrypted");
    expect(JSON.stringify(publica)).not.toContain("segredo-super-secreto");
    expect(publica.tem_cabecalho).toBe(true);
  });
});

describe("listarConexoes", () => {
  it("lista só as conexões desta organização, no formato público", async () => {
    const { admin } = criarAdminFalso([
      { id: "c1", organization_id: ORG, slug: "imoveis", name: "Imóveis", url: "https://a.exemplo.com" },
      { id: "c2", organization_id: OUTRA_ORG, slug: "outra", name: "Outra org", url: "https://b.exemplo.com" },
    ]);
    const lista = await listarConexoes(admin, ORG);
    expect(lista).toHaveLength(1);
    expect(lista[0]).not.toHaveProperty("auth_header_value_encrypted");
    expect(lista[0]?.apelido).toBe("imoveis");
  });
});

// ─── `carregarParaOTurno` ────────────────────────────────────────────────────

describe("carregarParaOTurno", () => {
  it("só traz conexões ATIVAS desta organização, com o cabeçalho decifrado", async () => {
    const { admin } = criarAdminFalso([
      {
        id: "c1",
        organization_id: ORG,
        slug: "imoveis",
        name: "Imóveis",
        url: "https://a.exemplo.com",
        auth_header_name: "Authorization",
        auth_header_value_encrypted: `cifrado:${Buffer.from("Bearer x", "utf8").toString("base64")}`,
      },
      { id: "c2", organization_id: ORG, slug: "inativa", name: "Inativa", url: "https://b.exemplo.com", is_active: false },
      { id: "c3", organization_id: OUTRA_ORG, slug: "imoveis", name: "De outro tenant", url: "https://c.exemplo.com" },
    ]);
    const r = await carregarParaOTurno(admin, ORG, ["imoveis", "inativa"]);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ apelido: "imoveis", url: "https://a.exemplo.com", cabecalho: { nome: "Authorization", valor: "Bearer x" } });
  });

  it("lista vazia de apelidos não bate no banco e devolve vazio", async () => {
    const { admin } = criarAdminFalso([]);
    expect(await carregarParaOTurno(admin, ORG, [])).toEqual([]);
  });

  it("B1: pula a conexão inteira (não entra com cabecalho: null) quando a chave salva não decifra", async () => {
    const { admin } = criarAdminFalso([
      {
        id: "c1",
        organization_id: ORG,
        slug: "quebrada",
        name: "Chave ilegível",
        url: "https://a.exemplo.com",
        auth_header_name: "Authorization",
        auth_header_value_encrypted: "isto-nao-comeca-com-o-prefixo-da-cifra-falsa",
      },
      { id: "c2", organization_id: ORG, slug: "sem-cabecalho", name: "Sem cabeçalho", url: "https://b.exemplo.com" },
    ]);
    const r = await carregarParaOTurno(admin, ORG, ["quebrada", "sem-cabecalho"]);
    expect(r).toHaveLength(1);
    expect(r[0]?.apelido).toBe("sem-cabecalho");
  });
});
