/**
 * COB-02, plano confirmado: o pagamento foi aprovado e o plano está liberado até a data. Sai para quem
 * administra a organização, uma vez por compra.
 *
 * Valores: o ciclo e a forma de pagamento chegam como código (`CicloDoPlano`, `FormaDePagamento`) e saem no
 * idioma de quem lê; a data chega ISO e sai `dd/mm/aaaa`.
 */
import { traduzir } from "@/lib/i18n/dicionario";

import {
  formatarData,
  montarEmailTransacional,
  paraAssunto,
  preencher,
  rotuloDaForma,
  rotuloDoCiclo,
  type CicloDoPlano,
  type FormaDePagamento,
  type OpcoesBaseDoEmail,
} from "./_layout-transacional";

export const ID_DO_EMAIL = "COB-02";

export interface PlanoConfirmadoEmailOptions extends OpcoesBaseDoEmail {
  plano: string;
  ciclo: CicloDoPlano;
  formaDePagamento: FormaDePagamento;
  /** ISO. O último dia de acesso pago. */
  acessoAte: string;
}

export function buildPlanoConfirmadoEmail(opts: PlanoConfirmadoEmailOptions): {
  subject: string;
  html: string;
  text: string;
} {
  const { idioma, marca } = opts;
  const ciclo = rotuloDoCiclo(opts.ciclo, idioma);
  const data = formatarData(opts.acessoAte);

  const titulo = preencher(traduzir("Seu plano {plano} está ativo", idioma), { plano: opts.plano });
  const texto = preencher(
    traduzir(
      "Recebemos o pagamento e o plano {plano} ({ciclo}) já está liberado até {data}.",
      idioma,
    ),
    { plano: opts.plano, ciclo: ciclo.toLocaleLowerCase(idioma), data },
  );

  const { html, text } = montarEmailTransacional({
    marca,
    idioma,
    empresa: opts.empresa,
    faixaDoOperador: opts.faixaDoOperador,
    selo: { texto: traduzir("Pagamento aprovado", idioma), tom: "sucesso" },
    titulo,
    paragrafos: [texto],
    resumo: [
      { rotulo: traduzir("Plano", idioma), valor: opts.plano },
      { rotulo: traduzir("Ciclo", idioma), valor: ciclo },
      {
        rotulo: traduzir("Forma de pagamento", idioma),
        valor: rotuloDaForma(opts.formaDePagamento, idioma),
      },
      { rotulo: traduzir("Acesso até", idioma), valor: data },
    ],
    botao: { texto: traduzir("Ver meu plano", idioma), url: opts.url },
  });

  return { subject: paraAssunto(titulo), html, text };
}
