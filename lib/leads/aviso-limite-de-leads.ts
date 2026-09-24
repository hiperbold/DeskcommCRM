/**
 * Aviso na Central quando um lead AUTOMÁTICO não nasce (ou não reabre) por
 * causa do teto do plano (fase F3, tarefa 7, decisão 5 de
 * hiperbold/planos/fase-F3-tarefas.md).
 *
 * "O chat nunca para" já cobre mensagem, contato e conversa: quem falha é só
 * o card do negócio, e sem aviso nenhum ninguém no time descobre. Este
 * helper é o que cada caminho AUTOMÁTICO chama depois de reconhecer o PT402
 * de `crm_leads` (gatilho `trg_crm_leads_billing_bloqueio`, migration
 * 20260923120000_0907). Caminhos de PESSOA (criar, clonar, importar, mover à
 * mão, quadro, lote, reativação, MCP) NÃO chamam isto: a recusa aparece na
 * hora, na tela, pela frase fixa de `recusaDoPlano`; avisar de novo na
 * Central seria duplicar o que a pessoa já está vendo.
 *
 * Por que o título carrega a data: mesmo padrão de `fn_billing_dar_carencia`
 * (0907). O texto fixo inclui o DIA (fuso America/Sao_Paulo, o mesmo fuso de
 * todo cálculo de ciclo/carência da fase de planos) e a deduplicação é por
 * organização + kind + ref_kind + título. Uma rajada de mensagens no mesmo
 * dia deduplica num aviso só; se o teto continuar estourado amanhã, nasce
 * outro, "por dia", como a tarefa pede, e não "enquanto ninguém resolver"
 * (que esconderia dias novos atrás de um aviso antigo esquecido aberto).
 *
 * Por que é o cliente de serviço que grava, e não um insert qualquer:
 * `ref_kind = 'billing_limite'` é a MESMA família do aviso de carência
 * (0907). A revisão da F2 (migration 0905, M2: `billing_agent_inbox_items_
 * insert`/`_delete` e `trg_billing_trava_agent_inbox_items_update`) recusa
 * qualquer INSERT autenticado com este `ref_kind` e qualquer UPDATE fora de
 * status/resolved_at; só postgres/service_role/supabase_admin gravam ou
 * reescrevem esta linha. `admin` aqui é sempre `createAdminClient()`
 * (service_role, bypassa RLS): é o caminho que a auditoria da F2 deixou
 * aberto para o SERVIDOR avisar, sem reabrir a porta que ela fechou para o
 * cliente comum forjar ou apagar um aviso de plano.
 *
 * Nunca lança: o caminho automático que chama isto já gravou mensagem,
 * contato e conversa antes; uma falha ao avisar não pode derrubar o que já
 * aconteceu.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "@/lib/logger";

const KIND = "other";
const REF_KIND = "billing_limite";

/** Fuso fixo da fase de planos (ciclo, carência), não o fuso da organização. */
const FUSO_DE_PLANOS = "America/Sao_Paulo";

function tituloDoDia(agora: Date): string {
  // Dia no fuso de São Paulo montado das partes (formato fixo dd/mm/aaaa), sem
  // passar idioma para o formatador: o título é gravado uma vez no banco e
  // também é a chave da deduplicação diária, então não pode variar com o
  // idioma de quem está logado (a regra de i18n do projeto proíbe fixar
  // "pt-BR" em data formatada fora da camada de idioma).
  const partes = new Intl.DateTimeFormat("en-US", {
    timeZone: FUSO_DE_PLANOS,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(agora);
  const parte = (tipo: string) => partes.find((p) => p.type === tipo)?.value ?? "";
  const data = `${parte("day")}/${parte("month")}/${parte("year")}`;
  return `Um lead não foi criado em ${data} porque o plano chegou ao limite de leads`;
}

/**
 * Grava (ou reaproveita, se já existir hoje) o aviso de limite de leads desta
 * organização. `admin` precisa ser o cliente de serviço, ver o cabeçalho.
 */
export async function avisarLimiteDeLeadsAtingido(
  admin: SupabaseClient,
  organizationId: string,
  agora: Date = new Date(),
): Promise<void> {
  const titulo = tituloDoDia(agora);
  try {
    // Achado da revisão da F3 (médio 2): `.maybeSingle()` explode quando a
    // consulta devolve MAIS de uma linha. Duas rajadas do mesmo dia (duas
    // mensagens quase juntas, cada uma tentando avisar) podem gravar dois
    // avisos iguais antes de qualquer um deles enxergar o outro (não há
    // unique constraint aqui, só a checagem "já existe?" abaixo, que roda sem
    // trava nenhuma), a PARTIR daí, toda recusa seguinte no mesmo dia lê
    // duas linhas, `maybeSingle()` lança, o catch abaixo intercepta, e o
    // código (antes desta correção) seguia para o INSERT do mesmo jeito,
    // empilhando mais um aviso duplicado a cada recusa. `.limit(1)` sem
    // `maybeSingle()` nunca lança por "mais de uma linha": lê no máximo uma,
    // e a deduplicação continua funcionando (só precisa saber SE existe
    // alguma, não quantas). Se mesmo assim a LEITURA falhar (banco fora,
    // erro de rede), a doutrina muda aqui: como este helper não pode
    // distinguir "não existe aviso" de "não sei se existe", inserir às cegas
    // arriscaria duplicar; por isso NÃO insere, só loga e segue (o card já
    // foi recusado e a mensagem/contato/conversa já estão gravados, perder
    // este aviso específico é o lado mais barato do que duplicá-lo).
    const { data: linhas, error: erroLeitura } = await admin
      .from("agent_inbox_items")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("kind", KIND)
      .eq("ref_kind", REF_KIND)
      .eq("title", titulo)
      .limit(1);

    if (erroLeitura) {
      logger.warn("aviso-limite-de-leads: leitura falhou, aviso NÃO gravado (evita duplicar às cegas)", {
        organization_id: organizationId,
        detail: erroLeitura.message.slice(0, 160),
      });
      return;
    }
    if (linhas && linhas.length > 0) return;

    const { error } = await admin.from("agent_inbox_items").insert({
      organization_id: organizationId,
      kind: KIND,
      severity: "warn",
      title: titulo,
      body:
        "O plano desta organização chegou ao limite de leads contratado. Mensagens e conversas continuam sendo registradas normalmente; o card do negócio não nasceu (ou não reabriu). Fale com o suporte para ampliar o limite.",
      ref_kind: REF_KIND,
      ref_id: organizationId,
    });
    if (error) {
      logger.warn("aviso-limite-de-leads: aviso não gravado", {
        organization_id: organizationId,
        detail: error.message.slice(0, 160),
      });
    }
  } catch (err) {
    logger.warn("aviso-limite-de-leads: aviso não gravado", {
      organization_id: organizationId,
      detail: err instanceof Error ? err.message.slice(0, 160) : "desconhecido",
    });
  }
}
