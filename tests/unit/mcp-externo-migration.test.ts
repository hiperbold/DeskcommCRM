import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Timestamp deslocado 1s no merge de 2026-09-22: colidia com a migration 0321
// do autor, que carimba o mesmo instante. Número 0901 (faixa do fork) inalterado.
const MIGRATION = readFileSync(
  join(process.cwd(), "supabase/migrations/20260919120001_0901_conexoes_mcp.sql"),
  "utf8",
);
const BASELINE = readFileSync(join(process.cwd(), "supabase/baseline.sql"), "utf8");

describe("0901 conexões MCP", () => {
  it("a credencial não é legível por quem acessa o banco pela API pública", () => {
    // Quem lê a coluna cifrada com a service key é só o servidor. anon e
    // authenticated não enxergam a tabela: tudo passa pela rota, que filtra
    // por organização e nunca devolve o cabeçalho.
    for (const sql of [MIGRATION, BASELINE]) {
      expect(sql).toMatch(/revoke all on public\.ai_mcp_connections from anon, authenticated/);
      expect(sql).toMatch(/alter table public\.ai_mcp_connections enable row level security/);
    }
  });

  it("o apelido é único por organização e tem o formato do id da ferramenta", () => {
    expect(MIGRATION).toMatch(/unique \(organization_id, slug\)/);
    expect(MIGRATION).toContain("slug ~ '^[a-z0-9]{2,12}$'");
  });

  it("só aceita https", () => {
    expect(MIGRATION).toContain("url ~ '^https://'");
  });
});
