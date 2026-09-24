/**
 * "O bloqueio de verdade está valendo AGORA para esta organização?": só o
 * interruptor geral (`billing_settings.modo` + `billing_contracts.
 * bloqueio_a_partir_de`), sem olhar item nem teto: quem decide "cabe ou não
 * cabe" continua sendo `podeCriar` (pode-criar.ts). Mesma regra do gatilho de
 * verdade `fn_billing_bloqueia` (migration 0907, decisão 3): modo = 'bloquear'
 * E `bloqueio_a_partir_de` preenchido e já VENCIDO; nulo = não bloqueia
 * (carência nunca dada, ou organização anterior ao gatilho de carência), data
 * no futuro = carência ainda correndo.
 *
 * ═══ Por que esta função existe separada de `podeCriar` ═══
 *
 * Três pré-checagens do servidor (`channels/partner`, `leads/import`,
 * `leads/bulk`) chamavam `podeCriar` direto: ela só responde "cabe ou não
 * cabe no teto", sem perguntar se o bloqueio VALE para a organização. Fase
 * F3: o banco continua em modo `avisar` em toda instalação, e nesse modo
 * NADA pode mudar de comportamento (`hiperbold/planos/fase-F3-tarefas.md`,
 * linha 5). Sem este portão, as três pré-checagens recusavam uma criação que
 * o modo `avisar` de hoje deixaria passar: o defeito que esta função fecha.
 *
 * Uso: só chamar `podeCriar` (e pagar o custo da leitura dela) quando esta
 * função disser que sim. O gatilho do banco continua sendo a trava de
 * verdade; a pré-checagem só existe para dar a mensagem boa antes da
 * tentativa.
 *
 * ═══ Organização Ilimitado ═══
 *
 * Não precisa de tratamento aqui: o plano Ilimitado tem TODOS os tetos
 * `null`, e é `podeCriar` quem reconhece isso (`motivo: 'sem_limite'`, `pode:
 * true`). Ela nunca bloqueia mesmo que esta função diga que o bloqueio vale
 * para a organização: não há teto para estourar.
 *
 * ═══ Fail-open ═══
 *
 * Mesma doutrina de `pode-criar.ts` e `plano-da-organizacao.ts`: leitura que
 * falha NUNCA bloqueia (devolve `false`, "não vale"), e grita
 * `alarme_planos_leitura` no log para a falha não passar despercebida.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Logger } from "@/lib/agent-engine/obs/logger";

export async function bloqueioValeParaOrganizacao(
  admin: SupabaseClient,
  organizationId: string,
  log?: Logger,
): Promise<boolean> {
  try {
    const { data: settings, error: erroSettings } = await admin
      .from("billing_settings")
      .select("modo")
      .eq("id", 1)
      .maybeSingle();
    if (erroSettings) {
      throw new Error(`ler billing_settings: ${erroSettings.message}`);
    }

    // Sem linha (banco recém-migrado, antes da semeadura) ou modo diferente
    // de 'bloquear': sai aqui, sem ler billing_contracts nem gastar consulta
    // a mais, o mesmo "zero custo a mais" de `fn_billing_bloqueia`.
    if ((settings as { modo?: string } | null)?.modo !== "bloquear") {
      return false;
    }

    const { data: contrato, error: erroContrato } = await admin
      .from("billing_contracts")
      .select("bloqueio_a_partir_de")
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (erroContrato) {
      throw new Error(`ler billing_contracts: ${erroContrato.message}`);
    }

    const bloqueioAPartirDe = (contrato as { bloqueio_a_partir_de?: string | null } | null)
      ?.bloqueio_a_partir_de;

    // Nulo = não bloqueia (mesma regra de `enforcement_effective_at` no
    // orçamento de IA); sem contrato conta como nulo. Data no futuro = a
    // carência ainda não venceu.
    if (!bloqueioAPartirDe) return false;
    return new Date(bloqueioAPartirDe).getTime() <= Date.now();
  } catch (err) {
    log?.error("alarme_planos_leitura", {
      organization_id: organizationId,
      etapa: "bloqueio_vale_para_organizacao",
      error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
    });
    return false;
  }
}
