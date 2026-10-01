import type { SupabaseClient } from "@supabase/supabase-js";
import { createCipheriv, randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

/**
 * D-168 no banco externo: a senha da conexão é cifrada presa à organização e à
 * linha. Cripto real. Linha antiga (cifrada sem contexto) continua abrindo.
 */

vi.mock("@/lib/env", () => ({ env: { AI_CRED_AES_KEY: Buffer.alloc(32, 7).toString("base64") } }));
vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: async () => true }));

const { cifrarSenha, carregarConexao } = await import("@/lib/external-db/credenciais");

const ORG = "org-1";

function linha(id: string, colunas: { password_encrypted: string; password_iv: string; password_tag: string }) {
  return {
    id,
    organization_id: ORG,
    label: "Loja",
    host: "db.exemplo.com",
    port: 5432,
    database_name: "loja",
    username: "leitor",
    ...colunas,
    ssl_mode: "require",
    enabled: true,
    max_rows: null,
    max_filters: null,
    max_response_bytes: null,
    updated_at: "2026-10-01T00:00:00.000Z",
  };
}

function adminCom(data: unknown) {
  const builder = {
    select: () => builder,
    eq: () => builder,
    maybeSingle: async () => ({ data, error: null }),
  };
  return { from: () => builder } as unknown as SupabaseClient;
}

describe("senha da conexão presa à linha", () => {
  it("gravada por cifrarSenha, abre na própria conexão", async () => {
    const r = await carregarConexao(
      adminCom(linha("conn-1", cifrarSenha("s3gredo", { organizationId: ORG, connectionId: "conn-1" }))),
      ORG,
      "conn-1",
    );
    expect(r).toMatchObject({ ok: true, conexao: { password: "s3gredo" } });
  });

  it("copiada para a linha de OUTRA conexão, não abre (cifra_indisponivel)", async () => {
    const daConn1 = cifrarSenha("s3gredo", { organizationId: ORG, connectionId: "conn-1" });
    const r = await carregarConexao(adminCom(linha("conn-2", daConn1)), ORG, "conn-2");
    expect(r).toEqual({ ok: false, motivo: "cifra_indisponivel" });
  });

  it("linha antiga, cifrada sem contexto (iv de 12 bytes), continua abrindo", async () => {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", Buffer.alloc(32, 7), iv);
    const ciphertext = Buffer.concat([cipher.update("senha-de-antes", "utf8"), cipher.final()]);
    const antiga = {
      password_encrypted: `\\x${ciphertext.toString("hex")}`,
      password_iv: `\\x${iv.toString("hex")}`,
      password_tag: `\\x${cipher.getAuthTag().toString("hex")}`,
    };
    const r = await carregarConexao(adminCom(linha("conn-1", antiga)), ORG, "conn-1");
    expect(r).toMatchObject({ ok: true, conexao: { password: "senha-de-antes" } });
  });
});
