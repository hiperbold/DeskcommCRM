import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Migration 0914 (D-083, achado 4, fork Hiperbold): `channel_sessions.uazapi_base_url`
 * só é gravado pelo servidor da aplicação. Este arquivo cobre a FORMA (migration
 * e baseline dizem a mesma coisa, no lugar certo, com as garantias de segurança
 * da função); o COMPORTAMENTO em banco (authenticated admin recusado, service_role
 * grava) é provado por `tests/invariants/uazapi-servidor-so-pelo-servidor.test.ts`,
 * que precisa de Docker (`pnpm test:db`).
 */

const MIGRATION = readFileSync(
  join(process.cwd(), "supabase/migrations/20260930120000_0914_uazapi_servidor_so_pelo_servidor.sql"),
  "utf8",
);
const BASELINE = readFileSync(join(process.cwd(), "supabase/baseline.sql"), "utf8");
const MANIFEST = readFileSync(join(process.cwd(), "supabase/migrations/MANIFEST.md"), "utf8");

const MARCADOR_0914 = "-- ---- o servidor da conexão UAZAPI só é gravado pelo servidor da aplicação (migration 0914";

/** Do marcador do bloco 0914 até (sem incluir) o cabeçalho do PRÓXIMO bloco. */
function extraiBloco0914Baseline(): string {
  const posicaoMarcador = BASELINE.indexOf(MARCADOR_0914);
  const fim = BASELINE.indexOf("\n-- ---- ", posicaoMarcador + MARCADOR_0914.length);
  return BASELINE.slice(posicaoMarcador, fim + 1);
}

function semComentariosEBrancas(sql: string): string {
  return sql
    .split("\n")
    .map((linha) => linha.trim())
    .filter((linha) => linha.length > 0 && !linha.startsWith("--"))
    .join("\n");
}

describe("0914: posição e igualdade", () => {
  it("o bloco do baseline vem depois do bloco da 0913 e antes da VARREDURA anon", () => {
    const inicio0913 = BASELINE.indexOf("-- ---- estimativa de custo da margem casa o modelo pelo prefixo (migration 0913");
    const inicio0914 = BASELINE.indexOf(MARCADOR_0914);
    const varreduraAnon = BASELINE.lastIndexOf("-- ---- VARREDURA anon:");
    expect(inicio0913).toBeGreaterThan(-1);
    expect(inicio0914).toBeGreaterThan(-1);
    expect(varreduraAnon).toBeGreaterThan(-1);
    expect(inicio0913).toBeLessThan(inicio0914);
    // A VARREDURA anon é o último bloco de propósito: função criada depois dela
    // nasceria exposta a anon em quem atualiza.
    expect(inicio0914).toBeLessThan(varreduraAnon);
  });

  it("o SQL da migração e o SQL do bloco do baseline são iguais, ignorando comentários e linhas em branco", () => {
    expect(semComentariosEBrancas(extraiBloco0914Baseline())).toBe(semComentariosEBrancas(MIGRATION));
  });

  it("está registrada no MANIFEST", () => {
    expect(MANIFEST).toMatch(/\| `20260930120000` \| `0914_uazapi_servidor_so_pelo_servidor` \|/);
  });

  it("nenhuma linha da migração usa travessão (U+2014)", () => {
    expect(MIGRATION.split("\n").filter((linha) => linha.includes(String.fromCharCode(0x2014)))).toEqual([]);
  });
});

describe("0914: o que o gatilho faz", () => {
  for (const [nome, sql] of [
    ["migração", MIGRATION],
    ["bloco do baseline", extraiBloco0914Baseline()],
  ] as const) {
    describe(nome, () => {
      const codigo = semComentariosEBrancas(sql);

      it("gatilho BEFORE INSERT OR UPDATE OF uazapi_base_url, por linha, em channel_sessions", () => {
        expect(codigo).toMatch(
          /create or replace trigger trg_channel_sessions_trava_uazapi_base_url\s+before insert or update of uazapi_base_url on public\.channel_sessions\s+for each row\s+execute function public\.fn_channel_sessions_trava_uazapi_base_url\(\);/,
        );
      });

      it("decide pelo critério do servidor (fn_billing_e_servidor), recusa com 42501 e mensagem fixa", () => {
        expect(codigo).toMatch(/if not public\.fn_billing_e_servidor\(\) and \(/);
        expect(codigo).toMatch(/tg_op = 'INSERT' and new\.uazapi_base_url is not null/);
        expect(codigo).toMatch(/tg_op = 'UPDATE' and new\.uazapi_base_url is distinct from old\.uazapi_base_url/);
        expect(codigo).toMatch(
          /raise exception 'uazapi_base_url só pode ser alterado pelo servidor' using errcode = '42501';/,
        );
      });

      it("security definer, search_path fixo, execute só para service_role", () => {
        expect(codigo).toMatch(
          /^create or replace function public\.fn_channel_sessions_trava_uazapi_base_url\(\)\s*returns trigger\s*language plpgsql\s*security definer\s*set search_path = public, pg_temp/,
        );
        expect(codigo).toMatch(
          /revoke execute on function public\.fn_channel_sessions_trava_uazapi_base_url\(\) from public, anon, authenticated;/,
        );
        expect(codigo).toMatch(
          /grant execute on function public\.fn_channel_sessions_trava_uazapi_base_url\(\) to service_role;/,
        );
      });

      it("reaplicável com o app no ar: só create or replace, sem tabela, constraint, índice nem reescrita de linha", () => {
        expect(codigo).not.toMatch(/alter table/);
        expect(codigo).not.toMatch(/create table/);
        expect(codigo).not.toMatch(/create index/);
        expect(codigo).not.toMatch(/drop trigger/);
        expect(codigo).not.toMatch(/\bupdate public\./);
        expect(codigo).not.toMatch(/\bdelete from\b/);
        expect(codigo).not.toMatch(/add constraint/);
      });
    });
  }
});
