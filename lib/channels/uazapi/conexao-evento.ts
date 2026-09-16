/**
 * A instância CAIU (ou voltou) — evento `connection`.
 *
 * ─── Por que ele importa mais que os outros dois ────────────────────────────
 *
 * Mensagem que não chega é barulhenta: o cliente reclama. Instância caída é
 * silenciosa — o CRM segue aberto, a fila segue vazia, e ninguém descobre até
 * alguém perguntar "por que ninguém falou com a gente hoje?". Por isso este
 * evento não vira linha nem log: ele vai para o vigia de conexão, que abre o
 * aviso na Central e o FECHA quando o número volta.
 *
 * ─── Um aviso honesto sobre o formato ───────────────────────────────────────
 *
 * O contrato publicado do servidor diz, com estas palavras, que o corpo do
 * webhook "varia conforme o tipo do evento" e "segue o que o backend envia"
 * — ou seja, não há esquema para este evento.
 *
 * Então aqui não se CHUTA um campo só: procura-se o estado nos lugares em que
 * o servidor descreve uma instância no resto da API (`instance.status`, que é
 * o que `/instance/status` devolve), com as formas vizinhas atrás. E o que não
 * for encontrado NÃO vira "tudo bem": vira uma recusa nomeada, que aparece no
 * arquivo do webhook para alguém ler e ajustar.
 *
 * Conferido em 16/09/2026 contra eventos REAIS (instância descartável, pedido
 * de QR e desconexão): o estado vem em `instance.status`, o primeiro lugar
 * procurado. As formas estão no teste `channel-conexao-evento-uazapi`.
 */
import { z } from "zod";

import { lerEnvelope, type LeituraDeEnvelope } from "@/lib/webhooks/contrato";
import type { ChannelHealth } from "../types";
import { saudeDoEstadoUazapi } from "./saude";

const texto = z.string().nullish();

export const uazapiConexaoSchema = z.looseObject({
  EventType: texto,
  BaseUrl: texto,
  instanceName: texto,
  owner: texto,
  /** Nem todo evento repete o token da instância — ver `inbound.ts`. */
  token: texto,
  /** A forma que o resto da API usa para descrever uma instância. */
  instance: z.looseObject({ status: texto, id: texto, name: texto, owner: texto }).nullish(),
  /**
   * `status` aparece nas DUAS formas na API: string ("connected") no objeto da
   * instância e objeto (`{connected, loggedIn}`) no resumo da sessão. Aceitar
   * só uma faria o contrato recusar o evento inteiro por causa deste campo.
   */
  status: z.union([z.string(), z.looseObject({ connected: z.boolean().nullish(), loggedIn: z.boolean().nullish() })]).nullish(),
  state: texto,
  event: z.looseObject({ state: texto, status: texto }).nullish(),
});

export type UazapiConexao = z.infer<typeof uazapiConexaoSchema>;

export function lerConexaoUazapi(rawBody: string): LeituraDeEnvelope<UazapiConexao> {
  return lerEnvelope(rawBody, uazapiConexaoSchema);
}

export interface ConexaoLida {
  /** O rótulo cru do servidor, para o detalhe do aviso e para o arquivo. */
  estado: string;
  saude: ChannelHealth;
}

export type LeituraDaConexao =
  | { ok: true; conexao: ConexaoLida }
  /** O motivo vai para o arquivo do webhook: é o que se lê quando "não avisou". */
  | { ok: false; motivo: string };

/** O primeiro texto não vazio da lista; `null` se não houver nenhum. */
function primeiroTexto(...valores: Array<unknown>): string | null {
  for (const v of valores) {
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return null;
}

/**
 * Traduz o evento. Não lança: evento que não diz estado devolve o motivo, e a
 * rota responde 200 para o servidor não reentregar para sempre.
 */
export function parseUazapiConexao(env: UazapiConexao): LeituraDaConexao {
  if ((env.EventType ?? "") !== "connection") return { ok: false, motivo: "evento_sem_interesse" };

  const estado =
    primeiroTexto(
      env.instance?.status,
      typeof env.status === "string" ? env.status : null,
      env.state,
      env.event?.status,
      env.event?.state,
    ) ??
    // Último recurso: o resumo booleano da sessão. Vale só para o caso POSITIVO
    // — `connected: false` não distingue "desconectou" de "ainda conectando", e
    // chamar os dois de `disconnected` mandaria escanear QR à toa.
    (typeof env.status === "object" && env.status !== null && env.status.connected === true ? "connected" : null);

  if (!estado) return { ok: false, motivo: "conexao_sem_estado" };

  return { ok: true, conexao: { estado: estado.toLowerCase(), saude: saudeDoEstadoUazapi(estado) } };
}
