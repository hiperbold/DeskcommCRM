/**
 * O saldo da carteira de tokens de IA da organização (fase F2-B, tarefa 5).
 *
 * Chama `fn_billing_saldo_da_carteira` (RPC, só o papel de serviço executa,
 * migração `20260923110000_0906_planos_carteira_de_tokens.sql`, item 22):
 * essa função TAMBÉM concede o ciclo atual (decisão 9 da fase), então toda
 * leitura de saldo já garante a concessão preguiçosa antes de devolver o
 * retrato. Formato exato devolvido pela RPC:
 * `{"ciclo", "por_fonte": {"plano"|"adicional"|"avulso": {"creditado",
 * "consumido","saldo"}}, "sem_limite", "total_disponivel","total_consumido"}`.
 *
 * ─── Nunca lança, mesma regra de `planos/uso-da-organizacao.ts` (fase F2) ───
 *
 * Uma falha de leitura aqui vira `{ status: "leitura_falhou" }`, nunca "sem
 * limite" (mentiria dizendo que a organização não tem teto) nem números
 * zerados (mentiriam dizendo que ela não consumiu nada). Alarme em
 * `log.error` com a marca `alarme_planos_leitura`, a mesma da F2, para cair
 * na mesma investigação de quem audita esses alarmes.
 *
 * O tipo de retorno é discriminado em TRÊS, não dois: "ok" (com teto, os
 * números fazem sentido contra um total disponível), "sem_limite" (Ilimitado,
 * decisão 9: não existe concessão de `plano`, então `total_disponivel` não
 * tem significado e fica de fora do tipo, não só zerado) e "leitura_falhou".
 *
 * ─── `concessaoPendente` (item 9/13 da revisão, 23/09/2026) ─────────────────
 *
 * `fn_billing_saldo_da_carteira` (Parte 4, item 6 da revisão) devolve
 * `concessao_pendente: true` quando a trava da carteira estava ocupada e a
 * concessão do ciclo ainda não rodou: os números de `por_fonte`/`total_*` já
 * vêm com o teto efetivo emprestado (sem gravar nada), mas quem lê precisa
 * saber que é um empréstimo, não o retrato final. Só existe na variante "ok"
 * (Ilimitado nunca concede `plano`, decisão 9, e nunca fica pendente).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Logger } from "@/lib/agent-engine/obs/logger";

/** As três fontes da carteira, na ordem de consumo (decisão 6 da fase). */
export const FONTES_DA_CARTEIRA = ["plano", "adicional", "avulso"] as const;
export type FonteCarteira = (typeof FONTES_DA_CARTEIRA)[number];

export interface SaldoPorFonte {
  creditado: number;
  consumido: number;
  saldo: number;
}

export type ResultadoSaldoDaCarteira =
  | {
      status: "ok";
      ciclo: string;
      porFonte: Record<FonteCarteira, SaldoPorFonte>;
      totalDisponivel: number;
      totalConsumido: number;
      /** Item 6/13 da revisão: a concessão do ciclo ainda não rodou; os números acima já emprestam o teto efetivo. */
      concessaoPendente: boolean;
    }
  | {
      status: "sem_limite";
      ciclo: string;
      porFonte: Record<FonteCarteira, SaldoPorFonte>;
      totalConsumido: number;
    }
  | { status: "leitura_falhou" };

const esquemaDaFonte = z
  .object({
    // creditado pode ficar negativo a partir de um ajuste do admin (Parte 4
    // da migração, decisão 4 do ajuste): nenhum dos três campos tem piso.
    creditado: z.coerce.number().int(),
    consumido: z.coerce.number().int(),
    saldo: z.coerce.number().int(),
  })
  .strict();

/** O formato exato de `fn_billing_saldo_da_carteira` (migração 0906, item 22, com `concessao_pendente` da Parte 6/item 6 da revisão). */
const esquemaDoSaldo = z
  .object({
    ciclo: z.string().min(1),
    por_fonte: z
      .object({ plano: esquemaDaFonte, adicional: esquemaDaFonte, avulso: esquemaDaFonte })
      .strict(),
    sem_limite: z.boolean(),
    total_disponivel: z.coerce.number().int(),
    total_consumido: z.coerce.number().int(),
    concessao_pendente: z.boolean(),
  })
  .strict();

/** O saldo atual da carteira de tokens de IA da organização. Nunca lança. */
export async function saldoDaOrganizacao(
  admin: SupabaseClient,
  organizationId: string,
  log?: Logger,
): Promise<ResultadoSaldoDaCarteira> {
  try {
    const { data, error } = await admin.rpc("fn_billing_saldo_da_carteira", { p_org: organizationId });

    if (error) {
      throw new Error(`ler saldo da carteira de tokens: ${error.message}`);
    }

    const parsed = esquemaDoSaldo.safeParse(data);
    if (!parsed.success) {
      throw new Error(`saldo da carteira de tokens fora do esquema: ${parsed.error.message}`);
    }

    const porFonte: Record<FonteCarteira, SaldoPorFonte> = {
      plano: parsed.data.por_fonte.plano,
      adicional: parsed.data.por_fonte.adicional,
      avulso: parsed.data.por_fonte.avulso,
    };

    if (parsed.data.sem_limite) {
      return {
        status: "sem_limite",
        ciclo: parsed.data.ciclo,
        porFonte,
        totalConsumido: parsed.data.total_consumido,
      };
    }

    return {
      status: "ok",
      ciclo: parsed.data.ciclo,
      porFonte,
      totalDisponivel: parsed.data.total_disponivel,
      totalConsumido: parsed.data.total_consumido,
      concessaoPendente: parsed.data.concessao_pendente,
    };
  } catch (err) {
    log?.error("alarme_planos_leitura", {
      organization_id: organizationId,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
    });
    return { status: "leitura_falhou" };
  }
}
