/**
 * COB-08, estorno feito: devolvemos um valor. O prazo para aparecer na fatura depende do banco ou do cartão.
 */
import { traduzir } from "@/lib/i18n/dicionario";

import {
  formatarData,
  formatarReais,
  montarEmailTransacional,
  paraAssunto,
  preencher,
  type OpcoesBaseDoEmail,
} from "./_layout-transacional";

export const ID_DO_EMAIL = "COB-08";

export interface EstornoFeitoEmailOptions extends OpcoesBaseDoEmail {
  /** Centavos. */
  valor: number;
  plano: string;
  /** ISO. Quando o estorno foi feito. */
  estornadoEm: string;
}

export function buildEstornoFeitoEmail(opts: EstornoFeitoEmailOptions): {
  subject: string;
  html: string;
  text: string;
} {
  const { idioma, marca } = opts;
  const valor = formatarReais(opts.valor);

  const titulo = preencher(traduzir("Estorno de {valor} feito", idioma), { valor });
  const texto = preencher(
    traduzir(
      "Estornamos {valor} referente a {plano}. O prazo para aparecer na fatura depende do seu banco ou cartão.",
      idioma,
    ),
    { valor, plano: opts.plano },
  );

  const { html, text } = montarEmailTransacional({
    marca,
    idioma,
    empresa: opts.empresa,
    faixaDoOperador: opts.faixaDoOperador,
    selo: { texto: traduzir("Estorno", idioma), tom: "info" },
    titulo,
    paragrafos: [texto],
    resumo: [
      { rotulo: traduzir("Valor", idioma), valor },
      { rotulo: traduzir("Plano", idioma), valor: opts.plano },
      { rotulo: traduzir("Data do estorno", idioma), valor: formatarData(opts.estornadoEm) },
    ],
    botao: { texto: traduzir("Ver pagamentos", idioma), url: opts.url },
  });

  return { subject: paraAssunto(titulo), html, text };
}
