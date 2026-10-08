/**
 * D-092, 2a parte (migration 0950, fork Hiperbold): a sessão sem o segundo fator (aal1) de quem TEM
 * fator verificado não troca o que a IA e o robô mandam ao cliente final.
 *
 * As actions de agente exigem o segundo fator só no servidor; as políticas de `ai_agents`,
 * `ai_agent_versions`, do roteador, do conhecimento, dos guardrails, das automações, dos modelos de
 * mensagem e dos fluxos de follow-up eram `for all` por papel, sem olhar o nível da sessão. Quem tinha a
 * senha de um admin com TOTP reescrevia o prompt do agente direto no PostgREST. Aqui se prova no Postgres
 * real, como `authenticated`, com o `aal` no JWT:
 *
 *   1. as 14 tabelas têm as três políticas RESTRICTIVE (insert, update, delete) para `authenticated`,
 *      pela ponte da prova de sessão, e nenhuma é de SELECT;
 *   2. admin com fator e sessão aal1: insert, update e delete em `ai_agents` recusados; com aal2 passam;
 *   3. o mesmo para `org_guardrail_layers`, `automation_rules` e `message_templates`;
 *   4. admin SEM fator, sessão aal1: passa (quem nunca cadastrou não é trancado fora);
 *   5. a LEITURA não muda: o admin com fator em aal1 segue lendo os agentes;
 *   6. execução de um fluxo já publicado (`followup_enrollments`) NÃO entra na trava, de propósito.
 *
 * Roda via `pnpm test:db tests/invariants/sessao-aal1-agente-roteador-conhecimento.test.ts`.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

const TABELAS = [
  "ai_agents",
  "ai_agent_versions",
  "ai_routers",
  "ai_router_members",
  "ai_budgets",
  "ai_knowledge_sources",
  "ai_faq_items",
  "ai_chunks",
  "ai_knowledge_versions",
  "org_guardrail_layers",
  "automation_rules",
  "message_templates",
  "followup_flow_pointers",
  "followup_flow_versions",
] as const;

const ORG = "09500001-a5aa-4000-8000-000000000001";
const ADMIN_COM_FATOR = "09500001-b0b0-4000-8000-000000000001";
const ADMIN_SEM_FATOR = "09500001-b0b0-4000-8000-000000000002";
const FATOR = "09500001-f0f0-4000-8000-000000000001";
const AGENTE = "09500001-c0c0-4000-8000-000000000001";
const AGENTE_ALHEIO = "09500001-c0c0-4000-8000-000000000002";

/** Roda `corpo` como `authenticated`, com o JWT do usuário no nível `aal` dado. */
function como(usuario: string, aal: "aal1" | "aal2", corpo: string): string {
  return sql(`
    set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${usuario}","role":"authenticated","aal":"${aal}"}', false);
    ${corpo}
  `);
}

/** Roda e devolve a mensagem do erro, ou "" se não houve erro. */
function recusadoPorRls(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return motivoDoErro(err);
  }
  return "";
}

const agenteSql = (id: string, nome: string) =>
  `insert into public.ai_agents (id, organization_id, name, system_prompt)
   values ('${id}'::uuid, '${ORG}'::uuid, '${nome}', 'Prompt original') returning id;`;

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${ADMIN_COM_FATOR}', 'admin-fator-0950@invariant.test'),
      ('${ADMIN_SEM_FATOR}', 'admin-sem-fator-0950@invariant.test')
      on conflict (id) do nothing;

    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG}', 'mfa-0950-a', 'MFA 0950 A', 'MFA 0950 A')
      on conflict (id) do nothing;

    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${ADMIN_COM_FATOR}', '${ORG}', 'admin', now()),
      ('${ADMIN_SEM_FATOR}', '${ORG}', 'admin', now())
      on conflict do nothing;

    insert into auth.mfa_factors (id, user_id, status, factor_type) values
      ('${FATOR}', '${ADMIN_COM_FATOR}', 'verified', 'totp')
      on conflict (id) do nothing;

    -- Linhas semeadas pelo dono do banco (fora da RLS) para os update/delete tentarem alcançar.
    insert into public.ai_agents (id, organization_id, name, system_prompt) values
      ('${AGENTE}', '${ORG}', 'Agente semeado', 'Prompt original')
      on conflict (id) do nothing;
  `);
});

describe("as quatorze tabelas têm as três políticas restritivas da prova de sessão", () => {
  for (const tabela of TABELAS) {
    it(`${tabela}: insert, update e delete, RESTRICTIVE, só authenticated, pela ponte`, () => {
      const linhas = sql(`
        select cmd || '|' || permissive || '|' || roles::text || '|' ||
               (coalesce(qual, '') || coalesce(with_check, '') like '%fn_session_mfa_proven_rls%')::text
          from pg_policies
         where schemaname = 'public' and tablename = '${tabela}' and policyname like '${tabela}\\_mfa\\_%'
         order by cmd;
      `).split("\n");
      expect(linhas).toEqual([
        "DELETE|RESTRICTIVE|{authenticated}|true",
        "INSERT|RESTRICTIVE|{authenticated}|true",
        "UPDATE|RESTRICTIVE|{authenticated}|true",
      ]);
    });
  }

  it("execução de fluxo e telemetria ficam de fora, de propósito: sem política _mfa_", () => {
    const fora = sql(`
      select count(*) from pg_policies
       where schemaname = 'public' and policyname ~ '_mfa_'
         and tablename in ('followup_enrollments', 'followup_enrollment_events', 'ai_router_decisions',
                           'automation_rule_runs', 'agent_cases', 'knowledge_searches');
    `);
    expect(fora).toBe("0");
  });

  it("nenhuma política nova é de SELECT: a leitura não muda", () => {
    const leitura = sql(`
      select count(*) from pg_policies
       where schemaname = 'public' and policyname ~ '_mfa_' and cmd in ('SELECT', 'ALL');
    `);
    expect(leitura).toBe("0");
  });
});

describe("ai_agents: reescrever o prompt do agente exige a prova da sessão de quem tem fator", () => {
  it("⭐ admin com fator e sessão aal1: insert recusado pela RLS", () => {
    const motivo = recusadoPorRls(() => como(ADMIN_COM_FATOR, "aal1", agenteSql(AGENTE_ALHEIO, "Agente do aal1")));
    expect(motivo, "a sessão aal1 criou um agente").toContain("row-level security");
    expect(sql(`select count(*) from public.ai_agents where id = '${AGENTE_ALHEIO}'::uuid;`)).toBe("0");
  });

  it("⭐ update e delete no aal1 não alcançam o agente: o prompt segue o original", () => {
    recusadoPorRls(() =>
      como(ADMIN_COM_FATOR, "aal1", `update public.ai_agents set system_prompt = 'TROCADO' where id = '${AGENTE}'::uuid;`),
    );
    recusadoPorRls(() => como(ADMIN_COM_FATOR, "aal1", `delete from public.ai_agents where id = '${AGENTE}'::uuid;`));
    expect(sql(`select system_prompt from public.ai_agents where id = '${AGENTE}'::uuid;`)).toBe("Prompt original");
  });

  it("CONTROLE POSITIVO: o mesmo admin com aal2 insere, altera e apaga", () => {
    como(ADMIN_COM_FATOR, "aal2", agenteSql(AGENTE_ALHEIO, "Agente do aal2"));
    expect(sql(`select count(*) from public.ai_agents where id = '${AGENTE_ALHEIO}'::uuid;`)).toBe("1");
    como(ADMIN_COM_FATOR, "aal2", `update public.ai_agents set system_prompt = 'NOVO' where id = '${AGENTE_ALHEIO}'::uuid;`);
    expect(sql(`select system_prompt from public.ai_agents where id = '${AGENTE_ALHEIO}'::uuid;`)).toBe("NOVO");
    como(ADMIN_COM_FATOR, "aal2", `delete from public.ai_agents where id = '${AGENTE_ALHEIO}'::uuid;`);
    expect(sql(`select count(*) from public.ai_agents where id = '${AGENTE_ALHEIO}'::uuid;`)).toBe("0");
  });

  it("admin SEM fator cadastrado, sessão aal1: segue escrevendo (não é trancado fora)", () => {
    const id = "09500001-c0c0-4000-8000-0000000000aa";
    como(ADMIN_SEM_FATOR, "aal1", agenteSql(id, "Agente sem fator"));
    expect(sql(`select count(*) from public.ai_agents where id = '${id}'::uuid;`)).toBe("1");
  });

  it("a leitura não muda: o admin com fator em aal1 segue lendo os agentes da empresa", () => {
    const lidos = como(
      ADMIN_COM_FATOR,
      "aal1",
      `select count(*) from public.ai_agents where organization_id = '${ORG}'::uuid;`,
    );
    expect(Number(lidos.split("\n").pop())).toBeGreaterThan(0);
  });
});

describe("guardrail, automação e modelo de mensagem: a mesma trava", () => {
  const casos = [
    {
      tabela: "org_guardrail_layers",
      inserir: `insert into public.org_guardrail_layers (organization_id, layer, enabled) values ('${ORG}'::uuid, 'camada-%S', false)`,
      contar: `select count(*) from public.org_guardrail_layers where organization_id = '${ORG}'::uuid and layer = 'camada-%S'`,
    },
    {
      tabela: "automation_rules",
      inserir: `insert into public.automation_rules (organization_id, name, trigger_event) values ('${ORG}'::uuid, 'regra-%S', 'message.received')`,
      contar: `select count(*) from public.automation_rules where organization_id = '${ORG}'::uuid and name = 'regra-%S'`,
    },
    {
      tabela: "message_templates",
      inserir: `insert into public.message_templates (organization_id, title, body) values ('${ORG}'::uuid, 'modelo-%S', 'texto')`,
      contar: `select count(*) from public.message_templates where organization_id = '${ORG}'::uuid and title = 'modelo-%S'`,
    },
  ];

  for (const caso of casos) {
    it(`⭐ ${caso.tabela}: o aal1 de quem tem fator não insere; o aal2 e quem não tem fator inserem`, () => {
      const motivo = recusadoPorRls(() => como(ADMIN_COM_FATOR, "aal1", `${caso.inserir.replaceAll("%S", "aal1")};`));
      expect(motivo, `a sessão aal1 escreveu em ${caso.tabela}`).toContain("row-level security");
      expect(sql(`${caso.contar.replaceAll("%S", "aal1")};`)).toBe("0");

      como(ADMIN_COM_FATOR, "aal2", `${caso.inserir.replaceAll("%S", "aal2")};`);
      expect(sql(`${caso.contar.replaceAll("%S", "aal2")};`)).toBe("1");

      como(ADMIN_SEM_FATOR, "aal1", `${caso.inserir.replaceAll("%S", "semfator")};`);
      expect(sql(`${caso.contar.replaceAll("%S", "semfator")};`)).toBe("1");
    });
  }

  it("⭐ automation_rules: o aal1 não liga nem apaga uma regra existente; o aal2 liga", () => {
    const regra = sql(`select id from public.automation_rules where name = 'regra-aal2' and organization_id = '${ORG}'::uuid;`);
    expect(regra).not.toBe("");
    recusadoPorRls(() =>
      como(ADMIN_COM_FATOR, "aal1", `update public.automation_rules set is_active = true where id = '${regra}'::uuid;`),
    );
    recusadoPorRls(() => como(ADMIN_COM_FATOR, "aal1", `delete from public.automation_rules where id = '${regra}'::uuid;`));
    expect(sql(`select is_active::text from public.automation_rules where id = '${regra}'::uuid;`)).toBe("false");

    como(ADMIN_COM_FATOR, "aal2", `update public.automation_rules set is_active = true where id = '${regra}'::uuid;`);
    expect(sql(`select is_active::text from public.automation_rules where id = '${regra}'::uuid;`)).toBe("true");
  });
});
