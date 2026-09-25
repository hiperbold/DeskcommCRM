import "server-only";

/**
 * Configuração do Asaas: fase F5 (`hiperbold/planos/fase-F5-tarefas.md`,
 * Tarefa 10, decisão 14).
 *
 * ═══ Por que a validação mora AQUI, e não em `lib/env.ts` ═══
 *
 * `lib/env.ts` só sabe ler as cinco variáveis soltas; a REGRA (base oficial +
 * prefixo da chave batendo com ela) depende de cruzar duas delas, e um erro
 * de configuração do Asaas não pode derrubar `lib/env.ts` inteiro: ele roda
 * no import do módulo, e um `throw` ali tira o app do ar inteiro por causa de
 * uma feature que a instalação talvez nem use. `configDoAsaas()` só lança
 * quando `ASAAS_ENABLED=true` E a combinação está incoerente. A instalação
 * que nunca ligou o Asaas nunca paga esse preço.
 *
 * ═══ Restrição absoluta desta fase ═══
 *
 * Nenhuma chamada real ao Asaas, nem ao sandbox, sai daqui: este módulo só
 * lê variável de ambiente e resolve `billing_settings.compra_pelo_cliente`
 * pelo banco. Quem fala com a rede é `lib/billing/asaas/cliente.ts`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

export const ASAAS_BASE_URL_SANDBOX = "https://api-sandbox.asaas.com/v3";
export const ASAAS_BASE_URL_PRODUCAO = "https://api.asaas.com/v3";

export type AmbienteAsaas = "sandbox" | "producao";

export interface ConfigAsaas {
  /** Ambas as chaves da decisão 18 precisam estar ligadas; esta é a do `.env`. */
  habilitado: boolean;
  baseUrl: string;
  apiKey: string;
  webhookToken: string;
  webhookId: string;
  /**
   * Ambiente DERIVADO da base (nunca de uma variável própria: uma variável
   * `ASAAS_ENV` solta poderia divergir da base sem ninguém notar). Quando
   * `habilitado` é falso, vale `"sandbox"` como valor neutro; nada o lê nesse
   * caso, porque nenhuma chamada de rede acontece.
   */
  ambiente: AmbienteAsaas;
}

/**
 * Erro de CONFIGURAÇÃO: a combinação de variáveis não faz sentido. Nunca é
 * lançado por uma resposta de rede: ver `lib/billing/asaas/erros.ts` para os
 * erros de chamada, que é uma família deliberadamente separada desta.
 */
export class ErroConfiguracaoAsaas extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = "ErroConfiguracaoAsaas";
  }
}

function ambienteDaBase(baseUrl: string): AmbienteAsaas | null {
  if (baseUrl === ASAAS_BASE_URL_SANDBOX) return "sandbox";
  if (baseUrl === ASAAS_BASE_URL_PRODUCAO) return "producao";
  return null;
}

/**
 * O prefixo da chave, NUNCA a chave inteira: esta função só decide se
 * `$aact_hmlg_` (sandbox) ou `$aact_prod_` (produção) abre o valor. O resto
 * da chave não importa para essa decisão e não precisa ser olhado.
 */
function ambienteDaChave(apiKey: string): AmbienteAsaas | null {
  if (apiKey.startsWith("$aact_hmlg_")) return "sandbox";
  if (apiKey.startsWith("$aact_prod_")) return "producao";
  return null;
}

/**
 * O ambiente do EVENTO recebido pelo webhook (`app/api/v1/webhooks/asaas/
 * route.ts`, Tarefa 12): derivado SÓ da base configurada (`ASAAS_BASE_URL`),
 * NUNCA da chave nem de `ASAAS_ENABLED`. A rota precisa saber em que
 * ambiente um evento chegou mesmo com a compra desligada ou a chave
 * incoerente com a base: o token já provou que quem chamou é o Asaas de
 * verdade, e `configDoAsaas()` não serve aqui porque ela devolve `"sandbox"`
 * como valor NEUTRO quando `habilitado` é falso (correto para quem nunca vai
 * chamar a rede, errado para gravar o ambiente de um evento real).
 *
 * `null` quando a base está vazia ou fora das duas oficiais: EMERGÊNCIA de
 * configuração (o webhook está configurado, mas a base não diz qual
 * ambiente é), nunca "sandbox" como padrão silencioso (risco 12: ambiente
 * trocado). Quem chama decide o 500 nesse caso.
 */
export function ambienteDoEventoWebhook(): AmbienteAsaas | null {
  return ambienteDaBase(env.ASAAS_BASE_URL.trim());
}

/**
 * Lê e valida a configuração do Asaas. NUNCA chama a rede.
 *
 * Com `ASAAS_ENABLED=false` (o estado de toda instalação desta fase),
 * devolve `habilitado: false` sem validar base/chave: a instalação pode ter
 * as outras variáveis vazias ou incoerentes sem que isso quebre nada. Só
 * quando `ASAAS_ENABLED=true` é que a base precisa ser uma das duas oficiais
 * e o prefixo da chave precisa casar com ela; discordância é
 * `ErroConfiguracaoAsaas`, lançado ANTES de qualquer tentativa de chamada.
 */
export function configDoAsaas(): ConfigAsaas {
  const habilitado = env.ASAAS_ENABLED;
  const baseUrl = env.ASAAS_BASE_URL.trim();
  const apiKey = env.ASAAS_API_KEY.trim();
  const webhookToken = env.ASAAS_WEBHOOK_TOKEN.trim();
  const webhookId = env.ASAAS_WEBHOOK_ID.trim();

  if (!habilitado) {
    return { habilitado: false, baseUrl, apiKey, webhookToken, webhookId, ambiente: "sandbox" };
  }

  const daBase = ambienteDaBase(baseUrl);
  if (!daBase) {
    throw new ErroConfiguracaoAsaas(
      `ASAAS_BASE_URL precisa ser ${ASAAS_BASE_URL_SANDBOX} (sandbox) ou ${ASAAS_BASE_URL_PRODUCAO} (produção)`,
    );
  }
  const daChave = ambienteDaChave(apiKey);
  if (!daChave) {
    throw new ErroConfiguracaoAsaas(
      "ASAAS_API_KEY precisa começar com $aact_hmlg_ (sandbox) ou $aact_prod_ (produção)",
    );
  }
  if (daChave !== daBase) {
    throw new ErroConfiguracaoAsaas(
      "ASAAS_API_KEY e ASAAS_BASE_URL apontam para ambientes diferentes (uma é de sandbox e a outra de produção)",
    );
  }

  return { habilitado: true, baseUrl, apiKey, webhookToken, webhookId, ambiente: daBase };
}

/**
 * A SEGUNDA chave da decisão 18: `compra_pelo_cliente` no banco
 * (`billing_settings`, linha única `id = 1`, mesma convenção de
 * `lib/billing/assinatura/modo-leitura.ts`). A compra pelo próprio cliente só
 * fica ligada com as DUAS travas ao mesmo tempo, e por isso este helper
 * recebe `habilitado` (de `configDoAsaas()`) e nem consulta o banco quando ele
 * já é falso, o "zero custo a mais" que o resto do módulo de billing também
 * segue.
 *
 * Fail-closed: qualquer erro de leitura devolve `false` (a compra continua
 * desligada) e grita no log. É o padrão contrário de
 * `contaEmModoLeitura` (que é fail-open porque bloquear sem necessidade
 * corta o acesso de quem paga; aqui o erro do lado errado ABRE uma compra
 * real, e a restrição fixa da fase 24/09/2026 é não cobrar a mais).
 */
export async function compraLigada(db: SupabaseClient, habilitado: boolean): Promise<boolean> {
  if (!habilitado) return false;
  try {
    const { data, error } = await db
      .from("billing_settings")
      .select("compra_pelo_cliente")
      .eq("id", 1)
      .maybeSingle<{ compra_pelo_cliente: boolean | null }>();
    if (error) {
      throw new Error(`ler billing_settings.compra_pelo_cliente: ${error.message}`);
    }
    return Boolean(data?.compra_pelo_cliente);
  } catch (err) {
    logger.error("alarme_asaas_compra_ligada", {
      etapa: "compra_ligada",
      erro: (err instanceof Error ? err.message : String(err)).slice(0, 300),
    });
    return false;
  }
}
