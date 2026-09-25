import { describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

/**
 * SANEAMENTO DO MÓDULO DE PLANOS, migration 0910 (fase F7, lote 1, fork
 * Hiperbold, `hiperbold/planos/fase-F7-tarefas.md`). Prova de banco das
 * cinco entradas do `DEBITO.md` que esta migração toca:
 *
 *  1. D-069: billing_payments perde INSERT do service_role, billing_contracts
 *     perde INSERT/DELETE/TRUNCATE do service_role, e UPDATE de
 *     billing_contracts continua concedido de propósito (planoDaOrganizacao.ts).
 *  2. D-047: TRUNCATE revogado de anon/authenticated em toda tabela do schema
 *     public, inclusive tabela criada DEPOIS desta migração.
 *  3. D-055: fn_billing_trava_crm_leads grava um rastro consultável em
 *     billing_trigger_alarmes quando o upsert do contador falha, sem
 *     derrubar a criação do lead.
 *  4. D-070/D-060: sem mudança de SQL; prova de que as três roles que podem
 *     executar fn_billing_modo_leitura/fn_billing_limites_efetivos/
 *     fn_billing_ia_pode_responder têm rolbypassrls, para o gate travar se
 *     algum dia isso deixar de ser verdade.
 *
 * Como os outros arquivos desta pasta: fala com o Postgres por
 * `tests/invariants/psql-transporte.ts`, `postgres` (superusuário do
 * container) para fixtures e leitura, `set role <papel>` para prova de
 * privilégio. Cada caso que muda estado global ou de linha roda dentro de
 * `begin; ...; rollback;`.
 */

const MARCA = "SONDA|";

function linhasMarcadas(saida: string): string[] {
  return saida
    .split("\n")
    .filter((linha) => linha.startsWith(MARCA))
    .map((linha) => linha.slice(MARCA.length));
}

/** Roda como o papel da sessão do container (`postgres`, superusuário). */
function comoServico(corpo: string): string[] {
  return linhasMarcadas(sql(corpo));
}

/** Devolve o erro do Postgres, ou `null` quando o comando PASSOU. */
function erroDe(script: string): string | null {
  try {
    sql(script);
    return null;
  } catch (err) {
    return motivoDoErro(err);
  }
}

/** Afirma que UM PAPEL QUALQUER foi recusado por privilégio (permission denied). */
function esperaBarradoComoPapel(papel: string, comando: string, contexto: string): void {
  const erro = erroDe(`set role ${papel};\n${comando};`);
  expect(erro, `${contexto}: passou SEM erro sob "${papel}"`).not.toBeNull();
  expect(erro).toContain("permission denied");
}

function criarOrgSql(id: string, slug: string): string {
  return `insert into public.organizations (id, slug, legal_name, display_name)
    values ('${id}', '${slug}', '${slug} LTDA', '${slug}')
    on conflict (id) do nothing;`;
}

// ============================================================================
// 1. D-069: billing_payments e billing_contracts só escritos pelas funções.
// ============================================================================

describe("1. D-069: service_role não escreve direto em billing_payments nem billing_contracts", () => {
  const ORG = "09100001-0000-4000-8000-000000000001";

  it("service_role é barrado ao dar INSERT em billing_payments", () => {
    esperaBarradoComoPapel(
      "service_role",
      `insert into public.billing_payments (organization_id, contract_id, gross_cents, status, paid_at, billing_period_start, billing_period_end, chave)
        values ('${ORG}', gen_random_uuid(), 1000, 'RECEIVED_IN_CASH', now(), now(), now(), gen_random_uuid())`,
      "insert em billing_payments sob service_role",
    );
  });

  it("service_role é barrado ao dar INSERT, DELETE e TRUNCATE em billing_contracts", () => {
    esperaBarradoComoPapel(
      "service_role",
      `insert into public.billing_contracts (organization_id, plan_id) values ('${ORG}', gen_random_uuid())`,
      "insert em billing_contracts sob service_role",
    );
    esperaBarradoComoPapel(
      "service_role",
      `delete from public.billing_contracts where organization_id = '${ORG}'`,
      "delete em billing_contracts sob service_role",
    );
    esperaBarradoComoPapel("service_role", "truncate public.billing_contracts", "truncate em billing_contracts sob service_role");
  });

  it("EXCEÇÃO DELIBERADA: service_role continua podendo dar UPDATE em billing_contracts (planoDaOrganizacao.ts)", () => {
    const linhas = comoServico(`
      begin;
      ${criarOrgSql(ORG, "d069-update-exc")}
      set role service_role;
      update public.billing_contracts set bloqueio_a_partir_de = now() + interval '10 days'
        where organization_id = '${ORG}';
      reset role;
      select 'SONDA|' || (bloqueio_a_partir_de is not null)::text from public.billing_contracts where organization_id = '${ORG}';
      rollback;
    `);
    expect(linhas, "UPDATE de billing_contracts sob service_role deveria continuar passando").toEqual(["true"]);
  });
});

// ============================================================================
// 2. D-047: TRUNCATE revogado de anon/authenticated, inclusive tabela futura.
// ============================================================================

describe("2. D-047: TRUNCATE revogado de anon e authenticated em toda tabela do schema public", () => {
  it("anon e authenticated são barrados ao dar TRUNCATE numa tabela EXISTENTE (crm_pipelines)", () => {
    esperaBarradoComoPapel("anon", "truncate public.crm_pipelines", "truncate em crm_pipelines sob anon");
    esperaBarradoComoPapel(
      "authenticated",
      "truncate public.crm_pipelines",
      "truncate em crm_pipelines sob authenticated",
    );
  });

  it("uma tabela criada DEPOIS da migração 0910 já nasce sem TRUNCATE para anon/authenticated (alter default privileges)", () => {
    const linhas = comoServico(`
      begin;
      create table public.zz_saneamento_d047_futura (id int);
      insert into public.zz_saneamento_d047_futura values (1);
      select 'SONDA|anon=' || has_table_privilege('anon', 'public.zz_saneamento_d047_futura', 'TRUNCATE')::text
        || '|authenticated=' || has_table_privilege('authenticated', 'public.zz_saneamento_d047_futura', 'TRUNCATE')::text
        || '|select_anon=' || has_table_privilege('anon', 'public.zz_saneamento_d047_futura', 'SELECT')::text;
      rollback;
    `);
    // O grant padrão do Supabase continua concedendo o resto (select
    // inclusive): só o TRUNCATE some, prova de que o alter default
    // privileges mirou exatamente o privilégio certo, sem alargar o revoke.
    expect(linhas).toEqual(["anon=false|authenticated=false|select_anon=true"]);
  });
});

// ============================================================================
// 3. D-055: rastro consultável quando fn_billing_trava_crm_leads engole a
//    falha do upsert de billing_usage_counters.
// ============================================================================

describe("3. D-055: billing_trigger_alarmes guarda o rastro, e o lead nasce mesmo assim", () => {
  const ORG = "09100003-0000-4000-8000-000000000001";
  const PIPELINE = "09100003-0000-4000-8000-000000000002";
  const STAGE = "09100003-0000-4000-8000-000000000003";

  it("upsert do contador falhando (injeção controlada): o lead nasce e o alarme fica gravado", () => {
    const linhas = comoServico(`
      begin;
      ${criarOrgSql(ORG, "d055-alarme")}
      insert into public.crm_pipelines (id, organization_id, name, slug)
        values ('${PIPELINE}', '${ORG}', 'Funil D055', 'funil-d055');
      insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position)
        values ('${STAGE}', '${ORG}', '${PIPELINE}', 'Entrada', 'entrada', 1000);

      -- Injeção controlada: faz o upsert de billing_usage_counters falhar SÓ
      -- para esta organização, sem mexer em nenhum outro caminho do banco.
      -- NOT VALID não isenta o INSERT novo, só pula a validação das linhas
      -- já existentes na criação da constraint.
      alter table public.billing_usage_counters
        add constraint zz_forca_falha_d055 check (organization_id <> '${ORG}'::uuid) not valid;

      insert into public.crm_leads (organization_id, pipeline_id, stage_id, title)
        values ('${ORG}', '${PIPELINE}', '${STAGE}', 'Lead D-055');

      select 'SONDA|lead=' || count(*) from public.crm_leads
        where organization_id = '${ORG}' and title = 'Lead D-055';
      select 'SONDA|alarme=' || count(*) || '|gatilho=' || max(gatilho) || '|falha_tem_texto=' || (max(falha) is not null)::text
        from public.billing_trigger_alarmes where organization_id = '${ORG}';
      select 'SONDA|contador=' || count(*) from public.billing_usage_counters
        where organization_id = '${ORG}' and item = 'leads';

      alter table public.billing_usage_counters drop constraint zz_forca_falha_d055;
      rollback;
    `);
    expect(linhas).toEqual([
      "lead=1",
      "alarme=1|gatilho=fn_billing_trava_crm_leads|falha_tem_texto=true",
      // O contador NÃO foi somado (a falha aconteceu dentro do próprio
      // upsert): a linha nunca chegou a existir para esta organização, o que
      // é exatamente o comportamento de hoje (fn_billing_conferir_contador
      // corrige no dia seguinte).
      "contador=0",
    ]);
  });

  it("billing_trigger_alarmes: anon, authenticated e agent_worker barrados; service_role só select+insert", () => {
    esperaBarradoComoPapel("anon", "select id from public.billing_trigger_alarmes limit 1", "select em billing_trigger_alarmes sob anon");
    esperaBarradoComoPapel(
      "authenticated",
      "select id from public.billing_trigger_alarmes limit 1",
      "select em billing_trigger_alarmes sob authenticated",
    );
    esperaBarradoComoPapel(
      "authenticated",
      `insert into public.billing_trigger_alarmes (organization_id, gatilho, falha) values ('${ORG}', 'x', 'y')`,
      "insert em billing_trigger_alarmes sob authenticated",
    );
    esperaBarradoComoPapel(
      "service_role",
      `update public.billing_trigger_alarmes set falha = 'editado' where organization_id = '${ORG}'`,
      "update em billing_trigger_alarmes sob service_role",
    );
    esperaBarradoComoPapel(
      "service_role",
      `delete from public.billing_trigger_alarmes where organization_id = '${ORG}'`,
      "delete em billing_trigger_alarmes sob service_role",
    );

    const roleExiste = comoServico(
      "select 'SONDA|' || exists(select 1 from pg_roles where rolname = 'agent_worker')::text;",
    );
    if (roleExiste[0] === "true") {
      esperaBarradoComoPapel(
        "agent_worker",
        "select id from public.billing_trigger_alarmes limit 1",
        "select em billing_trigger_alarmes sob agent_worker",
      );
    }
  });
});

// ============================================================================
// 4. D-070/D-060: sem mudança de SQL; prova da justificativa (rolbypassrls).
// ============================================================================

describe("4. D-070/D-060: as únicas roles que executam as três funções têm rolbypassrls", () => {
  const FUNCOES = [
    "fn_billing_modo_leitura",
    "fn_billing_limites_efetivos",
    "fn_billing_ia_pode_responder",
  ] as const;

  it.each(FUNCOES)("%s: só postgres, service_role e agent_worker (se existir) têm EXECUTE, e todas têm rolbypassrls", (nome) => {
    const linhas = comoServico(`
      select 'SONDA|' || string_agg(distinct grantee::text || ':' || rb::text, ',' order by grantee::text || ':' || rb::text)
      from (
        select g.grantee, r.rolbypassrls as rb
        from information_schema.role_routine_grants g
        join pg_roles r on r.rolname = g.grantee
        where g.routine_name = '${nome}' and g.privilege_type = 'EXECUTE'
      ) t;
    `);
    const grants = linhas[0]!.replace("SONDA|", "").split(",");
    const rolesInesperadas = grants.filter((g) => !g.startsWith("postgres:") && !g.startsWith("service_role:") && !g.startsWith("agent_worker:"));
    expect(rolesInesperadas, `${nome} tem EXECUTE para role fora das três esperadas: ${grants.join(", ")}`).toEqual([]);
    for (const g of grants) {
      expect(g.endsWith(":true"), `${nome}: ${g} deveria ter rolbypassrls = true`).toBe(true);
    }
  });
});
