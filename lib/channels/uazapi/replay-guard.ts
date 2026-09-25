/**
 * D-042: `messages_update` e `connection` não repetem o token da instância no
 * corpo (medido em `inbound.ts`/`verificaTokenUazapiNoPortao`): a prova deles
 * é só o número dono, que vem dentro do próprio corpo. Sem nonce nem janela de
 * tempo, quem capturar um corpo válido pode reenviá-lo pela mesma URL quantas
 * vezes quiser.
 *
 * ─── Por que "id do evento" aqui é um hash do corpo, e não um campo do payload ──
 *
 * Nenhum dos dois eventos traz um identificador único monotônico: `connection`
 * não publica esquema nenhum (ver `conexao-evento.ts`) e não tem campo de
 * carimbo; `messages_update` tem `MessageIDs` + `state`, mas o MESMO recibo
 * genuíno pode chegar mais de uma vez do próprio servidor (reentrega por falta
 * de 200) com o corpo BYTE A BYTE idêntico, que é exatamente o mesmo formato
 * de um replay capturado. Hashear o corpo cru inteiro (por sessão, para não
 * colidir entre organizações) é a prova mais forte que os dados disponíveis
 * permitem: dois corpos iguais viram a mesma chave, corpo diferente (inclusive
 * um campo a mais) vira chave diferente.
 *
 * ─── Por que é janela curta e em memória, não uma tabela ────────────────────
 *
 * O objetivo é reduzir o ALCANCE do reenvio, não distinguir para sempre "já vi
 * isso" de "nunca vi": aplicar o MESMO desfecho duas vezes já é inofensivo por
 * outra razão (`aplicarStatusUazapi` nunca rebaixa, `sincronizarSaudeDaConexao`
 * é vigia idempotente): o risco que fica é o de fora do escopo desta função:
 * gastar recursos reenviando pela mesma URL sem parar. Uma janela curta em
 * memória do processo mata isso sem migração nova. Concessão declarada: em
 * múltiplas réplicas do processo, cada uma tem sua própria memória, e um
 * reenvio dirigido a réplicas diferentes não é pego: mitigação parcial, não
 * garantia, e está anotada aqui para quem for fechar D-042 de vez.
 *
 * ─── Por que checar e marcar são duas funções, não uma ──────────────────────
 *
 * A versão anterior marcava a chave como vista DENTRO da própria checagem, ou
 * seja: antes de `uazapiInbound` processar o evento. Se o processamento
 * lançasse (banco fora do ar, por exemplo), a rota respondia 500, o sinal
 * certo para o servidor reentregar, mas a chave já estava marcada, e a
 * reentrega com o corpo idêntico era descartada como "repetida" sem nunca ter
 * sido de fato processada. Um evento de verdade sumia depois de uma falha
 * transitória. Agora `eventoUazapiRepetido` só LÊ, e quem chama marca com
 * `marcarEventoUazapiVisto` depois que o processamento terminou sem lançar.
 */
import { createHash } from "node:crypto";

/** 5 min: mata a rajada de reenvio sem represar uma reentrega legítima e tardia. */
export const JANELA_DE_REPLAY_MS = 5 * 60 * 1000;

/** Teto de entradas antes de forçar a limpeza de vencidas, para não crescer sem fim. */
const LIMITE_ANTES_DE_LIMPAR = 2_000;

declare global {
  /** Mesmo padrão de `lib/instalacao/comportamento.ts`: sobrevive a duas instâncias do módulo no mesmo processo Next. */
  var __uazapiEventosVistos: Map<string, number> | undefined;
}

function mapaDeVistos(): Map<string, number> {
  if (!globalThis.__uazapiEventosVistos) globalThis.__uazapiEventosVistos = new Map();
  return globalThis.__uazapiEventosVistos;
}

function limparVencidos(mapa: Map<string, number>, agoraMs: number): void {
  for (const [chave, expiraEm] of mapa) {
    if (expiraEm <= agoraMs) mapa.delete(chave);
  }
}

/** A chave do evento: sessão + tipo + hash do corpo cru inteiro. */
export function chaveDoEventoUazapi(channelSessionId: string, eventType: string, rawBody: string): string {
  const hash = createHash("sha256").update(rawBody).digest("hex");
  return `${channelSessionId}:${eventType}:${hash}`;
}

/**
 * `true` = já visto dentro da janela, e quem chama deve recusar como repetido.
 * `false` = novo (ou a janela anterior já venceu, ou nunca chegou a ser
 * marcado como visto porque o processamento anterior falhou).
 *
 * Só LÊ, não marca. Quem chama, depois de processar com sucesso, marca com
 * `marcarEventoUazapiVisto`. `agoraMs` é injetável só para teste; produção
 * sempre usa `Date.now()`.
 */
export function eventoUazapiRepetido(chave: string, agoraMs: number = Date.now()): boolean {
  const mapa = mapaDeVistos();
  if (mapa.size > LIMITE_ANTES_DE_LIMPAR) limparVencidos(mapa, agoraMs);

  const expiraEm = mapa.get(chave);
  return expiraEm !== undefined && expiraEm > agoraMs;
}

/**
 * Marca a chave como vista por `JANELA_DE_REPLAY_MS`. Chamar SÓ depois que o
 * processamento do evento terminou sem lançar, é isso que distingue
 * "processado" de "só recebido", e é a diferença entre este guard e a versão
 * anterior que marcava antes de processar (ver o porquê acima).
 */
export function marcarEventoUazapiVisto(chave: string, agoraMs: number = Date.now()): void {
  const mapa = mapaDeVistos();
  if (mapa.size > LIMITE_ANTES_DE_LIMPAR) limparVencidos(mapa, agoraMs);
  mapa.set(chave, agoraMs + JANELA_DE_REPLAY_MS);
}

/** Só para teste: devolve o processo ao estado de quem nunca viu evento nenhum. */
export function esquecerEventosUazapiVistos(): void {
  globalThis.__uazapiEventosVistos = undefined;
}
