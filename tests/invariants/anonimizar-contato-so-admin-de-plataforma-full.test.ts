/**
 * D-103 (migration 0917, fork Hiperbold): o botão "Anonimizar contato"
 * (`fn_lgpd_anonymize_contact`) só aceita de FORA da empresa o admin de
 * plataforma de escopo `full`.
 *
 * A função é `security definer` e chamável direto pelo PostgREST por qualquer
 * `authenticated`. O portão da 0414 aceitava `fn_is_platform_admin()`, que vale
 * para qualquer linha não revogada de `platform_admins`: um operador
 * `support_readonly` chamava a função com o id de QUALQUER empresa, sem ser
 * membro, e anonimizava o contato (irreversível). Aqui se prova no Postgres real:
 *
 *   1. `support_readonly` de fora da empresa é recusado (42501) e o contato fica
 *      intacto;
 *   2. o MESMO caminho com escopo `full` passa (controle positivo: sem ele o
 *      caso 1 estaria verde por a função recusar tudo);
 *   3. `support_readonly` que é ADMIN da própria empresa segue anonimizando,
 *      pelo ramo de papel (o escopo só restringe o ramo de fora);
 *   4. admin de OUTRA empresa continua sem poder nada.
 *
 * Roda via `pnpm test:db tests/invariants/anonimizar-contato-so-admin-de-plataforma-full.test.ts`.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

const ORG = "09170001-a5aa-4000-8000-000000000001";
const OUTRA_ORG = "09170001-a5aa-4000-8000-000000000002";
const SUPORTE = "09170001-b0b0-4000-8000-000000000001";
const COMPLETO = "09170001-b0b0-4000-8000-000000000002";
const SUPORTE_ADMIN_DA_EMPRESA = "09170001-b0b0-4000-8000-000000000003";
const ADMIN_DE_OUTRA = "09170001-b0b0-4000-8000-000000000004";
const CONTATO_1 = "09170001-c0c0-4000-8000-000000000001";
const CONTATO_2 = "09170001-c0c0-4000-8000-000000000002";
const CONTATO_3 = "09170001-c0c0-4000-8000-000000000003";
const CONTATO_4 = "09170001-c0c0-4000-8000-000000000004";

/** Chama a função como `authenticated` com a sessão provada (aal2). */
function anonimizarComo(usuario: string, contato: string): string {
  return sql(`
    set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${usuario}","role":"authenticated","aal":"aal2"}', false);
    select public.fn_lgpd_anonymize_contact('${ORG}'::uuid, '${contato}'::uuid)::text;
  `);
}

const anonimizado = (contato: string) =>
  sql(`select is_anonymized from public.contacts where id = '${contato}'::uuid;`);

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${SUPORTE}', 'suporte-0917@invariant.test'),
      ('${COMPLETO}', 'completo-0917@invariant.test'),
      ('${SUPORTE_ADMIN_DA_EMPRESA}', 'suporte-admin-0917@invariant.test'),
      ('${ADMIN_DE_OUTRA}', 'admin-outra-0917@invariant.test')
      on conflict (id) do nothing;

    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG}', 'anon-0917-a', 'Anonimizar 0917 A', 'Anonimizar 0917 A'),
      ('${OUTRA_ORG}', 'anon-0917-b', 'Anonimizar 0917 B', 'Anonimizar 0917 B')
      on conflict (id) do nothing;

    insert into public.platform_admins (user_id, granted_by, scope, reason) values
      ('${SUPORTE}', '${COMPLETO}', 'support_readonly', 'invariante 0917'),
      ('${COMPLETO}', '${COMPLETO}', 'full', 'invariante 0917'),
      ('${SUPORTE_ADMIN_DA_EMPRESA}', '${COMPLETO}', 'support_readonly', 'invariante 0917')
      on conflict (user_id) do nothing;

    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${SUPORTE_ADMIN_DA_EMPRESA}', '${ORG}', 'admin', now()),
      ('${ADMIN_DE_OUTRA}', '${OUTRA_ORG}', 'admin', now())
      on conflict do nothing;

    insert into public.contacts (id, organization_id, name, display_name) values
      ('${CONTATO_1}', '${ORG}', 'ALVO-1', 'ALVO-1'),
      ('${CONTATO_2}', '${ORG}', 'ALVO-2', 'ALVO-2'),
      ('${CONTATO_3}', '${ORG}', 'ALVO-3', 'ALVO-3'),
      ('${CONTATO_4}', '${ORG}', 'ALVO-4', 'ALVO-4')
      on conflict (id) do nothing;
  `);
});

describe("fn_lgpd_anonymize_contact: o ramo de fora da empresa exige escopo full", () => {
  it("⭐ support_readonly de fora da empresa é recusado e o contato fica intacto", () => {
    let motivo = "";
    try {
      anonimizarComo(SUPORTE, CONTATO_1);
    } catch (err) {
      motivo = motivoDoErro(err);
    }
    expect(motivo, "o support_readonly anonimizou contato de empresa da qual não é membro").toContain(
      "contact_anonymize_forbidden",
    );
    expect(anonimizado(CONTATO_1)).toBe("f");
  });

  it("CONTROLE POSITIVO: admin de plataforma de escopo full, de fora, anonimiza", () => {
    const r = anonimizarComo(COMPLETO, CONTATO_2);
    expect(r).toContain('"already_anonymized": false');
    expect(anonimizado(CONTATO_2)).toBe("t");
  });

  it("support_readonly que é ADMIN da própria empresa continua anonimizando (ramo de papel)", () => {
    const r = anonimizarComo(SUPORTE_ADMIN_DA_EMPRESA, CONTATO_3);
    expect(r).toContain('"already_anonymized": false');
    expect(anonimizado(CONTATO_3)).toBe("t");
  });

  it("admin de OUTRA empresa continua sem poder nada", () => {
    let motivo = "";
    try {
      anonimizarComo(ADMIN_DE_OUTRA, CONTATO_4);
    } catch (err) {
      motivo = motivoDoErro(err);
    }
    expect(motivo).toContain("contact_anonymize_forbidden");
    expect(anonimizado(CONTATO_4)).toBe("f");
  });
});
