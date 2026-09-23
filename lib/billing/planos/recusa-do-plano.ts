/**
 * "O banco recusou porque o plano acabou": reconhece o erro PT402 (fase F3,
 * decisões 3, 4 e 9 de hiperbold/planos/fase-F3-tarefas.md) e traduz para uma
 * frase fixa em português, nunca o texto cru do Postgres.
 *
 * ─── Por que dois formatos de erro ──────────────────────────────────────────
 *
 * O mesmo `raise exception ... using errcode = 'PT402', detail = '<item>'`
 * chega ao Node por DOIS clientes diferentes, cada um com o campo do item em
 * um nome:
 *
 *   - `@supabase/supabase-js` (PostgrestError): `code` e `details` (COM "s" —
 *     é o nome do campo da classe, ver node_modules/.pnpm/@supabase+postgrest-js@2.116.0
 *     /node_modules/@supabase/postgrest-js/src/PostgrestError.ts);
 *   - `pg` (DatabaseError, usado pelos caminhos por `pg.Pool`): `code` e
 *     `detail` (SEM "s" — é o nome do campo DETAIL do protocolo do Postgres,
 *     ver node_modules/.pnpm/pg-protocol@1.16.0/.../messages.d.ts).
 *
 * A decisão 9 da fase é explícita: reconhecer pelo `code === 'PT402'`, nunca
 * pelo status HTTP (os caminhos por `pg.Pool` não têm status nenhum). Por
 * isso esta função lê os dois nomes de campo e nunca olha para `status`.
 */

/** Os cinco itens que esta tarefa trata (leads fica para a Tarefa 7, fora daqui). */
export const ITENS_RECUSADOS_PELO_PLANO = [
  "funis",
  "etapas_por_funil",
  "conexoes",
  "integracoes_webhook",
  "membros",
] as const;

export type ItemRecusadoPeloPlano = (typeof ITENS_RECUSADOS_PELO_PLANO)[number];

/** Status HTTP fixo de toda recusa do plano — "Payment Required". */
export const STATUS_RECUSA_DO_PLANO = 402;

/** O código de erro que a API expõe para esta família (ver lib/api/errors.ts). */
export const CODIGO_RECUSA_DO_PLANO = "plano_limite_atingido";

/**
 * Uma frase fixa por item, nunca o `message`/`detail` do Postgres. O texto do
 * banco ("Limite do plano atingido") é para log e depuração; quem lê a tela
 * precisa saber QUAL limite e ser orientado a falar com o suporte.
 */
const MENSAGEM_POR_ITEM: Record<ItemRecusadoPeloPlano, string> = {
  funis: "O plano desta organização chegou ao limite de funis. Fale com o suporte para ampliar.",
  etapas_por_funil:
    "O plano desta organização chegou ao limite de etapas por funil. Fale com o suporte para ampliar.",
  conexoes:
    "O plano desta organização chegou ao limite de conexões. Fale com o suporte para ampliar.",
  integracoes_webhook:
    "O plano desta organização chegou ao limite de integrações de webhook. Fale com o suporte para ampliar.",
  membros: "O plano desta organização chegou ao limite de membros. Fale com o suporte para ampliar.",
};

/** Mensagem para um `detail` que não é nenhum dos cinco itens conhecidos (defensivo). */
const MENSAGEM_GENERICA =
  "O plano desta organização chegou a um limite contratado. Fale com o suporte para ampliar.";

export interface RecusaDoPlano {
  /** O item do teto, quando reconhecido; `null` se o `detail` não bateu com nenhum. */
  item: ItemRecusadoPeloPlano | null;
  /** Frase fixa em português, pronta para a tela — nunca o texto do Postgres. */
  mensagem: string;
}

function ehItemConhecido(valor: unknown): valor is ItemRecusadoPeloPlano {
  return (
    typeof valor === "string" &&
    (ITENS_RECUSADOS_PELO_PLANO as readonly string[]).includes(valor)
  );
}

/**
 * Reconhece um erro de banco como recusa do plano (PT402) e devolve a frase
 * fixa, ou `null` quando o erro não é isso (o chamador deve seguir tratando
 * como antes: outro erro, passa adiante).
 *
 * Aceita `unknown` de propósito: o erro pode vir de `supabase-js`
 * (`{ code, details }`), de `pg` (`{ code, detail }`) ou de qualquer outra
 * forma — só o `code === 'PT402'` importa, o resto é defensivo.
 */
export function recusaDoPlano(erro: unknown): RecusaDoPlano | null {
  if (!erro || typeof erro !== "object") return null;

  const registro = erro as Record<string, unknown>;
  if (registro.code !== "PT402") return null;

  // supabase-js: `details` (com "s"); pg: `detail` (sem "s"). Nunca repassar
  // o valor cru na mensagem — só usar para ESCOLHER a frase fixa.
  const detalhe = registro.details ?? registro.detail;
  const item = ehItemConhecido(detalhe) ? detalhe : null;

  return {
    item,
    mensagem: item ? MENSAGEM_POR_ITEM[item] : MENSAGEM_GENERICA,
  };
}
