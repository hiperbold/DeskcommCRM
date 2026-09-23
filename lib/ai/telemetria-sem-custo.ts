/**
 * TELEMETRIA SEM CUSTO: uma linha em `llm_calls` para os pontos que a Tarefa 8
 * (Frente 2, `hiperbold/planos/fase-F2-tarefas.md`) tirou de `registraEm: "nenhum"`:
 * embedding (indexar e consultar), transcrição de áudio e leitura de imagem.
 *
 * ## Por que `cost_cents` é SEMPRE nulo aqui
 *
 * `llm_calls.cost_cents` alimenta o orçamento de IA (`ai_budgets`, gatilho
 * `trg_llm_calls_budget`, função `fn_gasto_de_ia_do_mes`). Preencher um valor
 * aqui ligaria esse teto para consumos que hoje ele não vê, e organizações em
 * produção poderiam ter a IA parada no meio do mês, sem ninguém ter decidido
 * isso de propósito. Ligar é decisão do Filipe, registrada em D-050
 * (`hiperbold/DEBITO.md`). Enquanto essa decisão não vier, `cost_cents` fica
 * nulo aqui sempre, e nulo é o valor que a coluna já trata como "preço
 * desconhecido, nunca inventar zero" (comentário do `baseline.sql`).
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
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Os quatro `purpose` que esta função grava, na única lista canônica: quem
 * precisar saber "isto é telemetria sem custo por decisão (D-050), não preço
 * desconhecido" importa DAQUI, nunca repete a string. O achado 1 da revisão
 * da fase F2 nasceu de `check.ts` repetir esses nomes por fora: o dia em que
 * um quinto ponto entrasse aqui, o aviso de "gasto incompleto" da tela
 * continuaria contando a linha dele como furo de medição para sempre.
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
    const { error } = await admin.from("llm_calls").insert({
      organization_id: input.organizationId,
      job_id: input.jobId ?? null,
      purpose: input.purpose,
      provider: input.provider,
      model: input.model,
      input_tokens: input.inputTokens ?? 0,
      output_tokens: input.outputTokens ?? 0,
      // SEMPRE nulo, ver o comentário do arquivo (D-050).
      cost_cents: null,
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
