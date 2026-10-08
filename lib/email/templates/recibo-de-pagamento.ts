/**
 * COB-03, recibo: comprovante de um pagamento recebido (à vista ou uma parcela). Dinheiro chega em centavos e
 * sai em reais (`R$ 349,66`); datas chegam ISO e saem `dd/mm/aaaa`.
 */
import { traduzir } from "@/lib/i18n/dicionario";

import {
  formatarData,
  formatarReais,
  montarEmailTransacional,
  paraAssunto,
  preencher,
  rotuloDaForma,
  type FormaDePagamento,
  type OpcoesBaseDoEmail,
} from "./_layout-transacional";

export const ID_DO_EMAIL = "COB-03";

export interface ReciboDePagamentoEmailOptions extends OpcoesBaseDoEmail {
  /** Centavos. */
  valor: number;
  /** ISO. Quando o pagamento foi recebido. */
  pagoEm: string;
  plano: string;
  /** ISO. Início e fim do período que o pagamento cobre. */
  periodoInicio: string;
  periodoFim: string;
  formaDePagamento: FormaDePagamento;
  /** Só no parcelado: "2 de 6". */
  parcela?: { numero: number; total: number };
}

export function buildReciboDePagamentoEmail(opts: ReciboDePagamentoEmailOptions): {
  subject: string;
  html: string;
  text: string;
} {
  const { idioma, marca } = opts;
  const valor = formatarReais(opts.valor);
  const pagoEm = formatarData(opts.pagoEm);
  const periodo = preencher(traduzir("{inicio} a {fim}", idioma), {
    inicio: formatarData(opts.periodoInicio),
    fim: formatarData(opts.periodoFim),
  });

  const titulo = preencher(traduzir("Recibo do seu pagamento de {valor}", idioma), { valor });
  const texto = preencher(
    traduzir(
      "Pagamento de {valor} recebido em {data}, referente a {plano} ({periodo}). Guarde este e-mail como comprovante.",
      idioma,
    ),
    { valor, data: pagoEm, plano: opts.plano, periodo },
  );

  const { html, text } = montarEmailTransacional({
    marca,
    idioma,
    empresa: opts.empresa,
    faixaDoOperador: opts.faixaDoOperador,
    selo: { texto: traduzir("Recibo", idioma), tom: "sucesso" },
    titulo,
    paragrafos: [texto],
    resumo: [
      { rotulo: traduzir("Valor", idioma), valor },
      { rotulo: traduzir("Data do pagamento", idioma), valor: pagoEm },
      { rotulo: traduzir("Plano", idioma), valor: opts.plano },
      { rotulo: traduzir("Período", idioma), valor: periodo },
      {
        rotulo: traduzir("Forma de pagamento", idioma),
        valor: rotuloDaForma(opts.formaDePagamento, idioma),
      },
      ...(opts.parcela
        ? [
            {
              rotulo: traduzir("Parcela", idioma),
              valor: preencher(traduzir("{n} de {total}", idioma), {
                n: opts.parcela.numero,
                total: opts.parcela.total,
              }),
            },
          ]
        : []),
    ],
    botao: { texto: traduzir("Ver pagamentos", idioma), url: opts.url },
  });

  return { subject: paraAssunto(titulo), html, text };
}
