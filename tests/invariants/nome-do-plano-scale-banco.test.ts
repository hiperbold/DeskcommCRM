/**
 * Migration 0951: o plano de código `escale` se chama Scale. Provado no Postgres real, depois do install
 * (baseline ou cadeia de migrations): o nome exibido é Scale, o código e o preço não mudaram, reaplicar é
 * idempotente, a troca alcança o nome antigo em qualquer versão e não sobrescreve um nome escolhido pelo
 * admin. As mudanças de teste correm numa transação que sempre desfaz.
 *
 * Roda via `pnpm test:db tests/invariants/nome-do-plano-scale-banco.test.ts`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { sql } from "./psql-transporte";

const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/20261008160000_0951_nome_do_plano_escale_vira_scale.sql"),
  "utf8",
);

describe("0951: nome exibido do plano escale", () => {
  it("depois do install, o plano escale ativo se chama Scale e os outros nomes não mudaram", () => {
    expect(sql(`select name from public.billing_plans where code = 'escale' and active;`)).toBe("Scale");
    expect(sql(`select code || '|' || name from public.billing_plans where active order by price_monthly_cents;`).split("\n")).toEqual([
      "ilimitado|Ilimitado",
      "pro|Pro",
      "max|Max",
      "escale|Scale",
    ]);
  });

  it("nenhuma versão do código escale guarda o nome antigo, e o código e o preço seguem os mesmos", () => {
    expect(sql(`select count(*) from public.billing_plans where name ilike 'escale';`)).toBe("0");
    expect(sql(`select code || '|' || price_monthly_cents from public.billing_plans where code = 'escale' and active;`)).toBe("escale|59900");
  });

  it("reaplicar a migration com o nome antigo volta para Scale, em todas as versões do código", () => {
    const saida = sql(`
      begin;
      update public.billing_plans set name = 'Escale' where code = 'escale';
      ${migration}
      select 'RESULTADO|' || count(*) filter (where name = 'Scale') || '|' || count(*) filter (where name <> 'Scale') from public.billing_plans where code = 'escale';
      rollback;
    `);
    const linha = saida.split("\n").find((l) => l.startsWith("RESULTADO|")) ?? "";
    const [, scale, outros] = linha.split("|");
    expect(Number(scale)).toBeGreaterThanOrEqual(1);
    expect(outros).toBe("0");
  });

  it("reaplicar é idempotente e não sobrescreve um nome que o admin escolheu", () => {
    const saida = sql(`
      begin;
      update public.billing_plans set name = 'Nome do admin' where code = 'escale' and active;
      ${migration}
      ${migration}
      select 'RESULTADO|' || name from public.billing_plans where code = 'escale' and active;
      rollback;
    `);
    const linha = saida.split("\n").find((l) => l.startsWith("RESULTADO|")) ?? "";
    expect(linha).toBe("RESULTADO|Nome do admin");
  });

  it("o rollback não vazou: o plano segue Scale depois dos casos acima", () => {
    expect(sql(`select name from public.billing_plans where code = 'escale' and active;`)).toBe("Scale");
  });
});
