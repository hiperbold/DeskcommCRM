/**
 * Confere a forma do que um cursor decodificado traz antes de ele entrar numa
 * expressão `.or()` do PostgREST como texto (D-165).
 *
 * O cursor é base64 de um JSON que o cliente devolve; nada garante que o
 * servidor foi quem o gerou. Uma vírgula ou um parêntese no valor acrescentaria
 * condição ao filtro (o `eq(organization_id)` e a RLS contêm o estrago, mas a
 * regra é não depender disso).
 */
const INSTANTE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}(:?\d{2})?)?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Data/hora ISO ou no formato do Postgres (`2026-09-30 10:00:00.123+00`). */
export function ehInstante(valor: unknown): valor is string {
  if (typeof valor !== "string" || !INSTANTE.test(valor)) return false;
  // `Date.parse` do JS não lê o fuso curto do Postgres (`+00`): completa para `+00:00`.
  const normal = valor.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00").replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  return !Number.isNaN(Date.parse(normal));
}

export function ehUuid(valor: unknown): valor is string {
  return typeof valor === "string" && UUID.test(valor);
}
