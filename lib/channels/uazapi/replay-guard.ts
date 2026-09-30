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
 * ─── Por que é janela curta, não uma tabela ─────────────────────────────────
 *
 * O objetivo é reduzir o ALCANCE do reenvio, não distinguir para sempre "já vi
 * isso" de "nunca vi": aplicar o MESMO desfecho duas vezes já é inofensivo por
 * outra razão (`aplicarStatusUazapi` nunca rebaixa, `sincronizarSaudeDaConexao`
 * é vigia idempotente): o risco que fica é o de fora do escopo desta função:
 * gastar recursos reenviando pela mesma URL sem parar. Uma janela curta mata
 * isso sem migração nova.
 *
 * ─── Compartilhado entre réplicas (fecha o D-042) ───────────────────────────
 *
 * Só a memória do processo não pega o reenvio dirigido a outra réplica do
 * container. Por isso a marca também vai para o Redis que o app JÁ usa para
 * estado compartilhado (o mesmo Upstash REST de `lib/ai/dispatcher/rate-limit.ts`
 * e `lib/ai/rag/debounce.ts`: `SET EX` com o TTL da janela, então o próprio
 * Redis expira a chave). A memória continua sendo a primeira consulta (barata,
 * sem rede) e o piso de segurança:
 *
 *  - Redis não configurado, malformado, fora do ar ou lento (teto de
 *    `TIMEOUT_REDIS_MS`): cai para a memória do processo, exatamente o
 *    comportamento de antes. NUNCA lança e nunca devolve "repetido" por causa
 *    de falha do armazenamento: perder o evento por isso seria pior do que
 *    processar duas vezes (o efeito já é idempotente, ver acima).
 *  - A marca continua sendo gravada só DEPOIS do processamento dar certo.
 *
 * Concessão que sobra: duas réplicas que recebem o MESMO corpo no mesmo instante
 * ainda podem processar as duas (a consulta e a marca não são atômicas de
 * propósito, porque marcar antes de processar descartaria a reentrega legítima
 * após uma falha; ver a seção abaixo). O efeito é idempotente, então isso custa
 * uma aplicação a mais, não um dado errado.
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
import { Redis } from "@upstash/redis";
import { env } from "@/lib/env";
import { validarConfigRedisRest } from "@/lib/redis-config";

/** 5 min: mata a rajada de reenvio sem represar uma reentrega legítima e tardia. */
export const JANELA_DE_REPLAY_MS = 5 * 60 * 1000;

/**
 * Teto NOSSO para a ida ao Redis (mesmo motivo de `lib/ai/rag/debounce.ts`: o
 * SDK tenta de novo com backoff e, sem corrida contra um relógio, a promise não
 * volta e o webhook ficaria pendurado). Estourou: segue só com a memória.
 */
export const TIMEOUT_REDIS_MS = 2_000;

const PREFIXO_REDIS = "uazapi:replay:";

let _redis: Redis | null = null;
let _avisouSemRedis = false;

/**
 * Cliente do Redis compartilhado, ou `null` quando não há (não configurado ou
 * malformado). `retry: false` pelo mesmo motivo de `rate-limit.ts`: com o Redis
 * inalcançável, retentar só transfere a indisponibilidade dele para a latência
 * do webhook, e já existe a memória logo abaixo para cair.
 */
function getRedis(): Redis | null {
  if (_redis) return _redis;
  const url = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  const config = validarConfigRedisRest(url, token);
  if (!config.ok) {
    if (!_avisouSemRedis) {
      console.warn(
        `[uazapi-replay-guard] Redis ${config.reason}: guarda de replay só por processo (não cobre várias réplicas)`,
      );
      _avisouSemRedis = true;
    }
    return null;
  }
  _redis = new Redis({ url, token, retry: false });
  return _redis;
}

/** Corre a operação contra o teto de tempo, sem deixar o relógio pendurado. */
async function comTeto<T>(operacao: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operacao,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("replay_guard_timeout")), TIMEOUT_REDIS_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

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
 * marcado como visto porque o processamento anterior falhou, ou o Redis
 * compartilhado falhou e a memória deste processo não conhece a chave).
 *
 * Só LÊ, não marca. Quem chama, depois de processar com sucesso, marca com
 * `marcarEventoUazapiVisto`. `agoraMs` é injetável só para teste (vale para a
 * memória; o Redis expira pelo relógio dele); produção sempre usa `Date.now()`.
 * Nunca lança: falha do Redis vira `false` (processa), nunca perde o evento.
 */
export async function eventoUazapiRepetido(chave: string, agoraMs: number = Date.now()): Promise<boolean> {
  const mapa = mapaDeVistos();
  if (mapa.size > LIMITE_ANTES_DE_LIMPAR) limparVencidos(mapa, agoraMs);

  const expiraEm = mapa.get(chave);
  if (expiraEm !== undefined && expiraEm > agoraMs) return true;

  const redis = getRedis();
  if (!redis) return false;
  try {
    const valor = await comTeto(redis.get<string | number>(PREFIXO_REDIS + chave));
    return valor !== null && valor !== undefined;
  } catch (err) {
    console.warn(
      "[uazapi-replay-guard] Redis não respondeu na consulta: seguindo só com a memória do processo:",
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

/**
 * Marca a chave como vista por `JANELA_DE_REPLAY_MS`. Chamar SÓ depois que o
 * processamento do evento terminou sem lançar, é isso que distingue
 * "processado" de "só recebido", e é a diferença entre este guard e a versão
 * anterior que marcava antes de processar (ver o porquê acima).
 *
 * Grava primeiro na memória (piso que não depende de rede) e depois no Redis
 * compartilhado, com o TTL da janela. Nunca lança: o evento JÁ foi processado,
 * e uma falha do armazenamento não pode virar 500 (o servidor reentregaria).
 */
export async function marcarEventoUazapiVisto(chave: string, agoraMs: number = Date.now()): Promise<void> {
  const mapa = mapaDeVistos();
  if (mapa.size > LIMITE_ANTES_DE_LIMPAR) limparVencidos(mapa, agoraMs);
  mapa.set(chave, agoraMs + JANELA_DE_REPLAY_MS);

  const redis = getRedis();
  if (!redis) return;
  try {
    await comTeto(redis.set(PREFIXO_REDIS + chave, "1", { ex: Math.ceil(JANELA_DE_REPLAY_MS / 1000) }));
  } catch (err) {
    console.warn(
      "[uazapi-replay-guard] Redis não respondeu na marcação: esta réplica marcou só na memória do processo:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** Só para teste: devolve o processo ao estado de quem nunca viu evento nenhum. */
export function esquecerEventosUazapiVistos(): void {
  globalThis.__uazapiEventosVistos = undefined;
}
