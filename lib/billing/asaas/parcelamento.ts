/**
 * A conta do parcelamento do semestral e do anual no cartão (D-177, parte 1). Pura, sem I/O e sem
 * `server-only`: a página (servidor) monta as opções da tela com ela, `iniciarCompra` calcula o total
 * que manda ao Asaas, e a função `fn_billing_parcelamento_total` do banco (migration 0945) refaz a
 * mesma conta para conferir o pedido. As duas pontas têm que dar o mesmo centavo (o teste de banco
 * compara as duas).
 *
 * Regras decididas pelo Filipe em 06/10/2026:
 * - só cartão; semestral de 1x a 6x e anual de 1x a 12x, em todos os planos; mensal não parcela;
 * - 1x, 2x e 3x sem juros: o total é o preço do ciclo e a Hiperbold arca com a taxa do cartão;
 * - de 4x em diante, juros de 1,99% ao mês pagos pelo comprador, Tabela Price:
 *   parcela = preço x i / (1 - (1 + i)^-n), arredondada ao centavo (half-up), total = parcela x n.
 *
 * Os parâmetros (taxa, até quantas parcelas sem juros, tetos) moram em `billing_settings`, semeados uma
 * vez pela migration; nada daqui é lido do navegador. Parâmetro nulo (admin zerou) desliga o
 * parcelamento: só sobra o 1x.
 *
 * Arredondamento do Asaas (documentação: "quando `totalValue` não puder ser dividido igualmente, a
 * diferença será aplicada à última parcela"): `dividirTotalEmParcelas` assume parcela arredondada ao
 * centavo mais próximo e o resto na última (3x de R$ 1.049,00 = 349,67 + 349,67 + 349,66). A documentação
 * não diz se o Asaas arredonda ou trunca a parcela; a etapa de homologação do sandbox imprime as parcelas
 * reais para conferir.
 */

export type CicloParcelavel = "semiannual" | "yearly";

export interface ParametrosDeParcelamento {
  /** Taxa de juros ao mês, em fração (0,0199 = 1,99%). */
  taxaMensal: number | null;
  /** Até quantas parcelas o total é o preço do ciclo, sem juros. */
  semJurosAte: number | null;
  maxSemestral: number | null;
  maxAnual: number | null;
}

export interface ResultadoDoParcelamento {
  parcelas: number;
  /** O que o Asaas cobra em cada parcela (das 1 a n-1). */
  parcelaCents: number;
  /** A última parcela: igual às outras com juros, e com a sobra do arredondamento sem juros. */
  ultimaParcelaCents: number;
  /** O que o comprador paga no total: o `totalValue` enviado ao Asaas e o `amount_cents` do pedido. */
  totalCents: number;
  comJuros: boolean;
}

/** Teto de parcelas do ciclo; 1 quando o parâmetro está ausente (só à vista). */
export function maximoDeParcelas(ciclo: CicloParcelavel, parametros: ParametrosDeParcelamento): number {
  const teto = ciclo === "semiannual" ? parametros.maxSemestral : parametros.maxAnual;
  return teto !== null && Number.isInteger(teto) && teto >= 1 ? teto : 1;
}

/** Número inteiro de 1 até o teto do ciclo. */
export function parcelasValidas(ciclo: CicloParcelavel, parcelas: number, parametros: ParametrosDeParcelamento): boolean {
  return Number.isInteger(parcelas) && parcelas >= 1 && parcelas <= maximoDeParcelas(ciclo, parametros);
}

/** Half-up ao centavo (os valores aqui são sempre positivos). */
function arredondar(valor: number): number {
  return Math.round(valor);
}

/**
 * Como o Asaas reparte o `totalValue` em parcelas: as n-1 primeiras arredondadas ao centavo, e a última
 * leva a diferença (pode ser 1 ou 2 centavos a menos ou a mais).
 */
export function dividirTotalEmParcelas(totalCents: number, parcelas: number): { parcelaCents: number; ultimaParcelaCents: number } {
  const parcelaCents = arredondar(totalCents / parcelas);
  return { parcelaCents, ultimaParcelaCents: totalCents - parcelaCents * (parcelas - 1) };
}

/**
 * A conta de UM número de parcelas para o preço do ciclo. Lança em número de parcelas que não é inteiro
 * a partir de 1: quem chama valida o teto do ciclo antes (`parcelasValidas`).
 */
export function calcularParcelamento(
  precoCents: number,
  parcelas: number,
  parametros: ParametrosDeParcelamento,
): ResultadoDoParcelamento {
  if (!Number.isInteger(parcelas) || parcelas < 1) {
    throw new Error("parcelamento: número de parcelas inválido");
  }
  const semJuros =
    parcelas === 1 ||
    parametros.taxaMensal === null ||
    parametros.taxaMensal <= 0 ||
    parcelas <= (parametros.semJurosAte ?? 1);

  if (semJuros) {
    return { parcelas, ...dividirTotalEmParcelas(precoCents, parcelas), totalCents: precoCents, comJuros: false };
  }

  const i = parametros.taxaMensal as number;
  const parcelaCents = arredondar((precoCents * i) / (1 - Math.pow(1 + i, -parcelas)));
  return {
    parcelas,
    parcelaCents,
    ultimaParcelaCents: parcelaCents,
    totalCents: parcelaCents * parcelas,
    comJuros: true,
  };
}

export type OpcaoDeParcelas = ResultadoDoParcelamento;

/** As opções da tela: de 1x até o teto do ciclo, cada uma com a parcela, a última e o total. */
export function opcoesDeParcelamento(
  precoCents: number,
  ciclo: CicloParcelavel,
  parametros: ParametrosDeParcelamento,
): OpcaoDeParcelas[] {
  const teto = maximoDeParcelas(ciclo, parametros);
  const opcoes: OpcaoDeParcelas[] = [];
  for (let n = 1; n <= teto; n += 1) {
    opcoes.push(calcularParcelamento(precoCents, n, parametros));
  }
  return opcoes;
}
