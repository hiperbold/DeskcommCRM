import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

/**
 * Migration 0954 (D-188, decisão do dono em 09/10/2026): o limite de Conexões do plano vale para TODOS os
 * canais somados e BLOQUEIA de verdade, qualquer que seja `billing_settings.modo`. Provado no Postgres real:
 *
 *   1. Pro (3 conexões) com modo `avisar`: a 4ª conexão é recusada com PT402 e detail `conexoes`, qualquer
 *      que seja o canal da 4ª (waha, uazapi, meta_cloud, zernio_social); idem em `desligado` e `bloquear`
 *      (este último sem carência: `bloqueio_a_partir_de` nulo);
 *   2. as três primeiras são de canais DIFERENTES e todas contam (a soma é de todos os canais);
 *   3. conexão arquivada não conta; desarquivar com o limite cheio é recusado;
 *   4. os outros itens continuam seguindo o modo: em `avisar` o 6º funil passa e `fn_billing_bloqueia` diz
 *      não para funis; a IA segue (`fn_billing_ia_pode_responder`); em `bloquear` com carência vencida o
 *      6º funil é recusado;
 *   5. plano sem limite (Ilimitado) e ajuste com `conexoes` nulo não bloqueiam;
 *   6. conexão que já existe acima do limite não é tocada: editar a linha passa, só nova ou desarquivada
 *      é barrada;
 *   7. reaplicar a migration não muda o comportamento.
 *
 * Roda via `pnpm test:db tests/invariants/limite-de-conexoes-bloqueia-sempre.test.ts`.
 */

const U = (n: number) => `0954a000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const MARCA = "SONDA|";
const ORG_PRO = U(1);
const ORG_ARQ = U(2);
const ORG_FUNIS = U(3);
const ORG_ILIMITADO = U(4);
const ORG_AJUSTE_NULO = U(5);
const ORG_EXISTENTES = U(6);
const ORG_MODOS = U(7);

const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/20261009110000_0954_limite_de_conexoes_bloqueia_sempre.sql"),
  "utf8",
);

function marcadas(saida: string): string[] {
  return saida
    .split("\n")
    .filter((l) => l.startsWith(MARCA))
    .map((l) => l.slice(MARCA.length));
}
const roda = (corpo: string) => marcadas(sql(corpo));

function erroDe(script: string): string | null {
  try {
    sql(`\\set VERBOSITY verbose\n${script}`);
    return null;
  } catch (err) {
    return motivoDoErro(err);
  }
}

const orgs = (ids: string[]) =>
  ids
    .map(
      (id, i) =>
        `insert into public.organizations (id, slug, legal_name, display_name) values ('${id}', 'i954-${i}-${id.slice(-3)}', 'i954 LTDA', 'i954') on conflict (id) do nothing;`,
    )
    .join("\n");

/** Coloca a organização no Pro (3 conexões, 5 funis). */
const noPro = (org: string) => `select public.fn_billing_trocar_plano('${org}'::uuid, 'pro', null);`;

/** Insere uma conexão ativa de um canal. */
const conexao = (org: string, canal: "waha" | "uazapi" | "meta_cloud" | "zernio_social", n: number) => {
  const id = U(1000 + n);
  const cols: Record<string, string> = {
    waha: `provider, waha_session_name`,
    uazapi: `provider, uazapi_instance_id, uazapi_base_url`,
    meta_cloud: `provider, meta_phone_number_id`,
    zernio_social: `provider, zernio_account_id`,
  };
  const vals: Record<string, string> = {
    waha: `'waha', 'i954-waha-${n}'`,
    uazapi: `'uazapi', 'i954-inst-${n}', 'https://qr.exemplo.com'`,
    meta_cloud: `'meta_cloud', 'i954-meta-${n}'`,
    zernio_social: `'zernio_social', 'i954-zer-${n}'`,
  };
  return `insert into public.channel_sessions (id, organization_id, ${cols[canal]}, webhook_secret_encrypted)
    values ('${id}', '${org}', ${vals[canal]}, '\\x00'::bytea);`;
};

describe("0954: setup", () => {
  it("cria as organizações", () => {
    sql(orgs([ORG_PRO, ORG_ARQ, ORG_FUNIS, ORG_ILIMITADO, ORG_AJUSTE_NULO, ORG_EXISTENTES, ORG_MODOS]));
    expect(sql(`select count(*) from public.organizations where id::text like '0954a000-%';`)).toBe("7");
  });
});

describe("0954: a 4ª conexão do Pro é recusada com o modo avisar (e em qualquer modo)", () => {
  it.each(["avisar", "desligado", "bloquear"])("modo %s: três canais diferentes passam, a 4ª dá PT402 conexoes", (modo) => {
    for (const canal of ["waha", "uazapi", "meta_cloud", "zernio_social"] as const) {
      const erro = erroDe(`
        begin;
        update public.billing_settings set modo = '${modo}' where id = 1;
        ${noPro(ORG_PRO)}
        ${conexao(ORG_PRO, "waha", 1)}
        ${conexao(ORG_PRO, "uazapi", 2)}
        ${conexao(ORG_PRO, "meta_cloud", 3)}
        select '${MARCA}' || count(*) from public.channel_sessions where organization_id = '${ORG_PRO}' and archived_at is null;
        ${conexao(ORG_PRO, canal, 4)}
        rollback;
      `);
      expect(erro, `${modo}/${canal}`).toContain("PT402");
      expect(erro, `${modo}/${canal}`).toContain("Limite do plano atingido");
      expect(erro, `${modo}/${canal}`).toContain("conexoes");
    }
  });

  it("em avisar a contagem antes da 4ª é 3 (a soma é de todos os canais) e nada é gravado pela 4ª", () => {
    const linhas = roda(`
      begin;
      update public.billing_settings set modo = 'avisar' where id = 1;
      ${noPro(ORG_PRO)}
      ${conexao(ORG_PRO, "waha", 1)}
      ${conexao(ORG_PRO, "uazapi", 2)}
      ${conexao(ORG_PRO, "zernio_social", 3)}
      select '${MARCA}' || count(*) from public.channel_sessions where organization_id = '${ORG_PRO}' and archived_at is null;
      select '${MARCA}' || (public.fn_billing_bloqueia('${ORG_PRO}'::uuid, 'conexoes', null))::text;
      select '${MARCA}' || (public.fn_billing_pode_criar('${ORG_PRO}'::uuid, 'conexoes', null) ->> 'atual');
      rollback;
    `);
    expect(linhas).toEqual(["3", "true", "3"]);
  });

  it("com carência no futuro em modo bloquear a conexão também é recusada (conexões não esperam a carência)", () => {
    const erro = erroDe(`
      begin;
      update public.billing_settings set modo = 'bloquear' where id = 1;
      ${noPro(ORG_PRO)}
      update public.billing_contracts set bloqueio_a_partir_de = now() + interval '30 days' where organization_id = '${ORG_PRO}';
      ${conexao(ORG_PRO, "waha", 1)}
      ${conexao(ORG_PRO, "waha", 2)}
      ${conexao(ORG_PRO, "waha", 3)}
      ${conexao(ORG_PRO, "waha", 4)}
      rollback;
    `);
    expect(erro).toContain("PT402");
  });
});

describe("0954: arquivada não conta e desarquivar com o limite cheio é recusado", () => {
  it("arquivar libera a vaga; desarquivar de volta com o limite cheio dá PT402", () => {
    const linhas = roda(`
      begin;
      update public.billing_settings set modo = 'avisar' where id = 1;
      ${noPro(ORG_ARQ)}
      ${conexao(ORG_ARQ, "waha", 11)}
      ${conexao(ORG_ARQ, "uazapi", 12)}
      ${conexao(ORG_ARQ, "meta_cloud", 13)}
      update public.channel_sessions set archived_at = now() where id = '${U(1011)}';
      ${conexao(ORG_ARQ, "zernio_social", 14)}
      select '${MARCA}' || count(*) from public.channel_sessions where organization_id = '${ORG_ARQ}' and archived_at is null;
      rollback;
    `);
    expect(linhas).toEqual(["3"]);

    const erro = erroDe(`
      begin;
      update public.billing_settings set modo = 'avisar' where id = 1;
      ${noPro(ORG_ARQ)}
      ${conexao(ORG_ARQ, "waha", 11)}
      ${conexao(ORG_ARQ, "uazapi", 12)}
      ${conexao(ORG_ARQ, "meta_cloud", 13)}
      update public.channel_sessions set archived_at = now() where id = '${U(1011)}';
      ${conexao(ORG_ARQ, "zernio_social", 14)}
      update public.channel_sessions set archived_at = null where id = '${U(1011)}';
      rollback;
    `);
    expect(erro).toContain("PT402");
    expect(erro).toContain("conexoes");
  });
});

describe("0954: os outros itens seguem o modo", () => {
  const funis = (org: string, quantos: number) =>
    Array.from(
      { length: quantos },
      (_, i) => `insert into public.crm_pipelines (organization_id, name, slug) values ('${org}', 'F${i}', 'i954-f${i}');`,
    ).join("\n");

  it("em avisar: o 6º funil passa, fn_billing_bloqueia diz não para funis, a IA segue e conexoes bloqueia", () => {
    const linhas = roda(`
      begin;
      update public.billing_settings set modo = 'avisar' where id = 1;
      ${noPro(ORG_FUNIS)}
      ${funis(ORG_FUNIS, 6)}
      ${conexao(ORG_FUNIS, "waha", 21)}
      ${conexao(ORG_FUNIS, "waha", 22)}
      ${conexao(ORG_FUNIS, "waha", 23)}
      select '${MARCA}' || count(*) from public.crm_pipelines where organization_id = '${ORG_FUNIS}' and name like 'F%';
      select '${MARCA}' || (public.fn_billing_bloqueia('${ORG_FUNIS}'::uuid, 'funis', null))::text;
      select '${MARCA}' || (public.fn_billing_bloqueia('${ORG_FUNIS}'::uuid, 'conexoes', null))::text;
      select '${MARCA}' || (public.fn_billing_ia_pode_responder('${ORG_FUNIS}'::uuid) ->> 'acao');
      rollback;
    `);
    expect(linhas).toEqual(["6", "false", "true", "seguir"]);
  });

  it("em bloquear com carência vencida: o 6º funil também é recusado (o modo continua valendo para eles)", () => {
    const erro = erroDe(`
      begin;
      ${noPro(ORG_FUNIS)}
      ${funis(ORG_FUNIS, 5)}
      update public.billing_settings set modo = 'bloquear' where id = 1;
      update public.billing_contracts set bloqueio_a_partir_de = now() - interval '1 day' where organization_id = '${ORG_FUNIS}';
      insert into public.crm_pipelines (organization_id, name, slug) values ('${ORG_FUNIS}', 'F6', 'i954-f6');
      rollback;
    `);
    expect(erro).toContain("PT402");
    expect(erro).toContain("funis");
  });

  it("em desligado: fn_billing_bloqueia diz não para funis mesmo acima do teto", () => {
    const linhas = roda(`
      begin;
      update public.billing_settings set modo = 'desligado' where id = 1;
      ${noPro(ORG_MODOS)}
      ${funis(ORG_MODOS, 7)}
      select '${MARCA}' || (public.fn_billing_bloqueia('${ORG_MODOS}'::uuid, 'funis', null))::text;
      rollback;
    `);
    expect(linhas).toEqual(["false"]);
  });
});

describe("0954: sem limite no plano, não bloqueia", () => {
  it("Ilimitado: 8 conexões de canais variados, qualquer modo", () => {
    for (const modo of ["avisar", "bloquear"]) {
      const linhas = roda(`
        begin;
        update public.billing_settings set modo = '${modo}' where id = 1;
        ${Array.from({ length: 8 }, (_, i) => conexao(ORG_ILIMITADO, i % 2 ? "uazapi" : "waha", 30 + i)).join("\n")}
        select '${MARCA}' || count(*) from public.channel_sessions where organization_id = '${ORG_ILIMITADO}';
        select '${MARCA}' || (public.fn_billing_bloqueia('${ORG_ILIMITADO}'::uuid, 'conexoes', null))::text;
        rollback;
      `);
      expect(linhas, modo).toEqual(["8", "false"]);
    }
  });

  it("plano Pro com ajuste da organização pondo conexoes em nulo: sem limite, não bloqueia", () => {
    const linhas = roda(`
      begin;
      update public.billing_settings set modo = 'avisar' where id = 1;
      ${noPro(ORG_AJUSTE_NULO)}
      select public.fn_billing_ajustar_limites('${ORG_AJUSTE_NULO}'::uuid, '{"conexoes": null}'::jsonb, null, null);
      ${Array.from({ length: 5 }, (_, i) => conexao(ORG_AJUSTE_NULO, "waha", 40 + i)).join("\n")}
      select '${MARCA}' || count(*) from public.channel_sessions where organization_id = '${ORG_AJUSTE_NULO}';
      rollback;
    `);
    expect(linhas).toEqual(["5"]);
  });
});

describe("0954: conexão que já existe não é afetada", () => {
  it("org com 5 conexões que passa para o Pro: editar a linha passa; nova e desarquivar são barradas", () => {
    const preparo = `
      update public.billing_settings set modo = 'avisar' where id = 1;
      ${Array.from({ length: 5 }, (_, i) => conexao(ORG_EXISTENTES, "waha", 50 + i)).join("\n")}
      update public.channel_sessions set archived_at = now() where id = '${U(1054)}';
      ${noPro(ORG_EXISTENTES)}
    `;
    const editar = roda(`
      begin;
      ${preparo}
      update public.channel_sessions set display_name = 'renomeada', status = 'WORKING' where organization_id = '${ORG_EXISTENTES}' and archived_at is null;
      select '${MARCA}' || count(*) from public.channel_sessions where organization_id = '${ORG_EXISTENTES}' and display_name = 'renomeada';
      rollback;
    `);
    expect(editar).toEqual(["4"]);
    expect(
      erroDe(`begin; ${preparo} ${conexao(ORG_EXISTENTES, "uazapi", 60)} rollback;`),
    ).toContain("PT402");
    expect(
      erroDe(`begin; ${preparo} update public.channel_sessions set archived_at = null where id = '${U(1054)}'; rollback;`),
    ).toContain("PT402");
  });
});

describe("0954: reaplicar com o app no ar", () => {
  it("reaplicar duas vezes mantém a regra e a assinatura da função", () => {
    const corpo = migration.replace(/^begin;\s*$/m, "").replace(/^commit;\s*$/m, "");
    const erro = erroDe(`
      begin;
      ${corpo}
      ${corpo}
      update public.billing_settings set modo = 'avisar' where id = 1;
      ${noPro(ORG_PRO)}
      ${conexao(ORG_PRO, "waha", 70)}
      ${conexao(ORG_PRO, "waha", 71)}
      ${conexao(ORG_PRO, "waha", 72)}
      ${conexao(ORG_PRO, "waha", 73)}
      rollback;
    `);
    expect(erro).toContain("PT402");
    expect(
      sql(`select count(*) from pg_proc where proname = 'fn_billing_bloqueia' and pronamespace = 'public'::regnamespace;`),
    ).toBe("1");
  });

  it("anon e authenticated continuam sem executar fn_billing_bloqueia", () => {
    for (const papel of ["anon", "authenticated"]) {
      const erro = erroDe(`set role ${papel}; select public.fn_billing_bloqueia('${ORG_PRO}'::uuid, 'conexoes', null);`);
      expect(erro, papel).toContain("permission denied");
    }
  });
});
