/**
 * Migração 0943: aceite dos Termos de Uso na compra (D-133). Provado no Postgres real:
 *   1. a compra com ator (o cliente) sem a versão dos Termos é recusada e nenhum pedido nasce;
 *   2. com a versão, o pedido grava termos_versao e termos_aceitos_em;
 *   3. chamada interna (sem ator, sem versão) segue como antes, com aceite nulo;
 *   4. versão em branco ou longa demais é recusada, com ou sem ator;
 *   5. repetir a mesma chave devolve o pedido original e não troca o aceite;
 *   6. só existe uma assinatura da função (a de nove argumentos foi derrubada) e só service_role executa.
 *
 * Roda via `pnpm test:db tests/invariants/aceite-dos-termos-banco.test.ts`.
 */
import { describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

const U = (n: number) => `0943a000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ORG_COM_ATOR = U(1);
const ORG_INTERNA = U(2);
const ORG_INVALIDA = U(3);
const ORG_REPETE = U(4);
const ORGS = [ORG_COM_ATOR, ORG_INTERNA, ORG_INVALIDA, ORG_REPETE];
const ATOR = "0943a000-0000-4000-8000-0000000000aa";

function erroDe(comando: string): string | null {
  try {
    sql(comando);
    return null;
  } catch (err) {
    return motivoDoErro(err);
  }
}

const pedir = (org: string, ator: string | null, termos: string | null, chave = "gen_random_uuid()") =>
  `select public.fn_billing_criar_pedido('${org}'::uuid, 'assinatura', 'pro', 'monthly', null, 'CREDIT_CARD', 'sandbox', ${chave}, ${ator ? `'${ator}'::uuid` : "null"}${termos === null ? "" : `, '${termos}'`});`;
const pedidos = (org: string) => sql(`select count(*) from public.billing_orders where organization_id = '${org}';`);

describe("0943: setup", () => {
  it("cria as organizações e liga a compra e a venda do Pro", () => {
    sql(`
      ${ORGS.map((id) => `insert into public.organizations (id, slug, legal_name, display_name) values ('${id}', 'i943-${id.slice(-2)}', 'i943 LTDA', 'i943') on conflict (id) do nothing;`).join("\n")}
      select public.fn_billing_definir_compra_pelo_cliente(true, null);
      select public.fn_billing_definir_a_venda('pro', true, null);
    `);
    expect(sql(`select count(*) from public.organizations where id = any(array[${ORGS.map((id) => `'${id}'`).join(",")}]::uuid[]);`)).toBe(String(ORGS.length));
  });
});

describe("0943: o aceite no pedido", () => {
  it("compra com ator e SEM versão é recusada e nenhum pedido nasce", () => {
    expect(erroDe(pedir(ORG_COM_ATOR, ATOR, null))).toContain("billing_termos_nao_aceitos");
    expect(pedidos(ORG_COM_ATOR)).toBe("0");
  });

  it("compra com ator e a versão grava a versão e o momento no pedido", () => {
    expect(erroDe(pedir(ORG_COM_ATOR, ATOR, "2026-09-23"))).toBeNull();
    expect(sql(`select termos_versao || '|' || (termos_aceitos_em is not null and termos_aceitos_em <= now())::text from public.billing_orders where organization_id = '${ORG_COM_ATOR}';`)).toBe("2026-09-23|true");
  });

  it("chamada interna, sem ator e sem versão, segue como antes, com aceite nulo", () => {
    expect(erroDe(pedir(ORG_INTERNA, null, null))).toBeNull();
    expect(sql(`select (termos_versao is null)::text || '|' || (termos_aceitos_em is null)::text from public.billing_orders where organization_id = '${ORG_INTERNA}';`)).toBe("true|true");
  });

  it("versão em branco ou com mais de 40 caracteres é recusada, com ou sem ator", () => {
    expect(erroDe(pedir(ORG_INVALIDA, ATOR, "   "))).toContain("billing_termos_invalidos");
    expect(erroDe(pedir(ORG_INVALIDA, null, "x".repeat(41)))).toContain("billing_termos_invalidos");
    expect(pedidos(ORG_INVALIDA)).toBe("0");
  });

  it("repetir a mesma chave devolve o pedido original e não troca o aceite", () => {
    const chave = "'0943a000-0000-4000-8000-0000000000c1'::uuid";
    expect(erroDe(pedir(ORG_REPETE, ATOR, "2026-09-23", chave))).toBeNull();
    expect(erroDe(pedir(ORG_REPETE, ATOR, "2027-01-01", chave))).toBeNull();
    expect(pedidos(ORG_REPETE)).toBe("1");
    expect(sql(`select termos_versao from public.billing_orders where organization_id = '${ORG_REPETE}';`)).toBe("2026-09-23");
  });
});

describe("0943: forma", () => {
  it("só existe a assinatura de dez parâmetros, e só service_role executa", () => {
    expect(sql(`select count(*) from pg_proc where proname = 'fn_billing_criar_pedido' and pronamespace = 'public'::regnamespace;`)).toBe("1");
    const acl = sql(`select has_function_privilege('anon', p.oid, 'execute')::text || '|' || has_function_privilege('authenticated', p.oid, 'execute')::text || '|' || has_function_privilege('service_role', p.oid, 'execute')::text from pg_proc p where proname = 'fn_billing_criar_pedido' and pronamespace = 'public'::regnamespace;`);
    expect(acl).toBe("false|false|true");
  });
});
