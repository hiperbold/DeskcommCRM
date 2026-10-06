import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * B1 (auditoria do lote 16): o baseline é reaplicado em produção por `psql -f` em autocommit, e as
 * funções criadas do zero nas migrations 0943 (`fn_billing_criar_pedido` de 10 parâmetros) e 0944
 * (`fn_pacing_reservar_vaga`, `fn_pacing_liberar_vaga`) nascem com EXECUTE para PUBLIC (o ACL padrão
 * do Supabase) até o revoke. Cada grupo drop/create/comment/revoke/grant vai dentro de UM
 * `begin; ... commit;` curto, na migration e no baseline (espelho), como a 0916 já faz. Nenhum
 * `create function` pode ficar fora da transação.
 */

const BASELINE = readFileSync(join(process.cwd(), "supabase/baseline.sql"), "utf8");

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

const CASOS = [
  {
    numero: "0943",
    arquivo: "20261007120000_0943_aceite_dos_termos_na_compra.sql",
    funcoes: ["fn_billing_criar_pedido"],
  },
  {
    numero: "0944",
    arquivo: "20261007130000_0944_reserva_de_vaga_no_ritmo_por_token.sql",
    funcoes: ["fn_pacing_reservar_vaga", "fn_pacing_liberar_vaga"],
  },
];

for (const caso of CASOS) {
  const migration = readFileSync(join(process.cwd(), "supabase/migrations", caso.arquivo), "utf8");
  const origens: Array<[string, string]> = [
    ["migration", codigo(migration)],
    ["baseline", codigo(extraiBloco(caso.numero))],
  ];

  for (const [onde, c] of origens) {
    describe(`${caso.numero} (${onde}): sem janela de EXECUTE para PUBLIC`, () => {
      it("create, comment, revoke e grant de cada função ficam dentro de UM begin ... commit", () => {
        const begin = c.indexOf("begin;\n");
        const commit = c.lastIndexOf("\ncommit;");
        expect(begin).toBeGreaterThan(-1);
        expect(commit).toBeGreaterThan(begin);
        const dentro = c.slice(begin, commit);
        for (const nome of caso.funcoes) {
          const create = dentro.indexOf(`create or replace function public.${nome}(`);
          const revoke = dentro.indexOf(`revoke execute on function public.${nome}(`);
          expect(create, `${nome}: create fora do begin/commit`).toBeGreaterThan(-1);
          expect(revoke, `${nome}: revoke fora do begin/commit`).toBeGreaterThan(create);
          expect(dentro, `${nome}: comment fora do begin/commit`).toContain(`comment on function public.${nome}(`);
          expect(dentro, `${nome}: grant fora do begin/commit`).toMatch(
            new RegExp(`grant execute on function public\\.${nome}\\(.*\\) to service_role;`),
          );
        }
      });

      it("a transação é uma só e não cobre DDL de tabela", () => {
        expect(c.match(/^begin;$/gm)?.length).toBe(1);
        expect(c.match(/^commit;$/gm)?.length).toBe(1);
        const begin = c.indexOf("begin;\n");
        const commit = c.lastIndexOf("\ncommit;");
        expect(c.slice(begin, commit)).not.toMatch(/alter table|create table|add column/);
      });
    });
  }
}

describe("0943: o drop da assinatura antiga também entra na transação", () => {
  it("o drop vem depois do begin, junto do create (sem janela em que a função não existe)", () => {
    const c = codigo(extraiBloco("0943"));
    expect(c.indexOf("begin;\n")).toBeLessThan(
      c.indexOf("drop function if exists public.fn_billing_criar_pedido(uuid, text, text, text, text, text, text, uuid, uuid);"),
    );
  });
});
