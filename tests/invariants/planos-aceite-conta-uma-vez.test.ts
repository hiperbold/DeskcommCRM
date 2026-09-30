import { describe, expect, it } from "vitest";

import { sql } from "./psql-transporte";

/**
 * D-053 item 1 (migration 0912, fork Hiperbold): ACEITAR um convite conta a
 * pessoa UMA vez, e não abre o aviso espúrio "Limite de membros do plano
 * atingido" numa organização exatamente no teto.
 *
 * O caminho real é `lib/auth/aplicar-convite.ts`: (1) `fn_accept_team_invite`
 * grava o vínculo ativo em `user_organizations`, pelo cliente de SERVIÇO; (2)
 * só depois o convite em `team_invites` recebe `accepted_at`. No passo (1) o
 * gatilho de membros roda num BEFORE INSERT: o vínculo novo ainda não é
 * visível, o convite pendente do mesmo e-mail continua contando, e a conferência
 * de aviso enxergava "atual = teto" numa organização que só tinha o membro que
 * estava entrando.
 *
 * Molde de `planos-bloqueio-membros.test.ts`: cada caso vive dentro de
 * `begin; ...; rollback;`, com `billing_settings.modo` (linha única e global)
 * fixado em `avisar` DENTRO da transação, e o aceite chamado como `service_role`
 * (é assim que `aplicarConvite` o chama, e é o único papel para o qual as
 * isenções do aceite valem, `fn_billing_e_servidor`).
 *
 * Rodar (precisa de Docker, é banco): `pnpm test:db tests/invariants/planos-aceite-conta-uma-vez.test.ts`.
 */

const MARCA = "SONDA|";

function linhasMarcadas(saida: string): string[] {
  return saida
    .split("\n")
    .filter((linha) => linha.startsWith(MARCA))
    .map((linha) => linha.slice(MARCA.length));
}

/** Roda como o papel da sessão do container (`postgres`, sem SET ROLE). */
function comoServico(corpo: string): string[] {
  return linhasMarcadas(sql(corpo));
}

const ORG_NO_TETO = "d0530001-0000-4000-8000-000000000001";
const ADMIN_NO_TETO = "d0530001-1111-4000-8000-000000000001";
const CONVIDADO_NO_TETO = "d0530001-1111-4000-8000-000000000002";

const ORG_SEM_CONVITE = "d0530002-0000-4000-8000-000000000001";
const ADMIN_SEM_CONVITE = "d0530002-1111-4000-8000-000000000001";
const ENTRANTE_SEM_CONVITE = "d0530002-1111-4000-8000-000000000002";

const ORG_CONVITE_DE_OUTRO = "d0530003-0000-4000-8000-000000000001";
const ADMIN_CONVITE_DE_OUTRO = "d0530003-1111-4000-8000-000000000001";
const ENTRANTE_CONVITE_DE_OUTRO = "d0530003-1111-4000-8000-000000000002";

/**
 * Organização com teto de membros informado e UM admin ativo (o admin entra
 * antes do teto ser ajustado, para a fixture nunca se avisar a si mesma).
 */
function fixtureOrg(org: string, admin: string, sufixo: string, tetoDeMembros: number): string {
  return `
    update public.billing_settings set modo = 'avisar' where id = 1;
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${org}', 'inv-aceite-${sufixo}', 'Aceite ${sufixo} LTDA', 'Aceite ${sufixo}')
      on conflict (id) do nothing;
    insert into auth.users (id, email) values ('${admin}', 'admin-aceite-${sufixo}@invariant.test')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
      values ('${admin}', '${org}', 'admin', now())
      on conflict do nothing;
    select public.fn_billing_ajustar_limites('${org}'::uuid, '{"membros": ${tetoDeMembros}}'::jsonb, null, null);
  `;
}

/** Quantos avisos de limite de plano ABERTOS a organização tem. */
function contarAvisos(org: string, rotulo: string): string {
  return `
    select 'SONDA|${rotulo}=' || count(*) from public.agent_inbox_items
      where organization_id = '${org}' and kind = 'other' and ref_kind = 'billing_limite' and status = 'open';
  `;
}

/** O uso de membros como a Central e a trava o enxergam, NO MOMENTO da consulta. */
function usoDeMembros(org: string, rotulo: string): string {
  return `select 'SONDA|${rotulo}=' || (public.fn_billing_uso('${org}'::uuid) ->> 'membros');`;
}

describe("D-053 item 1: o aceite de convite conta a pessoa uma vez", () => {
  it("organização EXATAMENTE no teto (admin + convite pendente = teto): aceitar o convite legítimo não abre aviso, e a pessoa conta uma vez em cada passo do aceite", () => {
    const linhas = comoServico(`
      begin;
      ${fixtureOrg(ORG_NO_TETO, ADMIN_NO_TETO, "teto", 2)}
      insert into auth.users (id, email) values ('${CONVIDADO_NO_TETO}', 'convidado-aceite-teto@invariant.test')
        on conflict (id) do nothing;
      -- O convite ocupa a segunda (e última) vaga: 1 ativo + 1 pendente = 2 = teto.
      -- Nasce com 1 ativo < 2, então o convite em si não avisa.
      insert into public.team_invites (organization_id, email, role, invited_by, expires_at)
        values ('${ORG_NO_TETO}', 'convidado-aceite-teto@invariant.test', 'agent', '${ADMIN_NO_TETO}', now() + interval '7 days');
      ${contarAvisos(ORG_NO_TETO, "avisos_antes_do_aceite")}
      ${usoDeMembros(ORG_NO_TETO, "uso_antes_do_aceite")}

      -- PASSO 1 do aceite real: o vínculo nasce ativo, o convite ainda pendente.
      set role service_role;
      select public.fn_accept_team_invite(
        '${CONVIDADO_NO_TETO}'::uuid, '${ORG_NO_TETO}'::uuid, 'agent', '${ADMIN_NO_TETO}'::uuid,
        now() - interval '1 minute', now() - interval '1 minute'
      );
      reset role;
      ${contarAvisos(ORG_NO_TETO, "avisos_apos_o_vinculo")}
      -- Entre os dois passos: vínculo ativo + convite ainda pendente. A pessoa
      -- conta UMA vez (o admin + ela = 2), não duas (3).
      ${usoDeMembros(ORG_NO_TETO, "uso_entre_os_passos")}
      select 'SONDA|vinculo_ativo=' || count(*) from public.user_organizations
        where user_id = '${CONVIDADO_NO_TETO}' and organization_id = '${ORG_NO_TETO}'
          and accepted_at is not null and revoked_at is null;

      -- PASSO 2 do aceite real: o convite é fechado.
      update public.team_invites set accepted_at = now(), accepted_by = '${CONVIDADO_NO_TETO}'
        where organization_id = '${ORG_NO_TETO}' and email = 'convidado-aceite-teto@invariant.test';
      ${contarAvisos(ORG_NO_TETO, "avisos_apos_o_aceite")}
      ${usoDeMembros(ORG_NO_TETO, "uso_apos_o_aceite")}
      rollback;
    `);
    expect(linhas, "o aceite de convite no teto tem que passar sem aviso e contando a pessoa uma vez").toEqual([
      "avisos_antes_do_aceite=0",
      "uso_antes_do_aceite=2",
      "avisos_apos_o_vinculo=0",
      "uso_entre_os_passos=2",
      "vinculo_ativo=1",
      "avisos_apos_o_aceite=0",
      "uso_apos_o_aceite=2",
    ]);
  });

  it("controle: aceite SEM linha de convite (token antigo) numa organização já no teto continua avisando, porque aí a pessoa é um ocupante A MAIS", () => {
    const linhas = comoServico(`
      begin;
      ${fixtureOrg(ORG_SEM_CONVITE, ADMIN_SEM_CONVITE, "semconvite", 1)}
      insert into auth.users (id, email) values ('${ENTRANTE_SEM_CONVITE}', 'entrante-sem-convite@invariant.test')
        on conflict (id) do nothing;
      ${contarAvisos(ORG_SEM_CONVITE, "avisos_antes")}

      set role service_role;
      select public.fn_accept_team_invite(
        '${ENTRANTE_SEM_CONVITE}'::uuid, '${ORG_SEM_CONVITE}'::uuid, 'agent', '${ADMIN_SEM_CONVITE}'::uuid,
        now() - interval '1 minute', now() - interval '1 minute'
      );
      reset role;
      ${contarAvisos(ORG_SEM_CONVITE, "avisos_apos")}
      rollback;
    `);
    expect(linhas, "sem convite pendente o aceite soma um ocupante e o aviso continua valendo").toEqual([
      "avisos_antes=0",
      "avisos_apos=1",
    ]);
  });

  it("controle: convite pendente de OUTRO e-mail não dispensa o aviso de quem entra sem convite próprio", () => {
    const linhas = comoServico(`
      begin;
      ${fixtureOrg(ORG_CONVITE_DE_OUTRO, ADMIN_CONVITE_DE_OUTRO, "deoutro", 2)}
      insert into auth.users (id, email) values ('${ENTRANTE_CONVITE_DE_OUTRO}', 'entrante-deoutro@invariant.test')
        on conflict (id) do nothing;
      -- 1 ativo + 1 convite pendente de OUTRA pessoa = 2 = teto.
      insert into public.team_invites (organization_id, email, role, invited_by, expires_at)
        values ('${ORG_CONVITE_DE_OUTRO}', 'outra-pessoa-deoutro@invariant.test', 'agent', '${ADMIN_CONVITE_DE_OUTRO}', now() + interval '7 days');
      ${contarAvisos(ORG_CONVITE_DE_OUTRO, "avisos_antes")}

      set role service_role;
      select public.fn_accept_team_invite(
        '${ENTRANTE_CONVITE_DE_OUTRO}'::uuid, '${ORG_CONVITE_DE_OUTRO}'::uuid, 'agent', '${ADMIN_CONVITE_DE_OUTRO}'::uuid,
        now() - interval '1 minute', now() - interval '1 minute'
      );
      reset role;
      ${contarAvisos(ORG_CONVITE_DE_OUTRO, "avisos_apos")}
      rollback;
    `);
    expect(linhas, "o convite de outra pessoa não é a vaga de quem entrou: o terceiro ocupante avisa").toEqual([
      "avisos_antes=0",
      "avisos_apos=1",
    ]);
  });
});
