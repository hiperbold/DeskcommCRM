/**
 * Migrations 0923 a 0927 (lote 6 da auditoria de 30/09/2026: D-138, D-139, D-111,
 * D-112, D-113, D-163, D-127 parcial, D-129). Provado no Postgres real, como
 * `authenticated` com o JWT do usuário, sempre em par: o papel de baixo é barrado e o
 * papel que a rota exige passa (controle positivo).
 *
 * Roda via `pnpm test:db tests/invariants/lote6-rls-e-banco.test.ts`.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

const ORG = "09230001-a5aa-4000-8000-000000000001";
const OUTRA = "09230001-a5aa-4000-8000-000000000002";
const VIEWER = "09230001-b0b0-4000-8000-000000000001";
const AGENT = "09230001-b0b0-4000-8000-000000000002";
const MANAGER = "09230001-b0b0-4000-8000-000000000003";
const ADMIN_B = "09230001-b0b0-4000-8000-000000000004";
const SEM_ORG = "09230001-b0b0-4000-8000-000000000005";
const CONTA = "09230001-c0c0-4000-8000-000000000001";
const COMANDA_ABERTA = "09230001-c0c0-4000-8000-000000000002";
const COMANDA_FECHADA = "09230001-c0c0-4000-8000-000000000003";
const COMANDA_DE_B = "09230001-c0c0-4000-8000-000000000004";
const LANC_PAGO = "09230001-c0c0-4000-8000-000000000005";
const LANC_PENDENTE = "09230001-c0c0-4000-8000-000000000006";
const CONTATO = "09230001-c0c0-4000-8000-000000000007";
const FLUXO = "09230001-d0d0-4000-8000-000000000001";
const VERSAO = "09230001-d0d0-4000-8000-000000000002";
const VERSAO_DE_B = "09230001-d0d0-4000-8000-000000000003";
const AGENTE_DE_B = "09230001-d0d0-4000-8000-000000000004";
const NUMERO = "09230001-e0e0-4000-8000-000000000001";
const JOB = "09230001-e0e0-4000-8000-000000000002";

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

const contagem = (tabela: string, onde: string) =>
  Number(sql(`select count(*) from public.${tabela} where ${onde};`));

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${VIEWER}', 'viewer-0923@invariant.test'),
      ('${AGENT}', 'agent-0923@invariant.test'),
      ('${MANAGER}', 'manager-0923@invariant.test'),
      ('${ADMIN_B}', 'admin-b-0923@invariant.test'),
      ('${SEM_ORG}', 'sem-org-0923@invariant.test')
      on conflict (id) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG}', 'lote6-a', 'Lote6 A', 'Lote6 A'),
      ('${OUTRA}', 'lote6-b', 'Lote6 B', 'Lote6 B')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${VIEWER}', '${ORG}', 'viewer', now()),
      ('${AGENT}', '${ORG}', 'agent', now()),
      ('${MANAGER}', '${ORG}', 'manager', now()),
      ('${ADMIN_B}', '${OUTRA}', 'admin', now())
      on conflict do nothing;
    insert into public.contacts (id, organization_id, name, phone_number)
      values ('${CONTATO}', '${ORG}', 'Cliente 0923', '+5511900000923') on conflict (id) do nothing;

    insert into public.financial_accounts (id, organization_id, name) values ('${CONTA}', '${ORG}', 'Caixa 0923')
      on conflict (id) do nothing;
    insert into public.sales (id, organization_id, number, status, cancelled_at) values
      ('${COMANDA_ABERTA}', '${ORG}', 923001, 'open', null),
      ('${COMANDA_FECHADA}', '${ORG}', 923002, 'cancelled', now()),
      ('${COMANDA_DE_B}', '${OUTRA}', 923003, 'open', null)
      on conflict (id) do nothing;
    insert into public.financial_entries (id, organization_id, account_id, direction, amount_cents, status, paid_at, origin) values
      ('${LANC_PAGO}', '${ORG}', '${CONTA}', 'in', 1000, 'paid', now(), 'manual'),
      ('${LANC_PENDENTE}', '${ORG}', '${CONTA}', 'in', 500, 'pending', null, 'manual')
      on conflict (id) do nothing;

    insert into public.followup_flow_pointers (id, organization_id, name) values ('${FLUXO}', '${ORG}', 'Fluxo 0923')
      on conflict (id) do nothing;
    insert into public.followup_flow_versions (id, organization_id, pointer_id, graph) values
      ('${VERSAO}', '${ORG}', '${FLUXO}', '{"texto":"original"}'::jsonb)
      on conflict (id) do nothing;
    insert into public.followup_flow_pointers (id, organization_id, name)
      values ('09230001-d0d0-4000-8000-000000000009', '${OUTRA}', 'Fluxo B 0923') on conflict (id) do nothing;
    insert into public.followup_flow_versions (id, organization_id, pointer_id, graph) values
      ('${VERSAO_DE_B}', '${OUTRA}', '09230001-d0d0-4000-8000-000000000009', '{}'::jsonb)
      on conflict (id) do nothing;
    update public.followup_flow_pointers set active_version_id = '${VERSAO}' where id = '${FLUXO}';

    insert into public.ai_agents (id, organization_id, name, system_prompt)
      values ('${AGENTE_DE_B}', '${OUTRA}', 'Agente B 0923', 'x') on conflict (id) do nothing;
    insert into public.phone_numbers (id, organization_id, number, trunk_endpoint)
      values ('${NUMERO}', '${ORG}', '+5511900009230', 'sip:tronco-0923') on conflict (id) do nothing;
    insert into public.job_queue (id, organization_id, kind)
      values ('${JOB}', '${ORG}', 'watchdog') on conflict (id) do nothing;
  `);
});

describe("D-138: financeiro no papel da rota", () => {
  it("viewer não apaga lançamento pago nem pendente; nem insere", () => {
    expect(linhas(VIEWER, `delete from public.financial_entries where id = '${LANC_PAGO}'`)).toBe(0);
    expect(linhas(VIEWER, `delete from public.financial_entries where id = '${LANC_PENDENTE}'`)).toBe(0);
    expect(contagem("financial_entries", `id = '${LANC_PAGO}'`)).toBe(1);
    const motivo = recusado(() =>
      como(VIEWER, `insert into public.financial_entries (organization_id, account_id, direction, amount_cents, origin)
        values ('${ORG}', '${CONTA}', 'in', 1, 'manual');`),
    );
    expect(motivo).toContain("row-level security");
  });

  it("agent não apaga lançamento pago, mas apaga o pendente manual (controle positivo)", () => {
    expect(linhas(AGENT, `delete from public.financial_entries where id = '${LANC_PAGO}'`)).toBe(0);
    expect(contagem("financial_entries", `id = '${LANC_PAGO}'`)).toBe(1);
    sql(`insert into public.financial_entries (id, organization_id, account_id, direction, amount_cents, status, origin)
      values ('09230001-c0c0-4000-8000-000000000016', '${ORG}', '${CONTA}', 'in', 7, 'pending', 'manual') on conflict do nothing;`);
    expect(linhas(AGENT, `delete from public.financial_entries where id = '09230001-c0c0-4000-8000-000000000016'`)).toBe(1);
  });

  it("agent cria lançamento manual e marca o pendente como pago; não forja origem de comanda", () => {
    como(AGENT, `insert into public.financial_entries (organization_id, account_id, direction, amount_cents, origin)
      values ('${ORG}', '${CONTA}', 'in', 11, 'manual');`);
    expect(
      linhas(AGENT, `update public.financial_entries set status = 'paid', paid_at = now() where id = '${LANC_PENDENTE}'`),
    ).toBe(1);
    const motivo = recusado(() =>
      como(AGENT, `insert into public.financial_entries (organization_id, account_id, direction, amount_cents, origin)
        values ('${ORG}', '${CONTA}', 'in', 12, 'sale');`),
    );
    expect(motivo).toContain("row-level security");
  });

  it("lançamento já pago não é reescrito pelo agent", () => {
    expect(linhas(AGENT, `update public.financial_entries set status = 'pending', paid_at = null where id = '${LANC_PAGO}'`)).toBe(0);
  });

  it("agent não cria regra de comissão (a rota é de manager); manager cria", () => {
    const sqlRegra = `insert into public.commission_rules (organization_id, percent, attendant_user_id) values ('${ORG}', 100, '${AGENT}');`;
    expect(recusado(() => como(AGENT, sqlRegra))).toContain("row-level security");
    expect(recusado(() => como(VIEWER, sqlRegra))).toContain("row-level security");
    expect(recusado(() => como(MANAGER, sqlRegra))).toBe("");
  });

  it("conta e forma de pagamento: viewer e agent não apagam nem alteram; manager altera", () => {
    expect(linhas(VIEWER, `delete from public.financial_accounts where id = '${CONTA}'`)).toBe(0);
    expect(linhas(AGENT, `update public.financial_accounts set name = 'X' where id = '${CONTA}'`)).toBe(0);
    expect(linhas(MANAGER, `update public.financial_accounts set name = 'Caixa 0923' where id = '${CONTA}'`)).toBe(1);
    expect(linhas(MANAGER, `delete from public.financial_accounts where id = '${CONTA}'`)).toBe(0);
  });

  it("comanda: agent altera a aberta, não a finalizada; ninguém apaga; viewer não escreve", () => {
    expect(linhas(AGENT, `update public.sales set notes = 'ok' where id = '${COMANDA_ABERTA}'`)).toBe(1);
    expect(linhas(AGENT, `update public.sales set status = 'open', cancelled_at = null where id = '${COMANDA_FECHADA}'`)).toBe(0);
    expect(linhas(AGENT, `delete from public.sales where id = '${COMANDA_ABERTA}'`)).toBe(0);
    expect(linhas(VIEWER, `update public.sales set notes = 'x' where id = '${COMANDA_ABERTA}'`)).toBe(0);
  });

  it("D-127: item só entra em comanda aberta e da mesma organização", () => {
    const item = (venda: string) => `insert into public.sale_items (organization_id, sale_id, description, unit_price_cents, total_cents)
      values ('${ORG}', '${venda}', 'Item', 100, 100);`;
    expect(recusado(() => como(AGENT, item(COMANDA_ABERTA)))).toBe("");
    expect(recusado(() => como(AGENT, item(COMANDA_FECHADA)))).toContain("row-level security");
    expect(recusado(() => como(AGENT, item(COMANDA_DE_B)))).toContain("row-level security");
    expect(recusado(() => como(VIEWER, item(COMANDA_ABERTA)))).toContain("row-level security");
  });

  it("pontos de fidelidade: viewer não dá, agent dá, ninguém altera nem apaga o livro", () => {
    const ponto = `insert into public.loyalty_ledger (organization_id, contact_id, points, reason) values ('${ORG}', '${CONTATO}', 10, 'teste');`;
    expect(recusado(() => como(VIEWER, ponto))).toContain("row-level security");
    expect(recusado(() => como(AGENT, ponto))).toBe("");
    expect(linhas(AGENT, `update public.loyalty_ledger set points = 9999 where organization_id = '${ORG}'`)).toBe(0);
    expect(linhas(MANAGER, `delete from public.loyalty_ledger where organization_id = '${ORG}'`)).toBe(0);
  });

  it("leitura segue para o membro (viewer vê o financeiro da própria empresa, não o da outra)", () => {
    expect(Number(como(VIEWER, `select count(*) from public.financial_entries where organization_id = '${ORG}';`).split("\n").pop())).toBeGreaterThan(0);
    expect(Number(como(VIEWER, `select count(*) from public.sales where organization_id = '${OUTRA}';`).split("\n").pop())).toBe(0);
  });
});

describe("D-139: roteiros de follow-up", () => {
  it("viewer e agent não reescrevem o graph da versão, nem o ponteiro", () => {
    for (const quem of [VIEWER, AGENT]) {
      expect(linhas(quem, `update public.followup_flow_versions set graph = '{"texto":"golpe"}'::jsonb where id = '${VERSAO}'`)).toBe(0);
      expect(linhas(quem, `update public.followup_flow_pointers set status = 'active' where id = '${FLUXO}'`)).toBe(0);
      expect(linhas(quem, `delete from public.followup_flow_versions where id = '${VERSAO}'`)).toBe(0);
    }
    expect(sql(`select graph->>'texto' from public.followup_flow_versions where id = '${VERSAO}';`)).toBe("original");
  });

  it("controle positivo: manager edita o ponteiro e lê a versão; viewer lê", () => {
    expect(linhas(MANAGER, `update public.followup_flow_pointers set name = 'Fluxo 0923' where id = '${FLUXO}'`)).toBe(1);
    expect(Number(como(VIEWER, `select count(*) from public.followup_flow_versions where id = '${VERSAO}';`).split("\n").pop())).toBe(1);
  });

  it("viewer não cria inscrição nem evento; manager cria inscrição", () => {
    const insc = `insert into public.followup_enrollments (organization_id, pointer_id, version_id, contact_id, current_node_id)
      values ('${ORG}', '${FLUXO}', '${VERSAO}', '${CONTATO}', 'inicio');`;
    expect(recusado(() => como(VIEWER, insc))).toContain("row-level security");
    expect(recusado(() => como(AGENT, insc))).toContain("row-level security");
    expect(recusado(() => como(MANAGER, insc))).toBe("");
  });

  it("D-127: o ponteiro não ativa versão de outra organização, mas ativa a própria", () => {
    const motivo = recusado(() =>
      como(MANAGER, `update public.followup_flow_pointers set active_version_id = '${VERSAO_DE_B}' where id = '${FLUXO}';`),
    );
    expect(motivo).toMatch(/Versão não encontrada|row-level|violates/);
    expect(sql(`select active_version_id from public.followup_flow_pointers where id = '${FLUXO}';`)).toBe(VERSAO);
    expect(
      recusado(() => sql(`update public.followup_flow_pointers set active_version_id = '${VERSAO_DE_B}' where id = '${FLUXO}';`)),
    ).toContain("Versão não encontrada");
    expect(recusado(() => sql(`update public.followup_flow_pointers set active_version_id = '${VERSAO}' where id = '${FLUXO}';`))).toBe("");
  });
});

describe("D-111 e D-112: números de telefone da voz", () => {
  it("D-111: fn_resolve_inbound_number não é executável por usuário logado; o serviço resolve", () => {
    expect(recusado(() => como(SEM_ORG, `select * from public.fn_resolve_inbound_number('+5511900009230');`))).toContain("permission denied");
    expect(recusado(() => como(VIEWER, `select * from public.fn_resolve_inbound_number('+5511900009230');`))).toContain("permission denied");
    expect(
      sql(`set role service_role; select organization_id from public.fn_resolve_inbound_number('+5511900009230');`).split("\n").pop(),
    ).toBe(ORG);
    expect(sql(`select count(*) from pg_proc where proname = 'fn_resolve_inbound_number' and proconfig::text like '%search_path=public%';`)).toBe("1");
  });

  it("D-111 vizinho: fn_colegas_podem_mexer_na_agenda só responde por quem é da organização", () => {
    expect(como(AGENT, `select public.fn_colegas_podem_mexer_na_agenda('${ORG}');`).split("\n").pop()).toBe("t");
    expect(como(AGENT, `select public.fn_colegas_podem_mexer_na_agenda('${OUTRA}');`).split("\n").pop()).toBe("f");
    expect(sql(`select public.fn_colegas_podem_mexer_na_agenda('${OUTRA}');`)).toBe("t");
  });

  it("D-112: viewer e agent não mexem em phone_numbers; manager cadastra e edita", () => {
    for (const quem of [VIEWER, AGENT]) {
      expect(linhas(quem, `update public.phone_numbers set trunk_endpoint = 'sip:golpe' where id = '${NUMERO}'`)).toBe(0);
      expect(linhas(quem, `delete from public.phone_numbers where id = '${NUMERO}'`)).toBe(0);
      expect(
        recusado(() => como(quem, `insert into public.phone_numbers (organization_id, number, trunk_endpoint) values ('${ORG}', '+5511900009231', 'x');`)),
      ).toContain("row-level security");
    }
    expect(recusado(() => como(MANAGER, `insert into public.phone_numbers (organization_id, number, trunk_endpoint) values ('${ORG}', '+5511900009232', 'sip:ok');`))).toBe("");
    expect(linhas(MANAGER, `update public.phone_numbers set label = 'principal' where id = '${NUMERO}'`)).toBe(1);
  });

  it("D-112: o agente padrão tem de ser da mesma organização", () => {
    const motivo = recusado(() =>
      como(MANAGER, `update public.phone_numbers set default_ai_agent_id = '${AGENTE_DE_B}' where id = '${NUMERO}';`),
    );
    expect(motivo).toContain("Agente não encontrado");
  });
});

describe("D-113 e D-163: tabelas do servidor", () => {
  it("viewer, agent e manager não apagam a fila de jobs nem inserem job; a leitura segue", () => {
    for (const quem of [VIEWER, AGENT, MANAGER]) {
      expect(recusado(() => como(quem, `delete from public.job_queue where id = '${JOB}';`))).toContain("permission denied");
      expect(
        recusado(() => como(quem, `insert into public.job_queue (organization_id, kind) values ('${ORG}', 'watchdog');`)),
      ).toContain("permission denied");
    }
    expect(contagem("job_queue", `id = '${JOB}'`)).toBe(1);
    expect(Number(como(VIEWER, `select count(*) from public.job_queue where id = '${JOB}';`).split("\n").pop())).toBe(1);
  });

  it("D-163: viewer não soma custo em ai_budgets pelo INSERT em ai_invocations", () => {
    const motivo = recusado(() =>
      como(VIEWER, `insert into public.ai_invocations (organization_id, invocation_kind, model, latency_ms, cost_cents)
        values ('${ORG}', 'bot_respond', 'm', 1, 999999);`),
    );
    expect(motivo).toContain("permission denied");
    expect(contagem("ai_budgets", `organization_id = '${ORG}' and current_month_consumed_cents >= 999999`)).toBe(0);
  });

  it("controle positivo: o dono do banco e o serviço seguem gravando (o gatilho definer soma)", () => {
    sql(`insert into public.ai_invocations (organization_id, invocation_kind, model, latency_ms, cost_cents)
      values ('${ORG}', 'bot_respond', 'm', 1, 5);`);
    expect(Number(sql(`select current_month_consumed_cents from public.ai_budgets where organization_id = '${ORG}';`))).toBeGreaterThanOrEqual(5);
    expect(recusado(() => sql(`set role service_role; insert into public.job_queue (organization_id, kind) values ('${ORG}', 'watchdog');`))).toBe("");
  });

  it("playbook_pointers e lead_state_transitions: authenticated sem privilégio de escrita", () => {
    const sem = sql(`
      select coalesce(string_agg(t, ','), '') from (values ('playbook_pointers'), ('skill_pointers'), ('lead_state_transitions'),
        ('send_ledger'), ('pacing_ledger'), ('metrics'), ('ai_agent_runs')) v(t)
      where has_table_privilege('authenticated', 'public.' || t, 'insert')
         or has_table_privilege('authenticated', 'public.' || t, 'update')
         or has_table_privilege('authenticated', 'public.' || t, 'delete');`);
    expect(sem).toBe("");
  });

  it("a varredura de proteção cria só SELECT para a tabela nova de organização", () => {
    sql(`create table public.sonda_lote6_0926 (id uuid primary key default gen_random_uuid(),
          organization_id uuid not null references public.organizations(id) on delete cascade);
         select public.fn_proteger_tabelas_de_organizacao();`);
    try {
      expect(sql(`select cmd from pg_policies where tablename = 'sonda_lote6_0926';`)).toBe("SELECT");
    } finally {
      sql(`drop table public.sonda_lote6_0926 cascade;`);
    }
  });
});

describe("D-129: emit_event", () => {
  const emite = (usuario: string, tipo: string, org: string | null, entidade = "09230001-f0f0-4000-8000-000000000001") =>
    como(
      usuario,
      `select public.emit_event('${tipo}', 'crm_lead', '${entidade}', '{}'::jsonb, '{}'::jsonb, ${org ? `'${org}'` : "null"});`,
    );

  it("viewer não emite lead.stage_changed; agent emite (controle positivo)", () => {
    expect(recusado(() => emite(VIEWER, "lead.stage_changed", ORG))).toContain("caller_not_authorized_for_org");
    expect(recusado(() => emite(AGENT, "lead.stage_changed", ORG))).toBe("");
  });

  it("sem organização informada recusa, em vez de escolher uma com limit 1", () => {
    expect(recusado(() => emite(AGENT, "lead.created", null))).toContain("organization_id obrigatorio");
  });

  it("o viewer ainda emite o evento do próprio perfil, e só o próprio", () => {
    expect(recusado(() => emite(VIEWER, "user.profile_updated", ORG, VIEWER))).toBe("");
    expect(recusado(() => emite(VIEWER, "user.profile_updated", ORG, AGENT))).toContain("caller_not_authorized_for_org");
  });

  it("agent de outra organização continua barrado; o serviço (sem JWT) emite com organização", () => {
    expect(recusado(() => emite(ADMIN_B, "lead.created", ORG))).toContain("caller_not_authorized_for_org");
    expect(recusado(() => sql(`select public.emit_event('lead.created', 'crm_lead', '09230001-f0f0-4000-8000-000000000002', '{}'::jsonb, '{}'::jsonb, '${ORG}');`))).toBe("");
  });
});
