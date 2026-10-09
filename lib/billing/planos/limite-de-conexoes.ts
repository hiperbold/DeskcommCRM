/**
 * O limite de Conexões do plano (D-188, decisão do dono em 09/10/2026).
 *
 * O item `conexoes` do plano vale para TODOS os canais somados (WhatsApp, WhatsApp oficial,
 * Instagram, Messenger: tudo que vive em `channel_sessions` e não está arquivado) e BLOQUEIA sempre, qualquer
 * que seja `billing_settings.modo` (migration 0954). Este módulo é a leitura e a frase desse limite:
 *
 *   - a frase de recusa: "Sua conta atingiu o limite de {n} conexões do plano {plano}. Remova uma conexão ou
 *     mude de plano.", com o link para a tela de assinar na própria interface;
 *   - `bloqueioDoBotaoDeConexoes`: o mesmo formato `BloqueioDoBotao` que as telas de Conexões já recebem, mas
 *     calculado sem olhar o modo (o `estadoDoBloqueio` sai cedo fora do modo `bloquear`, e aqui isso não vale).
 *
 * Quem decide de verdade é o banco (gatilho `trg_billing_trava_channel_sessions`). Aqui só se pergunta "cabe
 * mais uma?" para a tela dizer o motivo antes de a pessoa tentar. Leitura que falha LIBERA (nunca desabilita
 * por acidente) e grita `alarme_planos_leitura`, igual `podeCriar`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Logger } from "@/lib/agent-engine/obs/logger";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";

import type { BloqueioDoBotao } from "./estado-do-bloqueio";
import { planoDaOrganizacao } from "./plano-da-organizacao";
import { podeCriar } from "./pode-criar";
import type { RecusaDoPlano } from "./recusa-do-plano";

/** Para onde a recusa manda quem pode mudar de plano. */
export const CAMINHO_PARA_ASSINAR = "/app/settings/plano/assinar";

/** A linha que explica o que o item soma, para a tela do plano e os cartões. */
export const TEXTO_DE_CONEXOES_SOMADAS = "WhatsApp, Instagram e Messenger somados";

const FRASE_COM_NUMERO =
  "Sua conta atingiu o limite de {n} conexões do plano {plano}. Remova uma conexão ou mude de plano.";
const FRASE_SEM_NUMERO = "Sua conta atingiu o limite de conexões do plano. Remova uma conexão ou mude de plano.";

/**
 * A frase de recusa. Sem o limite ou sem o nome do plano (leitura falhou) cai na frase sem número, que continua
 * verdadeira, em vez de inventar "0" ou "undefined".
 */
export function fraseDoLimiteDeConexoes(
  limite: number | null,
  nomeDoPlano: string | null,
  idioma: Idioma = "pt-BR",
): string {
  if (limite === null || !nomeDoPlano) return traduzir(FRASE_SEM_NUMERO, idioma);
  return traduzir(FRASE_COM_NUMERO, idioma)
    .replaceAll("{n}", String(limite))
    .replaceAll("{plano}", nomeDoPlano);
}

/** A frase de recusa já com o limite e o plano reais da organização. Nunca lança. */
export async function mensagemDoLimiteDeConexoes(
  admin: SupabaseClient,
  organizationId: string,
  idioma: Idioma = "pt-BR",
  log?: Logger,
): Promise<string> {
  const plano = await planoDaOrganizacao(admin, organizationId, log);
  if (plano.leituraFalhou) return fraseDoLimiteDeConexoes(null, null, idioma);
  return fraseDoLimiteDeConexoes(plano.limites.conexoes, plano.plano.name, idioma);
}

/**
 * O botão de nova conexão: desabilitado quando o limite está cheio, com o motivo pronto. Vale em qualquer modo
 * de `billing_settings`. `idioma` traduz a frase no servidor, porque o componente cliente só repassa o texto.
 */
export async function bloqueioDoBotaoDeConexoes(
  admin: SupabaseClient,
  organizationId: string,
  idioma: Idioma = "pt-BR",
  log?: Logger,
): Promise<BloqueioDoBotao> {
  const veredito = await podeCriar(admin, organizationId, "conexoes", undefined, log);
  if (veredito.leituraFalhou || veredito.pode || veredito.motivo !== "teto_atingido") {
    return { desabilitado: false, motivo: null, suspensa: false };
  }
  const plano = await planoDaOrganizacao(admin, organizationId, log);
  const nome = plano.leituraFalhou ? null : plano.plano.name;
  return {
    desabilitado: true,
    motivo: fraseDoLimiteDeConexoes(veredito.teto, nome, idioma),
    suspensa: false,
  };
}

/**
 * A mensagem de uma recusa PT402 já reconhecida por `recusaDoPlano`: para o item `conexoes` é a frase com o
 * limite e o plano reais; para qualquer outro item é a frase fixa que `recusaDoPlano` já trouxe.
 */
export async function mensagemDaRecusaDoPlano(
  recusa: RecusaDoPlano,
  admin: SupabaseClient,
  organizationId: string,
  idioma: Idioma = "pt-BR",
  log?: Logger,
): Promise<string> {
  if (recusa.item !== "conexoes") return recusa.mensagem;
  return mensagemDoLimiteDeConexoes(admin, organizationId, idioma, log);
}
