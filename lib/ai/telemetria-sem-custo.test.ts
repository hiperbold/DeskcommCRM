/**
 * Tarefa 8 (Frente 2, `hiperbold/planos/fase-F2-tarefas.md`): a função que
 * grava a telemetria dos pontos que hoje escapam de `llm_calls` (embedding,
 * transcrição, leitura de imagem).
 *
 * D-050 (`hiperbold/DEBITO.md`, decisão do Filipe em 23/09/2026, item N12): o
 * comportamento mudou. `cost_cents` NÃO sai mais sempre nulo, embedding e
 * visão passam pelo resolvedor único (`custoCentsComCatalogo`) e ganham custo
 * real quando o catálogo `ai_models` conhece o modelo; só `transcricao_de_audio`
 * continua nula (D-051: o catálogo não precifica por minuto de áudio). O que
 * este arquivo prova agora: os quatro pontos gravam em `llm_calls` com
 * `cost_cents` correto para o caso de cada um; falha ao gravar OU ao ler o
 * catálogo nunca lança (o `catch` do chamador nunca precisa existir); e sem
 * organização conhecida a função nem tenta o INSERT.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

interface LinhaAiModels {
  provider: string;
  model_id: string;
  input_price_per_million_cents: number | null;
  output_price_per_million_cents: number | null;
}

const insertMock = vi.fn();
let insertDeveLancar = false;
let insertDeveDevolverErro = false;
let catalogoLinhas: LinhaAiModels[] = [];
let catalogoDeveFalhar = false;

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      if (tabela === "ai_models") {
        return {
          select: async () => {
            if (catalogoDeveFalhar) return { data: null, error: { message: "conexão com o catálogo recusada" } };
            return { data: catalogoLinhas, error: null };
          },
        };
      }
      return {
        insert: async (row: Record<string, unknown>) => {
          if (insertDeveLancar) throw new Error("conexão com o banco explodiu");
          insertMock(tabela, row);
          if (insertDeveDevolverErro) return { error: { message: "23514: purpose inválido" } };
          return { error: null };
        },
      };
    },
  }),
}));

import { _resetRuntimeCostCacheForTests } from "@/lib/ai/runtime/cost";

import { registrarTelemetriaSemCusto } from "@/lib/ai/telemetria-sem-custo";

beforeEach(() => {
  insertMock.mockReset();
  insertDeveLancar = false;
  insertDeveDevolverErro = false;
  catalogoLinhas = [];
  catalogoDeveFalhar = false;
  _resetRuntimeCostCacheForTests();
});

describe("registrarTelemetriaSemCusto", () => {
  it("embedding ganha cost_cents real quando o catálogo conhece o modelo (D-050, 23/09/2026, N12)", async () => {
    // Antes deste conserto este teste afirmava `cost_cents: null` sempre. A
    // decisão do Filipe (D-050, N12) foi ligar o custo onde o catálogo sabe o
    // preço, este é exatamente esse caso.
    catalogoLinhas = [
      {
        provider: "openai",
        model_id: "text-embedding-3-small",
        input_price_per_million_cents: 2,
        output_price_per_million_cents: 0,
      },
    ];
    await registrarTelemetriaSemCusto({
      organizationId: "org-1",
      purpose: "embedding_indexar",
      provider: "openai",
      model: "openai/text-embedding-3-small",
      inputTokens: 42,
    });

    expect(insertMock).toHaveBeenCalledTimes(1);
    const tabela = insertMock.mock.calls[0]![0] as string;
    const row = insertMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(tabela).toBe("llm_calls");
    expect(row).toMatchObject({
      organization_id: "org-1",
      purpose: "embedding_indexar",
      provider: "openai",
      model: "openai/text-embedding-3-small",
      input_tokens: 42,
      output_tokens: 0,
    });
    // (42 × 2) / 1_000_000 cents, fração pequena, mas NÃO nula.
    expect(row["cost_cents"]).toBeCloseTo(0.000084, 9);
  });

  it("embedding/visão sem preço no catálogo continuam com cost_cents nulo (nunca zero)", async () => {
    catalogoLinhas = [];
    await registrarTelemetriaSemCusto({
      organizationId: "org-1",
      purpose: "visao_de_imagem",
      provider: "openai",
      model: "modelo-ainda-sem-preco-no-catalogo",
      inputTokens: 100,
      outputTokens: 20,
    });

    const row = insertMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(row["cost_cents"]).toBeNull();
  });

  it("falha na leitura do catálogo: cost_cents fica nulo e a gravação segue (não lança)", async () => {
    catalogoDeveFalhar = true;
    await expect(
      registrarTelemetriaSemCusto({
        organizationId: "org-1",
        purpose: "embedding_consultar",
        provider: "openai",
        model: "openai/text-embedding-3-small",
        inputTokens: 10,
      }),
    ).resolves.toBeUndefined();

    const row = insertMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(row["cost_cents"]).toBeNull();
  });

  it("transcrição continua com cost_cents nulo mesmo que o catálogo tenha preço para o modelo (D-051)", async () => {
    // Whisper cobra por MINUTO, não por token, mesmo que `whisper-1` um dia
    // apareça no catálogo por token, este propósito não tem duração medida
    // para multiplicar pela tarifa, então fica nulo por decisão de código, não
    // por falta de dado no catálogo.
    catalogoLinhas = [
      { provider: "openai", model_id: "whisper-1", input_price_per_million_cents: 999, output_price_per_million_cents: 999 },
    ];
    await registrarTelemetriaSemCusto({
      organizationId: "org-1",
      purpose: "transcricao_de_audio",
      provider: "openai",
      model: "whisper-1",
    });

    const row = insertMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(row["cost_cents"]).toBeNull();
  });

  it("tokens ausentes viram zero, nunca undefined", async () => {
    await registrarTelemetriaSemCusto({
      organizationId: "org-1",
      purpose: "transcricao_de_audio",
      provider: "openai",
      model: "whisper-1",
    });

    const row = insertMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(row.input_tokens).toBe(0);
    expect(row.output_tokens).toBe(0);
  });

  it("sem organização conhecida, NÃO grava (não inventa organização)", async () => {
    await registrarTelemetriaSemCusto({
      organizationId: undefined,
      purpose: "visao_de_imagem",
      provider: "openai",
      model: "gpt-5",
    });
    await registrarTelemetriaSemCusto({
      organizationId: null,
      purpose: "visao_de_imagem",
      provider: "openai",
      model: "gpt-5",
    });

    expect(insertMock).not.toHaveBeenCalled();
  });

  it("o banco recusando o INSERT (error) não lança", async () => {
    insertDeveDevolverErro = true;
    await expect(
      registrarTelemetriaSemCusto({
        organizationId: "org-1",
        purpose: "embedding_consultar",
        provider: "openai",
        model: "openai/text-embedding-3-small",
      }),
    ).resolves.toBeUndefined();
  });

  it("o client explodindo (exceção, não `{error}`) não lança", async () => {
    insertDeveLancar = true;

    await expect(
      registrarTelemetriaSemCusto({
        organizationId: "org-1",
        purpose: "embedding_indexar",
        provider: "openai",
        model: "openai/text-embedding-3-small",
      }),
    ).resolves.toBeUndefined();
  });
});
