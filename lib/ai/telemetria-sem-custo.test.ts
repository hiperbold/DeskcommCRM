/**
 * Tarefa 8 (Frente 2, `hiperbold/planos/fase-F2-tarefas.md`): a função que
 * grava a telemetria dos pontos que hoje escapam de `llm_calls` (embedding,
 * transcrição, leitura de imagem).
 *
 * O que se prova: `cost_cents` sai SEMPRE nulo (D-050: ligar o custo ligaria
 * o orçamento de IA, cego para esses consumos); uma falha ao gravar nunca
 * lança (o `catch` do chamador nunca precisa existir); e sem organização
 * conhecida a função nem tenta o INSERT.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const insertMock = vi.fn();
let insertDeveLancar = false;
let insertDeveDevolverErro = false;

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => ({
      insert: async (row: Record<string, unknown>) => {
        if (insertDeveLancar) throw new Error("conexão com o banco explodiu");
        insertMock(tabela, row);
        if (insertDeveDevolverErro) return { error: { message: "23514: purpose inválido" } };
        return { error: null };
      },
    }),
  }),
}));

import { registrarTelemetriaSemCusto } from "@/lib/ai/telemetria-sem-custo";

beforeEach(() => {
  insertMock.mockReset();
  insertDeveLancar = false;
  insertDeveDevolverErro = false;
});

describe("registrarTelemetriaSemCusto", () => {
  it("grava em llm_calls com cost_cents SEMPRE nulo e os campos certos", async () => {
    await registrarTelemetriaSemCusto({
      organizationId: "org-1",
      purpose: "embedding_indexar",
      provider: "openai",
      model: "openai/text-embedding-3-small",
      inputTokens: 42,
    });

    expect(insertMock).toHaveBeenCalledTimes(1);
    const [tabela, row] = insertMock.mock.calls[0]!;
    expect(tabela).toBe("llm_calls");
    expect(row).toMatchObject({
      organization_id: "org-1",
      purpose: "embedding_indexar",
      provider: "openai",
      model: "openai/text-embedding-3-small",
      input_tokens: 42,
      output_tokens: 0,
      cost_cents: null,
    });
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
