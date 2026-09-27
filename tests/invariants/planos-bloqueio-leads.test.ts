import { describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

/**
 * O BLOQUEIO DE LEADS DE VERDADE, migration 0907 parte 4 (fase F3, fork
 * Hiperbold, `hiperbold/planos/fase-F3-tarefas.md`, Tarefa 7, decisão 5).
 *
 * A parte de banco (`trg_crm_leads_billing_bloqueio`,
 * `fn_billing_bloqueia_crm_leads`) já está pronta; este arquivo prova só o
 * que a Tarefa 7 pede, com uma organização de teste NO TETO (leads: 0, então
 * `atual (0) < teto (0)` já é falso, o primeiro lead já esbarra), modo
 * `bloquear` e carência (`bloqueio_a_partir_de`) VENCIDA:
 *
 *  1. `fn_nascer_lead_da_conversa` (a RPC que `garantirLeadDaConversa` usa,
 *     `lib/leads/nascimento-do-lead.ts`) chamada DEPOIS de uma mensagem já
 *     gravada na conversa: a mensagem continua gravada e o lead não nasce
 *     ("o chat nunca para", decisão 5);
 *  2. criar lead por INSERT direto em `crm_leads` dá PT402;
 *  3. no modo `avisar` (o padrão, e o único ligado em qualquer banco ao fim
 *     da fase, ver o cabeçalho de `20260923120500_0907_planos_bloqueio.sql`),
 *     a mesma organização no mesmo teto cria o lead normalmente: a fase não
 *     muda comportamento nenhum fora do modo `bloquear`.
 *
 * Como os outros arquivos desta pasta, fala com o Postgres por
 * `tests/invariants/psql-transporte.ts` (não `gov-helpers.ts`, congelado) e
 * roda como `postgres` (superusuário do container). Cada caso é UM script
 * `begin; ...; rollback;` (molde do caso 5 de `planos-trava-avisa.test.ts`):
 * `billing_settings.modo` é uma linha ÚNICA (id = 1) compartilhada por todo o
 * banco, então mudar para `bloquear` só é seguro dentro de uma transação que
 * nunca commita: nenhum outro arquivo (rodando antes, depois, ou em outra
 * sessão) enxerga o valor trocado, porque a mudança nunca sai do WAL.
 *
 * O `raise exception ... using errcode = 'PT402'` do gatilho é capturado
 * DENTRO de um bloco `do $$ ... exception when sqlstate 'PT402' ... $$`,
 * exatamente como o servidor faz (`if (error.code === 'PT402')` em
 * `nascimento-do-lead.ts` e `recusaDoPlano` nos outros caminhos): sem isso, o
 * `ON_ERROR_STOP=1` do psql abortaria o script inteiro no meio, e não daria
 * para ler o estado DEPOIS da recusa (a mensagem sobrevivendo, o lead
 * ausente) na mesma transação.
 */

const ORG_CHAT_NUNCA_PARA = "09070001-0000-4000-8000-000000000001";
const PIPELINE_CHAT = "09070001-0000-4000-8000-000000000002";
const STAGE_CHAT = "09070001-0000-4000-8000-000000000003";
const CONTACT_CHAT = "09070001-0000-4000-8000-000000000004";
const SESSION_CHAT = "09070001-0000-4000-8000-000000000005";
const CONV_CHAT = "09070001-0000-4000-8000-000000000006";
const MSG_CHAT = "09070001-0000-4000-8000-000000000007";

const ORG_INSERT_DIRETO = "09070001-0000-4000-8000-000000000011";
const PIPELINE_DIRETO = "09070001-0000-4000-8000-000000000012";
const STAGE_DIRETO = "09070001-0000-4000-8000-000000000013";

const ORG_MODO_AVISAR = "09070001-0000-4000-8000-000000000021";
const PIPELINE_AVISAR = "09070001-0000-4000-8000-000000000022";
const STAGE_AVISAR = "09070001-0000-4000-8000-000000000023";

/** Marcador das linhas de resultado, o psql também imprime SET, INSERT 0 1 etc. */
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

/**
 * O `begin` + a organização no teto: leads: 0 (`atual (0) < teto (0)` já é
 * falso, então o PRIMEIRO lead já esbarra, sem precisar semear um lead
 * anterior) e modo/carência conforme `bloqueado`.
 */
function fixtureOrgNoTeto(org: string, bloqueado: boolean): string {
  return `
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${org}', 'inv-bloqueio-leads-${org.slice(-4)}', 'Bloqueio Leads LTDA', 'Bloqueio Leads')
      on conflict (id) do nothing;

    select public.fn_billing_ajustar_limites('${org}'::uuid, '{"leads": 0}'::jsonb, null, null);

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

describe("1. `fn_nascer_lead_da_conversa` no teto (modo bloquear, carência vencida): a mensagem sobrevive, o lead não nasce", () => {
  it("mensagem gravada ANTES continua gravada, e o lead não nasce", () => {
    const linhas = comoServico(`
      begin;

      ${fixtureOrgNoTeto(ORG_CHAT_NUNCA_PARA, true)}

      insert into public.crm_pipelines (id, organization_id, name, slug)
        values ('${PIPELINE_CHAT}', '${ORG_CHAT_NUNCA_PARA}', 'Funil Chat', 'funil-chat');
      insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position)
        values ('${STAGE_CHAT}', '${ORG_CHAT_NUNCA_PARA}', '${PIPELINE_CHAT}', 'Entrada', 'entrada', 1000);
      insert into public.contacts (id, organization_id, name, phone_number)
        values ('${CONTACT_CHAT}', '${ORG_CHAT_NUNCA_PARA}', 'Contato Chat', '+5511900000071');
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted, status)
        values ('${SESSION_CHAT}', '${ORG_CHAT_NUNCA_PARA}', 'inv-bloqueio-leads-session', '\\x00'::bytea, 'WORKING');
      insert into public.conversations (id, organization_id, contact_id, channel_session_id, status)
        values ('${CONV_CHAT}', '${ORG_CHAT_NUNCA_PARA}', '${CONTACT_CHAT}', '${SESSION_CHAT}', 'open');

      -- "O chat nunca para": a mensagem entra ANTES de qualquer tentativa de
      -- criar o lead, exatamente a ordem de pos-entrada.ts e garantirLeadDaConversa.
      insert into public.messages
        (id, organization_id, conversation_id, channel_session_id, contact_id, type, direction, status, sent_via, body, sent_at)
        values ('${MSG_CHAT}', '${ORG_CHAT_NUNCA_PARA}', '${CONV_CHAT}', '${SESSION_CHAT}', '${CONTACT_CHAT}',
                'text', 'inbound', 'received', 'external_device', 'oi, quero atendimento', now());

      -- A RPC que garantirLeadDaConversa chama, capturada exatamente como o
      -- código real captura o PT402 (nascimento-do-lead.ts): não deixa o erro
      -- subir e abortar a transação inteira.
      do $$
      begin
        perform public.fn_nascer_lead_da_conversa(
          '${ORG_CHAT_NUNCA_PARA}'::uuid, '${CONTACT_CHAT}'::uuid,
          '${PIPELINE_CHAT}'::uuid, '${STAGE_CHAT}'::uuid,
          'Novo lead pelo chat', 'chat'
        );
      exception
        when sqlstate 'PT402' then
          raise notice 'PT402 capturado pelo caminho automático, o lead nao nasce e a mensagem fica';
      end $$;

      select 'SONDA|mensagem=' || count(*) from public.messages where id = '${MSG_CHAT}';
      select 'SONDA|lead=' || count(*) from public.crm_leads
        where organization_id = '${ORG_CHAT_NUNCA_PARA}' and contact_id = '${CONTACT_CHAT}';

      rollback;
    `);
    expect(linhas, "mensagem gravada antes do PT402 tem que sobreviver").toEqual(["mensagem=1", "lead=0"]);
  });
});

describe("2. Criar lead por INSERT direto em crm_leads, no teto (modo bloquear, carência vencida), dá PT402", () => {
  it("o INSERT é recusado com o código PT402 e a mensagem fixa do gatilho", () => {
    const erro = erroDe(`
      begin;

      ${fixtureOrgNoTeto(ORG_INSERT_DIRETO, true)}

      insert into public.crm_pipelines (id, organization_id, name, slug)
        values ('${PIPELINE_DIRETO}', '${ORG_INSERT_DIRETO}', 'Funil Direto', 'funil-direto');
      insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position)
        values ('${STAGE_DIRETO}', '${ORG_INSERT_DIRETO}', '${PIPELINE_DIRETO}', 'Entrada', 'entrada', 1000);

      insert into public.crm_leads (organization_id, pipeline_id, stage_id, title)
        values ('${ORG_INSERT_DIRETO}', '${PIPELINE_DIRETO}', '${STAGE_DIRETO}', 'Lead Direto Acima do Teto');

      rollback;
    `);
    expect(erro, "insert acima do teto de leads passou sem erro, o gatilho parou de bloquear").not.toBeNull();
    expect(erro).toContain("Limite do plano atingido");
  });

  it("nenhum lead ficou gravado (a transação inteira desfez, sem savepoint)", () => {
    const linhas = comoServico(
      `select 'SONDA|' || count(*) from public.crm_leads where organization_id = '${ORG_INSERT_DIRETO}';`,
    );
    expect(linhas).toEqual(["0"]);
  });
});

describe("3. Modo avisar (o padrão): a mesma organização no mesmo teto cria o lead normalmente", () => {
  it("no modo avisar, o INSERT acima do teto de leads passa sem erro", () => {
    const linhas = comoServico(`
      begin;

      ${fixtureOrgNoTeto(ORG_MODO_AVISAR, false)}

      -- Controle: o modo é o padrão (avisar) e não foi tocado por este caso.
      select 'SONDA|modo=' || modo from public.billing_settings where id = 1;

      insert into public.crm_pipelines (id, organization_id, name, slug)
        values ('${PIPELINE_AVISAR}', '${ORG_MODO_AVISAR}', 'Funil Avisar', 'funil-avisar');
      insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position)
        values ('${STAGE_AVISAR}', '${ORG_MODO_AVISAR}', '${PIPELINE_AVISAR}', 'Entrada', 'entrada', 1000);

      insert into public.crm_leads (organization_id, pipeline_id, stage_id, title)
        values ('${ORG_MODO_AVISAR}', '${PIPELINE_AVISAR}', '${STAGE_AVISAR}', 'Lead Modo Avisar');

      select 'SONDA|lead=' || count(*) from public.crm_leads
        where organization_id = '${ORG_MODO_AVISAR}' and title = 'Lead Modo Avisar';

      rollback;
    `);
    expect(linhas).toEqual(["modo=avisar", "lead=1"]);
  });
});

/**
 * A1 pós-auditoria (achado alto, migration 0907 parte 5 + correção editada NO
 * LUGAR na parte 4 desta 0907 e na 0905): a soma do contador saiu do AFTER
 * (que só dispara no FIM do comando inteiro) e entrou no BEFORE
 * (`fn_billing_bloqueia_crm_leads`), logo depois de aprovar CADA linha. Antes
 * da correção, um comando com várias linhas (insert de lote, PATCH em massa,
 * `fn_mover_leads_em_lote`) fazia TODAS as linhas lerem o MESMO contador
 * ainda não somado e passavam juntas por cima do teto, provado à mão no
 * commit da correção (teto 9, contador 8, 50 inseridos, os 50 entravam).
 *
 * Fixture única: organização com teto de leads = 9, 8 leads ABERTOS de
 * verdade (não só o contador: `count(*)` real bate), mais 5 PERDIDOS e 5
 * GANHOS para as duas reaberturas em lote. Os 8/5/5 nascem enquanto o modo
 * ainda é `avisar` (o padrão herdado do banco), sem nenhum bloqueio: só
 * DEPOIS deles o modo vira `bloquear` e a carência vence, exatamente como
 * `fixtureOrgNoTeto` acima faz para o caso 1.
 *
 * O comando arriscado de cada caso roda dentro de um `do $$ ... exception
 * when sqlstate 'PT402' ... $$`, o mesmo molde do caso 1: sem isso,
 * `ON_ERROR_STOP=1` abortaria o script (e a transação) inteiro no primeiro
 * erro, e não daria para ler o estado DEPOIS da recusa (nada novo gravado, o
 * contador sem se mexer) na mesma transação/fixture.
 */

const ORG_A1_INSERT = "0907a001-0000-4000-8000-000000000001";
const ADMIN_A1_INSERT = "0907a001-1111-4000-8000-000000000001";
const PIPELINE_A1_INSERT = "0907a001-0000-4000-8000-000000000002";
const STAGE_ABERTA_A1_INSERT = "0907a001-0000-4000-8000-000000000003";
const STAGE_PERDIDA_A1_INSERT = "0907a001-0000-4000-8000-000000000004";
const STAGE_GANHA_A1_INSERT = "0907a001-0000-4000-8000-000000000005";

const ORG_A1_UPDATE = "0907a002-0000-4000-8000-000000000001";
const ADMIN_A1_UPDATE = "0907a002-1111-4000-8000-000000000001";
const PIPELINE_A1_UPDATE = "0907a002-0000-4000-8000-000000000002";
const STAGE_ABERTA_A1_UPDATE = "0907a002-0000-4000-8000-000000000003";
const STAGE_PERDIDA_A1_UPDATE = "0907a002-0000-4000-8000-000000000004";
const STAGE_GANHA_A1_UPDATE = "0907a002-0000-4000-8000-000000000005";

const ORG_A1_MOVER = "0907a003-0000-4000-8000-000000000001";
const ADMIN_A1_MOVER = "0907a003-1111-4000-8000-000000000001";
const PIPELINE_A1_MOVER = "0907a003-0000-4000-8000-000000000002";
const STAGE_ABERTA_A1_MOVER = "0907a003-0000-4000-8000-000000000003";
const STAGE_PERDIDA_A1_MOVER = "0907a003-0000-4000-8000-000000000004";
const STAGE_GANHA_A1_MOVER = "0907a003-0000-4000-8000-000000000005";

const ORG_A1_AVISAR = "0907a004-0000-4000-8000-000000000001";
const ADMIN_A1_AVISAR = "0907a004-1111-4000-8000-000000000001";
const PIPELINE_A1_AVISAR = "0907a004-0000-4000-8000-000000000002";
const STAGE_ABERTA_A1_AVISAR = "0907a004-0000-4000-8000-000000000003";
const STAGE_PERDIDA_A1_AVISAR = "0907a004-0000-4000-8000-000000000004";
const STAGE_GANHA_A1_AVISAR = "0907a004-0000-4000-8000-000000000005";

/**
 * O prefixo que põe a sessão no lugar exato em que o PostgREST põe a de um
 * usuário logado (mesmo molde de `planos-trava-avisa.test.ts`).
 */
function comoMembroA1(userId: string): string {
  return `set role authenticated;\nselect set_config('request.jwt.claims', '{"sub":"${userId}"}', false);`;
}

/**
 * Organização com teto de leads = 9: 8 abertos, 5 perdidos e 5 ganhos de
 * verdade (não só o contador). `bloqueado`: além do teto, liga o modo
 * `bloquear` com carência vencida (`bloqueio_a_partir_de` no passado): os
 * oito/cinco/cinco leads iniciais nascem ANTES dessa troca, com o modo ainda
 * `avisar`, para não esbarrar em bloqueio nenhum na hora de semear.
 */
function fixtureOrgLote(params: {
  org: string;
  admin: string;
  pipeline: string;
  stageAberta: string;
  stagePerdida: string;
  stageGanha: string;
  bloqueado: boolean;
}): string {
  const { org, admin, pipeline, stageAberta, stagePerdida, stageGanha, bloqueado } = params;
  const sufixo = org.slice(-8);
  return `
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${org}', 'inv-a1-lote-${sufixo}', 'A1 Lote LTDA', 'A1 Lote')
      on conflict (id) do nothing;
    insert into auth.users (id, email) values ('${admin}', 'admin-a1-${sufixo}@invariant.test')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
      values ('${admin}', '${org}', 'admin', now())
      on conflict do nothing;

    select public.fn_billing_ajustar_limites('${org}'::uuid, '{"leads": 9}'::jsonb, null, null);

    insert into public.crm_pipelines (id, organization_id, name, slug)
      values ('${pipeline}', '${org}', 'Funil A1 Lote', 'funil-a1-lote-${sufixo}')
      on conflict (id) do nothing;
    insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position, is_won, is_lost) values
      ('${stageAberta}', '${org}', '${pipeline}', 'Aberta', 'aberta-${sufixo}', 1000, false, false),
      ('${stagePerdida}', '${org}', '${pipeline}', 'Perdida', 'perdida-${sufixo}', 2000, false, true),
      ('${stageGanha}', '${org}', '${pipeline}', 'Ganha', 'ganha-${sufixo}', 3000, true, false)
      on conflict (id) do nothing;

    -- 8 leads ABERTOS de verdade. Modo ainda avisar neste ponto do script
    -- (a troca para bloquear, quando "bloqueado", só acontece no FIM desta
    -- fixture): fn_billing_bloqueia devolve false incondicionalmente fora do
    -- modo bloquear, então os 8 entram livres, e o BEFORE soma o contador a
    -- cada um dos 8 (correção A1: soma incondicional de modo).
    insert into public.crm_leads (organization_id, pipeline_id, stage_id, title)
      select '${org}', '${pipeline}', '${stageAberta}', 'Aberto seed ' || g
      from generate_series(1, 8) g;

    -- 5 PERDIDOS e 5 GANHOS: matéria-prima das duas reaberturas em lote
    -- abaixo (update direto de status; fn_mover_leads_em_lote). Nascem
    -- FECHADOS (a trigger do autor decide o status pelo is_won/is_lost da
    -- etapa), então nunca somaram o contador.
    insert into public.crm_leads (organization_id, pipeline_id, stage_id, title, lost_reason)
      select '${org}', '${pipeline}', '${stagePerdida}', 'Perdido seed ' || g, 'other'
      from generate_series(1, 5) g;
    insert into public.crm_leads (organization_id, pipeline_id, stage_id, title)
      select '${org}', '${pipeline}', '${stageGanha}', 'Ganho seed ' || g
      from generate_series(1, 5) g;

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

describe("4. A1 pós-auditoria: um comando com várias linhas não passa por cima do teto (modo bloquear, carência vencida)", () => {
  it("INSERT de 50 linhas num comando só, pela sessão authenticated do admin, dá PT402 e nada entra; o contador fica como estava", () => {
    const linhas = comoServico(`
      begin;

      ${fixtureOrgLote({
        org: ORG_A1_INSERT,
        admin: ADMIN_A1_INSERT,
        pipeline: PIPELINE_A1_INSERT,
        stageAberta: STAGE_ABERTA_A1_INSERT,
        stagePerdida: STAGE_PERDIDA_A1_INSERT,
        stageGanha: STAGE_GANHA_A1_INSERT,
        bloqueado: true,
      })}

      ${comoMembroA1(ADMIN_A1_INSERT)}

      -- Antes da correção A1: as 50 linhas liam o MESMO contador (8) ainda
      -- não somado pelo AFTER (que só dispara no fim do comando inteiro) e
      -- entravam juntas, mesmo com teto 9. Depois da correção, a 2ª linha já
      -- vê o contador somado pela 1ª (BEFORE soma linha a linha), esbarra no
      -- teto, e a exceção sem savepoint desfaz o comando INTEIRO: nenhuma
      -- das 50, nem a 1ª que "caberia" sozinha.
      do $$
      begin
        insert into public.crm_leads (organization_id, pipeline_id, stage_id, title)
          select '${ORG_A1_INSERT}', '${PIPELINE_A1_INSERT}', '${STAGE_ABERTA_A1_INSERT}', 'Lote 50 ' || g
          from generate_series(1, 50) g;
      exception
        when sqlstate 'PT402' then
          raise notice 'PT402 capturado: o insert de 50 linhas foi recusado inteiro';
      end $$;

      reset role;
      select 'SONDA|leads_novos=' || count(*) from public.crm_leads
        where organization_id = '${ORG_A1_INSERT}' and title like 'Lote 50 %';
      select 'SONDA|contador=' || valor from public.billing_usage_counters
        where organization_id = '${ORG_A1_INSERT}' and item = 'leads';
      select 'SONDA|abertos_reais=' || count(*) from public.crm_leads
        where organization_id = '${ORG_A1_INSERT}' and status = 'open';

      rollback;
    `);
    expect(linhas, "leads_novos=0: nada do lote de 50 pode ter entrado").toEqual([
      "leads_novos=0",
      "contador=8",
      "abertos_reais=8",
    ]);
  });

  it("UPDATE ... set status = 'open' reabrindo vários leads perdidos num comando só dá PT402; o contador fica como estava", () => {
    const linhas = comoServico(`
      begin;

      ${fixtureOrgLote({
        org: ORG_A1_UPDATE,
        admin: ADMIN_A1_UPDATE,
        pipeline: PIPELINE_A1_UPDATE,
        stageAberta: STAGE_ABERTA_A1_UPDATE,
        stagePerdida: STAGE_PERDIDA_A1_UPDATE,
        stageGanha: STAGE_GANHA_A1_UPDATE,
        bloqueado: true,
      })}

      ${comoMembroA1(ADMIN_A1_UPDATE)}

      -- PATCH em massa: um UPDATE só, sem lista de colunas no gatilho (roda
      -- em qualquer update da linha), reabrindo os 5 perdidos de uma vez.
      do $$
      begin
        update public.crm_leads set status = 'open', closed_at = null
         where organization_id = '${ORG_A1_UPDATE}' and title like 'Perdido seed %';
      exception
        when sqlstate 'PT402' then
          raise notice 'PT402 capturado: a reabertura em lote (update direto) foi recusada inteira';
      end $$;

      reset role;
      select 'SONDA|reabertos=' || count(*) from public.crm_leads
        where organization_id = '${ORG_A1_UPDATE}' and title like 'Perdido seed %' and status = 'open';
      select 'SONDA|contador=' || valor from public.billing_usage_counters
        where organization_id = '${ORG_A1_UPDATE}' and item = 'leads';
      select 'SONDA|abertos_reais=' || count(*) from public.crm_leads
        where organization_id = '${ORG_A1_UPDATE}' and status = 'open';

      rollback;
    `);
    expect(linhas, "reabertos=0: nenhum dos 5 perdidos pode ter voltado a aberto").toEqual([
      "reabertos=0",
      "contador=8",
      "abertos_reais=8",
    ]);
  });

  it("fn_mover_leads_em_lote reabrindo 5 leads GANHOS para uma etapa aberta, num comando só, dá PT402; o contador fica como estava", () => {
    const linhas = comoServico(`
      begin;

      ${fixtureOrgLote({
        org: ORG_A1_MOVER,
        admin: ADMIN_A1_MOVER,
        pipeline: PIPELINE_A1_MOVER,
        stageAberta: STAGE_ABERTA_A1_MOVER,
        stagePerdida: STAGE_PERDIDA_A1_MOVER,
        stageGanha: STAGE_GANHA_A1_MOVER,
        bloqueado: true,
      })}

      ${comoMembroA1(ADMIN_A1_MOVER)}

      -- fn_mover_leads_em_lote (a RPC do arrasto em lote no quadro; granted a
      -- authenticated e service_role) move os 5 ganhos para a etapa aberta
      -- num UPDATE só; trg_crm_lead_close_on_stage (do autor) resolve
      -- new.status = 'open' para cada um (saiu de 'won'), e é esse UPDATE
      -- que o teto de leads tem que travar por linha, não por comando.
      do $$
      declare
        v_ids uuid[];
      begin
        select array_agg(id) into v_ids from public.crm_leads
          where organization_id = '${ORG_A1_MOVER}' and title like 'Ganho seed %';
        perform public.fn_mover_leads_em_lote(
          '${ORG_A1_MOVER}'::uuid, v_ids, '${STAGE_ABERTA_A1_MOVER}'::uuid, null
        );
      exception
        when sqlstate 'PT402' then
          raise notice 'PT402 capturado: fn_mover_leads_em_lote nao reabriu os ganhos';
      end $$;

      reset role;
      select 'SONDA|reabertos=' || count(*) from public.crm_leads
        where organization_id = '${ORG_A1_MOVER}' and title like 'Ganho seed %' and status = 'open';
      select 'SONDA|contador=' || valor from public.billing_usage_counters
        where organization_id = '${ORG_A1_MOVER}' and item = 'leads';
      select 'SONDA|abertos_reais=' || count(*) from public.crm_leads
        where organization_id = '${ORG_A1_MOVER}' and status = 'open';

      rollback;
    `);
    expect(linhas, "reabertos=0: nenhum dos 5 ganhos pode ter voltado a aberto").toEqual([
      "reabertos=0",
      "contador=8",
      "abertos_reais=8",
    ]);
  });
});

describe("5. Modo avisar (o padrão): os mesmos três comandos passam, e o contador sempre fica igual ao count(*) real de leads abertos", () => {
  it("insert de 50, update em lote e fn_mover_leads_em_lote passam sem PT402; o contador acompanha cada passo", () => {
    const linhas = comoServico(`
      begin;

      ${fixtureOrgLote({
        org: ORG_A1_AVISAR,
        admin: ADMIN_A1_AVISAR,
        pipeline: PIPELINE_A1_AVISAR,
        stageAberta: STAGE_ABERTA_A1_AVISAR,
        stagePerdida: STAGE_PERDIDA_A1_AVISAR,
        stageGanha: STAGE_GANHA_A1_AVISAR,
        bloqueado: false,
      })}

      -- Controle: o modo é o padrão (avisar) e não foi tocado por este caso.
      select 'SONDA|modo=' || modo from public.billing_settings where id = 1;

      ${comoMembroA1(ADMIN_A1_AVISAR)}

      insert into public.crm_leads (organization_id, pipeline_id, stage_id, title)
        select '${ORG_A1_AVISAR}', '${PIPELINE_A1_AVISAR}', '${STAGE_ABERTA_A1_AVISAR}', 'Lote 50 ' || g
        from generate_series(1, 50) g;

      update public.crm_leads set status = 'open', closed_at = null
       where organization_id = '${ORG_A1_AVISAR}' and title like 'Perdido seed %';

      do $$
      declare
        v_ids uuid[];
      begin
        select array_agg(id) into v_ids from public.crm_leads
          where organization_id = '${ORG_A1_AVISAR}' and title like 'Ganho seed %';
        perform public.fn_mover_leads_em_lote(
          '${ORG_A1_AVISAR}'::uuid, v_ids, '${STAGE_ABERTA_A1_AVISAR}'::uuid, null
        );
      end $$;

      reset role;
      select 'SONDA|novos=' || count(*) from public.crm_leads
        where organization_id = '${ORG_A1_AVISAR}' and title like 'Lote 50 %' and status = 'open';
      select 'SONDA|reabertos_update=' || count(*) from public.crm_leads
        where organization_id = '${ORG_A1_AVISAR}' and title like 'Perdido seed %' and status = 'open';
      select 'SONDA|reabertos_mover=' || count(*) from public.crm_leads
        where organization_id = '${ORG_A1_AVISAR}' and title like 'Ganho seed %' and status = 'open';
      select 'SONDA|contador=' || valor from public.billing_usage_counters
        where organization_id = '${ORG_A1_AVISAR}' and item = 'leads';
      select 'SONDA|abertos_reais=' || count(*) from public.crm_leads
        where organization_id = '${ORG_A1_AVISAR}' and status = 'open';

      rollback;
    `);
    // 8 (seed) + 50 (insert em lote) + 5 (reabertos por update) + 5
    // (reabertos por fn_mover_leads_em_lote) = 68, e o contador tem que
    // bater com a contagem REAL em cada uma das duas colunas.
    expect(linhas).toEqual([
      "modo=avisar",
      "novos=50",
      "reabertos_update=5",
      "reabertos_mover=5",
      "contador=68",
      "abertos_reais=68",
    ]);
  });
});
