/**
 * O fetch que o cliente MCP usa para falar com servidor de terceiro.
 *
 * O endereço vem de quem administra a organização, e o servidor do outro lado
 * é não confiável. Quatro recusas, em TODA requisição (o transporte faz várias
 * por sessão, e o DNS pode mudar entre elas):
 *   - http: credencial viajaria em claro;
 *   - host que resolve para IP interno: a rede da VPS não é destino;
 *   - redirecionamento (qualquer 3xx, não só 302): seguir levaria a
 *     credencial para outro lugar;
 *   - resposta maior que o teto: um servidor comprometido ou com bug poderia
 *     devolver megabytes e estourar memória antes mesmo do corte por
 *     caractere que `cliente.ts` faz no texto já extraído.
 *
 * Mesmas funções de `lib/automation/outbound-*` (webhooks de automação). A
 * diferença é a janela de rebinding (D-168): validar o nome e deixar o `fetch`
 * resolver DE NOVO abria um intervalo em que o DNS podia passar a devolver um IP
 * interno. Aqui a conexão é aberta NO ENDEREÇO QUE A GUARDA VALIDOU, com o nome
 * original só no SNI e no cabeçalho `Host` (TLS continua valendo para o domínio).
 */
import { request as requisicaoHttps } from "node:https";
import { getDefaultAutoSelectFamilyAttemptTimeout, isIPv6, setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";
import { Readable } from "node:stream";

import { resolverDestinoSeguro } from "@/lib/automation/outbound-ip";
import { assertSafeOutboundUrl } from "@/lib/automation/outbound-url";

/**
 * O `fetch` do Node escolhe entre IPv6 e IPv4 com 250 ms por tentativa de
 * conexão. Num link lento (medido no WSL em 22/09/2026 contra
 * mcp.deepwiki.com) o TCP passa disso e TODA tentativa morre em
 * `connect ETIMEDOUT` em menos de 1 s, enquanto o curl conecta em 0,8 s: a
 * conexão MCP falhava sempre com "O servidor não respondeu a tempo". O
 * padrão é do processo inteiro (o `fetch` global não aceita outro por
 * chamada sem o pacote `undici`); subir só afrouxa a espera antes de tentar
 * a outra família, não abre destino nenhum.
 */
export const ESPERA_POR_TENTATIVA_DE_CONEXAO_MS = 2000;
if (getDefaultAutoSelectFamilyAttemptTimeout() < ESPERA_POR_TENTATIVA_DE_CONEXAO_MS) {
  setDefaultAutoSelectFamilyAttemptTimeout(ESPERA_POR_TENTATIVA_DE_CONEXAO_MS);
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** 2 MiB: cabe folgado numa lista de ferramentas ou num resultado de consulta. */
export const TETO_DE_BYTES = 2 * 1024 * 1024;

/**
 * Corta a resposta pelo tamanho, em dois estágios:
 *   1) `content-length` declarado: recusa sem ler um byte do corpo;
 *   2) sem declaração (comum em SSE, onde o tamanho não é conhecido de
 *      antemão): conta em stream e erra assim que ultrapassa o teto, sem
 *      acumular a resposta inteira em memória. Um stream de SSE que passa de
 *      2 MiB numa única conexão é aceitável cortar; não é o caso comum.
 */
async function comLimiteDeBytes(res: Response): Promise<Response> {
  const declarado = res.headers.get("content-length");
  if (declarado !== null) {
    const tamanho = Number(declarado);
    if (Number.isFinite(tamanho) && tamanho > TETO_DE_BYTES) {
      // Sem cancelar, o corpo (e a conexão TCP por baixo) fica pendurado até
      // o timeout do socket: um jeito barato de o servidor segurar conexões
      // abertas mesmo sendo recusado.
      await res.body?.cancel().catch(() => {});
      throw new Error("mcp_resposta_grande_demais");
    }
  }
  if (!res.body) return res;
  let total = 0;
  const limitador = new TransformStream<Uint8Array, Uint8Array>({
    transform(pedaco, controller) {
      total += pedaco.byteLength;
      if (total > TETO_DE_BYTES) {
        controller.error(new Error("mcp_resposta_grande_demais"));
        return;
      }
      controller.enqueue(pedaco);
    },
  });
  return new Response(res.body.pipeThrough(limitador), {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}

/** O que `https.request` oferece, para o teste trocar a rede. */
type RequisicaoHttps = typeof requisicaoHttps;

/**
 * `lookup` que só devolve os endereços JÁ validados: o `https.request` nunca
 * chega a resolver o nome. Responde nos dois formatos que o Node pede (um
 * endereço, ou a lista, quando `all` está ligado — o caso do auto-select de
 * família).
 */
export function lookupFixo(enderecos: readonly string[]) {
  const lista = enderecos.map((address) => ({ address, family: isIPv6(address) ? 6 : 4 }));
  return (_nome: string, opcoes: unknown, cb: (...args: unknown[]) => void): void => {
    const callback = (typeof opcoes === "function" ? opcoes : cb) as (...args: unknown[]) => void;
    const todos = typeof opcoes === "object" && opcoes !== null && (opcoes as { all?: boolean }).all === true;
    if (todos) callback(null, lista);
    else callback(null, lista[0]!.address, lista[0]!.family);
  };
}

/**
 * `fetch` que conecta nos endereços validados. Corpo de requisição em memória
 * (as mensagens MCP são JSON pequeno); a resposta continua em stream (SSE).
 * `accept-encoding: identity`: o `fetch` do Node descompacta sozinho, o
 * `https.request` não, e o teto de bytes precisa contar o que o servidor mandou.
 */
async function buscarNoEnderecoValidado(
  input: string | URL | Request,
  init: RequestInit | undefined,
  enderecos: readonly string[],
  requisitar: RequisicaoHttps,
): Promise<Response> {
  const req = new Request(input, init);
  const url = new URL(req.url);
  const cabecalhos: Record<string, string> = { "accept-encoding": "identity" };
  req.headers.forEach((valor, nome) => {
    cabecalhos[nome] = valor;
  });
  const corpo = req.body ? Buffer.from(await req.arrayBuffer()) : undefined;

  return await new Promise<Response>((resolver, rejeitar) => {
    const chamada = requisitar(
      url,
      {
        method: req.method,
        headers: cabecalhos,
        lookup: lookupFixo(enderecos) as never,
        // O nome do domínio continua valendo para o certificado.
        servername: url.hostname,
        signal: req.signal,
      },
      (res) => {
        const headers = new Headers();
        for (const [nome, valor] of Object.entries(res.headers)) {
          if (Array.isArray(valor)) for (const v of valor) headers.append(nome, v);
          else if (valor !== undefined) headers.set(nome, String(valor));
        }
        const status = res.statusCode ?? 502;
        const semCorpo = status === 204 || status === 205 || status === 304;
        resolver(
          new Response(semCorpo ? null : (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>), {
            status,
            statusText: res.statusMessage ?? "",
            headers,
          }),
        );
      },
    );
    chamada.on("error", rejeitar);
    if (corpo) chamada.write(corpo);
    chamada.end();
  });
}

export function criarFetchSeguro(
  deps: {
    validarHost?: (host: string) => Promise<void>;
    fetch?: FetchLike;
    /** Teste: troca a resolução e a rede do caminho de produção. */
    resolverHost?: (host: string) => Promise<string[]>;
    requisitar?: RequisicaoHttps;
  } = {},
): FetchLike {
  // `fetch` injetado (teste) segue o caminho de sempre. Sem ele, produção:
  // resolve UMA vez, valida e conecta no endereço validado.
  const buscar = deps.fetch;
  const resolverHost = deps.resolverHost ?? resolverDestinoSeguro;
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    // Explícito: `assertSafeOutboundUrl` só barra http em produção, sem a opção.
    if (new URL(url).protocol !== "https:") throw new Error("unsafe_url:https_required");
    assertSafeOutboundUrl(url, { httpsSempre: true });
    const host = new URL(url).hostname;
    let res: Response;
    if (buscar) {
      await (deps.validarHost ?? (async (h: string) => void (await resolverHost(h))))(host);
      res = await buscar(input, { ...init, redirect: "manual" });
    } else {
      const enderecos = await resolverHost(host);
      res = await buscarNoEnderecoValidado(input, init, enderecos, deps.requisitar ?? requisicaoHttps);
    }
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => {});
      throw new Error("mcp_redirecionamento_recusado");
    }
    return await comLimiteDeBytes(res);
  };
}
