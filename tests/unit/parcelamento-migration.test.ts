import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Migration 0945 (parcelamento do semestral e do anual no cartão, D-177, fork Hiperbold): este arquivo cobre a
 * FORMA. Migration e baseline dizem a mesma coisa, no lugar certo (depois da 0944 e antes da VARREDURA anon),
 * registradas no MANIFEST, reaplicáveis com o app no ar. O COMPORTAMENTO em banco é provado por
 * `tests/invariants/parcelamento-banco.test.ts` (`pnpm test:db`).
 */

const BASELINE = readFileSync(join(process.cwd(), "supabase/baseline.sql"), "utf8");
const MANIFEST = readFileSync(join(process.cwd(), "supabase/migrations/MANIFEST.md"), "utf8");

const ARQUIVO = "20261007140000_0945_parcelamento_do_semestral_e_do_anual.sql";
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

describe("0945: posição, igualdade e registro", () => {
  it("bloco único no baseline, depois da 0944 e antes da VARREDURA anon", () => {
    const inicio = BASELINE.lastIndexOf(marcador("0945"));
    expect(BASELINE.split(marcador("0945")).length - 1).toBe(1);
    expect(inicio).toBeGreaterThan(BASELINE.lastIndexOf(marcador("0944")));
    expect(inicio).toBeLessThan(BASELINE.lastIndexOf("-- ---- VARREDURA anon:"));
  });

  it("o SQL da migration e o do bloco são iguais, ignorando comentários", () => {
    expect(codigo(extraiBloco("0945"))).toBe(c);
  });

  it("registrada no MANIFEST", () => {
    expect(MANIFEST).toContain("`0945_parcelamento_do_semestral_e_do_anual`");
  });

  it("sem travessão, sem apagar dado, e os únicos drops são as assinaturas antigas de fn_billing_criar_pedido", () => {
    expect(migration.includes(String.fromCharCode(0x2014))).toBe(false);
    expect(c).not.toMatch(/drop table|delete from|truncate table/);
    expect(c.match(/drop function/g)?.length).toBe(2);
    expect(c).toMatch(/drop function if exists public\.fn_billing_criar_pedido\(uuid, text, text, text, text, text, text, uuid, uuid, text\);/);
    expect(c).toMatch(/drop function if exists public\.fn_billing_criar_pedido\(uuid, text, text, text, text, text, text, uuid, uuid\);/);
  });
});

describe("0945: o que ela faz", () => {
  it("as colunas só nascem quando faltam, com lock_timeout curto", () => {
    expect(c).toMatch(/set_config\('lock_timeout', '3s', true\)/);
    expect(c).toMatch(/column_name = 'parcelas'\s*\) then\s+alter table public\.billing_orders add column parcelas integer not null default 1;/);
    expect(c).toMatch(/column_name = 'asaas_installment_id'\s*\) then\s+alter table public\.billing_orders add column asaas_installment_id text;/);
    expect(c).not.toMatch(/add column if not exists/);
  });

  it("os parâmetros são semeados uma vez, pela marca", () => {
    expect(c).toMatch(/where id = 1 and parcelamento_semeado_em is null\) then\s+update public\.billing_settings\s+set parcelamento_taxa_mensal = 0\.0199,\s+parcelamento_sem_juros_ate = 3,\s+parcelamento_max_semestral = 6,\s+parcelamento_max_anual = 12,\s+parcelamento_semeado_em = now\(\)/);
  });

  it("os parâmetros novos de fn_billing_criar_pedido são os últimos e têm default", () => {
    expect(c).toMatch(/p_termos_versao text default null,\s+p_parcelas integer default 1,\s+p_total_cents integer default null\s*\)/);
  });

  it("recusa parcelamento fora do cartão, fora do semestral e do anual, acima do teto e com total divergente", () => {
    for (const codigoDoErro of [
      "billing_parcelas_invalidas",
      "billing_parcelamento_indisponivel",
      "billing_parcelamento_so_no_cartao",
      "billing_parcelas_acima_do_teto",
      "billing_parcelamento_total_divergente",
    ]) {
      expect(c).toContain(`raise exception '${codigoDoErro}' using errcode = '22023'`);
    }
  });

  it("o período do parcelamento usa a conta do Pix e a conferência de valor é pelo total do parcelamento", () => {
    expect(c).toContain("(v_pedido.metodo = 'PIX' or v_pedido.parcelas > 1) and v_pedido.ciclo in ('semiannual', 'yearly')");
    expect(c).toContain("v_comparado_cents := v_total_parcelamento_cents;");
    expect(c).toContain("(nullif(p_confirmacao->>'parcelamento_total', ''))::numeric * 100");
  });

  it("as parcelas seguintes entram com período nulo e o estorno parcial do parcelamento só alarma", () => {
    expect(c).toContain("'Asaas: parcela do parcelamento'");
    expect(c).toContain("estorno_confirmado,estorno_parcial_do_parcelamento");
    expect(c).toMatch(/if v_estornadas < v_parcelas_do_pedido then/);
  });

  it("tudo que cria função vai numa única transação, e o ACL é repetido (só service_role nas de borda)", () => {
    expect(c.match(/^begin;$/gm)?.length).toBe(1);
    expect(c.match(/^commit;$/gm)?.length).toBe(1);
    expect(c).toMatch(/revoke execute on function public\.fn_billing_criar_pedido\(uuid, text, text, text, text, text, text, uuid, uuid, text, integer, integer\) from public, anon, authenticated;/);
    expect(c).toMatch(/grant execute on function public\.fn_billing_criar_pedido\(uuid, text, text, text, text, text, text, uuid, uuid, text, integer, integer\) to service_role;/);
    expect(c).toMatch(/revoke execute on function public\.fn_billing_pedido_registrar_parcelamento\(uuid, uuid, text\) from public, anon, authenticated;/);
    expect(c).toMatch(/grant execute on function public\.fn_billing_pedido_registrar_parcelamento\(uuid, uuid, text\) to service_role;/);
    expect(c).toMatch(/revoke execute on function public\.fn_billing_parcelamento_total\(integer, integer, numeric, integer\) from public, anon, authenticated, service_role;/);
  });
});
