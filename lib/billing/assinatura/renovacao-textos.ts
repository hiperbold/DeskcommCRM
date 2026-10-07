/**
 * Os textos da régua de aviso de renovação (D-177, parte 2, migration 0946): o título e o corpo do aviso na
 * Central e o assunto e o corpo do e-mail. Os dois canais dizem a MESMA coisa, então saem do mesmo lugar.
 *
 * O texto não carrega preço nem condição de pagamento além do que já é decidido e dito na tela de assinar
 * (cartão com renovação automática, Pix, e parcelado no cartão nos planos semestral e anual): quem decide
 * valor é a tela, com o catálogo na mão.
 *
 * Idioma: a chave é o texto em português (`lib/i18n/dicionario.ts`) e a tradução entra em `traduzir`.
 * O catálogo `lib/i18n/traducoes/zh-CN.json` também recebe as frases, para o dia em que o chinês deixar
 * de ser `em_construcao`; hoje `Idioma` só serve pt-BR e es.
 *
 * A quantidade de dias que o texto diz é a REAL (dias até o último dia de acesso na hora do envio), não a
 * do marco: um job atrasado que manda o marco de 30 dias com 27 dias restantes diz 27.
 */
import { traduzir } from "@/lib/i18n/dicionario";
import { IDIOMAS, type Idioma } from "@/lib/i18n/idiomas";

/** Os marcos da régua, em dias até o último dia de acesso. 0 é o próprio último dia. */
export const MARCOS_DA_RENOVACAO = [30, 15, 7, 1, 0] as const;
export type MarcoDaRenovacao = (typeof MARCOS_DA_RENOVACAO)[number];

/** 30 e 15 dias só informam; 7, 1 e o dia pedem ação. */
export function severidadeDoMarco(marco: MarcoDaRenovacao): "info" | "warn" {
  return marco >= 15 ? "info" : "warn";
}

/**
 * O idioma de quem recebe: preferência da pessoa, depois o idioma da organização, depois o padrão (a mesma
 * cadeia da interface, `lib/auth/server.ts`). Valor que o produto não serve cai para o próximo da cadeia.
 */
export function idiomaDoDestinatario(preferenciaDaPessoa: string | null, idiomaDaOrganizacao: string | null): Idioma {
  for (const candidato of [preferenciaDaPessoa, idiomaDaOrganizacao]) {
    if (candidato && (IDIOMAS as readonly string[]).includes(candidato)) return candidato as Idioma;
  }
  return "pt-BR";
}

/** `2026-11-30` (a data civil de São Paulo que o banco devolve) como `30/11/2026`, o formato de pt-BR e de es. */
export function formatarDia(dia: string): string {
  const [ano, mes, diaDoMes] = dia.slice(0, 10).split("-");
  if (!ano || !mes || !diaDoMes) return dia;
  return `${diaDoMes}/${mes}/${ano}`;
}

export interface DadosDoTextoDeRenovacao {
  planoNome: string;
  /** `YYYY-MM-DD`, o último dia de acesso. */
  ultimoDia: string;
  /** Dias até o último dia de acesso na hora do envio. */
  diasRestantes: number;
  idioma: Idioma;
}

/** O título do aviso e o assunto do e-mail. */
export function tituloDaRenovacao(dados: DadosDoTextoDeRenovacao): string {
  const { idioma, planoNome, diasRestantes } = dados;
  if (diasRestantes <= 0) {
    return traduzir("Hoje é o último dia do seu plano {plano}", idioma).replace("{plano}", () => planoNome);
  }
  if (diasRestantes === 1) {
    return traduzir("Falta 1 dia para o fim do seu plano {plano}", idioma).replace("{plano}", () => planoNome);
  }
  return traduzir("Faltam {dias} dias para o fim do seu plano {plano}", idioma)
    .replace("{dias}", String(diasRestantes))
    .replace("{plano}", () => planoNome);
}

/** O corpo do aviso e o parágrafo do e-mail. */
export function corpoDaRenovacao(dados: DadosDoTextoDeRenovacao): string {
  return traduzir(
    "O acesso vai até {data} e este plano não renova sozinho: nada é cobrado sem a sua confirmação. Para continuar sem interrupção, faça uma nova compra em Plano e uso. Você escolhe como pagar: à vista no cartão (com renovação automática) ou no Pix, e, nos planos semestral e anual, parcelado no cartão.",
    dados.idioma,
  ).replace("{data}", formatarDia(dados.ultimoDia));
}

/** O texto do botão do e-mail. */
export function botaoDaRenovacao(idioma: Idioma): string {
  return traduzir("Renovar meu plano", idioma);
}
