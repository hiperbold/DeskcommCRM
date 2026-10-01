import { createCipheriv, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * D-168: a cifra das credenciais ganha dado adicional (organização + linha) e
 * versão de chave, SEM quebrar o que já está gravado. Cripto real: nada aqui é
 * mock do próprio módulo.
 */

const CHAVE_V1 = Buffer.alloc(32, 7).toString("base64");
const CHAVE_V2 = Buffer.alloc(32, 9).toString("base64");

vi.mock("@/lib/env", () => ({ env: { AI_CRED_AES_KEY: Buffer.alloc(32, 7).toString("base64") } }));

const { decryptKey, encryptKey } = await import("@/lib/crypto/aes_gcm");

/** Como o código ANTIGO cifrava: iv de 12 bytes, sem dado adicional. */
function cifrarComoAntes(plaintext: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(CHAVE_V1, "base64"), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag() };
}

const AAD_A = "external_db_connections:org-1:conn-1";
const AAD_B = "external_db_connections:org-1:conn-2";

beforeEach(() => {
  delete process.env.AI_CRED_AES_KEY_VERSAO_ATUAL;
  delete process.env.AI_CRED_AES_KEY_V2;
});
afterEach(() => {
  delete process.env.AI_CRED_AES_KEY_VERSAO_ATUAL;
  delete process.env.AI_CRED_AES_KEY_V2;
});

describe("o que já está gravado continua lido", () => {
  it("cifra do formato antigo decifra, com ou sem contexto informado", () => {
    const antiga = cifrarComoAntes("senha-antiga");
    expect(decryptKey(antiga)).toBe("senha-antiga");
    expect(decryptKey(antiga, { aad: AAD_A })).toBe("senha-antiga");
  });

  it("quem não passa contexto continua escrevendo o formato antigo (iv de 12 bytes)", () => {
    const e = encryptKey("segredo-sem-contexto");
    expect(e.iv).toHaveLength(12);
    expect(decryptKey(e)).toBe("segredo-sem-contexto");
  });
});

describe("com contexto, a cifra fica presa ao dono", () => {
  it("round trip com o mesmo aad", () => {
    const e = encryptKey("senha-nova", { aad: AAD_A });
    expect(e.iv).toHaveLength(13);
    expect(decryptKey(e, { aad: AAD_A })).toBe("senha-nova");
  });

  it("a mesma cifra colada em OUTRA linha (aad diferente) não decifra", () => {
    const e = encryptKey("senha-nova", { aad: AAD_A });
    expect(() => decryptKey(e, { aad: AAD_B })).toThrow();
  });

  it("sem informar o aad, uma cifra com contexto não decifra", () => {
    const e = encryptKey("senha-nova", { aad: AAD_A });
    expect(() => decryptKey(e)).toThrow(/aad/);
  });

  it("adulterar a tag ou o texto cifrado continua sendo detectado", () => {
    const e = encryptKey("senha-nova", { aad: AAD_A });
    const tag = Buffer.from(e.tag);
    tag[0] = tag[0]! ^ 1;
    expect(() => decryptKey({ ...e, tag }, { aad: AAD_A })).toThrow();
  });
});

describe("versão de chave", () => {
  it("a versão usada para cifrar vai no primeiro byte do iv", () => {
    expect(encryptKey("x", { aad: AAD_A }).iv[0]).toBe(1);
    process.env.AI_CRED_AES_KEY_V2 = CHAVE_V2;
    process.env.AI_CRED_AES_KEY_VERSAO_ATUAL = "2";
    expect(encryptKey("x", { aad: AAD_A }).iv[0]).toBe(2);
  });

  it("trocar a chave não exige recifrar tudo: as linhas da versão 1 seguem decifrando", () => {
    const naV1 = encryptKey("segredo-v1", { aad: AAD_A });
    const legada = cifrarComoAntes("segredo-legado");
    process.env.AI_CRED_AES_KEY_V2 = CHAVE_V2;
    process.env.AI_CRED_AES_KEY_VERSAO_ATUAL = "2";

    const naV2 = encryptKey("segredo-v2", { aad: AAD_B });
    expect(decryptKey(naV2, { aad: AAD_B })).toBe("segredo-v2");
    expect(decryptKey(naV1, { aad: AAD_A })).toBe("segredo-v1");
    expect(decryptKey(legada)).toBe("segredo-legado");
  });

  it("linha de uma versão cuja chave não está configurada falha, sem cair noutra chave", async () => {
    process.env.AI_CRED_AES_KEY_V2 = CHAVE_V2;
    process.env.AI_CRED_AES_KEY_VERSAO_ATUAL = "2";
    const naV2 = encryptKey("segredo-v2", { aad: AAD_A });
    // Processo novo, sem a chave 2 (o módulo guarda as chaves já lidas).
    delete process.env.AI_CRED_AES_KEY_V2;
    vi.resetModules();
    const novo = await import("@/lib/crypto/aes_gcm");
    expect(() => novo.decryptKey(naV2, { aad: AAD_A })).toThrow(/AI_CRED_AES_KEY_V2/);
  });

  it("versão de escrita inválida é recusada em vez de cifrar com chave errada", () => {
    process.env.AI_CRED_AES_KEY_VERSAO_ATUAL = "zero";
    expect(() => encryptKey("x", { aad: AAD_A })).toThrow(/VERSAO_ATUAL/);
  });
});
