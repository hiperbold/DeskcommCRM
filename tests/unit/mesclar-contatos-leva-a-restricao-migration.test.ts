import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Migration 0922 (D-143, fork Hiperbold). Cobre a FORMA: migration e baseline dizem a
 * mesma coisa, no lugar certo, e a função mantém tudo o que a 0407 fazia. O
 * COMPORTAMENTO é provado por `tests/invariants/mesclar-contatos-leva-a-restricao.test.ts`.
 */

const MIGRATION = readFileSync(
  join(process.cwd(), "supabase/migrations/20260930173000_0922_mesclar_contatos_leva_a_restricao.sql"),
  "utf8",
);
const M0407 = readFileSync(
  join(process.cwd(), "supabase/migrations/20260924200100_0407_social_identity_na_fusao.sql"),
  "utf8",
);
const BASELINE = readFileSync(join(process.cwd(), "supabase/baseline.sql"), "utf8");
const MANIFEST = readFileSync(join(process.cwd(), "supabase/migrations/MANIFEST.md"), "utf8");

const MARCADOR_0921 = "-- ---- a anonimização LGPD alcança o que sobrava do titular (migration 0921";
const MARCADOR_0922 = "-- ---- mesclar contatos leva o opt-out e a trava force_human (migration 0922";

function extraiBloco(marcador: string): string {
  const inicio = BASELINE.lastIndexOf(marcador);
  const fim = BASELINE.indexOf("\n-- ---- ", inicio + marcador.length);
  return BASELINE.slice(inicio, fim + 1);
}

function codigoDe(sql: string): string {
  return sql
    .split("\n")
    .map((linha) => linha.trim())
    .filter((linha) => linha.length > 0 && !linha.startsWith("--"))
    .join("\n");
}

describe("0922: posição e igualdade", () => {
  it("o bloco do baseline vem depois do da 0921 e antes da VARREDURA anon, uma vez só", () => {
    const inicio0921 = BASELINE.lastIndexOf(MARCADOR_0921);
    const inicio0922 = BASELINE.lastIndexOf(MARCADOR_0922);
    expect(inicio0921).toBeGreaterThan(-1);
    expect(inicio0922).toBeGreaterThan(inicio0921);
    expect(inicio0922).toBeLessThan(BASELINE.lastIndexOf("-- ---- VARREDURA anon:"));
    expect(BASELINE.split(MARCADOR_0922).length - 1).toBe(1);
  });

  it("o SQL da migração e o do bloco são iguais, ignorando comentários", () => {
    expect(codigoDe(extraiBloco(MARCADOR_0922))).toBe(codigoDe(MIGRATION));
  });

  it("está no MANIFEST, depois da 0921, e sem travessão", () => {
    expect(MANIFEST).toMatch(/\| `20260930173000` \| `0922_mesclar_contatos_leva_a_restricao` \|/);
    expect(MANIFEST.indexOf("`0921_lgpd_anonimizacao")).toBeLessThan(MANIFEST.indexOf("`0922_mesclar_contatos"));
    expect(MIGRATION.includes(String.fromCharCode(0x2014))).toBe(false);
  });
});

describe("0922: a função leva a restrição e não perde o que a 0407 fazia", () => {
  const codigo = codigoDe(MIGRATION);

  it("is_blocked e force_human viram OU, com carimbo e motivo", () => {
    expect(codigo).toMatch(/coalesce\(v_principal\.is_blocked, false\) or coalesce\(bool_or\(c\.is_blocked\), false\)/);
    expect(codigo).toMatch(/coalesce\(v_principal\.force_human, false\) or coalesce\(bool_or\(c\.force_human\), false\)/);
    expect(codigo).toMatch(/is_blocked = v_bloqueado,/);
    expect(codigo).toMatch(/force_human = v_force_human,/);
    expect(codigo).toMatch(/coalesce\(blocked_at, v_bloqueado_em, now\(\)\)/);
    expect(codigo).toMatch(/coalesce\(blocked_reason, v_bloqueado_motivo\)/);
  });

  it("só a recusa do consentimento é levada; concessão não", () => {
    expect(codigo).toMatch(/e\.value = 'false'::jsonb/);
    expect(codigo).toMatch(/e\.value->>'revoked_at' is not null/);
  });

  it("todo o corpo da 0407 continua: cada trecho dela está na nova", () => {
    // sonda-do-baseline: primeira-de-proposito: lê o arquivo da 0407, que tem uma única função, não o baseline.
    const antigo = codigoDe(M0407.slice(M0407.indexOf("CREATE OR REPLACE FUNCTION")));
    // Cada linha da 0407 tem de existir na 0922 (a nova só ACRESCENTA).
    const novas = new Set(codigo.split("\n"));
    const perdidas = antigo.split("\n").filter((l) => !novas.has(l));
    expect(perdidas).toEqual([]);
  });

  it("segue security definer com search_path vazio e o mesmo grant", () => {
    expect(codigo).toMatch(/SECURITY DEFINER\s+SET search_path TO ''/);
    expect(codigo).toMatch(/revoke execute on function public\.fn_mesclar_contatos\(uuid, uuid, uuid\[\]\) from public, anon;/);
    expect(codigo).toMatch(/grant execute on function public\.fn_mesclar_contatos\(uuid, uuid, uuid\[\]\) to authenticated, service_role;/);
  });
});
