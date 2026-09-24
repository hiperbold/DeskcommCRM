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
 *     da fase, ver o cabeçalho de `20260923120000_0907_planos_bloqueio.sql`),
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
