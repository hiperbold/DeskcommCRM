/**
 * Migrations 0928 a 0931 (lote 7b da auditoria de 30/09/2026: D-094, D-125, D-133 parcial,
 * D-106). Provado no Postgres real: o papel de baixo é barrado e o que a rota exige passa
 * (controle positivo).
 *
 * Roda via `pnpm test:db tests/invariants/lote7-conta-e-cobranca-banco.test.ts`.
 */
import { spawn } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

const U = (n: number) => `0928a000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ADMIN1 = U(1);
const ADMIN2 = U(2);
const AGENT1 = U(3);
const SOLO = U(4);
const VITIMA = U(5);
const PLAT = U(6);
const RA1 = U(7);
const RA2 = U(8);
const ORG_A = U(101);
const ORG_SOLO = U(102);
const ORG_CORRIDA = U(103);

function como(usuario: string, corpo: string): string {
  return sql(`
    set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${usuario}","role":"authenticated","aal":"aal2"}', false);
    ${corpo}
  `);
}

function erroDe(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return motivoDoErro(err);
  }
  return "";
}

/** Linhas marcadas com SONDA| (uma saída por linha), dentro de um begin/rollback. */
function sonda(corpo: string): string[] {
  return sql(`begin;\n${corpo}\nrollback;`)
    .split("\n")
    .filter((l) => l.startsWith("SONDA|"))
    .map((l) => l.slice(6));
}

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${ADMIN1}', 'admin1-0928@invariant.test'), ('${ADMIN2}', 'admin2-0928@invariant.test'),
      ('${AGENT1}', 'agent1-0928@invariant.test'), ('${SOLO}', 'solo-0928@invariant.test'),
      ('${VITIMA}', 'vitima-0928@invariant.test'), ('${PLAT}', 'plat-0928@invariant.test'),
      ('${RA1}', 'ra1-0928@invariant.test'), ('${RA2}', 'ra2-0928@invariant.test')
      on conflict (id) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'lote7b-a', 'Lote7b A', 'Lote7b A'),
      ('${ORG_SOLO}', 'lote7b-solo', 'Lote7b Solo', 'Lote7b Solo'),
      ('${ORG_CORRIDA}', 'lote7b-corrida', 'Lote7b Corrida', 'Lote7b Corrida')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${ADMIN1}', '${ORG_A}', 'admin', now()), ('${ADMIN2}', '${ORG_A}', 'admin', now()),
      ('${AGENT1}', '${ORG_A}', 'agent', now()), ('${SOLO}', '${ORG_SOLO}', 'admin', now()),
      ('${RA1}', '${ORG_CORRIDA}', 'admin', now()), ('${RA2}', '${ORG_CORRIDA}', 'admin', now())
      on conflict do nothing;
  `);
});

describe("D-094: organização nova", () => {
  const nova = (id: string, slug: string, settings: string) =>
    `insert into public.organizations (id, slug, legal_name, display_name, settings)
       values ('${id}', '${slug}', 'X', 'X', '${settings}'::jsonb);`;
  // Revisto em 06/10/2026 (0940): sem período gratuito. O cadastro do próprio visitante nasce
  // suspenso, sem período e sem ciclo (o antigo caso de "avaliação de um mês no Pro" saiu).
  const lerContrato = (id: string) => `
    select 'SONDA|' || bc.status || '|' || bp.code || '|' || (bc.current_period_end is null)::text
      || '|' || (bc.cycle is null)::text
      from public.billing_contracts bc join public.billing_plans bp on bp.id = bc.plan_id
      where bc.organization_id = '${id}';`;

  it("o cadastro do próprio visitante nasce suspenso, sem período e sem ciclo (sem avaliação gratuita)", () => {
    const [linha] = sonda(`${nova(U(201), "l7b-aval", '{"billing_inicio":"sem_plano"}')} ${lerContrato(U(201))}`);
    expect(linha).toBe("suspensa|pro|true|true");
  });

  it("sem o marcador (admin da plataforma, provisionamento externo, instalação) segue ativa no Ilimitado, sem período", () => {
    const linhas = sonda(`
      ${nova(U(202), "l7b-ilim-1", "{}")} ${lerContrato(U(202))}
      ${nova(U(203), "l7b-ilim-2", '{"provisioning":{"integration":"x","external_id":"1"}}')} ${lerContrato(U(203))}
      ${nova(U(204), "l7b-ilim-3", '{"plan":"standard"}')} ${lerContrato(U(204))}`);
    expect(linhas).toEqual(["ativa|ilimitado|true|true", "ativa|ilimitado|true|true", "ativa|ilimitado|true|true"]);
  });

  it("a criação pelo admin da plataforma (fn_create_tenant_with_owner) segue no Ilimitado", () => {
    const [linha] = sonda(`
      insert into public.platform_admins(user_id, granted_by, scope, mfa_required, reason)
        values ('${PLAT}', '${PLAT}', 'full', false, 'fixture 0928') on conflict do nothing;
      create temp table criada as select (public.fn_create_tenant_with_owner('${PLAT}', '${U(301)}',
        '{"display_name":"Nova 0928","slug":"l7b-admin","plan":"standard","owner_email":"plat-0928@invariant.test"}'::jsonb, 'abcd')->>'id')::uuid as id;
      select 'SONDA|' || bc.status || '|' || bp.code from public.billing_contracts bc
        join public.billing_plans bp on bp.id = bc.plan_id where bc.organization_id = (select id from criada);`);
    expect(linha).toBe("ativa|ilimitado");
  });

  it("com o billing desligado cai no Ilimitado; sem o plano de entrada ativo segue suspensa (a linha usa o Ilimitado só como chave) e a criação não falha", () => {
    const linhas = sonda(`
      update public.billing_settings set modo = 'desligado' where id = 1;
      ${nova(U(205), "l7b-desl", '{"billing_inicio":"sem_plano"}')} ${lerContrato(U(205))}
      update public.billing_settings set modo = 'avisar' where id = 1;
      update public.billing_plans set active = false where code = 'pro';
      ${nova(U(206), "l7b-sempro", '{"billing_inicio":"sem_plano"}')} ${lerContrato(U(206))}`);
    expect(linhas).toEqual(["ativa|ilimitado|true|true", "suspensa|ilimitado|true|true"]);
  });

  it("o conferidor de vencimento nunca mexe em contrato sem período: a organização sem plano segue suspensa", () => {
    const [linha] = sonda(`
      ${nova(U(207), "l7b-venc", '{"billing_inicio":"sem_plano"}')}
      select 'SONDA|' || coalesce(public.fn_billing_conferir_vencimento('${U(207)}'), 'nada') || '|'
        || (select status from public.billing_contracts where organization_id = '${U(207)}');`);
    expect(linha).toBe("nada|suspensa");
  });
});

describe("D-125: vínculo só pelo servidor", () => {
  it("admin de organização não vincula outro usuário (insert) nem troca user_id, role, revoked_at, accepted_at", () => {
    const insere = erroDe(() =>
      como(ADMIN1, `insert into public.user_organizations (user_id, organization_id, role, accepted_at) values ('${VITIMA}', '${ORG_A}', 'agent', now());`),
    );
    expect(insere).toContain("só pode ser gravado pelo servidor");
    for (const set of [`user_id = '${VITIMA}'`, `role = 'viewer'`, `revoked_at = now()`, `accepted_at = null`]) {
      const erro = erroDe(() => como(ADMIN1, `update public.user_organizations set ${set} where user_id = '${AGENT1}' and organization_id = '${ORG_A}';`));
      expect(erro, set).toContain("só pode ser gravado pelo servidor");
    }
    expect(sql(`select role || '|' || (revoked_at is null) from public.user_organizations where user_id = '${AGENT1}' and organization_id = '${ORG_A}';`)).toBe("agent|true");
    expect(sql(`select count(*) from public.user_organizations where user_id = '${VITIMA}';`)).toBe("0");
  });

  it("CONTROLE POSITIVO: o admin ainda grava o resto (interface) e o servidor muda papel e revoga", () => {
    como(ADMIN1, `update public.user_organizations set interface_settings = '{"preset":"simplificada"}' where user_id = '${AGENT1}' and organization_id = '${ORG_A}';`);
    expect(sql(`select interface_settings->>'preset' from public.user_organizations where user_id = '${AGENT1}';`)).toBe("simplificada");
    sql(`set role service_role; update public.user_organizations set role = 'manager' where user_id = '${AGENT1}' and organization_id = '${ORG_A}';
         update public.user_organizations set role = 'agent' where user_id = '${AGENT1}' and organization_id = '${ORG_A}';`);
    expect(sql(`select role from public.user_organizations where user_id = '${AGENT1}' and organization_id = '${ORG_A}';`)).toBe("agent");
  });
});

describe("D-125: a organização nunca fica sem admin", () => {
  it("o último admin não é rebaixado, revogado nem apagado (servidor e authenticated)", () => {
    const doServidor = erroDe(() => sql(`set role service_role; update public.user_organizations set role = 'agent' where user_id = '${SOLO}' and organization_id = '${ORG_SOLO}';`));
    expect(doServidor).toContain("organizacao_sem_admin");
    const revoga = erroDe(() => sql(`set role service_role; update public.user_organizations set revoked_at = now() where user_id = '${SOLO}' and organization_id = '${ORG_SOLO}';`));
    expect(revoga).toContain("organizacao_sem_admin");
    const apaga = erroDe(() => como(SOLO, `delete from public.user_organizations where user_id = '${SOLO}' and organization_id = '${ORG_SOLO}';`));
    expect(apaga).toContain("organizacao_sem_admin");
    expect(sql(`select count(*) from public.user_organizations where organization_id = '${ORG_SOLO}' and role = 'admin' and revoked_at is null;`)).toBe("1");
  });

  it("CONTROLE POSITIVO: com dois admins o primeiro sai; o que sobrou não sai. Apagar a organização leva o último junto", () => {
    const linhas = sonda(`
      set role service_role;
      update public.user_organizations set revoked_at = now() where user_id = '${ADMIN1}' and organization_id = '${ORG_A}';
      select 'SONDA|ok';
      do $$ begin
        begin
          update public.user_organizations set role = 'agent' where user_id = '${ADMIN2}' and organization_id = '${ORG_A}';
          raise exception 'passou';
        exception when check_violation then null; end;
      end $$;
      select 'SONDA|barrou';
      reset role;
      delete from public.organizations where id = '${ORG_SOLO}';
      select 'SONDA|cascata ' || count(*) from public.user_organizations where organization_id = '${ORG_SOLO}';`);
    expect(linhas).toEqual(["ok", "barrou", "cascata 0"]);
  });

  it("corrida: duas revogações de admin ao mesmo tempo, só uma passa", async () => {
    const rodar = (script: string) =>
      new Promise<{ ok: boolean; erro: string }>((resolve) => {
        const c = process.env.TEST_DB_CONTAINER;
        const proc = c
          ? spawn("docker", ["exec", "-i", c, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"])
          : spawn("psql", [process.env.TEST_DB_CONN ?? "postgres://postgres@localhost/postgres", "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"]);
        let erro = "";
        proc.stderr.on("data", (d) => (erro += d.toString()));
        proc.on("close", (code) => resolve({ ok: code === 0, erro }));
        proc.stdin.write(script);
        proc.stdin.end();
      });
    const revoga = (quem: string, espera: number) =>
      `set role service_role; begin; update public.user_organizations set revoked_at = now() where user_id = '${quem}' and organization_id = '${ORG_CORRIDA}'; select pg_sleep(${espera}); commit;`;
    const [a, b] = await Promise.all([
      rodar(revoga(RA1, 3)),
      new Promise<{ ok: boolean; erro: string }>((r) => setTimeout(() => rodar(revoga(RA2, 0)).then(r), 1200)),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(a.erro + b.erro).toContain("organizacao_sem_admin");
    expect(sql(`select count(*) from public.user_organizations where organization_id = '${ORG_CORRIDA}' and role = 'admin' and revoked_at is null;`)).toBe("1");
  });
});

describe("D-133: troca de plano e ajuste de limites deixam evento na transação", () => {
  it("trocar o plano grava o evento plano com ator; o mesmo plano de novo não grava", () => {
    const linhas = sonda(`
      select 'SONDA|' || (public.fn_billing_trocar_plano('${ORG_A}', 'pro', '${ADMIN2}')->'depois'->>'plan_code');
      select 'SONDA|' || tipo || '|' || (de is not null)::text || '|' || (para = (select id::text from public.billing_plans where code = 'pro' and active))::text
        || '|' || motivo || '|' || (actor = '${ADMIN2}')::text from public.billing_contract_eventos where organization_id = '${ORG_A}';
      select public.fn_billing_trocar_plano('${ORG_A}', 'pro', '${ADMIN2}');
      select 'SONDA|total ' || count(*) from public.billing_contract_eventos where organization_id = '${ORG_A}';`);
    expect(linhas).toEqual(["pro", "plano|true|true|troca_manual|true", "total 1"]);
  });

  it("ajustar limites grava o evento do ajuste (a nota vai no motivo); repetir igual não grava; sem contrato não quebra", () => {
    const linhas = sonda(`
      select public.fn_billing_ajustar_limites('${ORG_A}', '{"leads": 10}'::jsonb, 'cortesia', '${ADMIN2}');
      select 'SONDA|' || tipo || '|' || para || '|' || motivo || '|' || (actor = '${ADMIN2}')::text
        from public.billing_contract_eventos where organization_id = '${ORG_A}' and motivo like 'ajuste_de_limites%';
      select public.fn_billing_ajustar_limites('${ORG_A}', '{"leads": 10}'::jsonb, 'cortesia', '${ADMIN2}');
      select 'SONDA|total ' || count(*) from public.billing_contract_eventos where organization_id = '${ORG_A}' and motivo like 'ajuste_de_limites%';
      delete from public.billing_contracts where organization_id = '${ORG_A}';
      select public.fn_billing_ajustar_limites('${ORG_A}', '{"leads": 20}'::jsonb, 'sem contrato', '${ADMIN2}');
      select 'SONDA|sem contrato ok';`);
    expect(linhas).toEqual(['plano|{"leads": 10}|ajuste_de_limites: cortesia|true', "total 1", "sem contrato ok"]);
  });
});

describe("D-106: tokens do plano só com contrato em dia", () => {
  const ciclo = `public.fn_billing_ciclo_de(now())`;
  const prepara = (org: string, slug: string, status: string, inicio: string, fim: string) => `
    insert into public.organizations (id, slug, legal_name, display_name) values ('${org}', '${slug}', 'X', 'X');
    select public.fn_billing_trocar_plano('${org}', 'pro', null);
    update public.billing_contracts set status = '${status}', current_period_start = ${inicio}, current_period_end = ${fim}
      where organization_id = '${org}';`;
  const conceder = (org: string) => `select public.fn_billing_garantir_concessoes('${org}', ${ciclo});`;
  const lerPlano = (org: string) => `
    select 'SONDA|' || coalesce((select tokens::text from public.billing_token_ledger where organization_id = '${org}' and chave = 'plano:' || to_char(${ciclo}, 'YYYY-MM-DD')), 'nada');`;
  const diasDoMes = `((${ciclo} + interval '1 month')::date - ${ciclo})`;

  it("a primeira concessão de um período pago que começou no mês é proporcional aos dias restantes; o mês seguinte e o plano sem período levam o teto inteiro", () => {
    const [prop, esperado] = sonda(`
      ${prepara(U(401), "l7b-prop", "ativa", `(${ciclo} + 9)::timestamp at time zone 'America/Sao_Paulo'`, "now() + interval '20 days'")}
      ${conceder(U(401))} ${lerPlano(U(401))}
      select 'SONDA|' || ((3000000 * (${diasDoMes} - 9)) / ${diasDoMes});`);
    expect(prop).toBe(esperado);
    expect(Number(prop)).toBeLessThan(3000000);

    const [cheio, proximo, jaTinha] = sonda(`
      ${prepara(U(402), "l7b-cheio", "ativa", "null", "null")} ${conceder(U(402))} ${lerPlano(U(402))}
      ${prepara(U(403), "l7b-prox", "ativa", `(${ciclo} + 9)::timestamp at time zone 'America/Sao_Paulo'`, "now() + interval '20 days'")}
      select public.fn_billing_garantir_concessoes('${U(403)}', (${ciclo} + interval '1 month')::date);
      select 'SONDA|' || tokens from public.billing_token_ledger where organization_id = '${U(403)}' and chave like 'plano:%';
      ${prepara(U(404), "l7b-ja", "ativa", `(${ciclo} + 9)::timestamp at time zone 'America/Sao_Paulo'`, "now() + interval '20 days'")}
      insert into public.billing_token_ledger (organization_id, fonte, tokens, chave) values ('${U(404)}', 'plano', 1, 'plano:2000-01-01');
      ${conceder(U(404))} ${lerPlano(U(404))}`);
    expect(cheio).toBe("3000000");
    expect(proximo).toBe("3000000");
    expect(jaTinha).toBe("3000000");
  });

  it("atrasada, suspensa, cancelada e período vencido não ganham o ciclo novo (nem adicional); avisada em dia ganha", () => {
    const linhas = sonda(`
      ${prepara(U(411), "l7b-atr", "atrasada", "null", "null")}
      ${prepara(U(412), "l7b-sus", "suspensa", "null", "null")}
      ${prepara(U(413), "l7b-can", "cancelada", "null", "null")}
      ${prepara(U(414), "l7b-venc2", "ativa", "now() - interval '40 days'", "now() - interval '1 day'")}
      ${prepara(U(415), "l7b-aval2", "avaliacao", "now() - interval '1 day'", "now() + interval '20 days'")}
      insert into public.billing_token_adicionais (organization_id, tokens_por_ciclo) values
        ('${U(411)}', 500), ('${U(412)}', 500), ('${U(413)}', 500), ('${U(414)}', 500), ('${U(415)}', 500);
      ${[411, 412, 413, 414, 415].map((n) => conceder(U(n))).join("\n")}
      select 'SONDA|' || o.slug || '|' || count(*) filter (where l.fonte = 'plano') || '|' || count(*) filter (where l.fonte = 'adicional')
        from public.organizations o left join public.billing_token_ledger l on l.organization_id = o.id
        where o.id in ('${U(411)}', '${U(412)}', '${U(413)}', '${U(414)}', '${U(415)}') group by o.slug order by o.slug;`);
    expect(linhas).toEqual(["l7b-atr|0|0", "l7b-aval2|1|1", "l7b-can|0|0", "l7b-sus|0|0", "l7b-venc2|0|0"]);
  });

  it("o que já foi concedido no ciclo aberto continua valendo quando o contrato atrasa", () => {
    const [antes, depois] = sonda(`
      ${prepara(U(421), "l7b-mantem", "ativa", "null", "null")} ${conceder(U(421))} ${lerPlano(U(421))}
      update public.billing_contracts set status = 'atrasada' where organization_id = '${U(421)}';
      ${conceder(U(421))} ${lerPlano(U(421))}`);
    expect([antes, depois]).toEqual(["3000000", "3000000"]);
  });
});
