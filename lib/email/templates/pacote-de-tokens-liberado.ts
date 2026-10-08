/**
 * COB-09, pacote de tokens liberado: a compra de um pacote extra de tokens de IA foi confirmada e o saldo já
 * está na organização. A quantidade sai com ponto de milhar (`500.000`).
 */
import { traduzir } from "@/lib/i18n/dicionario";

import {
  formatarData,
  formatarInteiro,
  formatarReais,
  montarEmailTransacional,
  paraAssunto,
  preencher,
  type OpcoesBaseDoEmail,
} from "./_layout-transacional";

export const ID_DO_EMAIL = "COB-09";

export interface PacoteDeTokensLiberadoEmailOptions extends OpcoesBaseDoEmail {
  /** Quantidade de tokens do pacote. */
  tokens: number;
  /** Centavos pagos pelo pacote. */
  valorPago: number;
  /**
   * ISO. Até quando o pacote vale. Hoje o pacote não tem validade no banco (fica no saldo avulso, sem ciclo):
   * sem ela, a linha "Válido até" some e o texto não promete data.
   */
  validoAte?: string;
}

export function buildPacoteDeTokensLiberadoEmail(opts: PacoteDeTokensLiberadoEmailOptions): {
  subject: string;
  html: string;
  text: string;
} {
  const { idioma, marca } = opts;
  const tokens = formatarInteiro(opts.tokens);
  const data = opts.validoAte ? formatarData(opts.validoAte) : null;

  const titulo = preencher(traduzir("Seu pacote de {tokens} tokens está liberado", idioma), {
    tokens,
  });
  const texto = data
    ? preencher(
        traduzir(
          "O pacote de {tokens} tokens já está no saldo da {empresa} e vale até {data}.",
          idioma,
        ),
        { tokens, empresa: opts.empresa, data },
      )
    : preencher(traduzir("O pacote de {tokens} tokens já está no saldo da {empresa}.", idioma), {
        tokens,
        empresa: opts.empresa,
      });

  const { html, text } = montarEmailTransacional({
    marca,
    idioma,
    empresa: opts.empresa,
    faixaDoOperador: opts.faixaDoOperador,
    selo: { texto: traduzir("Tokens liberados", idioma), tom: "sucesso" },
    titulo,
    paragrafos: [texto],
    resumo: [
      {
        rotulo: traduzir("Pacote", idioma),
        valor: preencher(traduzir("{tokens} tokens", idioma), { tokens }),
      },
      { rotulo: traduzir("Valor pago", idioma), valor: formatarReais(opts.valorPago) },
      ...(data ? [{ rotulo: traduzir("Válido até", idioma), valor: data }] : []),
    ],
    botao: { texto: traduzir("Ver consumo", idioma), url: opts.url },
  });

  return { subject: paraAssunto(titulo), html, text };
}
