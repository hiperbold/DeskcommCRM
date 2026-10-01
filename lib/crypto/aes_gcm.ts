/**
 * AES-256-GCM helpers para `ai_provider_credentials`.
 *
 * Key source: `process.env.AI_CRED_AES_KEY` — 32 bytes em base64.
 * Output do `encryptKey`: três `Buffer`s separados (ciphertext, IV de 12 bytes,
 * tag de 16 bytes) que são gravados como `bytea` na tabela. Pra uso via PostgREST
 * use o helper `bufToBytea()` que produz a literal `\x<hex>`.
 *
 * Plaintext NUNCA deve ser logado, persistido ou retornado em response — apenas
 * o `last4` é exposto via view `ai_provider_credentials_safe`.
 *
 * ─── DUAS FORMAS DE ENVELOPE (D-168) ────────────────────────────────────────
 *
 * LEGADA (sem `aad`): `iv` de 12 bytes, sem dado adicional, chave única
 * `AI_CRED_AES_KEY`. É o que já está gravado, e continua sendo lido e escrito
 * por quem não passa `aad`.
 *
 * COM CONTEXTO (`aad` informado): AES-GCM com dado adicional autenticado (a
 * organização e a linha) e a versão da chave no PRIMEIRO byte do campo `iv`
 * (13 bytes: versão + nonce de 12). Uma cifra copiada para outra linha ou
 * organização deixa de decifrar (a tag não fecha), e a troca de chave deixa de
 * exigir recifrar tudo de uma vez: cada linha diz com qual versão foi cifrada.
 * Nenhuma coluna nova: o `iv` é `bytea` sem restrição de tamanho.
 *
 * A leitura distingue as formas pelo tamanho do `iv`, então uma coluna com as
 * duas convive. Linha legada é regravada na forma nova na próxima vez que o
 * segredo for salvo; nenhuma credencial existente é tocada.
 *
 * VERSÕES DE CHAVE: a 1 é `AI_CRED_AES_KEY`. A versão `n` (2 ou mais) é lida de
 * `AI_CRED_AES_KEY_V<n>`, e a versão usada para ESCREVER vem de
 * `AI_CRED_AES_KEY_VERSAO_ATUAL` (padrão 1). Para trocar a chave: publique a
 * nova como `_V2`, mantenha a antiga, suba `VERSAO_ATUAL` para 2; as linhas
 * antigas seguem decifrando e vão migrando conforme são salvas.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { env } from "@/lib/env";

const KEY_LENGTH_BYTES = 32;
const IV_LENGTH_BYTES = 12;
const TAG_LENGTH_BYTES = 16;
/** Forma com contexto: 1 byte de versão da chave + nonce. */
const IV_COM_VERSAO_LENGTH_BYTES = IV_LENGTH_BYTES + 1;

const cachedKeys = new Map<number, Buffer>();

function nomeDaVariavel(versao: number): string {
  return versao === 1 ? "AI_CRED_AES_KEY" : `AI_CRED_AES_KEY_V${versao}`;
}

function getKey(versao = 1): Buffer {
  const emCache = cachedKeys.get(versao);
  if (emCache) return emCache;
  const nome = nomeDaVariavel(versao);
  const raw = versao === 1 ? env.AI_CRED_AES_KEY : process.env[nome];
  if (!raw) {
    throw new Error(`${nome} não configurada. Defina em .env.local (32 bytes base64).`);
  }
  let buf: Buffer;
  try {
    buf = Buffer.from(raw, "base64");
  } catch {
    throw new Error(`${nome} inválida: base64 malformado.`);
  }
  if (buf.length !== KEY_LENGTH_BYTES) {
    throw new Error(
      `${nome} deve ter exatamente 32 bytes (lido: ${buf.length}). Gere com: openssl rand -base64 32`,
    );
  }
  cachedKeys.set(versao, buf);
  return buf;
}

/** Versão com que os segredos NOVOS são cifrados (forma com contexto). */
function versaoDeEscrita(): number {
  const raw = process.env.AI_CRED_AES_KEY_VERSAO_ATUAL;
  if (raw === undefined || raw === "") return 1;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 255) {
    throw new Error("AI_CRED_AES_KEY_VERSAO_ATUAL deve ser um inteiro de 1 a 255.");
  }
  return n;
}

export interface ContextoDaCifra {
  /**
   * Dado adicional autenticado: o que prende a cifra ao seu dono (ex.:
   * `external_db_connections:<organization_id>:<id da linha>`). Quem decifra
   * tem de informar o MESMO texto.
   */
  aad: string;
}

export interface EncryptedSecret {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
  /** Últimos 4 chars do plaintext, mostrados na UI pra identificação. */
  last4: string;
}

export function encryptKey(plaintext: string, contexto?: ContextoDaCifra): EncryptedSecret {
  if (!plaintext || typeof plaintext !== "string") {
    throw new Error("plaintext inválido pra encryptKey()");
  }
  const nonce = randomBytes(IV_LENGTH_BYTES);
  let key: Buffer;
  let iv: Buffer;
  if (contexto) {
    if (!contexto.aad) throw new Error("contexto da cifra sem aad");
    const versao = versaoDeEscrita();
    key = getKey(versao);
    iv = Buffer.concat([Buffer.from([versao]), nonce]);
  } else {
    key = getKey();
    iv = nonce;
  }
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  if (contexto) cipher.setAAD(Buffer.from(contexto.aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  if (tag.length !== TAG_LENGTH_BYTES) {
    throw new Error(`tag length inesperada: ${tag.length}`);
  }
  const last4 = plaintext.slice(-4);
  return { ciphertext, iv, tag, last4 };
}

export function decryptKey(
  input: {
    ciphertext: Buffer;
    iv: Buffer;
    tag: Buffer;
  },
  contexto?: ContextoDaCifra,
): string {
  const { ciphertext, iv, tag } = input;
  let key: Buffer;
  let nonce: Buffer;
  let comContexto: boolean;
  if (iv.length === IV_LENGTH_BYTES) {
    // Forma legada: sem dado adicional, chave de versão 1. `contexto` é ignorado,
    // porque esta cifra nunca o carregou.
    key = getKey();
    nonce = iv;
    comContexto = false;
  } else if (iv.length === IV_COM_VERSAO_LENGTH_BYTES) {
    if (!contexto) throw new Error("cifra com contexto: informe o aad para decifrar");
    key = getKey(iv[0]!);
    nonce = iv.subarray(1);
    comContexto = true;
  } else {
    throw new Error(`iv com tamanho inesperado: ${iv.length}`);
  }
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  if (comContexto) decipher.setAAD(Buffer.from(contexto!.aad, "utf8"));
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}

/**
 * Converte um Buffer em literal hex aceito pelo PostgREST pra colunas `bytea`.
 */
export function bufToBytea(buf: Buffer): string {
  return `\\x${buf.toString("hex")}`;
}

/**
 * Inverso de `bufToBytea`: aceita o que o PostgREST devolve em colunas bytea
 * (string `\xHEX` em modo padrão, ou Buffer/Uint8Array dependendo do driver).
 */
export function byteaToBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string") {
    const hex = value.startsWith("\\x") ? value.slice(2) : value;
    return Buffer.from(hex, "hex");
  }
  throw new Error("byteaToBuffer: formato inesperado");
}
