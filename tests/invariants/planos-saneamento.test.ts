import { describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

/**
 * SANEAMENTO DO MÓDULO DE PLANOS, migration 0910 (fase F7, lote 1, fork
 * Hiperbold, `hiperbold/planos/fase-F7-tarefas.md`). Prova de banco das
 * cinco entradas do `DEBITO.md` que esta migração toca:
 *
 *  1. D-069: billing_payments perde INSERT do service_role, billing_contracts
 *     perde INSERT/UPDATE/DELETE/TRUNCATE do service_role (fase F7, lote 1b:
 *     UPDATE também revogado). planoDaOrganizacao.ts (darCarenciaExtra)
 *     passa a chamar fn_billing_estender_carencia (security definer,
 *     PARTE 3), que lê e escreve na mesma transação sob select ... for
 *     update, e grava um evento em billing_contract_eventos (tipo=carencia).
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

  it("service_role é barrado ao dar INSERT, UPDATE, DELETE e TRUNCATE em billing_contracts", () => {
    esperaBarradoComoPapel(
      "service_role",
      `insert into public.billing_contracts (organization_id, plan_id) values ('${ORG}', gen_random_uuid())`,
      "insert em billing_contracts sob service_role",
    );
    esperaBarradoComoPapel(
      "service_role",
      `update public.billing_contracts set bloqueio_a_partir_de = now() + interval '10 days' where organization_id = '${ORG}'`,
      "update em billing_contracts sob service_role",
    );
    esperaBarradoComoPapel(
      "service_role",
      `delete from public.billing_contracts where organization_id = '${ORG}'`,
      "delete em billing_contracts sob service_role",
    );
    esperaBarradoComoPapel("service_role", "truncate public.billing_contracts", "truncate em billing_contracts sob service_role");
  });
});

// ============================================================================
// 1b. fn_billing_estender_carencia (fase F7, lote 1b): fecha o D-069 por
// completo, trocando a escrita direta que planoDaOrganizacao.ts fazia.
// ============================================================================

describe("1b. fn_billing_estender_carencia: única porta para estender bloqueio_a_partir_de", () => {
  const ORG = "09100001-0000-4000-8000-000000000002";
  const ORG_SEM_BLOQUEIO = "09100001-0000-4000-8000-000000000003";
  const ORG_SEM_CONTRATO = "09100001-0000-4000-8000-000000000009";

  it("sucesso: adia bloqueio_a_partir_de, devolve o valor ANTERIOR e grava o evento tipo=carencia", () => {
    const linhas = comoServico(`
      begin;
      ${criarOrgSql(ORG, "d069-fn-sucesso")}
      update public.billing_contracts set bloqueio_a_partir_de = '2026-10-01T00:00:00Z'
        where organization_id = '${ORG}';
      set role service_role;
      select 'SONDA|' || public.fn_billing_estender_carencia(
        '${ORG}'::uuid, '2026-10-10T00:00:00Z'::timestamptz, gen_random_uuid()
      )::text;
      reset role;
      select 'SONDA|depois=' || bloqueio_a_partir_de::text from public.billing_contracts where organization_id = '${ORG}';
      select 'SONDA|evento=' || count(*) || '|de=' || max(de) || '|para=' || max(para) || '|motivo=' || max(motivo)
        from public.billing_contract_eventos where organization_id = '${ORG}' and tipo = 'carencia';
      rollback;
    `);
    expect(linhas).toEqual([
      "2026-10-01 00:00:00+00",
      "depois=2026-10-10 00:00:00+00",
      "evento=1|de=2026-10-01 00:00:00+00|para=2026-10-10 00:00:00+00|motivo=carencia_extra",
    ]);
  });

  it("recusa (P0002) organização sem linha em billing_contracts", () => {
    const erro = erroDe(`
      set role service_role;
      select public.fn_billing_estender_carencia(
        '${ORG_SEM_CONTRATO}'::uuid, now() + interval '10 days', gen_random_uuid()
      );
    `);
    expect(erro).not.toBeNull();
    expect(erro).toContain("billing_carencia_organizacao_sem_contrato");
  });

  it("recusa (P0002) organização sem bloqueio_a_partir_de programado (nada para estender)", () => {
    const erro = erroDe(`
      begin;
      ${criarOrgSql(ORG_SEM_BLOQUEIO, "d069-fn-sem-bloqueio")}
      set role service_role;
      select public.fn_billing_estender_carencia(
        '${ORG_SEM_BLOQUEIO}'::uuid, now() + interval '10 days', gen_random_uuid()
      );
      rollback;
    `);
    expect(erro).not.toBeNull();
    expect(erro).toContain("billing_carencia_sem_bloqueio_programado");
  });

  it("recusa (22023) data que não é posterior à carência atual: só ADIA, nunca antecipa", () => {
    const erro = erroDe(`
      begin;
      ${criarOrgSql(ORG, "d069-fn-nao-posterior")}
      update public.billing_contracts set bloqueio_a_partir_de = '2026-10-10T00:00:00Z'
        where organization_id = '${ORG}';
      set role service_role;
      select public.fn_billing_estender_carencia(
        '${ORG}'::uuid, '2026-10-05T00:00:00Z'::timestamptz, gen_random_uuid()
      );
      rollback;
    `);
    expect(erro).not.toBeNull();
    expect(erro).toContain("billing_carencia_data_nao_posterior");
  });

  it("anon, authenticated e agent_worker (se existir) são barrados por privilégio, não pelas regras de negócio", () => {
    esperaBarradoComoPapel(
      "anon",
      `select public.fn_billing_estender_carencia('${ORG}'::uuid, now() + interval '10 days', gen_random_uuid())`,
      "fn_billing_estender_carencia sob anon",
    );
    esperaBarradoComoPapel(
      "authenticated",
      `select public.fn_billing_estender_carencia('${ORG}'::uuid, now() + interval '10 days', gen_random_uuid())`,
      "fn_billing_estender_carencia sob authenticated",
    );

    const roleExiste = comoServico(
      "select 'SONDA|' || exists(select 1 from pg_roles where rolname = 'agent_worker')::text;",
    );
    if (roleExiste[0] === "true") {
      esperaBarradoComoPapel(
        "agent_worker",
        `select public.fn_billing_estender_carencia('${ORG}'::uuid, now() + interval '10 days', gen_random_uuid())`,
        "fn_billing_estender_carencia sob agent_worker",
      );
    }
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

  it("(lote 1b, auditoria) quando o papel supabase_admin existe, o mesmo revoke vale para o default DELE também", () => {
    // supabase_admin não existe neste harness local (test-db.sh não o cria):
    // criado e derrubado dentro do rollback, só para provar o ESTADO FINAL no
    // catálogo (pg_default_acl, via has_table_privilege numa tabela futura
    // criada COMO essa role) quando ela existir, sem exigir Supabase de
    // verdade. A migration já rodou (é o baseline inteiro que este arquivo
    // recebeu): supabase_admin não existia quando ela rodou, então o bloco da
    // PARTE 5 foi um no-op silencioso; este teste reexecuta o MESMO texto do
    // do-block da migração (colado aqui, não extraído do arquivo: é raso e
    // estável) depois de criar o papel, para provar que ele funciona quando a
    // role existe de verdade (Supabase gerenciado).
    const linhas = comoServico(`
      begin;
      create role supabase_admin nologin;
      grant create on schema public to supabase_admin;
      -- Reproduz, PARA supabase_admin, o mesmo default ACL que test-db.sh
      -- concede a 'postgres' no prelude (o dono de schema de um Supabase
      -- gerenciado de verdade é supabase_admin, não postgres): sem isto, uma
      -- tabela criada por supabase_admin não teria select/insert/update/
      -- delete nenhum para anon/authenticated, e a comparação de select não
      -- provaria que o revoke abaixo mirou só o TRUNCATE.
      alter default privileges for role supabase_admin in schema public grant all on tables to anon;
      alter default privileges for role supabase_admin in schema public grant all on tables to authenticated;
      alter default privileges for role supabase_admin in schema public grant all on tables to service_role;
      do $$
      begin
        if exists (select 1 from pg_roles where rolname = 'supabase_admin') then
          begin
            execute 'alter default privileges for role supabase_admin in schema public revoke truncate on tables from anon, authenticated';
          exception
            when insufficient_privilege then
              raise warning 'sem privilegio para alterar o default de supabase_admin';
          end;
        end if;
      end
      $$;
      set role supabase_admin;
      create table public.zz_saneamento_d047_supabase_admin_futura (id int);
      reset role;
      insert into public.zz_saneamento_d047_supabase_admin_futura values (1);
      select 'SONDA|anon=' || has_table_privilege('anon', 'public.zz_saneamento_d047_supabase_admin_futura', 'TRUNCATE')::text
        || '|authenticated=' || has_table_privilege('authenticated', 'public.zz_saneamento_d047_supabase_admin_futura', 'TRUNCATE')::text
        || '|select_anon=' || has_table_privilege('anon', 'public.zz_saneamento_d047_supabase_admin_futura', 'SELECT')::text;
      rollback;
    `);
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
