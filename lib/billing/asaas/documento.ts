import "server-only";

/**
 * Validação de CPF/CNPJ por dígito verificador: fase F5, Tarefa 10.
 *
 * Usado no formulário da primeira compra (decisão 16: o documento só passa
 * pelo servidor a caminho do `POST /customers`, nunca fica em
 * `billing_customers`). Confere o dígito verificador ANTES de gastar uma
 * chamada de rede com um documento obviamente inválido. O Asaas também
 * valida do lado dele, mas devolver o erro sem sair do processo é mais rápido
 * e não arrisca vazar o CPF/CNPJ inválido num log de erro de rede.
 */

function apenasDigitos(valor: string): string {
  return valor.replace(/\D/g, "");
}

function todosIguais(digitos: string): boolean {
  return /^(\d)\1*$/.test(digitos);
}

/** Módulo 11 do CPF: pesos de `ate+1` até 2, resto*10 mod 11, 10 vira 0. */
function digitoVerificadorCpf(digitos: string, ate: number): number {
  let soma = 0;
  let peso = ate + 1;
  for (let i = 0; i < ate; i++) {
    soma += Number(digitos[i]) * peso;
    peso -= 1;
  }
  const resto = (soma * 10) % 11;
  return resto === 10 ? 0 : resto;
}

export function cpfValido(valor: string): boolean {
  const digitos = apenasDigitos(valor);
  if (digitos.length !== 11) return false;
  // 000.000.000-00, 111.111.111-11 etc. têm dígito verificador matematicamente
  // "válido" pelo algoritmo abaixo e são o erro de digitação mais comum.
  if (todosIguais(digitos)) return false;
  const dv1 = digitoVerificadorCpf(digitos, 9);
  if (dv1 !== Number(digitos[9])) return false;
  const dv2 = digitoVerificadorCpf(digitos, 10);
  return dv2 === Number(digitos[10]);
}

const PESOS_CNPJ_DV1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
const PESOS_CNPJ_DV2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

function digitoVerificadorCnpj(digitos: string, pesos: number[]): number {
  let soma = 0;
  for (let i = 0; i < pesos.length; i++) {
    soma += Number(digitos[i]) * pesos[i]!;
  }
  const resto = soma % 11;
  return resto < 2 ? 0 : 11 - resto;
}

export function cnpjValido(valor: string): boolean {
  const digitos = apenasDigitos(valor);
  if (digitos.length !== 14) return false;
  if (todosIguais(digitos)) return false;
  const dv1 = digitoVerificadorCnpj(digitos, PESOS_CNPJ_DV1);
  if (dv1 !== Number(digitos[12])) return false;
  const dv2 = digitoVerificadorCnpj(digitos.slice(0, 12) + String(dv1), PESOS_CNPJ_DV2);
  return dv2 === Number(digitos[13]);
}

/** CPF (11 dígitos) ou CNPJ (14 dígitos); qualquer outro comprimento é inválido. */
export function documentoValido(valor: string): boolean {
  const digitos = apenasDigitos(valor);
  if (digitos.length === 11) return cpfValido(digitos);
  if (digitos.length === 14) return cnpjValido(digitos);
  return false;
}
