/**
 * COB-07, cancelamento confirmado: o plano foi cancelado, não haverá novas cobranças e o acesso segue até a
 * data. O botão leva a reativar o plano.
 */
import { traduzir } from "@/lib/i18n/dicionario";

import {
  formatarData,
  montarEmailTransacional,
  paraAssunto,
  preencher,
  type OpcoesBaseDoEmail,
} from "./_layout-transacional";

export const ID_DO_EMAIL = "COB-07";

export interface CancelamentoConfirmadoEmailOptions extends OpcoesBaseDoEmail {
  plano: string;
  /** ISO. Até quando o acesso continua. */
  acessoAte: string;
}

export function buildCancelamentoConfirmadoEmail(opts: CancelamentoConfirmadoEmailOptions): {
  subject: string;
  html: string;
  text: string;
} {
  const { idioma, marca } = opts;

  const titulo = traduzir("Cancelamento confirmado", idioma);
  const texto = preencher(
    traduzir(
      "O plano {plano} foi cancelado e não haverá novas cobranças. Você continua com acesso até {data}.",
      idioma,
    ),
    { plano: opts.plano, data: formatarData(opts.acessoAte) },
  );

  const { html, text } = montarEmailTransacional({
    marca,
    idioma,
    empresa: opts.empresa,
    faixaDoOperador: opts.faixaDoOperador,
    selo: { texto: traduzir("Cancelamento", idioma), tom: "info" },
    titulo,
    paragrafos: [texto],
    botao: { texto: traduzir("Reativar plano", idioma), url: opts.url },
  });

  return { subject: paraAssunto(titulo), html, text };
}
