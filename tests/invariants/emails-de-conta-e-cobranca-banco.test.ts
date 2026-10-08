/**
 * Migração 0952: a fila de envio dos e-mails de conta e de cobrança (`billing_emails_enviados`). Provado no
 * Postgres real, como o envio o usa:
 *
 *   1. a unicidade (organização, e-mail, chave) é a idempotência: o `insert ... on conflict do nothing` do
 *      enfileiramento entra uma vez só, também quando duas sessões enfileiram ao mesmo tempo;
 *   2. a mesma chave vale em outra organização, e outra chave/outro e-mail da mesma organização é outro fato;
 *   3. o formato do código do e-mail, o tamanho da chave e o resultado em objeto são cobrados pelo banco;
 *   4. o resultado por destinatário é gravado na linha;
 *   5. só o servidor lê e grava: RLS ligada sem policy, anon e authenticated barrados, service_role sem
 *      delete/truncate, e a cascata leva o histórico junto com a organização;
 *   6. reaplicar a migration com o app no ar não perde nem duplica linha;
 *   7. as colunas da fila e os valores que o banco cobra (status, destino com criador, enviado com data,
 *      código de erro classificado), com o índice parcial da fila;
 *   8. o claim `fn_billing_emails_reservar_lote`: marca enviando, conta a tentativa, empurra a hora, respeita
 *      limite e hora marcada, devolve a reserva vencida, esgota em falhou e NUNCA entrega a mesma linha a duas
 *      sessões ao mesmo tempo (`for update skip locked`, provado com sessões psql paralelas);
 *   9. o EXECUTE do claim é só do service_role (as duas origens, public e anon/authenticated);
 *  10. a migration reaplica sobre a versão anterior (só a tabela de registro) sem perder a linha.
 *
 * Roda via `pnpm test:db tests/invariants/emails-de-conta-e-cobranca-banco.test.ts`.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

const U = (n: number) => `0952a000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ORG_A = U(1);
const ORG_B = U(2);
const ORG_ACL = U(3);
const ORG_CASCATA = U(4);
const ORG_REAPLICA = U(5);
const ORG_FILA = U(6);
const ORG_CLAIM = U(7);
const ORG_ATUALIZA = U(8);
const ORGS = [ORG_A, ORG_B, ORG_ACL, ORG_CASCATA, ORG_REAPLICA, ORG_FILA, ORG_CLAIM, ORG_ATUALIZA];

const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/20261008170000_0952_emails_de_conta_e_cobranca.sql"),
  "utf8",
);

function erroDe(comando: string): string | null {
  try {
    sql(comando);
    return null;
  } catch (err) {
    return motivoDoErro(err);
  }
}

/** A reserva que o envio faz: devolve quantas linhas foram inseridas (1 = reservou; 0 = já existia). */
function reservar(org: string, emailId: string, chave: string): number {
  return Number(
    sql(`
      with r as (
        insert into public.billing_emails_enviados (organization_id, email_id, chave)
        values ('${org}', '${emailId}', '${chave}')
        on conflict (organization_id, email_id, chave) do nothing
        returning id
      )
      select count(*) from r;
    `),
  );
}

function linhas(org: string): string {
  return sql(`select count(*) from public.billing_emails_enviados where organization_id = '${org}';`);
}

describe("0952: setup", () => {
  it("cria as organizações", () => {
    sql(
      ORGS.map(
        (id) =>
          `insert into public.organizations (id, slug, legal_name, display_name) values ('${id}', 'i952-${id.slice(-2)}', 'i952 LTDA', 'i952') on conflict (id) do nothing;`,
      ).join("\n"),
    );
    expect(sql(`select count(*) from public.organizations where id = any(array[${ORGS.map((id) => `'${id}'`).join(",")}]::uuid[]);`)).toBe(String(ORGS.length));
  });
});

describe("0952 item 1 e 2: a unicidade é a idempotência", () => {
  it("a primeira reserva insere; a segunda, igual, não insere (on conflict do nothing)", () => {
    expect(reservar(ORG_A, "COB-02", "pedido:p-1")).toBe(1);
    expect(reservar(ORG_A, "COB-02", "pedido:p-1")).toBe(0);
    expect(linhas(ORG_A)).toBe("1");
  });

  it("duas sessões reservando o mesmo fato ao mesmo tempo: só uma ganha", () => {
    const script = `
      insert into public.billing_emails_enviados (organization_id, email_id, chave)
      values ('${ORG_A}', 'COB-05', 'pagamento:pay_corrida') on conflict (organization_id, email_id, chave) do nothing;
    `;
    // duas chamadas psql seguidas: o resultado tem de ser uma linha, qualquer que seja a ordem
    sql(script);
    sql(script);
    expect(sql(`select count(*) from public.billing_emails_enviados where organization_id = '${ORG_A}' and chave = 'pagamento:pay_corrida';`)).toBe("1");
  });

  it("a mesma chave em outra organização, outro e-mail ou outra chave são outros fatos", () => {
    expect(reservar(ORG_B, "COB-02", "pedido:p-1")).toBe(1);
    expect(reservar(ORG_A, "COB-03", "pedido:p-1")).toBe(1);
    expect(reservar(ORG_A, "COB-02", "pedido:p-2")).toBe(1);
  });

  it("insert simples duplicado é recusado pela unicidade", () => {
    const erro = erroDe(
      `insert into public.billing_emails_enviados (organization_id, email_id, chave) values ('${ORG_A}', 'COB-02', 'pedido:p-1');`,
    );
    expect(erro).not.toBeNull();
    expect(erro).toContain("billing_emails_enviados_org_email_chave_unique");
  });
});

describe("0952 item 3: o banco cobra o formato", () => {
  it.each([
    ["código do e-mail em minúsculas", "cob-02", "x"],
    ["código do e-mail sem número", "COB", "x"],
    ["código do e-mail vazio", "", "x"],
    ["chave vazia", "COB-02", ""],
  ])("recusa %s", (_nome, emailId, chave) => {
    const erro = erroDe(
      `insert into public.billing_emails_enviados (organization_id, email_id, chave) values ('${ORG_A}', '${emailId}', '${chave}');`,
    );
    expect(erro).not.toBeNull();
    expect(erro).toContain("violates check constraint");
  });

  it("recusa chave com mais de 200 caracteres", () => {
    const erro = erroDe(
      `insert into public.billing_emails_enviados (organization_id, email_id, chave) values ('${ORG_A}', 'COB-02', '${"x".repeat(201)}');`,
    );
    expect(erro).toContain("billing_emails_enviados_chave_tamanho");
  });

  it("recusa organização que não existe e resultado que não é objeto", () => {
    expect(
      erroDe(`insert into public.billing_emails_enviados (organization_id, email_id, chave) values ('${U(99)}', 'COB-02', 'x');`),
    ).toContain("foreign key");
    expect(
      erroDe(`insert into public.billing_emails_enviados (organization_id, email_id, chave, resultado) values ('${ORG_A}', 'COB-02', 'r', '[]'::jsonb);`),
    ).toContain("billing_emails_enviados_resultado_objeto");
  });

  it("aceita os códigos que o envio usa", () => {
    for (const [i, id] of ["CONTA-06", "COB-02", "COB-03", "COB-05", "COB-08", "COB-09", "IA-02"].entries()) {
      expect(reservar(ORG_ACL, id, `formato-${i}`)).toBe(1);
    }
  });
});

describe("0952 item 4: o resultado por destinatário", () => {
  it("é gravado na linha reservada e tem objeto vazio como padrão", () => {
    expect(sql(`select resultado::text from public.billing_emails_enviados where organization_id = '${ORG_A}' and chave = 'pedido:p-2';`)).toBe("{}");
    sql(`
      update public.billing_emails_enviados
         set resultado = '{"enviados":1,"falhas":0,"destinatarios":[{"para":"d***@x.com","tipo":"cliente","ok":true}]}'::jsonb
       where organization_id = '${ORG_A}' and chave = 'pedido:p-2';
    `);
    expect(sql(`select resultado->>'enviados' from public.billing_emails_enviados where organization_id = '${ORG_A}' and chave = 'pedido:p-2';`)).toBe("1");
  });
});

describe("0952 item 5: só o servidor lê e grava", () => {
  it("RLS ligada e nenhuma policy", () => {
    expect(sql(`select relrowsecurity::text from pg_class where oid = 'public.billing_emails_enviados'::regclass;`)).toBe("true");
    expect(sql(`select count(*) from pg_policies where schemaname = 'public' and tablename = 'billing_emails_enviados';`)).toBe("0");
  });

  it.each(["anon", "authenticated"] as const)("%s não lê, não insere, não altera e não apaga a tabela", (papel) => {
    const barrado = (comando: string) => {
      const erro = erroDe(`set role ${papel};\n${comando};`);
      expect(erro, `${papel}: ${comando}`).not.toBeNull();
      expect(erro).toContain("permission denied");
    };
    barrado("select id from public.billing_emails_enviados limit 1");
    barrado(`insert into public.billing_emails_enviados (organization_id, email_id, chave) values ('${ORG_ACL}', 'COB-02', 'intruso')`);
    barrado("update public.billing_emails_enviados set resultado = '{}'::jsonb");
    barrado("delete from public.billing_emails_enviados");
  });

  it("service_role lê, insere e altera, mas não apaga nem esvazia a tabela", () => {
    expect(erroDe(`set role service_role;\nselect count(*) from public.billing_emails_enviados;`)).toBeNull();
    expect(
      erroDe(`set role service_role;\ninsert into public.billing_emails_enviados (organization_id, email_id, chave) values ('${ORG_ACL}', 'COB-08', 'servidor');`),
    ).toBeNull();
    expect(erroDe(`set role service_role;\nupdate public.billing_emails_enviados set resultado = '{"ok":true}'::jsonb where chave = 'servidor';`)).toBeNull();
    for (const comando of ["delete from public.billing_emails_enviados", "truncate public.billing_emails_enviados"]) {
      const erro = erroDe(`set role service_role;\n${comando};`);
      expect(erro, comando).not.toBeNull();
      expect(erro).toContain("permission denied");
    }
  });

  it("apagar a organização leva o histórico junto (cascata), sem deixar linha órfã", () => {
    expect(reservar(ORG_CASCATA, "CONTA-06", `organizacao:${ORG_CASCATA}`)).toBe(1);
    expect(linhas(ORG_CASCATA)).toBe("1");
    sql(`delete from public.organizations where id = '${ORG_CASCATA}';`);
    expect(linhas(ORG_CASCATA)).toBe("0");
  });
});

describe("0952 item 6: reaplicar com o app no ar", () => {
  it("rodar a migration de novo não perde, não duplica e não reabre a reserva", () => {
    expect(reservar(ORG_REAPLICA, "COB-02", "pedido:reaplica")).toBe(1);
    const antes = sql(`select count(*) from public.billing_emails_enviados;`);
    sql(migration);
    sql(migration);
    expect(sql(`select count(*) from public.billing_emails_enviados;`)).toBe(antes);
    expect(reservar(ORG_REAPLICA, "COB-02", "pedido:reaplica")).toBe(0);
  });

  it("depois de reaplicar, a tabela continua fechada para anon e authenticated", () => {
    for (const papel of ["anon", "authenticated"]) {
      const erro = erroDe(`set role ${papel};\nselect id from public.billing_emails_enviados limit 1;`);
      expect(erro).toContain("permission denied");
    }
  });
});

/** Roda um script numa sessão psql própria e ASSÍNCRONA (as sessões paralelas do claim). Mesmo transporte de `sql`. */
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

/** Enfileira um e-mail como o gatilho faz; `extra` são colunas a mais, com o valor já como expressão SQL. */
function enfileirar(org: string, chave: string, extra: Record<string, string> = {}): string {
  const colunas = ["organization_id", "email_id", "chave", "dados", ...Object.keys(extra)];
  const valores = [`'${org}'`, `'COB-02'`, `'${chave}'`, `'{"plano":"Pro"}'::jsonb`, ...Object.values(extra)];
  return sql(`insert into public.billing_emails_enviados (${colunas.join(", ")}) values (${valores.join(", ")});`);
}

describe("0952 item 7: a fila (colunas, valores cobrados, índice)", () => {
  it("a linha enfileirada nasce pendente, sem tentativa, com a hora de agora e a cópia desligada", () => {
    enfileirar(ORG_FILA, "padrao");
    expect(
      sql(`select status || '|' || tentativas || '|' || destino || '|' || copia_para_operador || '|' || (proxima_tentativa_em <= now())::text || '|' || coalesce(enviado_em::text, 'nulo') || '|' || coalesce(ultimo_erro, 'nulo') from public.billing_emails_enviados where organization_id = '${ORG_FILA}' and chave = 'padrao';`),
    ).toBe("pendente|0|admins|false|true|nulo|nulo");
  });

  it.each([
    ["status fora da lista", `update public.billing_emails_enviados set status = 'enviado_ou_nao' where chave = 'padrao'`, "billing_emails_enviados_status_valido"],
    ["destino fora da lista", `update public.billing_emails_enviados set destino = 'todos' where chave = 'padrao'`, "billing_emails_enviados_destino_valido"],
    ["destino criador sem criador", `update public.billing_emails_enviados set destino = 'criador' where chave = 'padrao'`, "billing_emails_enviados_criador_exigido"],
    ["enviado sem a hora do envio", `update public.billing_emails_enviados set status = 'enviado' where chave = 'padrao'`, "billing_emails_enviados_enviado_com_data"],
    ["dados que não é objeto", `update public.billing_emails_enviados set dados = '[]'::jsonb where chave = 'padrao'`, "billing_emails_enviados_dados_objeto"],
    ["erro com texto cru em vez de código", `update public.billing_emails_enviados set ultimo_erro = 'Connection refused to dono@x.com' where chave = 'padrao'`, "billing_emails_enviados_ultimo_erro_codigo"],
    ["tentativas negativas", `update public.billing_emails_enviados set tentativas = -1 where chave = 'padrao'`, "billing_emails_enviados_tentativas_faixa"],
  ])("recusa %s", (_nome, comando, restricao) => {
    const erro = erroDe(`${comando};`);
    expect(erro).not.toBeNull();
    expect(erro).toContain(restricao);
  });

  it("aceita destino criador com criador, enviado com data e código de erro classificado", () => {
    expect(
      erroDe(`update public.billing_emails_enviados set destino = 'criador', criador_user_id = gen_random_uuid() where chave = 'padrao';`),
    ).toBeNull();
    expect(
      erroDe(`update public.billing_emails_enviados set status = 'enviado', enviado_em = now(), ultimo_erro = 'send_failed' where chave = 'padrao';`),
    ).toBeNull();
  });

  it("o índice da fila é parcial: só pendente e enviando, por proxima_tentativa_em", () => {
    const def = sql(`select indexdef from pg_indexes where schemaname = 'public' and indexname = 'billing_emails_enviados_fila_idx';`);
    expect(def).toContain("(proxima_tentativa_em)");
    expect(def).toMatch(/WHERE \(status = ANY \(ARRAY\['pendente'(::text)?, 'enviando'(::text)?\]\)\)/);
  });
});

describe("0952 item 8: o claim do lote", () => {
  // Os itens anteriores deixaram linhas pendentes de outras organizações; o claim pega de qualquer uma.
  beforeAll(() => {
    sql(`update public.billing_emails_enviados set status = 'enviado', enviado_em = now() where status in ('pendente', 'enviando');`);
  });

  const claim = (limite: number, extra = "") =>
    sql(`select id from public.fn_billing_emails_reservar_lote(${limite}${extra}) order by id;`)
      .split("\n")
      .filter(Boolean);
  const campo = (chave: string, coluna: string) =>
    sql(`select ${coluna}::text from public.billing_emails_enviados where organization_id = '${ORG_CLAIM}' and chave = '${chave}';`);

  it("pega só pendente com a hora chegada, marca enviando, conta a tentativa e empurra a hora em 5 minutos", () => {
    enfileirar(ORG_CLAIM, "ja");
    enfileirar(ORG_CLAIM, "futura", { proxima_tentativa_em: "now() + interval '1 hour'" });
    enfileirar(ORG_CLAIM, "enviada", { status: "'enviado'", enviado_em: "now()" });

    const ids = claim(20);
    expect(ids).toHaveLength(1);
    expect(campo("ja", "status")).toBe("enviando");
    expect(campo("ja", "tentativas")).toBe("1");
    expect(sql(`select (proxima_tentativa_em between now() + interval '299 seconds' and now() + interval '301 seconds')::text from public.billing_emails_enviados where organization_id = '${ORG_CLAIM}' and chave = 'ja';`)).toBe("true");
    // a futura e a já enviada ficam como estavam
    expect(campo("futura", "status")).toBe("pendente");
    expect(campo("futura", "tentativas")).toBe("0");
    expect(campo("enviada", "status")).toBe("enviado");
    // reserva viva: nova chamada não devolve a mesma linha
    expect(claim(20)).toEqual([]);
  });

  it("devolve as linhas inteiras (o envio lê dados, destino, criador e cópia delas)", () => {
    enfileirar(ORG_CLAIM, "inteira");
    expect(
      sql(`select organization_id || '|' || email_id || '|' || destino || '|' || dados::text from public.fn_billing_emails_reservar_lote(20) where chave = 'inteira';`),
    ).toBe(`${ORG_CLAIM}|COB-02|admins|{"plano": "Pro"}`);
  });

  it("respeita o limite do lote e a ordem (a mais antiga primeiro)", () => {
    for (const [i, chave] of ["l1", "l2", "l3", "l4"].entries()) {
      enfileirar(ORG_CLAIM, chave, { proxima_tentativa_em: `now() - interval '${10 - i} minutes'` });
    }
    const pegas = sql(`select chave from public.fn_billing_emails_reservar_lote(2) order by proxima_tentativa_em, chave;`);
    expect(pegas.split("\n").sort()).toEqual(["l1", "l2"]);
    expect(campo("l3", "status")).toBe("pendente");
    // as outras duas saem na rodada seguinte
    expect(claim(20)).toHaveLength(2);
  });

  it("reserva que venceu volta ao lote (o processo morreu no meio) e conta a tentativa de novo", () => {
    enfileirar(ORG_CLAIM, "morreu");
    expect(claim(20)).toHaveLength(1);
    expect(campo("morreu", "tentativas")).toBe("1");
    sql(`update public.billing_emails_enviados set proxima_tentativa_em = now() - interval '1 minute' where organization_id = '${ORG_CLAIM}' and chave = 'morreu';`);
    expect(claim(20)).toHaveLength(1);
    expect(campo("morreu", "status")).toBe("enviando");
    expect(campo("morreu", "tentativas")).toBe("2");
  });

  it("reserva vencida que já gastou as 6 tentativas vira `falhou` com código `esgotado`, e não volta à fila", () => {
    enfileirar(ORG_CLAIM, "esgotou", { status: "'enviando'", tentativas: "6", proxima_tentativa_em: "now() - interval '1 minute'" });
    const ids = claim(20);
    expect(ids).toHaveLength(0);
    expect(campo("esgotou", "status")).toBe("falhou");
    expect(campo("esgotou", "ultimo_erro")).toBe("esgotado");
    expect(claim(20)).toEqual([]);
  });

  it("recusa parâmetros fora da faixa (limite, reserva, tentativas)", () => {
    for (const chamada of ["0", "101", "20, 5", "20, 300, 0", "20, 300, 21"]) {
      const erro = erroDe(`select * from public.fn_billing_emails_reservar_lote(${chamada});`);
      expect(erro, chamada).toContain("emails_lote_invalido");
    }
  });

  it("DUAS SESSÕES AO MESMO TEMPO nunca pegam a mesma linha, e a segunda não espera a primeira (skip locked)", async () => {
    for (let i = 0; i < 6; i += 1) enfileirar(ORG_CLAIM, `par-${i}`, { proxima_tentativa_em: "now() - interval '1 hour'" });
    // A: reserva 3 e segura a transação aberta por 2 s antes de confirmar
    const t0 = Date.now();
    const sessaoA = sqlAssincrono(`
      begin;
      select string_agg(chave, ',' order by chave) from public.fn_billing_emails_reservar_lote(3) where chave like 'par-%';
      select pg_sleep(2);
      commit;
    `);
    await new Promise((r) => setTimeout(r, 700)); // A já reservou e segura as linhas
    const t1 = Date.now();
    const saidaB = await sqlAssincrono(`select string_agg(chave, ',' order by chave) from public.fn_billing_emails_reservar_lote(3) where chave like 'par-%';`);
    const duracaoB = Date.now() - t1;
    const saidaA = await sessaoA;

    // (o psql -tA também imprime BEGIN, a linha vazia do pg_sleep e COMMIT)
    const doA = saidaA.split("\n").find((l) => l.startsWith("par-"))!.split(",");
    const doB = saidaB.split(",");
    expect(doA).toHaveLength(3);
    expect(doB).toHaveLength(3);
    expect(doA.filter((c) => doB.includes(c))).toEqual([]); // nenhuma linha em dobro
    expect(new Set([...doA, ...doB]).size).toBe(6);
    // B terminou enquanto A ainda segurava o lock (não ficou esperando): bem antes dos 2 s do sleep de A
    expect(duracaoB).toBeLessThan(1500);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(2000);
  });

  it("várias sessões paralelas: cada linha é reservada uma única vez", async () => {
    for (let i = 0; i < 12; i += 1) enfileirar(ORG_CLAIM, `rajada-${i}`, { proxima_tentativa_em: "now() - interval '1 hour'" });
    const saidas = await Promise.all(
      [0, 1, 2, 3].map(() =>
        sqlAssincrono(`select coalesce(string_agg(chave, ',' order by chave), '') from public.fn_billing_emails_reservar_lote(5) where chave like 'rajada-%';`),
      ),
    );
    const todas = saidas.flatMap((s) => (s ? s.split(",") : []));
    expect(todas).toHaveLength(12);
    expect(new Set(todas).size).toBe(12);
    expect(sql(`select count(*) from public.billing_emails_enviados where organization_id = '${ORG_CLAIM}' and chave like 'rajada-%' and tentativas = 1 and status = 'enviando';`)).toBe("12");
  });
});

describe("0952 item 9: quem pode executar o claim", () => {
  it("é SECURITY DEFINER com search_path fixo", () => {
    expect(
      sql(`select prosecdef::text || '|' || coalesce(array_to_string(proconfig, ','), '') from pg_proc where oid = 'public.fn_billing_emails_reservar_lote(integer, integer, integer)'::regprocedure;`),
    ).toBe("true|search_path=public, pg_temp");
  });

  it("nenhuma origem de EXECUTE além do service_role: nem public, nem anon, nem authenticated", () => {
    const aclPorPapel = sql(`
      select coalesce(string_agg(g.grantee::text, ',' order by g.grantee::text), '')
        from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) g
       where p.oid = 'public.fn_billing_emails_reservar_lote(integer, integer, integer)'::regprocedure
         and g.privilege_type = 'EXECUTE' and g.grantee <> 0;
    `);
    expect(aclPorPapel.split(",")).not.toContain("anon");
    expect(aclPorPapel.split(",")).not.toContain("authenticated");
    // grant a PUBLIC (grantee 0) também não existe
    expect(
      sql(`select count(*) from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) g where p.oid = 'public.fn_billing_emails_reservar_lote(integer, integer, integer)'::regprocedure and g.grantee = 0;`),
    ).toBe("0");
    for (const papel of ["anon", "authenticated"]) {
      const erro = erroDe(`set role ${papel};\nselect * from public.fn_billing_emails_reservar_lote(1);`);
      expect(erro, papel).toContain("permission denied");
    }
    expect(erroDe(`set role service_role;\nselect * from public.fn_billing_emails_reservar_lote(1);`)).toBeNull();
  });
});

describe("0952 item 10: reaplicar sobre a versão anterior (só a tabela de registro)", () => {
  it("a migration traz a tabela antiga para a fila sem perder a linha, e reaplicar de novo é inofensivo", () => {
    // volta ao desenho da versão anterior: tabela de registro, sem as colunas da fila
    sql(`
      drop table public.billing_emails_enviados cascade;
      create table public.billing_emails_enviados (
        id uuid primary key default gen_random_uuid(),
        organization_id uuid not null references public.organizations(id) on delete cascade,
        email_id text not null,
        chave text not null,
        criado_em timestamptz not null default now(),
        resultado jsonb not null default '{}'::jsonb,
        constraint billing_emails_enviados_email_id_formato check (email_id ~ '^[A-Z]{2,8}-[0-9]{2}$'),
        constraint billing_emails_enviados_chave_tamanho check (length(chave) between 1 and 200),
        constraint billing_emails_enviados_resultado_objeto check (jsonb_typeof(resultado) = 'object'),
        constraint billing_emails_enviados_org_email_chave_unique unique (organization_id, email_id, chave)
      );
      alter table public.billing_emails_enviados enable row level security;
      revoke all on public.billing_emails_enviados from anon, authenticated;
      grant select, insert, update on public.billing_emails_enviados to service_role;
      insert into public.billing_emails_enviados (organization_id, email_id, chave) values ('${ORG_ATUALIZA}', 'COB-02', 'registro-antigo');
    `);
    expect(sql(`select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'billing_emails_enviados' and column_name = 'status';`)).toBe("0");

    sql(migration);
    sql(migration);

    expect(sql(`select count(*) from public.billing_emails_enviados where chave = 'registro-antigo';`)).toBe("1");
    expect(sql(`select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'billing_emails_enviados' and column_name in ('status','dados','copia_para_operador','destino','criador_user_id','tentativas','proxima_tentativa_em','enviado_em','ultimo_erro');`)).toBe("9");
    expect(sql(`select count(*) from pg_constraint where conrelid = 'public.billing_emails_enviados'::regclass and conname in ('billing_emails_enviados_status_valido','billing_emails_enviados_criador_exigido','billing_emails_enviados_enviado_com_data','billing_emails_enviados_ultimo_erro_codigo');`)).toBe("4");
    expect(sql(`select count(*) from pg_indexes where schemaname = 'public' and indexname = 'billing_emails_enviados_fila_idx';`)).toBe("1");
    // RLS e ACL continuam fechadas
    expect(sql(`select relrowsecurity::text from pg_class where oid = 'public.billing_emails_enviados'::regclass;`)).toBe("true");
    expect(erroDe(`set role anon;\nselect id from public.billing_emails_enviados limit 1;`)).toContain("permission denied");
    expect(erroDe(`set role service_role;\ndelete from public.billing_emails_enviados;`)).toContain("permission denied");
    // e a reserva antiga continua segurando a unicidade
    expect(reservar(ORG_ATUALIZA, "COB-02", "registro-antigo")).toBe(0);
  });
});
