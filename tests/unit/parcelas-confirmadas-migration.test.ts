import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Migration 0947 (parcelas confirmadas e parcelamento removido, D-177, fork Hiperbold): este arquivo cobre a
 * FORMA. Migration e baseline dizem a mesma coisa, no lugar certo (depois da 0946 e antes da VARREDURA anon),
 * registradas no MANIFEST, numa transação curta com lock_timeout. O COMPORTAMENTO em banco é provado por
 * `tests/invariants/parcelamento-banco.test.ts` (`pnpm test:db`).
 */

const BASELINE = readFileSync(join(process.cwd(), "supabase/baseline.sql"), "utf8");
const MANIFEST = readFileSync(join(process.cwd(), "supabase/migrations/MANIFEST.md"), "utf8");

const ARQUIVO = "20261007170000_0947_parcelas_confirmadas_e_parcelamento_removido.sql";
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

describe("0947: posição, igualdade e registro", () => {
  it("bloco único no baseline, depois da 0946 e antes da VARREDURA anon", () => {
    const inicio = BASELINE.lastIndexOf(marcador("0947"));
    expect(BASELINE.split(marcador("0947")).length - 1).toBe(1);
    expect(inicio).toBeGreaterThan(BASELINE.lastIndexOf(marcador("0946")));
    expect(inicio).toBeLessThan(BASELINE.lastIndexOf("-- ---- VARREDURA anon:"));
  });

  it("o SQL da migration e o do bloco são iguais, ignorando comentários", () => {
    expect(codigo(extraiBloco("0947"))).toBe(c);
  });

  it("registrada no MANIFEST", () => {
    expect(MANIFEST).toContain("`0947_parcelas_confirmadas_e_parcelamento_removido`");
  });

  it("sem travessão, sem apagar nada, sem DDL: só redefine a função, numa transação com lock_timeout", () => {
    expect(migration.includes(String.fromCharCode(0x2014))).toBe(false);
    expect(c).not.toMatch(/drop |delete from|truncate table|alter table|create table/);
    expect(c.match(/^begin;$/gm)?.length).toBe(1);
    expect(c.match(/^commit;$/gm)?.length).toBe(1);
    expect(c).toContain("select set_config('lock_timeout', '3s', true);");
    expect(c.match(/create or replace function/g)?.length).toBe(1);
    expect(c).toContain("create or replace function public.fn_billing_asaas_aplicar_pagamento(p_confirmacao jsonb, p_ambiente text)");
    expect(c).toMatch(/revoke execute on function public\.fn_billing_asaas_aplicar_pagamento\(jsonb, text\) from public, anon, authenticated, service_role;/);
  });
});

describe("0947: o que ela faz", () => {
  it("M2: só concede com todas as parcelas confirmadas, senão aguardando", () => {
    expect(c).toContain("coalesce((nullif(p_confirmacao->>'parcelamento_confirmadas', ''))::integer, 0) < v_pedido.parcelas");
    expect(c).toContain("'erro_codigo', 'billing_parcelamento_parcelas_pendentes'");
  });

  it("B4: parcelamento removido com parcela confirmada alarma, no pedido aberto e no pago", () => {
    expect(c.split("to_jsonb(array['parcelamento_removido_com_pagamento'])").length - 1).toBe(2);
    expect(c).toContain("coalesce(p_confirmacao->>'parcelamento_removido', '') = 'true'");
  });

  it("mantém o que a 0945 já fazia: período uma vez, total do parcelamento, parcelas seguintes com período nulo", () => {
    expect(c).toContain("(v_pedido.metodo = 'PIX' or v_pedido.parcelas > 1) and v_pedido.ciclo in ('semiannual', 'yearly')");
    expect(c).toContain("v_comparado_cents := v_total_parcelamento_cents;");
    expect(c).toContain("'Asaas: parcela do parcelamento'");
    expect(c).toContain("'billing_parcelamento_sem_total'");
  });
});
