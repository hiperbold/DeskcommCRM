/**
 * Portão de escrita do modo leitura para rotas de API (D-154).
 *
 * `contaEmModoLeitura` só era chamada por páginas, produtores automáticos e IA:
 * uma conta suspensa por estorno ou inadimplência seguia importando contatos,
 * produtos e lançando no financeiro por chamada direta à API. A decisão de
 * produto de 0908 ("o chat nunca para", leads continuam sendo criados) fica
 * intacta: este portão só entra nas escritas em massa e no financeiro, nunca no
 * atendimento nem na cobrança.
 *
 * Mesma resposta da recusa do plano (402 `plano_limite_atingido`), a que o
 * reenvio de automação já usa. Mesma doutrina fail-open de `contaEmModoLeitura`:
 * leitura que falha não derruba a rota (ela grita `alarme_planos_leitura`).
 */
import { fail } from "@/lib/api/wrappers";
import { contaEmModoLeitura } from "@/lib/billing/assinatura/modo-leitura";
import { CODIGO_RECUSA_DO_PLANO, STATUS_RECUSA_DO_PLANO } from "@/lib/billing/planos/recusa-do-plano";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";
import { createAdminClient } from "@/lib/supabase/admin";

/** `null` = pode escrever; `Response` = devolva esta resposta e pare. */
export async function recusarEscritaEmModoLeitura(
  organizationId: string,
  requestId: string,
  idioma: Idioma = "pt-BR",
): Promise<Response | null> {
  if (!(await contaEmModoLeitura(createAdminClient(), organizationId))) return null;
  return fail(
    CODIGO_RECUSA_DO_PLANO,
    traduzir(
      "A conta está suspensa por falta de pagamento: importações e lançamentos financeiros ficam parados até a assinatura ser regularizada. Fale com o suporte.",
      idioma,
    ),
    STATUS_RECUSA_DO_PLANO,
    { requestId },
  );
}
