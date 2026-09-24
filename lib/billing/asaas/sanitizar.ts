import "server-only";

/**
 * Sanitização do payload do webhook do Asaas antes de guardar: fase F5,
 * Tarefa 12, decisão 19.
 *
 * Remove `creditCard`, `creditCardToken`, `creditCardHolderInfo` e qualquer
 * chave cujo nome contenha "card" (sem diferenciar maiúscula de minúscula,
 * para pegar variações que o Asaas venha a acrescentar), em QUALQUER
 * profundidade do objeto: o manual não garante onde esses campos aparecem
 * dentro do envelope, e o corte precisa valer também dentro de sub-objetos e
 * dentro de itens de array.
 *
 * Não é o schema zod (`contratos.ts`): o schema valida os campos que o app
 * LÊ; esta função varre tudo o que o Asaas mandou, inclusive campos que o app
 * nunca olha, porque o que é guardado em `asaas_webhook_events.payload` é o
 * corpo inteiro (sanitizado), não só os campos conhecidos.
 */

function nomeSuspeito(chave: string): boolean {
  return chave.toLowerCase().includes("card");
}

/**
 * Sanitiza recursivamente. Aceita qualquer valor vindo de `JSON.parse`
 * (objeto, array, primitivo) e devolve uma cópia nova, sem os campos
 * sensíveis - o valor original nunca é mutado.
 */
export function sanitizarPayloadAsaas(valor: unknown): unknown {
  if (Array.isArray(valor)) {
    return valor.map((item) => sanitizarPayloadAsaas(item));
  }

  if (valor !== null && typeof valor === "object") {
    const saida: Record<string, unknown> = {};
    for (const [chave, item] of Object.entries(valor as Record<string, unknown>)) {
      if (nomeSuspeito(chave)) continue;
      saida[chave] = sanitizarPayloadAsaas(item);
    }
    return saida;
  }

  return valor;
}
