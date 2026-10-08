import { createCipheriv, randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * D-168: a chave de um provedor de IA (`ai_provider_credentials`) é cifrada ligada à organização e à
 * linha, com a versão da chave no envelope, e as linhas antigas (sem contexto) continuam lidas.
 * Cripto real: o único dublê é o banco (captura o que seria gravado) e o provedor de IA.
 */

vi.mock("@/lib/env", () => ({ env: { AI_CRED_AES_KEY: Buffer.alloc(32, 7).toString("base64") } }));
vi.mock("@/lib/audit", () => ({ audit: async () => undefined }));
vi.mock("@/lib/logger", () => ({ logger: { warn: () => undefined, error: () => undefined, info: () => undefined } }));
vi.mock("@/lib/ai/provider-validators", () => ({
  validateProviderKey: async () => ({ ok: false, error: "sem_rede_no_teste" }),
}));

const { guardarCredencial, rotacionarCredencial } = await import("@/lib/ai/credenciais/guardar");
const { decifrarColunasDaCredencial } = await import("@/lib/ai/credenciais/cifra");
const { byteaToBuffer } = await import("@/lib/crypto/aes_gcm");

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OUTRA_ORG = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CHAVE = "sk-teste-1234567890abcd";

const capturado: { insert?: Record<string, unknown>; update?: Record<string, unknown> } = {};

/** Um banco de mentira que só guarda o que seria gravado e devolve o `id` que veio no insert. */
function bancoDeMentira() {
  const encadeia = (resultado: unknown) => {
    const cadeia: Record<string, unknown> = {};
    for (const nome of ["eq", "select", "update"]) cadeia[nome] = () => cadeia;
    cadeia.single = async () => resultado;
    cadeia.maybeSingle = async () => resultado;
    cadeia.then = (ok: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(ok);
    return cadeia;
  };
  return {
    from: () => ({
      insert: (linha: Record<string, unknown>) => {
        capturado.insert = linha;
        return encadeia({ data: { id: linha.id }, error: null });
      },
      update: (patch: Record<string, unknown>) => {
        capturado.update ??= patch;
        return encadeia({ data: { id: "linha-existente" }, error: null });
      },
    }),
  } as never;
}

function ivDe(coluna: unknown): Buffer {
  return byteaToBuffer(coluna);
}

/** Como o código ANTIGO cifrava: iv de 12 bytes, sem dado adicional, chave de versão 1. */
function cifrarComoAntes(plaintext: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.alloc(32, 7), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag() };
}

beforeEach(() => {
  delete capturado.insert;
  delete capturado.update;
  delete process.env.AI_CRED_AES_KEY_VERSAO_ATUAL;
});

describe("cadastro: a chave nasce cifrada ligada à organização e à linha", () => {
  it("⭐ o insert leva o id escolhido antes, e o envelope tem versão da chave + nonce (13 bytes)", async () => {
    const r = await guardarCredencial({
      admin: bancoDeMentira(),
      orgId: ORG,
      userId: "u1",
      provider: "openai",
      label: "principal",
      apiKey: CHAVE,
    });
    expect(r.ok).toBe(true);
    const linha = capturado.insert!;
    expect(linha.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.ok && r.id).toBe(linha.id);
    const iv = ivDe(linha.api_key_iv);
    expect(iv).toHaveLength(13);
    expect(iv[0]).toBe(1);
  });

  it("⭐ decifra com a organização e a linha de origem, e RECUSA em outra organização ou outra linha", async () => {
    await guardarCredencial({
      admin: bancoDeMentira(),
      orgId: ORG,
      userId: "u1",
      provider: "openai",
      label: "principal",
      apiKey: CHAVE,
    });
    const linha = capturado.insert as { id: string; api_key_encrypted: string; api_key_iv: string; api_key_tag: string };
    expect(decifrarColunasDaCredencial(linha, ORG)).toBe(CHAVE);
    expect(() => decifrarColunasDaCredencial(linha, OUTRA_ORG)).toThrow();
    expect(() => decifrarColunasDaCredencial({ ...linha, id: "outra-linha" }, ORG)).toThrow();
  });
});

describe("rotação: a chave nova também nasce no formato novo, ligada à linha rotacionada", () => {
  it("⭐ regrava a linha legada no formato novo", async () => {
    const r = await rotacionarCredencial({
      admin: bancoDeMentira(),
      orgId: ORG,
      userId: "u1",
      credentialId: "linha-existente",
      provider: "openai",
      apiKey: CHAVE,
    });
    expect(r.ok).toBe(true);
    const patch = capturado.update as { api_key_encrypted: string; api_key_iv: string; api_key_tag: string };
    expect(ivDe(patch.api_key_iv)).toHaveLength(13);
    expect(decifrarColunasDaCredencial({ id: "linha-existente", ...patch }, ORG)).toBe(CHAVE);
    expect(() => decifrarColunasDaCredencial({ id: "outra", ...patch }, ORG)).toThrow();
  });

  it("rotacionar só o rótulo não toca na cifra", async () => {
    await rotacionarCredencial({
      admin: bancoDeMentira(),
      orgId: ORG,
      userId: "u1",
      credentialId: "linha-existente",
      provider: "openai",
      label: "novo nome",
    });
    expect(capturado.update).toEqual({ label: "novo nome" });
  });
});

describe("migração transparente: o que já está gravado continua lido", () => {
  it("⭐ linha legada (iv de 12 bytes, sem contexto) decifra pelo mesmo leitor, qualquer que seja o contexto", () => {
    const antiga = cifrarComoAntes(CHAVE);
    const linha = {
      id: "qualquer",
      api_key_encrypted: antiga.ciphertext,
      api_key_iv: antiga.iv,
      api_key_tag: antiga.tag,
    };
    expect(decifrarColunasDaCredencial(linha, ORG)).toBe(CHAVE);
    expect(decifrarColunasDaCredencial(linha, OUTRA_ORG)).toBe(CHAVE);
  });
});
