/**
 * IA-02, tokens de IA acabando: dois níveis, 80% (alerta) e 100% (perigo). A barra e o texto falam do limiar que
 * disparou o aviso; o detalhe abaixo da barra traz o uso (`usados` de `total`) medido quando o aviso foi enfileirado.
 *
 * O texto acompanha o MODO do sistema (`billing_settings.modo`, decisão do dono em IA-02): com o sistema só
 * avisando (`avisar`) a IA continua respondendo, então o e-mail NUNCA diz que ela parou; só com `bloquear`
 * (a IA para de responder ao esgotar a franquia) o texto fala da parada.
 */
import { traduzir } from "@/lib/i18n/dicionario";

import {
  formatarData,
  formatarInteiro,
  montarEmailTransacional,
  paraAssunto,
  preencher,
  type OpcoesBaseDoEmail,
} from "./_layout-transacional";

export const ID_DO_EMAIL = "IA-02";

/** `avisar` = a IA segue respondendo ao passar da franquia; `bloquear` = ela para. */
export type ModoDaFranquiaDeTokens = "avisar" | "bloquear";

export interface TokensDeIaAcabandoEmailOptions extends OpcoesBaseDoEmail {
  /** O nível do aviso: 80 (acabando) ou 100 (acabou). */
  nivel: 80 | 100;
  /** Tokens usados no mês. */
  usados: number;
  /** Tokens do mês (o limite do plano mais o que sobrou de pacote). */
  total: number;
  /** ISO. Quando o consumo do mês zera. */
  renovaEm: string;
  /** O modo do sistema. Ausente = `bloquear` (os textos de "a IA para"); o gatilho sempre informa. */
  modo?: ModoDaFranquiaDeTokens;
}

export function buildTokensDeIaAcabandoEmail(opts: TokensDeIaAcabandoEmailOptions): {
  subject: string;
  html: string;
  text: string;
} {
  const { idioma, marca, nivel } = opts;
  const data = formatarData(opts.renovaEm);
  const esgotou = nivel === 100;

  const soAvisa = (opts.modo ?? "bloquear") === "avisar";

  const titulo = traduzir(
    esgotou
      ? soAvisa
        ? "Seus tokens de IA do mês acabaram"
        : "Seus tokens de IA acabaram"
      : "Seus tokens de IA estão acabando",
    idioma,
  );
  const chaveDoTexto = soAvisa
    ? esgotou
      ? "A {empresa} já usou 100% dos tokens de IA do mês. Para manter o uso dentro do plano, compre um pacote extra."
      : "A {empresa} já usou 80% dos tokens de IA do mês. Para manter o uso dentro do plano, compre um pacote extra."
    : esgotou
      ? "A {empresa} já usou 100% dos tokens de IA do mês. A IA parou de responder e volta em {data} ou assim que um pacote extra for comprado."
      : "A {empresa} já usou 80% dos tokens de IA do mês. Ao chegar a 100%, a IA para de responder até {data} ou até a compra de um pacote extra.";
  const texto = preencher(traduzir(chaveDoTexto, idioma), { empresa: opts.empresa, data });

  // A barra mostra o limiar que cruzou (80 ou 100), o mesmo que o texto diz. O uso do momento em que o aviso
  // foi enfileirado aparece em "usados de total"; a razão dos dois pode divergir por pouco (um pacote comprado
  // entre o cruzamento e o aviso muda o total), e a barra não pode contradizer o título.
  const percentual = nivel;

  const { html, text } = montarEmailTransacional({
    marca,
    idioma,
    empresa: opts.empresa,
    faixaDoOperador: opts.faixaDoOperador,
    selo: { texto: traduzir("Tokens de IA", idioma), tom: esgotou ? "perigo" : "alerta" },
    titulo,
    paragrafos: [texto],
    progresso: {
      percentual,
      rotulo: traduzir("Tokens usados no mês", idioma),
      detalhe: preencher(traduzir("{usados} de {total}", idioma), {
        usados: formatarInteiro(opts.usados),
        total: formatarInteiro(opts.total),
      }),
    },
    botao: { texto: traduzir("Comprar tokens", idioma), url: opts.url },
  });

  return { subject: paraAssunto(titulo), html, text };
}
