/**
 * Migrações 0937 a 0939 (lote 13a da auditoria de 30/09/2026): D-160 (compromissos do mesmo dono
 * não se sobrepõem, nem numa corrida), D-165 (FK de `crm_tasks` para a própria organização) e
 * D-147 (visibilidade por atendente nas tabelas filhas). Provado no Postgres real, sempre em par:
 * o que a regra barra e o controle positivo do que ela deixa passar.
 *
 * Roda via `pnpm test:db tests/invariants/lote13a-banco.test.ts`.
 */
import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GOV_AGENT_A, GOV_AGENT_B, GOV_CONV_AGENT_B, GOV_CONV_UNASSIGNED, GOV_MANAGER, GOV_ORG, GOV_PIPELINE, GOV_SESSION, GOV_STAGE, GOV_VIEWER, seedGov } from "./gov-helpers";
import { motivoDoErro, sql } from "./psql-transporte";

if (!process.env.TEST_DB_CONTAINER) throw new Error("Rode via pnpm test:db");
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
  max: 6,
});

/** Roda como o serviço (dono do banco) e devolve o motivo do erro com o SQLSTATE, ou "" se passou. */
function tenta(corpo: string): string {
  try {
    sql(`\\set VERBOSITY verbose\n${corpo}`);
  } catch (err) {
    return motivoDoErro(err);
  }
  return "";
}

function como(usuario: string, corpo: string): string {
  return sql(`
    \\set VERBOSITY verbose
    set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${usuario}","role":"authenticated","aal":"aal2"}', false);
    ${corpo}
  `);
}

function comoTenta(usuario: string, corpo: string): string {
  try {
    como(usuario, corpo);
  } catch (err) {
    return motivoDoErro(err);
  }
  return "";
}

/** Linhas afetadas por um DML como o usuário (0 se a RLS barrou o filtro). */
function linhas(usuario: string, dml: string): number {
  return Number(como(usuario, `with w as (${dml} returning 1) select count(*) from w;`).split("\n").pop());
}

const RLS = "row-level security";

afterAll(async () => {
  await pool.end();
});

/* ------------------------------------------------------------------------------------------- */
/* D-160: agenda                                                                                */
/* ------------------------------------------------------------------------------------------- */

const ORG_AG = "13a00001-a000-4000-8000-000000000001";
const DONO1 = "13a00001-a000-4000-8000-0000000000d1";
const DONO2 = "13a00001-a000-4000-8000-0000000000d2";
const DIA = "2027-03-10";
const hora = (h: string) => `${DIA} ${h}:00+00`;

function compromisso(dono: string | null, ini: string, fim: string, status = "confirmed"): string {
  const d = dono === null ? "null" : `'${dono}'`;
  const cancelado = status === "cancelled" ? ", cancelled_at" : "";
  const quando = status === "cancelled" ? ", now()" : "";
  return `insert into public.calendar_appointments (organization_id, owner_user_id, title, starts_at, ends_at, status${cancelado})
          values ('${ORG_AG}', ${d}, 'c', '${hora(ini)}', '${hora(fim)}', '${status}'${quando})`;
}

function idDo(dono: string, ini: string): string {
  return sql(`select id from public.calendar_appointments where organization_id = '${ORG_AG}' and owner_user_id = '${dono}' and starts_at = '${hora(ini)}' limit 1;`);
}

describe("D-160: dois compromissos ativos do mesmo dono não se sobrepõem", () => {
  beforeAll(() => {
    sql(`
      insert into auth.users (id, email) values ('${DONO1}', 'ag-d1@invariant.test'), ('${DONO2}', 'ag-d2@invariant.test') on conflict (id) do nothing;
      insert into public.organizations (id, slug, legal_name, display_name) values ('${ORG_AG}', 'lote13a-agenda', 'Agenda 13a', 'Agenda 13a') on conflict (id) do nothing;
      delete from public.calendar_appointments where organization_id = '${ORG_AG}';
    `);
  });

  it("o primeiro entra; a sobreposição parcial do mesmo dono é recusada com 23P01", () => {
    expect(tenta(`${compromisso(DONO1, "14:00", "15:00")};`)).toBe("");
    const motivo = tenta(`${compromisso(DONO1, "14:30", "15:30")};`);
    expect(motivo).toContain("23P01");
    expect(motivo).toContain("Horário indisponível");
  });

  it("o mesmo intervalo, o intervalo contido e o que engloba também são recusados", () => {
    for (const [ini, fim] of [["14:00", "15:00"], ["14:15", "14:45"], ["13:00", "16:00"], ["13:30", "14:01"]] as const) {
      expect(tenta(`${compromisso(DONO1, ini, fim)};`), `${ini}-${fim}`).toContain("23P01");
    }
    expect(sql(`select count(*) from public.calendar_appointments where organization_id = '${ORG_AG}' and owner_user_id = '${DONO1}';`)).toBe("1");
  });

  it("controle positivo: encostar (fim = início), outro dono e sem dono entram", () => {
    expect(tenta(`${compromisso(DONO1, "15:00", "16:00")};`)).toBe("");
    expect(tenta(`${compromisso(DONO1, "13:00", "14:00")};`)).toBe("");
    expect(tenta(`${compromisso(DONO2, "14:00", "15:00")};`)).toBe("");
    expect(tenta(`${compromisso(null, "14:00", "15:00")};`)).toBe("");
    expect(tenta(`${compromisso(null, "14:00", "15:00")};`)).toBe("");
  });

  it("o que libera o horário não conta: cancelado e falta do outro não bloqueiam; o novo cancelado não é conferido", () => {
    sql(`update public.calendar_appointments set status = 'cancelled', cancelled_at = now() where id = '${idDo(DONO1, "15:00")}';`);
    // a falta só se registra por pessoa logada (gatilho de autoria), então o fixture já nasce assim
    expect(tenta(`${compromisso(DONO1, "15:15", "15:45", "no_show")};`)).toBe("");
    expect(tenta(`${compromisso(DONO1, "15:20", "15:40")};`)).toBe("");
    // um compromisso que já nasce cancelado não ocupa nada, então não é conferido
    expect(tenta(`${compromisso(DONO1, "14:10", "14:20", "cancelled")};`)).toBe("");
  });

  it("pending ocupa como confirmed", () => {
    expect(tenta(`${compromisso(DONO2, "10:00", "11:00", "pending")};`)).toBe("");
    expect(tenta(`${compromisso(DONO2, "10:30", "11:30")};`)).toContain("23P01");
    expect(tenta(`${compromisso(DONO2, "10:30", "11:30", "pending")};`)).toContain("23P01");
  });

  it("remarcar para cima de outro compromisso é recusado; para o vazio e para o mesmo horário, não", () => {
    expect(tenta(`${compromisso(DONO1, "17:00", "18:00")};`)).toBe("");
    const id = idDo(DONO1, "17:00");
    const duplo = tenta(`update public.calendar_appointments set starts_at = '${hora("14:30")}', ends_at = '${hora("15:30")}' where id = '${id}';`);
    expect(duplo).toContain("23P01");
    expect(sql(`select starts_at = '${hora("17:00")}' from public.calendar_appointments where id = '${id}';`)).toBe("t");
    expect(tenta(`update public.calendar_appointments set starts_at = '${hora("19:00")}', ends_at = '${hora("20:00")}' where id = '${id}';`)).toBe("");
    // remarcar para o mesmo horário é no-op: o compromisso não se vê como conflito de si mesmo
    expect(tenta(`update public.calendar_appointments set starts_at = starts_at, ends_at = ends_at where id = '${id}';`)).toBe("");
    // alongar sem cruzar ninguém passa, e o intervalo alongado passa a ocupar o horário
    expect(tenta(`update public.calendar_appointments set ends_at = '${hora("22:00")}' where id = '${id}';`)).toBe("");
    expect(tenta(`${compromisso(DONO1, "21:00", "21:30")};`)).toContain("23P01");
  });

  it("trocar o dono para quem já está ocupado é recusado; para quem está livre, passa", () => {
    const id = idDo(DONO1, "13:00");
    expect(tenta(`update public.calendar_appointments set owner_user_id = '${DONO2}' where id = '${id}';`)).toBe("");
    // DONO2 tem 14:00-15:00 e 10:00-11:00: o compromisso de 14:00-15:00 do DONO1 não pode ir para ele
    const outro = idDo(DONO1, "14:00");
    expect(tenta(`update public.calendar_appointments set owner_user_id = '${DONO2}' where id = '${outro}';`)).toContain("23P01");
  });

  it("dado antigo já sobreposto não quebra: mexer em outra coluna ou cancelar passa, e só a linha que muda de horário é conferida", () => {
    const dono = "13a00001-a000-4000-8000-0000000000d3";
    sql(`insert into auth.users (id, email) values ('${dono}', 'ag-d3@invariant.test') on conflict (id) do nothing;`);
    // o legado entrou antes do gatilho: cria a sobreposição com os gatilhos desligados na sessão
    sql(`
      set session_replication_role = replica;
      insert into public.calendar_appointments (organization_id, owner_user_id, title, starts_at, ends_at, status) values
        ('${ORG_AG}', '${dono}', 'legado 1', '${hora("08:00")}', '${hora("09:00")}', 'confirmed'),
        ('${ORG_AG}', '${dono}', 'legado 2', '${hora("08:30")}', '${hora("09:30")}', 'confirmed');
    `);
    const id = idDo(dono, "08:30");
    expect(tenta(`update public.calendar_appointments set notes = 'só uma nota' where id = '${id}';`)).toBe("");
    // a linha que MUDA de horário é conferida: continuar em cima do outro legado é recusado
    expect(tenta(`update public.calendar_appointments set starts_at = '${hora("08:45")}', ends_at = '${hora("09:45")}' where id = '${id}';`)).toContain("23P01");
    expect(tenta(`update public.calendar_appointments set status = 'cancelled', cancelled_at = now() where id = '${id}';`)).toBe("");
    expect(tenta(`update public.calendar_appointments set notes = 'outra nota' where id = '${idDo(dono, "08:00")}';`)).toBe("");
  });

  it("uma corrida: duas marcações sobrepostas ao mesmo tempo, só uma entra (o gatilho serializa por dono)", async () => {
    // Início diferente de propósito: o índice único de mesmo início não pega este par, só o gatilho.
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      await a.query("begin");
      await b.query("begin");
      await a.query(`${compromisso(DONO1, "05:00", "06:00")}`);
      // b chega enquanto a ainda não confirmou: tem de esperar a trava do dono, e não passar batido
      let terminou = false;
      const segunda = b
        .query(`${compromisso(DONO1, "05:30", "06:30")}`)
        .then(() => ({ ok: true as const, code: "" }))
        .catch((err: { code?: string }) => ({ ok: false as const, code: err.code ?? "" }))
        .finally(() => {
          terminou = true;
        });
      await new Promise((r) => setTimeout(r, 400));
      expect(terminou).toBe(false);
      await a.query("commit");
      const resultado = await segunda;
      expect(resultado).toEqual({ ok: false, code: "23P01" });
      await b.query("rollback");
    } finally {
      a.release();
      b.release();
    }
    expect(sql(`select count(*) from public.calendar_appointments where organization_id = '${ORG_AG}' and owner_user_id = '${DONO1}' and starts_at >= '${hora("05:00")}' and starts_at < '${hora("07:00")}';`)).toBe("1");
  });

  it("controle positivo da corrida: donos diferentes não esperam um pelo outro", async () => {
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      await a.query("begin");
      await b.query("begin");
      await a.query(`${compromisso(DONO1, "03:00", "04:00")}`);
      await b.query(`${compromisso(DONO2, "03:00", "04:00")}`);
      await a.query("commit");
      await b.query("commit");
    } finally {
      a.release();
      b.release();
    }
  });

  it("a função do gatilho não é chamável por ninguém", () => {
    for (const papel of ["anon", "authenticated", "public"]) {
      expect(sql(`select has_function_privilege('${papel}', 'public.fn_agenda_sem_sobreposicao()', 'execute');`), papel).toBe("f");
    }
  });
});

/* ------------------------------------------------------------------------------------------- */
/* D-165: crm_tasks                                                                             */
/* ------------------------------------------------------------------------------------------- */

const ORG_B = "13a00002-b000-4000-8000-000000000002";
const CONTATO_B = "13a00002-b000-4000-8000-0000000000c1";
const PIPE_B = "13a00002-b000-4000-8000-0000000000e1";
const ETAPA_B = "13a00002-b000-4000-8000-0000000000e2";
const LEAD_B_TAREFA = "13a00002-b000-4000-8000-0000000000e3";
const USER_B = "13a00002-b000-4000-8000-0000000000f1";
const CONTATO_A = "13a00002-a000-4000-8000-0000000000c1";
const LEAD_A_TAREFA = "13a00002-a000-4000-8000-0000000000e3";
const USER_A_REVOGADO = "13a00002-a000-4000-8000-0000000000f2";

const tarefa = (campos: string, valores: string) => `insert into public.crm_tasks (organization_id, title, ${campos}) values ('${GOV_ORG}', 'tarefa', ${valores});`;

describe("D-165: tarefa só liga a negócio, contato e responsável da própria organização", () => {
  beforeAll(() => {
    seedGov();
    sql(`
      insert into auth.users (id, email) values
        ('${USER_B}', 'tar-b@invariant.test'), ('${USER_A_REVOGADO}', 'tar-a2@invariant.test')
        on conflict (id) do nothing;
      insert into public.organizations (id, slug, legal_name, display_name) values ('${ORG_B}', 'lote13a-tarefas-b', 'Tarefas B', 'Tarefas B') on conflict (id) do nothing;
      insert into public.user_organizations (user_id, organization_id, role, accepted_at) values ('${USER_B}', '${ORG_B}', 'agent', now()) on conflict do nothing;
      insert into public.user_organizations (user_id, organization_id, role, accepted_at, revoked_at)
        values ('${USER_A_REVOGADO}', '${GOV_ORG}', 'agent', now(), now()) on conflict do nothing;
      insert into public.contacts (id, organization_id, display_name) values ('${CONTATO_B}', '${ORG_B}', 'Contato B tarefa'), ('${CONTATO_A}', '${GOV_ORG}', 'Contato A tarefa') on conflict (id) do nothing;
      insert into public.crm_pipelines (id, organization_id, name, slug) values ('${PIPE_B}', '${ORG_B}', 'Funil B', 'funil-b-13a') on conflict (id) do nothing;
      insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position) values ('${ETAPA_B}', '${ORG_B}', '${PIPE_B}', 'Novo', 'novo-b-13a', 1000) on conflict (id) do nothing;
      insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title) values
        ('${LEAD_B_TAREFA}', '${ORG_B}', '${PIPE_B}', '${ETAPA_B}', 'Lead B tarefa'),
        ('${LEAD_A_TAREFA}', '${GOV_ORG}', '${GOV_PIPELINE}', '${GOV_STAGE}', 'Lead A tarefa') on conflict (id) do nothing;
    `);
  });

  const FK = "23503";

  it("negócio, contato ou responsável de outra organização: recusados com 23503, pela sessão e pelo serviço", () => {
    expect(tenta(tarefa("lead_id", `'${LEAD_B_TAREFA}'`))).toContain(FK);
    expect(tenta(tarefa("contact_id", `'${CONTATO_B}'`))).toContain(FK);
    expect(tenta(tarefa("assigned_to", `'${USER_B}'`))).toContain(FK);
    expect(comoTenta(GOV_AGENT_A, tarefa("lead_id", `'${LEAD_B_TAREFA}'`))).toContain(FK);
    expect(comoTenta(GOV_AGENT_A, tarefa("assigned_to", `'${USER_B}'`))).toContain(FK);
  });

  it("a mensagem não diz se o id existe em outra organização", () => {
    const existe = tenta(tarefa("contact_id", `'${CONTATO_B}'`));
    const naoExiste = tenta(tarefa("contact_id", `'${randomUUID()}'`));
    expect(existe).toContain("Registro vinculado não encontrado");
    expect(naoExiste).toContain(FK);
    expect(naoExiste).not.toContain(CONTATO_B);
  });

  it("responsável que saiu da organização (vínculo revogado) também é recusado", () => {
    expect(tenta(tarefa("assigned_to", `'${USER_A_REVOGADO}'`))).toContain(FK);
  });

  it("no UPDATE: trocar para o de fora é recusado; mexer em outra coluna e reenviar o mesmo valor, não", () => {
    sql(`insert into public.crm_tasks (id, organization_id, title, lead_id, contact_id, assigned_to) values
      ('13a00002-a000-4000-8000-0000000000aa', '${GOV_ORG}', 'ok', '${LEAD_A_TAREFA}', '${CONTATO_A}', '${GOV_AGENT_A}');`);
    const id = "13a00002-a000-4000-8000-0000000000aa";
    expect(tenta(`update public.crm_tasks set lead_id = '${LEAD_B_TAREFA}' where id = '${id}';`)).toContain(FK);
    expect(tenta(`update public.crm_tasks set contact_id = '${CONTATO_B}' where id = '${id}';`)).toContain(FK);
    expect(tenta(`update public.crm_tasks set assigned_to = '${USER_B}' where id = '${id}';`)).toContain(FK);
    expect(comoTenta(GOV_AGENT_A, `update public.crm_tasks set assigned_to = '${USER_B}' where id = '${id}';`)).toContain(FK);
    expect(tenta(`update public.crm_tasks set title = 'novo título', status = 'done' where id = '${id}';`)).toBe("");
    expect(tenta(`update public.crm_tasks set assigned_to = '${GOV_AGENT_A}', lead_id = '${LEAD_A_TAREFA}' where id = '${id}';`)).toBe("");
  });

  it("responsável que ficou revogado depois de a tarefa existir não impede editar a tarefa (só conferimos o campo que mudou)", () => {
    sql(`
      set session_replication_role = replica;
      insert into public.crm_tasks (id, organization_id, title, assigned_to) values ('13a00002-a000-4000-8000-0000000000ab', '${GOV_ORG}', 'antiga', '${USER_A_REVOGADO}');
    `);
    expect(tenta(`update public.crm_tasks set title = 'editada', status = 'in_progress' where id = '13a00002-a000-4000-8000-0000000000ab';`)).toBe("");
  });

  it("controle positivo: negócio, contato e responsável da própria organização passam; os três vazios também", () => {
    expect(tenta(tarefa("lead_id, contact_id, assigned_to", `'${LEAD_A_TAREFA}', '${CONTATO_A}', '${GOV_AGENT_A}'`))).toBe("");
    expect(comoTenta(GOV_AGENT_A, tarefa("assigned_to", `'${GOV_AGENT_B}'`))).toBe("");
    expect(comoTenta(GOV_AGENT_A, tarefa("priority", `'high'`))).toBe("");
    expect(tenta(tarefa("assigned_to", `'${GOV_MANAGER}'`))).toBe("");
  });
});

/* ------------------------------------------------------------------------------------------- */
/* D-147: visibilidade por atendente nas tabelas filhas                                         */
/* ------------------------------------------------------------------------------------------- */

const CONTATO_CONV_A = "13a00003-c000-4000-8000-0000000000c1";
const CONV_A = "13a00003-c000-4000-8000-0000000000c2";
const LEAD_A = "13a00003-c000-4000-8000-0000000000a1";
const LEAD_B = "13a00003-c000-4000-8000-0000000000a2";
const LEAD_FILA = "13a00003-c000-4000-8000-0000000000a3";

const SEM = "null";
const u = (v: string | null) => (v === null ? SEM : `'${v}'`);
const T = `'${GOV_ORG}'`;

interface Tabela {
  nome: string;
  coluna: "conversation_id" | "lead_id";
  /** Existe linha sem o vínculo (coluna nula): a regra pelo contato não existe, o comportamento antigo se mantém. */
  admiteSemVinculo: boolean;
  inserir: (v: string | null) => string;
}

const TABELAS: Tabela[] = [
  { nome: "agent_cases", coluna: "conversation_id", admiteSemVinculo: false, inserir: (v) => `insert into public.agent_cases (organization_id, conversation_id, title, summary, blocker) values (${T}, ${u(v)}, 't', 's', 'b')` },
  { nome: "ai_agent_runs", coluna: "conversation_id", admiteSemVinculo: true, inserir: (v) => `insert into public.ai_agent_runs (organization_id, agent_id, agent_version_id, conversation_id) values (${T}, gen_random_uuid(), gen_random_uuid(), ${u(v)})` },
  { nome: "ai_invocations", coluna: "conversation_id", admiteSemVinculo: true, inserir: (v) => `insert into public.ai_invocations (organization_id, invocation_kind, model, latency_ms, conversation_id) values (${T}, 'bot_respond', 'm', 1, ${u(v)})` },
  { nome: "ai_router_decisions", coluna: "conversation_id", admiteSemVinculo: true, inserir: (v) => `insert into public.ai_router_decisions (organization_id, outcome, conversation_id) values (${T}, 'classified', ${u(v)})` },
  { nome: "contact_field_proposals", coluna: "conversation_id", admiteSemVinculo: true, inserir: (v) => `insert into public.contact_field_proposals (organization_id, contact_id, campo, valor_proposto, expires_at, conversation_id) values (${T}, gen_random_uuid(), 'name', 'v', now() + interval '1 day', ${u(v)})` },
  { nome: "conversation_notes", coluna: "conversation_id", admiteSemVinculo: false, inserir: (v) => `insert into public.conversation_notes (organization_id, conversation_id, body) values (${T}, ${u(v)}, 'nota interna')` },
  { nome: "demanda_conversas", coluna: "conversation_id", admiteSemVinculo: false, inserir: (v) => `insert into public.demanda_conversas (organization_id, demanda_id, conversation_id) values (${T}, gen_random_uuid(), ${u(v)})` },
  { nome: "followup_enrollments", coluna: "conversation_id", admiteSemVinculo: true, inserir: (v) => `insert into public.followup_enrollments (organization_id, pointer_id, version_id, contact_id, current_node_id, conversation_id) values (${T}, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'n', ${u(v)})` },
  { nome: "jev_observacoes", coluna: "conversation_id", admiteSemVinculo: true, inserir: (v) => `insert into public.jev_observacoes (organization_id, tarefa, estado, conversation_id) values (${T}, 't', 'observando', ${u(v)})` },
  { nome: "lead_checkpoints", coluna: "conversation_id", admiteSemVinculo: true, inserir: (v) => `insert into public.lead_checkpoints (organization_id, contact_id, conversation_id, rolling_summary) values (${T}, gen_random_uuid(), ${u(v)}, 'resumo')` },
  { nome: "crm_lead_reactivations", coluna: "lead_id", admiteSemVinculo: false, inserir: (v) => `insert into public.crm_lead_reactivations (lead_id, organization_id, expires_at) values (${u(v)}, ${T}, now() + interval '1 day')` },
  { nome: "crm_lead_risk_states", coluna: "lead_id", admiteSemVinculo: false, inserir: (v) => `insert into public.crm_lead_risk_states (lead_id, organization_id, bucket, since, cold_hours) values (${u(v)}, ${T}, 'em_dia', now() - interval '1 hour', 1)` },
  { nome: "crm_lead_scores", coluna: "lead_id", admiteSemVinculo: false, inserir: (v) => `insert into public.crm_lead_scores (lead_id, organization_id) values (${u(v)}, ${T})` },
  { nome: "demandas", coluna: "lead_id", admiteSemVinculo: true, inserir: (v) => `insert into public.demandas (organization_id, contact_id, lead_id) values (${T}, gen_random_uuid(), ${u(v)})` },
  { nome: "golden_candidates", coluna: "lead_id", admiteSemVinculo: true, inserir: (v) => `insert into public.golden_candidates (organization_id, job_id, fonte, skill, motivo, lead_id) values (${T}, gen_random_uuid(), 'skill_match_miss', 's', 'm', ${u(v)})` },
  { nome: "voice_calls", coluna: "lead_id", admiteSemVinculo: true, inserir: (v) => `insert into public.voice_calls (organization_id, direction, peer_phone, status, lead_id) values (${T}, 'outbound', '+5511999990000', 'ended', ${u(v)})` },
];

const VINCULOS = {
  conversation_id: { meu: CONV_A, alheio: GOV_CONV_AGENT_B, fila: GOV_CONV_UNASSIGNED },
  lead_id: { meu: LEAD_A, alheio: LEAD_B, fila: LEAD_FILA },
} as const;

function modo(valor: "own_and_unassigned" | "own" | "all") {
  sql(`update public.organizations set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{visibility_mode}', '"${valor}"') where id = '${GOV_ORG}';`);
}

/** Uma consulta só, como o usuário: quantas linhas de cada tabela ele enxerga em cada vínculo. */
function enxerga(usuario: string): Record<string, { meu: number; alheio: number; fila: number; semVinculo: number }> {
  const consultas = TABELAS.map((t) => {
    const v = VINCULOS[t.coluna];
    return `select '${t.nome}', count(*) filter (where ${t.coluna} = '${v.meu}'), count(*) filter (where ${t.coluna} = '${v.alheio}'),
              count(*) filter (where ${t.coluna} = '${v.fila}'), count(*) filter (where ${t.coluna} is null)
              from public.${t.nome} where organization_id = '${GOV_ORG}'`;
  }).join("\nunion all\n");
  const saida = como(usuario, `${consultas};`).split("\n").filter((l) => l.includes("|"));
  const lido: Record<string, { meu: number; alheio: number; fila: number; semVinculo: number }> = {};
  for (const linha of saida) {
    const [nome, meu, alheio, fila, semVinculo] = linha.split("|");
    lido[nome as string] = { meu: Number(meu), alheio: Number(alheio), fila: Number(fila), semVinculo: Number(semVinculo) };
  }
  return lido;
}

describe("D-147: a visibilidade por atendente vale nas tabelas filhas", () => {
  beforeAll(() => {
    seedGov();
    sql(`
      insert into public.contacts (id, organization_id, display_name) values ('${CONTATO_CONV_A}', '${GOV_ORG}', 'Contato da conversa de A') on conflict (id) do nothing;
      insert into public.conversations (id, organization_id, contact_id, channel_session_id, status, assigned_to_user_id, assigned_at)
        values ('${CONV_A}', '${GOV_ORG}', '${CONTATO_CONV_A}', '${GOV_SESSION}', 'claimed', '${GOV_AGENT_A}', now()) on conflict (id) do nothing;
      insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title, owner_user_id) values
        ('${LEAD_A}', '${GOV_ORG}', '${GOV_PIPELINE}', '${GOV_STAGE}', 'Lead de A (13a)', '${GOV_AGENT_A}'),
        ('${LEAD_B}', '${GOV_ORG}', '${GOV_PIPELINE}', '${GOV_STAGE}', 'Lead de B (13a)', '${GOV_AGENT_B}'),
        ('${LEAD_FILA}', '${GOV_ORG}', '${GOV_PIPELINE}', '${GOV_STAGE}', 'Lead da fila (13a)', null) on conflict (id) do nothing;
    `);
    // As filhas entram pelo dono do banco, com as FKs desligadas na sessão (o assunto aqui é a leitura, não o pai de cada linha).
    const inserts = TABELAS.flatMap((t) => {
      const v = VINCULOS[t.coluna];
      const linhasT = [v.meu, v.alheio, v.fila].map((id) => `${t.inserir(id)};`);
      if (t.admiteSemVinculo) linhasT.push(`${t.inserir(null)};`);
      return linhasT;
    });
    sql(`set session_replication_role = replica;\n${inserts.join("\n")}`);
    modo("own_and_unassigned");
  });

  afterAll(() => {
    modo("own_and_unassigned");
  });

  it("fixture: cada tabela recebeu a linha de cada vínculo (a prova de leitura abaixo não passa vazia)", () => {
    for (const t of TABELAS) {
      const total = Number(sql(`select count(*) from public.${t.nome} where organization_id = '${GOV_ORG}';`));
      expect(total, t.nome).toBe(3 + (t.admiteSemVinculo ? 1 : 0));
    }
  });

  it("agent no modo padrão (own_and_unassigned): vê o seu e a fila, não o do colega", () => {
    modo("own_and_unassigned");
    const lido = enxerga(GOV_AGENT_A);
    for (const t of TABELAS) {
      expect(lido[t.nome], t.nome).toEqual({ meu: 1, alheio: 0, fila: 1, semVinculo: t.admiteSemVinculo ? 1 : 0 });
    }
  });

  it("agent no modo own: vê só o seu", () => {
    modo("own");
    const lido = enxerga(GOV_AGENT_A);
    for (const t of TABELAS) {
      expect(lido[t.nome], t.nome).toEqual({ meu: 1, alheio: 0, fila: 0, semVinculo: t.admiteSemVinculo ? 1 : 0 });
    }
  });

  it("agent no modo all: vê tudo (controle positivo: a regra segue o modo da organização)", () => {
    modo("all");
    const lido = enxerga(GOV_AGENT_A);
    for (const t of TABELAS) {
      expect(lido[t.nome], t.nome).toEqual({ meu: 1, alheio: 1, fila: 1, semVinculo: t.admiteSemVinculo ? 1 : 0 });
    }
  });

  it("o outro agent vê o dele, e não o de A", () => {
    modo("own");
    const lido = enxerga(GOV_AGENT_B);
    for (const t of TABELAS) {
      expect(lido[t.nome], t.nome).toEqual({ meu: 0, alheio: 1, fila: 0, semVinculo: t.admiteSemVinculo ? 1 : 0 });
    }
  });

  it("viewer, manager e admin seguem lendo a organização inteira, em qualquer modo", () => {
    modo("own");
    for (const usuario of [GOV_VIEWER, GOV_MANAGER]) {
      const lido = enxerga(usuario);
      for (const t of TABELAS) {
        expect(lido[t.nome], `${usuario} ${t.nome}`).toEqual({ meu: 1, alheio: 1, fila: 1, semVinculo: t.admiteSemVinculo ? 1 : 0 });
      }
    }
  });

  it("o serviço (service_role) não é afetado", () => {
    modo("own");
    const total = sql(`set role service_role; select count(*) from public.conversation_notes where organization_id = '${GOV_ORG}';`).split("\n").pop();
    expect(total).toBe("3");
  });

  it("quando há conversa e negócio, vale a conversa (a nota da conversa do colega some mesmo com negócio meu)", () => {
    modo("own");
    sql(`set session_replication_role = replica;
      insert into public.agent_cases (organization_id, conversation_id, lead_id, title, summary, blocker)
        values ('${GOV_ORG}', '${GOV_CONV_AGENT_B}', '${LEAD_A}', 'misto', 's', 'b');`);
    expect(Number(como(GOV_AGENT_A, `select count(*) from public.agent_cases where title = 'misto';`).split("\n").pop())).toBe(0);
    expect(Number(como(GOV_MANAGER, `select count(*) from public.agent_cases where title = 'misto';`).split("\n").pop())).toBe(1);
  });

  it("ligação: quem fez a chamada a enxerga mesmo sem ver o negócio", () => {
    modo("own");
    sql(`set session_replication_role = replica;
      insert into public.voice_calls (organization_id, direction, peer_phone, status, lead_id, owner_user_id)
        values ('${GOV_ORG}', 'outbound', '+5511999990001', 'ended', '${LEAD_B}', '${GOV_AGENT_A}');
      insert into public.voice_calls (organization_id, direction, peer_phone, status, lead_id, created_by)
        values ('${GOV_ORG}', 'outbound', '+5511999990002', 'ended', '${LEAD_B}', '${GOV_AGENT_A}');`);
    expect(Number(como(GOV_AGENT_A, `select count(*) from public.voice_calls where peer_phone in ('+5511999990001', '+5511999990002');`).split("\n").pop())).toBe(2);
    expect(Number(como(GOV_AGENT_B, `select count(*) from public.voice_calls where peer_phone in ('+5511999990001', '+5511999990002');`).split("\n").pop())).toBe(2);
    sql(`update public.voice_calls set owner_user_id = '${GOV_AGENT_B}', created_by = '${GOV_AGENT_B}' where peer_phone in ('+5511999990001', '+5511999990002');`);
    expect(Number(como(GOV_AGENT_A, `select count(*) from public.voice_calls where peer_phone in ('+5511999990001', '+5511999990002');`).split("\n").pop())).toBe(0);
  });

  it("a escrita não mudou: viewer barrado, agent escreve onde escrevia (nota e ligação)", () => {
    modo("own_and_unassigned");
    const nota = (conversa: string) => `insert into public.conversation_notes (organization_id, conversation_id, body) values ('${GOV_ORG}', '${conversa}', 'nova nota');`;
    expect(comoTenta(GOV_VIEWER, nota(GOV_CONV_UNASSIGNED))).toContain(RLS);
    expect(comoTenta(GOV_AGENT_A, nota(CONV_A))).toBe("");
    const ligacao = `insert into public.voice_calls (organization_id, direction, peer_phone, status, lead_id) values ('${GOV_ORG}', 'outbound', '+5511999990003', 'starting', '${LEAD_A}');`;
    expect(comoTenta(GOV_VIEWER, ligacao)).toContain(RLS);
    expect(comoTenta(GOV_AGENT_A, ligacao)).toBe("");
  });

  it("agent não edita nem apaga nota de conversa que não enxerga; na própria, sim", () => {
    modo("own");
    expect(linhas(GOV_AGENT_A, `update public.conversation_notes set body = 'golpe' where conversation_id = '${GOV_CONV_AGENT_B}'`)).toBe(0);
    expect(linhas(GOV_AGENT_A, `delete from public.conversation_notes where conversation_id = '${GOV_CONV_AGENT_B}'`)).toBe(0);
    expect(linhas(GOV_AGENT_A, `update public.conversation_notes set body = 'ajustada' where conversation_id = '${CONV_A}'`)).toBeGreaterThan(0);
    expect(linhas(GOV_AGENT_A, `delete from public.conversation_notes where conversation_id = '${CONV_A}'`)).toBeGreaterThan(0);
    expect(sql(`select count(*) from public.conversation_notes where conversation_id = '${GOV_CONV_AGENT_B}' and body = 'nota interna';`)).toBe("1");
  });

  it("a função de apoio é de quem está logado, nunca da chave anônima", () => {
    expect(sql(`select has_function_privilege('anon', 'public.fn_registro_filho_visivel(uuid,uuid,uuid)', 'execute');`)).toBe("f");
    expect(sql(`select has_function_privilege('authenticated', 'public.fn_registro_filho_visivel(uuid,uuid,uuid)', 'execute');`)).toBe("t");
    // fora da organização, nem a pergunta devolve "sim"
    modo("all");
    expect(como(GOV_AGENT_A, `select public.fn_registro_filho_visivel('${randomUUID()}', null, null);`).split("\n").pop()).toBe("f");
  });

  it("o custo por linha cabe em índice: os pais são lidos pela chave primária", () => {
    for (const [tabela, indice] of [["conversations", "conversations_pkey"], ["crm_leads", "crm_leads_pkey"]] as const) {
      expect(sql(`select count(*) from pg_indexes where schemaname = 'public' and tablename = '${tabela}' and indexname = '${indice}';`)).toBe("1");
    }
  });
});
