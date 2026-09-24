import "server-only";

/**
 * Erros do cliente HTTP do Asaas: fase F5, Tarefa 10, decisão 14.
 *
 * `ErroAsaas` é DISCRIMINADO por `tipo`: quem trata o erro decide o próximo
 * passo (repetir, gravar `inconclusivo`, avisar o admin) olhando só esse
 * campo, sem precisar inspecionar mensagem de texto. Nenhuma variante carrega
 * cabeçalho, chave de API, corpo da requisição nem CPF/CNPJ: o `status` HTTP
 * e um punhado de `codigos` (do envelope de erro do Asaas) são tudo que passa
 * daqui para fora, e é exatamente o que a decisão 13 do manual (seção 10,
 * item 2) manda: "mensagem do Asaas nunca crua na tela; só os `code` vão para
 * o log".
 *
 * `inconclusivo` está em TODA variante porque quem decide o que fazer com um
 * `POST` financeiro que falhou precisa da mesma pergunta em qualquer ramo do
 * erro: "o Asaas pode ter processado mesmo assim?" (decisão 13: timeout ou
 * 5xx em POST marca o pedido `inconclusivo`, e a retentativa consulta antes
 * de criar de novo). Numa chamada `GET`, a resposta é sempre `false`: uma
 * leitura que falha não muda nada do lado do Asaas.
 */
export type ErroAsaas =
  | { tipo: "configuracao"; mensagem: string; inconclusivo: false }
  | { tipo: "autenticacao"; status: number; inconclusivo: false }
  | { tipo: "validacao"; status: number; codigos: string[]; inconclusivo: false }
  | { tipo: "nao_encontrado"; status: number; inconclusivo: false }
  | { tipo: "limite"; reiniciaEm: number | null; inconclusivo: boolean }
  | { tipo: "indisponivel"; status: number; inconclusivo: boolean }
  | { tipo: "tempo_esgotado"; inconclusivo: boolean }
  | { tipo: "resposta_invalida"; detalhe: string; inconclusivo: false };

/**
 * Exceção lançada pelo cliente HTTP (`lib/billing/asaas/cliente.ts`); quem
 * chama confere `erro.erro.tipo` (ou `instanceof ErroAsaasException`) para
 * decidir o próximo passo. `Error.message` traz só o `tipo` (ex.:
 * `"asaas_limite"`), nunca detalhe sensível. Quem precisa do `status` ou dos
 * `codigos` lê o objeto `erro`, tipado por variante.
 */
export class ErroAsaasException extends Error {
  constructor(public readonly erro: ErroAsaas) {
    super(`asaas_${erro.tipo}`);
    this.name = "ErroAsaasException";
  }
}

/** Combinação de variáveis incoerente (decisão 14); nunca chegou a chamar a rede. */
export function erroConfiguracao(mensagem: string): ErroAsaasException {
  return new ErroAsaasException({ tipo: "configuracao", mensagem, inconclusivo: false });
}

/** 401/403: chave recusada. Resposta definitiva, nunca inconclusiva. */
export function erroAutenticacao(status: number): ErroAsaasException {
  return new ErroAsaasException({ tipo: "autenticacao", status, inconclusivo: false });
}

/** 400/422: o Asaas recusou o payload. `codigos` são só os `code` do envelope de erro. */
export function erroValidacao(status: number, codigos: string[]): ErroAsaasException {
  return new ErroAsaasException({ tipo: "validacao", status, codigos, inconclusivo: false });
}

/** 404 num recurso que não é o de "buscar assinatura/cobrança" (esses viram remoção, decisão 10/B4). */
export function erroNaoEncontrado(status: number): ErroAsaasException {
  return new ErroAsaasException({ tipo: "nao_encontrado", status, inconclusivo: false });
}

/**
 * 429 além do teto de espera de `RateLimit-Reset` (decisão 13/M7), ou 429 num
 * `POST` (que nunca repete). `reiniciaEm` é o valor CRU do cabeçalho, em
 * segundos, para quem chama decidir quando tentar de novo por fora.
 */
export function erroLimite(reiniciaEm: number | null, inconclusivo = false): ErroAsaasException {
  return new ErroAsaasException({ tipo: "limite", reiniciaEm, inconclusivo });
}

/** 5xx depois de esgotar as retentativas (só `GET` repete) ou num `POST`/`DELETE`. */
export function erroIndisponivel(status: number, inconclusivo = false): ErroAsaasException {
  return new ErroAsaasException({ tipo: "indisponivel", status, inconclusivo });
}

/** `AbortSignal.timeout` estourou antes de qualquer resposta chegar. */
export function erroTempoEsgotado(inconclusivo = false): ErroAsaasException {
  return new ErroAsaasException({ tipo: "tempo_esgotado", inconclusivo });
}

/** A resposta chegou 2xx mas não bate com o schema zod esperado. */
export function erroRespostaInvalida(detalhe: string): ErroAsaasException {
  return new ErroAsaasException({ tipo: "resposta_invalida", detalhe, inconclusivo: false });
}
