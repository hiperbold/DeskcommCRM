import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Migration 0942 (correção da auditoria do lote 15, fork Hiperbold): este arquivo cobre a FORMA.
 * Migration e baseline dizem a mesma coisa, no lugar certo (depois da 0941 e antes da VARREDURA
 * anon), registradas no MANIFEST, reaplicáveis com o app no ar; e o bloco da 0941 no baseline foi
 * corrigido (ALTER só quando a coluna falta, preços semeados uma vez). O COMPORTAMENTO em banco é
 * provado por `tests/invariants/lote15-auditoria-banco.test.ts` (`pnpm test:db`).
 */

const BASELINE = readFileSync(join(process.cwd(), "supabase/baseline.sql"), "utf8");
const MANIFEST = readFileSync(join(process.cwd(), "supabase/migrations/MANIFEST.md"), "utf8");

const ARQUIVO = "20261007110000_0942_auditoria_do_lote_15.sql";
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
const bloco0941 = codigo(extraiBloco("0941"));
const doDa0941 = bloco0941.match(/do \$ciclos_semestral_e_anual\$[\s\S]*?\$ciclos_semestral_e_anual\$;/)?.[0] ?? "";

describe("0942: posição, igualdade e registro", () => {
  it("bloco único no baseline, depois da 0941 e antes da VARREDURA anon", () => {
    const inicio = BASELINE.lastIndexOf(marcador("0942"));
    expect(BASELINE.split(marcador("0942")).length - 1).toBe(1);
    expect(inicio).toBeGreaterThan(BASELINE.lastIndexOf(marcador("0941")));
    expect(inicio).toBeLessThan(BASELINE.lastIndexOf("-- ---- VARREDURA anon:"));
  });

  it("o SQL da migration e o do bloco são iguais, ignorando comentários", () => {
    expect(codigo(extraiBloco("0942"))).toBe(c);
  });

  it("registrada no MANIFEST", () => {
    expect(MANIFEST).toContain("`0942_auditoria_do_lote_15`");
  });

  it("sem travessão e sem nada que apague ou reescreva linha de dado", () => {
    expect(migration.includes(String.fromCharCode(0x2014))).toBe(false);
    expect(c).not.toMatch(/drop table|drop function|delete from|truncate table/);
    expect(c).not.toMatch(/update public\.billing_plans/);
  });
});

describe("0942: o que ela redefine", () => {
  it("recusa a troca de plano com período pago vigente, no cartão e no Pix, e defende na aplicação", () => {
    expect(c).toMatch(/raise exception 'billing_troca_de_plano_indisponivel' using errcode = '22023'/);
    expect(c).toMatch(/'troca_de_plano_com_periodo_vigente'/);
  });

  it("o Pix empilhado não soma o dia extra e o início do contrato nunca vai para o futuro", () => {
    expect(c).toMatch(/v_periodo_fim := v_periodo_inicio \+ v_intervalo;/);
    expect(c).toMatch(/v_periodo_fim := v_periodo_inicio \+ v_intervalo \+ interval '1 day';/);
    expect(c).toMatch(/when v_periodo_inicio <= now\(\) then v_periodo_inicio/);
  });

  it("o estorno recalcula o fim pelo maior fim dos pagamentos não estornados e só encurta quando sobra cobertura", () => {
    expect(c).toMatch(/select max\(p\.billing_period_end\) into v_fim_restante/);
    expect(c).toMatch(/if v_fim_restante > now\(\) then/);
    expect(c).toMatch(/'estorno_encurtou_periodo'/);
  });

  it("a renovação abaixo do preço do ciclo é divergente e a assinatura encerrada não é renovação", () => {
    expect(c).toMatch(/v_valor_cents < v_esperado_cents then\s+return jsonb_build_object\(\s+'resultado', 'divergente'/);
    expect(c).toMatch(/asaas_assinatura_encerrada_em is null;/);
    expect(c).toMatch(/when v_contract\.asaas_assinatura_encerrada_em is not null then null/);
  });

  it("a coluna da marca só nasce quando falta, com lock_timeout curto", () => {
    expect(c).toMatch(/set_config\('lock_timeout', '3s', true\)/);
    expect(c).toMatch(/column_name = 'precos_de_ciclo_semeados_em'\s*\) then\s+alter table public\.billing_settings add column precos_de_ciclo_semeados_em timestamptz;/);
    expect(c).not.toMatch(/add column if not exists/);
  });

  it("as funções seguem só do servidor (ACL repetido)", () => {
    expect(c).toMatch(/revoke execute on function public\.fn_billing_criar_pedido\(.*\) from public, anon, authenticated;/);
    expect(c).toMatch(/grant execute on function public\.fn_billing_criar_pedido\(.*\) to service_role;/);
    expect(c).toMatch(/revoke execute on function public\.fn_billing_asaas_aplicar_pagamento\(jsonb, text\) from public, anon, authenticated, service_role;/);
    expect(c).toMatch(/revoke execute on function public\.fn_billing_asaas_rotear_pagamento\(text, text, text, text\) from public, anon, authenticated, service_role;/);
    expect(c).toMatch(/revoke execute on function public\.fn_billing_asaas_cortar_por_estorno_total\(.*\) from public, anon, authenticated, service_role;/);
  });
});

describe("0942: o bloco da 0941 no baseline foi corrigido (itens 3 e 5)", () => {
  it("a sonda está viva: o DO da 0941 foi achado no bloco do baseline", () => {
    expect(doDa0941.length).toBeGreaterThan(500);
  });

  it("o ALTER das colunas só roda quando a coluna não existe (information_schema), sem add column if not exists", () => {
    expect(doDa0941).not.toMatch(/add column if not exists/);
    expect(doDa0941).toMatch(/column_name = 'price_semiannual_cents'\s*\) then\s+alter table public\.billing_plans add column price_semiannual_cents integer;/);
  });

  it("os preços só são semeados quando a marca está nula, na versão 1, e a marca é gravada no fim", () => {
    expect(doDa0941).toMatch(/if exists \(select 1 from public\.billing_settings where id = 1 and precos_de_ciclo_semeados_em is null\) then/);
    expect(doDa0941.match(/and version = 1/g)?.length).toBe(2);
    expect(doDa0941).toMatch(/update public\.billing_settings set precos_de_ciclo_semeados_em = now\(\) where id = 1;\s+end if;/);
    // Nenhuma semeadura fora do if da marca.
    const antesDoIf = doDa0941.slice(0, doDa0941.indexOf("precos_de_ciclo_semeados_em is null"));
    expect(antesDoIf).not.toMatch(/update public\.billing_plans/);
  });
});
