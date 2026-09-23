/**
 * A decisão "a aba Plano pode mostrar os controles de escrita?" (fase F1,
 * correção da revisão).
 *
 * ═══ Por que isto é uma função pura, fora do Server Component ═══
 *
 * `page.tsx` faz quatro leituras em paralelo (o plano efetivo via
 * `planoDaOrganizacao`, os limites crus do plano contratado, o ajuste, e a
 * lista de planos ativos). Antes desta correção, só o erro da primeira virava
 * `leituraFalhou`: se qualquer uma das outras três falhasse, a tela abria como
 * se tudo estivesse certo, com os campos de ajuste em "herdar", porque
 * `ajusteAtual` cai para `{}` quando a leitura falha. Um admin que mudasse UMA
 * chave e clicasse "Salvar ajuste" gravaria só o que veio do formulário: o
 * upsert de `fn_billing_ajustar_limites` substitui o objeto inteiro, então as
 * chaves que a tela nunca leu de verdade seriam apagadas sem ninguém decidir
 * isso.
 *
 * A régua: qualquer leitura que falhou impede a escrita, do mesmo jeito que o
 * escopo `support_readonly` impede. Os dois casos usam o mesmo efeito visual
 * (`podeEscrever = false`), porque os dois têm a mesma causa raiz: a tela não
 * tem certeza do estado atual.
 */

export interface LeiturasDaAbaDePlano {
  /** `leituraFalhou` que `planoDaOrganizacao` devolveu. */
  leituraDoPlanoFalhou: boolean;
  /** Erro ao ler os limites crus do plano contratado (`billing_contracts → billing_plans.limits`). */
  leituraDosLimitesDoPlanoFalhou: boolean;
  /** Erro ao ler o ajuste da organização (`billing_plan_adjustments`). */
  leituraDoAjusteFalhou: boolean;
  /** Erro ao ler a lista de planos ativos (`billing_plans`, para o seletor de troca). */
  leituraDosPlanosAtivosFalhou: boolean;
}

/** Verdadeiro quando QUALQUER uma das quatro leituras da aba falhou. */
export function algumaLeituraFalhou(leituras: LeiturasDaAbaDePlano): boolean {
  return (
    leituras.leituraDoPlanoFalhou ||
    leituras.leituraDosLimitesDoPlanoFalhou ||
    leituras.leituraDoAjusteFalhou ||
    leituras.leituraDosPlanosAtivosFalhou
  );
}

/**
 * A tela pode mostrar os controles de escrita (trocar plano, ajustar limites)
 * quando o escopo do admin é `full` E as quatro leituras vieram certas. Sem
 * as duas condições, a tela mostra só leitura: mesmo efeito visual, seja qual
 * for a causa.
 */
export function podeEscreverNaAba(escopoDoAdmin: string, leituras: LeiturasDaAbaDePlano): boolean {
  if (escopoDoAdmin !== "full") return false;
  return !algumaLeituraFalhou(leituras);
}
