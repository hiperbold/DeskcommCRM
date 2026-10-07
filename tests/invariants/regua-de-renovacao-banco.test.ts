/**
 * Migração 0946: régua de aviso de renovação do plano que não renova sozinho (D-177, parte 2). Provado no
 * Postgres real, chamando as funções como o job as chama:
 *
 *   1. os marcos (30, 15, 7, 1 e o próprio último dia) em datas de São Paulo, na virada de mês, de ano e de
 *      fevereiro bissexto, e na virada de dia em UTC contra São Paulo;
 *   2. uma simulação dia a dia de um período de 6 e de um de 12 meses: cada marco sai UMA vez, no dia certo;
 *   3. job atrasado: só o marco mais recente, nunca uma pilha;
 *   4. idempotência: o mesmo marco não sai duas vezes, nem em corrida;
 *   5. a régua para: renovou (período novo), cancelamento no fim do período, organização suspensa,
 *      assinatura viva no Asaas, contrato sem gateway, atrasado, período vencido;
 *   6. o resultado de cada canal: e-mail que falhou repete, e-mail em voo nunca repete, aviso que falhou ou
 *      ficou preso repete, aviso na Central criado uma vez só;
 *   7. a Central: o aviso nasce para a organização (ref_kind billing_assinatura) e resolve quando renova;
 *   8. a tabela e as funções são só do servidor: RLS ligada sem policy, anon e authenticated barrados.
 *
 * Roda via `pnpm test:db tests/invariants/regua-de-renovacao-banco.test.ts`.
 */
import { describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

const U = (n: number) => `0946a000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ORG_MARCOS = U(1);
const ORG_SEIS_MESES = U(2);
const ORG_DOZE_MESES = U(3);
const ORG_ATRASADO = U(4);
const ORG_IDEMPOTENCIA = U(5);
const ORG_RENOVOU = U(6);
const ORG_CANCELOU = U(7);
const ORG_SUSPENSA = U(8);
const ORG_VIVA = U(9);
const ORG_SEM_GATEWAY = U(10);
const ORG_ATRASADA = U(11);
const ORG_VENCIDO = U(12);
const ORG_CANAIS = U(13);
const ORG_OUTRA = U(14);
const ORG_CENTRAL = U(15);
const ORG_ENCERRADA = U(16);
const ORG_ACL = U(17);
const ORG_ENCERRADA_2 = U(18);
const ORGS = [
  ORG_MARCOS, ORG_SEIS_MESES, ORG_DOZE_MESES, ORG_ATRASADO, ORG_IDEMPOTENCIA, ORG_RENOVOU, ORG_CANCELOU,
  ORG_SUSPENSA, ORG_VIVA, ORG_SEM_GATEWAY, ORG_ATRASADA, ORG_VENCIDO, ORG_CANAIS, ORG_OUTRA, ORG_CENTRAL,
  ORG_ENCERRADA, ORG_ACL, ORG_ENCERRADA_2,
];

/** 08:00 em São Paulo, a hora do job. */
const AGORA = "2026-10-07 11:00:00+00";
/** Fim exclusivo de um período cujo último dia de acesso é 2026-11-06: 00h de SP do dia 07. */
const FIM = "2026-11-07 00:00:00-03";

function erroDe(comando: string): string | null {
  try {
    sql(comando);
    return null;
  } catch (err) {
    return motivoDoErro(err);
  }
}

interface Config {
  fim?: string | null;
  gateway?: string | null;
  assinatura?: string | null;
  encerrada?: boolean;
  cancelar?: boolean;
  status?: string;
  ciclo?: string;
}

/** Deixa o contrato da organização do jeito pedido (o gatilho de organização nova já criou a linha). */
function configurar(org: string, c: Config = {}): void {
  const fim = c.fim === undefined ? FIM : c.fim;
  const gateway = c.gateway === undefined ? "asaas" : c.gateway;
  sql(`
    update public.billing_contracts
       set plan_id = (select id from public.billing_plans where code = 'pro' and active limit 1),
           status = '${c.status ?? "ativa"}',
           cycle = '${c.ciclo ?? "semiannual"}',
           gateway = ${gateway === null ? "null" : `'${gateway}'`},
           current_period_start = '2026-01-01 00:00:00-03',
           current_period_end = ${fim === null ? "null" : `'${fim}'::timestamptz`},
           cancel_at_period_end = ${c.cancelar ? "true" : "false"},
           asaas_subscription_id = ${c.assinatura ? `'${c.assinatura}'` : "null"},
           asaas_assinatura_encerrada_em = ${c.encerrada ? "now()" : "null"}
     where organization_id = '${org}';
  `);
}

const contrato = (org: string) => sql(`select id from public.billing_contracts where organization_id = '${org}';`);

const marcoDe = (fim: string, agora: string) =>
  sql(`select coalesce(public.fn_billing_renovacao_marco('${fim}'::timestamptz, '${agora}'::timestamptz)::text, 'nulo');`);

/** As linhas pendentes da organização, como `marco|dias|ultimo_dia|precisa_email|precisa_aviso`. */
function pendentes(org: string, agora = AGORA): string[] {
  const saida = sql(
    `select marco || '|' || dias_restantes || '|' || ultimo_dia || '|' || precisa_email::text || '|' || precisa_aviso::text
       from public.fn_billing_renovacao_pendentes('${agora}'::timestamptz, 500)
      where organization_id = '${org}' order by marco;`,
  );
  return saida === "" ? [] : saida.split("\n");
}

/** Reserva o marco pendente da organização e devolve `reserva_id|enviar_email|criar_aviso`, ou "" quando nada. */
function reservar(org: string, fim: string, marco: number, agora = AGORA): string {
  return sql(
    `select reserva_id || '|' || enviar_email::text || '|' || criar_aviso::text
       from public.fn_billing_renovacao_reservar('${org}'::uuid, '${contrato(org)}'::uuid, '${fim}'::timestamptz, ${marco}, '${agora}'::timestamptz);`,
  );
}

const linhas = (org: string) => sql(`select count(*) from public.billing_avisos_de_renovacao where organization_id = '${org}';`);
const coluna = (id: string, col: string) => sql(`select ${col} from public.billing_avisos_de_renovacao where id = '${id}';`);

/** Simula o job diário (08:00 de SP) de `de` a `ate`, cumprindo os dois canais; devolve `dia:marco`. */
function simular(org: string, de: string, ate: string): string[] {
  const saida = sql(`
    create temp table sim (dia date, marco int);
    do $sim$
    declare d date; r record; v record; t timestamptz;
    begin
      for d in select g::date from generate_series('${de}'::date, '${ate}'::date, interval '1 day') g loop
        t := (d::text || ' 11:00:00+00')::timestamptz;
        for r in select * from public.fn_billing_renovacao_pendentes(t, 500) where organization_id = '${org}' loop
          select * into v from public.fn_billing_renovacao_reservar(r.organization_id, r.contract_id, r.fim_do_periodo, r.marco, t);
          if v.reserva_id is not null and (v.enviar_email or v.criar_aviso) then
            perform public.fn_billing_renovacao_criar_aviso(v.reserva_id, 'simulado', 'simulado', 'info');
            update public.billing_avisos_de_renovacao set email_resultado = 'enviado' where id = v.reserva_id;
            insert into sim values (d, r.marco);
          end if;
        end loop;
      end loop;
    end
    $sim$;
    select dia::text || ':' || marco from sim order by dia, marco;
  `);
  return saida.split("\n").filter((linha) => /^\d{4}-\d{2}-\d{2}:\d+$/.test(linha));
}

describe("0946: setup", () => {
  it("cria as organizações", () => {
    sql(
      ORGS.map(
        (id) =>
          `insert into public.organizations (id, slug, legal_name, display_name) values ('${id}', 'i946-${id.slice(-2)}', 'i946 LTDA', 'i946') on conflict (id) do nothing;`,
      ).join("\n"),
    );
    expect(sql(`select count(*) from public.billing_contracts where organization_id = any(array[${ORGS.map((id) => `'${id}'`).join(",")}]::uuid[]);`)).toBe(String(ORGS.length));
  });
});

describe("0946 item 1: os marcos, em datas de São Paulo", () => {
  // O último dia de acesso é 2026-11-06 (o limite exclusivo é 00h de SP do dia 07).
  const casos: Array<[string, string, string]> = [
    ["31 dias antes: ainda não", "2026-10-06 11:00:00+00", "nulo"],
    ["30 dias antes", "2026-10-07 11:00:00+00", "30"],
    ["29 dias antes cai no marco de 30 (o vigente é o menor já vencido)", "2026-10-08 11:00:00+00", "30"],
    ["16 dias antes ainda é o de 30", "2026-10-21 11:00:00+00", "30"],
    ["15 dias antes", "2026-10-22 11:00:00+00", "15"],
    ["8 dias antes ainda é o de 15", "2026-10-29 11:00:00+00", "15"],
    ["7 dias antes", "2026-10-30 11:00:00+00", "7"],
    ["2 dias antes ainda é o de 7", "2026-11-04 11:00:00+00", "7"],
    ["1 dia antes", "2026-11-05 11:00:00+00", "1"],
    ["o próprio último dia", "2026-11-06 11:00:00+00", "0"],
  ];

  it.each(casos)("%s", (_nome, agora, esperado) => {
    expect(marcoDe(FIM, agora)).toBe(esperado);
  });

  it("o dia é o de São Paulo, não o de UTC: 23h30 de SP do dia 06 ainda é 31 dias antes, 00h de SP do dia 07 já é 30", () => {
    // 2026-10-07 02:30 UTC = 2026-10-06 23:30 em SP.
    expect(marcoDe(FIM, "2026-10-07 02:30:00+00")).toBe("nulo");
    // 2026-10-07 03:00 UTC = 2026-10-07 00:00 em SP.
    expect(marcoDe(FIM, "2026-10-07 03:00:00+00")).toBe("30");
  });

  it("o último dia é o dia ANTERIOR ao limite exclusivo: 23h de SP do último dia ainda é o dia 0", () => {
    // 2026-11-07 01:59 UTC = 2026-11-06 22:59 em SP; o período só acaba às 00h de SP do dia 07 (03:00 UTC).
    expect(marcoDe(FIM, "2026-11-07 01:59:00+00")).toBe("0");
  });

  it("um fim gravado como 23:59:59 do último dia dá o mesmo último dia (não depende de o limite ser exato)", () => {
    expect(marcoDe("2026-11-06 23:59:59-03", "2026-10-07 11:00:00+00")).toBe("30");
    expect(marcoDe("2026-11-06 23:59:59-03", "2026-10-06 11:00:00+00")).toBe("nulo");
  });

  it("virada de mês: fim em 01/03 (último dia 28/02) avisa em 29/01 e em 28/02", () => {
    const fim = "2026-03-01 00:00:00-03";
    expect(marcoDe(fim, "2026-01-28 11:00:00+00")).toBe("nulo");
    expect(marcoDe(fim, "2026-01-29 11:00:00+00")).toBe("30");
    expect(marcoDe(fim, "2026-02-13 11:00:00+00")).toBe("15");
    expect(marcoDe(fim, "2026-02-21 11:00:00+00")).toBe("7");
    expect(marcoDe(fim, "2026-02-27 11:00:00+00")).toBe("1");
    expect(marcoDe(fim, "2026-02-28 11:00:00+00")).toBe("0");
  });

  it("fevereiro bissexto: fim em 01/03/2028 (último dia 29/02) avisa em 30/01 e em 29/02", () => {
    const fim = "2028-03-01 00:00:00-03";
    expect(marcoDe(fim, "2028-01-29 11:00:00+00")).toBe("nulo");
    expect(marcoDe(fim, "2028-01-30 11:00:00+00")).toBe("30");
    expect(marcoDe(fim, "2028-02-28 11:00:00+00")).toBe("1");
    expect(marcoDe(fim, "2028-02-29 11:00:00+00")).toBe("0");
  });

  it("virada de ano: fim em 02/01/2027 (último dia 01/01) avisa em 02/12 e em 01/01", () => {
    const fim = "2027-01-02 00:00:00-03";
    expect(marcoDe(fim, "2026-12-01 11:00:00+00")).toBe("nulo");
    expect(marcoDe(fim, "2026-12-02 11:00:00+00")).toBe("30");
    expect(marcoDe(fim, "2026-12-17 11:00:00+00")).toBe("15");
    expect(marcoDe(fim, "2026-12-31 11:00:00+00")).toBe("1");
    expect(marcoDe(fim, "2027-01-01 11:00:00+00")).toBe("0");
  });

  it("a lista de pendentes traz o marco, os dias e o último dia, e o contrato sem aviso ainda pede os dois canais", () => {
    configurar(ORG_MARCOS);
    expect(pendentes(ORG_MARCOS, "2026-10-07 11:00:00+00")).toEqual(["30|30|2026-11-06|true|true"]);
    expect(pendentes(ORG_MARCOS, "2026-10-06 11:00:00+00")).toEqual([]);
  });
});

describe("0946 item 2: simulação dia a dia, cada marco sai uma vez, no dia certo", () => {
  it("período de 6 meses comprado em 07/10/2026 (fim 08/04/2027, último dia 07/04/2027)", () => {
    configurar(ORG_SEIS_MESES, { fim: "2027-04-08 00:00:00-03" });
    expect(simular(ORG_SEIS_MESES, "2026-10-07", "2027-04-12")).toEqual([
      "2027-03-08:30",
      "2027-03-23:15",
      "2027-03-31:7",
      "2027-04-06:1",
      "2027-04-07:0",
    ]);
    expect(linhas(ORG_SEIS_MESES)).toBe("5");
  });

  it("período de 12 meses comprado em 07/10/2026 (fim 08/10/2027, último dia 07/10/2027)", () => {
    configurar(ORG_DOZE_MESES, { fim: "2027-10-08 00:00:00-03", ciclo: "yearly" });
    expect(simular(ORG_DOZE_MESES, "2026-10-07", "2027-10-12")).toEqual([
      "2027-09-07:30",
      "2027-09-22:15",
      "2027-09-30:7",
      "2027-10-06:1",
      "2027-10-07:0",
    ]);
    expect(linhas(ORG_DOZE_MESES)).toBe("5");
  });
});

describe("0946 item 3: job atrasado manda só o marco mais recente", () => {
  it("o cron ficou parado de 30 a 7 dias antes: sai UM aviso (o de 7), nunca os de 30 e de 15", () => {
    configurar(ORG_ATRASADO);
    // 2026-10-31 = 6 dias antes do último dia (06/11): o vigente é o de 7.
    const fila = pendentes(ORG_ATRASADO, "2026-10-31 11:00:00+00");
    expect(fila).toEqual(["7|6|2026-11-06|true|true"]);
    expect(reservar(ORG_ATRASADO, FIM, 7, "2026-10-31 11:00:00+00")).toMatch(/^[0-9a-f-]{36}\|true\|true$/);
    expect(linhas(ORG_ATRASADO)).toBe("1");
    expect(sql(`select marco from public.billing_avisos_de_renovacao where organization_id = '${ORG_ATRASADO}';`)).toBe("7");
  });

  it("não reserva um marco que já não é o vigente (o chamador tinha uma listagem velha)", () => {
    // O vigente em 31/10 é o 7; pedir o 30 agora não grava nada.
    expect(reservar(ORG_ATRASADO, FIM, 30, "2026-10-31 11:00:00+00")).toBe("");
    expect(sql(`select count(*) from public.billing_avisos_de_renovacao where organization_id = '${ORG_ATRASADO}' and marco = 30;`)).toBe("0");
  });
});

describe("0946 item 4: idempotência", () => {
  it("o marco reservado e cumprido não volta à lista nem reserva de novo", () => {
    configurar(ORG_IDEMPOTENCIA);
    const [id] = reservar(ORG_IDEMPOTENCIA, FIM, 30).split("|");
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    sql(`select public.fn_billing_renovacao_criar_aviso('${id}'::uuid, 'Faltam 30 dias', 'corpo', 'info');`);
    sql(`update public.billing_avisos_de_renovacao set email_resultado = 'enviado', email_enviados = 1 where id = '${id}';`);
    expect(pendentes(ORG_IDEMPOTENCIA)).toEqual([]);
    // Reservar de novo reconhece a linha e não manda cumprir canal nenhum.
    expect(reservar(ORG_IDEMPOTENCIA, FIM, 30)).toBe(`${id}|false|false`);
    expect(linhas(ORG_IDEMPOTENCIA)).toBe("1");
  });

  it("a unicidade é do banco: o mesmo (organização, fim, marco) não entra duas vezes", () => {
    const erro = erroDe(
      `insert into public.billing_avisos_de_renovacao (organization_id, contract_id, fim_do_periodo, marco)
         values ('${ORG_IDEMPOTENCIA}', '${contrato(ORG_IDEMPOTENCIA)}', '${FIM}', 30);`,
    );
    expect(erro).toContain("billing_avisos_de_renovacao_periodo_marco_unique");
  });

  it("o marco precisa ser um dos cinco, e os resultados um dos vocabulários fechados", () => {
    const base = `insert into public.billing_avisos_de_renovacao (organization_id, contract_id, fim_do_periodo, marco`;
    expect(erroDe(`${base}) values ('${ORG_IDEMPOTENCIA}', '${contrato(ORG_IDEMPOTENCIA)}', '2030-01-01 00:00:00-03', 5);`)).toContain("billing_avisos_de_renovacao_marco_check");
    expect(erroDe(`${base}, email_resultado) values ('${ORG_IDEMPOTENCIA}', '${contrato(ORG_IDEMPOTENCIA)}', '2030-01-01 00:00:00-03', 30, 'talvez');`)).toContain("billing_avisos_de_renovacao_email_check");
    expect(erroDe(`${base}, aviso_resultado) values ('${ORG_IDEMPOTENCIA}', '${contrato(ORG_IDEMPOTENCIA)}', '2030-01-01 00:00:00-03', 30, 'talvez');`)).toContain("billing_avisos_de_renovacao_aviso_check");
  });

  it("organização de outra conta não reserva o contrato alheio", () => {
    configurar(ORG_OUTRA);
    const resposta = sql(
      `select count(*) from public.fn_billing_renovacao_reservar('${ORG_OUTRA}'::uuid, '${contrato(ORG_IDEMPOTENCIA)}'::uuid, '${FIM}'::timestamptz, 30, '${AGORA}'::timestamptz);`,
    );
    expect(resposta).toBe("0");
    expect(linhas(ORG_OUTRA)).toBe("0");
  });

  it("entrada inválida é recusada", () => {
    expect(
      erroDe(`select * from public.fn_billing_renovacao_reservar('${ORG_OUTRA}'::uuid, '${contrato(ORG_OUTRA)}'::uuid, '${FIM}'::timestamptz, 3, '${AGORA}'::timestamptz);`),
    ).toContain("renovacao_entrada_invalida");
  });
});

describe("0946 item 5: a régua para", () => {
  it("renovou: o período novo derruba o marco do período velho, e a régua do período novo é outra", () => {
    configurar(ORG_RENOVOU);
    expect(pendentes(ORG_RENOVOU)).toHaveLength(1);
    const [id] = reservar(ORG_RENOVOU, FIM, 30).split("|");
    sql(`select public.fn_billing_renovacao_criar_aviso('${id}'::uuid, 't', 'c', 'info');`);
    sql(`update public.billing_avisos_de_renovacao set email_resultado = 'enviado' where id = '${id}';`);
    // O cliente renova (Pix empilhado): current_period_end vai seis meses adiante.
    sql(`update public.billing_contracts set current_period_end = '2027-05-07 00:00:00-03' where organization_id = '${ORG_RENOVOU}';`);
    expect(pendentes(ORG_RENOVOU)).toEqual([]);
    // Quem ainda tinha a listagem velha não reserva marco do período antigo.
    expect(reservar(ORG_RENOVOU, FIM, 30)).toBe("");
    // O novo período só entra na régua perto do novo fim, com linha própria (mesmo marco, outro fim).
    expect(pendentes(ORG_RENOVOU, "2027-04-07 11:00:00+00")).toEqual(["30|29|2027-05-06|true|true"]);
    expect(reservar(ORG_RENOVOU, "2027-05-07 00:00:00-03", 30, "2027-04-07 11:00:00+00")).toMatch(/\|true\|true$/);
    expect(linhas(ORG_RENOVOU)).toBe("2");
  });

  it("cancelamento no fim do período (por qualquer via) sai da régua, na lista e na reserva", () => {
    configurar(ORG_CANCELOU, { cancelar: true });
    expect(pendentes(ORG_CANCELOU)).toEqual([]);
    expect(reservar(ORG_CANCELOU, FIM, 30)).toBe("");
    expect(linhas(ORG_CANCELOU)).toBe("0");
  });

  it("organização suspensa não é avisada, e a reserva também recusa se ela foi suspensa depois da listagem", () => {
    configurar(ORG_SUSPENSA);
    expect(pendentes(ORG_SUSPENSA)).toHaveLength(1);
    sql(`update public.organizations set status = 'suspended' where id = '${ORG_SUSPENSA}';`);
    expect(pendentes(ORG_SUSPENSA)).toEqual([]);
    expect(reservar(ORG_SUSPENSA, FIM, 30)).toBe("");
    sql(`update public.organizations set status = 'active' where id = '${ORG_SUSPENSA}';`);
    expect(pendentes(ORG_SUSPENSA)).toHaveLength(1);
  });

  it("assinatura viva no Asaas renova sozinha: sem régua; encerrada, entra", () => {
    configurar(ORG_VIVA, { assinatura: "sub_i946_viva" });
    expect(pendentes(ORG_VIVA)).toEqual([]);
    expect(reservar(ORG_VIVA, FIM, 30)).toBe("");
    configurar(ORG_VIVA, { assinatura: "sub_i946_viva", encerrada: true });
    expect(pendentes(ORG_VIVA)).toHaveLength(1);
  });

  it("contrato sem gateway (avaliação ou plano concedido) não entra na régua", () => {
    configurar(ORG_SEM_GATEWAY, { gateway: null });
    expect(pendentes(ORG_SEM_GATEWAY)).toEqual([]);
  });

  it("contrato atrasado ou suspenso não entra, e período já vencido também não", () => {
    configurar(ORG_ATRASADA, { status: "atrasada" });
    expect(pendentes(ORG_ATRASADA)).toEqual([]);
    configurar(ORG_ATRASADA, { status: "suspensa" });
    expect(pendentes(ORG_ATRASADA)).toEqual([]);
    configurar(ORG_VENCIDO);
    expect(pendentes(ORG_VENCIDO, "2026-11-07 03:00:00+00")).toEqual([]);
    expect(pendentes(ORG_VENCIDO, "2026-11-07 02:59:00+00")).toHaveLength(1);
  });

  it("contrato sem fim de período não entra", () => {
    configurar(ORG_VENCIDO, { fim: null });
    expect(pendentes(ORG_VENCIDO)).toEqual([]);
  });

  it("a regra de assinatura viva: id gravado e sem marcador de encerramento", () => {
    const viva = (id: string | null, enc: string | null) =>
      sql(`select public.fn_billing_assinatura_viva(${id === null ? "null" : `'${id}'`}, ${enc === null ? "null" : `'${enc}'::timestamptz`})::text;`);
    expect(viva(null, null)).toBe("false");
    expect(viva("sub_x", null)).toBe("true");
    expect(viva("sub_x", "2026-10-01 10:00:00+00")).toBe("false");
    expect(viva(null, "2026-10-01 10:00:00+00")).toBe("false");
  });
});

describe("0946 item 6: o resultado de cada canal", () => {
  it("reserva nova entrega os dois canais; e-mail que falhou repete, o aviso criado não", () => {
    configurar(ORG_CANAIS);
    const [id, email, aviso] = reservar(ORG_CANAIS, FIM, 30).split("|");
    expect([email, aviso]).toEqual(["true", "true"]);
    expect(coluna(id!, "email_resultado || '|' || aviso_resultado")).toBe("pendente|pendente");

    // Aviso criado; e-mail falhou sem entregar nada.
    sql(`select public.fn_billing_renovacao_criar_aviso('${id}'::uuid, 't', 'c', 'info');`);
    sql(`update public.billing_avisos_de_renovacao set email_resultado = 'falhou', email_falhas = 1 where id = '${id}';`);
    expect(pendentes(ORG_CANAIS)).toEqual(["30|30|2026-11-06|true|false"]);
    expect(reservar(ORG_CANAIS, FIM, 30)).toBe(`${id}|true|false`);
    // A rodada que reservou o e-mail o marcou como em voo: uma segunda rodada ao mesmo tempo não o repete.
    expect(coluna(id!, "email_resultado")).toBe("pendente");
    expect(reservar(ORG_CANAIS, FIM, 30)).toBe(`${id}|false|false`);
    expect(pendentes(ORG_CANAIS)).toEqual([]);
  });

  it("e-mail em voo (pendente, o processo morreu) NUNCA é reenviado", () => {
    // O e-mail ficou pendente da rodada anterior e o aviso foi criado: nada a repetir, nem com o tempo.
    const depois = "2026-10-08 11:00:00+00";
    sql(`update public.billing_avisos_de_renovacao set atualizado_em = '2026-10-07 11:00:00+00' where organization_id = '${ORG_CANAIS}';`);
    expect(coluna(sql(`select id from public.billing_avisos_de_renovacao where organization_id = '${ORG_CANAIS}';`), "email_resultado")).toBe("pendente");
    // 08/10 ainda é o marco de 30 (29 dias antes); nada pendente de repetir.
    expect(pendentes(ORG_CANAIS, depois)).toEqual([]);
  });

  it("aviso na Central que falhou repete; o preso em pendente por mais de 10 minutos repete; o recente não", () => {
    const id = sql(`select id from public.billing_avisos_de_renovacao where organization_id = '${ORG_CANAIS}';`);
    // Estado: aviso criado. Simula falha e depois reserva presa.
    sql(`update public.billing_avisos_de_renovacao set aviso_resultado = 'falhou', inbox_item_id = null where id = '${id}';`);
    expect(pendentes(ORG_CANAIS)).toEqual(["30|30|2026-11-06|false|true"]);
    expect(reservar(ORG_CANAIS, FIM, 30)).toBe(`${id}|false|true`);

    // Agora está pendente e recente (atualizado_em = AGORA): outra rodada não o repete.
    expect(coluna(id, "aviso_resultado")).toBe("pendente");
    expect(pendentes(ORG_CANAIS)).toEqual([]);
    expect(reservar(ORG_CANAIS, FIM, 30)).toBe(`${id}|false|false`);

    // 11 minutos depois a reserva está presa: repete.
    expect(pendentes(ORG_CANAIS, "2026-10-07 11:11:00+00")).toEqual(["30|30|2026-11-06|false|true"]);
    expect(reservar(ORG_CANAIS, FIM, 30, "2026-10-07 11:11:00+00")).toBe(`${id}|false|true`);
  });

  it("o aviso na Central é criado uma vez só, mesmo chamado de novo", () => {
    const id = sql(`select id from public.billing_avisos_de_renovacao where organization_id = '${ORG_CANAIS}';`);
    const primeira = sql(`select public.fn_billing_renovacao_criar_aviso('${id}'::uuid, 'Faltam 30 dias', 'corpo', 'info');`);
    expect(primeira).toMatch(/^[0-9a-f-]{36}$/);
    expect(sql(`select coalesce(public.fn_billing_renovacao_criar_aviso('${id}'::uuid, 'Faltam 30 dias', 'corpo', 'info')::text, 'nulo');`)).toBe("nulo");
    expect(coluna(id, "aviso_resultado || '|' || (inbox_item_id is not null)::text")).toBe("criado|true");
    expect(sql(`select count(*) from public.agent_inbox_items where organization_id = '${ORG_CANAIS}' and ref_kind = 'billing_assinatura' and title = 'Faltam 30 dias';`)).toBe("1");
  });
});

describe("0946 item 7: a Central", () => {
  it("o aviso nasce para a organização, com a severidade pedida, e só aceita info ou warn", () => {
    configurar(ORG_CENTRAL);
    const [id] = reservar(ORG_CENTRAL, FIM, 30).split("|");
    expect(erroDe(`select public.fn_billing_renovacao_criar_aviso('${id}'::uuid, 't', 'c', 'critical');`)).toContain("renovacao_aviso_invalido");
    expect(erroDe(`select public.fn_billing_renovacao_criar_aviso('${id}'::uuid, '  ', 'c', 'info');`)).toContain("renovacao_aviso_invalido");
    const item = sql(`select public.fn_billing_renovacao_criar_aviso('${id}'::uuid, 'Hoje é o último dia', 'corpo', 'warn');`);
    expect(
      sql(`select kind || '|' || severity || '|' || ref_kind || '|' || (ref_id = organization_id)::text || '|' || status || '|' || organization_id::text from public.agent_inbox_items where id = '${item}';`),
    ).toBe(`other|warn|billing_assinatura|true|open|${ORG_CENTRAL}`);
  });

  it("reserva inexistente não cria nada", () => {
    expect(sql(`select coalesce(public.fn_billing_renovacao_criar_aviso(gen_random_uuid(), 't', 'c', 'info')::text, 'nulo');`)).toBe("nulo");
  });

  it("renovou: o aviso velho é resolvido, o de outro assunto não, e a segunda chamada não resolve nada", () => {
    configurar(ORG_ENCERRADA);
    const [id] = reservar(ORG_ENCERRADA, FIM, 30).split("|");
    const item = sql(`select public.fn_billing_renovacao_criar_aviso('${id}'::uuid, 'Faltam 30 dias', 'corpo', 'info');`);
    // Outro aviso de plano da mesma organização (o do modo leitura), que NÃO é da régua.
    sql(`insert into public.agent_inbox_items (organization_id, kind, severity, title, ref_kind, ref_id)
           values ('${ORG_ENCERRADA}', 'other', 'critical', 'Assinatura em leitura', 'billing_assinatura', '${ORG_ENCERRADA}');`);

    // Período ainda o mesmo: o aviso desta organização segue aberto (a função é global, então não se conta o total).
    sql(`select public.fn_billing_renovacao_encerrar_avisos('${AGORA}'::timestamptz);`);
    expect(sql(`select status from public.agent_inbox_items where id = '${item}';`)).toBe("open");

    sql(`update public.billing_contracts set current_period_end = '2027-05-07 00:00:00-03' where organization_id = '${ORG_ENCERRADA}';`);
    expect(Number(sql(`select public.fn_billing_renovacao_encerrar_avisos('${AGORA}'::timestamptz);`))).toBeGreaterThanOrEqual(1);
    expect(sql(`select status || '|' || (resolved_at is not null)::text from public.agent_inbox_items where id = '${item}';`)).toBe("resolved|true");
    expect(sql(`select status from public.agent_inbox_items where organization_id = '${ORG_ENCERRADA}' and title = 'Assinatura em leitura';`)).toBe("open");
    // Segunda chamada: o que já foi resolvido não é resolvido de novo (a data não muda).
    const quando = sql(`select resolved_at::text from public.agent_inbox_items where id = '${item}';`);
    sql(`select public.fn_billing_renovacao_encerrar_avisos('${AGORA}'::timestamptz);`);
    expect(sql(`select resolved_at::text from public.agent_inbox_items where id = '${item}';`)).toBe(quando);
  });

  it("cancelou ou ganhou assinatura viva depois do aviso: o aviso também é resolvido", () => {
    configurar(ORG_ENCERRADA_2);
    const [id] = reservar(ORG_ENCERRADA_2, FIM, 30).split("|");
    const item = sql(`select public.fn_billing_renovacao_criar_aviso('${id}'::uuid, 'Faltam 30 dias', 'corpo', 'info');`);
    sql(`select public.fn_billing_renovacao_encerrar_avisos('${AGORA}'::timestamptz);`);
    expect(sql(`select status from public.agent_inbox_items where id = '${item}';`)).toBe("open");
    sql(`update public.billing_contracts set cancel_at_period_end = true where organization_id = '${ORG_ENCERRADA_2}';`);
    sql(`select public.fn_billing_renovacao_encerrar_avisos('${AGORA}'::timestamptz);`);
    expect(sql(`select status from public.agent_inbox_items where id = '${item}';`)).toBe("resolved");
  });
});

describe("0946 item 8: só o servidor lê e grava", () => {
  it("RLS ligada e nenhuma policy", () => {
    expect(sql(`select relrowsecurity::text from pg_class where oid = 'public.billing_avisos_de_renovacao'::regclass;`)).toBe("true");
    expect(sql(`select count(*) from pg_policies where schemaname = 'public' and tablename = 'billing_avisos_de_renovacao';`)).toBe("0");
  });

  const papeis = ["anon", "authenticated"] as const;

  it.each(papeis)("%s não lê, não insere, não altera e não apaga a tabela", (papel) => {
    const barrado = (comando: string) => {
      const erro = erroDe(`set role ${papel};\n${comando};`);
      expect(erro, `${papel}: ${comando}`).not.toBeNull();
      expect(erro).toContain("permission denied");
    };
    barrado("select id from public.billing_avisos_de_renovacao limit 1");
    barrado(
      `insert into public.billing_avisos_de_renovacao (organization_id, contract_id, fim_do_periodo, marco) select organization_id, id, now(), 30 from public.billing_contracts limit 1`,
    );
    barrado("update public.billing_avisos_de_renovacao set email_resultado = 'enviado'");
    barrado("delete from public.billing_avisos_de_renovacao");
  });

  it.each(papeis)("%s não executa nenhuma das funções da régua", (papel) => {
    const chamadas = [
      "select public.fn_billing_assinatura_viva('x', null)",
      "select public.fn_billing_renovacao_marco(now(), now())",
      "select * from public.fn_billing_renovacao_pendentes(now(), 10)",
      `select * from public.fn_billing_renovacao_reservar('${ORG_ACL}'::uuid, gen_random_uuid(), now(), 30, now())`,
      "select public.fn_billing_renovacao_criar_aviso(gen_random_uuid(), 't', 'c', 'info')",
      "select public.fn_billing_renovacao_encerrar_avisos(now())",
    ];
    for (const chamada of chamadas) {
      const erro = erroDe(`set role ${papel};\n${chamada};`);
      expect(erro, `${papel}: ${chamada}`).not.toBeNull();
      expect(erro).toContain("permission denied");
    }
  });

  it("service_role lê, insere e altera, mas não apaga nem esvazia a tabela", () => {
    configurar(ORG_ACL);
    expect(erroDe(`set role service_role;\nselect count(*) from public.billing_avisos_de_renovacao;`)).toBeNull();
    expect(
      erroDe(
        `set role service_role;\ninsert into public.billing_avisos_de_renovacao (organization_id, contract_id, fim_do_periodo, marco) values ('${ORG_ACL}', '${contrato(ORG_ACL)}', '${FIM}', 15);`,
      ),
    ).toBeNull();
    expect(erroDe(`set role service_role;\nupdate public.billing_avisos_de_renovacao set email_resultado = 'enviado' where organization_id = '${ORG_ACL}';`)).toBeNull();
    for (const comando of ["delete from public.billing_avisos_de_renovacao", "truncate public.billing_avisos_de_renovacao"]) {
      const erro = erroDe(`set role service_role;\n${comando};`);
      expect(erro, comando).not.toBeNull();
      expect(erro).toContain("permission denied");
    }
  });

  it("service_role executa as funções", () => {
    expect(erroDe(`set role service_role;\nselect * from public.fn_billing_renovacao_pendentes(now(), 10);`)).toBeNull();
    expect(erroDe(`set role service_role;\nselect public.fn_billing_renovacao_encerrar_avisos(now());`)).toBeNull();
  });

  it("apagar a organização leva o histórico junto (cascata), sem deixar linha órfã", () => {
    sql(`delete from public.organizations where id = '${ORG_ACL}';`);
    expect(linhas(ORG_ACL)).toBe("0");
  });
});
