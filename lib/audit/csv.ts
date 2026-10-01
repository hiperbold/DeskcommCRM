/**
 * Escape de célula do CSV de auditoria.
 *
 * Planilha interpreta como fórmula a célula que começa com `=`, `+`, `-`, `@`, tab ou CR.
 * O audit grava texto que o cliente controla (o `x-request-id` que a rota repassa, nomes
 * de recurso), e quem exporta abre o arquivo no Excel ou no Sheets: a célula `=HYPERLINK(...)`
 * rodava (D-107). Esses valores levam um `'` na frente, que a planilha mostra como texto.
 */
export function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s = typeof v === "string" ? v : JSON.stringify(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
