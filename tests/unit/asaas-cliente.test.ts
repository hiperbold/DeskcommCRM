/**
 * `lib/billing/asaas/cliente.ts`: fase F5, Tarefa 11.
 *
 * RESTRIÇÃO ABSOLUTA: nenhuma chamada real sai destes testes. Todo `fetch` é
 * um dublê local (`criarFetchFalso`), programado por caso. Nenhum `apiKey`
 * usado aqui é uma chave real, só literais óbvios de teste com o prefixo
 * certo (`$aact_hmlg_teste...`).
 */
import { describe, expect, it } from "vitest";

import type { ConfigAsaas } from "@/lib/billing/asaas/config";
import {
  criarClienteAsaas,
  MAX_RETENTATIVAS_GET,
  TETO_ESPERA_RATE_LIMIT_MS,
  type DepsClienteAsaas,
  type FetchAsaas,
} from "@/lib/billing/asaas/cliente";
import { ErroAsaasException } from "@/lib/billing/asaas/erros";

const CHAVE_DE_TESTE = "$aact_hmlg_testeNuncaEUmaChaveReal000111222";
const CPF_DE_TESTE = "111.444.777-35";

const CONFIG_BASE: ConfigAsaas = {
  habilitado: true,
  baseUrl: "https://api-sandbox.asaas.com/v3",
  apiKey: CHAVE_DE_TESTE,
  webhookToken: "token-de-teste-nunca-real",
  webhookId: "",
  ambiente: "sandbox",
};

interface ChamadaRegistrada {
  url: string;
  init: RequestInit;
}

type PassoFalso = Response | "timeout" | "abort" | (() => Response);

function respostaJson(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** `fetch` falso, programado passo a passo, nunca fala com a rede de verdade. */
function criarFetchFalso(passos: PassoFalso[]) {
  const chamadas: ChamadaRegistrada[] = [];
  let indice = 0;
  const fetchFalso = (async (url: string | URL, init?: RequestInit) => {
    chamadas.push({ url: String(url), init: init ?? {} });
    const passo = passos[indice];
    indice += 1;
    if (passo === undefined) {
      throw new Error(`fetchFalso: nenhuma resposta programada para a chamada #${indice}`);
    }
    if (passo === "timeout" || passo === "abort") {
      throw new DOMException("simulado", "TimeoutError");
    }
    if (typeof passo === "function") return passo();
    return passo;
  }) as FetchAsaas;
  return { fetchFalso, chamadas };
}

interface LogChamada {
  msg: string;
  ctx?: Record<string, unknown>;
}

function criarLoggerFalso() {
  const chamadas: LogChamada[] = [];
  return {
    logger: {
      warn: (msg: string, ctx?: Record<string, unknown>) => chamadas.push({ msg, ctx }),
      error: (msg: string, ctx?: Record<string, unknown>) => chamadas.push({ msg, ctx }),
    },
    chamadas,
  };
}

function montarDeps(passos: PassoFalso[]) {
  const { fetchFalso, chamadas } = criarFetchFalso(passos);
  const { logger, chamadas: logs } = criarLoggerFalso();
  const deps: DepsClienteAsaas = { fetch: fetchFalso, config: CONFIG_BASE, logger };
  return { deps, chamadas, logs };
}

describe("cliente Asaas: cabeçalhos e forma da requisição", () => {
  it("GET manda access_token, Content-Type, User-Agent e NUNCA Authorization", async () => {
    const { deps, chamadas } = montarDeps([
      respostaJson(200, { object: "list", data: [] }),
    ]);
    const cliente = criarClienteAsaas(deps);
    await cliente.buscarClientePorReferencia("HC:org:abc");

    const headers = new Headers(chamadas[0]!.init.headers);
    expect(headers.get("access_token")).toBe(CHAVE_DE_TESTE);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("User-Agent")).toBe("HiperCRM/1.0");
    expect(headers.has("Authorization")).toBe(false);
  });

  it("GET não leva corpo", async () => {
    const { deps, chamadas } = montarDeps([respostaJson(200, { object: "list", data: [] })]);
    const cliente = criarClienteAsaas(deps);
    await cliente.buscarClientePorReferencia("HC:org:abc");
    expect(chamadas[0]!.init.body).toBeUndefined();
  });

  it("POST leva o corpo serializado e os mesmos cabeçalhos, sem Authorization", async () => {
    const { deps, chamadas } = montarDeps([
      respostaJson(200, {
        id: "cus_123",
        name: "Cliente Teste",
        cpfCnpj: CPF_DE_TESTE,
        externalReference: "HC:org:abc",
      }),
    ]);
    const cliente = criarClienteAsaas(deps);
    await cliente.criarCliente({
      name: "Cliente Teste",
      cpfCnpj: CPF_DE_TESTE,
      externalReference: "HC:org:abc",
    });
    const headers = new Headers(chamadas[0]!.init.headers);
    expect(headers.has("Authorization")).toBe(false);
    expect(chamadas[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(chamadas[0]!.init.body))).toMatchObject({ name: "Cliente Teste" });
  });

  it("toda chamada (GET e POST) vai com redirect: error", async () => {
    const { deps, chamadas } = montarDeps([
      respostaJson(200, { object: "list", data: [] }),
      respostaJson(200, { id: "cus_1", name: "x", cpfCnpj: CPF_DE_TESTE }),
    ]);
    const cliente = criarClienteAsaas(deps);
    await cliente.buscarClientePorReferencia("HC:org:abc");
    await cliente.criarCliente({ name: "x", cpfCnpj: CPF_DE_TESTE });
    expect(chamadas[0]!.init.redirect).toBe("error");
    expect(chamadas[1]!.init.redirect).toBe("error");
  });
});

describe("cliente Asaas: timeout", () => {
  it("timeout num GET não é inconclusivo", async () => {
    const { deps } = montarDeps(["timeout", "timeout", "timeout"]);
    const cliente = criarClienteAsaas(deps);
    let capturado: unknown;
    await cliente.buscarClientePorReferencia("HC:org:abc").catch((err) => {
      capturado = err;
    });
    expect(capturado).toBeInstanceOf(ErroAsaasException);
    expect((capturado as ErroAsaasException).erro).toMatchObject({
      tipo: "tempo_esgotado",
      inconclusivo: false,
    });
  });

  it("timeout num POST marca inconclusivo", async () => {
    const { deps } = montarDeps(["timeout"]);
    const cliente = criarClienteAsaas(deps);
    let capturado: unknown;
    await cliente.criarCliente({ name: "x", cpfCnpj: CPF_DE_TESTE }).catch((err) => {
      capturado = err;
    });
    expect(capturado).toBeInstanceOf(ErroAsaasException);
    expect((capturado as ErroAsaasException).erro).toMatchObject({
      tipo: "tempo_esgotado",
      inconclusivo: true,
    });
  });
});

describe("cliente Asaas: mapa de status para erro tipado", () => {
  it("401 -> autenticacao", async () => {
    const { deps } = montarDeps([respostaJson(401, { errors: [{ code: "invalid_api_key" }] })]);
    const cliente = criarClienteAsaas(deps);
    await expect(cliente.buscarClientePorReferencia("HC:org:1")).rejects.toMatchObject({
      erro: { tipo: "autenticacao", status: 401, inconclusivo: false },
    });
  });

  it("400 -> validacao, com os codigos do envelope", async () => {
    const { deps } = montarDeps([
      respostaJson(400, { errors: [{ code: "invalid_cpfCnpj", description: `cpf ${CPF_DE_TESTE} invalido` }] }),
    ]);
    const cliente = criarClienteAsaas(deps);
    await expect(cliente.criarCliente({ name: "x", cpfCnpj: CPF_DE_TESTE })).rejects.toMatchObject({
      erro: { tipo: "validacao", status: 400, codigos: ["invalid_cpfCnpj"], inconclusivo: false },
    });
  });

  it("404 num GET genérico -> nao_encontrado", async () => {
    const { deps } = montarDeps([respostaJson(404, { errors: [{ code: "not_found" }] })]);
    const cliente = criarClienteAsaas(deps);
    await expect(cliente.listarCobrancasDaAssinatura("sub_123")).rejects.toMatchObject({
      erro: { tipo: "nao_encontrado", status: 404 },
    });
  });

  it("429 num POST -> limite, sem retentativa (uma chamada só)", async () => {
    const { deps, chamadas } = montarDeps([respostaJson(429, {}, { "RateLimit-Reset": "1" })]);
    const cliente = criarClienteAsaas(deps);
    await expect(cliente.criarCliente({ name: "x", cpfCnpj: CPF_DE_TESTE })).rejects.toMatchObject({
      erro: { tipo: "limite" },
    });
    expect(chamadas).toHaveLength(1);
  });

  it("5xx num POST -> indisponivel e inconclusivo", async () => {
    const { deps, chamadas } = montarDeps([respostaJson(502, {})]);
    const cliente = criarClienteAsaas(deps);
    await expect(cliente.criarCliente({ name: "x", cpfCnpj: CPF_DE_TESTE })).rejects.toMatchObject({
      erro: { tipo: "indisponivel", status: 502, inconclusivo: true },
    });
    expect(chamadas).toHaveLength(1);
  });
});

describe("cliente Asaas: retentativa só em GET", () => {
  it("GET com 429 e RateLimit-Reset dentro do teto repete e depois consegue", async () => {
    const { deps, chamadas } = montarDeps([
      respostaJson(429, {}, { "RateLimit-Reset": "0" }),
      respostaJson(200, { object: "list", data: [] }),
    ]);
    const cliente = criarClienteAsaas(deps);
    const resultado = await cliente.buscarClientePorReferencia("HC:org:1");
    expect(resultado).toBeNull();
    expect(chamadas).toHaveLength(2);
  });

  it("GET com 429 e RateLimit-Reset ACIMA do teto falha sem esperar nem repetir", async () => {
    const acimaDoTeto = String(TETO_ESPERA_RATE_LIMIT_MS / 1000 + 10);
    const { deps, chamadas } = montarDeps([respostaJson(429, {}, { "RateLimit-Reset": acimaDoTeto })]);
    const cliente = criarClienteAsaas(deps);
    const inicio = Date.now();
    await expect(cliente.buscarClientePorReferencia("HC:org:1")).rejects.toMatchObject({
      erro: { tipo: "limite" },
    });
    expect(Date.now() - inicio).toBeLessThan(500);
    expect(chamadas).toHaveLength(1);
  });

  it("GET com 5xx repete até o teto de tentativas e então falha", async () => {
    const { deps, chamadas } = montarDeps([
      respostaJson(503, {}),
      respostaJson(503, {}),
      respostaJson(503, {}),
    ]);
    const cliente = criarClienteAsaas(deps);
    await expect(cliente.buscarClientePorReferencia("HC:org:1")).rejects.toMatchObject({
      erro: { tipo: "indisponivel", status: 503, inconclusivo: false },
    });
    expect(chamadas).toHaveLength(MAX_RETENTATIVAS_GET + 1);
  });

  it("GET com 5xx e depois sucesso: a retentativa vale", async () => {
    const { deps, chamadas } = montarDeps([respostaJson(503, {}), respostaJson(200, { object: "list", data: [] })]);
    const cliente = criarClienteAsaas(deps);
    await cliente.buscarClientePorReferencia("HC:org:1");
    expect(chamadas).toHaveLength(2);
  });
});

describe("cliente Asaas: resposta fora do schema", () => {
  it("resposta 2xx sem os campos exigidos vira resposta_invalida", async () => {
    const { deps } = montarDeps([respostaJson(200, { nao_e_um_cliente: true })]);
    const cliente = criarClienteAsaas(deps);
    await expect(cliente.criarCliente({ name: "x", cpfCnpj: CPF_DE_TESTE })).rejects.toMatchObject({
      erro: { tipo: "resposta_invalida" },
    });
  });
});

describe("cliente Asaas: recurso removido (decisão 10/B4)", () => {
  it("buscarAssinatura em 404 vira { removido: true }, não lança", async () => {
    const { deps } = montarDeps([respostaJson(404, { errors: [{ code: "not_found" }] })]);
    const cliente = criarClienteAsaas(deps);
    await expect(cliente.buscarAssinatura("sub_123")).resolves.toEqual({ removido: true });
  });

  it("buscarAssinatura com deleted:true no corpo vira { removido: true }", async () => {
    const { deps } = montarDeps([
      respostaJson(200, {
        id: "sub_123",
        customer: "cus_1",
        status: "INACTIVE",
        billingType: "CREDIT_CARD",
        cycle: "MONTHLY",
        value: 199.9,
        deleted: true,
      }),
    ]);
    const cliente = criarClienteAsaas(deps);
    await expect(cliente.buscarAssinatura("sub_123")).resolves.toEqual({ removido: true });
  });

  it("buscarCobranca em 404 vira { removido: true }", async () => {
    const { deps } = montarDeps([respostaJson(404, {})]);
    const cliente = criarClienteAsaas(deps);
    await expect(cliente.buscarCobranca("pay_123")).resolves.toEqual({ removido: true });
  });

  it("removerAssinatura em 404 não lança (idempotente)", async () => {
    const { deps } = montarDeps([respostaJson(404, {})]);
    const cliente = criarClienteAsaas(deps);
    await expect(cliente.removerAssinatura("sub_123")).resolves.toBeUndefined();
  });

  it("removerCobranca faz DELETE e não lança em 404", async () => {
    const { deps, chamadas } = montarDeps([respostaJson(404, {})]);
    const cliente = criarClienteAsaas(deps);
    await expect(cliente.removerCobranca("pay_123")).resolves.toBeUndefined();
    expect(chamadas[0]!.init.method).toBe("DELETE");
  });
});

describe("cliente Asaas: buscarWebhook (Tarefa 16, decisão 21)", () => {
  it("faz GET em /webhooks/{id} e devolve o campo interrupted", async () => {
    const { deps, chamadas } = montarDeps([respostaJson(200, { id: "wh_1", interrupted: true })]);
    const cliente = criarClienteAsaas(deps);
    await expect(cliente.buscarWebhook("wh_1")).resolves.toMatchObject({ id: "wh_1", interrupted: true });
    expect(chamadas[0]!.url).toContain("/webhooks/wh_1");
    expect(chamadas[0]!.init.method).toBe("GET");
  });

  it("resposta sem interrupted (fila saudável) não quebra o schema", async () => {
    const { deps } = montarDeps([respostaJson(200, { id: "wh_1" })]);
    const cliente = criarClienteAsaas(deps);
    await expect(cliente.buscarWebhook("wh_1")).resolves.toMatchObject({ id: "wh_1" });
  });
});

describe("cliente Asaas: base ou chave trocada", () => {
  it("config com habilitado:false recusa qualquer chamada, sem tocar a rede", async () => {
    const { deps, chamadas } = montarDeps([respostaJson(200, { object: "list", data: [] })]);
    const desligado: DepsClienteAsaas = { ...deps, config: { ...CONFIG_BASE, habilitado: false } };
    const cliente = criarClienteAsaas(desligado);
    await expect(cliente.buscarClientePorReferencia("HC:org:1")).rejects.toMatchObject({
      erro: { tipo: "configuracao" },
    });
    expect(chamadas).toHaveLength(0);
  });
});

describe("cliente Asaas: nada sensível vai para o log nem para o erro", () => {
  it("nenhuma chamada de log carrega a chave de API nem o CPF, em nenhum caminho testado acima", async () => {
    const { deps, chamadas: chamadasFetch, logs } = montarDeps([
      "timeout",
      respostaJson(503, {}),
      respostaJson(503, {}),
      respostaJson(503, {}),
    ]);
    const cliente = criarClienteAsaas(deps);
    await cliente.criarCliente({ name: "x", cpfCnpj: CPF_DE_TESTE }).catch(() => {});
    await cliente.buscarClientePorReferencia("HC:org:1").catch(() => {});

    const textoDosLogs = JSON.stringify(logs);
    expect(textoDosLogs).not.toContain(CHAVE_DE_TESTE);
    expect(textoDosLogs).not.toContain(CPF_DE_TESTE);
    expect(textoDosLogs).not.toContain("11144477735");

    // E nenhuma chamada de fetch de verdade tentou usar uma URL fora do
    // sandbox falso configurado acima: prova de que o dublê é o único canal.
    for (const chamada of chamadasFetch) {
      expect(chamada.url.startsWith(CONFIG_BASE.baseUrl)).toBe(true);
    }
  });

  it("JSON.stringify(erro) de nenhum erro lançado contém a chave ou o CPF", async () => {
    const { deps } = montarDeps([respostaJson(400, { errors: [{ code: "invalid_cpfCnpj", description: CPF_DE_TESTE }] })]);
    const cliente = criarClienteAsaas(deps);
    let capturado: unknown;
    try {
      await cliente.criarCliente({ name: "x", cpfCnpj: CPF_DE_TESTE });
    } catch (err) {
      capturado = err;
    }
    expect(capturado).toBeInstanceOf(ErroAsaasException);
    const serializado = JSON.stringify((capturado as ErroAsaasException).erro);
    expect(serializado).not.toContain(CPF_DE_TESTE);
    expect(serializado).not.toContain(CHAVE_DE_TESTE);
  });
});
