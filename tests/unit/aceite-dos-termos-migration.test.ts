import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Migration 0943 (aceite dos Termos de Uso na compra, D-133, fork Hiperbold): este arquivo cobre a
 * FORMA. Migration e baseline dizem a mesma coisa, no lugar certo (depois da 0942 e antes da
 * VARREDURA anon), registradas no MANIFEST, reaplicáveis com o app no ar. O COMPORTAMENTO em banco
 * é provado por `tests/invariants/aceite-dos-termos-banco.test.ts` (`pnpm test:db`).
 */

const BASELINE = readFileSync(join(process.cwd(), "supabase/baseline.sql"), "utf8");
const MANIFEST = readFileSync(join(process.cwd(), "supabase/migrations/MANIFEST.md"), "utf8");

const ARQUIVO = "20261007120000_0943_aceite_dos_termos_na_compra.sql";
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

describe("0943: posição, igualdade e registro", () => {
  it("bloco único no baseline, depois da 0942 e antes da VARREDURA anon", () => {
    const inicio = BASELINE.lastIndexOf(marcador("0943"));
    expect(BASELINE.split(marcador("0943")).length - 1).toBe(1);
    expect(inicio).toBeGreaterThan(BASELINE.lastIndexOf(marcador("0942")));
    expect(inicio).toBeLessThan(BASELINE.lastIndexOf("-- ---- VARREDURA anon:"));
  });

  it("o SQL da migration e o do bloco são iguais, ignorando comentários", () => {
    expect(codigo(extraiBloco("0943"))).toBe(c);
  });

  it("registrada no MANIFEST", () => {
    expect(MANIFEST).toContain("`0943_aceite_dos_termos_na_compra`");
  });

  it("sem travessão, sem apagar dado, e o único drop é o da assinatura antiga de fn_billing_criar_pedido", () => {
    expect(migration.includes(String.fromCharCode(0x2014))).toBe(false);
    expect(c).not.toMatch(/drop table|delete from|truncate table|update public\./);
    expect(c.match(/drop function/g)?.length).toBe(1);
    expect(c).toMatch(/drop function if exists public\.fn_billing_criar_pedido\(uuid, text, text, text, text, text, text, uuid, uuid\);/);
  });
});

describe("0943: o que ela faz", () => {
  it("as colunas só nascem quando faltam, com lock_timeout curto", () => {
    expect(c).toMatch(/set_config\('lock_timeout', '3s', true\)/);
    expect(c).toMatch(/column_name = 'termos_versao'\s*\) then\s+alter table public\.billing_orders add column termos_versao text;/);
    expect(c).toMatch(/column_name = 'termos_aceitos_em'\s*\) then\s+alter table public\.billing_orders add column termos_aceitos_em timestamptz;/);
    expect(c).not.toMatch(/add column if not exists/);
  });

  it("o parâmetro novo é o último e tem default nulo", () => {
    expect(c).toMatch(/p_actor uuid,\s+p_termos_versao text default null\s*\)/);
  });

  it("a compra com ator sem versão é recusada e a versão em branco ou longa também", () => {
    expect(c).toMatch(/if p_actor is not null and p_termos_versao is null then\s+raise exception 'billing_termos_nao_aceitos' using errcode = '22023'/);
    expect(c).toMatch(/btrim\(p_termos_versao\) = '' or length\(p_termos_versao\) > 40\) then\s+raise exception 'billing_termos_invalidos'/);
  });

  it("o pedido grava a versão e o momento", () => {
    expect(c).toMatch(/criado_por, termos_versao, termos_aceitos_em/);
    expect(c).toMatch(/btrim\(p_termos_versao\),\s+case when p_termos_versao is null then null else now\(\) end/);
  });

  it("segue só do servidor (ACL repetido na assinatura nova)", () => {
    expect(c).toMatch(/revoke execute on function public\.fn_billing_criar_pedido\(uuid, text, text, text, text, text, text, uuid, uuid, text\) from public, anon, authenticated;/);
    expect(c).toMatch(/grant execute on function public\.fn_billing_criar_pedido\(uuid, text, text, text, text, text, text, uuid, uuid, text\) to service_role;/);
  });
});
