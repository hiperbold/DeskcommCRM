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
 * Mesmas funções de `lib/automation/outbound-*` (webhooks de automação), com a
 * mesma janela residual de rebinding declarada lá.
 */
import { getDefaultAutoSelectFamilyAttemptTimeout, setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";

import { assertDestinoResolvidoSeguro } from "@/lib/automation/outbound-ip";
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

export function criarFetchSeguro(
  deps: { validarHost?: (host: string) => Promise<void>; fetch?: FetchLike } = {},
): FetchLike {
  const validarHost = deps.validarHost ?? assertDestinoResolvidoSeguro;
  const buscar = deps.fetch ?? globalThis.fetch;
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    // Explícito: `assertSafeOutboundUrl` só barra http em produção.
    if (new URL(url).protocol !== "https:") throw new Error("unsafe_url:https_required");
    assertSafeOutboundUrl(url);
    await validarHost(new URL(url).hostname);
    const res = await buscar(input, { ...init, redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => {});
      throw new Error("mcp_redirecionamento_recusado");
    }
    return await comLimiteDeBytes(res);
  };
}
