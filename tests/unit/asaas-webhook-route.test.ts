// @vitest-environment node
//
// POST /api/v1/webhooks/asaas - fase F5, Tarefa 12, decisão 19, correção M6.
//
// Mesmo padrão de `tests/unit/asaas-config.test.ts`: `env` (lib/env.ts) é
// congelado na IMPORTAÇÃO do módulo, então toda variação de
// ASAAS_WEBHOOK_TOKEN/ASAAS_ENABLED/ASAAS_BASE_URL/ASAAS_API_KEY troca a
// variável ANTES de importar, com `vi.resetModules()`. `createAdminClient` e
// `logger` são dublados: nenhum teste aqui fala com um Supabase de verdade
// nem imprime no console de verdade.
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const ORIGINAL = { ...process.env };
const URL_WEBHOOK = "http://localhost/api/v1/webhooks/asaas";
const TOKEN = "token-secreto-de-teste-com-32-chars!!";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
type LogFn = (msg: string, ctx?: Record<string, unknown>) => void;
vi.mock("@/lib/logger", () => ({
  logger: {
    info: vi.fn<LogFn>(),
    warn: vi.fn<LogFn>(),
    error: vi.fn<LogFn>(),
    debug: vi.fn<LogFn>(),
  },
}));

afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.resetModules();
  vi.restoreAllMocks();
  // `vi.resetModules()` troca o MÓDULO importado a seguir, mas o objeto
  // `logger` dublado (retornado pela factory de `vi.mock`) é reutilizado
  // entre reimportações dentro do mesmo arquivo de teste: sem isto, a
  // contagem de chamadas de `logger.info`/`logger.error` acumula de um teste
  // para o outro.
  vi.clearAllMocks();
});

type RpcResultado =
  | { data: { novo: boolean; event_id: string; resultado: string; quarentena: boolean }; error: null }
  | { data: null; error: { message: string } };

/**
 * Reimporta a rota do zero com o ambiente indicado (padrão: token válido
 * configurado, ASAAS_ENABLED desligado - o estado de toda instalação desta
 * fase) e o admin client dublado devolvendo `rpcResultado` de
 * `fn_billing_asaas_registrar_evento`.
 */
async function montarRota(opts: {
  vars?: Record<string, string>;
  rpcResultado?: RpcResultado;
}) {
  vi.resetModules();
  const vars: Record<string, string> = {
    ASAAS_ENABLED: "false",
    ASAAS_BASE_URL: "",
    ASAAS_API_KEY: "",
    ASAAS_WEBHOOK_TOKEN: TOKEN,
    ASAAS_WEBHOOK_ID: "",
    ...opts.vars,
  };
  for (const [k, v] of Object.entries(vars)) process.env[k] = v;

  const rpc = vi.fn(
    async (_nome: string, _args?: Record<string, unknown>) =>
      opts.rpcResultado ?? {
        data: { novo: true, event_id: "evt_padrao", resultado: "aguardando", quarentena: false },
        error: null,
      },
  );
  const { createAdminClient } = await import("@/lib/supabase/admin");
  vi.mocked(createAdminClient).mockReturnValue({ rpc } as never);

  const { logger } = await import("@/lib/logger");
  const { POST } = await import("@/app/api/v1/webhooks/asaas/route");

  return { POST, rpc, logger: vi.mocked(logger) };
}

function req(opts: {
  token?: string | null;
  body?: string;
  headers?: Record<string, string>;
  stream?: ReadableStream<Uint8Array>;
}) {
  const headers: Record<string, string> = { "content-type": "application/json", ...opts.headers };
  if (opts.token !== undefined && opts.token !== null) headers["asaas-access-token"] = opts.token;

  const init: RequestInit & { duplex?: "half" } = { method: "POST", headers };
  if (opts.stream) {
    init.body = opts.stream;
    init.duplex = "half";
  } else {
    init.body = opts.body ?? JSON.stringify({ id: "evt_1", event: "PAYMENT_CREATED" });
  }
  return new NextRequest(URL_WEBHOOK, init as unknown as ConstructorParameters<typeof NextRequest>[1]);
}

const ENVELOPE_VALIDO = JSON.stringify({
  id: "evt_pagamento_confirmado",
  event: "PAYMENT_CONFIRMED",
  payment: {
    id: "pay_abc123",
    customer: "cus_abc123",
    status: "CONFIRMED",
    billingType: "CREDIT_CARD",
    value: 199.9,
    dueDate: "2026-01-05",
  },
});

// ─── Token: ausente no ambiente, errado, de outro tamanho, sem cabeçalho ───

describe("POST /api/v1/webhooks/asaas - autenticação (decisão 19, risco 2)", () => {
  it("ASAAS_WEBHOOK_TOKEN ausente no ambiente -> 401, mesmo com cabeçalho presente (falha fechada)", async () => {
    const { POST, rpc } = await montarRota({ vars: { ASAAS_WEBHOOK_TOKEN: "" } });
    const res = await POST(req({ token: "qualquer-coisa" }));
    expect(res.status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("token errado -> 401, sem chamar o banco", async () => {
    const { POST, rpc } = await montarRota({});
    const res = await POST(req({ token: "token-errado-do-mesmo-tamanho!!" }));
    expect(res.status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("token de outro tamanho -> 401 (timingSafeStringEqual não vaza tamanho)", async () => {
    const { POST, rpc } = await montarRota({});
    const res = await POST(req({ token: "curto" }));
    expect(res.status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("cabeçalho asaas-access-token ausente -> 401", async () => {
    const { POST, rpc } = await montarRota({});
    const res = await POST(req({ token: null }));
    expect(res.status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("nenhum outro cabeçalho é aceito (Authorization: Bearer não autentica)", async () => {
    const { POST, rpc } = await montarRota({});
    const res = await POST(req({ token: null, headers: { authorization: `Bearer ${TOKEN}` } }));
    expect(res.status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });
});

// ─── Teto de 64 KB: por Content-Length e por fluxo real ────────────────────

describe("POST /api/v1/webhooks/asaas - teto de 64 KB (decisão 19)", () => {
  it("413 pelo Content-Length declarado, antes de ler o corpo", async () => {
    const { POST, rpc } = await montarRota({});
    const grande = await POST(
      req({ token: TOKEN, body: ENVELOPE_VALIDO, headers: { "content-length": "999999" } }),
    );
    expect(grande.status).toBe(413);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("413 pelo fluxo real, quando o Content-Length declarado mente (ausente/pequeno)", async () => {
    const { POST, rpc } = await montarRota({});
    const enc = new TextEncoder();
    const pedaco = enc.encode("a".repeat(20_000));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // 4 pedaços de 20.000 bytes = 80.000 bytes, acima do teto de 64 KB,
        // sem nenhum Content-Length declarado.
        controller.enqueue(pedaco);
        controller.enqueue(pedaco);
        controller.enqueue(pedaco);
        controller.enqueue(pedaco);
        controller.close();
      },
    });
    const res = await POST(req({ token: TOKEN, stream }));
    expect(res.status).toBe(413);
    expect(rpc).not.toHaveBeenCalled();
  });
});

// ─── JSON inválido / sem id-event: quarentena pelo banco, sempre 200 (M6) ──

describe("POST /api/v1/webhooks/asaas - corpo fora do formato, autenticado (M6)", () => {
  it("JSON inválido com token certo: registra (id/event nulos) e responde 200 exato", async () => {
    const { POST, rpc } = await montarRota({
      rpcResultado: {
        data: { novo: true, event_id: "quarentena:abc", resultado: "erro", quarentena: true },
        error: null,
      },
    });
    const res = await POST(req({ token: TOKEN, body: "isto não é json{{{" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ recebido: true });
    expect(rpc).toHaveBeenCalledTimes(1);
    const chamada = rpc.mock.calls[0]![1] as Record<string, unknown>;
    expect(chamada.p_event_id).toBeNull();
    expect(chamada.p_event_type).toBeNull();
    expect(chamada.p_origem).toBe("webhook");
  });

  it("JSON válido mas sem id/event: mesmo caminho de quarentena, 200 exato", async () => {
    const { POST, rpc } = await montarRota({
      rpcResultado: {
        data: { novo: true, event_id: "quarentena:def", resultado: "erro", quarentena: true },
        error: null,
      },
    });
    const res = await POST(req({ token: TOKEN, body: JSON.stringify({ foo: "bar" }) }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ recebido: true });
    const chamada = rpc.mock.calls[0]![1] as Record<string, unknown>;
    expect(chamada.p_event_id).toBeNull();
    expect(chamada.p_event_type).toBeNull();
  });
});

// ─── 200 exato, idêntico para evento novo e repetido ───────────────────────

describe("POST /api/v1/webhooks/asaas - resposta (decisão 19)", () => {
  it("200 com {recebido:true} para evento novo", async () => {
    const { POST } = await montarRota({
      rpcResultado: {
        data: { novo: true, event_id: "evt_pagamento_confirmado", resultado: "aguardando", quarentena: false },
        error: null,
      },
    });
    const res = await POST(req({ token: TOKEN, body: ENVELOPE_VALIDO }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ recebido: true });
  });

  it("200 com o MESMO corpo para evento repetido (novo:false)", async () => {
    const { POST } = await montarRota({
      rpcResultado: {
        data: { novo: false, event_id: "evt_pagamento_confirmado", resultado: "ja_aplicado", quarentena: false },
        error: null,
      },
    });
    const res = await POST(req({ token: TOKEN, body: ENVELOPE_VALIDO }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ recebido: true });
  });

  it("resposta nunca ecoa nada do corpo recebido", async () => {
    const { POST } = await montarRota({});
    const res = await POST(
      req({
        token: TOKEN,
        body: JSON.stringify({
          id: "evt_x",
          event: "PAYMENT_CONFIRMED",
          externalReference: "segredo-do-pedido-nao-pode-ecoar",
        }),
      }),
    );
    const body = await res.json();
    expect(body).toEqual({ recebido: true });
    expect(JSON.stringify(body)).not.toContain("segredo-do-pedido-nao-pode-ecoar");
  });

  it("500 genérico quando o banco não consegue guardar o evento", async () => {
    const { POST, logger } = await montarRota({
      rpcResultado: { data: null, error: { message: "conexão recusada com o banco" } },
    });
    const res = await POST(req({ token: TOKEN, body: ENVELOPE_VALIDO }));
    expect(res.status).toBe(500);
    const texto = await res.text();
    expect(texto).toBe("");
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});

// ─── Sanitização em profundidade (integração com sanitizar.ts) ────────────

describe("POST /api/v1/webhooks/asaas - sanitização do payload (decisão 19)", () => {
  it("remove creditCard e qualquer chave com 'card' no nome, em qualquer profundidade, antes de guardar", async () => {
    const { POST, rpc } = await montarRota({});
    const corpo = {
      id: "evt_com_cartao",
      event: "PAYMENT_CONFIRMED",
      payment: {
        id: "pay_abc123",
        customer: "cus_abc123",
        status: "CONFIRMED",
        billingType: "CREDIT_CARD",
        value: 100,
        dueDate: "2026-01-05",
        creditCard: { number: "4111111111111111" },
        creditCardToken: "tok_secreto",
        creditCardHolderInfo: { cpfCnpj: "12345678900" },
        nested: { anotherCardField: "4111", ok: "fica" },
      },
    };
    const res = await POST(req({ token: TOKEN, body: JSON.stringify(corpo) }));
    expect(res.status).toBe(200);
    const chamada = rpc.mock.calls[0]![1] as Record<string, unknown>;
    const payloadEnviado = JSON.stringify(chamada.p_payload);
    expect(payloadEnviado).not.toContain("4111111111111111");
    expect(payloadEnviado).not.toContain("tok_secreto");
    expect(payloadEnviado).not.toContain("12345678900");
    expect(payloadEnviado).not.toContain("creditCard");
    expect(payloadEnviado).not.toContain("anotherCardField");
    expect(payloadEnviado).toContain("fica");
  });
});

// ─── Log: só requestId, tipo, event_id e novo - nunca token/corpo/CPF ─────

describe("POST /api/v1/webhooks/asaas - log (restrição fixa 4, risco 2/3)", () => {
  it("log de sucesso não contém o token nem o corpo recebido", async () => {
    const { POST, logger } = await montarRota({
      rpcResultado: {
        data: { novo: true, event_id: "evt_pagamento_confirmado", resultado: "aguardando", quarentena: false },
        error: null,
      },
    });
    await POST(req({ token: TOKEN, body: ENVELOPE_VALIDO }));
    expect(logger.info).toHaveBeenCalledTimes(1);
    const [, contexto] = logger.info.mock.calls[0]!;
    const serializado = JSON.stringify(contexto);
    expect(serializado).not.toContain(TOKEN);
    expect(serializado).not.toContain("199.9");
    expect(contexto).not.toHaveProperty("payload");
    expect(contexto).toMatchObject({
      event_type: "PAYMENT_CONFIRMED",
      event_id: "evt_pagamento_confirmado",
      novo: true,
    });
  });

  it("log de falha (500) não contém o token nem o corpo recebido", async () => {
    const { POST, logger } = await montarRota({
      rpcResultado: { data: null, error: { message: "conexão recusada com o banco" } },
    });
    await POST(req({ token: TOKEN, body: ENVELOPE_VALIDO }));
    const [, contexto] = logger.error.mock.calls[0]!;
    const serializado = JSON.stringify(contexto);
    expect(serializado).not.toContain(TOKEN);
    expect(serializado).not.toContain("199.9");
    expect(contexto).not.toHaveProperty("payload");
  });
});
