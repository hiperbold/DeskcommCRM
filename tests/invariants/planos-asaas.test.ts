/**
 * FASE F5 (migration 0909, fork Hiperbold), TAREFAS 1 E 2: SCHEMA E TRAVA DE
 * DELETE, MEDIDOS DE VERDADE.
 *
 * Três coisas que só se provam rodando contra o Postgres:
 *
 *   1. `billing_customers`, `billing_orders` e `asaas_webhook_events` são
 *      deny-all (mesmo desenho de `billing_payments`/`billing_contract_eventos`,
 *      0908, e do eixo de anúncios, 0213): `anon`/`authenticated` sem privilégio
 *      NENHUM, `agent_worker` sem privilégio NENHUM (medido por `set role`,
 *      não só por comentário), `service_role` só SELECT (a escrita é das
 *      funções da Tarefa 3, fora desta migration).
 *   2. `trg_billing_protege_assinatura_asaas` recusa apagar um contrato com
 *      assinatura Asaas viva (sem o marcador), INCLUSIVE pela cascata de
 *      apagar a organização, e deixa de recusar quando o marcador está
 *      preenchido.
 *
 * Molde: `credencial-de-anuncios-e-server-side.test.ts` (deny-all) e o caso 29
 * de `planos-carteira.test.ts` (delete em cascata). Roda via `pnpm test:db`
 * (TEST_DB_CONTAINER), contêiner descartável por rodada, sem rollback ao
 * final, ids fixos com prefixo próprio para não colidir com outra suíte.
 */
import { describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

const TABELAS = ["billing_customers", "billing_orders", "asaas_webhook_events"] as const;

function erroSob(papel: string, comando: string): string | null {
  try {
    sql(`set role ${papel};\n${comando};\nreset role;`);
    return null;
  } catch (err) {
    return motivoDoErro(err);
  }
}

function esperaBarrado(papel: string, comando: string): void {
  const erro = erroSob(papel, comando);
  expect(erro, `\`${papel}\` executou "${comando}" SEM erro, a tabela está exposta`).not.toBeNull();
  expect(erro).toContain("permission denied");
}

function privilegiosDe(papel: string, tabela: string): string {
  return sql(`
    select coalesce(string_agg(distinct privilege_type, ',' order by privilege_type), 'NENHUM')
      from information_schema.role_table_grants
     where table_schema = 'public'
       and table_name = '${tabela}'
       and grantee = '${papel}';
  `).trim();
}

describe.each(TABELAS)("0909: `%s` é deny-all (grants no catálogo)", (tabela) => {
  it("a tabela EXISTE no baseline, controle positivo da sonda", () => {
    const existe = sql(`
      select count(*) from information_schema.tables
       where table_schema = 'public' and table_name = '${tabela}';
    `).trim();
    expect(existe, `\`${tabela}\` não está no baseline`).toBe("1");
  });

  it("`anon` não tem privilégio NENHUM", () => {
    expect(privilegiosDe("anon", tabela)).toBe("NENHUM");
  });

  it("`authenticated` não tem privilégio NENHUM", () => {
    expect(privilegiosDe("authenticated", tabela)).toBe("NENHUM");
  });

  it("`agent_worker` não tem privilégio NENHUM (quando a role existir neste contêiner)", () => {
    const existeRole = sql(`select count(*) from pg_roles where rolname = 'agent_worker';`).trim();
    if (existeRole !== "1") {
      // Mesma condicional da migração (`do $$ if exists (...) $$`): a role não
      // existe neste contêiner de teste (test:db não a provisiona), nada a
      // provar aqui. No banco local de desenvolvimento (supabase_db_deskcomm-
      // crm), a role existe e o mesmo caso mede o privilégio de verdade.
      return;
    }
    expect(privilegiosDe("agent_worker", tabela)).toBe("NENHUM");
  });

  it("`service_role` tem SELECT e NADA de escrita (a escrita é só por função, Tarefa 3 em diante)", () => {
    const privilegios = privilegiosDe("service_role", tabela);
    expect(privilegios).toContain("SELECT");
    expect(privilegios).not.toContain("INSERT");
    expect(privilegios).not.toContain("UPDATE");
    expect(privilegios).not.toContain("DELETE");
    expect(privilegios).not.toContain("TRUNCATE");
  });

  it("`anon` é BARRADO por permission denied ao ler, não zero linhas", () => {
    esperaBarrado("anon", `select id from public.${tabela}`);
  });

  it("`authenticated` é BARRADO por permission denied ao ler", () => {
    esperaBarrado("authenticated", `select id from public.${tabela}`);
  });

  it("`agent_worker` é BARRADO por permission denied ao ler (bypassrls não é grant, quando a role existir)", () => {
    const existeRole = sql(`select count(*) from pg_roles where rolname = 'agent_worker';`).trim();
    if (existeRole !== "1") {
      return;
    }
    esperaBarrado("agent_worker", `select id from public.${tabela}`);
  });

  it("a RLS está LIGADA", () => {
    const ligada = sql(`select relrowsecurity from pg_class where oid = 'public.${tabela}'::regclass;`).trim();
    expect(ligada, "RLS desligada: o revoke vira a única defesa").toBe("t");
  });

  it("não há policy nenhuma", () => {
    const quantas = sql(`
      select count(*) from pg_policies where schemaname = 'public' and tablename = '${tabela}';
    `).trim();
    expect(quantas, `\`${tabela}\` ganhou policy, e o desenho é deny-all`).toBe("0");
  });
});

describe("0909: organization_id de billing_customers/billing_orders é NOT NULL com FK cascade; asaas_webhook_events NÃO tem FK (decisão do plano)", () => {
  it.each(["billing_customers", "billing_orders"] as const)("`%s`.organization_id é NOT NULL com FK on delete cascade", (tabela) => {
    const nullable = sql(`
      select is_nullable from information_schema.columns
       where table_schema = 'public' and table_name = '${tabela}' and column_name = 'organization_id';
    `).trim();
    expect(nullable).toBe("NO");

    const cascata = sql(`
      select count(*) from information_schema.table_constraints tc
       join information_schema.referential_constraints rc on rc.constraint_name = tc.constraint_name
       join information_schema.key_column_usage kcu on kcu.constraint_name = tc.constraint_name
       where tc.table_schema = 'public' and tc.table_name = '${tabela}'
         and tc.constraint_type = 'FOREIGN KEY' and kcu.column_name = 'organization_id'
         and rc.delete_rule = 'CASCADE';
    `).trim();
    expect(cascata, `a FK de organization_id em ${tabela} não é ON DELETE CASCADE`).not.toBe("0");
  });

  it("`asaas_webhook_events`.organization_id é nullable e SEM chave estrangeira", () => {
    const nullable = sql(`
      select is_nullable from information_schema.columns
       where table_schema = 'public' and table_name = 'asaas_webhook_events' and column_name = 'organization_id';
    `).trim();
    expect(nullable).toBe("YES");

    const temFk = sql(`
      select count(*) from information_schema.table_constraints tc
       join information_schema.key_column_usage kcu on kcu.constraint_name = tc.constraint_name
       where tc.table_schema = 'public' and tc.table_name = 'asaas_webhook_events'
         and tc.constraint_type = 'FOREIGN KEY' and kcu.column_name = 'organization_id';
    `).trim();
    expect(temFk, "asaas_webhook_events.organization_id ganhou uma FK, e a decisão do plano é NÃO ter (o roteamento pode não achar organização)").toBe("0");
  });
});

// ============================================================================
// trg_billing_protege_assinatura_asaas (decisão 22 do plano da fase F5).
// ============================================================================

const ORG_TRIGGER_DIRETO = "09090001-a5aa-4000-8000-000000000001";
const ORG_TRIGGER_CASCATA = "09090001-a5aa-4000-8000-000000000002";
const ORG_TRIGGER_LIBERADO = "09090001-a5aa-4000-8000-000000000003";

function criarOrgSql(id: string, slug: string): string {
  return `insert into public.organizations (id, slug, legal_name, display_name)
    values ('${id}', '${slug}', '${slug} LTDA', '${slug}')
    on conflict (id) do nothing;`;
}

describe("0909: trg_billing_protege_assinatura_asaas recusa apagar contrato com assinatura Asaas viva", () => {
  it("setup: três organizações, cada uma com o contrato automático (trigger da 0904) recebendo asaas_subscription_id", () => {
    sql(`
      ${criarOrgSql(ORG_TRIGGER_DIRETO, "f5-trigger-direto")}
      ${criarOrgSql(ORG_TRIGGER_CASCATA, "f5-trigger-cascata")}
      ${criarOrgSql(ORG_TRIGGER_LIBERADO, "f5-trigger-liberado")}
      update public.billing_contracts set asaas_subscription_id = 'sub_teste0001', asaas_assinatura_encerrada_em = null where organization_id = '${ORG_TRIGGER_DIRETO}';
      update public.billing_contracts set asaas_subscription_id = 'sub_teste0002', asaas_assinatura_encerrada_em = null where organization_id = '${ORG_TRIGGER_CASCATA}';
      update public.billing_contracts set asaas_subscription_id = 'sub_teste0003', asaas_assinatura_encerrada_em = now() where organization_id = '${ORG_TRIGGER_LIBERADO}';
    `);
    const contagem = sql(`
      select count(*) from public.billing_contracts
       where organization_id in ('${ORG_TRIGGER_DIRETO}', '${ORG_TRIGGER_CASCATA}', '${ORG_TRIGGER_LIBERADO}');
    `).trim();
    expect(contagem).toBe("3");
  });

  it("apagar o CONTRATO direto, sem marcador, falha com billing_cancele_no_asaas_antes", () => {
    const erro = erroSob("service_role", `delete from public.billing_contracts where organization_id = '${ORG_TRIGGER_DIRETO}'`);
    expect(erro, "o delete direto do contrato passou sem erro, a trava não pegou").not.toBeNull();
    expect(erro).toContain("billing_cancele_no_asaas_antes");

    const aindaExiste = sql(`select count(*) from public.billing_contracts where organization_id = '${ORG_TRIGGER_DIRETO}'`).trim();
    expect(aindaExiste, "a linha deveria continuar existindo depois do erro").toBe("1");
  });

  it("apagar a ORGANIZAÇÃO (cascata), sem marcador, TAMBÉM falha, e a organização continua existindo", () => {
    const erro = erroSob("service_role", `delete from public.organizations where id = '${ORG_TRIGGER_CASCATA}'`);
    expect(erro, "apagar a organização em cascata passou sem erro, o contrato ficaria órfão com assinatura Asaas viva").not.toBeNull();
    expect(erro).toContain("billing_cancele_no_asaas_antes");

    const orgExiste = sql(`select count(*) from public.organizations where id = '${ORG_TRIGGER_CASCATA}'`).trim();
    expect(orgExiste, "a organização deveria continuar existindo, o comando inteiro foi abortado pela trava").toBe("1");
    const contratoExiste = sql(`select count(*) from public.billing_contracts where organization_id = '${ORG_TRIGGER_CASCATA}'`).trim();
    expect(contratoExiste).toBe("1");
  });

  it("com o marcador (asaas_assinatura_encerrada_em) preenchido, apagar o contrato FUNCIONA", () => {
    const erro = erroSob("service_role", `delete from public.billing_contracts where organization_id = '${ORG_TRIGGER_LIBERADO}'`);
    expect(erro, `o delete deveria ter passado, o marcador já está preenchido: ${erro}`).toBeNull();

    const existe = sql(`select count(*) from public.billing_contracts where organization_id = '${ORG_TRIGGER_LIBERADO}'`).trim();
    expect(existe).toBe("0");
  });

  it("limpeza: apaga as organizações de teste que ainda restam (billing_contracts primeiro, sem assinatura Asaas)", () => {
    sql(`
      update public.billing_contracts set asaas_subscription_id = null, asaas_assinatura_encerrada_em = null
       where organization_id in ('${ORG_TRIGGER_DIRETO}', '${ORG_TRIGGER_CASCATA}');
      delete from public.organizations where id in ('${ORG_TRIGGER_DIRETO}', '${ORG_TRIGGER_CASCATA}', '${ORG_TRIGGER_LIBERADO}');
    `);
    const restam = sql(`
      select count(*) from public.organizations
       where id in ('${ORG_TRIGGER_DIRETO}', '${ORG_TRIGGER_CASCATA}', '${ORG_TRIGGER_LIBERADO}');
    `).trim();
    expect(restam).toBe("0");
  });
});
