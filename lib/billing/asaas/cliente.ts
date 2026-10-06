import "server-only";

/**
 * Cliente HTTP do Asaas: fase F5, Tarefa 11, decisão 14.
 *
 * RESTRIÇÃO ABSOLUTA DESTA FASE: nenhuma chamada real ao Asaas, nem ao
 * sandbox, sai daqui em teste. Todo teste injeta `fetch` falso. Ligar de
 * verdade depende de chave e autorização explícita do Filipe.
 *
 * ═══ Contrato fixo, ponto por ponto ═══
 *
 * - Cabeçalhos: `access_token`, `Content-Type: application/json`,
 *   `User-Agent: HiperCRM/1.0`. NUNCA o header `Authorization`: o Asaas usa
 *   `access_token` como header próprio, e mandar os dois seria o tipo de
 *   detalhe que passa despercebido até auditoria de segurança.
 * - `GET` nunca leva corpo.
 * - `redirect: "error"`: o `fetch` do Node reenviaria o header `access_token`
 *   para outro domínio num redirecionamento 3xx, e a chave vazaria para quem
 *   quer que controle o Location. Preferimos falhar a esse risco.
 * - `AbortSignal.timeout`: 20s em `GET`, 60s em `POST`/`DELETE` (o manual,
 *   seção 10 item 5, pede pelo menos 60s no fluxo de cartão).
 * - Só `GET` repete sozinho, em 429/5xx, até duas vezes, respeitando
 *   `RateLimit-Reset` com um teto de poucos segundos; acima do teto vira
 *   `limite` sem esperar (decisão 13/M7). `POST` NUNCA repete: decisão 13 do
 *   plano e seção 10 item 5 do manual dizem a mesma coisa por caminhos
 *   diferentes ("não repetir POST de captura cegamente").
 * - Timeout ou 5xx num `POST` marca o erro como `inconclusivo`. Quem chama
 *   (a Tarefa 14, `compra.ts`) consulta o recurso por `externalReference`
 *   antes de tentar de novo, nunca recria cegamente.
 * - Toda resposta 2xx passa por um schema zod (`lib/billing/asaas/contratos.ts`);
 *   fora do formato esperado vira `resposta_invalida`.
 * - 404 (ou `deleted: true` numa resposta 2xx) ao buscar uma assinatura ou
 *   cobrança específica NÃO é erro: vira `{ removido: true }` (decisão 10/B4).
 *   O recurso já não existe no Asaas, e essa é uma resposta válida para
 *   quem confere se uma remoção pegou.
 * - Erros nunca carregam cabeçalho, chave de API, corpo da requisição nem
 *   CPF/CNPJ: só o `status` HTTP e, quando o Asaas manda, os `code` do
 *   envelope de validação (`lib/billing/asaas/erros.ts`).
 */
import { z } from "zod";

import type { ConfigAsaas } from "./config";
import {
  type AssinaturaAsaas,
  type CobrancaAsaas,
  type ClienteAsaas,
  type CriarAssinaturaRequest,
  type CriarClienteRequest,
  type CriarCobrancaParceladaRequest,
  type CriarCobrancaRequest,
  type ParcelamentoAsaas,
  type QrPixAsaas,
  assinaturaAsaasSchema,
  clienteAsaasSchema,
  cobrancaAsaasSchema,
  criarAssinaturaRequestSchema,
  criarClienteRequestSchema,
  criarCobrancaParceladaRequestSchema,
  criarCobrancaRequestSchema,
  parcelamentoAsaasSchema,
  listaAssinaturasSchema,
  listaClientesSchema,
  listaCobrancasSchema,
  qrPixAsaasSchema,
  type WebhookAsaas,
  webhookAsaasSchema,
} from "./contratos";
import {
  ErroAsaasException,
  erroAutenticacao,
  erroConfiguracao,
  erroIndisponivel,
  erroLimite,
  erroNaoEncontrado,
  erroRespostaInvalida,
  erroTempoEsgotado,
  erroValidacao,
} from "./erros";

/** Só o que este módulo precisa do logger da app (`lib/logger.ts` já satisfaz). */
export interface LoggerAsaas {
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
}

/** A assinatura do `fetch` global, para injetar um dublê nos testes. */
export type FetchAsaas = typeof fetch;

export interface DepsClienteAsaas {
  fetch: FetchAsaas;
  config: ConfigAsaas;
  logger: LoggerAsaas;
}

/** 20s em `GET` (decisão 14). */
export const TETO_GET_MS = 20_000;
/** 60s em `POST`/`DELETE` (decisão 14, manual seção 10 item 5). */
export const TETO_POST_MS = 60_000;
/**
 * Teto de espera por `RateLimit-Reset` na retentativa de `GET` (decisão
 * 13/M7): "teto de poucos segundos". Acima disso, falha com backoff em vez de
 * segurar a chamada.
 */
export const TETO_ESPERA_RATE_LIMIT_MS = 5_000;
/** Retentativas MÁXIMAS de um `GET` (além da primeira tentativa). */
export const MAX_RETENTATIVAS_GET = 2;
/** Espera padrão quando o Asaas não manda `RateLimit-Reset`/`Retry-After`. */
const ESPERA_PADRAO_SEM_HEADER_MS = 300;

export interface Removido {
  removido: true;
}

type Metodo = "GET" | "POST" | "DELETE";

interface OpcoesChamada {
  metodo: Metodo;
  caminho: string;
  corpo?: unknown;
}

function esperar(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Lê o tempo de espera indicado pelo Asaas, em SEGUNDOS. `RateLimit-Reset` é
 * o header que o manual (seção 7) manda respeitar; `Retry-After` é o
 * fallback padrão HTTP para quando ele não vier.
 */
function lerEsperaIndicada(res: Response): number | null {
  const bruto = res.headers.get("RateLimit-Reset") ?? res.headers.get("Retry-After");
  if (!bruto) return null;
  const segundos = Number(bruto);
  return Number.isFinite(segundos) && segundos >= 0 ? segundos : null;
}

const envelopeErroAsaasSchema = z
  .object({
    errors: z
      .array(z.object({ code: z.string().optional(), description: z.string().optional() }))
      .optional(),
  })
  .passthrough();

/** Só os `code`; NUNCA a `description` (pode conter dado do payload/CPF citado de volta). */
function extrairCodigos(corpo: unknown): string[] {
  const parsed = envelopeErroAsaasSchema.safeParse(corpo);
  if (!parsed.success) return [];
  return (parsed.data.errors ?? [])
    .map((e) => e.code)
    .filter((codigo): codigo is string => Boolean(codigo));
}

/**
 * O núcleo de toda chamada: monta a requisição, aplica o teto de tempo, a
 * política de retentativa e o mapa de status -> erro tipado. Devolve o corpo
 * JSON cru (ainda sem validar contra schema) de uma resposta 2xx.
 */
async function chamar(deps: DepsClienteAsaas, opcoes: OpcoesChamada): Promise<unknown> {
  const { config, logger } = deps;

  if (!config.habilitado) {
    throw erroConfiguracao("ASAAS_ENABLED está desligado; nenhuma chamada ao Asaas é permitida");
  }

  const url = `${config.baseUrl}${opcoes.caminho}`;
  const headers: Record<string, string> = {
    access_token: config.apiKey,
    "Content-Type": "application/json",
    "User-Agent": "HiperCRM/1.0",
  };
  const isPost = opcoes.metodo === "POST";
  const teto = opcoes.metodo === "GET" ? TETO_GET_MS : TETO_POST_MS;
  // Só GET repete; POST/DELETE têm uma única tentativa (decisão 13).
  const maxTentativas = opcoes.metodo === "GET" ? MAX_RETENTATIVAS_GET + 1 : 1;

  for (let tentativa = 0; tentativa < maxTentativas; tentativa += 1) {
    const ultimaTentativa = tentativa === maxTentativas - 1;
    let res: Response;
    try {
      res = await deps.fetch(url, {
        method: opcoes.metodo,
        headers,
        // GET nunca leva corpo, nem `undefined` explícito.
        ...(opcoes.metodo === "GET" ? {} : { body: JSON.stringify(opcoes.corpo ?? {}) }),
        redirect: "error",
        signal: AbortSignal.timeout(teto),
      });
    } catch (err) {
      // `AbortSignal.timeout()` rejeita com `DOMException`, que NÃO é
      // `instanceof Error` no Node (é uma classe própria, só com a mesma
      // forma: `name`/`message`/`stack`). Ler `.name` direto do objeto,
      // nunca atrás de um `instanceof Error`, é o que faz o timeout de
      // verdade cair no ramo certo.
      const nome = (err as { name?: unknown })?.name;
      if (nome === "TimeoutError" || nome === "AbortError") {
        logger.warn("asaas_timeout", { metodo: opcoes.metodo, caminho: opcoes.caminho, tetoMs: teto });
        throw erroTempoEsgotado(isPost);
      }
      // Redirect recusado (`redirect: "error"`), DNS, socket recusado etc.
      logger.error("asaas_falha_de_rede", {
        metodo: opcoes.metodo,
        caminho: opcoes.caminho,
        erro: String(typeof nome === "string" && nome ? nome : err).slice(0, 100),
      });
      throw erroIndisponivel(0, isPost);
    }

    if (res.ok) {
      return await res.json().catch(() => null);
    }

    if (res.status === 401 || res.status === 403) {
      throw erroAutenticacao(res.status);
    }
    if (res.status === 400 || res.status === 422) {
      const corpo = await res.json().catch(() => null);
      throw erroValidacao(res.status, extrairCodigos(corpo));
    }
    if (res.status === 404) {
      throw erroNaoEncontrado(res.status);
    }
    if (res.status === 429) {
      const reiniciaEm = lerEsperaIndicada(res);
      const acimaDoTeto = reiniciaEm !== null && reiniciaEm * 1000 > TETO_ESPERA_RATE_LIMIT_MS;
      if (opcoes.metodo !== "GET" || ultimaTentativa || acimaDoTeto) {
        throw erroLimite(reiniciaEm, isPost);
      }
      logger.warn("asaas_retry_429", { caminho: opcoes.caminho, tentativa, reiniciaEm });
      await esperar(reiniciaEm !== null ? reiniciaEm * 1000 : ESPERA_PADRAO_SEM_HEADER_MS);
      continue;
    }
    if (res.status >= 500) {
      if (opcoes.metodo !== "GET" || ultimaTentativa) {
        throw erroIndisponivel(res.status, isPost);
      }
      logger.warn("asaas_retry_5xx", { caminho: opcoes.caminho, tentativa, status: res.status });
      await esperar(ESPERA_PADRAO_SEM_HEADER_MS);
      continue;
    }
    // Qualquer outro status de erro não mapeado explicitamente.
    throw erroIndisponivel(res.status, isPost);
  }

  // Inatingível: o laço acima sempre retorna ou lança antes de esgotar as
  // tentativas (a última iteração cai num dos ramos de `ultimaTentativa`).
  throw erroIndisponivel(0, isPost);
}

async function chamarComSchema<T>(
  deps: DepsClienteAsaas,
  opcoes: OpcoesChamada,
  schema: z.ZodType<T>,
): Promise<T> {
  const corpo = await chamar(deps, opcoes);
  const parsed = schema.safeParse(corpo);
  if (!parsed.success) {
    throw erroRespostaInvalida(parsed.error.issues.map((i) => i.path.join(".")).join(",") || "raiz");
  }
  return parsed.data;
}

function ehRemovido(err: unknown): boolean {
  return err instanceof ErroAsaasException && err.erro.tipo === "nao_encontrado";
}

export interface ClienteAsaasHttp {
  buscarClientePorReferencia(externalReference: string): Promise<ClienteAsaas | null>;
  criarCliente(dados: CriarClienteRequest): Promise<ClienteAsaas>;
  criarAssinatura(dados: CriarAssinaturaRequest): Promise<AssinaturaAsaas>;
  buscarAssinatura(id: string): Promise<AssinaturaAsaas | Removido>;
  listarCobrancasDaAssinatura(id: string): Promise<CobrancaAsaas[]>;
  buscarAssinaturaPorReferencia(externalReference: string): Promise<AssinaturaAsaas | null>;
  removerAssinatura(id: string): Promise<void>;
  criarCobranca(dados: CriarCobrancaRequest): Promise<CobrancaAsaas>;
  buscarCobranca(id: string): Promise<CobrancaAsaas | Removido>;
  buscarCobrancaPorReferencia(externalReference: string): Promise<CobrancaAsaas | null>;
  removerCobranca(id: string): Promise<void>;
  qrPix(id: string): Promise<QrPixAsaas>;
  /** D-177: cobrança parcelada no cartão (`installmentCount` + `totalValue`); devolve a PRIMEIRA parcela, com `installment`. */
  criarCobrancaParcelada(dados: CriarCobrancaParceladaRequest): Promise<CobrancaAsaas>;
  /** D-177: `GET /installments/{id}`, o total do parcelamento que se confere contra o pedido. */
  buscarParcelamento(id: string): Promise<ParcelamentoAsaas | Removido>;
  /** D-177: `DELETE /installments/{id}` remove o parcelamento pendente inteiro (idempotente em 404). */
  removerParcelamento(id: string): Promise<void>;
  /** D-177: as cobranças (parcelas) do parcelamento. */
  listarCobrancasDoParcelamento(id: string): Promise<CobrancaAsaas[]>;
  /** `GET /webhooks/{id}` (Tarefa 16, decisão 21): a conciliação diária confere `interrupted`. */
  buscarWebhook(id: string): Promise<WebhookAsaas>;
}

/**
 * Monta o cliente HTTP com as dependências injetadas, sem módulo global
 * com `fetch`/`config` fixos, para que o teste injete um `fetch` falso sem
 * tocar variável de ambiente nenhuma.
 */
export function criarClienteAsaas(deps: DepsClienteAsaas): ClienteAsaasHttp {
  return {
    async buscarClientePorReferencia(externalReference) {
      const lista = await chamarComSchema(
        deps,
        { metodo: "GET", caminho: `/customers?externalReference=${encodeURIComponent(externalReference)}` },
        listaClientesSchema,
      );
      return lista.data[0] ?? null;
    },

    async criarCliente(dados) {
      const corpo = criarClienteRequestSchema.parse(dados);
      return chamarComSchema(deps, { metodo: "POST", caminho: "/customers", corpo }, clienteAsaasSchema);
    },

    async criarAssinatura(dados) {
      const corpo = criarAssinaturaRequestSchema.parse(dados);
      return chamarComSchema(deps, { metodo: "POST", caminho: "/subscriptions", corpo }, assinaturaAsaasSchema);
    },

    async buscarAssinatura(id) {
      try {
        const assinatura = await chamarComSchema(
          deps,
          { metodo: "GET", caminho: `/subscriptions/${encodeURIComponent(id)}` },
          assinaturaAsaasSchema,
        );
        if (assinatura.deleted) return { removido: true };
        return assinatura;
      } catch (err) {
        if (ehRemovido(err)) return { removido: true };
        throw err;
      }
    },

    async listarCobrancasDaAssinatura(id) {
      const lista = await chamarComSchema(
        deps,
        { metodo: "GET", caminho: `/subscriptions/${encodeURIComponent(id)}/payments` },
        listaCobrancasSchema,
      );
      return lista.data;
    },

    async buscarAssinaturaPorReferencia(externalReference) {
      const lista = await chamarComSchema(
        deps,
        { metodo: "GET", caminho: `/subscriptions?externalReference=${encodeURIComponent(externalReference)}` },
        listaAssinaturasSchema,
      );
      return lista.data[0] ?? null;
    },

    async removerAssinatura(id) {
      try {
        await chamar(deps, { metodo: "DELETE", caminho: `/subscriptions/${encodeURIComponent(id)}` });
      } catch (err) {
        // Idempotente: já não existir é o resultado que a remoção queria.
        if (ehRemovido(err)) return;
        throw err;
      }
    },

    async criarCobranca(dados) {
      const corpo = criarCobrancaRequestSchema.parse(dados);
      return chamarComSchema(deps, { metodo: "POST", caminho: "/payments", corpo }, cobrancaAsaasSchema);
    },

    async criarCobrancaParcelada(dados) {
      const corpo = criarCobrancaParceladaRequestSchema.parse(dados);
      return chamarComSchema(deps, { metodo: "POST", caminho: "/payments", corpo }, cobrancaAsaasSchema);
    },

    async buscarParcelamento(id) {
      try {
        const parcelamento = await chamarComSchema(
          deps,
          { metodo: "GET", caminho: `/installments/${encodeURIComponent(id)}` },
          parcelamentoAsaasSchema,
        );
        if (parcelamento.deleted) return { removido: true };
        return parcelamento;
      } catch (err) {
        if (ehRemovido(err)) return { removido: true };
        throw err;
      }
    },

    async removerParcelamento(id) {
      try {
        await chamar(deps, { metodo: "DELETE", caminho: `/installments/${encodeURIComponent(id)}` });
      } catch (err) {
        if (ehRemovido(err)) return;
        throw err;
      }
    },

    async listarCobrancasDoParcelamento(id) {
      const lista = await chamarComSchema(
        deps,
        { metodo: "GET", caminho: `/installments/${encodeURIComponent(id)}/payments` },
        listaCobrancasSchema,
      );
      return lista.data;
    },

    async buscarCobranca(id) {
      try {
        const cobranca = await chamarComSchema(
          deps,
          { metodo: "GET", caminho: `/payments/${encodeURIComponent(id)}` },
          cobrancaAsaasSchema,
        );
        if (cobranca.deleted) return { removido: true };
        return cobranca;
      } catch (err) {
        if (ehRemovido(err)) return { removido: true };
        throw err;
      }
    },

    async buscarCobrancaPorReferencia(externalReference) {
      const lista = await chamarComSchema(
        deps,
        { metodo: "GET", caminho: `/payments?externalReference=${encodeURIComponent(externalReference)}` },
        listaCobrancasSchema,
      );
      return lista.data[0] ?? null;
    },

    async removerCobranca(id) {
      try {
        await chamar(deps, { metodo: "DELETE", caminho: `/payments/${encodeURIComponent(id)}` });
      } catch (err) {
        if (ehRemovido(err)) return;
        throw err;
      }
    },

    async qrPix(id) {
      return chamarComSchema(
        deps,
        { metodo: "GET", caminho: `/payments/${encodeURIComponent(id)}/pixQrCode` },
        qrPixAsaasSchema,
      );
    },

    async buscarWebhook(id) {
      return chamarComSchema(deps, { metodo: "GET", caminho: `/webhooks/${encodeURIComponent(id)}` }, webhookAsaasSchema);
    },
  };
}
