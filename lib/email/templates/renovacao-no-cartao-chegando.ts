/**
 * COB-04, renovação no cartão chegando: aviso de que o plano com cobrança automática no cartão vai renovar em
 * alguns dias. Diferente de `renovacao-do-plano.ts`, que é o aviso do plano que NÃO renova sozinho.
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

export const ID_DO_EMAIL = "COB-04";

export interface RenovacaoNoCartaoChegandoEmailOptions extends OpcoesBaseDoEmail {
  plano: string;
  /** Centavos. */
  valor: number;
  /** ISO. O dia em que o cartão será cobrado. */
  cobrancaEm: string;
  /**
   * Os últimos dígitos do cartão (`4242`). O CRM não guarda o cartão (quem guarda é o Asaas), então quem
   * chama costuma não ter: sem ele, a linha "Cartão" some e o texto fala do "cartão cadastrado".
   */
  cartaoFinal?: string;
  /** Dias até a cobrança. 1 sai no singular. */
  dias: number;
}

export function buildRenovacaoNoCartaoChegandoEmail(opts: RenovacaoNoCartaoChegandoEmailOptions): {
  subject: string;
  html: string;
  text: string;
} {
  const { idioma, marca } = opts;
  const valor = formatarReais(opts.valor);
  const data = formatarData(opts.cobrancaEm);
  const final = opts.cartaoFinal
    ? preencher(traduzir("final {final}", idioma), { final: opts.cartaoFinal })
    : null;

  const titulo =
    opts.dias === 1
      ? traduzir("Seu plano renova em 1 dia", idioma)
      : preencher(traduzir("Seu plano renova em {dias} dias", idioma), { dias: opts.dias });
  const texto = final
    ? preencher(
        traduzir(
          "No dia {data} vamos cobrar {valor} no cartão {final} para renovar o plano {plano}. Para trocar o cartão ou cancelar, use o botão abaixo.",
          idioma,
        ),
        { data, valor, final, plano: opts.plano },
      )
    : preencher(
        traduzir(
          "No dia {data} vamos cobrar {valor} no cartão cadastrado para renovar o plano {plano}. Para trocar o cartão ou cancelar, use o botão abaixo.",
          idioma,
        ),
        { data, valor, plano: opts.plano },
      );

  const { html, text } = montarEmailTransacional({
    marca,
    idioma,
    empresa: opts.empresa,
    faixaDoOperador: opts.faixaDoOperador,
    selo: { texto: traduzir("Renovação automática", idioma), tom: "info" },
    titulo,
    paragrafos: [texto],
    resumo: [
      { rotulo: traduzir("Plano", idioma), valor: opts.plano },
      { rotulo: traduzir("Valor", idioma), valor },
      { rotulo: traduzir("Data da cobrança", idioma), valor: data },
      ...(final ? [{ rotulo: traduzir("Cartão", idioma), valor: final }] : []),
    ],
    botao: { texto: traduzir("Gerenciar plano", idioma), url: opts.url },
  });

  return { subject: paraAssunto(titulo), html, text };
}
