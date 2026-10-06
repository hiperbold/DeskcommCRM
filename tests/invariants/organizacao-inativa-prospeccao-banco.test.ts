/**
 * D-091: a consulta que escolhe as organizações do tick de prospecção deixa de fora a organização
 * suspensa ou arquivada. Provado no Postgres real, com a consulta de produção.
 *
 * Roda via `pnpm test:db tests/invariants/organizacao-inativa-prospeccao-banco.test.ts`.
 */
import { describe, expect, it } from "vitest";

import { SQL_ORGANIZACOES_DO_TICK } from "@/lib/prospecting/worker";

import { sql } from "./psql-transporte";

const U = (n: number) => `0091a000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ATIVA = U(1);
const SUSPENSA = U(2);
const ARQUIVADA = U(3);

describe("D-091: tick de prospecção", () => {
  it("só devolve a organização ativa, mesmo com campanha rodando nas três", () => {
    sql(`
      insert into public.organizations (id, slug, legal_name, display_name) values
        ('${ATIVA}', 'd091-a', 'd091', 'd091'), ('${SUSPENSA}', 'd091-s', 'd091', 'd091'), ('${ARQUIVADA}', 'd091-r', 'd091', 'd091')
        on conflict (id) do nothing;
      update public.organizations set status = 'suspended' where id = '${SUSPENSA}';
      update public.organizations set status = 'archived' where id = '${ARQUIVADA}';
      insert into public.prospecting_campaigns (organization_id, request_id, name, search, status, search_status)
        select o, gen_random_uuid(), 'c', '{}'::jsonb, 'running', 'succeeded' from unnest(array['${ATIVA}', '${SUSPENSA}', '${ARQUIVADA}']::uuid[]) o;
    `);
    const linhas = sql(`select string_agg(organization_id::text, ',') from (${SQL_ORGANIZACOES_DO_TICK.replace(/ limit 20$/, "")}) t where organization_id::text like '0091a000%';`);
    expect(linhas).toBe(ATIVA);
  });
});
