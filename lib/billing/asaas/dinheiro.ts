import "server-only";

import { partesNoFuso } from "@/lib/agenda/fuso";
import { FUSO_PADRAO } from "@/lib/tempo/fusos";

/**
 * Dinheiro na fronteira com o Asaas: fase F5, decisão 15.
 *
 * O banco e o resto do app guardam CENTAVOS inteiros; o Asaas fala em REAIS
 * decimais. A conversão só acontece AQUI, na borda, e nunca por multiplicação
 * ou divisão crua de `number` de ponto flutuante. O motivo é que
 * `19990 / 100` e primos do tipo já produzem erro de arredondamento binário
 * em casos reais (ex: `0.1 + 0.2 !== 0.3`), e um centavo perdido ou ganho
 * numa cobrança é dinheiro de verdade.
 *
 * A conversão INVERSA (reais confirmados pelo Asaas -> centavos, para gravar
 * em `billing_payments`) acontece no SQL, sobre `numeric`, e não neste módulo
 * (decisão 15). Este arquivo só sabe ir de centavos para o texto que o
 * `POST` manda.
 */

/**
 * `centavosParaReais(19990)` -> `199.9`.
 *
 * Monta o valor por TEXTO (parte inteira + resto de dois dígitos), e só no
 * fim converte para `number`: o mesmo formato que `JSON.stringify` já
 * produziria para o campo `value` do Asaas. Nunca `centavos / 100` como
 * operação aritmética: aqui não existe divisão, só concatenação de dígitos já
 * inteiros.
 */
export function centavosParaReais(centavos: number): number {
  if (!Number.isInteger(centavos)) {
    throw new Error(`centavosParaReais espera um inteiro, recebeu ${centavos}`);
  }
  const negativo = centavos < 0;
  const absolutos = Math.abs(centavos);
  const parteInteira = Math.trunc(absolutos / 100);
  const parteCentavos = String(absolutos % 100).padStart(2, "0");
  const texto = `${negativo ? "-" : ""}${parteInteira}.${parteCentavos}`;
  return Number(texto);
}

/**
 * `dataSaoPaulo(hoje)` -> `"AAAA-MM-DD"`, no fuso de parede de São Paulo: o
 * formato `dueDate`/`nextDueDate` que todo `POST` financeiro do Asaas exige
 * (manual, seção 5). Reaproveita `partesNoFuso` (já usado por
 * `lib/tempo/agora.ts` e pela agenda) em vez de reimplementar a conversão de
 * fuso: o cálculo do offset de DST de São Paulo já está resolvido lá, e uma
 * segunda implementação divergiria na primeira borda de horário de verão.
 */
export function dataSaoPaulo(instante: Date): string {
  const partes = partesNoFuso(instante, FUSO_PADRAO);
  const ano = String(partes.ano).padStart(4, "0");
  const mes = String(partes.mes).padStart(2, "0");
  const dia = String(partes.dia).padStart(2, "0");
  return `${ano}-${mes}-${dia}`;
}
