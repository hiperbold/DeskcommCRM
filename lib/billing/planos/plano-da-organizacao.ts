/**
 * A leitura do plano efetivo de uma organização (fase F1).
 *
 * ═══ Por que esta função NUNCA lança ═══
 *
 * `planoDaOrganizacao` é o módulo de leitura que a F2 vai chamar no caminho
 * de criação de coisas (funil, etapa, lead, conexão...) para saber contra que
 * teto contar. Um erro de leitura aqui não pode derrubar essa criação: a
 * decisão desta fase, deliberada, é LIBERAR (devolver `limites` todos `null`,
 * que a régua do produto lê como "sem limite") quando o banco não responde
 * direito. Ilimitado por erro não é ilimitado por plano, e por isso o caso de
 * erro carimba `leituraFalhou: true` e grita em `log.error` com a marca
 * `alarme_planos_leitura`, para ninguém confundir as duas coisas depois,
 * numa investigação de por que uma organização vencida passou reto.
 *
 * ═══ Os três casos, e só eles ═══
 *
 * 1. Contrato existe: devolve o plano contratado, o contrato e os limites
 *    efetivos (plano + ajuste), lidos de `fn_billing_limites_efetivos` por
 *    RPC, a ÚNICA função de precedência (fase F1, decisão de desenho 9; não
 *    há segunda implementação em TypeScript, ver `limites.ts`).
 * 2. Sem contrato (organização anterior ao gatilho, ou backfill que ainda não
 *    rodou): plano Ilimitado, `contrato: null`, `log.warn`, não é erro, é o
 *    estado documentado de quem nunca teve contrato gravado.
 * 3. Erro de leitura (a consulta devolve `error`, lança, ou os limites que
 *    voltaram do banco não passam no esquema do plano): `leituraFalhou: true`,
 *    `limites` todos `null`, `log.error` com `alarme_planos_leitura`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Logger } from "@/lib/agent-engine/obs/logger";

import { CHAVES_DE_LIMITE, esquemaDoPlanoDeLimites, type Limites } from "./limites";

export interface PlanoResumo {
  code: string;
  name: string;
  version: number;
}

export interface ContratoResumo {
  status: string;
  cycle: string | null;
}

export interface ResultadoDoPlano {
  plano: PlanoResumo;
  contrato: ContratoResumo | null;
  limites: Limites;
  leituraFalhou: boolean;
}

/**
 * O plano Ilimitado usado como resposta de fallback nos casos 2 e 3 (sem
 * contrato, ou leitura que falhou). Os valores batem com a semeadura da
 * migration 0904 (`code = 'ilimitado'`, `version = 1`): não é uma segunda
 * consulta ao banco de propósito, um round trip a mais no caminho de erro é
 * mais uma coisa que pode falhar exatamente quando o banco já está ruim.
 */
const PLANO_ILIMITADO_PADRAO: PlanoResumo = { code: "ilimitado", name: "Ilimitado", version: 1 };

function limitesTodosSemLimite(): Limites {
  return Object.fromEntries(CHAVES_DE_LIMITE.map((chave) => [chave, null])) as Limites;
}

/** Forma da linha lida de `billing_contracts` com o plano embutido pelo FK `plan_id`. */
interface LinhaDoContrato {
  status: string;
  cycle: string | null;
  billing_plans: { code: string; name: string; version: number } | null;
}

/**
 * O plano efetivo de uma organização: plano contratado (ou Ilimitado, se não
 * houver contrato), contrato e limites efetivos. Nunca lança, ver o
 * comentário do arquivo.
 */
export async function planoDaOrganizacao(
  admin: SupabaseClient,
  organizationId: string,
  log?: Logger,
): Promise<ResultadoDoPlano> {
  try {
    const [contratoRes, limitesRes] = await Promise.all([
      admin
        .from("billing_contracts")
        .select("status, cycle, billing_plans(code, name, version)")
        .eq("organization_id", organizationId)
        .maybeSingle(),
      admin.rpc("fn_billing_limites_efetivos", { p_org: organizationId }),
    ]);

    if (contratoRes.error) {
      throw new Error(`ler contrato: ${contratoRes.error.message}`);
    }
    if (limitesRes.error) {
      throw new Error(`ler limites efetivos: ${limitesRes.error.message}`);
    }

    const limitesParseados = esquemaDoPlanoDeLimites.safeParse(limitesRes.data);
    if (!limitesParseados.success) {
      throw new Error(`limites efetivos fora do esquema: ${limitesParseados.error.message}`);
    }

    const linha = contratoRes.data as unknown as LinhaDoContrato | null;

    if (!linha) {
      log?.warn("organização sem contrato de plano, servindo o Ilimitado", {
        organization_id: organizationId,
      });
      return {
        plano: PLANO_ILIMITADO_PADRAO,
        contrato: null,
        limites: limitesParseados.data,
        leituraFalhou: false,
      };
    }

    if (!linha.billing_plans) {
      throw new Error("contrato sem plano associado (embed billing_plans ausente)");
    }

    return {
      plano: {
        code: linha.billing_plans.code,
        name: linha.billing_plans.name,
        version: linha.billing_plans.version,
      },
      contrato: { status: linha.status, cycle: linha.cycle },
      limites: limitesParseados.data,
      leituraFalhou: false,
    };
  } catch (err) {
    log?.error("alarme_planos_leitura", {
      organization_id: organizationId,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
    });
    return {
      plano: PLANO_ILIMITADO_PADRAO,
      contrato: null,
      limites: limitesTodosSemLimite(),
      leituraFalhou: true,
    };
  }
}
