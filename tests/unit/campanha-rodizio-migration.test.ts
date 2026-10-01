import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Migration 0920 (D-098, fork Hiperbold): `campaigns.last_tick_at` e o índice do
 * rodízio da rodada. Cobre a FORMA (migration e baseline iguais, no lugar certo,
 * reaplicável). O comportamento do rodízio é provado em
 * `tests/unit/campanha-rodizio-da-rodada.test.ts`.
 */

const MIGRATION = readFileSync(
  join(process.cwd(), "supabase/migrations/20260930171000_0920_campanha_rodizio_da_rodada.sql"),
  "utf8",
);
const BASELINE = readFileSync(join(process.cwd(), "supabase/baseline.sql"), "utf8");
const MANIFEST = readFileSync(join(process.cwd(), "supabase/migrations/MANIFEST.md"), "utf8");

const MARCADOR_0919 = "-- ---- mídia e Storage: o que um membro grava não alcança o arquivo de outra empresa (migration 0919";
const MARCADOR_0920 = "-- ---- rodízio da rodada de campanhas: campaigns.last_tick_at (migration 0920";

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

describe("0920: posição e igualdade", () => {
  it("o bloco do baseline vem depois do da 0919 e antes da VARREDURA anon, uma vez só", () => {
    const inicio0919 = BASELINE.lastIndexOf(MARCADOR_0919);
    const inicio0920 = BASELINE.lastIndexOf(MARCADOR_0920);
    expect(inicio0920).toBeGreaterThan(inicio0919);
    expect(inicio0920).toBeLessThan(BASELINE.lastIndexOf("-- ---- VARREDURA anon:"));
    expect(BASELINE.split(MARCADOR_0920).length - 1).toBe(1);
  });

  it("o SQL da migração e o do bloco são iguais, ignorando comentários", () => {
    expect(codigoDe(extraiBloco(MARCADOR_0920))).toBe(codigoDe(MIGRATION));
  });

  it("está no MANIFEST e sem travessão", () => {
    expect(MANIFEST).toMatch(/\| `20260930171000` \| `0920_campanha_rodizio_da_rodada` \|/);
    const travessao = String.fromCharCode(0x2014);
    expect(MIGRATION.includes(travessao)).toBe(false);
  });
});

describe("0920: reaplicável com o app no ar", () => {
  const codigo = codigoDe(MIGRATION);
  it("coluna nula sem default, índice parcial, if not exists e lock_timeout curto", () => {
    expect(codigo).toMatch(/set_config\('lock_timeout','3s',true\)/);
    expect(codigo).toMatch(/add column if not exists last_tick_at timestamptz;/);
    expect(codigo).not.toMatch(/last_tick_at timestamptz (not null|default)/);
    expect(codigo).toMatch(/create index if not exists idx_campaigns_rodizio_running/);
    expect(codigo).toMatch(/where status = 'running'/);
    expect(codigo).not.toMatch(/create (or replace )?function|drop |update public\./);
  });
});
