/**
 * O que este teste protege, em duas frentes.
 *
 * **1. Sem gateway, o embedding não pode passar pelo gateway.**
 * O arquivo prometia esse caminho no cabeçalho desde que nasceu ("otherwise uses
 * the OpenAI provider directly") e não o tinha: passava a string
 * `openai/text-embedding-3-small` direto para `embed()`, e no AI SDK um id com
 * barra é resolvido pelo **gateway da Vercel mesmo sem chave** — entrando no
 * plano anônimo. O teto desse plano devolve `GatewayRateLimitError`, o `catch`
 * do `searchKnowledge` engole, e a busca na base volta vazia sem gravar nada.
 *
 * A asserção é sobre o TIPO do que chega em `embed({model})`: string significa
 * "deixa o gateway resolver"; objeto significa "provider explícito". É a única
 * diferença observável sem rede.
 *
 * **2. A chave vem da ORGANIZAÇÃO (0181).** Até aqui `embedText` lia só o
 * `process.env`, e o efeito era o pior possível para quem instala: cadastrar a
 * chave da OpenAI pela tela NÃO habilitava a base de conhecimento, enquanto duas
 * telas do produto prometiam que sim. Os casos abaixo cobrem os dois desfechos —
 * a chave da organização é usada, e a ausência dela vira erro TIPADO em vez de
 * uma falha genérica que a tela não sabe traduzir.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const embedSpy = vi.fn();
vi.mock("ai", () => ({
  embed: (args: unknown) => embedSpy(args),
}));

// Tarefa 8 (Frente 2): `embedText` agora grava telemetria em `llm_calls`.
// Mockado no nível do client, e não da função: para provar a integração real
// (o `insert` chega com os campos certos, e uma falha nele não derruba a
// chamada), não só que `embedText` "chamou algo".
const insertMock = vi.fn();
let insertDeveLancar = false;
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => ({
      insert: async (row: Record<string, unknown>) => {
        if (insertDeveLancar) throw new Error("conexão com o banco explodiu");
        insertMock(tabela, row);
        return { error: null };
      },
    }),
  }),
}));

let chaveMock: () => unknown;
vi.mock("@/lib/ai/embeddings/chave", async () => {
  const real =
    await vi.importActual<typeof import("@/lib/ai/embeddings/chave")>("@/lib/ai/embeddings/chave");
  return {
    ...real,
    // Mockado porque a resposta REAL depende de banco e de `.env.local`, e este
    // arquivo mede qual OBJETO DE MODELO chega em `embed()`. Sem isto ele só
    // passaria em máquina com credencial — refém de algo que não usa.
    resolverChaveDeEmbedding: async () => chaveMock(),
  };
});

import { embedText, SemChaveDeEmbeddingError } from "@/lib/ai/embed";

beforeEach(() => {
  insertMock.mockReset();
  insertDeveLancar = false;
  embedSpy.mockReset();
  embedSpy.mockResolvedValue({
    // 1536 dimensões: `embedText` assere a dimensão a cada chamada, porque
    // divergir de modelo quebra o recall em SILÊNCIO.
    embedding: Array.from({ length: 1536 }, (_, i) => i / 1536),
    usage: { tokens: 7 },
  });
  chaveMock = () => ({
    apiKey: "sk-da-organizacao",
    baseUrl: null,
    viaGateway: false,
    origem: "credencial_da_organizacao",
    rotulo: "Chave principal",
    avisos: [],
  });
});

describe("embedText", () => {
  it("SEM gateway, usa o provider OpenAI explícito — nunca a string com barra", async () => {
    await embedText("oi", { organizationId: "org-1" });

    const arg = embedSpy.mock.calls[0]?.[0] as { model: unknown; headers?: unknown };
    // String aqui = o gateway resolve = plano anônimo = teto. É o defeito.
    expect(
      typeof arg.model,
      "modelo chegou como string: o gateway vai resolver e cair no plano anônimo",
    ).not.toBe("string");
    expect(arg.model).toBeTypeOf("object");
    // Sem gateway não há tenant para observar: headers não fazem sentido.
    expect(arg.headers).toBeUndefined();
  });

  it("COM gateway, mantém a string (é ele quem roteia) e anexa os headers do tenant", async () => {
    chaveMock = () => ({
      apiKey: null,
      baseUrl: null,
      viaGateway: true,
      origem: "gateway_da_instalacao",
      rotulo: null,
      avisos: [],
    });

    await embedText("oi", { organizationId: "org-1" });

    const arg = embedSpy.mock.calls[0]?.[0] as { model: unknown; headers?: Record<string, string> };
    expect(arg.model).toBe("openai/text-embedding-3-small");
    expect(arg.headers?.["X-AI-Gateway-Tenant-Id"]).toBe("org-1");
  });

  it("devolve a contagem de tokens que o SDK reporta", async () => {
    const r = await embedText("oi", { organizationId: "org-1" });
    expect(r.embedding).toHaveLength(1536);
    expect(r.promptTokens).toBe(7);
  });

  it("organização SEM chave nenhuma vira erro tipado, não uma falha genérica", async () => {
    chaveMock = () => null;

    await expect(embedText("oi", { organizationId: "org-1" })).rejects.toBeInstanceOf(
      SemChaveDeEmbeddingError,
    );
    // E não chega a chamar o SDK: falhar depois de gastar a chamada seria pior.
    expect(embedSpy).not.toHaveBeenCalled();
  });

  it("chave já resolvida NÃO é re-resolvida — indexar 200 trechos decifra a credencial uma vez", async () => {
    let resolucoes = 0;
    chaveMock = () => {
      resolucoes++;
      return {
        apiKey: "sk-x",
        baseUrl: null,
        viaGateway: false,
        origem: "credencial_da_organizacao",
        rotulo: "x",
        avisos: [],
      };
    };

    const chave = {
      apiKey: "sk-x",
      baseUrl: null,
      viaGateway: false,
      origem: "credencial_da_organizacao" as const,
      rotulo: "x",
      avisos: [],
    };
    await embedText("a", { organizationId: "org-1", chave });
    await embedText("b", { organizationId: "org-1", chave });

    expect(resolucoes, "a chave passada por parâmetro foi ignorada e re-resolvida").toBe(0);
    expect(embedSpy).toHaveBeenCalledTimes(2);
  });

  it("dimensão diferente do contrato é ERRO — recall quebrado em silêncio é pior", async () => {
    embedSpy.mockResolvedValue({ embedding: [0.1, 0.2], usage: { tokens: 1 } });

    await expect(embedText("oi", { organizationId: "org-1" })).rejects.toThrow(/1536/);
  });

  describe("Tarefa 8: telemetria em llm_calls", () => {
    it("grava com cost_cents SEMPRE nulo, o ponto e os tokens do SDK", async () => {
      await embedText("oi", { organizationId: "org-1", ponto: "embedding_consultar" });

      expect(insertMock).toHaveBeenCalledTimes(1);
      const [tabela, row] = insertMock.mock.calls[0]!;
      expect(tabela).toBe("llm_calls");
      expect(row).toMatchObject({
        organization_id: "org-1",
        purpose: "embedding_consultar",
        provider: "openai",
        input_tokens: 7,
        cost_cents: null,
      });
    });

    it("D-053 item 3 e D-057: cada caminho da chave grava o provedor REAL e a origem no vocabulário de llm_calls", async () => {
      const casos = [
        {
          nome: "credencial da organização, direto na OpenAI",
          chave: { apiKey: "sk-org", baseUrl: null, viaGateway: false, origem: "credencial_da_organizacao" },
          provider: "openai",
          origem: "credencial_da_organizacao",
        },
        {
          nome: "binding do painel com endereço próprio",
          chave: { apiKey: "sk-b", baseUrl: "https://gateway.da-empresa.exemplo/v1", viaGateway: false, origem: "binding_do_ponto" },
          provider: "custom",
          origem: "credencial_da_organizacao",
        },
        {
          nome: "binding do painel sem endereço próprio",
          chave: { apiKey: "sk-b", baseUrl: null, viaGateway: false, origem: "binding_do_ponto" },
          provider: "openai",
          origem: "credencial_da_organizacao",
        },
        {
          nome: "gateway da instalação",
          chave: { apiKey: null, baseUrl: null, viaGateway: true, origem: "gateway_da_instalacao" },
          provider: "gateway",
          origem: "chave_da_instalacao",
        },
        {
          nome: "chave OpenAI da instalação",
          chave: { apiKey: "sk-inst", baseUrl: null, viaGateway: false, origem: "chave_da_instalacao" },
          provider: "openai",
          origem: "chave_da_instalacao",
        },
      ] as const;

      for (const caso of casos) {
        insertMock.mockReset();
        chaveMock = () => ({ ...caso.chave, rotulo: null, avisos: [] });
        await embedText("oi", { organizationId: "org-1" });
        const row = insertMock.mock.calls[0]![1] as Record<string, unknown>;
        expect(row, caso.nome).toMatchObject({
          provider: caso.provider,
          origem_da_chave: caso.origem,
          model: "openai/text-embedding-3-small",
        });
        // O endereço nunca vai para a telemetria: pode levar credencial.
        expect(JSON.stringify(row), caso.nome).not.toContain("gateway.da-empresa");
      }
    });

    it("sem `ponto`, usa o padrão de indexar (mesmo default de resolverChaveDeEmbedding)", async () => {
      await embedText("a", { organizationId: "org-1" });

      const row = insertMock.mock.calls[0]![1] as Record<string, unknown>;
      expect(row.purpose).toBe("embedding_indexar");
    });

    it("o INSERT de telemetria lançando NÃO derruba o embedding: o resultado volta normal", async () => {
      insertDeveLancar = true;

      const r = await embedText("oi", { organizationId: "org-1" });

      expect(r.embedding).toHaveLength(1536);
      expect(r.promptTokens).toBe(7);
    });
  });
});
