/**
 * A versão VIGENTE dos Termos de Uso (`app/legal/terms/page.tsx`).
 *
 * Fonte única: a tela de compra (`/app/settings/plano/assinar`) manda esta versão junto com o
 * aceite, o servidor recusa a compra sem ela ou com versão velha, e o pedido (`billing_orders.
 * termos_versao`, com `termos_aceitos_em`) e o onboarding (`onboarding_state.welcome.terms_version`)
 * guardam qual texto a pessoa aceitou. Sem a versão, "aceitou os Termos" não diz o que foi aceito
 * quando o texto muda.
 *
 * Mude esta data (AAAA-MM-DD, o dia em que o texto novo passou a valer) SEMPRE que o conteúdo dos
 * Termos mudar de forma que importe: o teste `tests/unit/versao-dos-termos.test.ts` guarda a
 * impressão digital do arquivo da página e falha quando o texto muda sem a versão acompanhar.
 */
export const VERSAO_DOS_TERMOS = "2026-09-23";
