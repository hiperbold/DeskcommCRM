import { spawn } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

/**
 * A ASSINATURA GANHA VIDA: pagamentos, estados, conferidor, modo leitura,
 * pacotes de tokens e D-046. Migration 0908 (fase F4, fork Hiperbold,
 * `hiperbold/planos/fase-F4-tarefas.md`, "Tarefa 4" e decisões 1 a 11).
 *
 * O banco (partes 1 a 3 da 0908) já está pronto; este arquivo só prova o que
 * a Tarefa 4 pede, na ordem do enunciado:
 *
 *  1. Pagamento: registro e renovação de período, idempotência pela chave,
 *     valores/fim divergentes, os dois privilégios negados de
 *     billing_payments, estorno e o estorno duplo (achado corrigido na
 *     própria 0908), correção de período exige motivo.
 *  2. Estados: as transições permitidas e proibidas da decisão 3.
 *  3. Conferidor: as três transições em ordem, idempotência, e a corrida
 *     real entre um pagamento e o conferidor (duas sessões psql).
 *  4. Avisos: uma vez por transição, sem duplicar, sem recriar ao encerrar,
 *     e o viewer não forja/apaga/reescreve mas consegue encerrar.
 *  5. Modo leitura: os quatro gatilhos de criação recusam com PT402/
 *     assinatura_suspensa; lead, aceite pelo servidor e conexão de canal
 *     continuam; carência futura/nula e modo avisar não recusam nada;
 *     fn_billing_modo_leitura não é executável por authenticated.
 *  6. Pacotes: crédito pelo preço do catálogo, pelo valor informado, os dois
 *     ausentes, pacote inativo, repetição idempotente, catálogo fechado a
 *     authenticated.
 *  7. D-046: viewer não insere em api_audit_log, service_role insere,
 *     agent_worker (se a role existir) perde update/delete.
 *
 * Como os outros arquivos desta pasta (`planos-carteira.test.ts`,
 * `planos-bloqueio-leads.test.ts`, `planos-bloqueio-membros.test.ts`): fala
 * com o Postgres por `tests/invariants/psql-transporte.ts`, sessão
 * `authenticated` com JWT real (`request.jwt.claims`) para os casos de
 * privilégio, e `postgres` (superusuário do container) para o resto, que
 * bypassa GRANT/REVOKE mas não as regras que as próprias funções aplicam.
 * `billing_settings.modo` é uma linha ÚNICA (id = 1) compartilhada por todo o
 * banco: todo caso que liga `bloquear` faz isso DENTRO de uma transação
 * `begin; ...; rollback;` que nunca commita, para nenhum outro arquivo (nem
 * outro caso deste) enxergar o valor trocado. O caso de corrida real (3f) é a
 * ÚNICA exceção: usa duas sessões psql de verdade, commita de propósito, e
 * limpa a própria organização no `afterAll`.
 */

const MARCA = "SONDA|";

function linhasMarcadas(saida: string): string[] {
  return saida
    .split("\n")
    .filter((linha) => linha.startsWith(MARCA))
    .map((linha) => linha.slice(MARCA.length));
}

/** Roda como o papel da sessão do container (`postgres`, superusuário). */
function comoServico(corpo: string): string[] {
  return linhasMarcadas(sql(corpo));
}

/**
 * O prefixo que põe a sessão no lugar exato em que o PostgREST põe a de um
 * usuário logado: papel `authenticated` + `request.jwt.claims` (mesmo padrão
 * de `planos-carteira.test.ts` e `planos-bloqueio-membros.test.ts`).
 */
function comoMembro(userId: string): string {
  return `set role authenticated;\nselect set_config('request.jwt.claims', '{"sub":"${userId}"}', false);`;
}

function membro(userId: string, corpo: string): string[] {
  return linhasMarcadas(sql(`${comoMembro(userId)}\n${corpo}`));
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

/** Afirma que `authenticated` foi recusado por PRIVILÉGIO (permission denied). */
function esperaBarrado(userId: string, dml: string, contexto: string): void {
  const erro = erroDe(`${comoMembro(userId)}\n${dml};`);
  expect(erro, `${contexto}: passou SEM erro, está exposto a "authenticated"`).not.toBeNull();
  expect(erro).toContain("permission denied");
}

/** Afirma que UM PAPEL QUALQUER (aqui, `service_role`) foi recusado por privilégio. */
function esperaBarradoComoPapel(papel: string, comando: string, contexto: string): void {
  const erro = erroDe(`set role ${papel};\n${comando};`);
  expect(erro, `${contexto}: passou SEM erro sob "${papel}"`).not.toBeNull();
  expect(erro).toContain("permission denied");
}

/**
 * Como `esperaBarrado`, mas para uma recusa que NÃO é falta de GRANT
 * (`permission denied`): é uma policy RESTRICTIVE (RLS, "new row violates
 * row-level security policy") ou um gatilho de regra de negócio (42501 com
 * mensagem própria, como `fn_billing_trava_agent_inbox_items_update`). O
 * membro TEM privilégio de tabela (é dono do próprio dado); quem barra é a
 * REGRA, não o GRANT.
 */
function esperaRecusado(userId: string, dml: string, contexto: string, trechoEsperado: string): void {
  const erro = erroDe(`${comoMembro(userId)}\n${dml};`);
  expect(erro, `${contexto}: passou SEM erro`).not.toBeNull();
  expect(erro).toContain(trechoEsperado);
}

function criarOrgSql(id: string, slug: string): string {
  return `insert into public.organizations (id, slug, legal_name, display_name)
    values ('${id}', '${slug}', '${slug} LTDA', '${slug}')
    on conflict (id) do nothing;`;
}

/**
 * Toda organização nova já ganha um `billing_contracts` no plano Ilimitado
 * (status ativa, período nulo, grace_days 7), pelo gatilho AFTER INSERT de
 * `organizations` da 0904 (`fn_billing_contrato_da_organizacao_nova`). Esta
 * função só existe para deixar EXPLÍCITO, no ponto de uso, que é disso que os
 * fixtures partem, sem repetir o comentário em cada caso.
 */
function criarOrgComContratoPadraoSql(id: string, slug: string): string {
  return criarOrgSql(id, slug);
}

/**
 * O mesmo fim de dia em America/Sao_Paulo que `fn_billing_registrar_pagamento`
 * e `fn_billing_corrigir_periodo` calculam (decisão 2): `(p_fim + 1)::timestamp
 * at time zone 'America/Sao_Paulo'`. Devolvida como EXPRESSÃO SQL (não como
 * data calculada em JS) de propósito: comparar contra a mesma fórmula que a
 * função usa prova a fórmula, não uma reimplementação dela que pudesse
 * concordar por acidente.
 */
function fimDeDiaSpExpr(pFimLiteralSql: string): string {
  return `((${pFimLiteralSql})::date + 1)::timestamp at time zone 'America/Sao_Paulo'`;
}

/** Concede execução temporária e TRANSACIONAL de `fn_billing_modo_leitura` a `authenticated`, só para o caso 5.11 medir a LÓGICA sem privilégio no caminho. */

// ============================================================================
// 1. Pagamento: fn_billing_registrar_pagamento, fn_billing_estornar_pagamento,
//    fn_billing_corrigir_periodo (decisões 1 e 2).
// ============================================================================

describe("1. Pagamento", () => {
  const ORG_SEM_PERIODO = "09080001-0000-4000-8000-000000000001";
  const CHAVE_SEM_PERIODO = "09080001-c0de-4000-8000-000000000001";

  it("sem período prévio: início = agora, fim = fim do dia SP do p_fim, status volta a ativa", () => {
    const linhas = comoServico(`
      begin;
      ${criarOrgComContratoPadraoSql(ORG_SEM_PERIODO, "pag-sem-periodo")}
      select public.fn_billing_registrar_pagamento('${ORG_SEM_PERIODO}'::uuid, '2027-01-10'::date, 1000, '${CHAVE_SEM_PERIODO}'::uuid, 'nota', null);
      select 'SONDA|status=' || status
        || '|inicio_ok=' || (current_period_start >= now() - interval '30 seconds' and current_period_start <= now())::text
        || '|fim_ok=' || (current_period_end = ${fimDeDiaSpExpr("'2027-01-10'")})::text
        from public.billing_contracts where organization_id = '${ORG_SEM_PERIODO}';
      rollback;
    `);
    expect(linhas).toEqual(["status=ativa|inicio_ok=true|fim_ok=true"]);
  });

  const ORG_RENOVA = "09080001-0000-4000-8000-000000000002";
  const CHAVE_RENOVA_A = "09080001-c0de-4000-8000-000000000002";
  const CHAVE_RENOVA_B = "09080001-c0de-4000-8000-000000000003";

  it("com período já vigente: início = fim do período ANTERIOR (greatest ignora now() quando o antigo é maior)", () => {
    const linhas = comoServico(`
      begin;
      ${criarOrgComContratoPadraoSql(ORG_RENOVA, "pag-renova")}
      select public.fn_billing_registrar_pagamento('${ORG_RENOVA}'::uuid, '2027-01-10'::date, 1000, '${CHAVE_RENOVA_A}'::uuid, 'nota 1', null);
      select public.fn_billing_registrar_pagamento('${ORG_RENOVA}'::uuid, '2027-02-15'::date, 500, '${CHAVE_RENOVA_B}'::uuid, 'nota 2', null);
      select 'SONDA|inicio_ok=' || (current_period_start = ${fimDeDiaSpExpr("'2027-01-10'")})::text
        || '|fim_ok=' || (current_period_end = ${fimDeDiaSpExpr("'2027-02-15'")})::text
        from public.billing_contracts where organization_id = '${ORG_RENOVA}';
      rollback;
    `);
    expect(linhas).toEqual(["inicio_ok=true|fim_ok=true"]);
  });

  const ORG_IDEMPOTENTE = "09080001-0000-4000-8000-000000000003";
  const CHAVE_IDEMPOTENTE = "09080001-c0de-4000-8000-000000000004";

  it("mesma chave, mesmos valores: a segunda chamada devolve ja_registrado=true e não duplica a linha", () => {
    const linhas = comoServico(`
      begin;
      ${criarOrgComContratoPadraoSql(ORG_IDEMPOTENTE, "pag-idempotente")}
      select 'SONDA|' || (public.fn_billing_registrar_pagamento('${ORG_IDEMPOTENTE}'::uuid, '2027-01-10'::date, 700, '${CHAVE_IDEMPOTENTE}'::uuid, 'nota', null) ->> 'ja_registrado');
      select 'SONDA|' || (public.fn_billing_registrar_pagamento('${ORG_IDEMPOTENTE}'::uuid, '2027-01-10'::date, 700, '${CHAVE_IDEMPOTENTE}'::uuid, 'nota', null) ->> 'ja_registrado');
      select 'SONDA|' || count(*) from public.billing_payments where organization_id = '${ORG_IDEMPOTENTE}' and chave = '${CHAVE_IDEMPOTENTE}';
      rollback;
    `);
    expect(linhas).toEqual(["false", "true", "1"]);
  });

  const ORG_CHAVE_DIVERGE = "09080001-0000-4000-8000-000000000004";
  const CHAVE_DIVERGE = "09080001-c0de-4000-8000-000000000005";

  it("mesma chave, valor diferente: 22023 (billing_chave_com_valores_diferentes)", () => {
    const erro = erroDe(`
      begin;
      ${criarOrgComContratoPadraoSql(ORG_CHAVE_DIVERGE, "pag-chave-diverge")}
      select public.fn_billing_registrar_pagamento('${ORG_CHAVE_DIVERGE}'::uuid, '2027-01-10'::date, 700, '${CHAVE_DIVERGE}'::uuid, 'nota', null);
      select public.fn_billing_registrar_pagamento('${ORG_CHAVE_DIVERGE}'::uuid, '2027-01-10'::date, 999, '${CHAVE_DIVERGE}'::uuid, 'nota', null);
      rollback;
    `);
    expect(erro).not.toBeNull();
    expect(erro).toContain("billing_chave_com_valores_diferentes");
  });

  const ORG_FIM_ANTERIOR = "09080001-0000-4000-8000-000000000005";
  const CHAVE_FIM_ANTERIOR_A = "09080001-c0de-4000-8000-000000000006";
  const CHAVE_FIM_ANTERIOR_B = "09080001-c0de-4000-8000-000000000007";

  it("fim não posterior ao período de referência: 22023 (billing_fim_anterior_ao_periodo_atual)", () => {
    const erro = erroDe(`
      begin;
      ${criarOrgComContratoPadraoSql(ORG_FIM_ANTERIOR, "pag-fim-anterior")}
      select public.fn_billing_registrar_pagamento('${ORG_FIM_ANTERIOR}'::uuid, '2027-01-10'::date, 700, '${CHAVE_FIM_ANTERIOR_A}'::uuid, 'nota', null);
      select public.fn_billing_registrar_pagamento('${ORG_FIM_ANTERIOR}'::uuid, '2027-01-05'::date, 700, '${CHAVE_FIM_ANTERIOR_B}'::uuid, 'nota', null);
      rollback;
    `);
    expect(erro).not.toBeNull();
    expect(erro).toContain("billing_fim_anterior_ao_periodo_atual");
  });

  // ── privilégios de billing_payments (decisão 1: só de acréscimo, sem
  //    grant nenhum para authenticated) ──
  const ORG_PRIV = "09080001-0000-4000-8000-000000000006";
  const USER_PRIV = "09080001-1111-4000-8000-000000000001";
  const CHAVE_PRIV_SEED = "09080001-c0de-4000-8000-000000000008";

  describe("service_role não faz update nem delete em billing_payments (decisão 1)", () => {
    beforeAll(() => {
      comoServico(`
        ${criarOrgComContratoPadraoSql(ORG_PRIV, "pag-priv")}
        select public.fn_billing_registrar_pagamento('${ORG_PRIV}'::uuid, '2027-01-10'::date, 500, '${CHAVE_PRIV_SEED}'::uuid, 'seed', null);
      `);
    });

    it("service_role é barrado ao dar UPDATE em billing_payments", () => {
      esperaBarradoComoPapel(
        "service_role",
        `update public.billing_payments set gross_cents = 1 where organization_id = '${ORG_PRIV}'`,
        "update em billing_payments sob service_role",
      );
    });

    it("service_role é barrado ao dar DELETE em billing_payments", () => {
      esperaBarradoComoPapel(
        "service_role",
        `delete from public.billing_payments where organization_id = '${ORG_PRIV}'`,
        "delete em billing_payments sob service_role",
      );
    });

    it("a linha semeada continua intacta", () => {
      const linhas = comoServico(
        `select 'SONDA|' || gross_cents from public.billing_payments where organization_id = '${ORG_PRIV}' and chave = '${CHAVE_PRIV_SEED}';`,
      );
      expect(linhas).toEqual(["500"]);
    });
  });

  describe("`authenticated` não lê nem grava billing_payments (decisão 1: telas leem pelo servidor)", () => {
    beforeAll(() => {
      comoServico(`insert into auth.users (id, email) values ('${USER_PRIV}', 'pag-priv@invariant.test') on conflict (id) do nothing;`);
    });

    it("select barrado", () => {
      esperaBarrado(USER_PRIV, `select id from public.billing_payments limit 1`, "select em billing_payments");
    });

    it("insert barrado", () => {
      esperaBarrado(
        USER_PRIV,
        `insert into public.billing_payments (organization_id, contract_id, gross_cents, status, paid_at, billing_period_start, billing_period_end, chave)
           select organization_id, id, 100, 'RECEIVED_IN_CASH', now(), now(), now() + interval '1 day', gen_random_uuid()
           from public.billing_contracts where organization_id = '${ORG_PRIV}'`,
        "insert em billing_payments",
      );
    });
  });

  // Correção (revisão F4, item 4): billing_contract_eventos, mesmo desenho
  // deny-all de billing_payments (RLS ligada, ZERO policy, revoke all de
  // anon/authenticated). Citada em tests/invariants/rls-completude-varredura.test.ts
  // (PROVA_PROPRIA).
  describe("`authenticated` não lê nem grava billing_contract_eventos (correção revisão F4, item 4: telas leem pelo servidor)", () => {
    it("select barrado", () => {
      esperaBarrado(USER_PRIV, `select id from public.billing_contract_eventos limit 1`, "select em billing_contract_eventos");
    });

    it("insert barrado", () => {
      esperaBarrado(
        USER_PRIV,
        `insert into public.billing_contract_eventos (organization_id, contract_id, tipo, de, para)
           select organization_id, id, 'estado', 'ativa', 'cancelada'
           from public.billing_contracts where organization_id = '${ORG_PRIV}'`,
        "insert em billing_contract_eventos",
      );
    });
  });

  // ── estorno (decisão 2) e o estorno duplo (achado da Tarefa 1, corrigido
  //    na própria 0908 via billing_payments.estorna_pagamento_id) ──
  const ORG_ESTORNO = "09080001-0000-4000-8000-000000000007";
  const CHAVE_PAG_ESTORNO = "09080001-c0de-4000-8000-000000000009";
  const CHAVE_ESTORNO_1 = "09080001-c0de-4000-8000-00000000000a";
  const CHAVE_ESTORNO_2 = "09080001-c0de-4000-8000-00000000000b";

  it("estorno grava REFUNDED com o mesmo valor/período do original, e NÃO mexe no período do contrato", () => {
    const linhas = comoServico(`
      begin;
      ${criarOrgComContratoPadraoSql(ORG_ESTORNO, "pag-estorno")}
      select public.fn_billing_registrar_pagamento('${ORG_ESTORNO}'::uuid, '2027-03-10'::date, 2000, '${CHAVE_PAG_ESTORNO}'::uuid, 'nota', null);
      select public.fn_billing_estornar_pagamento(
        '${ORG_ESTORNO}'::uuid,
        (select id from public.billing_payments where organization_id = '${ORG_ESTORNO}' and chave = '${CHAVE_PAG_ESTORNO}'),
        '${CHAVE_ESTORNO_1}'::uuid, 'motivo do estorno', null
      );
      select 'SONDA|status=' || status || '|gross=' || gross_cents
        from public.billing_payments where organization_id = '${ORG_ESTORNO}' and chave = '${CHAVE_ESTORNO_1}';
      select 'SONDA|periodo_intacto=' || (current_period_end = ${fimDeDiaSpExpr("'2027-03-10'")})::text
        from public.billing_contracts where organization_id = '${ORG_ESTORNO}';
      rollback;
    `);
    expect(linhas).toEqual(["status=REFUNDED|gross=2000", "periodo_intacto=true"]);
  });

  it("segundo estorno do MESMO pagamento, com OUTRA chave: 22023 (billing_pagamento_ja_estornado, achado da Tarefa 1)", () => {
    const erro = erroDe(`
      begin;
      ${criarOrgComContratoPadraoSql(ORG_ESTORNO, "pag-estorno")}
      select public.fn_billing_registrar_pagamento('${ORG_ESTORNO}'::uuid, '2027-03-10'::date, 2000, '${CHAVE_PAG_ESTORNO}'::uuid, 'nota', null);
      select public.fn_billing_estornar_pagamento(
        '${ORG_ESTORNO}'::uuid,
        (select id from public.billing_payments where organization_id = '${ORG_ESTORNO}' and chave = '${CHAVE_PAG_ESTORNO}'),
        '${CHAVE_ESTORNO_1}'::uuid, 'primeiro estorno', null
      );
      -- Antes da correção (Tarefa 1), esta segunda chamada, com CHAVE
      -- diferente, estornava o MESMO pagamento de novo: a checagem antiga só
      -- olhava o status da linha ORIGINAL (que billing_payments, só de
      -- acréscimo, nunca atualiza). estorna_pagamento_id fecha isso.
      select public.fn_billing_estornar_pagamento(
        '${ORG_ESTORNO}'::uuid,
        (select id from public.billing_payments where organization_id = '${ORG_ESTORNO}' and chave = '${CHAVE_PAG_ESTORNO}'),
        '${CHAVE_ESTORNO_2}'::uuid, 'segundo estorno, chave diferente', null
      );
      rollback;
    `);
    expect(erro).not.toBeNull();
    expect(erro).toContain("billing_pagamento_ja_estornado");
  });

  // ── evento de billing_contract_eventos quando o pagamento MUDA o estado
  //    do contrato (correção segunda rodada F4, item 2) ──
  const ORG_PAGAMENTO_EVENTO = "09080001-0000-4000-8000-000000000009";
  const CHAVE_PAGAMENTO_EVENTO_ATIVA = "09080001-c0de-4000-8000-00000000000c";
  const CHAVE_PAGAMENTO_EVENTO_ATRASADA = "09080001-c0de-4000-8000-00000000000d";
  const ACTOR_PAGAMENTO_EVENTO = "09080001-1111-4000-8000-000000000002";

  it("pagamento que NÃO muda o estado (contrato já ativa) não grava evento em billing_contract_eventos (correção segunda rodada F4, item 2)", () => {
    const linhas = comoServico(`
      begin;
      ${criarOrgComContratoPadraoSql(ORG_PAGAMENTO_EVENTO, "pag-evento")}
      select public.fn_billing_registrar_pagamento('${ORG_PAGAMENTO_EVENTO}'::uuid, '2027-01-10'::date, 1000, '${CHAVE_PAGAMENTO_EVENTO_ATIVA}'::uuid, 'nota', '${ACTOR_PAGAMENTO_EVENTO}'::uuid);
      select 'SONDA|' || count(*) from public.billing_contract_eventos where organization_id = '${ORG_PAGAMENTO_EVENTO}';
      rollback;
    `);
    expect(linhas).toEqual(["0"]);
  });

  it("pagamento que MUDA o estado (atrasada -> ativa) grava um evento (tipo=estado, de=atrasada, para=ativa, motivo=pagamento, actor=p_actor) na MESMA transação (correção segunda rodada F4, item 2)", () => {
    const linhas = comoServico(`
      begin;
      ${criarOrgComContratoPadraoSql(ORG_PAGAMENTO_EVENTO, "pag-evento")}
      update public.billing_contracts set status = 'atrasada', current_period_end = now() - interval '5 days' where organization_id = '${ORG_PAGAMENTO_EVENTO}';
      select public.fn_billing_registrar_pagamento('${ORG_PAGAMENTO_EVENTO}'::uuid, '2027-01-10'::date, 1000, '${CHAVE_PAGAMENTO_EVENTO_ATRASADA}'::uuid, 'nota', '${ACTOR_PAGAMENTO_EVENTO}'::uuid);
      select 'SONDA|' || tipo || '|' || de || '|' || para || '|' || motivo || '|' || actor
        from public.billing_contract_eventos where organization_id = '${ORG_PAGAMENTO_EVENTO}';
      rollback;
    `);
    expect(linhas).toEqual([`estado|atrasada|ativa|pagamento|${ACTOR_PAGAMENTO_EVENTO}`]);
  });

  // ── corrigir período (decisão 2) ──
  const ORG_CORRIGIR = "09080001-0000-4000-8000-000000000008";

  it("corrigir período sem motivo: 22023 (billing_motivo_obrigatorio)", () => {
    const erroNulo = erroDe(`
      begin;
      ${criarOrgComContratoPadraoSql(ORG_CORRIGIR, "pag-corrigir-1")}
      select public.fn_billing_corrigir_periodo('${ORG_CORRIGIR}'::uuid, '2027-01-01'::date, null, null);
      rollback;
    `);
    expect(erroNulo).not.toBeNull();
    expect(erroNulo).toContain("billing_motivo_obrigatorio");

    const erroBranco = erroDe(`
      begin;
      ${criarOrgComContratoPadraoSql(ORG_CORRIGIR, "pag-corrigir-1")}
      select public.fn_billing_corrigir_periodo('${ORG_CORRIGIR}'::uuid, '2027-01-01'::date, '   ', null);
      rollback;
    `);
    expect(erroBranco).not.toBeNull();
    expect(erroBranco).toContain("billing_motivo_obrigatorio");
  });
});

// ============================================================================
// 2. Estados: fn_billing_mudar_estado, as transições da decisão 3.
// ============================================================================

describe("2. Estados", () => {
  let seq = 0;
  function novoOrg(): string {
    seq += 1;
    return `09080002-0000-4000-8000-${String(seq).padStart(12, "0")}`;
  }

  /**
   * Organização com o contrato posto DIRETO no estado/período pedidos
   * (update direto, não pela função sob teste: é só o fixture). `periodo`:
   * "futuro" (now()+30d), "passado" (now()-30d), ou null (current_period_end
   * fica nulo, o valor que toda organização nova já nasce com).
   */
  function fixtureEstado(org: string, status: string, periodo: "futuro" | "passado" | null): string {
    const periodoExpr = periodo === "futuro" ? "now() + interval '30 days'" : periodo === "passado" ? "now() - interval '30 days'" : null;
    return `
      ${criarOrgComContratoPadraoSql(org, `estado-${org.slice(-6)}`)}
      update public.billing_contracts
        set status = '${status}'${periodoExpr ? `, current_period_end = ${periodoExpr}` : ""}
        where organization_id = '${org}';
    `;
  }

  interface CasoTransicao {
    readonly nome: string;
    readonly de: string;
    readonly periodo: "futuro" | "passado" | null;
    readonly para: string;
    readonly permitida: boolean;
    readonly mensagemDeErro?: string;
  }

  const CASOS: readonly CasoTransicao[] = [
    { nome: "ativa -> cancelada, sem período, permitida", de: "ativa", periodo: null, para: "cancelada", permitida: true },
    { nome: "avaliacao -> cancelada, sem período, permitida (qualquer estado -> cancelada)", de: "avaliacao", periodo: null, para: "cancelada", permitida: true },
    { nome: "ativa -> atrasada, permitida", de: "ativa", periodo: null, para: "atrasada", permitida: true },
    { nome: "ativa -> suspensa, permitida", de: "ativa", periodo: null, para: "suspensa", permitida: true },
    { nome: "suspensa -> ativa, com período futuro, permitida", de: "suspensa", periodo: "futuro", para: "ativa", permitida: true },
    { nome: "atrasada -> ativa, com período futuro, permitida", de: "atrasada", periodo: "futuro", para: "ativa", permitida: true },
    { nome: "cancelada -> ativa, com período futuro, permitida", de: "cancelada", periodo: "futuro", para: "ativa", permitida: true },
    { nome: "suspensa -> avaliacao, com período preenchido (futuro), permitida", de: "suspensa", periodo: "futuro", para: "avaliacao", permitida: true },
    // Correção (revisão F4, item 2): avaliacao passa a exigir período FUTURO,
    // não só preenchido. Período PASSADO agora é 22023 próprio
    // (billing_avaliacao_sem_data_futura), não mais permitido.
    { nome: "atrasada -> avaliacao, com período FUTURO, permitida", de: "atrasada", periodo: "futuro", para: "avaliacao", permitida: true },
    {
      nome: "atrasada -> avaliacao, com período preenchido no PASSADO, 22023 (billing_avaliacao_sem_data_futura, correção revisão F4 item 2)",
      de: "atrasada",
      periodo: "passado",
      para: "avaliacao",
      permitida: false,
      mensagemDeErro: "billing_avaliacao_sem_data_futura",
    },
    { nome: "avaliacao -> atrasada, PROIBIDA (atrasada só sai de ativa)", de: "avaliacao", periodo: null, para: "atrasada", permitida: false, mensagemDeErro: "billing_transicao_nao_permitida" },
    { nome: "suspensa -> atrasada, PROIBIDA (atrasada só sai de ativa)", de: "suspensa", periodo: null, para: "atrasada", permitida: false, mensagemDeErro: "billing_transicao_nao_permitida" },
    { nome: "atrasada -> suspensa, PROIBIDA (suspensa só sai de ativa)", de: "atrasada", periodo: null, para: "suspensa", permitida: false, mensagemDeErro: "billing_transicao_nao_permitida" },
    { nome: "cancelada -> atrasada, PROIBIDA", de: "cancelada", periodo: null, para: "atrasada", permitida: false, mensagemDeErro: "billing_transicao_nao_permitida" },
    { nome: "cancelada -> ativa, SEM período vigente, 22023 (billing_estado_sem_periodo_vigente)", de: "cancelada", periodo: null, para: "ativa", permitida: false, mensagemDeErro: "billing_estado_sem_periodo_vigente" },
    {
      nome: "ativa -> avaliacao, SEM data de fim, 22023 (billing_avaliacao_sem_data_futura, correção revisão F4 item 2)",
      de: "ativa",
      periodo: null,
      para: "avaliacao",
      permitida: false,
      mensagemDeErro: "billing_avaliacao_sem_data_futura",
    },
    // Correção (revisão F4, item 3): ativa -> ativa é sucesso SEM MUDANÇA
    // quando o período está vigente; com período vencido mantém o erro atual
    // (billing_estado_sem_periodo_vigente, a mesma mensagem de qualquer outra
    // transição para ativa sem período vigente).
    { nome: "ativa -> ativa, com período FUTURO, sucesso sem mudança (correção revisão F4 item 3)", de: "ativa", periodo: "futuro", para: "ativa", permitida: true },
    {
      nome: "ativa -> ativa, com período VENCIDO, mantém o erro (billing_estado_sem_periodo_vigente, correção revisão F4 item 3)",
      de: "ativa",
      periodo: "passado",
      para: "ativa",
      permitida: false,
      mensagemDeErro: "billing_estado_sem_periodo_vigente",
    },
  ];

  for (const caso of CASOS) {
    it(caso.nome, () => {
      const org = novoOrg();
      if (caso.permitida) {
        const linhas = comoServico(`
          begin;
          ${fixtureEstado(org, caso.de, caso.periodo)}
          select public.fn_billing_mudar_estado('${org}'::uuid, '${caso.para}', 'motivo do caso', null);
          select 'SONDA|' || status from public.billing_contracts where organization_id = '${org}';
          rollback;
        `);
        expect(linhas).toEqual([caso.para]);
      } else {
        const erro = erroDe(`
          begin;
          ${fixtureEstado(org, caso.de, caso.periodo)}
          select public.fn_billing_mudar_estado('${org}'::uuid, '${caso.para}', 'motivo do caso', null);
          rollback;
        `);
        expect(erro).not.toBeNull();
        expect(erro).toContain(caso.mensagemDeErro);
      }
    });
  }
});

// ============================================================================
// 3. Conferidor: fn_billing_conferir_vencimento (decisão 4).
// ============================================================================

describe("3. Conferidor", () => {
  const ORG_SEM_PERIODO = "09080003-0000-4000-8000-000000000001";
  const ORG_CANCEL_AT_PERIOD_END = "09080003-0000-4000-8000-000000000002";
  const ORG_ATIVA_VENCIDA = "09080003-0000-4000-8000-000000000003";
  const ORG_ATRASADA_ALEM_DA_CARENCIA = "09080003-0000-4000-8000-000000000004";
  const ORG_RODAR_DE_NOVO = "09080003-0000-4000-8000-000000000005";

  it("organização sem current_period_end nunca muda (devolve null)", () => {
    const linhas = comoServico(`
      begin;
      ${criarOrgComContratoPadraoSql(ORG_SEM_PERIODO, "conf-sem-periodo")}
      select 'SONDA|' || coalesce(public.fn_billing_conferir_vencimento('${ORG_SEM_PERIODO}'::uuid)::text, 'null');
      select 'SONDA|' || status from public.billing_contracts where organization_id = '${ORG_SEM_PERIODO}';
      rollback;
    `);
    expect(linhas).toEqual(["null", "ativa"]);
  });

  it("cancel_at_period_end + período vencido: cancelada (vence ANTES do atraso, nunca passa por atrasada)", () => {
    const linhas = comoServico(`
      begin;
      ${criarOrgComContratoPadraoSql(ORG_CANCEL_AT_PERIOD_END, "conf-cancel-at-period-end")}
      update public.billing_contracts
        set status = 'ativa', cancel_at_period_end = true, current_period_end = now() - interval '1 hour'
        where organization_id = '${ORG_CANCEL_AT_PERIOD_END}';
      select 'SONDA|' || public.fn_billing_conferir_vencimento('${ORG_CANCEL_AT_PERIOD_END}'::uuid);
      select 'SONDA|' || status from public.billing_contracts where organization_id = '${ORG_CANCEL_AT_PERIOD_END}';
      rollback;
    `);
    expect(linhas).toEqual(["cancelada", "cancelada"]);
  });

  it("ativa vencida vira atrasada", () => {
    const linhas = comoServico(`
      begin;
      ${criarOrgComContratoPadraoSql(ORG_ATIVA_VENCIDA, "conf-ativa-vencida")}
      update public.billing_contracts
        set status = 'ativa', current_period_end = now() - interval '1 hour'
        where organization_id = '${ORG_ATIVA_VENCIDA}';
      select 'SONDA|' || public.fn_billing_conferir_vencimento('${ORG_ATIVA_VENCIDA}'::uuid);
      select 'SONDA|' || status from public.billing_contracts where organization_id = '${ORG_ATIVA_VENCIDA}';
      rollback;
    `);
    expect(linhas).toEqual(["atrasada", "atrasada"]);
  });

  it("atrasada além de grace_days (7, o padrão do Ilimitado) vira suspensa", () => {
    const linhas = comoServico(`
      begin;
      ${criarOrgComContratoPadraoSql(ORG_ATRASADA_ALEM_DA_CARENCIA, "conf-atrasada-alem-carencia")}
      update public.billing_contracts
        set status = 'atrasada', current_period_end = now() - interval '10 days'
        where organization_id = '${ORG_ATRASADA_ALEM_DA_CARENCIA}';
      select 'SONDA|' || public.fn_billing_conferir_vencimento('${ORG_ATRASADA_ALEM_DA_CARENCIA}'::uuid);
      select 'SONDA|' || status from public.billing_contracts where organization_id = '${ORG_ATRASADA_ALEM_DA_CARENCIA}';
      rollback;
    `);
    expect(linhas).toEqual(["suspensa", "suspensa"]);
  });

  it("rodar de novo, já suspensa, não muda nada (devolve null)", () => {
    const linhas = comoServico(`
      begin;
      ${criarOrgComContratoPadraoSql(ORG_RODAR_DE_NOVO, "conf-rodar-de-novo")}
      update public.billing_contracts
        set status = 'atrasada', current_period_end = now() - interval '10 days'
        where organization_id = '${ORG_RODAR_DE_NOVO}';
      select public.fn_billing_conferir_vencimento('${ORG_RODAR_DE_NOVO}'::uuid);
      select 'SONDA|' || coalesce(public.fn_billing_conferir_vencimento('${ORG_RODAR_DE_NOVO}'::uuid)::text, 'null');
      select 'SONDA|' || status from public.billing_contracts where organization_id = '${ORG_RODAR_DE_NOVO}';
      rollback;
    `);
    expect(linhas).toEqual(["null", "suspensa"]);
  });

  /**
   * Como `sql` (`psql-transporte.ts`), mas ASSÍNCRONA e numa sessão psql
   * PRÓPRIA: o caso de corrida real precisa de DUAS conexões vivas ao mesmo
   * tempo (`sql()` é síncrona, execFileSync, duas chamadas dela nunca se
   * sobrepõem). Cópia do mesmo helper de `planos-carteira.test.ts` (caso 13):
   * duplicação registrada, não módulo compartilhado, para este arquivo não
   * arrastar `describe`/`beforeAll` de outro.
   */
  function sqlAsync(script: string): Promise<{ ok: boolean; erro: string | null }> {
    const container = process.env.TEST_DB_CONTAINER;
    const psqlLocal = process.env.TEST_DB_PSQL;
    const bin = psqlLocal ?? "docker";
    const args = psqlLocal
      ? [process.env.TEST_DB_CONN ?? "postgres://postgres@localhost/postgres", "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"]
      : ["exec", "-i", container as string, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"];

    return new Promise((resolve) => {
      const proc = spawn(bin, args);
      let stderr = "";
      proc.stderr.on("data", (d) => (stderr += d.toString()));
      proc.on("close", (code) => resolve({ ok: code === 0, erro: code === 0 ? null : stderr }));
      proc.stdin.write(script);
      proc.stdin.end();
    });
  }

  describe("corrida real: um pagamento segurando a linha, o conferidor no meio, não sobrescreve o ativa", () => {
    // Organização nasce ATRASADA e além da carência (o conferidor, sozinho,
    // levaria a suspensa). Sessão A chama fn_billing_registrar_pagamento de
    // verdade (o SELECT ... FOR UPDATE dela prende a linha) com um fim
    // FUTURO, dorme ANTES do commit (a atualização de status='ativa' já
    // aconteceu dentro da transação, só não commitou), e só então commita.
    // Sessão B chama fn_billing_conferir_vencimento pouco depois de A
    // começar: o UPDATE do passo (c) enxerga a linha ainda como 'atrasada'
    // (o snapshot ANTES do commit de A), tenta travar a linha e BLOQUEIA no
    // lock de escrita dela até A commitar; ao continuar, o Postgres reavalia
    // o WHERE contra o valor JÁ COMMITADO (EvalPlanQual): 'ativa', período
    // futuro, não bate mais, e o UPDATE não afeta linha nenhuma. É a prova
    // direta do comentário da migração (0908, seção 7).
    const ORG_CORRIDA = "09080003-0000-4000-8000-000000000006";
    const CHAVE_CORRIDA = "09080003-c0de-4000-8000-000000000001";

    afterAll(() => {
      // Limpeza: este é o único caso do arquivo que COMMITA de verdade
      // (precisa de duas transações reais overlapping); apaga a organização
      // (cascata: contrato e pagamento) para não deixar rastro entre rodadas.
      comoServico(`delete from public.organizations where id = '${ORG_CORRIDA}';`);
    });

    it("depois da corrida, o contrato continua ativa com o período do pagamento (não virou suspensa)", async () => {
      comoServico(`
        ${criarOrgComContratoPadraoSql(ORG_CORRIDA, "conf-corrida")}
        update public.billing_contracts
          set status = 'atrasada', current_period_end = now() - interval '10 days'
          where organization_id = '${ORG_CORRIDA}';
      `);

      const sessaoA = `
        begin;
        select public.fn_billing_registrar_pagamento('${ORG_CORRIDA}'::uuid, (current_date + 30)::date, 1000, '${CHAVE_CORRIDA}'::uuid, 'pagamento da corrida', null);
        select pg_sleep(2.5);
        commit;
      `;
      const sessaoB = `
        select pg_sleep(0.3);
        select public.fn_billing_conferir_vencimento('${ORG_CORRIDA}'::uuid);
      `;

      const [resultadoA, resultadoB] = await Promise.all([sqlAsync(sessaoA), sqlAsync(sessaoB)]);
      expect(resultadoA.ok, resultadoA.erro ?? "").toBe(true);
      expect(resultadoB.ok, resultadoB.erro ?? "").toBe(true);

      const linhas = comoServico(
        `select 'SONDA|status=' || status || '|periodo_futuro=' || (current_period_end > now())::text
           from public.billing_contracts where organization_id = '${ORG_CORRIDA}';`,
      );
      expect(linhas, "o conferidor não pode ter sobrescrito o pagamento que entrou no meio").toEqual(["status=ativa|periodo_futuro=true"]);
    });
  });
});

// ============================================================================
// 4. Avisos: fn_billing_avisar_assinatura, chamada de dentro do conferidor
//    (decisão 9).
// ============================================================================

describe("4. Avisos", () => {
  /** Avisos de assinatura ABERTOS da organização. */
  function avisosAbertosDe(org: string): number {
    return Number(
      comoServico(
        `select 'SONDA|' || count(*) from public.agent_inbox_items where organization_id = '${org}' and kind = 'other' and ref_kind = 'billing_assinatura' and status = 'open';`,
      )[0],
    );
  }

  /** Como acima, mas SEM filtrar status, para provar que encerrar não some da contagem total. */
  function avisosTotalDe(org: string): number {
    return Number(
      comoServico(
        `select 'SONDA|' || count(*) from public.agent_inbox_items where organization_id = '${org}' and kind = 'other' and ref_kind = 'billing_assinatura';`,
      )[0],
    );
  }

  const ORG_ATRASADA = "09080004-0000-4000-8000-000000000001";

  it("entrar em atrasada (via conferidor) cria o aviso 'Pagamento em atraso' uma vez", () => {
    comoServico(`
      ${criarOrgComContratoPadraoSql(ORG_ATRASADA, "aviso-atrasada")}
      update public.billing_contracts set status = 'ativa', current_period_end = now() - interval '1 hour' where organization_id = '${ORG_ATRASADA}';
      select public.fn_billing_conferir_vencimento('${ORG_ATRASADA}'::uuid);
    `);
    expect(avisosAbertosDe(ORG_ATRASADA)).toBe(1);
    const titulos = comoServico(
      `select 'SONDA|' || title || '|' || severity from public.agent_inbox_items where organization_id = '${ORG_ATRASADA}' and ref_kind = 'billing_assinatura';`,
    );
    expect(titulos).toEqual(["Pagamento em atraso|warn"]);
  });

  it("rodar o conferidor de novo, ainda atrasada, não duplica o aviso", () => {
    comoServico(`select public.fn_billing_conferir_vencimento('${ORG_ATRASADA}'::uuid);`);
    expect(avisosTotalDe(ORG_ATRASADA)).toBe(1);
  });

  const ORG_TRES_DIAS = "09080004-0000-4000-8000-000000000002";

  it("atrasada há tempo suficiente (grace_days=7 > 3) emite TAMBÉM o aviso de três dias antes da suspensão, junto do de entrada, quando o efeito vale ou vai valer (correção revisão F4, item 7)", () => {
    // data_suspensao = current_period_end + 7 dias. Escolhendo
    // current_period_end = now() - 5 dias, data_suspensao = now() + 2 dias,
    // que cai dentro da janela [data_suspensao - 3 dias, data_suspensao) já
    // na primeira chamada (decisão 9). Correção (revisão F4, item 7): o
    // aviso de três dias só nasce quando o efeito VAI VALER de verdade
    // (modo=bloquear E a organização tem carência definida); modo volta a
    // 'avisar' no fim do MESMO script, sem vazar para os outros casos deste
    // arquivo.
    comoServico(`
      ${criarOrgComContratoPadraoSql(ORG_TRES_DIAS, "aviso-tres-dias")}
      update public.billing_contracts
        set status = 'atrasada', current_period_end = now() - interval '5 days', bloqueio_a_partir_de = now() - interval '1 day'
        where organization_id = '${ORG_TRES_DIAS}';
      update public.billing_settings set modo = 'bloquear' where id = 1;
      select public.fn_billing_conferir_vencimento('${ORG_TRES_DIAS}'::uuid);
      update public.billing_settings set modo = 'avisar' where id = 1;
    `);
    const titulos = comoServico(
      `select 'SONDA|' || title from public.agent_inbox_items where organization_id = '${ORG_TRES_DIAS}' and ref_kind = 'billing_assinatura' order by title;`,
    );
    expect(titulos).toEqual(["Pagamento em atraso", "Suspensão em três dias"]);
  });

  const ORG_CARENCIA_POSTERIOR = "09080004-0000-4000-8000-000000000007";

  it("bloqueio_a_partir_de POSTERIOR à suspensão prevista pelo plano: o aviso usa a data REAL (greatest), e o de três dias não nasce cedo demais (correção segunda rodada F4, item 1)", () => {
    // data prevista pelo plano = current_period_end + 7 dias = now() + 2
    // dias (mesmo current_period_end do caso ORG_TRES_DIAS, acima). Aqui
    // bloqueio_a_partir_de = now() + 10 dias, POSTERIOR à prevista (o
    // inverso do caso ORG_TRES_DIAS, onde a carência é ANTERIOR e não muda
    // nada): fn_billing_modo_leitura só liga com bloqueio_a_partir_de <=
    // now(), então a suspensão de verdade só vale em now()+10 dias, não
    // now()+2. Sem o fix (item 1), o texto mentiria a data (now()+2) e o
    // aviso de três dias nasceria já na primeira chamada (now() >=
    // (now()+2)-3 = now()-1, verdadeiro), quando a janela real só abre em
    // now()+7.
    comoServico(`
      ${criarOrgComContratoPadraoSql(ORG_CARENCIA_POSTERIOR, "aviso-carencia-posterior")}
      update public.billing_contracts
        set status = 'atrasada', current_period_end = now() - interval '5 days', bloqueio_a_partir_de = now() + interval '10 days'
        where organization_id = '${ORG_CARENCIA_POSTERIOR}';
      update public.billing_settings set modo = 'bloquear' where id = 1;
      select public.fn_billing_conferir_vencimento('${ORG_CARENCIA_POSTERIOR}'::uuid);
      update public.billing_settings set modo = 'avisar' where id = 1;
    `);

    const titulos = comoServico(
      `select 'SONDA|' || title from public.agent_inbox_items where organization_id = '${ORG_CARENCIA_POSTERIOR}' and ref_kind = 'billing_assinatura' order by title;`,
    );
    expect(titulos, "o aviso de três dias nasceu cedo demais: a janela usou a data prevista, não a real").toEqual(["Pagamento em atraso"]);

    // O corpo cita a data REAL (a de bloqueio_a_partir_de, maior que a
    // prevista), conferida contra a COLUNA gravada -- não recalculada em
    // JS, para não provar a fórmula contra si mesma.
    const linhas = comoServico(`
      select 'SONDA|' || (i.body like '%' || to_char(bc.bloqueio_a_partir_de at time zone 'America/Sao_Paulo', 'DD/MM/YYYY') || '%')::text
        from public.agent_inbox_items i
        join public.billing_contracts bc on bc.organization_id = i.organization_id
        where i.organization_id = '${ORG_CARENCIA_POSTERIOR}' and i.ref_kind = 'billing_assinatura' and i.title = 'Pagamento em atraso';
    `);
    expect(linhas, "o corpo do aviso não cita a data REAL (bloqueio_a_partir_de)").toEqual(["true"]);
  });

  const ORG_ATRASADA_SEM_AMEACA = "09080004-0000-4000-8000-000000000006";

  it("atrasada SEM ameaça real (modo avisar): texto neutro, sem data nem 'Suspensão em três dias' (correção revisão F4, item 7)", () => {
    comoServico(`
      ${criarOrgComContratoPadraoSql(ORG_ATRASADA_SEM_AMEACA, "aviso-atrasada-sem-ameaca")}
      update public.billing_contracts
        set status = 'atrasada', current_period_end = now() - interval '5 days', bloqueio_a_partir_de = null
        where organization_id = '${ORG_ATRASADA_SEM_AMEACA}';
      select public.fn_billing_conferir_vencimento('${ORG_ATRASADA_SEM_AMEACA}'::uuid);
    `);
    const linhas = comoServico(
      `select 'SONDA|' || title || '|' || body from public.agent_inbox_items where organization_id = '${ORG_ATRASADA_SEM_AMEACA}' and ref_kind = 'billing_assinatura';`,
    );
    expect(linhas).toEqual(["Pagamento em atraso|O pagamento da assinatura está em atraso. Regularize com o suporte."]);
  });

  const ORG_SUSPENSA = "09080004-0000-4000-8000-000000000003";

  it("suspender (via conferidor) emite o aviso 'Conta suspensa', crítico", () => {
    comoServico(`
      ${criarOrgComContratoPadraoSql(ORG_SUSPENSA, "aviso-suspensa")}
      update public.billing_contracts set status = 'atrasada', current_period_end = now() - interval '10 days' where organization_id = '${ORG_SUSPENSA}';
      select public.fn_billing_conferir_vencimento('${ORG_SUSPENSA}'::uuid);
    `);
    const titulos = comoServico(
      `select 'SONDA|' || title || '|' || severity from public.agent_inbox_items where organization_id = '${ORG_SUSPENSA}' and ref_kind = 'billing_assinatura';`,
    );
    expect(titulos).toEqual(["Conta suspensa|critical"]);
  });

  it("encerrar o aviso de suspensão e rodar o conferidor de novo não recria (dedup sobrevive ao encerramento)", () => {
    comoServico(`
      update public.agent_inbox_items set status = 'resolved' where organization_id = '${ORG_SUSPENSA}' and ref_kind = 'billing_assinatura';
      select public.fn_billing_conferir_vencimento('${ORG_SUSPENSA}'::uuid);
    `);
    expect(avisosTotalDe(ORG_SUSPENSA), "total continua 1: nenhum aviso novo de suspensão nasceu").toBe(1);
    expect(avisosAbertosDe(ORG_SUSPENSA), "abertos vira 0 (o único aviso segue resolvido)").toBe(0);
  });

  const ORG_CANCELADA = "09080004-0000-4000-8000-000000000004";

  it("cancelar (via conferidor) emite o aviso 'Assinatura cancelada'", () => {
    comoServico(`
      ${criarOrgComContratoPadraoSql(ORG_CANCELADA, "aviso-cancelada")}
      update public.billing_contracts set status = 'ativa', cancel_at_period_end = true, current_period_end = now() - interval '1 hour' where organization_id = '${ORG_CANCELADA}';
      select public.fn_billing_conferir_vencimento('${ORG_CANCELADA}'::uuid);
    `);
    const titulos = comoServico(
      `select 'SONDA|' || title from public.agent_inbox_items where organization_id = '${ORG_CANCELADA}' and ref_kind = 'billing_assinatura';`,
    );
    expect(titulos).toEqual(["Assinatura cancelada"]);
  });

  // ── viewer: não insere, não apaga, não reescreve, mas encerra (M2, 0905,
  //    estendida à decisão 9 desta fase) ──
  const ORG_VIEWER = "09080004-0000-4000-8000-000000000005";
  const VIEWER_USER = "09080004-1111-4000-8000-000000000001";

  describe("o viewer não forja, não apaga nem reescreve o aviso de assinatura, mas consegue encerrar", () => {
    let avisoId = "";

    beforeAll(() => {
      comoServico(`
        ${criarOrgComContratoPadraoSql(ORG_VIEWER, "aviso-viewer")}
        insert into auth.users (id, email) values ('${VIEWER_USER}', 'aviso-viewer@invariant.test') on conflict (id) do nothing;
        insert into public.user_organizations (user_id, organization_id, role, accepted_at)
          values ('${VIEWER_USER}', '${ORG_VIEWER}', 'viewer', now()) on conflict do nothing;
        update public.billing_contracts set status = 'atrasada', current_period_end = now() - interval '10 days' where organization_id = '${ORG_VIEWER}';
        select public.fn_billing_conferir_vencimento('${ORG_VIEWER}'::uuid);
      `);
      avisoId = comoServico(
        `select 'SONDA|' || id from public.agent_inbox_items where organization_id = '${ORG_VIEWER}' and ref_kind = 'billing_assinatura' and title = 'Conta suspensa';`,
      )[0]!;
    });

    it("viewer não insere um aviso forjado de billing_assinatura", () => {
      // Não é "permission denied": o viewer É membro da organização (a FOR
      // ALL tenant_isolation do autor dá privilégio de tabela); quem barra é
      // a policy RESTRICTIVE (M2/decisão 9), daí a mensagem de RLS.
      esperaRecusado(
        VIEWER_USER,
        `insert into public.agent_inbox_items (organization_id, kind, severity, title, body, ref_kind, ref_id)
           values ('${ORG_VIEWER}', 'other', 'critical', 'Forjado', 'corpo forjado', 'billing_assinatura', '${ORG_VIEWER}')`,
        "insert de aviso forjado por viewer",
        "row-level security policy",
      );
    });

    it("viewer não apaga o aviso real", () => {
      // Diferente do INSERT (o `with check` de uma RESTRICTIVE rejeitada
      // ERRA) e do UPDATE (o gatilho ERRA): um DELETE cuja linha não passa
      // no `using` de uma RESTRICTIVE simplesmente não a inclui no comando,
      // sem lançar exceção nenhuma ("DELETE 0"). A prova aqui é a linha
      // continuar existindo depois da tentativa, não um erro.
      const linhas = membro(
        VIEWER_USER,
        `delete from public.agent_inbox_items where id = '${avisoId}';
         select 'SONDA|' || count(*) from public.agent_inbox_items where id = '${avisoId}';`,
      );
      expect(linhas, "o aviso real sumiu: a policy RESTRICTIVE de delete não está barrando o viewer").toEqual(["1"]);
    });

    it("viewer não reescreve título/corpo do aviso real", () => {
      // O UPDATE não é barrado por RLS (a FOR ALL do autor permite), e sim
      // pelo GATILHO de update (fn_billing_trava_agent_inbox_items_update,
      // 0905/0908): mensagem própria, não "row-level security policy".
      esperaRecusado(
        VIEWER_USER,
        `update public.agent_inbox_items set title = 'Reescrito' where id = '${avisoId}'`,
        "update de título por viewer",
        "só status e resolved_at podem mudar fora do servidor",
      );
    });

    it("viewer CONSEGUE encerrar (status/resolved_at são as duas colunas permitidas)", () => {
      const linhas = membro(
        VIEWER_USER,
        `update public.agent_inbox_items set status = 'resolved', resolved_at = now() where id = '${avisoId}';
         select 'SONDA|' || status from public.agent_inbox_items where id = '${avisoId}';`,
      );
      expect(linhas).toEqual(["resolved"]);
    });
  });
});

// ============================================================================
// 5. Modo leitura: fn_billing_modo_leitura e os quatro gatilhos de criação
//    (decisões 5, 6 e 7).
// ============================================================================

describe("5. Modo leitura", () => {
  function ajustarLimitesGenerosos(org: string): string {
    return `select public.fn_billing_ajustar_limites('${org}'::uuid, '{"funis": 1000, "etapas_por_funil": 1000, "leads": 1000, "membros": 1000, "conexoes": 1000, "integracoes_webhook": 1000}'::jsonb, null, null);`;
  }

  /** Organização com pipeline+etapa BASE já existindo, limites generosos (o teto nunca é o que bloqueia aqui, só o modo leitura). */
  function fixtureBase(org: string, slug: string, pipeline: string, stage: string): string {
    return `
      ${criarOrgComContratoPadraoSql(org, slug)}
      ${ajustarLimitesGenerosos(org)}
      insert into public.crm_pipelines (id, organization_id, name, slug)
        values ('${pipeline}', '${org}', 'Funil Base', '${slug}-funil-base')
        on conflict (id) do nothing;
      insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position)
        values ('${stage}', '${org}', '${pipeline}', 'Entrada', '${slug}-entrada', 1000)
        on conflict (id) do nothing;
    `;
  }

  /** Liga o bloqueio DEPOIS da fixture base (senão a própria fixture já esbarraria no modo leitura). */
  function ligarModoLeitura(org: string, bloqueioExpr: string, status: string): string {
    return `
      update public.billing_settings set modo = 'bloquear' where id = 1;
      update public.billing_contracts set bloqueio_a_partir_de = ${bloqueioExpr}, status = '${status}' where organization_id = '${org}';
    `;
  }

  // ── os quatro gatilhos de criação recusam (decisão 7) ──
  const ORG_NEG = "09080005-0000-4000-8000-000000000001";
  const PIPELINE_NEG_BASE = "09080005-0000-4000-8000-000000000002";
  const STAGE_NEG_BASE = "09080005-0000-4000-8000-000000000003";
  const PIPELINE_NEG_NOVO = "09080005-0000-4000-8000-000000000004";
  const STAGE_NEG_NOVO = "09080005-0000-4000-8000-000000000005";
  const WEBHOOK_NEG = "09080005-0000-4000-8000-000000000006";

  it("criar um NOVO funil sob modo leitura dá PT402/assinatura_suspensa", () => {
    const erro = erroDe(`
      begin;
      ${fixtureBase(ORG_NEG, "ml-neg", PIPELINE_NEG_BASE, STAGE_NEG_BASE)}
      ${ligarModoLeitura(ORG_NEG, "now() - interval '1 day'", "suspensa")}
      insert into public.crm_pipelines (id, organization_id, name, slug)
        values ('${PIPELINE_NEG_NOVO}', '${ORG_NEG}', 'Funil Novo', 'ml-neg-funil-novo');
      rollback;
    `);
    expect(erro).not.toBeNull();
    expect(erro).toContain("Conta suspensa");
    expect(erro).toContain("assinatura_suspensa");
  });

  it("criar uma NOVA etapa sob modo leitura dá PT402/assinatura_suspensa", () => {
    const erro = erroDe(`
      begin;
      ${fixtureBase(ORG_NEG, "ml-neg", PIPELINE_NEG_BASE, STAGE_NEG_BASE)}
      ${ligarModoLeitura(ORG_NEG, "now() - interval '1 day'", "suspensa")}
      insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position)
        values ('${STAGE_NEG_NOVO}', '${ORG_NEG}', '${PIPELINE_NEG_BASE}', 'Etapa Nova', 'ml-neg-etapa-nova', 2000);
      rollback;
    `);
    expect(erro).not.toBeNull();
    expect(erro).toContain("Conta suspensa");
    expect(erro).toContain("assinatura_suspensa");
  });

  it("criar uma NOVA integração webhook sob modo leitura dá PT402/assinatura_suspensa", () => {
    const erro = erroDe(`
      begin;
      ${fixtureBase(ORG_NEG, "ml-neg", PIPELINE_NEG_BASE, STAGE_NEG_BASE)}
      ${ligarModoLeitura(ORG_NEG, "now() - interval '1 day'", "suspensa")}
      insert into public.webhook_sources (id, organization_id, name, path_token, default_pipeline_id, default_stage_id)
        values ('${WEBHOOK_NEG}', '${ORG_NEG}', 'Webhook ML', 'ml-neg-webhook-token', '${PIPELINE_NEG_BASE}', '${STAGE_NEG_BASE}');
      rollback;
    `);
    expect(erro).not.toBeNull();
    expect(erro).toContain("Conta suspensa");
    expect(erro).toContain("assinatura_suspensa");
  });

  it("criar um NOVO convite sob modo leitura dá PT402/assinatura_suspensa", () => {
    const erro = erroDe(`
      begin;
      ${fixtureBase(ORG_NEG, "ml-neg", PIPELINE_NEG_BASE, STAGE_NEG_BASE)}
      ${ligarModoLeitura(ORG_NEG, "now() - interval '1 day'", "suspensa")}
      insert into public.team_invites (organization_id, email, role, expires_at)
        values ('${ORG_NEG}', 'convite-ml-neg@invariant.test', 'agent', now() + interval '7 days');
      rollback;
    `);
    expect(erro).not.toBeNull();
    expect(erro).toContain("Conta suspensa");
    expect(erro).toContain("assinatura_suspensa");
  });

  // ── o que continua (decisão 5: "o chat nunca para") ──
  const ORG_POS = "09080005-0000-4000-8000-000000000007";
  const PIPELINE_POS_BASE = "09080005-0000-4000-8000-000000000008";
  const STAGE_POS_BASE = "09080005-0000-4000-8000-000000000009";
  const CHANNEL_POS = "09080005-0000-4000-8000-00000000000a";

  it("criar um LEAD sob modo leitura PASSA (N23)", () => {
    const linhas = comoServico(`
      begin;
      ${fixtureBase(ORG_POS, "ml-pos", PIPELINE_POS_BASE, STAGE_POS_BASE)}
      ${ligarModoLeitura(ORG_POS, "now() - interval '1 day'", "suspensa")}
      insert into public.crm_leads (organization_id, pipeline_id, stage_id, title)
        values ('${ORG_POS}', '${PIPELINE_POS_BASE}', '${STAGE_POS_BASE}', 'Lead Modo Leitura');
      select 'SONDA|' || count(*) from public.crm_leads where organization_id = '${ORG_POS}' and title = 'Lead Modo Leitura';
      rollback;
    `);
    expect(linhas).toEqual(["1"]);
  });

  it("conectar/reconectar um CANAL sob modo leitura PASSA (channel_sessions nunca teve gatilho de plano nenhum, decisão 5)", () => {
    const linhas = comoServico(`
      begin;
      ${fixtureBase(ORG_POS, "ml-pos", PIPELINE_POS_BASE, STAGE_POS_BASE)}
      ${ligarModoLeitura(ORG_POS, "now() - interval '1 day'", "suspensa")}
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted, status)
        values ('${CHANNEL_POS}', '${ORG_POS}', 'ml-pos-session', '\\x00'::bytea, 'WORKING');
      select 'SONDA|' || count(*) from public.channel_sessions where id = '${CHANNEL_POS}';
      rollback;
    `);
    expect(linhas).toEqual(["1"]);
  });

  const ORG_ACEITE = "09080005-0000-4000-8000-00000000000b";
  const ADMIN_ACEITE = "09080005-1111-4000-8000-000000000001";
  const CONVIDADO_ACEITE = "09080005-1111-4000-8000-000000000002";

  it("aceitar um convite JÁ PENDENTE pelo SERVIDOR sob modo leitura PASSA (o convite nasceu antes do bloqueio)", () => {
    const linhas = comoServico(`
      begin;
      ${criarOrgComContratoPadraoSql(ORG_ACEITE, "ml-aceite")}
      ${ajustarLimitesGenerosos(ORG_ACEITE)}
      insert into auth.users (id, email) values
        ('${ADMIN_ACEITE}', 'ml-aceite-admin@invariant.test'),
        ('${CONVIDADO_ACEITE}', 'ml-aceite-convidado@invariant.test')
        on conflict (id) do nothing;
      -- O convite em si é CRIAÇÃO (bloqueada, decisão 7): nasce ANTES do
      -- bloqueio, com o modo ainda avisar.
      insert into public.team_invites (organization_id, email, role, invited_by, expires_at)
        values ('${ORG_ACEITE}', 'ml-aceite-convidado@invariant.test', 'agent', '${ADMIN_ACEITE}', now() + interval '7 days');
      ${ligarModoLeitura(ORG_ACEITE, "now() - interval '1 day'", "suspensa")}
      set role service_role;
      select public.fn_accept_team_invite(
        '${CONVIDADO_ACEITE}'::uuid, '${ORG_ACEITE}'::uuid, 'agent', '${ADMIN_ACEITE}'::uuid,
        now() - interval '1 minute', now() - interval '1 minute'
      );
      reset role;
      select 'SONDA|ativo=' || count(*) from public.user_organizations
        where user_id = '${CONVIDADO_ACEITE}' and organization_id = '${ORG_ACEITE}'
          and accepted_at is not null and revoked_at is null;
      rollback;
    `);
    expect(linhas).toEqual(["ativo=1"]);
  });

  // ── carência futura/nula e modo avisar não recusam nada ──
  const ORG_CARENCIA_FUTURA = "09080005-0000-4000-8000-00000000000c";
  const PIPELINE_CF_BASE = "09080005-0000-4000-8000-00000000000d";
  const STAGE_CF_BASE = "09080005-0000-4000-8000-00000000000e";
  const PIPELINE_CF_NOVO = "09080005-0000-4000-8000-00000000000f";

  it("carência FUTURA não recusa (bloqueio_a_partir_de ainda não venceu, mesmo com status suspensa e modo bloquear)", () => {
    const linhas = comoServico(`
      begin;
      ${fixtureBase(ORG_CARENCIA_FUTURA, "ml-carencia-futura", PIPELINE_CF_BASE, STAGE_CF_BASE)}
      ${ligarModoLeitura(ORG_CARENCIA_FUTURA, "now() + interval '1 day'", "suspensa")}
      insert into public.crm_pipelines (id, organization_id, name, slug)
        values ('${PIPELINE_CF_NOVO}', '${ORG_CARENCIA_FUTURA}', 'Funil Carência Futura', 'ml-carencia-futura-funil');
      select 'SONDA|' || count(*) from public.crm_pipelines where id = '${PIPELINE_CF_NOVO}';
      rollback;
    `);
    expect(linhas).toEqual(["1"]);
  });

  const ORG_CARENCIA_NULA = "09080005-0000-4000-8000-000000000010";
  const PIPELINE_CN_BASE = "09080005-0000-4000-8000-000000000011";
  const STAGE_CN_BASE = "09080005-0000-4000-8000-000000000012";
  const PIPELINE_CN_NOVO = "09080005-0000-4000-8000-000000000013";

  it("carência NULA não recusa (mesmo com status suspensa e modo bloquear)", () => {
    const linhas = comoServico(`
      begin;
      ${fixtureBase(ORG_CARENCIA_NULA, "ml-carencia-nula", PIPELINE_CN_BASE, STAGE_CN_BASE)}
      update public.billing_settings set modo = 'bloquear' where id = 1;
      update public.billing_contracts set bloqueio_a_partir_de = null, status = 'suspensa' where organization_id = '${ORG_CARENCIA_NULA}';
      insert into public.crm_pipelines (id, organization_id, name, slug)
        values ('${PIPELINE_CN_NOVO}', '${ORG_CARENCIA_NULA}', 'Funil Carência Nula', 'ml-carencia-nula-funil');
      select 'SONDA|' || count(*) from public.crm_pipelines where id = '${PIPELINE_CN_NOVO}';
      rollback;
    `);
    expect(linhas).toEqual(["1"]);
  });

  const ORG_AVISAR = "09080005-0000-4000-8000-000000000014";
  const PIPELINE_AVISAR_BASE = "09080005-0000-4000-8000-000000000015";
  const STAGE_AVISAR_BASE = "09080005-0000-4000-8000-000000000016";
  const PIPELINE_AVISAR_NOVO = "09080005-0000-4000-8000-000000000017";

  it("modo avisar (o padrão) não recusa nada, mesmo com status suspensa e carência vencida", () => {
    const linhas = comoServico(`
      begin;
      ${fixtureBase(ORG_AVISAR, "ml-avisar", PIPELINE_AVISAR_BASE, STAGE_AVISAR_BASE)}
      -- status suspensa e carência vencida, mas SEM tocar billing_settings.modo (fica avisar, o padrão).
      update public.billing_contracts set bloqueio_a_partir_de = now() - interval '1 day', status = 'suspensa' where organization_id = '${ORG_AVISAR}';
      select 'SONDA|modo=' || modo from public.billing_settings where id = 1;
      insert into public.crm_pipelines (id, organization_id, name, slug)
        values ('${PIPELINE_AVISAR_NOVO}', '${ORG_AVISAR}', 'Funil Avisar', 'ml-avisar-funil');
      select 'SONDA|funil=' || count(*) from public.crm_pipelines where id = '${PIPELINE_AVISAR_NOVO}';
      rollback;
    `);
    expect(linhas).toEqual(["modo=avisar", "funil=1"]);
  });

  const ORG_FN_BARRADA = "09080005-0000-4000-8000-000000000018";
  const USER_FN_BARRADA = "09080005-1111-4000-8000-000000000003";

  it("fn_billing_modo_leitura não é executável por `authenticated`", () => {
    comoServico(`
      insert into auth.users (id, email) values ('${USER_FN_BARRADA}', 'ml-fn-barrada@invariant.test') on conflict (id) do nothing;
      ${criarOrgComContratoPadraoSql(ORG_FN_BARRADA, "ml-fn-barrada")}
    `);
    esperaBarrado(USER_FN_BARRADA, `select public.fn_billing_modo_leitura('${ORG_FN_BARRADA}'::uuid)`, "execução de fn_billing_modo_leitura por authenticated");
  });
});

// ============================================================================
// 6. Pacotes: fn_billing_creditar_pacote e billing_token_pacotes (decisão 10).
// ============================================================================

describe("6. Pacotes", () => {
  const ORG_PACOTE_PRECO = "09080006-0000-4000-8000-000000000001";
  const CHAVE_PACOTE_PRECO = "09080006-c0de-4000-8000-000000000001";

  it("crédito com o preço DO CATÁLOGO (p_valor_cents nulo): usa preco_cents do pacote", () => {
    const linhas = comoServico(`
      begin;
      ${criarOrgComContratoPadraoSql(ORG_PACOTE_PRECO, "pacote-com-preco")}
      insert into public.billing_token_pacotes (codigo, nome, tokens, preco_cents, ativo)
        values ('pacote_com_preco', 'Pacote Com Preço', 1000, 5000, true);
      select 'SONDA|' || (public.fn_billing_creditar_pacote(
        '${ORG_PACOTE_PRECO}'::uuid,
        (select id from public.billing_token_pacotes where codigo = 'pacote_com_preco'),
        null, '${CHAVE_PACOTE_PRECO}'::uuid, 'nota', null
      ) ->> 'valor_cents');
      select 'SONDA|' || creditado from public.billing_token_wallets where organization_id = '${ORG_PACOTE_PRECO}' and fonte = 'avulso';
      rollback;
    `);
    expect(linhas).toEqual(["5000", "1000"]);
  });

  const ORG_PACOTE_VALOR_INFORMADO = "09080006-0000-4000-8000-000000000002";
  const CHAVE_PACOTE_VALOR_INFORMADO = "09080006-c0de-4000-8000-000000000002";

  it("crédito com o valor INFORMADO na hora (pacote sem preco_cents no catálogo)", () => {
    const linhas = comoServico(`
      begin;
      ${criarOrgComContratoPadraoSql(ORG_PACOTE_VALOR_INFORMADO, "pacote-valor-informado")}
      insert into public.billing_token_pacotes (codigo, nome, tokens, preco_cents, ativo)
        values ('pacote_sem_preco', 'Pacote Sem Preço', 500, null, true);
      select 'SONDA|' || (public.fn_billing_creditar_pacote(
        '${ORG_PACOTE_VALOR_INFORMADO}'::uuid,
        (select id from public.billing_token_pacotes where codigo = 'pacote_sem_preco'),
        3000, '${CHAVE_PACOTE_VALOR_INFORMADO}'::uuid, 'nota', null
      ) ->> 'valor_cents');
      rollback;
    `);
    expect(linhas).toEqual(["3000"]);
  });

  const ORG_PACOTE_SEM_VALOR = "09080006-0000-4000-8000-000000000003";
  const CHAVE_PACOTE_SEM_VALOR = "09080006-c0de-4000-8000-000000000003";

  it("sem os DOIS (catálogo sem preço, e nada informado): 22023 (billing_valor_obrigatorio, N9)", () => {
    const erro = erroDe(`
      begin;
      ${criarOrgComContratoPadraoSql(ORG_PACOTE_SEM_VALOR, "pacote-sem-valor")}
      insert into public.billing_token_pacotes (codigo, nome, tokens, preco_cents, ativo)
        values ('pacote_dois_ausentes', 'Pacote Sem Nenhum Preço', 200, null, true);
      select public.fn_billing_creditar_pacote(
        '${ORG_PACOTE_SEM_VALOR}'::uuid,
        (select id from public.billing_token_pacotes where codigo = 'pacote_dois_ausentes'),
        null, '${CHAVE_PACOTE_SEM_VALOR}'::uuid, 'nota', null
      );
      rollback;
    `);
    expect(erro).not.toBeNull();
    expect(erro).toContain("billing_valor_obrigatorio");
  });

  const ORG_PACOTE_INATIVO = "09080006-0000-4000-8000-000000000004";
  const CHAVE_PACOTE_INATIVO = "09080006-c0de-4000-8000-000000000004";

  it("pacote INATIVO: 22023 (billing_pacote_inativo)", () => {
    const erro = erroDe(`
      begin;
      ${criarOrgComContratoPadraoSql(ORG_PACOTE_INATIVO, "pacote-inativo")}
      insert into public.billing_token_pacotes (codigo, nome, tokens, preco_cents, ativo)
        values ('pacote_inativo', 'Pacote Inativo', 100, 1000, false);
      select public.fn_billing_creditar_pacote(
        '${ORG_PACOTE_INATIVO}'::uuid,
        (select id from public.billing_token_pacotes where codigo = 'pacote_inativo'),
        null, '${CHAVE_PACOTE_INATIVO}'::uuid, 'nota', null
      );
      rollback;
    `);
    expect(erro).not.toBeNull();
    expect(erro).toContain("billing_pacote_inativo");
  });

  const ORG_PACOTE_REPETE = "09080006-0000-4000-8000-000000000005";
  const CHAVE_PACOTE_REPETE = "09080006-c0de-4000-8000-000000000005";

  it("repetição pela MESMA chave não duplica (idempotência herdada de fn_billing_creditar_tokens)", () => {
    const linhas = comoServico(`
      begin;
      ${criarOrgComContratoPadraoSql(ORG_PACOTE_REPETE, "pacote-repete")}
      insert into public.billing_token_pacotes (codigo, nome, tokens, preco_cents, ativo)
        values ('pacote_repete', 'Pacote Repete', 300, 1500, true);
      select 'SONDA|' || (public.fn_billing_creditar_pacote(
        '${ORG_PACOTE_REPETE}'::uuid,
        (select id from public.billing_token_pacotes where codigo = 'pacote_repete'),
        null, '${CHAVE_PACOTE_REPETE}'::uuid, 'nota', null
      ) ->> 'creditado');
      select 'SONDA|' || (public.fn_billing_creditar_pacote(
        '${ORG_PACOTE_REPETE}'::uuid,
        (select id from public.billing_token_pacotes where codigo = 'pacote_repete'),
        null, '${CHAVE_PACOTE_REPETE}'::uuid, 'nota', null
      ) ->> 'creditado');
      select 'SONDA|' || creditado from public.billing_token_wallets where organization_id = '${ORG_PACOTE_REPETE}' and fonte = 'avulso';
      rollback;
    `);
    expect(linhas).toEqual(["true", "false", "300"]);
  });

  const ORG_PACOTE_ID_NULO = "09080006-0000-4000-8000-000000000006";
  const PACOTE_ID_NULO = "09080006-a0a0-4000-8000-000000000001";
  const CHAVE_PACOTE_ID_NULO = "09080006-c0de-4000-8000-000000000006";

  it("reenvio devolve pacote_id NULO (billing_token_ledger não guarda o pacote de origem; correção segunda rodada F4, item 3: antes devolvia o p_pacote da CHAMADA do reenvio, não o da original)", () => {
    const linhas = comoServico(`
      begin;
      ${criarOrgComContratoPadraoSql(ORG_PACOTE_ID_NULO, "pacote-id-nulo")}
      insert into public.billing_token_pacotes (id, codigo, nome, tokens, preco_cents, ativo)
        values ('${PACOTE_ID_NULO}', 'pacote_id_nulo', 'Pacote Id Nulo', 300, 1500, true);
      select 'SONDA|' || coalesce((public.fn_billing_creditar_pacote(
        '${ORG_PACOTE_ID_NULO}'::uuid, '${PACOTE_ID_NULO}'::uuid,
        null, '${CHAVE_PACOTE_ID_NULO}'::uuid, 'nota', null
      ) ->> 'pacote_id'), '<null>');
      select 'SONDA|' || coalesce((public.fn_billing_creditar_pacote(
        '${ORG_PACOTE_ID_NULO}'::uuid, '${PACOTE_ID_NULO}'::uuid,
        null, '${CHAVE_PACOTE_ID_NULO}'::uuid, 'nota', null
      ) ->> 'pacote_id'), '<null>');
      rollback;
    `);
    expect(linhas).toEqual([PACOTE_ID_NULO, "<null>"]);
  });

  const USER_CATALOGO = "09080006-1111-4000-8000-000000000001";

  it("`authenticated` não lê o catálogo (billing_token_pacotes, decisão 10: a tela lê pelo servidor)", () => {
    comoServico(`insert into auth.users (id, email) values ('${USER_CATALOGO}', 'pacote-catalogo@invariant.test') on conflict (id) do nothing;`);
    esperaBarrado(USER_CATALOGO, `select id from public.billing_token_pacotes limit 1`, "select em billing_token_pacotes");
  });
});

// ============================================================================
// 7. D-046: api_audit_log (decisão 11).
// ============================================================================

describe("7. D-046", () => {
  const ORG_D046 = "09080007-0000-4000-8000-000000000001";
  const VIEWER_D046 = "09080007-1111-4000-8000-000000000001";

  beforeAll(() => {
    comoServico(`
      ${criarOrgSql(ORG_D046, "d046-audit")}
      insert into auth.users (id, email) values ('${VIEWER_D046}', 'd046-viewer@invariant.test') on conflict (id) do nothing;
      insert into public.user_organizations (user_id, organization_id, role, accepted_at)
        values ('${VIEWER_D046}', '${ORG_D046}', 'viewer', now()) on conflict do nothing;
    `);
  });

  it("viewer NÃO insere em api_audit_log, nem com ator/organização próprios (RESTRICTIVE with check(false))", () => {
    const erro = erroDe(`
      begin;
      ${comoMembro(VIEWER_D046)}
      insert into public.api_audit_log (organization_id, actor_user_id, action)
        values ('${ORG_D046}', '${VIEWER_D046}', 'teste_d046_ator_proprio');
      rollback;
    `);
    expect(erro, "viewer conseguiu inserir em api_audit_log: D-046 não está fechado").not.toBeNull();
    expect(erro).toMatch(/row-level security/i);
  });

  it("service_role insere em api_audit_log normalmente (a policy RESTRICTIVE só alcança `authenticated`)", () => {
    const linhas = comoServico(`
      begin;
      set role service_role;
      insert into public.api_audit_log (organization_id, action) values ('${ORG_D046}', 'teste_d046_service_role');
      reset role;
      select 'SONDA|' || count(*) from public.api_audit_log where organization_id = '${ORG_D046}' and action = 'teste_d046_service_role';
      rollback;
    `);
    expect(linhas).toEqual(["1"]);
  });

  it("agent_worker (quando a role existir neste contêiner) não faz UPDATE nem DELETE em api_audit_log", () => {
    const existeRole = comoServico(`select 'SONDA|' || exists(select 1 from pg_roles where rolname = 'agent_worker')::text;`)[0];
    if (existeRole !== "true") {
      // Mesma condicional da migração (`do $$ if exists (...) $$`): a role
      // não existe neste contêiner de teste, nada a provar aqui.
      return;
    }
    esperaBarradoComoPapel(
      "agent_worker",
      `update public.api_audit_log set action = 'forjado' where organization_id = '${ORG_D046}'`,
      "update em api_audit_log sob agent_worker",
    );
    esperaBarradoComoPapel("agent_worker", `delete from public.api_audit_log where organization_id = '${ORG_D046}'`, "delete em api_audit_log sob agent_worker");
  });
});
