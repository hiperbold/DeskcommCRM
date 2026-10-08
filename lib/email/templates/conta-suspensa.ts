/**
 * COB-06, conta suspensa: a organização foi suspensa por falta de pagamento. Os dados ficam guardados; o
 * atendimento e a IA voltam quando o pagamento for feito.
 */
import { traduzir } from "@/lib/i18n/dicionario";

import {
  montarEmailTransacional,
  paraAssunto,
  preencher,
  type OpcoesBaseDoEmail,
} from "./_layout-transacional";

export const ID_DO_EMAIL = "COB-06";

export type ContaSuspensaEmailOptions = OpcoesBaseDoEmail;

export function buildContaSuspensaEmail(opts: ContaSuspensaEmailOptions): {
  subject: string;
  html: string;
  text: string;
} {
  const { idioma, marca } = opts;

  const titulo = traduzir("Sua conta está suspensa", idioma);
  const texto = preencher(
    traduzir(
      "A conta da {empresa} foi suspensa por falta de pagamento. Suas conversas e contatos estão guardados; o atendimento e a IA voltam assim que o pagamento for feito.",
      idioma,
    ),
    { empresa: opts.empresa },
  );

  const { html, text } = montarEmailTransacional({
    marca,
    idioma,
    empresa: opts.empresa,
    faixaDoOperador: opts.faixaDoOperador,
    selo: { texto: traduzir("Conta suspensa", idioma), tom: "perigo" },
    titulo,
    paragrafos: [texto],
    botao: { texto: traduzir("Regularizar", idioma), url: opts.url },
  });

  return { subject: paraAssunto(titulo), html, text };
}
