import { describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

/**
 * D-084, B1 (migration 0915, fork Hiperbold): `ai_purpose_bindings.base_url` e
 * `credential_id` só são gravados pelo SERVIDOR (conexão direta sem SET ROLE, ou
 * service_role).
 *
 * O defeito: as travas do PUT (régua de destino, exige a chave da empresa,
 * credencial da própria organização) eram puladas por um admin que gravasse
 * direto pelo PostgREST, porque a tabela dá escrita a `authenticated` e a
 * policy só exige admin da organização. Aqui se prova o COMPORTAMENTO, nas
 * sessões que o PostgREST de fato usa: `authenticated` com JWT real e
 * `service_role`.
 *
 * Molde de `uazapi-servidor-so-pelo-servidor.test.ts`: cada caso vive dentro de
 * `begin; ...; rollback;`.
 *
 * Rodar (precisa de Docker, é banco): `pnpm test:db tests/invariants/ai-binding-endereco-e-chave-so-pelo-servidor.test.ts`.
 */

const MARCA = "SONDA|";

const ORG = "d0840001-0000-4000-8000-000000000001";
const OUTRA_ORG = "d0840001-0000-4000-8000-000000000002";
const ADMIN = "d0840001-1111-4000-8000-000000000001";
const CRED = "d0840001-2222-4000-8000-000000000001";
const OUTRA_CRED_DA_ORG = "d0840001-2222-4000-8000-000000000002";
const CRED_DE_OUTRA_ORG = "d0840001-2222-4000-8000-000000000003";
const BINDING_COM_ENDERECO = "d0840001-3333-4000-8000-000000000001";
const BINDING_SEM_ENDERECO = "d0840001-3333-4000-8000-000000000002";

const BASE_LEGITIMA = "https://gateway.exemplo.com/v1";
const BASE_INTERNA = "http://169.254.169.254";
const MENSAGEM = "base_url e credential_id do ponto de IA só podem ser alterados pelo servidor";

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

/**
 * Duas organizações, um admin da primeira, três chaves (duas dela, uma da outra
 * empresa) e dois pontos já gravados pelo servidor: um com endereço próprio e
 * chave, outro sem nenhum dos dois, mas com chave.
 */
function fixture(): string {
  return `
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG}', 'inv-binding-servidor', 'Binding Servidor LTDA', 'Binding Servidor'),
      ('${OUTRA_ORG}', 'inv-binding-outra', 'Binding Outra LTDA', 'Binding Outra')
      on conflict (id) do nothing;
    insert into auth.users (id, email) values ('${ADMIN}', 'admin-binding-servidor@invariant.test')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
      values ('${ADMIN}', '${ORG}', 'admin', now())
      on conflict do nothing;
    insert into public.ai_provider_credentials
      (id, organization_id, provider, label, api_key_encrypted, api_key_iv, api_key_tag, api_key_last4, is_active, validated_at)
      values
      ('${CRED}', '${ORG}', 'openrouter', 'chave da empresa', '\\x00', '\\x00', '\\x00', '1111', true, now()),
      ('${OUTRA_CRED_DA_ORG}', '${ORG}', 'openrouter', 'segunda chave', '\\x00', '\\x00', '\\x00', '2222', true, now()),
      ('${CRED_DE_OUTRA_ORG}', '${OUTRA_ORG}', 'openrouter', 'chave alheia', '\\x00', '\\x00', '\\x00', '3333', true, now());
    insert into public.ai_purpose_bindings
      (id, organization_id, purpose, provider, credential_id, model_id, base_url) values
      ('${BINDING_COM_ENDERECO}', '${ORG}', 'compaction', 'openrouter', '${CRED}', 'modelo-a', '${BASE_LEGITIMA}'),
      ('${BINDING_SEM_ENDERECO}', '${ORG}', 'flush', 'openrouter', '${CRED}', 'modelo-b', null);
    grant select, insert, update, delete on public.ai_purpose_bindings to authenticated;
    grant select, insert, update, delete on public.ai_provider_credentials to authenticated;
  `;
}

const estadoDoBinding = (id: string) =>
  `select 'SONDA|base=' || coalesce(base_url, '(nulo)') || '|cred=' || coalesce(credential_id::text, '(nulo)') || '|modelo=' || model_id from public.ai_purpose_bindings where id = '${id}';`;

describe("ai_purpose_bindings: authenticated admin não grava endereço nem chave", () => {
  it("UPDATE do base_url para um endereço interno é recusado com 42501 e a coluna não muda", () => {
    const erro = erroDe(`
      begin;
      ${fixture()}
      ${comoAdminAuthenticated()}
      update public.ai_purpose_bindings set base_url = '${BASE_INTERNA}' where id = '${BINDING_COM_ENDERECO}';
      rollback;
    `);
    expect(erro, "authenticated admin conseguiu gravar base_url").not.toBeNull();
    expect(erro).toContain(MENSAGEM);

    const linhas = comoServidorDireto(`
      begin;
      ${fixture()}
      ${comoAdminAuthenticated()}
      do $$
      begin
        begin
          update public.ai_purpose_bindings set base_url = '${BASE_INTERNA}' where id = '${BINDING_COM_ENDERECO}';
        exception when insufficient_privilege then
          null;
        end;
      end
      $$;
      reset role;
      ${estadoDoBinding(BINDING_COM_ENDERECO)}
      rollback;
    `);
    expect(linhas).toEqual([`base=${BASE_LEGITIMA}|cred=${CRED}|modelo=modelo-a`]);
  });

  it("UPDATE do base_url para outro endereço qualquer, ou para null, também é recusado", () => {
    for (const valor of [`'https://outro.exemplo.com'`, "null"]) {
      const erro = erroDe(`
        begin;
        ${fixture()}
        ${comoAdminAuthenticated()}
        update public.ai_purpose_bindings set base_url = ${valor} where id = '${BINDING_COM_ENDERECO}';
        rollback;
      `);
      expect(erro, `authenticated admin gravou ${valor}`).not.toBeNull();
      expect(erro).toContain(MENSAGEM);
    }
  });

  it("endereço próprio num ponto que não tinha (pulando o 'exige credencial') é recusado", () => {
    const erro = erroDe(`
      begin;
      ${fixture()}
      ${comoAdminAuthenticated()}
      update public.ai_purpose_bindings set base_url = '${BASE_LEGITIMA}' where id = '${BINDING_SEM_ENDERECO}';
      rollback;
    `);
    expect(erro).not.toBeNull();
    expect(erro).toContain(MENSAGEM);
  });

  it("UPDATE do credential_id para a chave de OUTRA organização é recusado", () => {
    const erro = erroDe(`
      begin;
      ${fixture()}
      ${comoAdminAuthenticated()}
      update public.ai_purpose_bindings set credential_id = '${CRED_DE_OUTRA_ORG}' where id = '${BINDING_SEM_ENDERECO}';
      rollback;
    `);
    expect(erro, "authenticated admin usou a chave de outra empresa").not.toBeNull();
    expect(erro).toContain(MENSAGEM);
  });

  it("UPDATE do credential_id para outra chave, mesmo da própria organização, também é recusado (a rota confere provedor e dono)", () => {
    const erro = erroDe(`
      begin;
      ${fixture()}
      ${comoAdminAuthenticated()}
      update public.ai_purpose_bindings set credential_id = '${OUTRA_CRED_DA_ORG}' where id = '${BINDING_SEM_ENDERECO}';
      rollback;
    `);
    expect(erro).not.toBeNull();
    expect(erro).toContain(MENSAGEM);
  });

  it("INSERT de ponto já com base_url, ou já com credential_id, é recusado", () => {
    for (const colunas of [
      { nomes: "base_url", valores: `'${BASE_INTERNA}'` },
      { nomes: "credential_id", valores: `'${CRED}'` },
      { nomes: "base_url, credential_id", valores: `'${BASE_LEGITIMA}', '${CRED}'` },
    ]) {
      const erro = erroDe(`
        begin;
        ${fixture()}
        ${comoAdminAuthenticated()}
        insert into public.ai_purpose_bindings (organization_id, purpose, provider, model_id, ${colunas.nomes})
          values ('${ORG}', 'sentiment_classify', 'openrouter', 'modelo-c', ${colunas.valores});
        rollback;
      `);
      expect(erro, `authenticated admin criou ponto com ${colunas.nomes}`).not.toBeNull();
      expect(erro).toContain(MENSAGEM);
    }
  });

  it("upsert do PostgREST (insert ... on conflict do update) com as duas colunas também é recusado", () => {
    const erro = erroDe(`
      begin;
      ${fixture()}
      ${comoAdminAuthenticated()}
      insert into public.ai_purpose_bindings (organization_id, purpose, provider, model_id, base_url, credential_id)
        values ('${ORG}', 'compaction', 'openrouter', 'modelo-a', '${BASE_INTERNA}', '${CRED}')
        on conflict (organization_id, purpose) do update
          set base_url = excluded.base_url, credential_id = excluded.credential_id;
      rollback;
    `);
    expect(erro).not.toBeNull();
    expect(erro).toContain(MENSAGEM);
  });

  it("limpar o credential_id de um ponto COM base_url é recusado (ficaria endereço próprio sem a chave da empresa)", () => {
    const erro = erroDe(`
      begin;
      ${fixture()}
      ${comoAdminAuthenticated()}
      update public.ai_purpose_bindings set credential_id = null where id = '${BINDING_COM_ENDERECO}';
      rollback;
    `);
    expect(erro).not.toBeNull();
    expect(erro).toContain(MENSAGEM);
  });
});

describe("ai_purpose_bindings: o que continua passando para o admin", () => {
  it("trocar modelo e ligar/desligar o ponto, sem tocar nas duas colunas, e repetir o mesmo valor", () => {
    const linhas = comoServidorDireto(`
      begin;
      ${fixture()}
      ${comoAdminAuthenticated()}
      update public.ai_purpose_bindings set model_id = 'modelo-novo', is_enabled = false where id = '${BINDING_COM_ENDERECO}';
      -- Mesmo valor nas colunas vigiadas: não é mudança, passa.
      update public.ai_purpose_bindings set base_url = base_url, credential_id = credential_id where id = '${BINDING_COM_ENDERECO}';
      reset role;
      ${estadoDoBinding(BINDING_COM_ENDERECO)}
      rollback;
    `);
    expect(linhas).toEqual([`base=${BASE_LEGITIMA}|cred=${CRED}|modelo=modelo-novo`]);
  });

  it("criar ponto sem endereço e sem chave, e limpar a chave de um ponto sem endereço", () => {
    const linhas = comoServidorDireto(`
      begin;
      ${fixture()}
      ${comoAdminAuthenticated()}
      insert into public.ai_purpose_bindings (id, organization_id, purpose, provider, model_id)
        values ('d0840001-3333-4000-8000-000000000009', '${ORG}', 'sentiment_classify', 'openrouter', 'modelo-c');
      update public.ai_purpose_bindings set credential_id = null where id = '${BINDING_SEM_ENDERECO}';
      reset role;
      select 'SONDA|novo=' || count(*) from public.ai_purpose_bindings where id = 'd0840001-3333-4000-8000-000000000009';
      ${estadoDoBinding(BINDING_SEM_ENDERECO)}
      rollback;
    `);
    expect(linhas).toEqual(["novo=1", "base=(nulo)|cred=(nulo)|modelo=modelo-b"]);
  });

  it("apagar a chave (FK on delete set null, 0141) continua funcionando e desvincula o ponto, também pela sessão do admin", () => {
    const linhas = comoServidorDireto(`
      begin;
      ${fixture()}
      update public.ai_purpose_bindings set base_url = null where id = '${BINDING_COM_ENDERECO}';
      ${comoAdminAuthenticated()}
      delete from public.ai_provider_credentials where id = '${CRED}';
      reset role;
      ${estadoDoBinding(BINDING_COM_ENDERECO)}
      ${estadoDoBinding(BINDING_SEM_ENDERECO)}
      rollback;
    `);
    expect(linhas).toEqual([
      "base=(nulo)|cred=(nulo)|modelo=modelo-a",
      "base=(nulo)|cred=(nulo)|modelo=modelo-b",
    ]);
  });
});

describe("ai_purpose_bindings: o servidor grava", () => {
  it("service_role cria e troca endereço e chave (o PUT da rota), inclusive por upsert", () => {
    const linhas = comoServidorDireto(`
      begin;
      ${fixture()}
      set role service_role;
      update public.ai_purpose_bindings
        set base_url = 'https://novo.exemplo.com/v1', credential_id = '${OUTRA_CRED_DA_ORG}'
        where id = '${BINDING_COM_ENDERECO}';
      insert into public.ai_purpose_bindings (organization_id, purpose, provider, model_id, base_url, credential_id)
        values ('${ORG}', 'flush', 'openrouter', 'modelo-b', 'https://segundo.exemplo.com/v1', '${OUTRA_CRED_DA_ORG}')
        on conflict (organization_id, purpose) do update
          set base_url = excluded.base_url, credential_id = excluded.credential_id;
      reset role;
      ${estadoDoBinding(BINDING_COM_ENDERECO)}
      ${estadoDoBinding(BINDING_SEM_ENDERECO)}
      rollback;
    `);
    expect(linhas).toEqual([
      `base=https://novo.exemplo.com/v1|cred=${OUTRA_CRED_DA_ORG}|modelo=modelo-a`,
      `base=https://segundo.exemplo.com/v1|cred=${OUTRA_CRED_DA_ORG}|modelo=modelo-b`,
    ]);
  });

  it("conexão direta como postgres (migração, worker) também grava", () => {
    const linhas = comoServidorDireto(`
      begin;
      ${fixture()}
      update public.ai_purpose_bindings set base_url = 'https://migrado.exemplo.com/v1' where id = '${BINDING_COM_ENDERECO}';
      ${estadoDoBinding(BINDING_COM_ENDERECO)}
      rollback;
    `);
    expect(linhas).toEqual([`base=https://migrado.exemplo.com/v1|cred=${CRED}|modelo=modelo-a`]);
  });
});
