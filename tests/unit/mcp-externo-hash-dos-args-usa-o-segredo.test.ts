import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { audit } from "@/lib/audit";
import { buildExternalMcpTools } from "@/lib/agent-engine/edge/crm/mcp-externo-tools";
import { montarIdDaFerramenta } from "@/lib/ai/mcp-externo/ids";
import type { FerramentaEmCache } from "@/lib/ai/mcp-externo/tipos";
import type { Logger } from "@/lib/agent-engine/obs/logger";
import { servidorDeTeste } from "./_helpers/servidor-mcp-de-teste";

/**
 * D-038: `args_sha256` era SHA-256 puro, reversível por força bruta quando o
 * argumento tem pouca entropia (telefone, CPF). Agora é HMAC com chave derivada
 * de `INTERNAL_SECRET`. O que se prova aqui é o COMPORTAMENTO: o hash muda com
 * o segredo, é estável para os mesmos argumentos e não é o SHA-256 puro que um
 * atacante com a tabela de auditoria conseguiria recalcular sozinho.
 */
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

// `env` é lido na hora da chamada; o mock deixa o segredo trocável entre os
// casos sem reimportar o módulo. Só `INTERNAL_SECRET` é desviado.
const segredo = vi.hoisted(() => ({ atual: "segredo-do-servidor-A" }));
vi.mock("@/lib/env", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/env")>();
  return {
    ...original,
    env: new Proxy(original.env, {
      get: (alvo, chave, receptor) =>
        chave === "INTERNAL_SECRET" ? segredo.atual : Reflect.get(alvo, chave, receptor),
    }),
  };
});

function fakeLog(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const execCtx = { toolCallId: "test", messages: [], context: undefined };

const escrita: FerramentaEmCache = {
  nome: "cadastrar_visita",
  descricao: "Descrição de cadastrar_visita",
  // `imovel`, e não telefone: `limparArgumentosExternos` retira dado de cliente
  // ANTES do hash, e com telefone todo caso compararia o hash de `{}`.
  input_schema: { type: "object", properties: { imovel: { type: "string" } } },
  somente_leitura: false,
  id: montarIdDaFerramenta("n8n", "cadastrar_visita"),
  recusada: null,
  somente_leitura_confirmado: false,
};

/** Executa a ferramenta de escrita uma vez e devolve o `args_sha256` gravado. */
async function hashGravado(args: Record<string, unknown>): Promise<string> {
  vi.mocked(audit).mockClear();
  const sessao = await servidorDeTeste();
  const carregar = vi.fn(async () => [
    { apelido: "n8n", url: "https://n8n.exemplo.com/mcp", cabecalho: null, ferramentas: [escrita] },
  ]);
  const r = await buildExternalMcpTools(
    {} as never,
    "org-1",
    [escrita.id!],
    fakeLog(),
    {},
    { abrir: vi.fn(async () => sessao), carregar },
  );
  await r.tools[escrita.id!]!.execute!(args, execCtx);
  await r.cleanup();
  const chamada = vi.mocked(audit).mock.calls[0]![0] as unknown as { metadata: { args_sha256: string } };
  return chamada.metadata.args_sha256;
}

describe("D-038: args_sha256 depende do segredo do servidor", () => {
  beforeEach(() => {
    segredo.atual = "segredo-do-servidor-A";
  });

  it("os mesmos argumentos com o MESMO segredo dão o mesmo hash", async () => {
    const um = await hashGravado({ imovel: "apto-101" });
    const dois = await hashGravado({ imovel: "apto-101" });
    expect(um).toMatch(/^[0-9a-f]{64}$/);
    expect(dois).toBe(um);
  });

  it("argumentos diferentes com o MESMO segredo dão hashes diferentes", async () => {
    const um = await hashGravado({ imovel: "apto-101" });
    const outro = await hashGravado({ imovel: "casa-7" });
    expect(outro).toMatch(/^[0-9a-f]{64}$/);
    expect(outro).not.toBe(um);
  });

  it("os mesmos argumentos com OUTRO segredo dão outro hash", async () => {
    const comA = await hashGravado({ imovel: "apto-101" });
    segredo.atual = "segredo-do-servidor-B";
    const comB = await hashGravado({ imovel: "apto-101" });
    expect(comB).toMatch(/^[0-9a-f]{64}$/);
    expect(comB).not.toBe(comA);
  });

  it("não é o SHA-256 puro dos argumentos: quem só lê a tabela não recalcula o hash do argumento", async () => {
    const args = { imovel: "apto-101" };
    const puro = createHash("sha256").update(JSON.stringify(args)).digest("hex");
    expect(await hashGravado(args)).not.toBe(puro);
  });
});
