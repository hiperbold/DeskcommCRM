/**
 * Pareamento por QR Code — a face neutra que rota e tela usam.
 *
 * Mesma razão de `./instancia`: a rota não pode nomear o provider (o
 * `lint:channels` reprova até no caminho de um import). Quem está do outro lado,
 * as chaves da instalação e o desenho da linha moram em `./uazapi/pareamento`; a
 * rota fala em conceitos: "o pareamento", "o QR", "o código".
 */
export { pareamentoPendente as pareamentoQrPendente } from "./uazapi/conexao";
export {
  LIMITE_DE_PAREAMENTOS_PENDENTES,
  VALIDADE_DO_PAREAMENTO_MS,
  cancelarPareamento as cancelarPareamentoQr,
  estadoDoPareamento as estadoDoPareamentoQr,
  iniciarPareamento as iniciarPareamentoQr,
  limparPareamentosVencidos as limparPareamentosQrVencidos,
  pareamentoDisponivel as pareamentoQrDisponivel,
  pareamentoPendenteDaOrganizacao as pareamentoQrPendenteDaOrganizacao,
  renovarPareamento as renovarPareamentoQr,
  type EstadoDoPareamento as EstadoDoPareamentoQr,
  type FalhaDoPareamento as FalhaDoPareamentoQr,
  type PareamentoEmAndamento as PareamentoQrEmAndamento,
} from "./uazapi/pareamento";
