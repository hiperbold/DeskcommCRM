/**
 * TELEMETRIA (ANTES SEMPRE SEM CUSTO): uma linha em `llm_calls` para os pontos
 * que a Tarefa 8 (Frente 2, `hiperbold/planos/fase-F2-tarefas.md`) tirou de
 * `registraEm: "nenhum"`: embedding (indexar e consultar), transcrição de
 * áudio e leitura de imagem. O nome do arquivo é histórico, este caminho
 * grava telemetria SEM custo só para transcrição; embedding e visão agora
 * levam `cost_cents` quando o catálogo tem o preço.
 *
 * ## `cost_cents`: por que às vezes tem valor e às vezes não
 *
 * D-050 (`hiperbold/DEBITO.md`, decisão do Filipe em 23/09/2026): os agentes
 * passam a usar modelos baratos fora da Anthropic, e o orçamento de IA
 * (`ai_budgets`, gatilho `trg_llm_calls_budget`, função
 * `fn_gasto_de_ia_do_mes`) precisa enxergar esse custo. Este ponto agora chama
 * o resolvedor único (`custoCentsComCatalogo`, em
 * `lib/agent-engine/edge/llm/pricing.ts`): embedding e visão ganham
 * `cost_cents` real quando o catálogo `ai_models` conhece o `provider` +
 * `model` da chamada; sem entrada no catálogo (ou se a leitura dele falhar),
 * o valor fica `null`, nulo é "preço desconhecido", nunca "de graça"
 * (comentário do `baseline.sql`).
 *
 * `transcricao_de_audio` é a exceção PERMANENTE: Whisper cobra por MINUTO de
 * áudio, não por token, e nada neste caminho mede a duração do arquivo antes
 * de transcrever (D-051, `hiperbold/DEBITO.md`). Sem tokens para multiplicar
 * pela tarifa do catálogo, `cost_cents` fica sempre nulo para este propósito,
 * independente do que o catálogo souber sobre o modelo.
 *
 * ## Por que uma falha aqui nunca derruba quem chamou
 *
 * Estes pontos (achar a base de conhecimento do agente, ouvir um áudio, ler
 * uma foto) são o que o cliente está esperando NO MOMENTO. Se o INSERT de
 * telemetria falhasse a chamada inteira, uma tabela de métricas ficaria mais
 * importante que o atendimento, o oposto do que este ponto deve fazer. Por
 * isso a função nunca lança: qualquer erro (o `insert` devolver `{error}`, ou
 * o próprio client explodir) vira um `logger.warn` e a função retorna
 * normalmente.
 */
import { custoCentsComCatalogo } from "@/lib/agent-engine/edge/llm/pricing";
import { precoDoCatalogoOuNull } from "@/lib/ai/runtime/cost";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Os quatro `purpose` que esta função grava, na única lista canônica: quem
 * precisar saber quais pontos passam por aqui importa DAQUI, nunca repete a
 * string. O achado 1 da revisão da fase F2 nasceu de `check.ts` repetir esses
 * nomes por fora: o dia em que um quinto ponto entrasse aqui, o aviso de
 * "gasto incompleto" da tela continuaria contando a linha dele como furo de
 * medição para sempre.
 *
 * DEPOIS DO D-050 (23/09/2026), o nome não é mais literal: só
 * `transcricao_de_audio` tem `cost_cents` nulo por uma razão permanente (D-051:
 * o catálogo não precifica por minuto de áudio). `embedding_indexar`,
 * `embedding_consultar` e `visao_de_imagem` agora GANHAM custo quando o
 * catálogo conhece o modelo; ficam nulos só no caso residual de um modelo
 * ainda não catalogado, ou de a leitura do catálogo falhar. A lista continua
 * excluída do "gasto incompleto" em `check.ts` mesmo assim, ver o comentário
 * de lá, porque um nulo residual destes três não é o sinal que aquele aviso
 * existe para dar (o modelo de conversa do agente sem preço conhecido).
 */
export const PROPOSITOS_SEM_CUSTO_POR_DECISAO = [
  "embedding_indexar",
  "embedding_consultar",
  "transcricao_de_audio",
  "visao_de_imagem",
] as const;

export type PropositoSemCustoPorDecisao = (typeof PROPOSITOS_SEM_CUSTO_POR_DECISAO)[number];

export interface TelemetriaSemCustoInput {
  /**
   * `null`/`undefined` é um estado legítimo: alguns pontos podem ser chamados
   * antes de a organização ser conhecida. Nesse caso NÃO gravamos, porque
   * inventar uma organização poluiria a carteira de outra empresa, o que é
   * pior que não medir.
   */
  organizationId: string | null | undefined;
  /** Casa com o `id` do ponto em `lib/ai/pontos/registro.ts`. */
  purpose: string;
  provider: string;
  model: string;
  /** Ausente = 0. Transcrição não tem token de entrada (é cobrada por minuto). */
  inputTokens?: number;
  outputTokens?: number;
  /** Só quando o ponto roda dentro de um job da fila; a maioria não tem. */
  jobId?: string | null;
  /**
   * 0906 (carteira de tokens de IA, fase F2-B): de quem é a chave desta
   * chamada, quando o chamador souber sem reestruturar a resolução de
   * credencial. Ausente/nulo = a coluna fica nula (não debita a carteira,
   * decisão 3 da fase).
   */
  origemDaChave?: "chave_da_instalacao" | "credencial_da_organizacao" | null;
}

/**
 * Grava UMA linha de telemetria em `llm_calls` para um ponto que hoje não
 * registra nada. Nunca lança, ver o comentário do arquivo.
 */
export async function registrarTelemetriaSemCusto(input: TelemetriaSemCustoInput): Promise<void> {
  if (!input.organizationId) {
    logger.warn("[telemetria-sem-custo] sem organização conhecida; não gravei", {
      purpose: input.purpose,
    });
    return;
  }

  try {
    const admin = createAdminClient();
    // Transcrição é a exceção permanente (D-051): sem duração do áudio não há
    // o que multiplicar pela tarifa do catálogo, então nem tenta, poupa a
    // consulta e mantém o nulo que já era o resultado certo. Embedding e
    // visão passam pelo resolvedor único (D-050): custo real quando o
    // catálogo conhece o modelo, nulo (nunca zero) quando não conhece ou a
    // leitura falha.
    const costCents =
      input.purpose === "transcricao_de_audio"
        ? null
        : await custoCentsComCatalogo(
            input.provider,
            input.model,
            { inputTokens: input.inputTokens ?? 0, outputTokens: input.outputTokens ?? 0 },
            undefined,
            logger,
            // `pricing.ts` não importa `lib/ai/runtime/cost` (a cerca do Jev trata
            // essa pasta como "quem envia", achado da junção de 2026-09-27), então
            // o carregador HTTP de sempre precisa vir explícito daqui.
            precoDoCatalogoOuNull,
          );
    const { error } = await admin.from("llm_calls").insert({
      organization_id: input.organizationId,
      job_id: input.jobId ?? null,
      purpose: input.purpose,
      provider: input.provider,
      model: input.model,
      input_tokens: input.inputTokens ?? 0,
      output_tokens: input.outputTokens ?? 0,
      cost_cents: costCents,
      // 0906: nula quando o chamador não sabe (embedding hoje não sabe sem
      // reestruturar a resolução de credencial; ver hiperbold/planos).
      origem_da_chave: input.origemDaChave ?? null,
    });
    if (error) {
      logger.warn("[telemetria-sem-custo] o banco recusou a gravação", {
        organization_id: input.organizationId,
        purpose: input.purpose,
        motivo: error.message,
      });
    }
  } catch (err) {
    logger.warn("[telemetria-sem-custo] falhou ao gravar telemetria", {
      organization_id: input.organizationId,
      purpose: input.purpose,
      motivo: err instanceof Error ? err.message : String(err),
    });
  }
}
