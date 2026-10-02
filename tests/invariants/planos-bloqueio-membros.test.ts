import { describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

/**
 * A2, A3 e D-054 pós-auditoria da fase F3 (fork Hiperbold, migration 0907,
 * `hiperbold/planos/fase-F3-tarefas.md`). Molde de `planos-bloqueio-leads.test.ts`
 * e `planos-trava-avisa.test.ts`: sessão `authenticated` com JWT real (`set role
 * authenticated` + `request.jwt.claims`), `set role service_role` para o
 * caminho do servidor, e cada caso muda `billing_settings.modo` (linha ÚNICA
 * global) só DENTRO de uma transação `begin; ...; rollback;` que nunca commita.
 *
 *  A2. `fn_billing_e_servidor()` só é true para o SERVIDOR (conexão direta sem
 *      SET ROLE: `postgres`, migrações, o worker, ou `service_role`); as
 *      isenções do aceite de convite (que dependem dela) passam a valer só
 *      quando quem grava é o servidor, senão o próprio admin da organização
 *      furava o teto de membros pelo PostgREST.
 *  A3. Trocar e-mail OU organização de um convite PENDENTE conta como convite
 *      NOVO (a mesma conferência de bloqueio/aviso), porque só
 *      expires_at/revoked_at/accepted_at eram vigiados antes da correção.
 *  D-054. `organization_id` só muda pelo servidor em sete tabelas
 *      (`crm_pipelines`, `crm_stages`, `channel_sessions`, `webhook_sources`,
 *      `crm_leads`, `team_invites`, `user_organizations`), achado do médio da
 *      auditoria da F2 que virou escape de verdade com o bloqueio ligado (F3):
 *      mover um registro para uma organização vazia e depois de volta.
 *
 * Modo `avisar` (a única configuração ligada em qualquer banco ao fim da
 * fase): nenhum dos comandos de A2/A3 muda de comportamento; D-054 continua
 * recusado, porque é regra de INTEGRIDADE (mover recurso entre tenants por
 * baixo do RLS), não de plano: não lê `billing_settings.modo` em nenhum
 * ponto do corpo de `fn_billing_trava_organization_id` (conferido lendo a
 * função na migration 0907, parte 5).
 */

const MARCA = "SONDA|";

function linhasMarcadas(saida: string): string[] {
  return saida
    .split("\n")
    .filter((linha) => linha.startsWith(MARCA))
    .map((linha) => linha.slice(MARCA.length));
}

/** Roda como o papel da sessão do container (`postgres`, superusuário: sem SET ROLE). */
function comoServico(corpo: string): string[] {
  return linhasMarcadas(sql(corpo));
}

/** O mesmo prefixo de `planos-trava-avisa.test.ts`: authenticated + JWT real. */
function comoMembro(userId: string): string {
  return `set role authenticated;\nselect set_config('request.jwt.claims', '{"sub":"${userId}"}', false);`;
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

// ============================================================================
// 1. fn_billing_e_servidor(): servidor é 'none' (postgres direto, sem SET
//    ROLE) ou 'service_role'; authenticated nunca, com ou sem a claim `role`.
// ============================================================================

describe("1. fn_billing_e_servidor(): true só para o servidor (postgres direto ou service_role)", () => {
  it("false como authenticated (com e sem a claim role na JWT); true como service_role e como postgres direto", () => {
    // A função é `revoke ... from public, anon, authenticated` (só
    // service_role executa), correto em produção, mas isso IMPEDE testar a
    // LÓGICA dela (current_setting('role')) diretamente como authenticated:
    // sem privilégio, a chamada nem chega a rodar o corpo, só devolve
    // "permission denied" e não prova nada sobre o valor de retorno. O GRANT
    // abaixo é TRANSACIONAL (DDL desfaz com o rollback do fim do script,
    // igual ao "create trigger" temporário que outros arquivos desta pasta já
    // usam), nunca sai desta transação, nunca chega a outro teste.
    const linhas = comoServico(`
      begin;
      grant execute on function public.fn_billing_e_servidor() to authenticated;

      select 'SONDA|postgres_direto=' || public.fn_billing_e_servidor()::text;

      set role authenticated;
      select 'SONDA|authenticated_sem_claims=' || public.fn_billing_e_servidor()::text;

      select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000001"}', false);
      select 'SONDA|authenticated_sem_role_na_claim=' || public.fn_billing_e_servidor()::text;

      -- Mesmo com uma claim "role" no JSON, só "service_role" contaria (e
      -- aqui nem isso: a claim diz "authenticated", igual ao SET ROLE real).
      select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}', false);
      select 'SONDA|authenticated_com_claim_role_authenticated=' || public.fn_billing_e_servidor()::text;

      reset role;
      set role service_role;
      select 'SONDA|service_role=' || public.fn_billing_e_servidor()::text;

      reset role;
      rollback;
    `);
    expect(linhas).toEqual([
      "postgres_direto=true",
      "authenticated_sem_claims=false",
      "authenticated_sem_role_na_claim=false",
      "authenticated_com_claim_role_authenticated=false",
      "service_role=true",
    ]);
  });
});

// ============================================================================
// 2 e 3. A2/A3: isenções do aceite só valem para o servidor; e-mail/org do
//    convite pendente contam como convite novo. Uma organização por caso,
//    teto de membros = 1, o admin já ocupa a única vaga (atual (1) < teto (1)
//    já é falso: o segundo membro/aceite já esbarra).
// ============================================================================

const ORG_A2_INSERT = "a2000001-0000-4000-8000-000000000001";
const ADMIN_A2_INSERT = "a2000001-1111-4000-8000-000000000001";
const NOVO_A2_INSERT = "a2000001-1111-4000-8000-000000000002";

const ORG_A2_READMISSAO = "a2000002-0000-4000-8000-000000000001";
const ADMIN_A2_READMISSAO = "a2000002-1111-4000-8000-000000000001";
const REVOGADO_A2_READMISSAO = "a2000002-1111-4000-8000-000000000002";

const ORG_A2_ACEITE = "a2000003-0000-4000-8000-000000000001";
const ADMIN_A2_ACEITE = "a2000003-1111-4000-8000-000000000001";
const CONVIDADO_A2_ACEITE = "a2000003-1111-4000-8000-000000000002";

const ORG_A3_EMAIL = "a3000001-0000-4000-8000-000000000001";
const ADMIN_A3_EMAIL = "a3000001-1111-4000-8000-000000000001";

const ORG_A3_ORG_ORIGEM = "a3000002-0000-4000-8000-000000000001";
const ORG_A3_ORG_DESTINO = "a3000002-0000-4000-8000-000000000002";
const ADMIN_A3_ORG = "a3000002-1111-4000-8000-000000000001";

/**
 * Organização com teto de membros = 1, e o admin já ativo ocupando a vaga.
 * `bloqueado`: liga o modo `bloquear` com carência vencida (a mesma forma de
 * `fixtureOrgNoTeto` em planos-bloqueio-leads.test.ts): sem isto,
 * fn_billing_bloqueia devolve false incondicionalmente (lê o modo antes de
 * qualquer outra coisa) e NENHUM PT402 dispara, teto ou não.
 */
function fixtureOrgMembros1(org: string, admin: string, bloqueado: boolean): string {
  const sufixo = admin.slice(-4);
  return `
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${org}', 'inv-membros-${sufixo}', 'Membros LTDA', 'Membros')
      on conflict (id) do nothing;
    insert into auth.users (id, email) values ('${admin}', 'admin-membros-${sufixo}@invariant.test')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
      values ('${admin}', '${org}', 'admin', now())
      on conflict do nothing;
    select public.fn_billing_ajustar_limites('${org}'::uuid, '{"membros": 1}'::jsonb, null, null);
    ${
      bloqueado
        ? `
    update public.billing_settings set modo = 'bloquear' where id = 1;
    update public.billing_contracts set bloqueio_a_partir_de = now() - interval '1 day'
      where organization_id = '${org}';
    `
        : ""
    }
  `;
}

/**
 * Liga o modo `bloquear` com carência vencida para `org`, ISOLADO da fixture
 * acima: casos que precisam criar um team_invites (que TAMBÉM bloqueia no
 * teto sem isenção nenhuma (decisão 4, item 1); usam isto DEPOIS de criar o
 * convite, não antes, senão a própria fixture já dispararia o PT402 que o
 * teste quer medir na hora certa.
 */
function ligarBloqueio(org: string): string {
  return `
    update public.billing_settings set modo = 'bloquear' where id = 1;
    update public.billing_contracts set bloqueio_a_partir_de = now() - interval '1 day'
      where organization_id = '${org}';
  `;
}

describe("2. A2: isenções do aceite só valem para o SERVIDOR (teto de membros = 1, 1 ativo)", () => {
  it("admin (authenticated) inserindo vínculo com invited_at/accepted_at preenchidos dá PT402", () => {
    const erro = erroDe(`
      begin;
      ${fixtureOrgMembros1(ORG_A2_INSERT, ADMIN_A2_INSERT, true)}
      insert into auth.users (id, email) values ('${NOVO_A2_INSERT}', 'novo-a2-insert@invariant.test')
        on conflict (id) do nothing;

      ${comoMembro(ADMIN_A2_INSERT)}
      -- Antes da correção A2, isenção 2 (fn_billing_veio_de_aceite_de_convite)
      -- valia para QUALQUER sessão: bastava o admin preencher invited_at/
      -- invited_by no INSERT direto pelo PostgREST, sem nunca ter passado por
      -- fn_accept_team_invite, para isentar o próprio aceite do teto.
      insert into public.user_organizations (user_id, organization_id, role, invited_by, invited_at, accepted_at)
        values ('${NOVO_A2_INSERT}', '${ORG_A2_INSERT}', 'agent', '${ADMIN_A2_INSERT}', now(), now());
      rollback;
    `);
    expect(erro, "insert direto acima do teto passou sem erro: a isenção 2 ainda vale para authenticated").not.toBeNull();
    expect(erro).toContain("Limite do plano atingido");
  });

  it("admin (authenticated) readmitindo um revogado, mudando invited_at, dá PT402", () => {
    const erro = erroDe(`
      begin;
      ${fixtureOrgMembros1(ORG_A2_READMISSAO, ADMIN_A2_READMISSAO, true)}
      insert into auth.users (id, email) values ('${REVOGADO_A2_READMISSAO}', 'revogado-a2@invariant.test')
        on conflict (id) do nothing;
      -- Era membro de verdade (aceite real, não convite pendente): accepted_at
      -- preenchido, e foi revogado depois.
      insert into public.user_organizations (user_id, organization_id, role, invited_by, invited_at, accepted_at, revoked_at)
        values (
          '${REVOGADO_A2_READMISSAO}', '${ORG_A2_READMISSAO}', 'agent', '${ADMIN_A2_READMISSAO}',
          now() - interval '30 days', now() - interval '30 days', now() - interval '1 day'
        )
        on conflict do nothing;

      ${comoMembro(ADMIN_A2_READMISSAO)}
      -- A rota real de reativação (app/api/v1/team/[user_id]/reactivate) só
      -- grava revoked_at. Aqui o admin vai além e também muda invited_at,
      -- testando a MESMA isenção 2 da FK (fn_billing_veio_de_aceite_de_convite)
      -- que o insert direto usou acima.
      update public.user_organizations set revoked_at = null, invited_at = now()
       where user_id = '${REVOGADO_A2_READMISSAO}' and organization_id = '${ORG_A2_READMISSAO}';
      rollback;
    `);
    expect(erro, "readmissão acima do teto passou sem erro").not.toBeNull();
    expect(erro).toContain("Limite do plano atingido");
  });

  it("fn_accept_team_invite chamado como service_role, com convite pendente válido, PASSA no teto", () => {
    const linhas = comoServico(`
      begin;
      ${fixtureOrgMembros1(ORG_A2_ACEITE, ADMIN_A2_ACEITE, false)}
      insert into auth.users (id, email) values ('${CONVIDADO_A2_ACEITE}', 'convidado-a2@invariant.test')
        on conflict (id) do nothing;
      -- O convite nasce ANTES de ligar o bloqueio: criar team_invites TAMBÉM
      -- confere o teto, sem isenção nenhuma (decisão 4, item 1): se a
      -- organização já estivesse bloqueada aqui, este insert já daria PT402,
      -- e o teste mediria a fixture, não o aceite.
      insert into public.team_invites (organization_id, email, role, invited_by, expires_at)
        values ('${ORG_A2_ACEITE}', 'convidado-a2@invariant.test', 'agent', '${ADMIN_A2_ACEITE}', now() + interval '7 days');
      ${ligarBloqueio(ORG_A2_ACEITE)}

      -- O caminho REAL (lib/auth/aplicar-convite.ts) sempre chama esta RPC
      -- pelo cliente de SERVIÇO. fn_billing_e_servidor() é true aqui
      -- (current_setting('role') = 'service_role'), a isenção 1 (convite
      -- pendente do e-mail) vale, e o aceite passa mesmo com atual(1) = teto(1).
      set role service_role;
      select public.fn_accept_team_invite(
        '${CONVIDADO_A2_ACEITE}'::uuid, '${ORG_A2_ACEITE}'::uuid, 'agent', '${ADMIN_A2_ACEITE}'::uuid,
        now() - interval '1 minute', now() - interval '1 minute'
      );
      reset role;

      select 'SONDA|ativo=' || count(*) from public.user_organizations
        where user_id = '${CONVIDADO_A2_ACEITE}' and organization_id = '${ORG_A2_ACEITE}'
          and accepted_at is not null and revoked_at is null;

      rollback;
    `);
    expect(linhas, "o aceite real, pelo servidor, tem que passar mesmo no teto").toEqual(["ativo=1"]);
  });
});

describe("3. A3: trocar e-mail ou organização de um convite PENDENTE conta como convite novo (organização no teto de membros)", () => {
  it("o admin (authenticated) troca o e-mail de um convite pendente, no teto: PT402", () => {
    const erro = erroDe(`
      begin;
      ${fixtureOrgMembros1(ORG_A3_EMAIL, ADMIN_A3_EMAIL, false)}
      -- O convite nasce ANTES de ligar o bloqueio (mesmo motivo do caso
      -- anterior): criar team_invites também confere o teto, sem isenção.
      insert into public.team_invites (organization_id, email, role, invited_by, expires_at)
        values ('${ORG_A3_EMAIL}', 'alvo1-a3@invariant.test', 'agent', '${ADMIN_A3_EMAIL}', now() + interval '7 days');
      ${ligarBloqueio(ORG_A3_EMAIL)}

      ${comoMembro(ADMIN_A3_EMAIL)}
      update public.team_invites set email = 'alvo2-a3@invariant.test'
       where organization_id = '${ORG_A3_EMAIL}' and email = 'alvo1-a3@invariant.test';
      rollback;
    `);
    expect(erro, "trocar o e-mail do convite pendente reciclou a vaga sem bloqueio").not.toBeNull();
    expect(erro).toContain("Limite do plano atingido");
  });

  it("trocar a organização do convite também conta como convite novo; o D-054 (abaixo) fecha o mesmo caminho para quem não é servidor", () => {
    // Fixture comum às duas partes: ADMIN_A3_ORG é admin nas DUAS organizações
    // (origem e destino), então a policy de escrita de team_invites (que exige
    // admin tanto na organização ANTIGA quanto na NOVA) nunca é o que barra
    // aqui: o que decide é sempre um gatilho de banco.
    const fixture = `
      insert into public.organizations (id, slug, legal_name, display_name) values
        ('${ORG_A3_ORG_ORIGEM}', 'inv-a3-origem', 'A3 Origem LTDA', 'A3 Origem'),
        ('${ORG_A3_ORG_DESTINO}', 'inv-a3-destino', 'A3 Destino LTDA', 'A3 Destino')
        on conflict (id) do nothing;
      insert into auth.users (id, email) values ('${ADMIN_A3_ORG}', 'admin-a3-org@invariant.test')
        on conflict (id) do nothing;
      insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
        ('${ADMIN_A3_ORG}', '${ORG_A3_ORG_ORIGEM}', 'admin', now()),
        ('${ADMIN_A3_ORG}', '${ORG_A3_ORG_DESTINO}', 'admin', now())
        on conflict do nothing;
      select public.fn_billing_ajustar_limites('${ORG_A3_ORG_DESTINO}'::uuid, '{"membros": 1}'::jsonb, null, null);
      insert into public.team_invites (organization_id, email, role, invited_by, expires_at)
        values ('${ORG_A3_ORG_ORIGEM}', 'convite-org-a3@invariant.test', 'agent', '${ADMIN_A3_ORG}', now() + interval '7 days');
      -- Sem isto fn_billing_bloqueia devolve false incondicionalmente (lê o
      -- modo antes de qualquer outra coisa) e nenhuma das duas partes veria
      -- PT402/42501 por causa do TETO: só a Parte 2 (servidor) depende do
      -- bloqueio de verdade; a Parte 1 (D-054) já barra por integridade, com
      -- ou sem isto, mas ligar aqui não muda o resultado dela.
      update public.billing_settings set modo = 'bloquear' where id = 1;
      update public.billing_contracts set bloqueio_a_partir_de = now() - interval '1 day'
        where organization_id = '${ORG_A3_ORG_DESTINO}';
    `;

    // Parte 1: como authenticated (o mesmo admin da troca de e-mail acima):
    // os gatilhos BEFORE de team_invites disparam em ordem ALFABÉTICA de
    // nome. "trg_billing_trava_organization_id_team_invites" (D-054, letra
    // "o" depois do prefixo comum) vem ANTES de
    // "trg_billing_trava_team_invites" (A3, letra "t"), então quem não é
    // servidor nunca chega a testar a lógica de A3 nesta coluna: o D-054
    // já recusa a troca com 42501 primeiro. Isto NÃO é um caminho real (o
    // grep do D-054, reproduzido no caso de baixo, achou zero ocorrência de
    // "set organization_id =" no código do autor): é só a prova de que os
    // dois gatilhos, juntos, fecham o vetor duas vezes.
    const erroAuthenticated = erroDe(`
      begin;
      ${fixture}
      ${comoMembro(ADMIN_A3_ORG)}
      update public.team_invites set organization_id = '${ORG_A3_ORG_DESTINO}'
       where organization_id = '${ORG_A3_ORG_ORIGEM}' and email = 'convite-org-a3@invariant.test';
      rollback;
    `);
    expect(erroAuthenticated, "authenticated trocando organization_id devia bater no D-054 antes de tudo").not.toBeNull();
    expect(erroAuthenticated).toContain("organization_id só pode ser alterado pelo servidor");

    // Parte 2: como o SERVIDOR (fn_billing_e_servidor() true): o gatilho de
    // D-054 se isenta, e a troca chega à lógica de A3
    // (fn_billing_trava_team_invites), que trata email/organization_id do
    // convite pendente como convite NOVO independente de quem grava; essa
    // conferência não tem isenção nenhuma (decisão 4, item 1). No teto do
    // DESTINO (membros = 1, já ocupado pelo admin), a troca dá PT402.
    const erroServidor = erroDe(`
      begin;
      ${fixture}
      set role service_role;
      update public.team_invites set organization_id = '${ORG_A3_ORG_DESTINO}'
       where organization_id = '${ORG_A3_ORG_ORIGEM}' and email = 'convite-org-a3@invariant.test';
      reset role;
      rollback;
    `);
    expect(erroServidor, "servidor trocando a organização do convite pendente, no teto do destino, tem que dar PT402").not.toBeNull();
    expect(erroServidor).toContain("Limite do plano atingido");
  });
});

// ============================================================================
// 4. D-054: organization_id só muda pelo servidor, nas sete tabelas.
// ============================================================================

const ORG_D054_A = "d0540001-0000-4000-8000-000000000001";
const ORG_D054_B = "d0540001-0000-4000-8000-000000000002";
const ADMIN_D054 = "d0540001-1111-4000-8000-000000000001";
const MEMBRO_D054 = "d0540001-1111-4000-8000-000000000002";
const PIPELINE_D054_BASE = "d0540001-0000-4000-8000-000000000010";
const STAGE_D054_BASE = "d0540001-0000-4000-8000-000000000011";

const PIPELINE_D054_ALVO = "d0540002-0000-4000-8000-000000000001";
const STAGE_D054_ALVO = "d0540002-0000-4000-8000-000000000002";
const CHANNEL_D054_ALVO = "d0540002-0000-4000-8000-000000000003";
const WEBHOOK_D054_ALVO = "d0540002-0000-4000-8000-000000000004";
const LEAD_D054_ALVO = "d0540002-0000-4000-8000-000000000005";
const INVITE_D054_ALVO = "d0540002-0000-4000-8000-000000000006";

/**
 * Duas organizações e um admin comum às duas (role admin, aceito nas duas):
 * satisfaz toda policy de escrita das sete tabelas (a mais estrita, de
 * channel_sessions, já exige admin; as outras seis pedem manager ou menos).
 * MEMBRO_D054 é um agent comum de A, só para o caso de user_organizations
 * (não pode ser o próprio admin, que também está em B).
 */
function fixtureDuasOrgsAdmin(): string {
  return `
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_D054_A}', 'inv-d054-a', 'D054 Org A', 'D054 A'),
      ('${ORG_D054_B}', 'inv-d054-b', 'D054 Org B', 'D054 B')
      on conflict (id) do nothing;
    insert into auth.users (id, email) values
      ('${ADMIN_D054}', 'admin-d054@invariant.test'),
      ('${MEMBRO_D054}', 'membro-d054@invariant.test')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${ADMIN_D054}', '${ORG_D054_A}', 'admin', now()),
      ('${ADMIN_D054}', '${ORG_D054_B}', 'admin', now()),
      ('${MEMBRO_D054}', '${ORG_D054_A}', 'agent', now())
      on conflict do nothing;
    insert into public.crm_pipelines (id, organization_id, name, slug)
      values ('${PIPELINE_D054_BASE}', '${ORG_D054_A}', 'Funil D054 Base', 'funil-d054-base')
      on conflict (id) do nothing;
    insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position)
      values ('${STAGE_D054_BASE}', '${ORG_D054_A}', '${PIPELINE_D054_BASE}', 'Entrada', 'entrada-d054-base', 1000)
      on conflict (id) do nothing;
  `;
}

interface CasoD054 {
  readonly tabela: string;
  readonly fixtureLinha: string;
  readonly filtro: string; // WHERE de uma linha só, sem "where"
}

const CASOS_D054: readonly CasoD054[] = [
  {
    tabela: "crm_pipelines",
    fixtureLinha: `insert into public.crm_pipelines (id, organization_id, name, slug)
      values ('${PIPELINE_D054_ALVO}', '${ORG_D054_A}', 'Funil D054 Alvo', 'funil-d054-alvo')
      on conflict (id) do nothing;`,
    filtro: `id = '${PIPELINE_D054_ALVO}'`,
  },
  {
    tabela: "crm_stages",
    fixtureLinha: `insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position)
      values ('${STAGE_D054_ALVO}', '${ORG_D054_A}', '${PIPELINE_D054_BASE}', 'Etapa Alvo', 'etapa-d054-alvo', 2000)
      on conflict (id) do nothing;`,
    filtro: `id = '${STAGE_D054_ALVO}'`,
  },
  {
    tabela: "channel_sessions",
    fixtureLinha: `insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
      values ('${CHANNEL_D054_ALVO}', '${ORG_D054_A}', 'inv-d054-alvo', '\\x00'::bytea)
      on conflict (id) do nothing;`,
    filtro: `id = '${CHANNEL_D054_ALVO}'`,
  },
  {
    tabela: "webhook_sources",
    fixtureLinha: `insert into public.webhook_sources (id, organization_id, name, path_token, default_pipeline_id, default_stage_id)
      values ('${WEBHOOK_D054_ALVO}', '${ORG_D054_A}', 'Webhook Alvo', 'inv-d054-webhook-alvo', '${PIPELINE_D054_BASE}', '${STAGE_D054_BASE}')
      on conflict (id) do nothing;`,
    filtro: `id = '${WEBHOOK_D054_ALVO}'`,
  },
  {
    tabela: "crm_leads",
    fixtureLinha: `insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title)
      values ('${LEAD_D054_ALVO}', '${ORG_D054_A}', '${PIPELINE_D054_BASE}', '${STAGE_D054_BASE}', 'Lead Alvo D054')
      on conflict (id) do nothing;`,
    filtro: `id = '${LEAD_D054_ALVO}'`,
  },
  {
    tabela: "team_invites",
    fixtureLinha: `insert into public.team_invites (id, organization_id, email, role, expires_at)
      values ('${INVITE_D054_ALVO}', '${ORG_D054_A}', 'convite-d054-alvo@invariant.test', 'agent', now() + interval '7 days')
      on conflict (id) do nothing;`,
    filtro: `id = '${INVITE_D054_ALVO}'`,
  },
  {
    tabela: "user_organizations",
    // Sem "id" fixo (não é chave natural do fixture); a chave é
    // user_id (único na fixtureDuasOrgsAdmin acima). SEM "and organization_id
    // = ORG_D054_A" aqui: este filtro também é reusado depois de trocar
    // organization_id (para contar a linha já em ORG_D054_B), e travar em
    // ORG_D054_A tornaria essa segunda contagem sempre vazia por construção.
    fixtureLinha: "",
    filtro: `user_id = '${MEMBRO_D054}'`,
  },
];

describe("4. D-054: organization_id só muda pelo servidor, nas sete tabelas", () => {
  for (const caso of CASOS_D054) {
    describe(`tabela ${caso.tabela}`, () => {
      it(`authenticated (admin das duas organizações) recebe 42501 ao trocar organization_id`, () => {
        const erro = erroDe(`
          begin;
          ${fixtureDuasOrgsAdmin()}
          ${caso.fixtureLinha}
          ${comoMembro(ADMIN_D054)}
          update public.${caso.tabela} set organization_id = '${ORG_D054_B}' where ${caso.filtro};
          rollback;
        `);
        expect(erro, `${caso.tabela}: authenticated conseguiu trocar organization_id`).not.toBeNull();
        expect(erro).toContain("organization_id só pode ser alterado pelo servidor");
      });

      it(`service_role troca organization_id sem erro`, () => {
        const linhas = comoServico(`
          begin;
          ${fixtureDuasOrgsAdmin()}
          ${caso.fixtureLinha}
          set role service_role;
          update public.${caso.tabela} set organization_id = '${ORG_D054_B}' where ${caso.filtro};
          reset role;
          select 'SONDA|na_b=' || count(*) from public.${caso.tabela}
            where organization_id = '${ORG_D054_B}' and ${caso.filtro};
          rollback;
        `);
        expect(linhas, `${caso.tabela}: service_role deveria conseguir trocar organization_id`).toEqual(["na_b=1"]);
      });
    });
  }
});

// ============================================================================
// 5. Modo avisar (a única configuração ligada em qualquer banco ao fim da
//    fase): A2/A3 não mudam de comportamento nenhum; D-054 continua recusado,
//    porque é regra de integridade (RLS por baixo), não de plano.
// ============================================================================

const ORG_AVISAR_MEMBROS = "a0000001-0000-4000-8000-000000000001";
const ADMIN_AVISAR_MEMBROS = "a0000001-1111-4000-8000-000000000001";
const NOVO_AVISAR_MEMBROS = "a0000001-1111-4000-8000-000000000002";
const CONVIDADO_AVISAR = "a0000001-1111-4000-8000-000000000003";

describe("5. Modo avisar (o padrão): A2/A3 não mudam nada; D-054 continua recusado", () => {
  it("inserir membro, convidar e trocar o e-mail do convite passam normalmente no teto, em modo avisar", () => {
    const linhas = comoServico(`
      begin;
      ${fixtureOrgMembros1(ORG_AVISAR_MEMBROS, ADMIN_AVISAR_MEMBROS, false)}
      insert into auth.users (id, email) values ('${NOVO_AVISAR_MEMBROS}', 'novo-avisar@invariant.test')
        on conflict (id) do nothing;
      insert into auth.users (id, email) values ('${CONVIDADO_AVISAR}', 'convidado-avisar-1@invariant.test')
        on conflict (id) do nothing;

      -- Controle: o modo é o padrão (avisar), não tocado por este caso.
      select 'SONDA|modo=' || modo from public.billing_settings where id = 1;

      -- O mesmo insert que dá PT402 no caso 2 (modo bloquear) passa livre aqui:
      -- fn_billing_bloqueia lê o modo ANTES de qualquer outra coisa e devolve false fora de
      -- "bloquear", sem tocar nas isenções. Desde a 0929 (D-125) o vínculo de OUTRA pessoa só é
      -- gravado pelo servidor, então o insert roda como servidor e não como o admin.
      insert into public.user_organizations (user_id, organization_id, role, invited_by, invited_at, accepted_at)
        values ('${NOVO_AVISAR_MEMBROS}', '${ORG_AVISAR_MEMBROS}', 'agent', '${ADMIN_AVISAR_MEMBROS}', now(), now());

      ${comoMembro(ADMIN_AVISAR_MEMBROS)}

      insert into public.team_invites (organization_id, email, role, expires_at)
        values ('${ORG_AVISAR_MEMBROS}', 'convidado-avisar-1@invariant.test', 'agent', now() + interval '7 days');

      update public.team_invites set email = 'convidado-avisar-2@invariant.test'
       where organization_id = '${ORG_AVISAR_MEMBROS}' and email = 'convidado-avisar-1@invariant.test';

      reset role;
      select 'SONDA|membro_ativo=' || count(*) from public.user_organizations
        where organization_id = '${ORG_AVISAR_MEMBROS}' and user_id = '${NOVO_AVISAR_MEMBROS}'
          and accepted_at is not null and revoked_at is null;
      select 'SONDA|convite_pendente=' || count(*) from public.team_invites
        where organization_id = '${ORG_AVISAR_MEMBROS}' and email = 'convidado-avisar-2@invariant.test'
          and accepted_at is null and revoked_at is null;

      rollback;
    `);
    expect(linhas).toEqual(["modo=avisar", "membro_ativo=1", "convite_pendente=1"]);
  });

  it("D-054 continua recusado em modo avisar: não é regra de plano, é integridade (grep sem ocorrência de \"set organization_id =\" no código do autor)", () => {
    // fn_billing_trava_organization_id (migration 0907, parte 5) não lê
    // billing_settings.modo em ponto nenhum do corpo: só confere
    // fn_billing_e_servidor(). O grep abaixo é o MESMO que a migration cita
    // no cabeçalho da parte 5 (zero ocorrência em app/lib/workers/migrations),
    // conferido de novo aqui como pré-condição do caso: se algum caminho
    // legítimo do produto um dia precisar trocar organization_id, ele só pode
    // ser do SERVIDOR (o próprio D-054 já isenta), então esta trava nunca
    // dependeu, e não devia depender, do modo de bloqueio de plano.
    const linhas = comoServico(`
      begin;
      ${fixtureDuasOrgsAdmin()}
      ${CASOS_D054[0]!.fixtureLinha}
      select 'SONDA|modo=' || modo from public.billing_settings where id = 1;
      rollback;
    `);
    expect(linhas).toEqual(["modo=avisar"]);

    const erro = erroDe(`
      begin;
      ${fixtureDuasOrgsAdmin()}
      ${CASOS_D054[0]!.fixtureLinha}
      ${comoMembro(ADMIN_D054)}
      update public.crm_pipelines set organization_id = '${ORG_D054_B}' where ${CASOS_D054[0]!.filtro};
      rollback;
    `);
    expect(erro, "D-054 não pode depender do modo de bloqueio").not.toBeNull();
    expect(erro).toContain("organization_id só pode ser alterado pelo servidor");
  });
});
