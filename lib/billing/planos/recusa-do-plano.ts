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

/**
 * Os seis itens que esta função reconhece. `leads` entrou na Tarefa 7 (F3,
 * decisão 5): o gatilho `trg_crm_leads_billing_bloqueio` (migration 0907,
 * parte 4) levanta o mesmo PT402 com `detail = 'leads'` em toda criação ou
 * reabertura de lead acima do teto, de qualquer origem.
 */
export const ITENS_RECUSADOS_PELO_PLANO = [
  "funis",
  "etapas_por_funil",
  "conexoes",
  "integracoes_webhook",
  "membros",
  "leads",
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
  // D-188: Conexões bloqueia sempre e vale para todos os canais; a frase com o limite e o plano reais vem de
  // `mensagemDaRecusaDoPlano` (limite-de-conexoes.ts). Esta é a versão sem número, para quem não tem o cliente.
  conexoes: "Sua conta atingiu o limite de conexões do plano. Remova uma conexão ou mude de plano.",
  integracoes_webhook:
    "O plano desta organização chegou ao limite de integrações de webhook. Fale com o suporte para ampliar.",
  membros: "O plano desta organização chegou ao limite de membros. Fale com o suporte para ampliar.",
  leads: "O plano desta organização chegou ao limite de leads. Fale com o suporte para ampliar.",
};

/** Mensagem para um `detail` que não é nenhum dos itens conhecidos (defensivo). */
const MENSAGEM_GENERICA =
  "O plano desta organização chegou a um limite contratado. Fale com o suporte para ampliar.";

/**
 * Fase F4, tarefa 2, decisão 7: `detail = 'assinatura_suspensa'`. Os quatro
 * gatilhos de criação (funis, etapas, integrações webhook, convites, migração
 * 0908 parte 2) levantam o MESMO PT402, mas o motivo não é um teto do plano
 * contratado, é a conta suspensa por falta de pagamento. Frase própria, nunca
 * a genérica de teto (que diria "aumente seu plano" para quem não tem o que
 * aumentar).
 */
const MENSAGEM_ASSINATURA_SUSPENSA =
  "A conta está suspensa por falta de pagamento: criar funis, etapas, integrações e convites fica parado até a assinatura ser regularizada. Fale com o suporte.";

export interface RecusaDoPlano {
  /**
   * O item do teto, quando reconhecido; `null` se o `detail` não bateu com
   * nenhum item de teto, inclusive quando `suspensa` é `true` (a conta
   * suspensa NÃO é um item de teto do plano, ver `suspensa` abaixo).
   */
  item: ItemRecusadoPeloPlano | null;
  /**
   * `true` só para `detail = 'assinatura_suspensa'`. Campo separado de
   * `item` DE PROPÓSITO (fase F4, tarefa 2): quem lê `item` para decidir uma
   * tela de "aumente seu plano" ou um contador de uso não pode confundir a
   * conta suspensa com um teto do plano contratado: são causas e remédios
   * diferentes (pagar o que está atrasado vs. contratar mais).
   */
  suspensa: boolean;
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

  if (detalhe === "assinatura_suspensa") {
    return { item: null, suspensa: true, mensagem: MENSAGEM_ASSINATURA_SUSPENSA };
  }

  const item = ehItemConhecido(detalhe) ? detalhe : null;

  return {
    item,
    suspensa: false,
    mensagem: item ? MENSAGEM_POR_ITEM[item] : MENSAGEM_GENERICA,
  };
}
