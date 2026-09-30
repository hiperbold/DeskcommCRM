/**
 * O ENDEREÇO QUE A EMPRESA ESCOLHEU NÃO ALCANÇA A REDE INTERNA NA HORA DA CHAMADA.
 *
 * `ai_purpose_bindings.base_url` é gravado pelo admin de UMA organização, e o
 * servidor chama esse endereço com a chave dela. Só o provedor personalizado
 * passava pela régua de destino (`fetchParaDestinoDaOrganizacao`, decisão
 * 22-d); o embedding e os provedores openrouter, deepseek e requesty (pilha
 * antiga `gateway-binding` e registry do agent-engine) usavam o fetch padrão.
 * Um endereço gravado antes da recusa na rota, escrito direto pelo PostgREST ou
 * um nome que passou a resolver para IP interno depois de aceito chegaria lá.
 *
 * Cada caso mede o DESTINO REAL: `fetch` global interceptado, SDK real no
 * caminho, e a asserção é que NENHUMA requisição saiu para o endereço interno.
 * Os controles positivos provam que a recusa não é "tudo falha": o endereço
 * público sai, e o endereço que vem do `.env` da instalação NÃO passa pela
 * régua (a instalação pode legitimamente usar um serviço interno).
 */
import { generateText } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// O DNS é controlado: a régua resolve o nome antes de a chave sair, e o teste
// não pode depender da rede de quem roda. Nome fora do mapa resolve para IP
// público; `db` imita um serviço do compose.
const dns = vi.hoisted(() => ({
  mapa: { db: "172.18.0.5" } as Record<string, string>,
}));
vi.mock("node:dns/promises", () => {
  const lookup = vi.fn(async (nome: string) => [{ address: dns.mapa[nome] ?? "93.184.216.34", family: 4 }]);
  return { lookup, default: { lookup } };
});

const bindings = vi.hoisted(() => ({ linha: null as Record<string, unknown> | null }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      const linha =
        tabela === "ai_purpose_bindings"
          ? bindings.linha
          : { api_key_encrypted: "x", api_key_iv: "y", api_key_tag: "z" };
      const chain = {
        select: () => chain,
        eq: () => chain,
        not: () => chain,
        maybeSingle: async () => ({ data: linha }),
      };
      return chain;
    },
  }),
}));
vi.mock("@/lib/crypto/aes_gcm", () => ({
  decryptKey: () => "chave-decifrada-da-organizacao",
  byteaToBuffer: (v: unknown) => v,
}));
// Telemetria grava em `llm_calls`; o assunto deste arquivo é o destino da rede.
vi.mock("@/lib/ai/telemetria-sem-custo", () => ({
  registrarTelemetriaSemCusto: vi.fn(async () => undefined),
}));

import { createDefaultRegistry } from "@/lib/agent-engine/edge/llm/providers";
import { embedText } from "@/lib/ai/embed";
import type { ChaveDeEmbedding } from "@/lib/ai/embeddings/chave";
import { resolverModeloDoPonto } from "@/lib/ai/gateway-binding";

const ORG = "33333333-3333-4333-8333-333333333333";

const EMBEDDING_OK = {
  object: "list",
  data: [{ object: "embedding", index: 0, embedding: Array.from({ length: 1536 }, (_, i) => i / 1536) }],
  model: "text-embedding-3-small",
  usage: { prompt_tokens: 3, total_tokens: 3 },
};
const CHAT_OK = {
  id: "c1",
  object: "chat.completion",
  created: 1,
  model: "m",
  choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

let espiao: ReturnType<typeof vi.fn>;

/** Devolve o que a API responderia, conforme o caminho pedido. */
function respostaDaApi(input: unknown): Response {
  const url = typeof input === "string" || input instanceof URL ? String(input) : (input as Request).url;
  const corpo = url.includes("/embeddings") ? EMBEDDING_OK : CHAT_OK;
  return new Response(JSON.stringify(corpo), { status: 200, headers: { "content-type": "application/json" } });
}

/** Hosts que receberam requisição. */
function hostsAlcancados(): string[] {
  return espiao.mock.calls.map(([input]) => {
    const url = typeof input === "string" || input instanceof URL ? String(input) : (input as Request).url;
    return new URL(url).host;
  });
}

beforeEach(() => {
  espiao = vi.fn(async (input: unknown) => respostaDaApi(input));
  vi.stubGlobal("fetch", espiao);
  bindings.linha = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

/**
 * Nos controles positivos o que se mede é QUEM recebeu a requisição. O corpo
 * de resposta do stub não precisa casar com o formato de cada API (a DeepSeek,
 * por exemplo, fala Responses aqui), então um erro de leitura da resposta não
 * conta: a recusa da régua de destino (mensagem "unsafe_url:...") ainda
 * falha o teste.
 */
async function chamarIgnorandoOFormatoDaResposta(model: Parameters<typeof generateText>[0]["model"]): Promise<void> {
  try {
    await generateText({ model, prompt: "oi", maxRetries: 0 });
  } catch (erro) {
    if (/unsafe_url:/.test(String(erro instanceof Error ? erro.message : erro))) throw erro;
  }
}

function chaveDoBinding(baseUrl: string | null): ChaveDeEmbedding {
  return {
    apiKey: "sk-da-organizacao",
    baseUrl,
    viaGateway: false,
    origem: "binding_do_ponto",
    rotulo: "Chave da empresa",
    avisos: [],
  };
}

describe("embedding: base_url do binding da organização", () => {
  it.each([
    ["metadados de nuvem", "http://169.254.169.254/v1"],
    ["localhost", "http://localhost:3000/v1"],
    ["rede privada", "http://10.0.0.5/v1"],
    ["serviço do compose", "http://db:5432/v1"],
  ])("recusa %s SEM sair requisição", async (_rotulo, endereco) => {
    await expect(
      embedText("texto", { organizationId: ORG, chave: chaveDoBinding(endereco) }),
    ).rejects.toThrow(/unsafe_url:/);
    expect(espiao, "a chave da empresa saiu para a rede interna").not.toHaveBeenCalled();
  });

  it("endereço público sai normalmente (controle positivo)", async () => {
    const r = await embedText("texto", { organizationId: ORG, chave: chaveDoBinding("https://gateway.exemplo/v1") });
    expect(r.embedding).toHaveLength(1536);
    expect(hostsAlcancados()).toEqual(["gateway.exemplo"]);
  });

  it("sem base_url (chave da organização ou da instalação) vai para a OpenAI, como antes", async () => {
    const r = await embedText("texto", {
      organizationId: ORG,
      chave: { ...chaveDoBinding(null), origem: "chave_da_instalacao", apiKey: "sk-da-instalacao" },
    });
    expect(r.embedding).toHaveLength(1536);
    expect(hostsAlcancados()).toEqual(["api.openai.com"]);
  });
});

describe("pilha antiga (gateway-binding): openrouter, deepseek e requesty com base_url do binding", () => {
  async function modeloDoBinding(provider: string, baseUrl: string | null) {
    bindings.linha = { provider, credential_id: "cred-1", model_id: "modelo-x", base_url: baseUrl };
    const r = await resolverModeloDoPonto("sentiment_classify", ORG, "anthropic/claude-haiku-4-5");
    expect(r?.origem).toBe("binding");
    return r!.model;
  }

  it.each(["openrouter", "deepseek", "requesty"])(
    "%s com base_url interno falha SEM sair requisição",
    async (provider) => {
      const model = await modeloDoBinding(provider, "http://169.254.169.254/v1");
      await expect(generateText({ model, prompt: "oi", maxRetries: 0 })).rejects.toThrow(/unsafe_url:/);
      expect(espiao, "a chave da empresa saiu para a rede interna").not.toHaveBeenCalled();
    },
  );

  it.each(["openrouter", "deepseek", "requesty"])(
    "%s com base_url do serviço do compose também falha SEM sair requisição",
    async (provider) => {
      const model = await modeloDoBinding(provider, "http://db:5432/v1");
      await expect(generateText({ model, prompt: "oi", maxRetries: 0 })).rejects.toThrow(/unsafe_url:/);
      expect(espiao).not.toHaveBeenCalled();
    },
  );

  it.each(["openrouter", "deepseek", "requesty"])(
    "%s com base_url público sai para esse endereço (controle positivo)",
    async (provider) => {
      const model = await modeloDoBinding(provider, "https://gateway.exemplo/v1");
      await chamarIgnorandoOFormatoDaResposta(model);
      expect(hostsAlcancados()).toEqual(["gateway.exemplo"]);
    },
  );

  it("sem base_url, o endpoint canônico do provedor segue sem a régua", async () => {
    const model = await modeloDoBinding("openrouter", null);
    await chamarIgnorandoOFormatoDaResposta(model);
    expect(hostsAlcancados()).toEqual(["openrouter.ai"]);
  });
});

describe("registry do agent-engine: openrouter, deepseek e requesty com base_url do binding", () => {
  const registry = createDefaultRegistry();

  it.each(["openrouter", "deepseek", "requesty"])(
    "%s com base_url interno falha SEM sair requisição",
    async (provider) => {
      for (const endereco of ["http://169.254.169.254/v1", "http://127.0.0.1:4000/v1", "http://db:5432/v1"]) {
        const model = registry[provider]!("sk-x", "modelo-x", endereco);
        await expect(generateText({ model, prompt: "oi", maxRetries: 0 })).rejects.toThrow(/unsafe_url:/);
      }
      expect(espiao, "a chave da empresa saiu para a rede interna").not.toHaveBeenCalled();
    },
  );

  it.each(["openrouter", "deepseek", "requesty"])(
    "%s com base_url público sai para esse endereço, que a allowlist do egress já libera",
    async (provider) => {
      const model = registry[provider]!("sk-x", "modelo-x", "https://gateway.exemplo/v1");
      await chamarIgnorandoOFormatoDaResposta(model);
      expect(hostsAlcancados()).toEqual(["gateway.exemplo"]);
    },
  );

  it("endereço do .env da instalação (OPENROUTER_BASE_URL interno) NÃO passa pela régua", async () => {
    // A instalação pode legitimamente rodar um roteador na rede interna: esse
    // endereço não é escolha de empresa, e a allowlist do egress (que o inclui)
    // continua sendo o único controle dele.
    vi.stubEnv("OPENROUTER_BASE_URL", "http://10.9.9.9:4000/v1");
    vi.resetModules();
    const { createDefaultRegistry: novoRegistry } = await import("@/lib/agent-engine/edge/llm/providers");

    const model = novoRegistry().openrouter!("sk-da-instalacao", "modelo-x");
    await chamarIgnorandoOFormatoDaResposta(model);
    expect(hostsAlcancados()).toEqual(["10.9.9.9:4000"]);
  });
});
