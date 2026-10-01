/**
 * D-092 (migration 0918, fork Hiperbold): sessão sem o segundo fator não grava em
 * `api_tokens` nem em `user_organizations`.
 *
 * A RLS não olhava o nível da sessão (`aal`). Com a senha de um admin com TOTP e a
 * chave pública do projeto, dava para inserir pelo PostgREST o hash de uma chave de
 * API escolhida (acesso que sobrevive à troca de senha) e, sendo admin de plataforma,
 * inserir a si mesmo em `user_organizations` como admin de qualquer empresa. Aqui se
 * prova no Postgres real, como `authenticated`, com o `aal` no JWT:
 *
 *   1. admin com fator TOTP verificado e sessão aal1: insert, update e delete em
 *      `api_tokens` recusados pela RLS;
 *   2. o MESMO admin com aal2: passa (controle positivo: sem ele o caso 1 estaria
 *      verde por a tabela recusar tudo);
 *   3. admin SEM fator cadastrado, sessão aal1: passa (quem nunca cadastrou não é
 *      trancado fora);
 *   4. admin de plataforma full com fator, aal1: não se insere em `user_organizations`;
 *      com aal2 insere (controle positivo);
 *   5. a ponte `fn_session_mfa_proven_rls` não é executável por `anon`.
 *
 * Roda via `pnpm test:db tests/invariants/sessao-aal1-nao-grava-token-e-vinculo.test.ts`.
 */
import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

const ORG = "09180001-a5aa-4000-8000-000000000001";
const ALVO_ORG = "09180001-a5aa-4000-8000-000000000002";
const ADMIN_COM_FATOR = "09180001-b0b0-4000-8000-000000000001";
const ADMIN_SEM_FATOR = "09180001-b0b0-4000-8000-000000000002";
const PLATAFORMA = "09180001-b0b0-4000-8000-000000000003";
const FATOR = "09180001-f0f0-4000-8000-000000000001";
const FATOR_PLATAFORMA = "09180001-f0f0-4000-8000-000000000002";

/** Roda `corpo` como `authenticated`, com o JWT do usuário no nível `aal` dado. */
function como(usuario: string, aal: "aal1" | "aal2", corpo: string): string {
  return sql(`
    set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${usuario}","role":"authenticated","aal":"${aal}"}', false);
    ${corpo}
  `);
}

function tokenSql(org: string, usuario: string, prefixo: string): string {
  return `insert into public.api_tokens (organization_id, created_by, name, prefix, token_hash, scopes)
    values ('${org}', '${usuario}', 'invariante 0918', '${prefixo}', '\\x${"ab".repeat(32)}', '["mcp:read"]'::jsonb)
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
      ('${ADMIN_COM_FATOR}', 'admin-fator-0918@invariant.test'),
      ('${ADMIN_SEM_FATOR}', 'admin-sem-fator-0918@invariant.test'),
      ('${PLATAFORMA}', 'plataforma-0918@invariant.test')
      on conflict (id) do nothing;

    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG}', 'mfa-0918-a', 'MFA 0918 A', 'MFA 0918 A'),
      ('${ALVO_ORG}', 'mfa-0918-b', 'MFA 0918 B', 'MFA 0918 B')
      on conflict (id) do nothing;

    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${ADMIN_COM_FATOR}', '${ORG}', 'admin', now()),
      ('${ADMIN_SEM_FATOR}', '${ORG}', 'admin', now())
      on conflict do nothing;

    insert into public.platform_admins (user_id, granted_by, scope, reason) values
      ('${PLATAFORMA}', '${PLATAFORMA}', 'full', 'invariante 0918')
      on conflict (user_id) do nothing;

    insert into auth.mfa_factors (id, user_id, status, factor_type) values
      ('${FATOR}', '${ADMIN_COM_FATOR}', 'verified', 'totp'),
      ('${FATOR_PLATAFORMA}', '${PLATAFORMA}', 'verified', 'totp')
      on conflict (id) do nothing;
  `);
});

describe("api_tokens: a escrita exige a prova da sessão de quem tem fator", () => {
  it("⭐ admin com fator e sessão aal1: insert recusado pela RLS", () => {
    const motivo = recusadoPorRls(() => como(ADMIN_COM_FATOR, "aal1", tokenSql(ORG, ADMIN_COM_FATOR, "dsk_0918a")));
    expect(motivo, "a sessão aal1 inseriu uma chave de API").toContain("row-level security");
  });

  it("CONTROLE POSITIVO: o mesmo admin com aal2 insere", () => {
    const id = uuidDe(como(ADMIN_COM_FATOR, "aal2", tokenSql(ORG, ADMIN_COM_FATOR, "dsk_0918b")));
    expect(id).not.toBe("");
  });

  it("⭐ update e delete de uma chave existente também são recusados no aal1, e passam no aal2", () => {
    const id = uuidDe(
      como(ADMIN_COM_FATOR, "aal2", tokenSql(ORG, ADMIN_COM_FATOR, `dsk_0918c${randomUUID().slice(0, 4)}`)),
    );
    expect(id).not.toBe("");

    // No aal1 a RLS esconde a escrita: update/delete casam zero linhas ou estouram,
    // e em qualquer dos dois a chave continua do jeito que estava.
    recusadoPorRls(() =>
      como(ADMIN_COM_FATOR, "aal1", `update public.api_tokens set name = 'trocado' where id = '${id}'::uuid;`),
    );
    recusadoPorRls(() => como(ADMIN_COM_FATOR, "aal1", `delete from public.api_tokens where id = '${id}'::uuid;`));
    expect(sql(`select name from public.api_tokens where id = '${id}'::uuid;`)).toBe("invariante 0918");

    como(ADMIN_COM_FATOR, "aal2", `update public.api_tokens set name = 'trocado' where id = '${id}'::uuid;`);
    expect(sql(`select name from public.api_tokens where id = '${id}'::uuid;`)).toBe("trocado");
    como(ADMIN_COM_FATOR, "aal2", `delete from public.api_tokens where id = '${id}'::uuid;`);
    expect(sql(`select count(*) from public.api_tokens where id = '${id}'::uuid;`)).toBe("0");
  });

  it("admin SEM fator cadastrado, sessão aal1: segue gravando (não é trancado fora)", () => {
    const id = uuidDe(como(ADMIN_SEM_FATOR, "aal1", tokenSql(ORG, ADMIN_SEM_FATOR, "dsk_0918d")));
    expect(id).not.toBe("");
  });
});

describe("user_organizations: a auto-inserção como admin exige a prova da sessão", () => {
  const entrar = (aal: "aal1" | "aal2") =>
    como(
      PLATAFORMA,
      aal,
      `insert into public.user_organizations (user_id, organization_id, role, accepted_at)
       values ('${PLATAFORMA}', '${ALVO_ORG}', 'admin', now()) returning role;`,
    );

  it("⭐ admin de plataforma com fator e sessão aal1 não se insere como admin de uma empresa", () => {
    const motivo = recusadoPorRls(() => entrar("aal1"));
    expect(motivo, "a sessão aal1 se inseriu como admin de uma empresa").toContain("row-level security");
    expect(
      sql(`select count(*) from public.user_organizations where user_id = '${PLATAFORMA}'::uuid and organization_id = '${ALVO_ORG}'::uuid;`),
    ).toBe("0");
  });

  it("CONTROLE POSITIVO: com aal2 o mesmo caminho insere", () => {
    expect(entrar("aal2")).toContain("admin");
  });
});

describe("a ponte da prova", () => {
  it("anon não executa fn_session_mfa_proven_rls", () => {
    const motivo = recusadoPorRls(() =>
      sql(`set role anon; select public.fn_session_mfa_proven_rls();`),
    );
    expect(motivo).toContain("permission denied");
  });
});
