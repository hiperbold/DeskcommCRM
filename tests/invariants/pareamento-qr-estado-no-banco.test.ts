import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

/**
 * Migration 0953: o estado do pareamento por QR Code mora em colunas que só o SERVIDOR grava, e a
 * criação do pareamento é uma reserva atômica no banco. Provado no Postgres real, nas sessões que o
 * PostgREST de fato usa (`authenticated` com JWT, `service_role`):
 *
 *   1. o admin da organização NÃO altera nenhuma das seis colunas (UPDATE nem INSERT), mas segue editando
 *      o resto da linha, inclusive o `metadata` (que por isso nunca decide nada);
 *   2. o servidor (service_role e a conexão direta) grava as colunas;
 *   3. a função de reserva é só do service_role;
 *   4. a reserva respeita no máximo 2 pendentes, não conta arquivada nem concluída como pendente, e o
 *      teto de conexões: o limite `conexoes` do plano sobre TODAS as conexões não arquivadas da organização
 *      (de qualquer canal; os pendentes já são linhas ativas), senão 50, qualquer que seja
 *      billing_settings.modo;
 *   5. duas reservas simultâneas da mesma organização não passam juntas do limite (trava por organização);
 *   6. reaplicar a migration não perde a linha nem o gatilho;
 *   7. a instância criada pelo CRM não sai por fora do fluxo: o admin não arquiva, não apaga e não troca
 *      servidor, instância ou token de uma linha `criada_pelo_crm` (a linha comum segue como sempre);
 *   8. a reserva recusa a partir de 10 criações na última hora (`taxa_de_criacao`), arquivadas inclusive.
 *
 * Roda via `pnpm test:db tests/invariants/pareamento-qr-estado-no-banco.test.ts`.
 */

const MARCA = "SONDA|";
const U = (n: number) => `0953a000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ORG = U(1);
const ADMIN = U(2);
const ORG_TETO = U(3);
const ORG_PLANO = U(4);
const ORG_MODO = U(5);
const ORG_CORRIDA = U(6);
const ORG_PENDENTES = U(7);
const ORG_TAXA = U(8);
const LINHA = U(10);
const MENSAGEM = "estado do pareamento por QR só pode ser alterado pelo servidor";
const MENSAGEM_INSTANCIA = "a instância criada pelo CRM só pode ser removida ou trocada pelo servidor";
const SERVIDOR = "https://qr.exemplo.com";

const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/20261009100000_0953_pareamento_qr_estado_no_banco.sql"),
  "utf8",
);

function linhasMarcadas(saida: string): string[] {
  return saida
    .split("\n")
    .filter((l) => l.startsWith(MARCA))
    .map((l) => l.slice(MARCA.length));
}
const servidor = (corpo: string) => linhasMarcadas(sql(corpo));
const comoAdmin = `set role authenticated;\nselect set_config('request.jwt.claims', '{"sub":"${ADMIN}"}', false);`;

function erroDe(script: string): string | null {
  try {
    sql(script);
    return null;
  } catch (err) {
    return motivoDoErro(err);
  }
}

/** Roda um script numa sessão psql própria e ASSÍNCRONA (as reservas simultâneas). Mesmo transporte de `sql`. */
function sqlAssincrono(script: string): Promise<string> {
  const container = process.env.TEST_DB_CONTAINER;
  const psqlLocal = process.env.TEST_DB_PSQL;
  const bin = psqlLocal ?? "docker";
  const args = psqlLocal
    ? [process.env.TEST_DB_CONN ?? "postgres://postgres@localhost/postgres", "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"]
    : ["exec", "-i", container as string, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"];
  return new Promise((resolve, reject) => {
    const filho = spawn(bin, args);
    let saida = "";
    let erro = "";
    filho.stdout.on("data", (d) => (saida += d));
    filho.stderr.on("data", (d) => (erro += d));
    filho.on("close", (codigo) => (codigo === 0 ? resolve(saida.trim()) : reject(new Error(erro || `psql saiu com ${codigo}`))));
    filho.stdin.end(script);
  });
}

/** Insere uma linha UAZAPI como o servidor insere (conexão direta), com as colunas do pareamento já escolhidas. */
function inserir(org: string, id: string, n: number, extra: Record<string, string> = {}): string {
  const colunas = {
    id: `'${id}'`,
    organization_id: `'${org}'`,
    provider: `'uazapi'`,
    uazapi_instance_id: `'inst-${n}-${id.slice(-4)}'`,
    uazapi_base_url: `'${SERVIDOR}'`,
    webhook_secret_encrypted: `'\\x00'::bytea`,
    ...extra,
  };
  return `insert into public.channel_sessions (${Object.keys(colunas).join(", ")}) values (${Object.values(colunas).join(", ")});`;
}

const fixture = `
  insert into public.organizations (id, slug, legal_name, display_name) values
    ('${ORG}', 'i953-a', 'i953 LTDA', 'i953'),
    ('${ORG_TETO}', 'i953-b', 'i953 LTDA', 'i953'),
    ('${ORG_PLANO}', 'i953-c', 'i953 LTDA', 'i953'),
    ('${ORG_MODO}', 'i953-d', 'i953 LTDA', 'i953'),
    ('${ORG_CORRIDA}', 'i953-e', 'i953 LTDA', 'i953'),
    ('${ORG_PENDENTES}', 'i953-f', 'i953 LTDA', 'i953'),
    ('${ORG_TAXA}', 'i953-g', 'i953 LTDA', 'i953')
    on conflict (id) do nothing;
  insert into auth.users (id, email) values ('${ADMIN}', 'admin-i953@invariant.test') on conflict (id) do nothing;
  insert into public.user_organizations (user_id, organization_id, role, accepted_at)
    values ('${ADMIN}', '${ORG}', 'admin', now()) on conflict do nothing;
`;

const reservar = (org: string, sessao: string, token = `tok-${sessao}`) =>
  `select '${MARCA}' || public.fn_channel_pareamento_qr_reservar('${org}'::uuid, '${sessao}'::uuid, '${SERVIDOR}', '${token}', '{}'::jsonb)::text;`;

describe("0953: setup", () => {
  it("cria as organizações e o admin", () => {
    sql(fixture);
    expect(sql(`select count(*) from public.organizations where id in ('${ORG}', '${ORG_TETO}', '${ORG_PLANO}', '${ORG_MODO}', '${ORG_CORRIDA}', '${ORG_PENDENTES}', '${ORG_TAXA}');`)).toBe("7");
  });

  it("as seis colunas existem, com o padrão que não mexe em canal comum", () => {
    expect(
      sql(`select string_agg(column_name || ':' || coalesce(column_default, 'nulo') || ':' || is_nullable, ',' order by column_name)
             from information_schema.columns
            where table_schema = 'public' and table_name = 'channel_sessions'
              and column_name in ('pareamento_qr_estado','pareamento_qr_iniciado_em','criada_pelo_crm','pareamento_qr_falhas','pareamento_qr_codigos','pareamento_qr_codigo_em');`),
    ).toBe(
      "criada_pelo_crm:false:NO,pareamento_qr_codigo_em:nulo:YES,pareamento_qr_codigos:0:NO,pareamento_qr_estado:nulo:YES,pareamento_qr_falhas:0:NO,pareamento_qr_iniciado_em:nulo:YES",
    );
  });

  it("o estado só aceita pendente ou concluido, e pendente exige a data de início", () => {
    expect(erroDe(`begin; ${inserir(ORG, LINHA, 1, { pareamento_qr_estado: `'qualquer'` })} rollback;`)).toContain("channel_sessions_pareamento_qr_estado_valido");
    expect(erroDe(`begin; ${inserir(ORG, LINHA, 1, { pareamento_qr_estado: `'pendente'` })} rollback;`)).toContain("channel_sessions_pareamento_qr_pendente_tem_inicio");
    expect(erroDe(`begin; ${inserir(ORG, LINHA, 1, { pareamento_qr_estado: `'pendente'`, pareamento_qr_iniciado_em: "now()" })} rollback;`)).toBeNull();
  });
});

describe("0953: o admin da organização NÃO altera o estado do pareamento", () => {
  const protegidas: Array<[string, string, string]> = [
    ["pareamento_qr_estado", `'pendente'`, `pareamento_qr_estado = 'pendente'`],
    ["pareamento_qr_estado (concluido)", `'concluido'`, `pareamento_qr_estado = 'concluido'`],
    ["pareamento_qr_iniciado_em", `now() - interval '31 minutes'`, `pareamento_qr_iniciado_em = now() - interval '31 minutes'`],
    ["criada_pelo_crm", `true`, `criada_pelo_crm = true`],
    ["pareamento_qr_falhas", `3`, `pareamento_qr_falhas = 3`],
    ["pareamento_qr_codigos", `4`, `pareamento_qr_codigos = 4`],
    ["pareamento_qr_codigo_em", `now()`, `pareamento_qr_codigo_em = now()`],
  ];

  it.each(protegidas)("UPDATE de %s é recusado com 42501 (o PATCH que marcaria uma linha dele como pendente vencida)", (_nome, _valor, atribuicao) => {
    const erro = erroDe(`
      begin;
      ${fixture}
      ${inserir(ORG, LINHA, 1)}
      ${comoAdmin}
      update public.channel_sessions set ${atribuicao} where id = '${LINHA}';
      rollback;
    `);
    expect(erro, `o admin conseguiu gravar ${atribuicao}`).not.toBeNull();
    expect(erro).toContain(MENSAGEM);
  });

  it("a linha não muda quando o UPDATE é recusado", () => {
    const linhas = servidor(`
      begin;
      ${fixture}
      ${inserir(ORG, LINHA, 1)}
      ${comoAdmin}
      do $$
      begin
        begin
          update public.channel_sessions set pareamento_qr_estado = 'pendente', criada_pelo_crm = true,
            pareamento_qr_iniciado_em = now() - interval '2 hours' where id = '${LINHA}';
        exception when insufficient_privilege then
          null;
        end;
      end
      $$;
      reset role;
      select '${MARCA}' || coalesce(pareamento_qr_estado, 'nulo') || '|' || criada_pelo_crm || '|' || coalesce(pareamento_qr_iniciado_em::text, 'nulo')
        from public.channel_sessions where id = '${LINHA}';
      rollback;
    `);
    expect(linhas).toEqual(["nulo|false|nulo"]);
  });

  it("também não troca o valor que o servidor já gravou (limpar a marca de pendente, ou a de criada pelo CRM)", () => {
    for (const atribuicao of [`pareamento_qr_estado = null`, `criada_pelo_crm = false`, `pareamento_qr_falhas = 0`, `pareamento_qr_iniciado_em = now() + interval '1 minute'`]) {
      const erro = erroDe(`
        begin;
        ${fixture}
        ${inserir(ORG, LINHA, 1, { pareamento_qr_estado: `'pendente'`, pareamento_qr_iniciado_em: "now()", criada_pelo_crm: "true", pareamento_qr_falhas: "2" })}
        ${comoAdmin}
        update public.channel_sessions set ${atribuicao} where id = '${LINHA}';
        rollback;
      `);
      expect(erro, `o admin conseguiu gravar ${atribuicao}`).toContain(MENSAGEM);
    }
  });

  it.each([
    ["estado", { pareamento_qr_estado: `'pendente'`, pareamento_qr_iniciado_em: "now()" }],
    ["criada_pelo_crm", { criada_pelo_crm: "true" }],
    ["falhas", { pareamento_qr_falhas: "1" }],
    ["codigos", { pareamento_qr_codigos: "1" }],
    ["codigo_em", { pareamento_qr_codigo_em: "now()" }],
  ])("INSERT já com %s preenchido é recusado", (_nome, colunas) => {
    const erro = erroDe(`
      begin;
      ${fixture}
      ${comoAdmin}
      ${inserir(ORG, LINHA, 1, colunas)}
      rollback;
    `);
    expect(erro).toContain(MENSAGEM);
  });

  it("não atrapalha o resto: o admin cria canal comum e edita nome e metadata (que por isso nunca decide nada)", () => {
    const linhas = servidor(`
      begin;
      ${fixture}
      ${inserir(ORG, LINHA, 1, { pareamento_qr_estado: "null" })}
      ${comoAdmin}
      update public.channel_sessions set display_name = 'Renomeada',
        metadata = '{"pareamento_qr_pendente": true, "criada_pelo_crm": true}'::jsonb where id = '${LINHA}';
      -- Mesmo valor nas colunas vigiadas: não é mudança, passa.
      update public.channel_sessions set criada_pelo_crm = criada_pelo_crm, pareamento_qr_estado = pareamento_qr_estado where id = '${LINHA}';
      reset role;
      select '${MARCA}' || display_name || '|' || (metadata ->> 'pareamento_qr_pendente') || '|' || coalesce(pareamento_qr_estado, 'nulo') || '|' || criada_pelo_crm
        from public.channel_sessions where id = '${LINHA}';
      rollback;
    `);
    // O metadata mente à vontade; a coluna segue dizendo a verdade.
    expect(linhas).toEqual(["Renomeada|true|nulo|false"]);
  });
});

describe("0953: o servidor grava", () => {
  it("service_role e a conexão direta (migração, worker) gravam as colunas", () => {
    const linhas = servidor(`
      begin;
      ${fixture}
      ${inserir(ORG, LINHA, 1)}
      set role service_role;
      update public.channel_sessions set pareamento_qr_estado = 'pendente', pareamento_qr_iniciado_em = now(),
        criada_pelo_crm = true, pareamento_qr_falhas = 2, pareamento_qr_codigos = 1, pareamento_qr_codigo_em = now() where id = '${LINHA}';
      reset role;
      select '${MARCA}' || pareamento_qr_estado || '|' || criada_pelo_crm || '|' || pareamento_qr_falhas || '|' || pareamento_qr_codigos from public.channel_sessions where id = '${LINHA}';
      update public.channel_sessions set pareamento_qr_estado = 'concluido' where id = '${LINHA}';
      select '${MARCA}' || pareamento_qr_estado from public.channel_sessions where id = '${LINHA}';
      rollback;
    `);
    expect(linhas).toEqual(["pendente|true|2|1", "concluido"]);
  });
});

describe("0953: a função de reserva é só do servidor", () => {
  it.each(["anon", "authenticated"])("%s não executa", (papel) => {
    const erro = erroDe(`
      begin;
      ${fixture}
      set role ${papel};
      ${reservar(ORG, U(20))}
      rollback;
    `);
    expect(erro).toContain("permission denied");
  });

  it("service_role executa, e a linha nasce com o estado, o servidor e o token provisório", () => {
    const linhas = servidor(`
      begin;
      ${fixture}
      set role service_role;
      ${reservar(ORG, U(20), "tokencaminho")}
      reset role;
      select '${MARCA}' || pareamento_qr_estado || '|' || criada_pelo_crm || '|' || status || '|' || uazapi_instance_id || '|' || uazapi_base_url || '|' || webhook_path_token || '|' || (pareamento_qr_iniciado_em is not null) || '|' || (archived_at is null)
        from public.channel_sessions where id = '${U(20)}';
      rollback;
    `);
    expect(linhas).toEqual([`{"id": "${U(20)}", "ok": true}`, `pendente|true|STARTING|pendente-${U(20)}|${SERVIDOR}|tokencaminho|true|true`]);
  });

  it("organização que não existe: recusa com P0002", () => {
    expect(erroDe(`begin; ${reservar(U(99), U(21))} rollback;`)).toContain("pareamento_qr_organizacao_inexistente");
  });
});

describe("0953: no máximo 2 pendentes por organização", () => {
  it("a terceira é recusada com pendentes_demais, sem inserir; arquivada e concluída não contam", () => {
    const linhas = servidor(`
      begin;
      ${fixture}
      ${reservar(ORG_PENDENTES, U(30))}
      ${reservar(ORG_PENDENTES, U(31))}
      ${reservar(ORG_PENDENTES, U(32))}
      select '${MARCA}' || count(*) from public.channel_sessions where organization_id = '${ORG_PENDENTES}';
      -- Concluir uma libera a vaga de pendente...
      update public.channel_sessions set pareamento_qr_estado = 'concluido' where id = '${U(30)}';
      ${reservar(ORG_PENDENTES, U(33))}
      -- ...e arquivar a outra também.
      update public.channel_sessions set archived_at = now(), pareamento_qr_estado = null where id = '${U(31)}';
      ${reservar(ORG_PENDENTES, U(34))}
      rollback;
    `);
    expect(linhas).toEqual([
      `{"id": "${U(30)}", "ok": true}`,
      `{"id": "${U(31)}", "ok": true}`,
      `{"ok": false, "codigo": "pendentes_demais"}`,
      "2",
      `{"id": "${U(33)}", "ok": true}`,
      `{"id": "${U(34)}", "ok": true}`,
    ]);
  });

  it("não olha o metadata: um metadata dizendo 'pendente' numa linha comum não ocupa vaga", () => {
    const linhas = servidor(`
      begin;
      ${fixture}
      ${inserir(ORG_PENDENTES, U(40), 1)}
      update public.channel_sessions set metadata = '{"pareamento_qr_pendente": true}'::jsonb where id = '${U(40)}';
      ${reservar(ORG_PENDENTES, U(41))}
      ${reservar(ORG_PENDENTES, U(42))}
      rollback;
    `);
    expect(linhas).toEqual([`{"id": "${U(41)}", "ok": true}`, `{"id": "${U(42)}", "ok": true}`]);
  });
});

describe("0953: o teto de conexões da reserva (limite do plano sobre todas as conexões ativas)", () => {
  /** n linhas comuns, ativas, de qualquer canal (não criadas pelo CRM). */
  const comuns = (org: string, quantas: number, base: number) =>
    Array.from({ length: quantas }, (_, i) => inserir(org, U(base + i), base + i)).join("\n");
  /** n linhas concluídas, criadas pelo CRM, ativas. */
  const criadas = (org: string, quantas: number, base: number) =>
    Array.from({ length: quantas }, (_, i) => inserir(org, U(base + i), base + i, { criada_pelo_crm: "true", pareamento_qr_estado: `'concluido'` })).join("\n");

  it("sem limite no plano: o teto de segurança é 50, contando conexões de qualquer origem e as pendentes", () => {
    const linhas = servidor(`
      begin;
      ${fixture}
      ${comuns(ORG_TETO, 30, 100)}
      ${criadas(ORG_TETO, 19, 140)}
      ${reservar(ORG_TETO, U(200))}
      update public.channel_sessions set pareamento_qr_estado = 'concluido' where id = '${U(200)}';
      ${reservar(ORG_TETO, U(201))}
      rollback;
    `);
    expect(linhas).toEqual([`{"id": "${U(200)}", "ok": true}`, `{"ok": false, "teto": 50, "codigo": "teto_de_instancias", "do_plano": false}`]);
  });

  it("conexão comum conta; arquivada não conta", () => {
    const linhas = servidor(`
      begin;
      ${fixture}
      insert into public.billing_plan_adjustments (organization_id, limits) values ('${ORG_TETO}', '{"conexoes": 3}'::jsonb);
      ${comuns(ORG_TETO, 2, 300)}
      ${Array.from({ length: 5 }, (_, i) => inserir(ORG_TETO, U(320 + i), 320 + i, { criada_pelo_crm: "true", archived_at: "now()" })).join("\n")}
      ${reservar(ORG_TETO, U(340))}
      ${reservar(ORG_TETO, U(341))}
      rollback;
    `);
    expect(linhas).toEqual([`{"id": "${U(340)}", "ok": true}`, `{"ok": false, "teto": 3, "codigo": "teto_de_instancias", "do_plano": true}`]);
  });

  it("o limite conexoes do plano vale, com 3 conexões comuns já no limite", () => {
    const linhas = servidor(`
      begin;
      ${fixture}
      insert into public.billing_plan_adjustments (organization_id, limits) values ('${ORG_PLANO}', '{"conexoes": 3}'::jsonb);
      ${comuns(ORG_PLANO, 3, 400)}
      ${reservar(ORG_PLANO, U(410))}
      select '${MARCA}' || count(*) from public.channel_sessions where organization_id = '${ORG_PLANO}';
      rollback;
    `);
    expect(linhas).toEqual([`{"ok": false, "teto": 3, "codigo": "teto_de_instancias", "do_plano": true}`, "3"]);
  });

  it("limite do plano acima de 10 vale como está (não é mais cortado em 10)", () => {
    const linhas = servidor(`
      begin;
      ${fixture}
      insert into public.billing_plan_adjustments (organization_id, limits) values ('${ORG_PLANO}', '{"conexoes": 500}'::jsonb);
      ${criadas(ORG_PLANO, 12, 500)}
      ${reservar(ORG_PLANO, U(520))}
      rollback;
    `);
    expect(linhas).toEqual([`{"id": "${U(520)}", "ok": true}`]);
  });

  it("o teto não depende de billing_settings.modo (desligado, avisar e bloquear respondem igual)", () => {
    for (const modo of ["desligado", "avisar", "bloquear"]) {
      const linhas = servidor(`
        begin;
        ${fixture}
        update public.billing_settings set modo = '${modo}' where id = 1;
        insert into public.billing_plan_adjustments (organization_id, limits) values ('${ORG_MODO}', '{"conexoes": 2}'::jsonb);
        ${criadas(ORG_MODO, 2, 600)}
        ${reservar(ORG_MODO, U(610))}
        rollback;
      `);
      expect(linhas, `modo ${modo}`).toEqual([`{"ok": false, "teto": 2, "codigo": "teto_de_instancias", "do_plano": true}`]);
    }
  });
});

describe("0953: duas reservas simultâneas da mesma organização não passam juntas", () => {
  it("com um pendente já existente, de duas reservas ao mesmo tempo só uma passa (trava por organização)", async () => {
    sql(`
      ${fixture}
      delete from public.channel_sessions where organization_id = '${ORG_CORRIDA}';
      ${reservar(ORG_CORRIDA, U(700))}
    `);
    // Cada sessão segura a trava por um instante depois de reservar: a outra espera e, ao entrar, enxerga a linha da primeira.
    const sessao = (id: string) => `
      begin;
      ${reservar(ORG_CORRIDA, id)}
      select pg_sleep(1.5);
      commit;
    `;
    const [a, b] = await Promise.all([sqlAssincrono(sessao(U(701))), sqlAssincrono(sessao(U(702)))]);
    const respostas = [a, b].map((saida) => linhasMarcadas(saida)[0]!);
    const passaram = respostas.filter((r) => r.includes(`"ok": true`));
    const barradas = respostas.filter((r) => r.includes("pendentes_demais"));
    expect(passaram).toHaveLength(1);
    expect(barradas).toHaveLength(1);
    expect(
      sql(`select count(*) from public.channel_sessions where organization_id = '${ORG_CORRIDA}' and pareamento_qr_estado = 'pendente';`),
    ).toBe("2");
    sql(`delete from public.channel_sessions where organization_id = '${ORG_CORRIDA}';`);
  }, 30_000);
});

describe("0953: a instância criada pelo CRM só sai pelo servidor", () => {
  /** Linha criada pelo CRM e já concluída (a instância existe no servidor). */
  const doCrm = () => inserir(ORG, LINHA, 1, { criada_pelo_crm: "true", pareamento_qr_estado: `'concluido'` });

  it.each([
    ["archived_at", `archived_at = now()`],
    ["uazapi_instance_id", `uazapi_instance_id = 'outra-instancia'`],
    ["uazapi_token_encrypted", `uazapi_token_encrypted = 'outro-token'`],
    ["uazapi_base_url", `uazapi_base_url = 'https://servidor-do-admin.exemplo.com'`],
    ["provider", `provider = 'waha'`],
    ["webhook_secret_encrypted", `webhook_secret_encrypted = 'segredo-trocado-pelo-admin'`],
  ])("o admin não muda %s de uma linha criada pelo CRM (42501)", (_nome, atribuicao) => {
    const erro = erroDe(`
      begin;
      ${fixture}
      ${doCrm()}
      ${comoAdmin}
      update public.channel_sessions set ${atribuicao} where id = '${LINHA}';
      rollback;
    `);
    expect(erro, `o admin conseguiu gravar ${atribuicao}`).toContain(MENSAGEM_INSTANCIA);
  });

  it("o admin não apaga a linha criada pelo CRM, e ela continua lá, ativa", () => {
    const erro = erroDe(`
      begin;
      ${fixture}
      ${doCrm()}
      ${comoAdmin}
      delete from public.channel_sessions where id = '${LINHA}';
      rollback;
    `);
    expect(erro).toContain(MENSAGEM_INSTANCIA);

    const linhas = servidor(`
      begin;
      ${fixture}
      ${doCrm()}
      ${comoAdmin}
      do $$
      begin
        begin
          delete from public.channel_sessions where id = '${LINHA}';
        exception when insufficient_privilege then null;
        end;
        begin
          update public.channel_sessions set archived_at = now() where id = '${LINHA}';
        exception when insufficient_privilege then null;
        end;
      end
      $$;
      reset role;
      select '${MARCA}' || count(*) || '|' || (archived_at is null) from public.channel_sessions where id = '${LINHA}' group by archived_at;
      rollback;
    `);
    expect(linhas).toEqual(["1|true"]);
  });

  it("o admin segue editando o resto da linha do CRM (nome, status, metadata)", () => {
    const linhas = servidor(`
      begin;
      ${fixture}
      ${doCrm()}
      ${comoAdmin}
      update public.channel_sessions set display_name = 'Renomeada', status = 'WORKING', metadata = '{"a": 1}'::jsonb where id = '${LINHA}';
      reset role;
      select '${MARCA}' || display_name || '|' || status from public.channel_sessions where id = '${LINHA}';
      rollback;
    `);
    expect(linhas).toEqual(["Renomeada|WORKING"]);
  });

  it("linha comum (não criada pelo CRM) continua como hoje: o admin arquiva, troca o token e apaga", () => {
    const linhas = servidor(`
      begin;
      ${fixture}
      ${inserir(ORG, LINHA, 1)}
      ${inserir(ORG, U(11), 2)}
      ${comoAdmin}
      update public.channel_sessions set uazapi_token_encrypted = 'novo', uazapi_instance_id = 'trocada' where id = '${LINHA}';
      update public.channel_sessions set archived_at = now() where id = '${LINHA}';
      delete from public.channel_sessions where id = '${U(11)}';
      reset role;
      select '${MARCA}' || (archived_at is not null) || '|' || uazapi_instance_id from public.channel_sessions where id = '${LINHA}';
      select '${MARCA}' || count(*) from public.channel_sessions where id = '${U(11)}';
      rollback;
    `);
    expect(linhas).toEqual(["true|trocada", "0"]);
  });

  it("o servidor (service_role) arquiva, troca e apaga a linha do CRM", () => {
    const linhas = servidor(`
      begin;
      ${fixture}
      ${doCrm()}
      ${inserir(ORG, U(11), 2, { criada_pelo_crm: "true", pareamento_qr_estado: `'concluido'` })}
      set role service_role;
      update public.channel_sessions set archived_at = now(), uazapi_instance_id = 'trocada' where id = '${LINHA}';
      delete from public.channel_sessions where id = '${U(11)}';
      reset role;
      select '${MARCA}' || (archived_at is not null) || '|' || uazapi_instance_id from public.channel_sessions where id = '${LINHA}';
      select '${MARCA}' || count(*) from public.channel_sessions where id = '${U(11)}';
      rollback;
    `);
    expect(linhas).toEqual(["true|trocada", "0"]);
  });
});

describe("0953: freio de taxa dentro da reserva (10 criações por hora, arquivadas inclusive)", () => {
  /** n instâncias que o CRM criou e já arquivou, iniciadas `quando` atrás. */
  const criadasArquivadas = (quantas: number, base: number, quando: string) =>
    Array.from({ length: quantas }, (_, i) =>
      inserir(ORG_TAXA, U(base + i), base + i, {
        criada_pelo_crm: "true",
        archived_at: "now()",
        pareamento_qr_iniciado_em: `now() - interval '${quando}'`,
      }),
    ).join("\n");

  it("com 10 criações na última hora, mesmo todas arquivadas, a reserva recusa com taxa_de_criacao e não insere", () => {
    const linhas = servidor(`
      begin;
      ${fixture}
      ${criadasArquivadas(10, 900, "5 minutes")}
      ${reservar(ORG_TAXA, U(950))}
      select '${MARCA}' || count(*) from public.channel_sessions where id = '${U(950)}';
      rollback;
    `);
    expect(linhas).toEqual([`{"ok": false, "codigo": "taxa_de_criacao"}`, "0"]);
  });

  it("com 9 criações passa (a décima ainda é permitida)", () => {
    const linhas = servidor(`
      begin;
      ${fixture}
      ${criadasArquivadas(9, 900, "5 minutes")}
      ${reservar(ORG_TAXA, U(950))}
      rollback;
    `);
    expect(linhas).toEqual([`{"id": "${U(950)}", "ok": true}`]);
  });

  it("criação de mais de uma hora atrás não conta, e linha que o CRM não criou também não", () => {
    const linhas = servidor(`
      begin;
      ${fixture}
      ${criadasArquivadas(10, 900, "2 hours")}
      ${Array.from({ length: 10 }, (_, i) => inserir(ORG_TAXA, U(930 + i), 930 + i, { archived_at: "now()", pareamento_qr_iniciado_em: "now()" })).join("\n")}
      ${reservar(ORG_TAXA, U(950))}
      rollback;
    `);
    expect(linhas).toEqual([`{"id": "${U(950)}", "ok": true}`]);
  });

  it("não vale para outra organização", () => {
    const linhas = servidor(`
      begin;
      ${fixture}
      ${criadasArquivadas(10, 900, "5 minutes")}
      ${reservar(ORG_PENDENTES, U(951))}
      rollback;
    `);
    expect(linhas).toEqual([`{"id": "${U(951)}", "ok": true}`]);
  });
});

describe("0953: reaplicar com o app no ar", () => {
  it("reaplicar duas vezes não perde a linha nem os valores, e o gatilho e a função continuam", () => {
    const linhas = servidor(`
      begin;
      ${fixture}
      ${inserir(ORG, LINHA, 1, { pareamento_qr_estado: `'pendente'`, pareamento_qr_iniciado_em: "now()", criada_pelo_crm: "true", pareamento_qr_falhas: "2" })}
      ${migration.replace(/^begin;\s*$/m, "").replace(/^commit;\s*$/m, "")}
      ${migration.replace(/^begin;\s*$/m, "").replace(/^commit;\s*$/m, "")}
      select '${MARCA}' || pareamento_qr_estado || '|' || criada_pelo_crm || '|' || pareamento_qr_falhas from public.channel_sessions where id = '${LINHA}';
      select '${MARCA}' || count(*) from pg_trigger where tgname = 'trg_channel_sessions_trava_pareamento_qr' and not tgisinternal;
      select '${MARCA}' || count(*) from pg_proc where proname = 'fn_channel_pareamento_qr_reservar';
      rollback;
    `);
    expect(linhas).toEqual(["pendente|true|2", "1", "1"]);
  });

  it("depois de reaplicar, o admin continua barrado e anon/authenticated continuam sem executar", () => {
    const erro = erroDe(`
      begin;
      ${fixture}
      ${inserir(ORG, LINHA, 1)}
      ${migration.replace(/^begin;\s*$/m, "").replace(/^commit;\s*$/m, "")}
      ${comoAdmin}
      update public.channel_sessions set criada_pelo_crm = true where id = '${LINHA}';
      rollback;
    `);
    expect(erro).toContain(MENSAGEM);
    expect(erroDe(`set role authenticated;\n${reservar(ORG, U(800))}`)).toContain("permission denied");
  });
});
