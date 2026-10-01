/**
 * Migration 0922 (D-143, fork Hiperbold): mesclar contatos não apaga o opt-out.
 *
 * O contato B pede para sair (`is_blocked`), um gerente mescla B em A, e A herda o
 * telefone de B. Antes, A ficava `is_blocked = false` e a IA, a campanha e a prospecção
 * voltavam a escrever para quem pediu opt-out. Provado no Postgres real, executando
 * `fn_mesclar_contatos`.
 *
 * Roda via `pnpm test:db tests/invariants/mesclar-contatos-leva-a-restricao.test.ts`.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { sql } from "./psql-transporte";

const ORG = "09220000-0000-4000-8000-00000000000a";

function id(grupo: number, n: number): string {
  return `0922${String(grupo).padStart(4, "0")}-0000-4000-8000-00000000000${n}`;
}

function mesclar(principal: string, secundarios: string[]): void {
  sql(
    `select public.fn_mesclar_contatos('${ORG}', '${principal}', array[${secundarios.map((s) => `'${s}'::uuid`).join(",")}]);`,
  );
}

function linha(contato: string): string {
  return sql(`
    select is_blocked || '|' || force_human || '|' || coalesce(blocked_reason, '-') || '|' ||
           (blocked_at is not null) || '|' || coalesce(phone_number, '-')
      from public.contacts where id = '${contato}';
  `);
}

beforeAll(() => {
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG}', 'mescla-0922', 'Mescla 0922', 'Mescla 0922');
  `);
});

describe("0922: a mesclagem leva a restrição do contato que sai", () => {
  it("opt-out do secundário bloqueia o principal, com o motivo e o carimbo dele", () => {
    const [a, b] = [id(1, 1), id(1, 2)];
    sql(`
      insert into public.contacts (id, organization_id, name) values ('${a}', '${ORG}', 'Ana');
      insert into public.contacts (id, organization_id, name, phone_number, is_blocked, blocked_reason, blocked_at)
        values ('${b}', '${ORG}', 'Ana B', '+5511900009221', true, 'pediu para sair', now() - interval '2 days');
    `);
    // Controle: sem a mesclagem, A não está bloqueado.
    expect(linha(a).startsWith("false|false")).toBe(true);

    mesclar(a, [b]);

    // O telefone foi herdado (o cenário do defeito) E o bloqueio veio junto.
    expect(linha(a)).toBe("true|false|pediu para sair|true|+5511900009221");
    expect(
      sql(`select blocked_at < now() - interval '1 day' from public.contacts where id = '${a}';`),
    ).toBe("t");
  });

  it("force_human do secundário vale no principal", () => {
    const [a, b] = [id(2, 1), id(2, 2)];
    sql(`
      insert into public.contacts (id, organization_id, name) values ('${a}', '${ORG}', 'Bia');
      insert into public.contacts (id, organization_id, name, force_human) values ('${b}', '${ORG}', 'Bia B', true);
    `);
    mesclar(a, [b]);
    expect(linha(a).startsWith("false|true|")).toBe(true);
  });

  it("principal já bloqueado mantém o próprio motivo e carimbo", () => {
    const [a, b] = [id(3, 1), id(3, 2)];
    sql(`
      insert into public.contacts (id, organization_id, name, is_blocked, blocked_reason, blocked_at)
        values ('${a}', '${ORG}', 'Caio', true, 'motivo do principal', now() - interval '10 days');
      insert into public.contacts (id, organization_id, name, is_blocked, blocked_reason, blocked_at)
        values ('${b}', '${ORG}', 'Caio B', true, 'motivo do secundario', now() - interval '1 day');
    `);
    mesclar(a, [b]);
    expect(linha(a).startsWith("true|false|motivo do principal|true|")).toBe(true);
  });

  it("recusa de consentimento do secundário vale (false ou revoked_at); concessão NÃO é herdada", () => {
    const [a, b] = [id(4, 1), id(4, 2)];
    sql(`
      insert into public.contacts (id, organization_id, name, consent)
        values ('${a}', '${ORG}', 'Dani', '{"marketing": true, "terms": true}'::jsonb);
      insert into public.contacts (id, organization_id, name, consent)
        values ('${b}', '${ORG}', 'Dani B', '{"marketing": false, "newsletter": true, "profiling": {"granted_at": "2026-01-01", "revoked_at": "2026-02-01"}}'::jsonb);
    `);
    mesclar(a, [b]);
    expect(
      sql(`select (consent->'marketing')::text || '|' || (consent->>'terms') || '|' || coalesce(consent->>'newsletter', 'ausente')
             || '|' || (consent->'profiling'->>'revoked_at')
             from public.contacts where id = '${a}';`),
    ).toBe("false|true|ausente|2026-02-01");
  });

  it("sem restrição em nenhum lado, nada muda (par positivo)", () => {
    const [a, b] = [id(5, 1), id(5, 2)];
    sql(`
      insert into public.contacts (id, organization_id, name) values ('${a}', '${ORG}', 'Eva');
      insert into public.contacts (id, organization_id, name, phone_number) values ('${b}', '${ORG}', 'Eva B', '+5511900009225');
    `);
    mesclar(a, [b]);
    expect(linha(a)).toBe("false|false|-|false|+5511900009225");
  });
});
