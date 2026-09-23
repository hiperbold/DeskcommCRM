/**
 * O conjunto fechado de chaves de limite do plano (fase F1).
 *
 * A lista, o teto e a validação espelham `fn_billing_limites_validos` da
 * migration `supabase/migrations/20260923020000_0904_planos_de_assinatura.sql`
 * (hiperbold/planos/fase-F1-tarefas.md, decisão de desenho 4): chave nova
 * exige migração que acrescente a chave a todos os planos, porque limitar um
 * item novo sempre exige código de contagem na F2.
 *
 * O que NÃO está aqui, de propósito: a função de precedência entre plano e
 * ajuste. Ela mora em UMA função SQL, `fn_billing_limites_efetivos`, estável,
 * chamada por RPC, uma segunda implementação em TypeScript é exatamente a
 * duplicação que a revisão da fase proibiu (decisão de desenho 9).
 */
import { z } from "zod";

/** As sete chaves de teto, na mesma ordem da migration e da tabela semeada. */
export const CHAVES_DE_LIMITE = [
  "funis",
  "etapas_por_funil",
  "leads",
  "membros",
  "conexoes",
  "integracoes_webhook",
  "tokens_ia_mes",
] as const;

export type ChaveDeLimite = (typeof CHAVES_DE_LIMITE)[number];

/** Cada chave: um inteiro >= 0, ou `null` significando sem limite. */
export type Limites = Record<ChaveDeLimite, number | null>;

/** O maior inteiro que a coluna `integer` do Postgres aceita. */
export const TETO_DE_LIMITE = 2147483647;

const valorDeLimite = z.number().int().min(0).max(TETO_DE_LIMITE).nullable();

const formaDoObjetoDeLimites = Object.fromEntries(
  CHAVES_DE_LIMITE.map((chave) => [chave, valorDeLimite]),
) as Record<ChaveDeLimite, typeof valorDeLimite>;

/**
 * O esquema do PLANO: as sete chaves, todas obrigatórias. Espelha
 * `fn_billing_limites_validos(limits, parcial := false)`.
 */
export const esquemaDoPlanoDeLimites = z.object(formaDoObjetoDeLimites).strict();

/**
 * O esquema do AJUSTE: qualquer subconjunto das sete chaves, inclusive vazio.
 * Espelha `fn_billing_limites_validos(limits, parcial := true)`.
 */
export const esquemaDoAjusteDeLimites = z.object(formaDoObjetoDeLimites).partial().strict();

export type AjusteDeLimites = z.infer<typeof esquemaDoAjusteDeLimites>;
