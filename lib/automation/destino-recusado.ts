/**
 * O código de recusa de destino que pode chegar a quem é de uma ORGANIZAÇÃO.
 *
 * A régua de destino (`motivoDaRecusaDeDestino`, `assertDestinoResolvidoSeguro`)
 * distingue "o nome não resolve" (`dns_failed`, `dns_empty`) de "o nome resolve
 * para IP interno" (`private_ip`). Para o log do servidor a distinção ajuda; para
 * quem administra uma empresa ela é um oráculo: por tentativa e erro, descobre
 * quais nomes existem na rede interna do compose (nome que não existe = "não
 * resolve"; nome que existe = "rede interna").
 *
 * Por isso todo ponto que grava ou devolve o código de uma recusa de endereço
 * escolhido por organização (resposta de API, `actions_result` da automação,
 * aviso da Central) passa por `codigoParaOrganizacao` ANTES de gravar ou
 * devolver. O log do servidor segue com o motivo real.
 *
 * Módulo puro, sem DNS nem banco: `lib/ai/credenciais/erro-de-validacao.ts` é
 * importado por componentes de cliente e não pode arrastar nada disso.
 */

/** O único código que a organização vê para as três recusas que denunciam a rede. */
export const DESTINO_RECUSADO = "unsafe_url:destino_recusado";

/** Os códigos que separam "não resolve" de "rede interna". */
const CODIGOS_QUE_DENUNCIAM_A_REDE: ReadonlySet<string> = new Set([
  "unsafe_url:dns_failed",
  "unsafe_url:dns_empty",
  "unsafe_url:private_ip",
]);

/** O código cru da régua, ou `DESTINO_RECUSADO` quando ele distinguiria nome inexistente de IP interno. */
export function codigoParaOrganizacao(codigo: string): string {
  return CODIGOS_QUE_DENUNCIAM_A_REDE.has(codigo) ? DESTINO_RECUSADO : codigo;
}

/** Aceita `null`/`undefined` para quem lê colunas anuláveis; devolve o que veio. */
export function codigoNuloParaOrganizacao(codigo: string | null | undefined): string | null {
  return codigo == null ? null : codigoParaOrganizacao(codigo);
}
