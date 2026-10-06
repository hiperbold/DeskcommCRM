import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Migration 0941 (D-176, fork Hiperbold): venda do plano no ciclo semestral e anual, à vista. Este
 * arquivo cobre a FORMA: migration e baseline dizem a mesma coisa, no lugar certo (depois da 0940 e
 * antes da VARREDURA anon), registradas no MANIFEST, reaplicáveis com o app no ar. O COMPORTAMENTO
 * em banco é provado por `tests/invariants/venda-semestral-e-anual-banco.test.ts` (`pnpm test:db`).
 */

const BASELINE = readFileSync(join(process.cwd(), "supabase/baseline.sql"), "utf8");
const MANIFEST = readFileSync(join(process.cwd(), "supabase/migrations/MANIFEST.md"), "utf8");

const ARQUIVO = "20261007100000_0941_venda_semestral_e_anual.sql";
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

describe("0941: posição, igualdade e registro", () => {
  it("bloco único no baseline, depois da 0940 e antes da VARREDURA anon", () => {
    const inicio = BASELINE.lastIndexOf(marcador("0941"));
    expect(BASELINE.split(marcador("0941")).length - 1).toBe(1);
    expect(inicio).toBeGreaterThan(BASELINE.lastIndexOf(marcador("0940")));
    expect(inicio).toBeLessThan(BASELINE.lastIndexOf("-- ---- VARREDURA anon:"));
  });

  it("o SQL da migration e o do bloco são iguais, ignorando comentários", () => {
    expect(codigo(extraiBloco("0941"))).toBe(c);
  });

  it("registrada no MANIFEST", () => {
    expect(MANIFEST).toContain("`0941_venda_semestral_e_anual`");
  });

  it("sem travessão e sem nada que apague ou reescreva linha fora do preço nulo", () => {
    expect(migration.includes(String.fromCharCode(0x2014))).toBe(false);
    expect(c).not.toMatch(/drop table|drop function|delete from|truncate table/);
  });
});

describe("0941: o que ela muda", () => {
  it("cria a coluna do preço semestral e só recria a constraint de ciclo quando ela ainda não conhece o valor novo", () => {
    expect(c).toMatch(/add column if not exists price_semiannual_cents integer/);
    expect(c).toMatch(/conname = 'billing_contracts_cycle_check'\s+and pg_get_constraintdef\(oid\) like '%semiannual%'/);
    expect(c).toMatch(/conname = 'billing_orders_ciclo_check'\s+and pg_get_constraintdef\(oid\) like '%semiannual%'/);
    expect(c).toMatch(/cycle in \('monthly', 'semiannual', 'yearly'\)/);
    expect(c).toMatch(/ciclo in \('monthly', 'semiannual', 'yearly'\)/);
    expect(c).toMatch(/set_config\('lock_timeout', '3s', true\)/);
  });

  it("grava os seis preços decididos em 29/09/2026, na versão ativa, só onde a coluna está nula", () => {
    for (const centavos of ["104900", "189900", "214900", "379900", "319900", "574900"]) {
      expect(c).toContain(centavos);
    }
    expect(c).toMatch(/where active\s+and code in \('pro', 'max', 'escale'\)\s+and price_semiannual_cents is null/);
    expect(c).toMatch(/where active\s+and code in \('pro', 'max', 'escale'\)\s+and price_yearly_cents is null/);
    expect(c).not.toMatch(/price_monthly_cents\s*=/);
    expect(c).not.toMatch(/for_sale\s*=/);
  });

  it("o período do semestral soma seis meses e o Pix semestral também", () => {
    expect(c).toMatch(/when 'semiannual' then interval '6 months'/);
    expect(c).toMatch(/ciclo in \('semiannual', 'yearly'\)/);
  });

  it("criar pedido recusa a troca de ciclo e lê o preço da coluna do ciclo", () => {
    expect(c).toMatch(/raise exception 'billing_troca_de_ciclo_indisponivel' using errcode = '22023'/);
    expect(c).toMatch(/when 'semiannual' then v_plan\.price_semiannual_cents/);
  });

  it("nenhuma função de tokens, estorno ou cancelamento é tocada", () => {
    expect(c).not.toMatch(/fn_billing_garantir_concessoes|fn_billing_asaas_cortar_por_estorno_total|fn_billing_asaas_aplicar_estorno|fn_billing_asaas_marcar_assinatura_encerrada/);
  });

  it("as funções seguem só do servidor (ACL repetido)", () => {
    expect(c).toMatch(/revoke execute on function public\.fn_billing_criar_pedido\(.*\) from public, anon, authenticated;/);
    expect(c).toMatch(/grant execute on function public\.fn_billing_criar_pedido\(.*\) to service_role;/);
    expect(c).toMatch(/revoke execute on function public\.fn_billing_asaas_periodo_do_ciclo\(date, text\) from public, anon, authenticated, service_role;/);
    expect(c).toMatch(/revoke execute on function public\.fn_billing_asaas_aplicar_pagamento\(jsonb, text\) from public, anon, authenticated, service_role;/);
  });
});
