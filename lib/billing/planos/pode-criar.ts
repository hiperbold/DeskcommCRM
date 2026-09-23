/**
 * "Cabe mais um?": pergunta ao banco se a organização pode criar mais um item
 * do plano, por `fn_billing_pode_criar` (RPC, só o papel de serviço executa).
 *
 * ═══ Por que o erro de leitura LIBERA ═══
 *
 * Esta função vai para o caminho de criação de funil, lead e conexão. Na F2
 * nenhum limite bloqueia, então negar por causa de uma leitura que falhou
 * seria bloquear justamente quando a regra manda só avisar. A falha devolve
 * `pode: true` com `leituraFalhou: true` e grita `alarme_planos_leitura` no
 * log, para ninguém confundir "liberado porque a leitura falhou" com
 * "liberado pelo plano". A F3, quando o bloqueio passar a valer, revê isso.
 *
 * Quem trava de verdade é o gatilho no banco (fase F2, tarefa 3): esta
 * função existe para a tela dizer o motivo antes de a pessoa tentar.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Logger } from "@/lib/agent-engine/obs/logger";

/** Os seis itens que `fn_billing_pode_criar` aceita: o mesmo conjunto do `p_item` dela. */
export const ITENS_COM_TETO = [
  "funis",
  "etapas_por_funil",
  "leads",
  "membros",
  "conexoes",
  "integracoes_webhook",
] as const;

export type ItemComTeto = (typeof ITENS_COM_TETO)[number];

/**
 * `leitura_falhou` nunca vem do banco: só aparece quando a própria leitura
 * falhou. Um valor próprio, e não `sem_limite`, porque "sem limite" é uma
 * afirmação sobre o plano, e quem investigar um alarme precisa saber que o
 * plano nem chegou a ser lido.
 */
export type MotivoPodeCriar = "ok" | "teto_atingido" | "sem_limite" | "leitura_falhou";

export interface ResultadoPodeCriar {
  pode: boolean;
  motivo: MotivoPodeCriar;
  atual: number | null;
  teto: number | null;
  leituraFalhou: boolean;
}

const campoNumericoOuNulo = z.number().int().nonnegative().nullable();

/** O formato do jsonb que `fn_billing_pode_criar` devolve. */
const esquemaPodeCriar = z
  .object({
    pode: z.boolean(),
    motivo: z.enum(["ok", "teto_atingido", "sem_limite"]),
    atual: campoNumericoOuNulo,
    teto: campoNumericoOuNulo,
  })
  .strict();

/**
 * Se a organização pode criar mais um `item`. `pipelineId` só é exigido para
 * `etapas_por_funil`, e quem confere isso é a própria função do banco.
 */
export async function podeCriar(
  admin: SupabaseClient,
  organizationId: string,
  item: ItemComTeto,
  pipelineId?: string,
  log?: Logger,
): Promise<ResultadoPodeCriar> {
  try {
    const { data, error } = await admin.rpc("fn_billing_pode_criar", {
      p_org: organizationId,
      p_item: item,
      p_pipeline: pipelineId ?? null,
    });

    if (error) {
      throw new Error(`chamar fn_billing_pode_criar: ${error.message}`);
    }

    const parsed = esquemaPodeCriar.safeParse(data);
    if (!parsed.success) {
      throw new Error(`resposta de fn_billing_pode_criar fora do esquema: ${parsed.error.message}`);
    }

    return { ...parsed.data, leituraFalhou: false };
  } catch (err) {
    log?.error("alarme_planos_leitura", {
      organization_id: organizationId,
      item,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
    });
    return {
      pode: true,
      motivo: "leitura_falhou",
      atual: null,
      teto: null,
      leituraFalhou: true,
    };
  }
}
