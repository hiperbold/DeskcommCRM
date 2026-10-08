import { createCipheriv, randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * D-168, parte 2: a senha do tronco SIP (`voip_trunk_settings`) e os segredos da configuração da instalação
 * (`platform_config`) deixam de ser cifrados SEM dado adicional com a mesma chave das credenciais de IA.
 * Cada um ganha o contexto próprio (a organização do tronco; a chave da configuração), a versão da chave no
 * envelope, e a leitura segue aceitando o formato antigo. Cripto real: o único dublê é o banco.
 */

vi.mock("@/lib/env", () => ({ env: { AI_CRED_AES_KEY: Buffer.alloc(32, 7).toString("base64") } }));
vi.mock("@/lib/audit", () => ({ audit: async () => undefined }));

/** A tabela `platform_config` em memória (uma linha por `chave`). */
const tabela = vi.hoisted(() => new Map<string, Record<string, unknown>>());
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => {
      let chave = "";
      const cadeia: Record<string, unknown> = {};
      cadeia.select = () => cadeia;
      cadeia.eq = (_coluna: string, valor: string) => {
        chave = valor;
        return cadeia;
      };
      cadeia.maybeSingle = async () => ({ data: tabela.get(chave) ?? null, error: null });
      cadeia.upsert = async (linha: Record<string, unknown>) => {
        tabela.set(String(linha.chave), linha);
        return { error: null };
      };
      cadeia.delete = () => cadeia;
      return cadeia;
    },
  }),
}));

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/** Como o código ANTIGO cifrava: iv de 12 bytes, sem dado adicional, chave de versão 1. */
function cifrarComoAntes(plaintext: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.alloc(32, 7), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag() };
}

beforeEach(() => {
  delete process.env.AI_CRED_AES_KEY_VERSAO_ATUAL;
});

describe("senha do tronco SIP (voip_trunk_settings)", () => {
  const capturado: { upsert?: Record<string, unknown> } = {};

  function bancoDeMentira(existente: boolean) {
    const cadeia: Record<string, unknown> = {};
    for (const n of ["select", "eq"]) cadeia[n] = () => cadeia;
    cadeia.maybeSingle = async () => ({ data: existente ? { organization_id: ORG_A } : null, error: null });
    return {
      from: () => ({
        select: () => cadeia,
        upsert: async (linha: Record<string, unknown>) => {
          capturado.upsert = linha;
          return { error: null };
        },
      }),
    } as never;
  }

  const pedido = (orgId: string, password?: string) => ({
    admin: bancoDeMentira(false),
    orgId,
    userId: "u1",
    host: "sip.exemplo.com",
    port: 5060,
    username: "tronco",
    ...(password ? { password } : {}),
    fromDomain: null,
    isActive: true,
  });

  beforeEach(() => {
    delete capturado.upsert;
  });

  it("⭐ a senha nasce com envelope de 13 bytes e só abre com o contexto do tronco da organização", async () => {
    const { guardarTrunk } = await import("@/lib/voip/guardar-trunk");
    const { decifrarSenhaDoTrunk } = await import("@/lib/voip/senha-do-trunk");
    const r = await guardarTrunk(pedido(ORG_A, "senha-do-tronco-9876"));
    expect(r).toEqual({ ok: true });

    const linha = capturado.upsert!;
    const { byteaToBuffer } = await import("@/lib/crypto/aes_gcm");
    expect(byteaToBuffer(linha.password_iv).length).toBe(13);
    expect(linha.password_last4).toBe("9876");
    expect(decifrarSenhaDoTrunk(linha as never, ORG_A)).toBe("senha-do-tronco-9876");
    // Copiada para o tronco de outra organização, a cifra não abre.
    expect(() => decifrarSenhaDoTrunk(linha as never, ORG_B)).toThrow();
  });

  it("⭐ o leitor segue aceitando a senha antiga (iv de 12 bytes, sem contexto)", async () => {
    const { decifrarSenhaDoTrunk } = await import("@/lib/voip/senha-do-trunk");
    const { bufToBytea } = await import("@/lib/crypto/aes_gcm");
    const velha = cifrarComoAntes("senha-antiga-1234");
    const linha = {
      password_encrypted: bufToBytea(velha.ciphertext),
      password_iv: bufToBytea(velha.iv),
      password_tag: bufToBytea(velha.tag),
    };
    expect(decifrarSenhaDoTrunk(linha, ORG_A)).toBe("senha-antiga-1234");
  });

  it("atualizar sem senha nova não mexe nas colunas da senha (a antiga segue como está)", async () => {
    const { guardarTrunk } = await import("@/lib/voip/guardar-trunk");
    const r = await guardarTrunk({ ...pedido(ORG_A), admin: bancoDeMentira(true) });
    expect(r).toEqual({ ok: true });
    expect(capturado.upsert).not.toHaveProperty("password_iv");
  });
});

describe("segredos da configuração da instalação (platform_config)", () => {
  beforeEach(() => {
    tabela.clear();
  });

  it("⭐ o segredo gravado pela tela tem envelope de 13 bytes e volta em claro pela leitura", async () => {
    const { gravarPelaTela, valorDaInstalacao } = await import("@/lib/instalacao/config");
    const { byteaToBuffer } = await import("@/lib/crypto/aes_gcm");
    const r = await gravarPelaTela("RESEND_API_KEY", "re_segredo_abcd", { ehSegredo: true, ator: "u1" });
    expect(r).toEqual({ ok: true });

    const linha = tabela.get("RESEND_API_KEY")!;
    expect(byteaToBuffer(linha.iv).length).toBe(13);
    expect(linha.valor).toBeNull();
    expect((await valorDaInstalacao("RESEND_API_KEY")).valor).toBe("re_segredo_abcd");
  });

  it("⭐ o envelope fica preso à chave da configuração: copiado para outra chave, não abre", async () => {
    const { gravarPelaTela, valorDaInstalacao } = await import("@/lib/instalacao/config");
    await gravarPelaTela("RESEND_API_KEY", "re_segredo_abcd", { ehSegredo: true, ator: "u1" });
    tabela.set("OUTRA_CHAVE", { ...tabela.get("RESEND_API_KEY")!, chave: "OUTRA_CHAVE" });

    const lido = await valorDaInstalacao("OUTRA_CHAVE");
    expect(lido.valor).toBeNull();
  });

  it("⭐ a linha antiga (iv de 12 bytes, sem contexto) segue sendo lida", async () => {
    const { valorDaInstalacao } = await import("@/lib/instalacao/config");
    const { bufToBytea } = await import("@/lib/crypto/aes_gcm");
    const velha = cifrarComoAntes("segredo-antigo-wxyz");
    tabela.set("RESEND_API_KEY", {
      chave: "RESEND_API_KEY",
      valor: null,
      ciphertext: bufToBytea(velha.ciphertext),
      iv: bufToBytea(velha.iv),
      tag: bufToBytea(velha.tag),
      last4: "wxyz",
      eh_segredo: true,
      semeado_do_env: false,
    });
    expect((await valorDaInstalacao("RESEND_API_KEY")).valor).toBe("segredo-antigo-wxyz");
  });

  it("valor que não é segredo continua em claro, sem envelope", async () => {
    const { gravarPelaTela } = await import("@/lib/instalacao/config");
    await gravarPelaTela("ALGUM_KNOB", "42", { ehSegredo: false, ator: "u1" });
    expect(tabela.get("ALGUM_KNOB")).toMatchObject({ valor: "42", ciphertext: null, iv: null, tag: null });
  });
});
