/**
 * Migrations 0932 a 0934 (lote 11a da auditoria de 30/09/2026: D-113 segunda metade, D-127
 * resto, D-150 parte do banco). Provado no Postgres real, como `authenticated` com o JWT do
 * usuário, sempre em par: o papel de baixo é barrado e o papel que a rota exige passa
 * (controle positivo).
 *
 * Roda via `pnpm test:db tests/invariants/lote11a-sobras-de-banco.test.ts`.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { GOV_AGENT_A, GOV_CONTACT_1, GOV_CONV_UNASSIGNED, GOV_LEAD, GOV_MANAGER, GOV_ORG, GOV_PIPELINE, GOV_SESSION, GOV_STAGE, GOV_VIEWER, seedGov } from "./gov-helpers";
import { motivoDoErro, sql } from "./psql-transporte";

const ORG_B = "11a00001-a5aa-4000-8000-000000000002";
const MULTI = "11a00001-b0b0-4000-8000-000000000001";
const SESSION_B = "11a00001-c0c0-4000-8000-000000000001";
const CONTATO_B = "11a00001-c0c0-4000-8000-000000000002";
const CONV_B = "11a00001-c0c0-4000-8000-000000000003";
const PIPE_B = "11a00001-c0c0-4000-8000-000000000004";
const ETAPA_B = "11a00001-c0c0-4000-8000-000000000005";
const LEAD_B = "11a00001-c0c0-4000-8000-000000000006";
const PIPE_A2 = "11a00001-c0c0-4000-8000-000000000007";
const ETAPA_A2 = "11a00001-c0c0-4000-8000-000000000008";
const MSG = "11a00001-d0d0-4000-8000-000000000001";
const LEAD_A2 = "11a00001-d0d0-4000-8000-000000000002";
const LEAD_A3 = "11a00001-d0d0-4000-8000-000000000003";
const ETAPA_A3 = "11a00001-d0d0-4000-8000-000000000004";

function como(usuario: string, corpo: string): string {
  return sql(`
    set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${usuario}","role":"authenticated","aal":"aal2"}', false);
    ${corpo}
  `);
}

/** Linhas afetadas por um DML como o usuário (0 se a RLS barrou; erro de privilégio sobe). */
function linhas(usuario: string, dml: string): number {
  const saida = como(usuario, `with w as (${dml} returning 1) select count(*) from w;`);
  return Number(saida.split("\n").pop());
}

function recusado(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return motivoDoErro(err);
  }
  return "";
}

const RLS = "row-level security";

beforeAll(() => {
  seedGov();
  sql(`
    insert into auth.users (id, email) values ('${MULTI}', 'multi-11a@invariant.test') on conflict (id) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG_B}', 'lote11a-b', 'Lote11a B', 'Lote11a B') on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${MULTI}', '${GOV_ORG}', 'agent', now()),
      ('${MULTI}', '${ORG_B}', 'agent', now())
      on conflict do nothing;
    insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
      values ('${SESSION_B}', '${ORG_B}', 'lote11a-b', '\\x00'::bytea) on conflict (id) do nothing;
    insert into public.contacts (id, organization_id, display_name) values ('${CONTATO_B}', '${ORG_B}', 'Contato B 11a') on conflict (id) do nothing;
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status)
      values ('${CONV_B}', '${ORG_B}', '${CONTATO_B}', '${SESSION_B}', 'open') on conflict (id) do nothing;
    insert into public.crm_pipelines (id, organization_id, name, slug) values
      ('${PIPE_B}', '${ORG_B}', 'Funil B', 'funil-b-11a'),
      ('${PIPE_A2}', '${GOV_ORG}', 'Funil A2', 'funil-a2-11a') on conflict (id) do nothing;
    insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position) values
      ('${ETAPA_B}', '${ORG_B}', '${PIPE_B}', 'Novo B', 'novo-b', 1000),
      ('${ETAPA_A2}', '${GOV_ORG}', '${PIPE_A2}', 'Novo A2', 'novo-a2', 1000),
      ('${ETAPA_A3}', '${GOV_ORG}', '${GOV_PIPELINE}', 'Segunda', 'segunda-a', 2000) on conflict (id) do nothing;
    insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title) values
      ('${LEAD_B}', '${ORG_B}', '${PIPE_B}', '${ETAPA_B}', 'Lead B 11a'),
      ('${LEAD_A2}', '${GOV_ORG}', '${GOV_PIPELINE}', '${GOV_STAGE}', 'Lead A2 11a'),
      ('${LEAD_A3}', '${GOV_ORG}', '${GOV_PIPELINE}', '${GOV_STAGE}', 'Lead A3 11a') on conflict (id) do nothing;
    insert into public.messages (id, organization_id, conversation_id, channel_session_id, contact_id, type, direction)
      values ('${MSG}', '${GOV_ORG}', '${GOV_CONV_UNASSIGNED}', '${GOV_SESSION}', '${GOV_CONTACT_1}', 'text', 'inbound') on conflict (id) do nothing;
  `);
});

const novaMsg = (org: string, conv: string, sessao: string, contato: string, direcao = "inbound") =>
  `insert into public.messages (organization_id, conversation_id, channel_session_id, contact_id, type, direction)
   values ('${org}', '${conv}', '${sessao}', '${contato}', 'text', '${direcao}');`;

describe("D-113 segunda metade: escrita das tabelas da sessão pede papel", () => {
  it("viewer não escreve em messages nem contacts; agent escreve (controle positivo)", () => {
    expect(recusado(() => como(GOV_VIEWER, novaMsg(GOV_ORG, GOV_CONV_UNASSIGNED, GOV_SESSION, GOV_CONTACT_1)))).toContain(RLS);
    expect(linhas(GOV_VIEWER, `update public.messages set body = 'x' where id = '${MSG}'`)).toBe(0);
    expect(linhas(GOV_VIEWER, `delete from public.messages where id = '${MSG}'`)).toBe(0);
    expect(linhas(GOV_VIEWER, `update public.contacts set display_name = 'golpe' where id = '${GOV_CONTACT_1}'`)).toBe(0);
    expect(recusado(() => como(GOV_AGENT_A, novaMsg(GOV_ORG, GOV_CONV_UNASSIGNED, GOV_SESSION, GOV_CONTACT_1, "outbound")))).toBe("");
    expect(linhas(GOV_AGENT_A, `update public.messages set body = 'editada' where id = '${MSG}'`)).toBe(1);
    expect(linhas(GOV_AGENT_A, `update public.contacts set display_name = 'Gov Invariant Contact 1' where id = '${GOV_CONTACT_1}'`)).toBe(1);
  });

  it("agent apaga mensagem (o eco do próprio envio e a exclusão de contato apagam com a sessão)", () => {
    sql(`insert into public.messages (id, organization_id, conversation_id, channel_session_id, contact_id, type, direction)
      values ('11a00001-d0d0-4000-8000-0000000000aa', '${GOV_ORG}', '${GOV_CONV_UNASSIGNED}', '${GOV_SESSION}', '${GOV_CONTACT_1}', 'text', 'outbound');`);
    expect(linhas(GOV_AGENT_A, `delete from public.messages where id = '11a00001-d0d0-4000-8000-0000000000aa'`)).toBe(1);
  });

  it("cron_jobs: viewer não cria; agent só cria o follow-up único (não o recorrente de turno)", () => {
    const job = (kind: string, jobKind: string, extra = "") =>
      `insert into public.cron_jobs (organization_id, contact_id, kind, job_kind, next_run_at${extra ? ", interval_ms" : ""})
       values ('${GOV_ORG}', '${GOV_CONTACT_1}', '${kind}', '${jobKind}', now()${extra ? ", 60000" : ""});`;
    expect(recusado(() => como(GOV_VIEWER, job("at", "followup_turn")))).toContain(RLS);
    expect(recusado(() => como(GOV_AGENT_A, job("every", "inbound_turn", "x")))).toContain(RLS);
    expect(recusado(() => como(GOV_AGENT_A, job("at", "inbound_turn")))).toContain(RLS);
    expect(recusado(() => como(GOV_AGENT_A, job("at", "followup_turn")))).toBe("");
  });

  it("atividade e vínculo de negócio: viewer barrado, agent passa", () => {
    const atividade = `insert into public.crm_lead_activities (organization_id, lead_id, source_module, type) values ('${GOV_ORG}', '${GOV_LEAD}', 'crm', 'note');`;
    const vinculo = `insert into public.crm_lead_links (organization_id, lead_id, target_kind, target_id, link_kind)
      values ('${GOV_ORG}', '${GOV_LEAD}', 'conversation', '${GOV_CONV_UNASSIGNED}', 'origem');`;
    for (const dml of [atividade, vinculo]) {
      expect(recusado(() => como(GOV_VIEWER, dml))).toContain(RLS);
      expect(recusado(() => como(GOV_AGENT_A, dml))).toBe("");
    }
  });

  it("onde nenhuma rota grava com a sessão, só manager: lead_notes", () => {
    const nota = `insert into public.lead_notes (organization_id, contact_id, headline, body) values ('${GOV_ORG}', '${GOV_CONTACT_1}', 'h', 'b');`;
    expect(recusado(() => como(GOV_VIEWER, nota))).toContain(RLS);
    expect(recusado(() => como(GOV_AGENT_A, nota))).toContain(RLS);
    expect(recusado(() => como(GOV_MANAGER, nota))).toBe("");
  });

  it("idempotency_keys: viewer não grava; agent grava o recibo", () => {
    const chave = (k: string) => `insert into public.idempotency_keys (organization_id, key, endpoint, request_hash, expires_at)
      values ('${GOV_ORG}', '${k}', '/api/v1/messages', '\\x01'::bytea, now() + interval '1 hour');`;
    expect(recusado(() => como(GOV_VIEWER, chave("11a-v")))).toContain(RLS);
    expect(recusado(() => como(GOV_AGENT_A, chave("11a-a")))).toBe("");
  });

  it("a leitura segue para o membro; o serviço (dono do banco) segue gravando", () => {
    expect(Number(como(GOV_VIEWER, `select count(*) from public.contacts where organization_id = '${GOV_ORG}';`).split("\n").pop())).toBeGreaterThan(0);
    expect(recusado(() => sql(`insert into public.agent_inbox_items (organization_id, kind, title) values ('${GOV_ORG}', 'next_action_ambiguous', 't');`))).toBe("");
  });
});

describe("D-127: vínculo só aponta para a própria organização", () => {
  it("mensagem com a conversa ou o contato de outra organização é recusada, mesmo pelo serviço", () => {
    const m1 = recusado(() => sql(novaMsg(GOV_ORG, CONV_B, GOV_SESSION, GOV_CONTACT_1)));
    expect(m1).toContain("Registro vinculado não encontrado");
    const m2 = recusado(() => sql(novaMsg(GOV_ORG, GOV_CONV_UNASSIGNED, GOV_SESSION, CONTATO_B)));
    expect(m2).toContain("Registro vinculado não encontrado");
    expect(recusado(() => como(GOV_AGENT_A, novaMsg(GOV_ORG, CONV_B, GOV_SESSION, GOV_CONTACT_1)))).not.toBe("");
    expect(recusado(() => sql(novaMsg(GOV_ORG, GOV_CONV_UNASSIGNED, GOV_SESSION, GOV_CONTACT_1)))).toBe("");
  });

  it("mover a mensagem para a conversa de outra organização no UPDATE também é recusado", () => {
    expect(
      recusado(() => sql(`update public.messages set conversation_id = '${CONV_B}' where id = '${MSG}';`)),
    ).toContain("Registro vinculado não encontrado");
    // reenviar o mesmo valor ou mexer em outra coluna não dispara
    expect(recusado(() => sql(`update public.messages set conversation_id = '${GOV_CONV_UNASSIGNED}', body = 'ok' where id = '${MSG}';`))).toBe("");
  });

  it("nota, atividade, vínculo, checkpoint e job de outra organização são recusados", () => {
    expect(recusado(() => sql(`insert into public.conversation_notes (organization_id, conversation_id, body) values ('${GOV_ORG}', '${CONV_B}', 'x');`))).toContain("Registro vinculado");
    expect(recusado(() => sql(`insert into public.crm_lead_activities (organization_id, lead_id, source_module, type) values ('${GOV_ORG}', '${LEAD_B}', 'crm', 'note');`))).toContain("Registro vinculado");
    expect(recusado(() => sql(`insert into public.crm_lead_links (organization_id, lead_id, target_kind, target_id, link_kind) values ('${GOV_ORG}', '${LEAD_B}', 'conversation', '${CONV_B}', 'origem');`))).toContain("Registro vinculado");
    expect(recusado(() => sql(`insert into public.lead_checkpoints (organization_id, contact_id) values ('${GOV_ORG}', '${CONTATO_B}');`))).toContain("Registro vinculado");
    expect(recusado(() => sql(`insert into public.cron_jobs (organization_id, contact_id, kind, next_run_at) values ('${GOV_ORG}', '${CONTATO_B}', 'at', now());`))).toContain("Registro vinculado");
    expect(recusado(() => sql(`insert into public.lead_notes (organization_id, contact_id, headline, body) values ('${GOV_ORG}', '${CONTATO_B}', 'h', 'b');`))).toContain("Registro vinculado");
    expect(recusado(() => sql(`insert into public.crm_lead_reactivations (organization_id, lead_id, expires_at) values ('${GOV_ORG}', '${LEAD_B}', now() + interval '1 day');`))).not.toBe("");
  });

  it("controle positivo: os mesmos registros na própria organização passam", () => {
    expect(recusado(() => sql(`insert into public.conversation_notes (organization_id, conversation_id, body) values ('${GOV_ORG}', '${GOV_CONV_UNASSIGNED}', 'x');`))).toBe("");
    expect(recusado(() => sql(`insert into public.lead_checkpoints (organization_id, contact_id) values ('${GOV_ORG}', '${GOV_CONTACT_1}');`))).toBe("");
  });
});

describe("D-150: a etapa é do mesmo funil e da mesma organização do negócio", () => {
  const mover = (usuario: string, lotes: string, etapa: string, org = GOV_ORG) =>
    como(usuario, `select * from public.fn_mover_leads_em_lote('${org}', array[${lotes}]::uuid[], '${etapa}');`);

  it("a RPC de lote recusa etapa de outro funil, sem mover nenhum card", () => {
    expect(recusado(() => mover(MULTI, `'${LEAD_A2}','${LEAD_A3}'`, ETAPA_A2))).toContain("Etapa de outro funil");
    expect(sql(`select count(*) from public.crm_leads where id in ('${LEAD_A2}','${LEAD_A3}') and stage_id = '${GOV_STAGE}';`)).toBe("2");
  });

  it("a RPC recusa etapa de outra organização, mesmo para quem é membro das duas", () => {
    expect(recusado(() => mover(MULTI, `'${LEAD_A2}'`, ETAPA_B))).toContain("Etapa não encontrada");
    expect(recusado(() => mover(MULTI, `'${LEAD_B}'`, ETAPA_A3, ORG_B))).toContain("Etapa não encontrada");
    expect(sql(`select stage_id from public.crm_leads where id = '${LEAD_B}';`)).toBe(ETAPA_B);
  });

  it("controle positivo: etapa do mesmo funil move o lote", () => {
    expect(recusado(() => mover(MULTI, `'${LEAD_A2}','${LEAD_A3}'`, ETAPA_A3))).toBe("");
    expect(sql(`select count(*) from public.crm_leads where id in ('${LEAD_A2}','${LEAD_A3}') and stage_id = '${ETAPA_A3}';`)).toBe("2");
  });

  it("o gatilho barra a escrita direta: etapa de outro funil ou de outra organização", () => {
    expect(recusado(() => sql(`update public.crm_leads set stage_id = '${ETAPA_A2}' where id = '${LEAD_A2}';`))).toContain("Etapa não pertence ao funil");
    expect(recusado(() => como(MULTI, `update public.crm_leads set stage_id = '${ETAPA_B}' where id = '${LEAD_A2}';`))).toContain("Etapa não pertence ao funil");
    expect(
      recusado(() => sql(`insert into public.crm_leads (organization_id, pipeline_id, stage_id, title) values ('${GOV_ORG}', '${GOV_PIPELINE}', '${ETAPA_A2}', 'x');`)),
    ).toContain("Etapa não pertence ao funil");
    // o clone entre funis cria o negócio já na etapa do funil de destino
    expect(
      recusado(() => sql(`insert into public.crm_leads (organization_id, pipeline_id, stage_id, title) values ('${GOV_ORG}', '${PIPE_A2}', '${ETAPA_A2}', 'clone');`)),
    ).toBe("");
    // mexer em outra coluna não dispara, e reenviar a mesma etapa também não
    expect(recusado(() => sql(`update public.crm_leads set title = 'novo título', stage_id = '${ETAPA_A3}' where id = '${LEAD_A2}';`))).toBe("");
  });
});
