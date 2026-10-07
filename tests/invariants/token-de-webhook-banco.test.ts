/**
 * Migration 0948 (D-128): o token da URL de webhook não é legível pela sessão do usuário.
 *
 * Medido no Postgres real, falando como `authenticated` (o papel do PostgREST): `select` do token e
 * `select *` das três tabelas recusam com 42501; as demais colunas seguem legíveis; o `service_role`
 * lê o token; e uma varredura do catálogo garante que coluna nova NASCE decidida (se entrou na tabela
 * depois da 0948 e ficou sem SELECT, o teste diz qual).
 *
 * Roda via `pnpm test:db tests/invariants/token-de-webhook-banco.test.ts`.
 */
import { describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

const TABELAS = [
  { tabela: "channel_sessions", token: "webhook_path_token" },
  { tabela: "webhook_sources", token: "path_token" },
  { tabela: "tenant_integrations", token: "webhook_path_token" },
] as const;

/** Roda `consulta` como `authenticated` numa transação que sempre desfaz. */
function comoAuthenticated(consulta: string): string {
  return sql(`
    begin;
    set local role authenticated;
    ${consulta}
    rollback;
  `);
}

function recusa(consulta: string): string {
  try {
    comoAuthenticated(consulta);
  } catch (err) {
    return motivoDoErro(err);
  }
  return "";
}

describe.each(TABELAS)("0948: $tabela", ({ tabela, token }) => {
  it(`authenticated não lê ${token}`, () => {
    expect(recusa(`select ${token} from public.${tabela} limit 1;`)).toContain("permission denied");
  });

  it("nem pelo select * (a projeção que traz a coluna junto)", () => {
    expect(recusa(`select * from public.${tabela} limit 1;`)).toContain("permission denied");
  });

  it("nem filtrando por ela (o filtro também é leitura da coluna)", () => {
    expect(recusa(`select id from public.${tabela} where ${token} = 'x' limit 1;`)).toContain("permission denied");
  });

  it("CONTROLE: as demais colunas seguem legíveis pela sessão (o grant não fechou tudo)", () => {
    expect(recusa(`select id, organization_id from public.${tabela} limit 1;`)).toBe("");
  });

  it("CONTROLE: o service_role lê o token (o servidor continua podendo)", () => {
    expect(() =>
      sql(`begin; set local role service_role; select ${token} from public.${tabela} limit 1; rollback;`),
    ).not.toThrow();
  });

  it("nenhuma coluna da tabela ficou de fora do grant além do token (coluna nova precisa de decisão)", () => {
    const sobra = sql(`
      select coalesce(string_agg(a.attname, ',' order by a.attnum), '')
        from pg_attribute a
       where a.attrelid = 'public.${tabela}'::regclass and a.attnum > 0 and not a.attisdropped
         and a.attname <> '${token}'
         and not has_column_privilege('authenticated', 'public.${tabela}', a.attname, 'select');
    `);
    expect(sobra, "coluna sem SELECT para authenticated: entre no grant da 0948 ou decida que é segredo").toBe("");
  });

  it("o token está de fora do grant para authenticated e anon", () => {
    expect(sql(`select has_column_privilege('authenticated', 'public.${tabela}', '${token}', 'select');`)).toBe("f");
    expect(sql(`select has_column_privilege('anon', 'public.${tabela}', '${token}', 'select');`)).toBe("f");
  });
});

describe("0948: nada que o login alcança lê o token por dentro", () => {
  it("nenhuma função de invoker executável por authenticated cita o token nem faz `select *` das tabelas", () => {
    const achados = sql(`
      select coalesce(string_agg(p.proname, ','), '')
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and not p.prosecdef
         and has_function_privilege('authenticated', p.oid, 'execute')
         and (p.prosrc ~* '(webhook_path_token|path_token)'
              or p.prosrc ~* '(channel_sessions|webhook_sources|tenant_integrations)[a-z_ ]*[.][*]');
    `);
    expect(achados).toBe("");
  });
});
