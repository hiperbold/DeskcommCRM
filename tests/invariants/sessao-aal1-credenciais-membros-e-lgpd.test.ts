/**
 * D-092 (migration 0949, fork Hiperbold): a sessão sem o segundo fator (aal1) de quem
 * TEM fator verificado também não grava nas tabelas de credencial, de convite, de
 * recuperação de acesso e de LGPD, nem na própria empresa.
 *
 * A 0918 fechou `api_tokens` e `user_organizations`. As demais tabelas de maior risco
 * seguiam graváveis pelo PostgREST com a chave pública do projeto e uma sessão só com
 * senha: trocar a chave de IA ou o token de uma conexão, convidar um admin, gravar
 * códigos de recuperação que o atacante conhece, mexer em pedido de LGPD. Aqui se prova
 * no Postgres real, como `authenticated`, com o `aal` no JWT:
 *
 *   1. as 12 tabelas têm as três políticas RESTRICTIVE (insert, update, delete) para
 *      `authenticated`, apontando para a ponte da prova de sessão;
 *   2. admin com fator e sessão aal1: insert, update e delete em `team_invites`
 *      recusados; o mesmo admin com aal2 passa (controle positivo);
 *   3. admin SEM fator, sessão aal1: passa (quem nunca cadastrou não é trancado fora);
 *   4. admin de plataforma full com fator, aal1: não altera `organizations`; com aal2 altera;
 *   5. a LEITURA não muda: o admin com fator em aal1 segue lendo `team_invites`.
 *
 * Roda via `pnpm test:db tests/invariants/sessao-aal1-credenciais-membros-e-lgpd.test.ts`.
 */
import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

const TABELAS = [
  "ai_provider_credentials",
  "ai_purpose_bindings",
  "calendar_connections",
  "channel_sessions",
  "external_db_connections",
  "lgpd_requests",
  "organizations",
  "team_invites",
  "tenant_integrations",
  "user_recovery_codes",
  "voip_trunk_settings",
  "webhook_sources",
] as const;

const ORG = "09490001-a5aa-4000-8000-000000000001";
const ADMIN_COM_FATOR = "09490001-b0b0-4000-8000-000000000001";
const ADMIN_SEM_FATOR = "09490001-b0b0-4000-8000-000000000002";
const PLATAFORMA = "09490001-b0b0-4000-8000-000000000003";
const FATOR = "09490001-f0f0-4000-8000-000000000001";
const FATOR_PLATAFORMA = "09490001-f0f0-4000-8000-000000000002";

/** Roda `corpo` como `authenticated`, com o JWT do usuário no nível `aal` dado. */
function como(usuario: string, aal: "aal1" | "aal2", corpo: string): string {
  return sql(`
    set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${usuario}","role":"authenticated","aal":"${aal}"}', false);
    ${corpo}
  `);
}

function conviteSql(email: string): string {
  return `insert into public.team_invites (organization_id, email, role, invited_by, expires_at)
    values ('${ORG}', '${email}', 'viewer', null, now() + interval '7 days')
    returning id;`;
}

/** O uuid devolvido pelo `returning id` no meio da saída do psql (SET, config, tag do comando). */
function uuidDe(saida: string): string {
  const achados = saida.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g);
  return achados?.[achados.length - 1] ?? "";
}

function recusadoPorRls(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return motivoDoErro(err);
  }
  return "";
}

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${ADMIN_COM_FATOR}', 'admin-fator-0949@invariant.test'),
      ('${ADMIN_SEM_FATOR}', 'admin-sem-fator-0949@invariant.test'),
      ('${PLATAFORMA}', 'plataforma-0949@invariant.test')
      on conflict (id) do nothing;

    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG}', 'mfa-0949-a', 'MFA 0949 A', 'MFA 0949 A')
      on conflict (id) do nothing;

    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${ADMIN_COM_FATOR}', '${ORG}', 'admin', now()),
      ('${ADMIN_SEM_FATOR}', '${ORG}', 'admin', now())
      on conflict do nothing;

    insert into public.platform_admins (user_id, granted_by, scope, reason) values
      ('${PLATAFORMA}', '${PLATAFORMA}', 'full', 'invariante 0949')
      on conflict (user_id) do nothing;

    insert into auth.mfa_factors (id, user_id, status, factor_type) values
      ('${FATOR}', '${ADMIN_COM_FATOR}', 'verified', 'totp'),
      ('${FATOR_PLATAFORMA}', '${PLATAFORMA}', 'verified', 'totp')
      on conflict (id) do nothing;
  `);
});

describe("as doze tabelas têm as três políticas restritivas da prova de sessão", () => {
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

  it("nenhuma política nova é de SELECT: a leitura não muda", () => {
    const leitura = sql(`
      select count(*) from pg_policies
       where schemaname = 'public' and policyname ~ '_mfa_' and cmd in ('SELECT', 'ALL');
    `);
    expect(leitura).toBe("0");
  });
});

describe("team_invites: a escrita exige a prova da sessão de quem tem fator", () => {
  it("⭐ admin com fator e sessão aal1: insert recusado pela RLS", () => {
    const motivo = recusadoPorRls(() => como(ADMIN_COM_FATOR, "aal1", conviteSql("aal1-0949@invariant.test")));
    expect(motivo, "a sessão aal1 criou um convite").toContain("row-level security");
  });

  it("CONTROLE POSITIVO: o mesmo admin com aal2 insere", () => {
    const id = uuidDe(como(ADMIN_COM_FATOR, "aal2", conviteSql("aal2-0949@invariant.test")));
    expect(id).not.toBe("");
  });

  it("⭐ update e delete de um convite existente são recusados no aal1 e passam no aal2", () => {
    const id = uuidDe(
      como(ADMIN_COM_FATOR, "aal2", conviteSql(`ud-${randomUUID().slice(0, 8)}-0949@invariant.test`)),
    );
    expect(id).not.toBe("");

    // No aal1 a RLS esconde a escrita: update/delete casam zero linhas ou estouram, e
    // em qualquer dos dois o convite segue do jeito que estava.
    recusadoPorRls(() =>
      como(ADMIN_COM_FATOR, "aal1", `update public.team_invites set role = 'admin' where id = '${id}'::uuid;`),
    );
    recusadoPorRls(() => como(ADMIN_COM_FATOR, "aal1", `delete from public.team_invites where id = '${id}'::uuid;`));
    expect(sql(`select role from public.team_invites where id = '${id}'::uuid;`)).toBe("viewer");

    como(ADMIN_COM_FATOR, "aal2", `update public.team_invites set role = 'admin' where id = '${id}'::uuid;`);
    expect(sql(`select role from public.team_invites where id = '${id}'::uuid;`)).toBe("admin");
    como(ADMIN_COM_FATOR, "aal2", `delete from public.team_invites where id = '${id}'::uuid;`);
    expect(sql(`select count(*) from public.team_invites where id = '${id}'::uuid;`)).toBe("0");
  });

  it("admin SEM fator cadastrado, sessão aal1: segue convidando (não é trancado fora)", () => {
    const id = uuidDe(como(ADMIN_SEM_FATOR, "aal1", conviteSql("sem-fator-0949@invariant.test")));
    expect(id).not.toBe("");
  });

  it("a leitura não muda: o admin com fator em aal1 segue lendo os convites da empresa", () => {
    const lidos = como(
      ADMIN_COM_FATOR,
      "aal1",
      `select count(*) from public.team_invites where organization_id = '${ORG}'::uuid;`,
    );
    expect(Number(lidos.split("\n").pop())).toBeGreaterThan(0);
  });
});

describe("organizations: o admin de plataforma com fator só altera a empresa com a prova da sessão", () => {
  const renomear = (aal: "aal1" | "aal2", nome: string) =>
    como(
      PLATAFORMA,
      aal,
      `update public.organizations set display_name = '${nome}' where id = '${ORG}'::uuid;`,
    );

  it("⭐ aal1: a alteração não acontece", () => {
    recusadoPorRls(() => renomear("aal1", "Trocada no aal1"));
    expect(sql(`select display_name from public.organizations where id = '${ORG}'::uuid;`)).toBe("MFA 0949 A");
  });

  it("CONTROLE POSITIVO: com aal2 a alteração acontece", () => {
    renomear("aal2", "Trocada no aal2");
    expect(sql(`select display_name from public.organizations where id = '${ORG}'::uuid;`)).toBe("Trocada no aal2");
  });
});
