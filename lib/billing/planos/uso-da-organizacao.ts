/**
 * Quanto a organização usa de cada item do plano, lido de `fn_billing_uso`
 * (RPC, só o papel de serviço executa). Serve a tela "Plano e uso" e o painel
 * do admin da plataforma.
 *
 * Nunca lança, pela mesma razão de `plano-da-organizacao.ts`: é leitura de
 * tela, e uma falha aqui não pode derrubar a página inteira. Com
 * `leituraFalhou: true` os números vêm zerados só para manter o formato:
 * quem chama NUNCA pode mostrá-los como uso real. Mostrar "0 de 5 funis"
 * depois de uma falha seria afirmar uma coisa que o banco não disse.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Logger } from "@/lib/agent-engine/obs/logger";

export interface Uso {
  funis: number;
  etapas_por_funil: number;
  leads: number;
  membros: number;
  conexoes: number;
  integracoes_webhook: number;
  /** A carteira de tokens é da F2-B; nesta fase é sempre nulo. */
  tokens_ia_mes: null;
}

export interface ResultadoDoUso {
  uso: Uso;
  leituraFalhou: boolean;
}

const campoDeUso = z.number().int().nonnegative();

/** O formato do jsonb que `fn_billing_uso` devolve: seis contagens, todas obrigatórias. */
const esquemaDoUso = z
  .object({
    funis: campoDeUso,
    etapas_por_funil: campoDeUso,
    leads: campoDeUso,
    membros: campoDeUso,
    conexoes: campoDeUso,
    integracoes_webhook: campoDeUso,
  })
  .strict();

/** O que volta quando a leitura falha: sempre junto de `leituraFalhou: true`. */
const USO_ZERADO: Uso = {
  funis: 0,
  etapas_por_funil: 0,
  leads: 0,
  membros: 0,
  conexoes: 0,
  integracoes_webhook: 0,
  tokens_ia_mes: null,
};

/** O uso atual da organização, item por item. */
export async function usoDaOrganizacao(
  admin: SupabaseClient,
  organizationId: string,
  log?: Logger,
): Promise<ResultadoDoUso> {
  try {
    const { data, error } = await admin.rpc("fn_billing_uso", { p_org: organizationId });

    if (error) {
      throw new Error(`ler uso da organização: ${error.message}`);
    }

    const parsed = esquemaDoUso.safeParse(data);
    if (!parsed.success) {
      throw new Error(`uso da organização fora do esquema: ${parsed.error.message}`);
    }

    return {
      uso: { ...parsed.data, tokens_ia_mes: null },
      leituraFalhou: false,
    };
  } catch (err) {
    log?.error("alarme_planos_leitura", {
      organization_id: organizationId,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
    });
    return {
      uso: USO_ZERADO,
      leituraFalhou: true,
    };
  }
}
