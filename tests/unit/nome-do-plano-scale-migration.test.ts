import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Migration 0951 (o plano de código `escale` passa a se chamar Scale na tela, fork Hiperbold): este arquivo
 * cobre a FORMA. Migration e baseline dizem a mesma coisa, no lugar certo (depois da 0948 e antes da
 * VARREDURA anon), registradas no MANIFEST, reaplicáveis com o app no ar. O COMPORTAMENTO em banco é provado
 * por `tests/invariants/nome-do-plano-scale-banco.test.ts` (`pnpm test:db`).
 */

const BASELINE = readFileSync(join(process.cwd(), "supabase/baseline.sql"), "utf8");
const MANIFEST = readFileSync(join(process.cwd(), "supabase/migrations/MANIFEST.md"), "utf8");
const ARQUIVO = "20261008160000_0951_nome_do_plano_escale_vira_scale.sql";
const migration = readFileSync(join(process.cwd(), "supabase/migrations", ARQUIVO), "utf8");

function marcador(n: string): string {
  const achado = BASELINE.match(new RegExp(`^-- ---- .*\\(migration ${n}, fork Hiperbold[^\\n]*$`, "m"));
  if (!achado) throw new Error(`bloco da ${n} não está no baseline`);
  return achado[0];
}

function extraiBloco(n: string): string {
  const m = marcador(n);
  const inicio = BASELINE.lastIndexOf(m);
  const fim = BASELINE.indexOf("\n-- ---- ", inicio + m.length);
  return BASELINE.slice(inicio, fim + 1);
}

function codigo(sql: string): string {
  return sql
    .split("\n")
    .map((linha) => linha.trim())
    .filter((linha) => linha.length > 0 && !linha.startsWith("--"))
    .join("\n");
}

const c = codigo(migration);

describe("0951: posição, igualdade e registro", () => {
  it("bloco único no baseline, depois da 0948 e antes da VARREDURA anon", () => {
    const inicio = BASELINE.lastIndexOf(marcador("0951"));
    expect(BASELINE.split(marcador("0951")).length - 1).toBe(1);
    expect(inicio).toBeGreaterThan(BASELINE.lastIndexOf(marcador("0948")));
    expect(inicio).toBeLessThan(BASELINE.lastIndexOf("-- ---- VARREDURA anon:"));
  });

  it("o SQL da migration e o do bloco são iguais, ignorando comentários", () => {
    expect(codigo(extraiBloco("0951"))).toBe(c);
  });

  it("registrada no MANIFEST", () => {
    expect(MANIFEST).toContain("`0951_nome_do_plano_escale_vira_scale`");
  });
});

describe("0951: o que ela faz", () => {
  it("sem travessão, sem apagar nada, lock_timeout curto e num DO só", () => {
    expect(migration.includes(String.fromCharCode(0x2014))).toBe(false);
    expect(c).not.toMatch(/drop |delete from|truncate table|alter table|create table|create or replace function|insert into/);
    expect(c).toContain("perform set_config('lock_timeout', '3s', true);");
    expect(c.match(/^do \$d0951\$$/gm)?.length).toBe(1);
  });

  it("troca só o nome, só do código escale e só de quem ainda tem o nome antigo (preço, limite e código ficam)", () => {
    expect(c).toMatch(/update public\.billing_plans\s+set name = 'Scale'\s+where code = 'escale'\s+and name = 'Escale';/);
    expect(c).not.toMatch(/price_|limits|set code|active/);
  });
});
