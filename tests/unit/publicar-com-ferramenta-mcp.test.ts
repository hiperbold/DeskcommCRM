/**
 * Publicar, duplicar e reverter aceitam a ferramenta externa (Tarefa 8, D17).
 *
 * ─── A catraca por texto ─────────────────────────────────────────────────────
 *
 * `publishAgentAction`, `revertToVersionAction` e `POST .../publish` tinham
 * CADA UMA a própria cópia de `new Set(VALID_TOOL_IDS).has(id)`. `escopo.ts`
 * já tinha esse defeito documentado no cabeçalho de `capacidades-conhecidas.ts`
 * como o motivo de existir: uma cópia que ficasse para trás recusaria com
 * `tool_id_invalid` o agente que a tela deixou salvar com uma ferramenta MCP.
 * Consertar as três e nenhum teste medir "as três continuam consertadas" é o
 * defeito voltando na próxima cópia — daí a varredura por texto, no estilo de
 * `rascunho-superado-nao-e-regravado.test.ts`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { capacidadesDesconhecidas } from "@/lib/ai/agents/capacidades-conhecidas";
import { duplicateAgentWithVersion } from "@/lib/ai/agents/duplicate";
import type { FerramentaEmCache } from "@/lib/ai/mcp-externo/tipos";

const ORG = "org-1";
const AGENT = "44444444-4444-4444-8444-444444444444";
const VERSAO = "99999999-9999-4999-8999-999999999999";

// ─── Passo 1: capacidadesDesconhecidas separa desconhecido de externo ───────

describe("capacidadesDesconhecidas — id de catálogo, externo e inventado", () => {
  it("aceita catálogo e externo bem formado, recusa só o inventado", () => {
    const r = capacidadesDesconhecidas(["crm_list_tags", "mcp_n8n__buscar", "inventada"]);
    expect(r).toEqual(["inventada"]);
  });
});

// ─── A catraca: nenhuma das três conferências volta a comparar à mão ────────

const ARQUIVOS_DE_PUBLICACAO = [
  "app/api/v1/ai/agents/[id]/publish/route.ts",
  "app/app/ai/agents/[id]/_actions.ts",
];

describe("nenhuma conferência de publicação volta a comparar tool_ids com VALID_TOOL_IDS à mão", () => {
  const raiz = process.cwd();

  it.each(ARQUIVOS_DE_PUBLICACAO)("%s não usa VALID_TOOL_IDS_RUNTIME.has nem valid.has(t)", (arquivo) => {
    const fonte = readFileSync(join(raiz, arquivo), "utf8");
    expect(fonte).not.toMatch(/VALID_TOOL_IDS_RUNTIME\.has|valid\.has\(t\)/);
  });

  it("as três conferências usam capacidadesDesconhecidas", () => {
    const publishRoute = readFileSync(join(raiz, ARQUIVOS_DE_PUBLICACAO[0]!), "utf8");
    const actions = readFileSync(join(raiz, ARQUIVOS_DE_PUBLICACAO[1]!), "utf8");
    expect((publishRoute.match(/capacidadesDesconhecidas\(/g) ?? []).length).toBeGreaterThanOrEqual(1);
    // `_actions.ts` tem DUAS conferências: publishAgentAction e revertToVersionAction.
    expect((actions.match(/capacidadesDesconhecidas\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("as três conferências chamam validarEscopoDaVersao para tool_ids antes de publicar", () => {
    const publishRoute = readFileSync(join(raiz, ARQUIVOS_DE_PUBLICACAO[0]!), "utf8");
    const actions = readFileSync(join(raiz, ARQUIVOS_DE_PUBLICACAO[1]!), "utf8");
    expect(publishRoute).toMatch(/validarEscopoDaVersao\(admin, activeOrg\.orgId, \{\s*\n\s*tool_ids/);
    expect((actions.match(/validarEscopoDaVersao\(admin, activeOrg\.orgId, \{\s*\n\s*tool_ids/g) ?? []).length).toBe(2);
  });
});

// ─── Duplicar mantém o id externo (não há validação nenhuma no caminho: é ───
// cópia direta de `tool_ids`; o teste prova que a cópia não filtra nada) ────

describe("duplicar um agente mantém o id externo em tool_ids", () => {
  it("a versão copiada leva o id mcp_<apelido>__<nome> junto", async () => {
    const AGENTE_MCP = {
      id: AGENT,
      organization_id: ORG,
      name: "Recepção",
      description: "desc",
      model: "claude-sonnet-4-6",
      system_prompt: "prompt",
      kind: "mcp_agent",
      priority: 0,
      config: {},
      guardrails: null,
      active_kb_version_id: null,
    };
    const VERSAO_COM_EXTERNA = {
      id: "version-1",
      organization_id: ORG,
      agent_id: AGENT,
      version_number: 3,
      system_prompt: "prompt da versao",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      credential_id: "cred-1",
      tool_ids: ["crm_get_lead", "mcp_n8n__buscar_imoveis"],
      trigger_config: { events: ["message"] },
      channel_session_id: "chan-1",
      max_steps: 10,
      token_budget: 50000,
      cost_budget_cents: 50,
      history_message_window: 20,
      history_token_window: 8000,
      handoff_keywords: [],
      handoff_tool_enabled: true,
      cases_enabled: false,
      operator_enabled: true,
      operator_model: null,
      operator_tool_ids: ["mcp_n8n__cadastrar_visita"],
      split_messages: false,
      split_max_chars: 600,
      followup: { enabled: false, flow_pointer_ids: [] },
      pipeline_ids: [],
      knowledge_source_ids: [],
      status: "published",
      published_at: "2026-07-31T00:00:00Z",
      superseded_at: null,
      created_at: "2026-07-01T00:00:00Z",
      created_by: "someone",
    };

    const inserts: Array<{ table: string; row: Record<string, unknown> }> = [];
    function builder(table: string) {
      const state: Record<string, unknown> = {};
      const api: Record<string, unknown> = {
        select: () => api,
        eq: (col: string, val: unknown) => {
          state[col] = val;
          return api;
        },
        order: () => api,
        limit: () => api,
        insert: (row: Record<string, unknown>) => {
          inserts.push({ table, row });
          const id = table === "ai_agents" ? "novo-agente" : "nova-versao";
          return { select: () => ({ single: async () => ({ data: { ...row, id }, error: null }) }) };
        },
        maybeSingle: async () => {
          if (table === "ai_agents") return { data: AGENTE_MCP, error: null };
          if (state.status === "published") return { data: VERSAO_COM_EXTERNA, error: null };
          return { data: null, error: null };
        },
      };
      return api;
    }
    const db = { from: (t: string) => builder(t) } as unknown as SupabaseClient;

    const res = await duplicateAgentWithVersion(db, {
      orgId: ORG,
      agentId: AGENT,
      actorUserId: "user-1",
      requireVersion: false,
    });

    expect(res.ok, JSON.stringify(res)).toBe(true);
    const versao = inserts.find((i) => i.table === "ai_agent_versions");
    expect(versao!.row.tool_ids).toEqual(["crm_get_lead", "mcp_n8n__buscar_imoveis"]);
    expect(versao!.row.operator_tool_ids).toEqual(["mcp_n8n__cadastrar_visita"]);
  });
});

// ─── Publicar e reverter, de ponta a ponta, com o dublê de ai_mcp_connections ─

function ferramenta(apelido: string, nome: string): FerramentaEmCache {
  return {
    nome,
    descricao: "",
    input_schema: {},
    somente_leitura: true,
    id: `mcp_${apelido}__${nome}`,
    recusada: null,
  };
}

interface Tabelas {
  ai_agents: Record<string, unknown>[];
  ai_agent_versions: Record<string, unknown>[];
  ai_mcp_connections: Record<string, unknown>[];
  event_log: Record<string, unknown>[];
}

/**
 * Dublê multi-tabela em memória. Cobre só as operações que os três
 * chamadores usam (`select`/`eq`/`in`/`order`/`limit`/`maybeSingle`/`single`/
 * `insert`/`update`/`delete`/thenable) — não é um simulador do PostgREST.
 */
function criarAdmin(tabelas: Tabelas): SupabaseClient {
  function builder(nomeTabela: string) {
    const linhas = (tabelas as unknown as Record<string, Record<string, unknown>[]>)[nomeTabela] ?? [];
    const filtros: [string, unknown][] = [];
    const pertinencias: [string, unknown[]][] = [];
    let colunas: string[] | null = null;
    let ordemDesc = false;
    let ordemCampo: string | null = null;
    let lim = Number.POSITIVE_INFINITY;
    let novaLinha: Record<string, unknown> | null = null;
    let patch: Record<string, unknown> | null = null;
    let apagar = false;

    const casam = () =>
      linhas
        .filter((r) => filtros.every(([c, v]) => r[c] === v))
        .filter((r) => pertinencias.every(([c, vs]) => vs.includes(r[c])));

    const projetar = (rows: Record<string, unknown>[]) =>
      colunas ? rows.map((r) => Object.fromEntries(colunas!.map((c) => [c, r[c]]))) : rows.map((r) => ({ ...r }));

    function ler() {
      let rows = casam();
      if (ordemCampo) {
        const campo = ordemCampo;
        rows = [...rows].sort((a, b) => {
          const av = Number(a[campo]);
          const bv = Number(b[campo]);
          return ordemDesc ? bv - av : av - bv;
        });
      }
      return projetar(rows.slice(0, lim));
    }

    async function run(): Promise<{ data: unknown; error: unknown }> {
      if (apagar) {
        const alvos = casam();
        for (const alvo of alvos) linhas.splice(linhas.indexOf(alvo), 1);
        return { data: null, error: null };
      }
      if (patch) {
        const alvos = casam();
        for (const alvo of alvos) Object.assign(alvo, patch);
        return { data: projetar(alvos), error: null };
      }
      if (novaLinha) {
        linhas.push({ ...novaLinha });
        return { data: projetar([novaLinha]), error: null };
      }
      return { data: ler(), error: null };
    }

    const b = {
      select: (cols?: string) => {
        colunas = cols ? cols.split(",").map((c) => c.trim()) : null;
        return b;
      },
      insert: (obj: Record<string, unknown>) => {
        novaLinha = { id: (obj.id as string | undefined) ?? `gerada-${linhas.length + 1}`, ...obj };
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
      order: (c: string, o?: { ascending?: boolean }) => {
        ordemCampo = c;
        ordemDesc = o?.ascending === false;
        return b;
      },
      limit: (n: number) => {
        lim = n;
        return b;
      },
      maybeSingle: async () => {
        const r = await run();
        return { data: (r.data as unknown[] | null)?.[0] ?? null, error: r.error };
      },
      single: async () => {
        const r = await run();
        const linha = (r.data as unknown[] | null)?.[0] ?? null;
        return { data: linha, error: linha ? null : { message: "sem linha" } };
      },
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => run().then(res, rej),
    };
    return b;
  }

  return { from: (t: string) => builder(t) } as unknown as SupabaseClient;
}

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(async () => ({ id: "user-1", email: "u@example.com" })),
  resolveActiveOrg: vi.fn(async () => ({ orgId: ORG, name: "Org", role: "admin" })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/ai/agents/publish", () => ({
  publishAgentVersion: vi.fn(async (_admin: unknown, params: { agentId: string; versionId: string }) => ({
    ok: true,
    agent_id: params.agentId,
    version_id: params.versionId,
    previous_version_id: null,
    published_at: "2026-01-01T00:00:00Z",
  })),
}));

import { createAdminClient } from "@/lib/supabase/admin";
import { publishAgentAction, revertToVersionAction } from "@/app/app/ai/agents/[id]/_actions";

function versaoBase(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: VERSAO,
    organization_id: ORG,
    agent_id: AGENT,
    version_number: 3,
    system_prompt: "prompt da versao, com pelo menos dez caracteres",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    credential_id: "cred-1",
    tool_ids: [],
    trigger_config: { events: ["message"] },
    channel_session_id: "chan-1",
    max_steps: 10,
    token_budget: 50000,
    cost_budget_cents: 50,
    history_message_window: 20,
    history_token_window: 8000,
    handoff_keywords: [],
    handoff_tool_enabled: true,
    cases_enabled: false,
    operator_enabled: false,
    operator_model: null,
    operator_tool_ids: [],
    split_messages: false,
    split_max_chars: 600,
    followup: { enabled: false, flow_pointer_ids: [] },
    pipeline_ids: [],
    knowledge_source_ids: [],
    status: "published",
    published_at: "2026-07-01T00:00:00Z",
    superseded_at: null,
    created_at: "2026-07-01T00:00:00Z",
    created_by: "user-1",
    ...over,
  };
}

function montarAdmin(versoes: Record<string, unknown>[], conexoes: Record<string, unknown>[] = []) {
  const tabelas: Tabelas = {
    ai_agents: [{ id: AGENT, organization_id: ORG, archived_at: null }],
    ai_agent_versions: versoes,
    ai_mcp_connections: conexoes,
    event_log: [],
  };
  const admin = criarAdmin(tabelas);
  vi.mocked(createAdminClient).mockReturnValue(admin);
  return { admin, tabelas };
}

beforeEach(() => vi.clearAllMocks());

describe("publishAgentAction — ferramenta externa e conferência de escopo", () => {
  it("publica com id externo quando a conexão está ativa e a ferramenta está em cache", async () => {
    montarAdmin(
      [versaoBase({ tool_ids: ["mcp_n8n__buscar"] })],
      [{ organization_id: ORG, slug: "n8n", is_active: true, tools_cache: [ferramenta("n8n", "buscar")] }],
    );
    const r = await publishAgentAction(AGENT, VERSAO);
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });

  it("recusa um id que não é do catálogo nem externo bem formado", async () => {
    montarAdmin([versaoBase({ tool_ids: ["crm_list_tags", "inventada"] })]);
    const r = await publishAgentAction(AGENT, VERSAO);
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toBe("tool_id_invalid");
    expect((r as { details?: { invalid: string[] } }).details?.invalid).toEqual(["inventada"]);
  });

  it("escopo: recusa publicar quando a conexão foi desligada depois de salvar a versão", async () => {
    montarAdmin(
      [versaoBase({ tool_ids: ["mcp_n8n__buscar"] })],
      // A conexão existe mas está INATIVA — id bem formado, mas a ferramenta
      // não está mais disponível para o turno.
      [{ organization_id: ORG, slug: "n8n", is_active: false, tools_cache: [ferramenta("n8n", "buscar")] }],
    );
    const r = await publishAgentAction(AGENT, VERSAO);
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toBe("validation_failed");
    expect((r as { message?: string }).message).toMatch(/Conexões MCP/);
  });
});

describe("revertToVersionAction — ferramenta externa e conferência de escopo", () => {
  it("reverte para uma versão com id externo quando a conexão continua ativa", async () => {
    const { tabelas } = montarAdmin(
      [versaoBase({ tool_ids: ["mcp_n8n__buscar"], operator_tool_ids: ["mcp_n8n__cadastrar_visita"] })],
      [
        {
          organization_id: ORG,
          slug: "n8n",
          is_active: true,
          tools_cache: [ferramenta("n8n", "buscar"), ferramenta("n8n", "cadastrar_visita")],
        },
      ],
    );
    const r = await revertToVersionAction(AGENT, VERSAO);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const nova = tabelas.ai_agent_versions.find((v) => v.id === (r as { data?: { new_version_id: string } }).data?.new_version_id);
    expect(nova?.tool_ids).toEqual(["mcp_n8n__buscar"]);
    expect(nova?.operator_tool_ids).toEqual(["mcp_n8n__cadastrar_visita"]);
  });

  it("recusa reverter para uma versão com id que não é do catálogo nem externo, sem criar draft nenhuma", async () => {
    const { tabelas } = montarAdmin([versaoBase({ tool_ids: ["inventada"] })]);
    const antes = tabelas.ai_agent_versions.length;
    const r = await revertToVersionAction(AGENT, VERSAO);
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toBe("tool_id_invalid");
    expect(tabelas.ai_agent_versions.length, "não pode ter criado draft antes de checar os ids").toBe(antes);
  });

  it("escopo: recusa reverter para uma versão cujo MCP foi desligado, e desfaz a draft criada", async () => {
    const { tabelas } = montarAdmin(
      [versaoBase({ tool_ids: ["mcp_n8n__buscar"] })],
      // Nenhuma conexão "n8n" ativa nesta organização.
      [],
    );
    const antes = tabelas.ai_agent_versions.length;
    const r = await revertToVersionAction(AGENT, VERSAO);
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toBe("validation_failed");
    expect((r as { message?: string }).message).toMatch(/Conexões MCP/);
    // A draft criada para virar a publicação foi desfeita: sobra só a
    // versão de origem, não uma órfã com `status: "draft"` no meio.
    expect(
      tabelas.ai_agent_versions.length,
      "a draft-veículo do revert falho não pode sobrar como lixo",
    ).toBe(antes);
  });
});
