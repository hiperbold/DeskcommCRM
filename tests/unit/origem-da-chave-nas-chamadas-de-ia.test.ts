/**
 * D-057 (carteira de tokens): a origem REAL da chave chega em `llm_calls`.
 *
 * A carteira só debita chamada com `origem_da_chave = 'chave_da_instalacao'`
 * (nulo não debita, para nunca cobrar do cliente o que ele pagou com a própria
 * chave). Este arquivo prende os elos que faltavam: `logInvocation` grava a
 * origem que recebe (e nula quando não recebe), o resolvedor de modelo dos dois
 * workers antigos diz de quem é a chave, e o embedding traduz o seu vocabulário
 * de origem para o de `llm_calls`. Os pontos que já gravavam (seam do agente,
 * visão e transcrição) têm teste em `midia-base-url-do-binding.test.ts` e
 * `run-model-call`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const inserts: Array<Record<string, unknown>> = [];

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      insert: (row: Record<string, unknown>) => {
        inserts.push(row);
        return Promise.resolve({ error: null });
      },
    }),
  }),
}));

const { logInvocation } = await import("@/lib/ai/log-invocation");
const { origemDaChaveDoModelo } = await import("@/lib/ai/origem-da-chave-do-modelo");
const { origemDaChaveParaLlmCalls, provedorDoEmbedding } = await import("@/lib/ai/embeddings/chave");
const { modeloRealDaChamada } = await import("@/lib/ai/telemetria-sem-custo");

async function drenar(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

const BASE = {
  organization_id: "11111111-1111-4111-8111-111111111111",
  agent_id: null,
  conversation_id: null,
  message_id: null,
  invocation_kind: "sentiment_classify" as const,
  model: "anthropic/claude-haiku-4-5",
  prompt_tokens: 100,
  completion_tokens: 10,
  latency_ms: 200,
  cost_cents: 1,
};

describe("logInvocation grava a origem da chave", () => {
  beforeEach(() => {
    inserts.length = 0;
  });

  it("grava chave_da_instalacao e credencial_da_organizacao como vieram", async () => {
    logInvocation({ ...BASE, origem_da_chave: "chave_da_instalacao" });
    logInvocation({ ...BASE, origem_da_chave: "credencial_da_organizacao" });
    await drenar();
    expect(inserts.map((i) => i["origem_da_chave"])).toEqual(["chave_da_instalacao", "credencial_da_organizacao"]);
  });

  it("sem origem (o Jev, que não passa nada) grava NULO, que não debita a carteira", async () => {
    logInvocation({ ...BASE, model: "typesafe/jev-1.13.0", provider: "typesafe" });
    logInvocation({ ...BASE, origem_da_chave: null });
    await drenar();
    expect(inserts.map((i) => i["origem_da_chave"])).toEqual([null, null]);
  });
});

describe("origem da chave do resolvedor de modelo dos workers antigos", () => {
  it("binding e credencial cadastrada são do CLIENTE (não debitam); o padrão do .env é da instalação (debita)", () => {
    expect(origemDaChaveDoModelo("binding")).toBe("credencial_da_organizacao");
    expect(origemDaChaveDoModelo("credencial_da_organizacao")).toBe("credencial_da_organizacao");
    expect(origemDaChaveDoModelo("padrao")).toBe("chave_da_instalacao");
  });
});

describe("origem da chave do embedding no vocabulário de llm_calls", () => {
  it("as quatro origens da escada de embedding têm tradução, e só as do .env são da instalação", () => {
    expect(origemDaChaveParaLlmCalls("binding_do_ponto")).toBe("credencial_da_organizacao");
    expect(origemDaChaveParaLlmCalls("credencial_da_organizacao")).toBe("credencial_da_organizacao");
    expect(origemDaChaveParaLlmCalls("gateway_da_instalacao")).toBe("chave_da_instalacao");
    expect(origemDaChaveParaLlmCalls("chave_da_instalacao")).toBe("chave_da_instalacao");
  });
});

describe("D-053 item 3: provedor e modelo reais", () => {
  it("o provedor do embedding é o caminho real: gateway, endereço próprio ou OpenAI direto", () => {
    expect(provedorDoEmbedding({ viaGateway: true, baseUrl: null })).toBe("gateway");
    expect(provedorDoEmbedding({ viaGateway: true, baseUrl: "https://x.exemplo/v1" })).toBe("gateway");
    expect(provedorDoEmbedding({ viaGateway: false, baseUrl: "https://x.exemplo/v1" })).toBe("custom");
    expect(provedorDoEmbedding({ viaGateway: false, baseUrl: null })).toBe("openai");
  });

  it("o modelo da visão nunca sai vazio: configurado, senão o que o provedor devolveu, senão `desconhecido`", () => {
    expect(modeloRealDaChamada("gpt-5", "gpt-5-2026-01-01")).toBe("gpt-5");
    expect(modeloRealDaChamada(null, "gpt-5-2026-01-01")).toBe("gpt-5-2026-01-01");
    expect(modeloRealDaChamada("", "gpt-5-2026-01-01")).toBe("gpt-5-2026-01-01");
    expect(modeloRealDaChamada("  ", undefined)).toBe("desconhecido");
    expect(modeloRealDaChamada(undefined, undefined)).toBe("desconhecido");
    // Id devolvido por endereço próprio do cliente não entra sem teto.
    expect(modeloRealDaChamada(null, "x".repeat(5000))).toHaveLength(200);
  });
});

describe("os pontos de log do worker de resposta legado levam a origem", () => {
  // O worker legado hoje pula antes de chamar o modelo (motor retirado), então
  // o caminho não é alcançável por teste de comportamento; a cerca lê o texto:
  // toda chamada de logInvocation que usa o modelo RESOLVIDO tem de levar a
  // origem que o resolvedor disse.
  it("todo logInvocation com `resolvido.modelId` traz origem_da_chave: origemDaChaveDoModelo(resolvido.origem)", () => {
    const fonte = readFileSync(join(process.cwd(), "workers/ai-response-worker.ts"), "utf8");
    const blocos = fonte.split("logInvocation({").slice(1).map((b) => b.slice(0, b.indexOf("});")));
    const doResolvido = blocos.filter((b) => b.includes("model: resolvido.modelId"));
    expect(doResolvido.length).toBe(3);
    for (const b of doResolvido) {
      expect(b).toContain("origem_da_chave: origemDaChaveDoModelo(resolvido.origem)");
    }
  });

  it("no worker de sentimento, só as linhas do modelo resolvido levam origem; as do Jev (typesafe) ficam nulas", () => {
    const fonte = readFileSync(join(process.cwd(), "workers/ai-sentiment-worker.ts"), "utf8");
    const blocos = fonte.split("logInvocation({").slice(1).map((b) => b.slice(0, b.indexOf("});")));
    const doResolvido = blocos.filter((b) => b.includes("model: resolvido.modelId"));
    const doJev = blocos.filter((b) => b.includes('provider: "typesafe"'));
    expect(doResolvido.length).toBe(2);
    expect(doJev.length).toBe(2);
    for (const b of doResolvido) expect(b).toContain("origem_da_chave: origemDaChaveDoModelo(resolvido.origem)");
    for (const b of doJev) expect(b).not.toContain("origem_da_chave");
  });
});
