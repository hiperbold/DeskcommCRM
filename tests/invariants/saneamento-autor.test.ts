import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

/**
 * SANEAMENTO DO CÓDIGO DO AUTOR, migration 0910 PARTE 2 (fase F7, lote 4b,
 * fork Hiperbold, `hiperbold/planos/fase-F7-tarefas.md`). Prova de banco das
 * três entradas do `DEBITO.md` que a PARTE 2 desta migração toca com SQL:
 *
 *  1. D-048: `orgs_write_platform_admin` passa a exigir `scope = 'full'`
 *     (`fn_is_platform_admin_full`); um admin `support_readonly` é recusado
 *     pela RLS, um admin `full` continua escrevendo.
 *  2. D-061: `fn_reserve_channel_connection`, no ramo de onboarding, zera
 *     `archived_at` de uma sessão `waha` arquivada ANTES de reaproveitá-la, e
 *     essa reativação passa a contar no teto de conexões do plano, igual a
 *     uma conexão nova.
 *  3. D-063: o segundo recálculo de `billing_usage_counters` (merge por
 *     `greatest`) nunca decresce um valor já elevado por um incremento
 *     concorrente, e continua subindo até o valor real quando ele é maior.
 *
 * D-062 não tem prova aqui: a migração não muda nenhum SQL para ele (ver o
 * comentário da própria migração, seção D-062).
 *
 * Como os outros arquivos desta pasta: fala com o Postgres por
 * `tests/invariants/psql-transporte.ts`, `postgres` (superusuário do
 * container) para fixtures e leitura, `set role`/`set local role` para prova
 * de privilégio. Cada caso que muda estado global ou de linha roda dentro de
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

function criarOrgSql(id: string, slug: string): string {
  return `insert into public.organizations (id, slug, legal_name, display_name)
    values ('${id}', '${slug}', '${slug} LTDA', '${slug}')
    on conflict (id) do nothing;`;
}

// ============================================================================
// 1. D-048: orgs_write_platform_admin exige escopo full.
// ============================================================================

describe("1. D-048: escrever em organizations pela política exige admin de escopo full", () => {
  const FULL_ADMIN = "d0480001-0000-4000-8000-000000000001";
  const SUPPORT_ADMIN = "d0480001-0000-4000-8000-000000000002";
  const ORG_RECUSADA = "d0480001-0000-4000-8000-000000000003";
  const ORG_ACEITA = "d0480001-0000-4000-8000-000000000004";

  const seedAdmins = `
    insert into auth.users(id,email) values
      ('${FULL_ADMIN}','full-d048@invariant.test'),
      ('${SUPPORT_ADMIN}','support-d048@invariant.test')
    on conflict (id) do nothing;
    insert into public.platform_admins(user_id,granted_by,scope,mfa_required,reason) values
      ('${FULL_ADMIN}','${FULL_ADMIN}','full',false,'Local invariant fixture'),
      ('${SUPPORT_ADMIN}','${FULL_ADMIN}','support_readonly',false,'Local invariant fixture')
    on conflict (user_id) do nothing;
  `;

  // UPDATE, não INSERT: um INSERT em organizations dispara o gatilho (de
  // OUTRO assunto, fn_semear_tipos_de_agendamento_na_org_nova) que hoje
  // recusa QUALQUER papel sem privilégio de agendamento, inclusive um admin
  // de escopo full: é o próprio "só falha por acaso" que o D-048 descreve.
  // UPDATE numa organização JÁ existente (criada aqui como o serviço, fora
  // da RLS) exercita só a política orgs_write_platform_admin, sem passar
  // por esse outro gatilho.
  function seedOrg(org: string): string {
    return `insert into public.organizations (id, slug, legal_name, display_name)
      values ('${org}', '${org.slice(-4)}', 'D048 LTDA', 'D048')
      on conflict (id) do nothing;`;
  }

  it("admin de escopo support_readonly é recusado pela RLS ao atualizar organizations", () => {
    // A cláusula USING de orgs_write_platform_admin filtra a linha (não é
    // "visível" para escrita por quem não é full): o UPDATE roda sem erro,
    // mas afeta ZERO linhas, e o display_name original sobrevive. Diferente
    // de um WITH CHECK falhando sobre uma linha JÁ visível (que dá "new row
    // violates row-level security policy", como no D-061 pelo caminho de
    // gatilho): aqui a política nem deixa a linha entrar no UPDATE.
    const linhas = comoServico(`
      begin;
      ${seedAdmins}
      ${seedOrg(ORG_RECUSADA)}
      set local role authenticated;
      select set_config('request.jwt.claims','{"sub":"${SUPPORT_ADMIN}"}',true);
      update public.organizations set display_name = 'Tentativa Support' where id = '${ORG_RECUSADA}';
      reset role;
      select 'SONDA|' || display_name from public.organizations where id = '${ORG_RECUSADA}';
      rollback;
    `);
    expect(linhas, "update de admin support_readonly mudou display_name: a política deixou a linha passar").toEqual([
      "D048",
    ]);
  });

  it("admin de escopo full continua escrevendo em organizations pela mesma política", () => {
    const linhas = comoServico(`
      begin;
      ${seedAdmins}
      ${seedOrg(ORG_ACEITA)}
      set local role authenticated;
      select set_config('request.jwt.claims','{"sub":"${FULL_ADMIN}"}',true);
      update public.organizations set display_name = 'Atualizado Full' where id = '${ORG_ACEITA}';
      reset role;
      select 'SONDA|' || display_name from public.organizations where id = '${ORG_ACEITA}';
      rollback;
    `);
    expect(linhas).toEqual(["Atualizado Full"]);
  });
});

// ============================================================================
// 2. D-061: fn_reserve_channel_connection limpa archived_at e conta no teto.
// ============================================================================

describe("2. D-061: reaproveitar sessão waha arquivada limpa archived_at e conta no teto", () => {
  const ATOR = "d0610001-0000-4000-8000-000000000001";
  const ORG_LIMPA = "d0610001-0000-4000-8000-000000000002";
  const SESSAO_LIMPA = "d0610001-0000-4000-8000-000000000003";
  const ORG_TETO = "d0610001-0000-4000-8000-000000000004";
  const SESSAO_TETO = "d0610001-0000-4000-8000-000000000005";

  const seedAtor = `insert into auth.users(id,email) values ('${ATOR}','ator-d061@invariant.test') on conflict (id) do nothing;`;
  const comoAtor = `
    set local role authenticated;
    select set_config('request.jwt.claims','{"sub":"${ATOR}","aal":"aal1"}',true);
  `;

  function seedOrgComAdmin(org: string): string {
    return `
      ${criarOrgSql(org, org.slice(-4))}
      insert into public.user_organizations (organization_id, user_id, role, accepted_at)
        values ('${org}', '${ATOR}', 'admin', now())
        on conflict (organization_id, user_id) do nothing;
    `;
  }

  function seedSessaoArquivada(org: string, sessao: string): string {
    return `
      insert into public.channel_sessions
        (id, organization_id, provider, waha_session_name, webhook_secret_encrypted, status, metadata, archived_at)
        values ('${sessao}', '${org}', 'waha', 'd061-sessao-${sessao.slice(-4)}', '\\x00'::bytea, 'STOPPED',
          '{"onboarding":true}'::jsonb, now() - interval '1 day');
    `;
  }

  it("sem teto: a sessão arquivada é reaproveitada com archived_at limpo (D-061, parte 1)", () => {
    const linhas = comoServico(`
      begin;
      ${seedAtor}
      ${seedOrgComAdmin(ORG_LIMPA)}
      ${seedSessaoArquivada(ORG_LIMPA, SESSAO_LIMPA)}
      ${comoAtor}
      select 'SONDA|' || ((public.fn_reserve_channel_connection(
        '${ORG_LIMPA}'::uuid, gen_random_uuid(), repeat('a', 64), null, true
      )->'channel'->>'id') = '${SESSAO_LIMPA}')::text;
      reset role;
      select 'SONDA|' || (archived_at is null)::text from public.channel_sessions where id = '${SESSAO_LIMPA}';
      rollback;
    `);
    expect(linhas).toEqual(["true", "true"]);
  });

  it("no teto (modo bloquear, carência vencida): reaproveitar a sessão arquivada é recusado com PT402, e a linha permanece arquivada (D-061, parte 2)", () => {
    const linhas = comoServico(`
      begin;
      ${seedAtor}
      ${seedOrgComAdmin(ORG_TETO)}
      select public.fn_billing_ajustar_limites('${ORG_TETO}'::uuid, '{"conexoes": 0}'::jsonb, null, null);
      update public.billing_settings set modo = 'bloquear' where id = 1;
      update public.billing_contracts set bloqueio_a_partir_de = now() - interval '1 day'
        where organization_id = '${ORG_TETO}';
      ${seedSessaoArquivada(ORG_TETO, SESSAO_TETO)}
      ${comoAtor}
      do $$
      begin
        perform public.fn_reserve_channel_connection('${ORG_TETO}'::uuid, gen_random_uuid(), repeat('a', 64), null, true);
        raise exception 'reserva no teto passou sem erro';
      exception
        when sqlstate 'PT402' then
          raise notice 'PT402 capturado: o teto agora conta o reaproveitamento';
      end $$;
      reset role;
      select 'SONDA|' || (archived_at is not null)::text from public.channel_sessions where id = '${SESSAO_TETO}';
      select 'SONDA|' || count(*) from public.channel_connection_requests where organization_id = '${ORG_TETO}';
      rollback;
    `);
    expect(linhas, "a sessão devia continuar arquivada e nenhum pedido de conexão devia sobreviver ao PT402").toEqual([
      "true",
      "0",
    ]);
  });
});

// ============================================================================
// 3. D-063: segundo recálculo de billing_usage_counters (merge por greatest).
// ============================================================================

describe("3. D-063: o recálculo por greatest nunca decresce e ainda sobe até o valor real", () => {
  const ORG_NAO_DECRESCE = "d0630001-0000-4000-8000-000000000001";
  const PIPELINE_A = "d0630001-0000-4000-8000-000000000002";
  const STAGE_A = "d0630001-0000-4000-8000-000000000003";

  const ORG_SOBE = "d0630001-0000-4000-8000-000000000011";
  const PIPELINE_B = "d0630001-0000-4000-8000-000000000012";
  const STAGE_B = "d0630001-0000-4000-8000-000000000013";

  /**
   * O trecho REAL da migração 0910, PARTE 2, D-063: lido do arquivo em vez de
   * copiado à mão, para o teste nunca divergir da SQL que roda de verdade.
   * É o ÚLTIMO comando do arquivo (nada depois dele), então basta cortar a
   * partir da última ocorrência da âncora até o fim do texto.
   */
  function recalculoD063(): string {
    const caminho = join(process.cwd(), "supabase/migrations/20260925010000_0910_planos_saneamento.sql");
    const texto = readFileSync(caminho, "utf8");
    const ancora = "insert into public.billing_usage_counters (organization_id, item, valor)\nselect cl.organization_id, 'leads', count(*)";
    const posicao = texto.lastIndexOf(ancora);
    if (posicao === -1) throw new Error("âncora do recálculo D-063 não achada na migração 0910");
    return texto.slice(posicao).trim();
  }

  function pipelineEEtapaSql(org: string, pipeline: string, stage: string): string {
    return `
      insert into public.crm_pipelines (id, organization_id, name, slug)
        values ('${pipeline}', '${org}', 'Funil D063', 'funil-d063-${stage.slice(-4)}');
      insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position)
        values ('${stage}', '${org}', '${pipeline}', 'Entrada', 'entrada-${stage.slice(-4)}', 1000);
    `;
  }

  function leadAbertoSql(org: string, pipeline: string, stage: string, titulo: string): string {
    return `insert into public.crm_leads (organization_id, pipeline_id, stage_id, title)
      values ('${org}', '${pipeline}', '${stage}', '${titulo}');`;
  }

  it("valor já elevado por um incremento concorrente (maior que a foto atual) NÃO é decrescido", () => {
    const linhas = comoServico(`
      begin;
      ${criarOrgSql(ORG_NAO_DECRESCE, "d063-nao-decresce")}
      ${pipelineEEtapaSql(ORG_NAO_DECRESCE, PIPELINE_A, STAGE_A)}

      -- Só 1 lead aberto de verdade: o gatilho AFTER já deixa o contador em 1.
      ${leadAbertoSql(ORG_NAO_DECRESCE, PIPELINE_A, STAGE_A, "Lead D063 unico")}

      -- Simula um incremento concorrente que já elevou o contador para 5,
      -- ANTES da foto desta passada (o cenário que D-063 descreve): escrita
      -- direta, sem gatilho nenhum na própria billing_usage_counters.
      update public.billing_usage_counters set valor = 5
        where organization_id = '${ORG_NAO_DECRESCE}' and item = 'leads';

      ${recalculoD063()}

      select 'SONDA|' || valor from public.billing_usage_counters
        where organization_id = '${ORG_NAO_DECRESCE}' and item = 'leads';
      rollback;
    `);
    expect(linhas, "o recálculo sobrescreveu um valor que um incremento concorrente já tinha elevado").toEqual(["5"]);
  });

  it("valor abaixo do real (undercount) SOBE até o valor real", () => {
    const linhas = comoServico(`
      begin;
      ${criarOrgSql(ORG_SOBE, "d063-sobe")}
      ${pipelineEEtapaSql(ORG_SOBE, PIPELINE_B, STAGE_B)}

      -- 3 leads abertos de verdade: o gatilho AFTER já deixa o contador em 3.
      ${leadAbertoSql(ORG_SOBE, PIPELINE_B, STAGE_B, "Lead D063 um")}
      ${leadAbertoSql(ORG_SOBE, PIPELINE_B, STAGE_B, "Lead D063 dois")}
      ${leadAbertoSql(ORG_SOBE, PIPELINE_B, STAGE_B, "Lead D063 tres")}

      -- Simula um undercount anterior (um upsert perdido, por exemplo):
      -- escrita direta para 1, abaixo do real (3).
      update public.billing_usage_counters set valor = 1
        where organization_id = '${ORG_SOBE}' and item = 'leads';

      ${recalculoD063()}

      select 'SONDA|' || valor from public.billing_usage_counters
        where organization_id = '${ORG_SOBE}' and item = 'leads';
      rollback;
    `);
    expect(linhas, "o recálculo devia subir o contador até o valor real de leads abertos").toEqual(["3"]);
  });
});
