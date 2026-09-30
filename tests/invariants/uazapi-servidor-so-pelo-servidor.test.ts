import { describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

/**
 * D-083, achado 4 (migration 0914, fork Hiperbold): `channel_sessions.uazapi_base_url`
 * só é gravado pelo SERVIDOR (conexão direta sem SET ROLE, ou service_role).
 *
 * O defeito: a coluna era conferida só no cadastro, mas a tabela tem GRANT ALL a
 * `authenticated` e a policy de escrita só exige admin da organização. O admin
 * gravava o endereço direto pelo PostgREST e apontava a conexão para a rede
 * interna, pulando a validação. Aqui se prova o COMPORTAMENTO, nas sessões que
 * o PostgREST de fato usa: `authenticated` com JWT real e `service_role`.
 *
 * Molde de `planos-bloqueio-membros.test.ts`: cada caso vive dentro de
 * `begin; ...; rollback;`.
 *
 * Rodar (precisa de Docker, é banco): `pnpm test:db tests/invariants/uazapi-servidor-so-pelo-servidor.test.ts`.
 */

const MARCA = "SONDA|";

const ORG = "d0830001-0000-4000-8000-000000000001";
const ADMIN = "d0830001-1111-4000-8000-000000000001";
const SESSAO_UAZAPI = "d0830001-2222-4000-8000-000000000001";
const SESSAO_OUTRA = "d0830001-2222-4000-8000-000000000002";

const BASE_LEGITIMA = "https://empresa.uazapi.com";
const BASE_INTERNA = "http://169.254.169.254";
const MENSAGEM = "uazapi_base_url só pode ser alterado pelo servidor";

function linhasMarcadas(saida: string): string[] {
  return saida
    .split("\n")
    .filter((linha) => linha.startsWith(MARCA))
    .map((linha) => linha.slice(MARCA.length));
}

/** Roda como o papel da sessão do container (`postgres`, superusuário: sem SET ROLE). */
function comoServidorDireto(corpo: string): string[] {
  return linhasMarcadas(sql(corpo));
}

/** authenticated com JWT real (o mesmo prefixo dos outros invariantes de RLS). */
function comoAdminAuthenticated(): string {
  return `set role authenticated;\nselect set_config('request.jwt.claims', '{"sub":"${ADMIN}"}', false);`;
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

/** Uma organização, um admin dela e uma conexão UAZAPI já gravada pelo servidor. */
function fixture(): string {
  return `
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG}', 'inv-uazapi-servidor', 'Uazapi Servidor LTDA', 'Uazapi Servidor')
      on conflict (id) do nothing;
    insert into auth.users (id, email) values ('${ADMIN}', 'admin-uazapi-servidor@invariant.test')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
      values ('${ADMIN}', '${ORG}', 'admin', now())
      on conflict do nothing;
    insert into public.channel_sessions
      (id, organization_id, provider, uazapi_instance_id, uazapi_base_url, webhook_secret_encrypted, display_name)
      values ('${SESSAO_UAZAPI}', '${ORG}', 'uazapi', 'inv-uazapi-1', '${BASE_LEGITIMA}', '\\x00'::bytea, 'Conexão');
  `;
}

const baseGravada = `select 'SONDA|base=' || uazapi_base_url from public.channel_sessions where id = '${SESSAO_UAZAPI}';`;

describe("channel_sessions.uazapi_base_url: authenticated admin não grava", () => {
  it("UPDATE para um endereço interno é recusado com 42501 e a coluna não muda", () => {
    const erro = erroDe(`
      begin;
      ${fixture()}
      ${comoAdminAuthenticated()}
      update public.channel_sessions set uazapi_base_url = '${BASE_INTERNA}' where id = '${SESSAO_UAZAPI}';
      rollback;
    `);
    expect(erro, "authenticated admin conseguiu gravar uazapi_base_url").not.toBeNull();
    expect(erro).toContain(MENSAGEM);

    // O valor segue o do servidor: o erro derruba o comando, mas a prova de que a
    // coluna não mudou é lida na mesma sessão, depois de engolir o erro.
    const linhas = comoServidorDireto(`
      begin;
      ${fixture()}
      ${comoAdminAuthenticated()}
      do $$
      begin
        begin
          update public.channel_sessions set uazapi_base_url = '${BASE_INTERNA}' where id = '${SESSAO_UAZAPI}';
        exception when insufficient_privilege then
          null;
        end;
      end
      $$;
      reset role;
      ${baseGravada}
      rollback;
    `);
    expect(linhas).toEqual([`base=${BASE_LEGITIMA}`]);
  });

  it("UPDATE para outro endereço qualquer, ou para null, também é recusado", () => {
    for (const valor of [`'https://outro.uazapi.com'`, "null"]) {
      const erro = erroDe(`
        begin;
        ${fixture()}
        ${comoAdminAuthenticated()}
        update public.channel_sessions set uazapi_base_url = ${valor} where id = '${SESSAO_UAZAPI}';
        rollback;
      `);
      expect(erro, `authenticated admin gravou ${valor}`).not.toBeNull();
      expect(erro).toContain(MENSAGEM);
    }
  });

  it("INSERT de conexão já com uazapi_base_url é recusado", () => {
    const erro = erroDe(`
      begin;
      ${fixture()}
      ${comoAdminAuthenticated()}
      insert into public.channel_sessions
        (organization_id, provider, uazapi_instance_id, uazapi_base_url, webhook_secret_encrypted)
        values ('${ORG}', 'uazapi', 'inv-uazapi-2', '${BASE_INTERNA}', '\\x00'::bytea);
      rollback;
    `);
    expect(erro, "authenticated admin criou conexão com uazapi_base_url").not.toBeNull();
    expect(erro).toContain(MENSAGEM);
  });

  it("não atrapalha o resto: o admin ainda edita as outras colunas e cria canal sem uazapi_base_url", () => {
    const linhas = comoServidorDireto(`
      begin;
      ${fixture()}
      ${comoAdminAuthenticated()}
      update public.channel_sessions set display_name = 'Renomeada' where id = '${SESSAO_UAZAPI}';
      -- Mesmo valor na coluna vigiada: não é mudança, passa.
      update public.channel_sessions set uazapi_base_url = uazapi_base_url where id = '${SESSAO_UAZAPI}';
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
        values ('${SESSAO_OUTRA}', '${ORG}', 'inv-uazapi-outra', '\\x00'::bytea);
      reset role;
      select 'SONDA|nome=' || display_name || '|base=' || uazapi_base_url from public.channel_sessions where id = '${SESSAO_UAZAPI}';
      select 'SONDA|outra=' || count(*) from public.channel_sessions where id = '${SESSAO_OUTRA}';
      rollback;
    `);
    expect(linhas).toEqual([`nome=Renomeada|base=${BASE_LEGITIMA}`, "outra=1"]);
  });
});

describe("channel_sessions.uazapi_base_url: o servidor grava", () => {
  it("service_role cria e troca o endereço (o cadastro legítimo, salvarConexaoUazapi)", () => {
    const linhas = comoServidorDireto(`
      begin;
      ${fixture()}
      set role service_role;
      update public.channel_sessions set uazapi_base_url = 'https://novo.uazapi.com' where id = '${SESSAO_UAZAPI}';
      insert into public.channel_sessions
        (id, organization_id, provider, uazapi_instance_id, uazapi_base_url, webhook_secret_encrypted)
        values ('${SESSAO_OUTRA}', '${ORG}', 'uazapi', 'inv-uazapi-2', 'https://segundo.uazapi.com', '\\x00'::bytea);
      reset role;
      select 'SONDA|base=' || uazapi_base_url from public.channel_sessions where id = '${SESSAO_UAZAPI}';
      select 'SONDA|segunda=' || uazapi_base_url from public.channel_sessions where id = '${SESSAO_OUTRA}';
      rollback;
    `);
    expect(linhas).toEqual(["base=https://novo.uazapi.com", "segunda=https://segundo.uazapi.com"]);
  });

  it("conexão direta como postgres (migração, worker) também grava", () => {
    const linhas = comoServidorDireto(`
      begin;
      ${fixture()}
      update public.channel_sessions set uazapi_base_url = 'https://migrado.uazapi.com' where id = '${SESSAO_UAZAPI}';
      ${baseGravada}
      rollback;
    `);
    expect(linhas).toEqual(["base=https://migrado.uazapi.com"]);
  });
});
