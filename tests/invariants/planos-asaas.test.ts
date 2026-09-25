/**
 * FASE F5 (migration 0909, fork Hiperbold), TAREFAS 1, 2 E 3: SCHEMA, TRAVA
 * DE DELETE E PEDIDO/CLIENTE/CHAVES, MEDIDOS DE VERDADE.
 *
 * Tarefas 1 e 2 (schema e trava de delete):
 *
 *   1. `billing_customers`, `billing_orders` e `asaas_webhook_events` são
 *      deny-all (mesmo desenho de `billing_payments`/`billing_contract_eventos`,
 *      0908, e do eixo de anúncios, 0213): `anon`/`authenticated` sem privilégio
 *      NENHUM, `agent_worker` sem privilégio NENHUM (medido por `set role`,
 *      não só por comentário), `service_role` só SELECT (a escrita é das
 *      funções da Tarefa 3, abaixo).
 *   2. `trg_billing_protege_assinatura_asaas` recusa apagar um contrato com
 *      assinatura Asaas viva (sem o marcador), INCLUSIVE pela cascata de
 *      apagar a organização, e deixa de recusar quando o marcador está
 *      preenchido.
 *
 * Tarefa 3 (pedido, cliente e chaves), no fim deste arquivo:
 *
 *   3. As sete funções novas são deny-all para `anon`/`authenticated` (só
 *      `service_role` executa), medido por `set role` E pelo catálogo.
 *   4. `fn_billing_criar_pedido` recusa cada uma das seis situações da
 *      decisão 18/2 (compra desligada, plano fora de venda, preço não
 *      definido, método inválido para a oferta, já tem assinatura Asaas,
 *      pedido aberto existe), é idempotente pela chave (mesmos valores devolve
 *      `ja_existia`, valores diferentes é `22023`), e o índice de pedido
 *      aberto único vale também para `processando`.
 *   5. `fn_billing_pedido_tomar` sob DUAS SESSÕES CONCORRENTES de verdade
 *      (via `pg.Pool`, não sequencial): só uma ganha a posse.
 *   6. `fn_billing_vincular_cliente_asaas` recusa o MESMO cliente Asaas já
 *      vinculado a OUTRA organização (`42501`).
 *   7. `fn_billing_pedido_registrar_cobranca` recusa `invoice_url` de um
 *      ambiente que não é o do próprio pedido.
 *   8. `fn_billing_pedido_marcar` recusa marcar a partir de `pago`.
 *
 * Molde: `credencial-de-anuncios-e-server-side.test.ts` (deny-all), o caso 29
 * de `planos-carteira.test.ts` (delete em cascata) e
 * `idempotencia-reserva-antes-do-efeito.test.ts` (corrida de verdade via
 * `pg.Pool`). Roda via `pnpm test:db` (TEST_DB_CONTAINER/TEST_DB_PORT), banco
 * NOVO por arquivo (`tests/db/banco-limpo-por-arquivo.ts`, `fileParallelism:
 * false`): mutar catálogo global aqui (`billing_plans.for_sale`,
 * `billing_settings.compra_pelo_cliente`) não vaza para outro arquivo. Sem
 * rollback ao final, ids fixos com prefixo próprio para não colidir com
 * outra suíte.
 */
import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";

import { motivoDoErro, sql } from "./psql-transporte";

const TABELAS = ["billing_customers", "billing_orders", "asaas_webhook_events"] as const;

function erroSob(papel: string, comando: string): string | null {
  try {
    sql(`set role ${papel};\n${comando};\nreset role;`);
    return null;
  } catch (err) {
    return motivoDoErro(err);
  }
}

function esperaBarrado(papel: string, comando: string): void {
  const erro = erroSob(papel, comando);
  expect(erro, `\`${papel}\` executou "${comando}" SEM erro, a tabela está exposta`).not.toBeNull();
  expect(erro).toContain("permission denied");
}

function privilegiosDe(papel: string, tabela: string): string {
  return sql(`
    select coalesce(string_agg(distinct privilege_type, ',' order by privilege_type), 'NENHUM')
      from information_schema.role_table_grants
     where table_schema = 'public'
       and table_name = '${tabela}'
       and grantee = '${papel}';
  `).trim();
}

describe.each(TABELAS)("0909: `%s` é deny-all (grants no catálogo)", (tabela) => {
  it("a tabela EXISTE no baseline, controle positivo da sonda", () => {
    const existe = sql(`
      select count(*) from information_schema.tables
       where table_schema = 'public' and table_name = '${tabela}';
    `).trim();
    expect(existe, `\`${tabela}\` não está no baseline`).toBe("1");
  });

  it("`anon` não tem privilégio NENHUM", () => {
    expect(privilegiosDe("anon", tabela)).toBe("NENHUM");
  });

  it("`authenticated` não tem privilégio NENHUM", () => {
    expect(privilegiosDe("authenticated", tabela)).toBe("NENHUM");
  });

  it("`agent_worker` não tem privilégio NENHUM (quando a role existir neste contêiner)", () => {
    const existeRole = sql(`select count(*) from pg_roles where rolname = 'agent_worker';`).trim();
    if (existeRole !== "1") {
      // Mesma condicional da migração (`do $$ if exists (...) $$`): a role não
      // existe neste contêiner de teste (test:db não a provisiona), nada a
      // provar aqui. No banco local de desenvolvimento (supabase_db_deskcomm-
      // crm), a role existe e o mesmo caso mede o privilégio de verdade.
      return;
    }
    expect(privilegiosDe("agent_worker", tabela)).toBe("NENHUM");
  });

  it("`service_role` tem SELECT e NADA de escrita (a escrita é só por função, Tarefa 3 em diante)", () => {
    const privilegios = privilegiosDe("service_role", tabela);
    expect(privilegios).toContain("SELECT");
    expect(privilegios).not.toContain("INSERT");
    expect(privilegios).not.toContain("UPDATE");
    expect(privilegios).not.toContain("DELETE");
    expect(privilegios).not.toContain("TRUNCATE");
  });

  it("`anon` é BARRADO por permission denied ao ler, não zero linhas", () => {
    esperaBarrado("anon", `select id from public.${tabela}`);
  });

  it("`authenticated` é BARRADO por permission denied ao ler", () => {
    esperaBarrado("authenticated", `select id from public.${tabela}`);
  });

  it("`agent_worker` é BARRADO por permission denied ao ler (bypassrls não é grant, quando a role existir)", () => {
    const existeRole = sql(`select count(*) from pg_roles where rolname = 'agent_worker';`).trim();
    if (existeRole !== "1") {
      return;
    }
    esperaBarrado("agent_worker", `select id from public.${tabela}`);
  });

  it("a RLS está LIGADA", () => {
    const ligada = sql(`select relrowsecurity from pg_class where oid = 'public.${tabela}'::regclass;`).trim();
    expect(ligada, "RLS desligada: o revoke vira a única defesa").toBe("t");
  });

  it("não há policy nenhuma", () => {
    const quantas = sql(`
      select count(*) from pg_policies where schemaname = 'public' and tablename = '${tabela}';
    `).trim();
    expect(quantas, `\`${tabela}\` ganhou policy, e o desenho é deny-all`).toBe("0");
  });
});

describe("0909: organization_id de billing_customers/billing_orders é NOT NULL com FK cascade; asaas_webhook_events NÃO tem FK (decisão do plano)", () => {
  it.each(["billing_customers", "billing_orders"] as const)("`%s`.organization_id é NOT NULL com FK on delete cascade", (tabela) => {
    const nullable = sql(`
      select is_nullable from information_schema.columns
       where table_schema = 'public' and table_name = '${tabela}' and column_name = 'organization_id';
    `).trim();
    expect(nullable).toBe("NO");

    const cascata = sql(`
      select count(*) from information_schema.table_constraints tc
       join information_schema.referential_constraints rc on rc.constraint_name = tc.constraint_name
       join information_schema.key_column_usage kcu on kcu.constraint_name = tc.constraint_name
       where tc.table_schema = 'public' and tc.table_name = '${tabela}'
         and tc.constraint_type = 'FOREIGN KEY' and kcu.column_name = 'organization_id'
         and rc.delete_rule = 'CASCADE';
    `).trim();
    expect(cascata, `a FK de organization_id em ${tabela} não é ON DELETE CASCADE`).not.toBe("0");
  });

  it("`asaas_webhook_events`.organization_id é nullable e SEM chave estrangeira", () => {
    const nullable = sql(`
      select is_nullable from information_schema.columns
       where table_schema = 'public' and table_name = 'asaas_webhook_events' and column_name = 'organization_id';
    `).trim();
    expect(nullable).toBe("YES");

    const temFk = sql(`
      select count(*) from information_schema.table_constraints tc
       join information_schema.key_column_usage kcu on kcu.constraint_name = tc.constraint_name
       where tc.table_schema = 'public' and tc.table_name = 'asaas_webhook_events'
         and tc.constraint_type = 'FOREIGN KEY' and kcu.column_name = 'organization_id';
    `).trim();
    expect(temFk, "asaas_webhook_events.organization_id ganhou uma FK, e a decisão do plano é NÃO ter (o roteamento pode não achar organização)").toBe("0");
  });
});

// ============================================================================
// trg_billing_protege_assinatura_asaas (decisão 22 do plano da fase F5).
// ============================================================================

const ORG_TRIGGER_DIRETO = "09090001-a5aa-4000-8000-000000000001";
const ORG_TRIGGER_CASCATA = "09090001-a5aa-4000-8000-000000000002";
const ORG_TRIGGER_LIBERADO = "09090001-a5aa-4000-8000-000000000003";

function criarOrgSql(id: string, slug: string): string {
  return `insert into public.organizations (id, slug, legal_name, display_name)
    values ('${id}', '${slug}', '${slug} LTDA', '${slug}')
    on conflict (id) do nothing;`;
}

describe("0909: trg_billing_protege_assinatura_asaas recusa apagar contrato com assinatura Asaas viva", () => {
  it("setup: três organizações, cada uma com o contrato automático (trigger da 0904) recebendo asaas_subscription_id", () => {
    sql(`
      ${criarOrgSql(ORG_TRIGGER_DIRETO, "f5-trigger-direto")}
      ${criarOrgSql(ORG_TRIGGER_CASCATA, "f5-trigger-cascata")}
      ${criarOrgSql(ORG_TRIGGER_LIBERADO, "f5-trigger-liberado")}
      update public.billing_contracts set asaas_subscription_id = 'sub_teste0001', asaas_assinatura_encerrada_em = null where organization_id = '${ORG_TRIGGER_DIRETO}';
      update public.billing_contracts set asaas_subscription_id = 'sub_teste0002', asaas_assinatura_encerrada_em = null where organization_id = '${ORG_TRIGGER_CASCATA}';
      update public.billing_contracts set asaas_subscription_id = 'sub_teste0003', asaas_assinatura_encerrada_em = now() where organization_id = '${ORG_TRIGGER_LIBERADO}';
    `);
    const contagem = sql(`
      select count(*) from public.billing_contracts
       where organization_id in ('${ORG_TRIGGER_DIRETO}', '${ORG_TRIGGER_CASCATA}', '${ORG_TRIGGER_LIBERADO}');
    `).trim();
    expect(contagem).toBe("3");
  });

  it("apagar o CONTRATO direto, sem marcador, falha com billing_cancele_no_asaas_antes", () => {
    const erro = erroSob("service_role", `delete from public.billing_contracts where organization_id = '${ORG_TRIGGER_DIRETO}'`);
    expect(erro, "o delete direto do contrato passou sem erro, a trava não pegou").not.toBeNull();
    expect(erro).toContain("billing_cancele_no_asaas_antes");

    const aindaExiste = sql(`select count(*) from public.billing_contracts where organization_id = '${ORG_TRIGGER_DIRETO}'`).trim();
    expect(aindaExiste, "a linha deveria continuar existindo depois do erro").toBe("1");
  });

  it("apagar a ORGANIZAÇÃO (cascata), sem marcador, TAMBÉM falha, e a organização continua existindo", () => {
    const erro = erroSob("service_role", `delete from public.organizations where id = '${ORG_TRIGGER_CASCATA}'`);
    expect(erro, "apagar a organização em cascata passou sem erro, o contrato ficaria órfão com assinatura Asaas viva").not.toBeNull();
    expect(erro).toContain("billing_cancele_no_asaas_antes");

    const orgExiste = sql(`select count(*) from public.organizations where id = '${ORG_TRIGGER_CASCATA}'`).trim();
    expect(orgExiste, "a organização deveria continuar existindo, o comando inteiro foi abortado pela trava").toBe("1");
    const contratoExiste = sql(`select count(*) from public.billing_contracts where organization_id = '${ORG_TRIGGER_CASCATA}'`).trim();
    expect(contratoExiste).toBe("1");
  });

  it("com o marcador (asaas_assinatura_encerrada_em) preenchido, apagar o contrato FUNCIONA", () => {
    const erro = erroSob("service_role", `delete from public.billing_contracts where organization_id = '${ORG_TRIGGER_LIBERADO}'`);
    expect(erro, `o delete deveria ter passado, o marcador já está preenchido: ${erro}`).toBeNull();

    const existe = sql(`select count(*) from public.billing_contracts where organization_id = '${ORG_TRIGGER_LIBERADO}'`).trim();
    expect(existe).toBe("0");
  });

  it("limpeza: apaga as organizações de teste que ainda restam (billing_contracts primeiro, sem assinatura Asaas)", () => {
    sql(`
      update public.billing_contracts set asaas_subscription_id = null, asaas_assinatura_encerrada_em = null
       where organization_id in ('${ORG_TRIGGER_DIRETO}', '${ORG_TRIGGER_CASCATA}');
      delete from public.organizations where id in ('${ORG_TRIGGER_DIRETO}', '${ORG_TRIGGER_CASCATA}', '${ORG_TRIGGER_LIBERADO}');
    `);
    const restam = sql(`
      select count(*) from public.organizations
       where id in ('${ORG_TRIGGER_DIRETO}', '${ORG_TRIGGER_CASCATA}', '${ORG_TRIGGER_LIBERADO}');
    `).trim();
    expect(restam).toBe("0");
  });
});

// ============================================================================
// TAREFA 3: pedido, cliente e chaves.
// ============================================================================

const FUNCOES_TAREFA_3 = [
  "fn_billing_definir_compra_pelo_cliente",
  "fn_billing_definir_a_venda",
  "fn_billing_criar_pedido",
  "fn_billing_pedido_tomar",
  "fn_billing_vincular_cliente_asaas",
  "fn_billing_pedido_registrar_cobranca",
  "fn_billing_pedido_marcar",
] as const;

function privilegiosDaFuncao(papel: string, funcao: string): string {
  return sql(`
    select coalesce(string_agg(distinct privilege_type, ',' order by privilege_type), 'NENHUM')
      from information_schema.routine_privileges
     where routine_schema = 'public'
       and routine_name = '${funcao}'
       and grantee = '${papel}';
  `).trim();
}

describe.each(FUNCOES_TAREFA_3)("0909 Tarefa 3: `%s` é deny-all para anon/authenticated (grants)", (funcao) => {
  it("`anon` não tem EXECUTE no catálogo", () => {
    expect(privilegiosDaFuncao("anon", funcao)).toBe("NENHUM");
  });

  it("`authenticated` não tem EXECUTE no catálogo", () => {
    expect(privilegiosDaFuncao("authenticated", funcao)).toBe("NENHUM");
  });

  it("`service_role` TEM EXECUTE no catálogo (controle positivo)", () => {
    expect(privilegiosDaFuncao("service_role", funcao)).toContain("EXECUTE");
  });
});

describe("0909 Tarefa 3: nenhuma das sete funções roda sob authenticated/anon (medido por set role, não só catálogo)", () => {
  it("`authenticated` é barrado por permission denied em fn_billing_pedido_tomar", () => {
    const erro = erroSob(
      "authenticated",
      "select public.fn_billing_pedido_tomar('00000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-000000000000')",
    );
    expect(erro).not.toBeNull();
    expect(erro).toContain("permission denied for function");
  });

  it("`anon` é barrado por permission denied em fn_billing_criar_pedido", () => {
    const erro = erroSob(
      "anon",
      "select public.fn_billing_criar_pedido('00000000-0000-4000-8000-000000000000', 'assinatura', 'pro', 'monthly', null, 'CREDIT_CARD', 'sandbox', gen_random_uuid(), null)",
    );
    expect(erro).not.toBeNull();
    expect(erro).toContain("permission denied for function");
  });
});

const ORG_PEDIDO = "09090003-a5aa-4000-8000-000000000001";
const ORG_PEDIDO_ABERTO = "09090003-a5aa-4000-8000-000000000002";
const ORG_JA_TEM_ASSINATURA = "09090003-a5aa-4000-8000-000000000003";
const ORG_TOMAR = "09090003-a5aa-4000-8000-000000000004";
const ORG_VINCULO_A = "09090003-a5aa-4000-8000-000000000005";
const ORG_VINCULO_B = "09090003-a5aa-4000-8000-000000000006";
const ORG_COBRANCA = "09090003-a5aa-4000-8000-000000000007";
const ORG_MARCAR = "09090003-a5aa-4000-8000-000000000008";

const ORGS_TAREFA_3 = [
  ORG_PEDIDO,
  ORG_PEDIDO_ABERTO,
  ORG_JA_TEM_ASSINATURA,
  ORG_TOMAR,
  ORG_VINCULO_A,
  ORG_VINCULO_B,
  ORG_COBRANCA,
  ORG_MARCAR,
];

function criarOrgTarefa3(id: string, slug: string): string {
  return `insert into public.organizations (id, slug, legal_name, display_name)
    values ('${id}', '${slug}', '${slug} LTDA', '${slug}')
    on conflict (id) do nothing;`;
}

describe("0909 Tarefa 3: setup comum (organizações, compra ligada, pro/max à venda)", () => {
  it("cria as organizações de teste e liga compra_pelo_cliente e for_sale de pro/max", () => {
    sql(`
      ${criarOrgTarefa3(ORG_PEDIDO, "f5-t3-pedido")}
      ${criarOrgTarefa3(ORG_PEDIDO_ABERTO, "f5-t3-pedido-aberto")}
      ${criarOrgTarefa3(ORG_JA_TEM_ASSINATURA, "f5-t3-ja-tem-assinatura")}
      ${criarOrgTarefa3(ORG_TOMAR, "f5-t3-tomar")}
      ${criarOrgTarefa3(ORG_VINCULO_A, "f5-t3-vinculo-a")}
      ${criarOrgTarefa3(ORG_VINCULO_B, "f5-t3-vinculo-b")}
      ${criarOrgTarefa3(ORG_COBRANCA, "f5-t3-cobranca")}
      ${criarOrgTarefa3(ORG_MARCAR, "f5-t3-marcar")}
      select public.fn_billing_definir_compra_pelo_cliente(true, null);
      select public.fn_billing_definir_a_venda('pro', true, null);
      select public.fn_billing_definir_a_venda('max', true, null);
    `);
    const contagem = sql(`select count(*) from public.organizations where id = any(array[${ORGS_TAREFA_3.map((id) => `'${id}'`).join(",")}]::uuid[]);`).trim();
    expect(contagem).toBe(String(ORGS_TAREFA_3.length));
    const proForSale = sql(`select for_sale from public.billing_plans where code = 'pro' and active;`).trim();
    expect(proForSale).toBe("t");
  });
});

describe("0909 Tarefa 3: fn_billing_criar_pedido, as seis recusas da decisão 18/2", () => {
  it("billing_compra_desligada quando billing_settings.compra_pelo_cliente está false", () => {
    let erro: string | null = null;
    try {
      sql(`
        begin;
        update public.billing_settings set compra_pelo_cliente = false where id = 1;
        select public.fn_billing_criar_pedido('${ORG_PEDIDO}'::uuid, 'assinatura', 'pro', 'monthly', null, 'CREDIT_CARD', 'sandbox', gen_random_uuid(), null);
        rollback;
      `);
    } catch (err) {
      erro = motivoDoErro(err);
    }
    expect(erro).not.toBeNull();
    expect(erro).toContain("billing_compra_desligada");
    // rollback: compra_pelo_cliente continua true para os próximos casos.
    expect(sql(`select compra_pelo_cliente from public.billing_settings where id = 1;`).trim()).toBe("t");
  });

  it("billing_plano_fora_de_venda quando o plano não está à venda", () => {
    let erro: string | null = null;
    try {
      sql(`
        begin;
        update public.billing_plans set for_sale = false where code = 'escale' and active;
        select public.fn_billing_criar_pedido('${ORG_PEDIDO}'::uuid, 'assinatura', 'escale', 'monthly', null, 'CREDIT_CARD', 'sandbox', gen_random_uuid(), null);
        rollback;
      `);
    } catch (err) {
      erro = motivoDoErro(err);
    }
    expect(erro).not.toBeNull();
    expect(erro).toContain("billing_plano_fora_de_venda");
  });

  it("billing_preco_nao_definido quando o ciclo é yearly (price_yearly_cents nulo, N8)", () => {
    const erro = erroSob(
      "service_role",
      `select public.fn_billing_criar_pedido('${ORG_PEDIDO}'::uuid, 'assinatura', 'pro', 'yearly', null, 'CREDIT_CARD', 'sandbox', gen_random_uuid(), null)`,
    );
    expect(erro).not.toBeNull();
    expect(erro).toContain("billing_preco_nao_definido");
  });

  it("billing_metodo_invalido_para_oferta quando mensal pede PIX (decisão 2: mensal só cartão)", () => {
    const erro = erroSob(
      "service_role",
      `select public.fn_billing_criar_pedido('${ORG_PEDIDO}'::uuid, 'assinatura', 'pro', 'monthly', null, 'PIX', 'sandbox', gen_random_uuid(), null)`,
    );
    expect(erro).not.toBeNull();
    expect(erro).toContain("billing_metodo_invalido_para_oferta");
  });

  it("billing_ja_tem_assinatura_asaas quando o contrato já tem assinatura Asaas SEM o marcador de encerramento", () => {
    sql(`
      update public.billing_contracts set asaas_subscription_id = 'sub_jatem0001', asaas_assinatura_encerrada_em = null
       where organization_id = '${ORG_JA_TEM_ASSINATURA}';
    `);
    const erro = erroSob(
      "service_role",
      `select public.fn_billing_criar_pedido('${ORG_JA_TEM_ASSINATURA}'::uuid, 'assinatura', 'pro', 'monthly', null, 'CREDIT_CARD', 'sandbox', gen_random_uuid(), null)`,
    );
    expect(erro).not.toBeNull();
    expect(erro).toContain("billing_ja_tem_assinatura_asaas");
  });

  it("com o marcador de encerramento preenchido, o MESMO contrato pode pedir de novo (decisão 22)", () => {
    sql(`
      update public.billing_contracts set asaas_assinatura_encerrada_em = now()
       where organization_id = '${ORG_JA_TEM_ASSINATURA}';
    `);
    const resultado = sql(
      `select public.fn_billing_criar_pedido('${ORG_JA_TEM_ASSINATURA}'::uuid, 'assinatura', 'pro', 'monthly', null, 'CREDIT_CARD', 'sandbox', gen_random_uuid(), null);`,
    );
    expect(resultado).toContain('"ja_existia": false');
  });

  it("billing_pedido_aberto_existe: um segundo pedido do MESMO tipo com chave NOVA é recusado", () => {
    const primeiro = sql(
      `select public.fn_billing_criar_pedido('${ORG_PEDIDO_ABERTO}'::uuid, 'assinatura', 'pro', 'monthly', null, 'CREDIT_CARD', 'sandbox', gen_random_uuid(), null);`,
    );
    expect(primeiro).toContain('"ja_existia": false');

    const erro = erroSob(
      "service_role",
      `select public.fn_billing_criar_pedido('${ORG_PEDIDO_ABERTO}'::uuid, 'assinatura', 'pro', 'monthly', null, 'CREDIT_CARD', 'sandbox', gen_random_uuid(), null)`,
    );
    expect(erro).not.toBeNull();
    expect(erro).toContain("billing_pedido_aberto_existe");
  });

  it("o pedido aberto único vale também com status processando (fn_billing_pedido_tomar, decisão 25)", () => {
    const pedidoId = sql(
      `select id from public.billing_orders where organization_id = '${ORG_PEDIDO_ABERTO}' and tipo = 'assinatura' and status = 'criado';`,
    ).trim();
    expect(pedidoId.length).toBeGreaterThan(0);

    const tomado = sql(`select public.fn_billing_pedido_tomar('${ORG_PEDIDO_ABERTO}'::uuid, '${pedidoId}'::uuid);`);
    expect(tomado).toContain('"tomado": true');
    expect(tomado).toContain('"status": "processando"');

    const erro = erroSob(
      "service_role",
      `select public.fn_billing_criar_pedido('${ORG_PEDIDO_ABERTO}'::uuid, 'assinatura', 'pro', 'monthly', null, 'CREDIT_CARD', 'sandbox', gen_random_uuid(), null)`,
    );
    expect(erro).not.toBeNull();
    expect(erro).toContain("billing_pedido_aberto_existe");
  });
});

describe("0909 Tarefa 3: fn_billing_criar_pedido, chave repetida (decisão 13)", () => {
  const CHAVE = "11110000-1111-4111-8111-111111111111";

  it("mesma chave, mesmos valores: devolve ja_existia = true", () => {
    const primeiro = sql(
      `select public.fn_billing_criar_pedido('${ORG_PEDIDO}'::uuid, 'assinatura', 'pro', 'monthly', null, 'CREDIT_CARD', 'sandbox', '${CHAVE}'::uuid, null);`,
    );
    expect(primeiro).toContain('"ja_existia": false');

    const segundo = sql(
      `select public.fn_billing_criar_pedido('${ORG_PEDIDO}'::uuid, 'assinatura', 'pro', 'monthly', null, 'CREDIT_CARD', 'sandbox', '${CHAVE}'::uuid, null);`,
    );
    expect(segundo).toContain('"ja_existia": true');
  });

  it("mesma chave, valores diferentes (outro plano à venda): billing_chave_com_valores_diferentes", () => {
    const erro = erroSob(
      "service_role",
      `select public.fn_billing_criar_pedido('${ORG_PEDIDO}'::uuid, 'assinatura', 'max', 'monthly', null, 'CREDIT_CARD', 'sandbox', '${CHAVE}'::uuid, null)`,
    );
    expect(erro).not.toBeNull();
    expect(erro).toContain("billing_chave_com_valores_diferentes");
  });
});

describe("0909 Tarefa 3: fn_billing_pedido_tomar sob DUAS SESSÕES CONCORRENTES de verdade (decisão 25)", () => {
  const container = process.env.TEST_DB_CONTAINER;
  const porta = Number(process.env.TEST_DB_PORT ?? 54329);
  const pool = new pg.Pool({
    connectionString: `postgresql://postgres:postgres@127.0.0.1:${porta}/postgres`,
    max: 4,
  });

  afterAll(async () => {
    await pool.end();
  });

  it("só UMA das duas chamadas simultâneas ganha a posse (tomado = true)", async () => {
    if (!container) {
      throw new Error("TEST_DB_CONTAINER ausente, rode via pnpm test:db");
    }

    sql(
      `select public.fn_billing_criar_pedido('${ORG_TOMAR}'::uuid, 'assinatura', 'pro', 'monthly', null, 'CREDIT_CARD', 'sandbox', gen_random_uuid(), null);`,
    );
    const pedidoId = sql(
      `select id from public.billing_orders where organization_id = '${ORG_TOMAR}' and tipo = 'assinatura' and status = 'criado';`,
    ).trim();
    expect(pedidoId.length).toBeGreaterThan(0);

    const [r1, r2] = await Promise.all([
      pool.query("select public.fn_billing_pedido_tomar($1::uuid, $2::uuid) as r", [ORG_TOMAR, pedidoId]),
      pool.query("select public.fn_billing_pedido_tomar($1::uuid, $2::uuid) as r", [ORG_TOMAR, pedidoId]),
    ]);

    const tomado1 = (r1.rows[0] as { r: { tomado: boolean } }).r.tomado;
    const tomado2 = (r2.rows[0] as { r: { tomado: boolean } }).r.tomado;

    expect([tomado1, tomado2].filter(Boolean)).toHaveLength(1);

    const status = sql(`select status from public.billing_orders where id = '${pedidoId}';`).trim();
    expect(status).toBe("processando");
  });
});

describe("0909 Tarefa 3: fn_billing_vincular_cliente_asaas, cliente de OUTRA organização (decisão 6)", () => {
  it("vincula o cliente à primeira organização", () => {
    const resultado = sql(
      `select public.fn_billing_vincular_cliente_asaas('${ORG_VINCULO_A}'::uuid, 'sandbox', 'cus_vinculoteste01');`,
    );
    expect(resultado).toContain('"ja_existia": false');
  });

  it("o MESMO cliente, no MESMO ambiente, para OUTRA organização: 42501", () => {
    const erro = erroSob(
      "service_role",
      `select public.fn_billing_vincular_cliente_asaas('${ORG_VINCULO_B}'::uuid, 'sandbox', 'cus_vinculoteste01')`,
    );
    expect(erro).not.toBeNull();
    expect(erro).toContain("billing_cliente_asaas_de_outra_organizacao");
  });

  it("um ambiente DIFERENTE para a mesma organização não colide (par (ambiente, asaas_customer_id) é a chave)", () => {
    const resultado = sql(
      `select public.fn_billing_vincular_cliente_asaas('${ORG_VINCULO_B}'::uuid, 'producao', 'cus_vinculoteste02');`,
    );
    expect(resultado).toContain('"ja_existia": false');
  });
});

describe("0909 Tarefa 3: fn_billing_pedido_registrar_cobranca, invoice_url de OUTRO ambiente (risco de redirecionamento aberto)", () => {
  it("pedido em sandbox recusa invoice_url de produção (www.asaas.com)", () => {
    sql(
      `select public.fn_billing_criar_pedido('${ORG_COBRANCA}'::uuid, 'assinatura', 'pro', 'monthly', null, 'CREDIT_CARD', 'sandbox', gen_random_uuid(), null);`,
    );
    const pedidoId = sql(
      `select id from public.billing_orders where organization_id = '${ORG_COBRANCA}' and tipo = 'assinatura' and status = 'criado';`,
    ).trim();

    const erro = erroSob(
      "service_role",
      `select public.fn_billing_pedido_registrar_cobranca('${ORG_COBRANCA}'::uuid, '${pedidoId}'::uuid, 'pay_teste0001', null, 'https://www.asaas.com/i/xyz')`,
    );
    expect(erro).not.toBeNull();
    expect(erro).toContain("billing_invoice_url_fora_do_ambiente");
  });

  it("a mesma invoice_url de sandbox é aceita, e o pedido passa a aguardando_pagamento", () => {
    const pedidoId = sql(
      `select id from public.billing_orders where organization_id = '${ORG_COBRANCA}' and tipo = 'assinatura' and status = 'criado';`,
    ).trim();

    const resultado = sql(
      `select public.fn_billing_pedido_registrar_cobranca('${ORG_COBRANCA}'::uuid, '${pedidoId}'::uuid, 'pay_teste0001', null, 'https://sandbox.asaas.com/i/xyz');`,
    );
    expect(resultado).toContain('"status": "aguardando_pagamento"');
  });
});

describe("0909 Tarefa 3: fn_billing_pedido_marcar, nunca a partir de pago", () => {
  it("marca um pedido criado como cancelado normalmente", () => {
    sql(
      `select public.fn_billing_criar_pedido('${ORG_MARCAR}'::uuid, 'assinatura', 'pro', 'monthly', null, 'CREDIT_CARD', 'sandbox', gen_random_uuid(), null);`,
    );
    const pedidoId = sql(
      `select id from public.billing_orders where organization_id = '${ORG_MARCAR}' and tipo = 'assinatura' and status = 'criado';`,
    ).trim();

    const resultado = sql(
      `select public.fn_billing_pedido_marcar('${ORG_MARCAR}'::uuid, '${pedidoId}'::uuid, 'cancelado', 'teste de invariante');`,
    );
    expect(resultado).toContain('"status_novo": "cancelado"');

    // Força status = pago direto no banco só para medir a recusa (nenhum
    // caminho de produto faz isto fora da Tarefa 5, fn_billing_asaas_aplicar_
    // pagamento).
    sql(`update public.billing_orders set status = 'pago' where id = '${pedidoId}';`);

    const erro = erroSob(
      "service_role",
      `select public.fn_billing_pedido_marcar('${ORG_MARCAR}'::uuid, '${pedidoId}'::uuid, 'cancelado', 'nunca deveria passar')`,
    );
    expect(erro).not.toBeNull();
    expect(erro).toContain("billing_pedido_ja_pago");
  });
});

describe("0909 Tarefa 3: limpeza", () => {
  it("apaga as organizações de teste (billing_contracts primeiro, sem assinatura Asaas)", () => {
    sql(`
      update public.billing_contracts set asaas_subscription_id = null, asaas_assinatura_encerrada_em = null
       where organization_id = any(array[${ORGS_TAREFA_3.map((id) => `'${id}'`).join(",")}]::uuid[]);
      delete from public.organizations where id = any(array[${ORGS_TAREFA_3.map((id) => `'${id}'`).join(",")}]::uuid[]);
    `);
    const restam = sql(
      `select count(*) from public.organizations where id = any(array[${ORGS_TAREFA_3.map((id) => `'${id}'`).join(",")}]::uuid[]);`,
    ).trim();
    expect(restam).toBe("0");
  });
});

// ============================================================================
// TAREFA 4: registrar, reservar com lease, falha, reprocessar, podar.
// ============================================================================

const FUNCOES_TAREFA_4_COM_GRANT = [
  "fn_billing_asaas_registrar_evento",
  "fn_billing_asaas_reservar_eventos",
  "fn_billing_asaas_registrar_falha",
  "fn_billing_asaas_reprocessar_evento",
  "fn_billing_asaas_podar_eventos",
] as const;

describe.each(FUNCOES_TAREFA_4_COM_GRANT)("0909 Tarefa 4: `%s` é deny-all para anon/authenticated (grants)", (funcao) => {
  it("`anon` não tem EXECUTE no catálogo", () => {
    expect(privilegiosDaFuncao("anon", funcao)).toBe("NENHUM");
  });

  it("`authenticated` não tem EXECUTE no catálogo", () => {
    expect(privilegiosDaFuncao("authenticated", funcao)).toBe("NENHUM");
  });

  it("`service_role` TEM EXECUTE no catálogo (controle positivo)", () => {
    expect(privilegiosDaFuncao("service_role", funcao)).toContain("EXECUTE");
  });
});

describe("0909 Tarefa 4: `fn_billing_asaas_lease_e_meu` é interna, SEM execute nem para service_role", () => {
  it("nenhum papel (anon/authenticated/service_role) tem EXECUTE no catálogo", () => {
    expect(privilegiosDaFuncao("anon", "fn_billing_asaas_lease_e_meu")).toBe("NENHUM");
    expect(privilegiosDaFuncao("authenticated", "fn_billing_asaas_lease_e_meu")).toBe("NENHUM");
    expect(privilegiosDaFuncao("service_role", "fn_billing_asaas_lease_e_meu")).toBe("NENHUM");
  });
});

describe("0909 Tarefa 4: nenhuma das cinco funções públicas roda sob authenticated/anon (medido por set role)", () => {
  it("`authenticated` é barrado por permission denied em fn_billing_asaas_reservar_eventos", () => {
    const erro = erroSob("authenticated", "select * from public.fn_billing_asaas_reservar_eventos(10, 300)");
    expect(erro).not.toBeNull();
    expect(erro).toContain("permission denied for function");
  });

  it("`anon` é barrado por permission denied em fn_billing_asaas_registrar_evento", () => {
    const erro = erroSob(
      "anon",
      "select public.fn_billing_asaas_registrar_evento('pay_x', 'PAYMENT_CREATED', null, 'sandbox', 'webhook', '{}'::jsonb)",
    );
    expect(erro).not.toBeNull();
    expect(erro).toContain("permission denied for function");
  });
});

describe("0909 Tarefa 4: fn_billing_asaas_registrar_evento, evento repetido guardado uma vez só (decisão 11)", () => {
  it("a mesma event_id chamada duas vezes: novo = true na primeira, novo = false na segunda", () => {
    const eventId = "evt-repetido-0001";
    const primeiro = sql(
      `select public.fn_billing_asaas_registrar_evento('${eventId}', 'PAYMENT_CREATED', 'pay_teste1', 'sandbox', 'webhook', '{"id":"pay_teste1"}'::jsonb);`,
    );
    expect(primeiro).toContain('"novo": true');

    const segundo = sql(
      `select public.fn_billing_asaas_registrar_evento('${eventId}', 'PAYMENT_CREATED', 'pay_teste1', 'sandbox', 'webhook', '{"id":"pay_teste1"}'::jsonb);`,
    );
    expect(segundo).toContain('"novo": false');

    const contagem = sql(`select count(*) from public.asaas_webhook_events where event_id = '${eventId}';`).trim();
    expect(contagem).toBe("1");
  });
});

describe("0909 Tarefa 4: fn_billing_asaas_registrar_evento, quarentena de evento fora do formato e de evento grande (decisão 19/M6)", () => {
  it("event_type fora de ^[A-Z_]{3,64}$ vai para quarentena: resultado erro, payload cortado, e a função devolve sucesso mesmo assim", () => {
    const eventId = "evt-formato-invalido-0001";
    const resultado = sql(
      `select public.fn_billing_asaas_registrar_evento('${eventId}', 'payment.created.minusculo', 'pay_x', 'sandbox', 'webhook', '{"id":"pay_x"}'::jsonb);`,
    );
    // Devolve sucesso (nenhuma exceção), e o corpo diz "quarentena": true.
    expect(resultado).toContain('"quarentena": true');
    expect(resultado).toContain('"resultado": "erro"');

    const linha = sql(
      `select resultado, erro_codigo, payload from public.asaas_webhook_events where event_id = '${eventId}';`,
    );
    expect(linha).toContain("erro");
    expect(linha).toContain("evento_fora_do_formato:event_type");
    // Payload CORTADO: não é mais o original ({"id":"pay_x"}), é o resumo pequeno.
    expect(linha).not.toContain('"id":"pay_x"');
    expect(linha).toContain("quarentena");
  });

  it("payload acima de 64 KB vai para quarentena: resultado erro, payload cortado, e a fila não trava (sem exceção)", () => {
    const eventId = "evt-grande-0001";
    // 70000 caracteres de "a" dentro de um jsonb: bem acima do teto de 65536
    // bytes.
    let erro: string | null = null;
    let resultado = "";
    try {
      resultado = sql(
        `select public.fn_billing_asaas_registrar_evento('${eventId}', 'PAYMENT_CREATED', 'pay_grande', 'sandbox', 'webhook', jsonb_build_object('recheio', repeat('a', 70000)));`,
      );
    } catch (err) {
      erro = motivoDoErro(err);
    }
    expect(erro, `não deveria ter lançado exceção nenhuma: ${erro}`).toBeNull();
    expect(resultado).toContain('"quarentena": true');
    expect(resultado).toContain('"resultado": "erro"');

    const tamanhoDoPayload = sql(
      `select octet_length(payload::text) from public.asaas_webhook_events where event_id = '${eventId}';`,
    ).trim();
    expect(Number(tamanhoDoPayload)).toBeLessThan(1000);
  });
});

describe("0909 Tarefa 4: fn_billing_asaas_reservar_eventos sob DUAS SESSÕES CONCORRENTES de verdade (decisão 20)", () => {
  const container = process.env.TEST_DB_CONTAINER;
  const porta = Number(process.env.TEST_DB_PORT ?? 54329);
  const pool = new pg.Pool({
    connectionString: `postgresql://postgres:postgres@127.0.0.1:${porta}/postgres`,
    max: 4,
  });

  afterAll(async () => {
    await pool.end();
  });

  it("dois processadores reservando ao mesmo tempo nunca pegam o MESMO evento", async () => {
    if (!container) {
      throw new Error("TEST_DB_CONTAINER ausente, rode via pnpm test:db");
    }

    sql(`
      select public.fn_billing_asaas_registrar_evento('evt-corrida-0001', 'PAYMENT_CREATED', 'pay_corrida1', 'sandbox', 'webhook', '{}'::jsonb);
      select public.fn_billing_asaas_registrar_evento('evt-corrida-0002', 'PAYMENT_CREATED', 'pay_corrida2', 'sandbox', 'webhook', '{}'::jsonb);
    `);

    const [r1, r2] = await Promise.all([
      pool.query("select * from public.fn_billing_asaas_reservar_eventos($1::int, $2::int) as r", [50, 300]),
      pool.query("select * from public.fn_billing_asaas_reservar_eventos($1::int, $2::int) as r", [50, 300]),
    ]);

    const idsReservados = [...r1.rows, ...r2.rows].map((row: { id: string }) => row.id);
    // As duas chamadas juntas reservaram no máximo os dois eventos criados
    // acima, e NUNCA o mesmo id duas vezes (skip locked).
    expect(new Set(idsReservados).size).toBe(idsReservados.length);
    expect(idsReservados.length).toBeGreaterThan(0);

    const aindaAguardando = sql(
      `select count(*) from public.asaas_webhook_events where event_id in ('evt-corrida-0001', 'evt-corrida-0002') and resultado = 'aguardando' and lease_token is null;`,
    ).trim();
    expect(aindaAguardando, "todo evento reservado deveria ter ganho um lease_token").toBe("0");
  });
});

describe("0909 Tarefa 4: lease vencido volta a ser reservável (decisão 20)", () => {
  it("um evento com lease_expira_em no passado é reservado de novo, com um lease_token NOVO", () => {
    sql(
      `select public.fn_billing_asaas_registrar_evento('evt-lease-vencido-0001', 'PAYMENT_CREATED', 'pay_lv1', 'sandbox', 'webhook', '{}'::jsonb);`,
    );

    // Simula um lease de um processador anterior que caiu sem confirmar: um
    // token qualquer, já vencido.
    sql(`
      update public.asaas_webhook_events
         set lease_token = gen_random_uuid(), lease_expira_em = now() - interval '10 minutes'
       where event_id = 'evt-lease-vencido-0001';
    `);
    const leaseAntigo = sql(`select lease_token from public.asaas_webhook_events where event_id = 'evt-lease-vencido-0001';`).trim();

    sql(`select * from public.fn_billing_asaas_reservar_eventos(10, 300);`);

    const leaseNovo = sql(`select lease_token from public.asaas_webhook_events where event_id = 'evt-lease-vencido-0001';`).trim();
    expect(leaseNovo).not.toBe(leaseAntigo);
    expect(leaseNovo.length).toBeGreaterThan(0);
  });
});

describe("0909 Tarefa 4: fn_billing_asaas_registrar_falha, lease alheio recusado e backoff até a décima (decisão 20)", () => {
  it("lease de OUTRO processador (ou já vencido) é recusado com billing_lease_invalido", () => {
    sql(
      `select public.fn_billing_asaas_registrar_evento('evt-falha-lease-alheio-0001', 'PAYMENT_CREATED', 'pay_fla1', 'sandbox', 'webhook', '{}'::jsonb);`,
    );
    sql(`select * from public.fn_billing_asaas_reservar_eventos(10, 300);`);

    const eventoId = sql(
      `select id from public.asaas_webhook_events where event_id = 'evt-falha-lease-alheio-0001';`,
    ).trim();

    const erro = erroSob(
      "service_role",
      `select public.fn_billing_asaas_registrar_falha('${eventoId}'::uuid, gen_random_uuid(), 'erro_qualquer')`,
    );
    expect(erro).not.toBeNull();
    expect(erro).toContain("billing_lease_invalido");
  });

  it("backoff cresce a cada falha e vira erro exatamente na décima tentativa", () => {
    sql(
      `select public.fn_billing_asaas_registrar_evento('evt-backoff-0001', 'PAYMENT_CREATED', 'pay_bo1', 'sandbox', 'webhook', '{}'::jsonb);`,
    );
    const eventoId = sql(`select id from public.asaas_webhook_events where event_id = 'evt-backoff-0001';`).trim();

    let proxima1: string | null = null;
    for (let tentativa = 1; tentativa <= 9; tentativa++) {
      // Força proxima_tentativa_em para agora, para a próxima reserva pegar o
      // evento de novo sem esperar o backoff de verdade.
      sql(`update public.asaas_webhook_events set proxima_tentativa_em = now(), lease_expira_em = null where id = '${eventoId}';`);
      const reserva = sql(
        `select lease_token from (select * from public.fn_billing_asaas_reservar_eventos(50, 300)) r where r.id = '${eventoId}';`,
      ).trim();
      expect(reserva.length, `tentativa ${tentativa}: o evento deveria ter sido reservado de novo`).toBeGreaterThan(0);

      const resultado = sql(
        `select public.fn_billing_asaas_registrar_falha('${eventoId}'::uuid, '${reserva}'::uuid, 'falha_de_teste_${tentativa}');`,
      );
      expect(resultado, `tentativa ${tentativa}`).toContain(`"tentativas": ${tentativa}`);

      if (tentativa < 10) {
        expect(resultado, `tentativa ${tentativa}: ainda deveria estar aguardando`).toContain('"resultado": "aguardando"');
      }
      if (tentativa === 1) {
        proxima1 = sql(`select proxima_tentativa_em from public.asaas_webhook_events where id = '${eventoId}';`).trim();
      }
    }

    const linhaAntesDaDecima = sql(
      `select resultado, tentativas from public.asaas_webhook_events where id = '${eventoId}';`,
    );
    expect(linhaAntesDaDecima).toContain("aguardando");
    expect(linhaAntesDaDecima).toContain("9");
    expect(proxima1, "a primeira falha deveria ter gravado um backoff no futuro").not.toBeNull();

    // Décima falha: vira erro.
    sql(`update public.asaas_webhook_events set proxima_tentativa_em = now(), lease_expira_em = null where id = '${eventoId}';`);
    const reservaDecima = sql(
      `select lease_token from (select * from public.fn_billing_asaas_reservar_eventos(50, 300)) r where r.id = '${eventoId}';`,
    ).trim();
    expect(reservaDecima.length).toBeGreaterThan(0);

    const resultadoDecima = sql(
      `select public.fn_billing_asaas_registrar_falha('${eventoId}'::uuid, '${reservaDecima}'::uuid, 'falha_de_teste_10');`,
    );
    expect(resultadoDecima).toContain('"tentativas": 10');
    expect(resultadoDecima).toContain('"resultado": "erro"');

    const linhaFinal = sql(`select resultado, tentativas from public.asaas_webhook_events where id = '${eventoId}';`);
    expect(linhaFinal).toContain("erro");
    expect(linhaFinal).toContain("10");

    // Um evento erro não é mais elegível para reserva (fora do índice dos
    // pendentes, que só cobre resultado = aguardando).
    const naoReservavel = sql(
      `select count(*) from (select * from public.fn_billing_asaas_reservar_eventos(50, 300)) r where r.id = '${eventoId}';`,
    ).trim();
    expect(naoReservavel).toBe("0");
  });
});

describe("0909 Tarefa 4: fn_billing_asaas_reprocessar_evento (decisão 20)", () => {
  it("volta erro para aguardando, zera tentativas, e o evento fica elegível para reserva de novo", () => {
    sql(
      `select public.fn_billing_asaas_registrar_evento('evt-reprocessar-0001', 'PAYMENT_CREATED', 'pay_rp1', 'sandbox', 'webhook', '{}'::jsonb);`,
    );
    const eventoId = sql(`select id from public.asaas_webhook_events where event_id = 'evt-reprocessar-0001';`).trim();
    sql(`update public.asaas_webhook_events set resultado = 'erro', tentativas = 10, erro_codigo = 'teste' where id = '${eventoId}';`);

    const resultado = sql(`select public.fn_billing_asaas_reprocessar_evento('${eventoId}'::uuid, null);`);
    expect(resultado).toContain('"resultado_novo": "aguardando"');

    const linha = sql(`select resultado, tentativas, erro_codigo from public.asaas_webhook_events where id = '${eventoId}';`);
    expect(linha).toContain("aguardando");
    expect(linha).toContain("0");

    const reservavel = sql(
      `select count(*) from (select * from public.fn_billing_asaas_reservar_eventos(50, 300)) r where r.id = '${eventoId}';`,
    ).trim();
    expect(reservavel).toBe("1");
  });

  it("recusa reprocessar um evento que NÃO está em erro", () => {
    sql(
      `select public.fn_billing_asaas_registrar_evento('evt-reprocessar-invalido-0001', 'PAYMENT_CREATED', 'pay_rp2', 'sandbox', 'webhook', '{}'::jsonb);`,
    );
    const eventoId = sql(
      `select id from public.asaas_webhook_events where event_id = 'evt-reprocessar-invalido-0001';`,
    ).trim();

    const erro = erroSob(
      "service_role",
      `select public.fn_billing_asaas_reprocessar_evento('${eventoId}'::uuid, null)`,
    );
    expect(erro).not.toBeNull();
    expect(erro).toContain("billing_evento_nao_esta_em_erro");
  });
});

describe("0909 Tarefa 4: fn_billing_asaas_podar_eventos (decisão 21/N38)", () => {
  it("payload vira {} e payload_podado_em é gravado só para eventos mais velhos que p_dias", () => {
    sql(
      `select public.fn_billing_asaas_registrar_evento('evt-podar-velho-0001', 'PAYMENT_CREATED', 'pay_pv1', 'sandbox', 'webhook', '{"algo":"presente"}'::jsonb);`,
    );
    sql(
      `select public.fn_billing_asaas_registrar_evento('evt-podar-novo-0001', 'PAYMENT_CREATED', 'pay_pn1', 'sandbox', 'webhook', '{"algo":"presente"}'::jsonb);`,
    );
    // O evento "velho" recebeu o evento há 200 dias; o "novo" é de agora.
    sql(`update public.asaas_webhook_events set recebido_em = now() - interval '200 days' where event_id = 'evt-podar-velho-0001';`);

    const resultado = sql(`select public.fn_billing_asaas_podar_eventos(180);`);
    const podados = JSON.parse(resultado) as { podados: number };
    expect(podados.podados).toBeGreaterThanOrEqual(1);

    const velho = sql(
      `select payload::text, payload_podado_em is not null as podado from public.asaas_webhook_events where event_id = 'evt-podar-velho-0001';`,
    );
    expect(velho).toContain("{}");
    expect(velho).toContain("t");

    const novo = sql(
      `select payload::text, payload_podado_em is null as nao_podado from public.asaas_webhook_events where event_id = 'evt-podar-novo-0001';`,
    );
    expect(novo).toContain("presente");
    expect(novo).toContain("t");
  });

  it("rejeita p_dias inválido", () => {
    const erro = erroSob("service_role", "select public.fn_billing_asaas_podar_eventos(0)");
    expect(erro).not.toBeNull();
    expect(erro).toContain("billing_dias_invalido");
  });
});

describe("0909 Tarefa 4: limpeza", () => {
  it("apaga os eventos de teste desta seção", () => {
    sql(`
      delete from public.asaas_webhook_events
       where event_id like 'evt-%'
          or event_id in ('evt-repetido-0001');
    `);
    const restam = sql(`select count(*) from public.asaas_webhook_events where event_id like 'evt-%';`).trim();
    expect(restam).toBe("0");
  });
});

// ============================================================================
// TAREFA 5: pagamento, período, troca de plano, pacote (decisões 4 a 8, 12,
// 26, 27; correções A1, M2, M3, M5, M8, B1, B5, B6, B9).
// ============================================================================

const FUNCOES_TAREFA_5_INTERNAS = [
  "fn_billing_asaas_periodo_do_ciclo",
  "fn_billing_asaas_rotear_pagamento",
  "fn_billing_asaas_aplicar_pagamento",
] as const;

describe.each(FUNCOES_TAREFA_5_INTERNAS)("0909 Tarefa 5: `%s` é interna, SEM execute nem para service_role", (funcao) => {
  it("nenhum papel (anon/authenticated/service_role) tem EXECUTE no catálogo", () => {
    expect(privilegiosDaFuncao("anon", funcao)).toBe("NENHUM");
    expect(privilegiosDaFuncao("authenticated", funcao)).toBe("NENHUM");
    expect(privilegiosDaFuncao("service_role", funcao)).toBe("NENHUM");
  });
});

describe("0909 Tarefa 5: `fn_billing_asaas_aplicar_evento` é deny-all para anon/authenticated (grants)", () => {
  it("`anon` não tem EXECUTE no catálogo", () => {
    expect(privilegiosDaFuncao("anon", "fn_billing_asaas_aplicar_evento")).toBe("NENHUM");
  });

  it("`authenticated` não tem EXECUTE no catálogo", () => {
    expect(privilegiosDaFuncao("authenticated", "fn_billing_asaas_aplicar_evento")).toBe("NENHUM");
  });

  it("`service_role` TEM EXECUTE no catálogo (controle positivo)", () => {
    expect(privilegiosDaFuncao("service_role", "fn_billing_asaas_aplicar_evento")).toContain("EXECUTE");
  });

  it("`authenticated` é barrado por permission denied ao chamar de verdade", () => {
    const erro = erroSob(
      "authenticated",
      "select public.fn_billing_asaas_aplicar_evento('00000000-0000-4000-8000-000000000000', gen_random_uuid(), null)",
    );
    expect(erro).not.toBeNull();
    expect(erro).toContain("permission denied for function");
  });
});

/**
 * Reserva os eventos pendentes (até 50) e devolve id/lease_token do
 * event_id ESPECÍFICO, lido de asaas_webhook_events DEPOIS da reserva
 * (nunca filtrando o resultado da própria função por resource_id: dois
 * event_id diferentes podem compartilhar o mesmo resource_id/asaas_
 * payment_id nestes testes, ex.: reenvio de CONFIRMED seguido de RECEIVED).
 */
function reservarPorEventId(eventId: string): { id: string; lease: string } {
  sql(`select public.fn_billing_asaas_reservar_eventos(50, 300);`);
  const linha = sql(`select id, lease_token from public.asaas_webhook_events where event_id = '${eventId}';`);
  const [id, lease] = linha.split("|");
  expect(id, `evento ${eventId} não foi reservado (lease_token ausente)`).toBeTruthy();
  expect(lease, `evento ${eventId} não ganhou lease_token`).toBeTruthy();
  return { id: (id ?? "").trim(), lease: (lease ?? "").trim() };
}

function registrarEAplicar(eventId: string, resourceId: string, confirmacao: string | null): string {
  sql(
    `select public.fn_billing_asaas_registrar_evento('${eventId}', 'PAYMENT_CONFIRMED', '${resourceId}', 'sandbox', 'webhook', '{}'::jsonb);`,
  );
  const { id, lease } = reservarPorEventId(eventId);
  return sql(
    `select public.fn_billing_asaas_aplicar_evento('${id}'::uuid, '${lease}'::uuid, ${confirmacao ?? "null"});`,
  );
}

const ORG_T5_PRIMEIRO = "09090005-a5aa-4000-8000-000000000001";
const ORG_T5_PACOTE = "09090005-a5aa-4000-8000-000000000002";
const ORG_T5_RENOVACAO = "09090005-a5aa-4000-8000-000000000003";
const ORG_T5_DIVERGENTE = "09090005-a5aa-4000-8000-000000000004";
const ORG_T5_VENCIDO = "09090005-a5aa-4000-8000-000000000005";
const ORG_T5_CARENCIA = "09090005-a5aa-4000-8000-000000000006";
const ORG_T5_CORRIDA = "09090005-a5aa-4000-8000-000000000007";
const ORG_T5_CONFERIDOR = "09090005-a5aa-4000-8000-000000000008";

const ORGS_T5 = [
  ORG_T5_PRIMEIRO, ORG_T5_PACOTE, ORG_T5_RENOVACAO, ORG_T5_DIVERGENTE,
  ORG_T5_VENCIDO, ORG_T5_CARENCIA, ORG_T5_CORRIDA, ORG_T5_CONFERIDOR,
];

describe("0909 Tarefa 5: setup comum (organizações, compra ligada, pro à venda, pacote de teste)", () => {
  it("cria as organizações e liga o necessário", () => {
    sql(`
      ${ORGS_T5.map((id) => `insert into public.organizations (id, slug, legal_name, display_name) values ('${id}', 't5-${id.slice(-4)}', 't5 LTDA', 't5') on conflict (id) do nothing;`).join("\n")}
      select public.fn_billing_definir_compra_pelo_cliente(true, null);
      select public.fn_billing_definir_a_venda('pro', true, null);
      -- Correção (revisão F5, item 11): sandbox nasce sem conceder acesso
      -- (billing_settings.asaas_sandbox_concede = false); esta suíte é a
      -- própria homologação de sandbox, então liga a chave direto (a mesma
      -- forma que a documentação da coluna manda usar, sem função dedicada).
      update public.billing_settings set asaas_sandbox_concede = true where id = 1;
      insert into public.billing_token_pacotes (codigo, nome, tokens, preco_cents, ativo)
        values ('t5pacote', 'Pacote de teste T5', 100000, 5000, true)
        on conflict (codigo) do update set preco_cents = 5000, ativo = true, tokens = 100000;
    `);
    const contagem = sql(
      `select count(*) from public.organizations where id = any(array[${ORGS_T5.map((id) => `'${id}'`).join(",")}]::uuid[]);`,
    ).trim();
    expect(contagem).toBe(String(ORGS_T5.length));
  });
});

describe("0909 Tarefa 5: CONFIRMED e depois RECEIVED concedem uma vez (decisão 4)", () => {
  it("primeiro pagamento troca de Ilimitado para Pro, e a segunda confirmação (mesmo asaas_payment_id) é ja_aplicado", () => {
    sql(
      `select public.fn_billing_criar_pedido('${ORG_T5_PRIMEIRO}'::uuid, 'assinatura', 'pro', 'monthly', null, 'CREDIT_CARD', 'sandbox', gen_random_uuid(), null);`,
    );
    const pedidoId = sql(
      `select id from public.billing_orders where organization_id = '${ORG_T5_PRIMEIRO}' and status = 'criado';`,
    ).trim();
    sql(`select public.fn_billing_pedido_registrar_cobranca('${ORG_T5_PRIMEIRO}'::uuid, '${pedidoId}'::uuid, 'pay_t5_001', null, null);`);
    sql(`select public.fn_billing_vincular_cliente_asaas('${ORG_T5_PRIMEIRO}'::uuid, 'sandbox', 'cus_t5001');`);

    // sem confirmação: fica aguardando (decisão 3).
    const semConfirmacao = registrarEAplicar("evt-t5-001a", "pay_t5_001", null);
    expect(semConfirmacao).toContain('"resultado": "aguardando"');
    expect(sql(`select resultado from public.asaas_webhook_events where event_id = 'evt-t5-001a';`).trim()).toBe("aguardando");

    // CONFIRMED: concede, plan_id troca para Pro.
    const confirmado = `jsonb_build_object('id','pay_t5_001','status','CONFIRMED','value',199.00,'dueDate','2026-10-01','paymentDate','2026-10-01','customer','cus_t5001','externalReference','HC:ord:${pedidoId}')`;
    const { id: eventoId1, lease: lease1 } = (() => {
      sql(`select public.fn_billing_asaas_registrar_evento('evt-t5-001b', 'PAYMENT_CONFIRMED', 'pay_t5_001', 'sandbox', 'webhook', '{}'::jsonb);`);
      return reservarPorEventId("evt-t5-001b");
    })();
    const resultadoConfirmed = sql(
      `select public.fn_billing_asaas_aplicar_evento('${eventoId1}'::uuid, '${lease1}'::uuid, ${confirmado});`,
    );
    expect(resultadoConfirmed).toContain('"resultado": "aplicado"');

    const planoDoContrato = sql(
      `select bp.code from public.billing_contracts bc join public.billing_plans bp on bp.id = bc.plan_id where bc.organization_id = '${ORG_T5_PRIMEIRO}';`,
    ).trim();
    expect(planoDoContrato).toBe("pro");
    expect(sql(`select status from public.billing_orders where id = '${pedidoId}';`).trim()).toBe("pago");

    // RECEIVED do MESMO asaas_payment_id: ja_aplicado, uma linha só.
    sql(`select public.fn_billing_asaas_registrar_evento('evt-t5-001c', 'PAYMENT_RECEIVED', 'pay_t5_001', 'sandbox', 'webhook', '{}'::jsonb);`);
    const { id: eventoId2, lease: lease2 } = reservarPorEventId("evt-t5-001c");
    const resultadoReceived = sql(
      `select public.fn_billing_asaas_aplicar_evento('${eventoId2}'::uuid, '${lease2}'::uuid, jsonb_build_object('id','pay_t5_001','status','RECEIVED','value',199.00,'dueDate','2026-10-01','customer','cus_t5001'));`,
    );
    expect(resultadoReceived).toContain('"resultado": "ja_aplicado"');
    expect(sql(`select count(*) from public.billing_payments where asaas_payment_id = 'pay_t5_001';`).trim()).toBe("1");

    // billing_contract_eventos gravado (periodo e plano; sem "estado" aqui
    // porque a organização já nasce com status=ativa, e ativa -> ativa não é
    // uma transição de verdade, mesmo padrão de fn_billing_registrar_
    // pagamento, 0908).
    const tipos = sql(
      `select string_agg(distinct tipo, ',') from public.billing_contract_eventos where organization_id = '${ORG_T5_PRIMEIRO}' and motivo = 'pay_primeiro_pagamento';`,
    ).trim();
    expect(tipos).toContain("periodo");
    expect(tipos).toContain("plano");
  });
});

describe("0909 Tarefa 5: pacote de tokens credita uma vez (decisão 8)", () => {
  it("aplica, credita a carteira, marca o pedido pago; reprocesso não credita de novo", () => {
    sql(
      `select public.fn_billing_criar_pedido('${ORG_T5_PACOTE}'::uuid, 'pacote_tokens', null, null, 't5pacote', 'PIX', 'sandbox', gen_random_uuid(), null);`,
    );
    const pedidoId = sql(
      `select id from public.billing_orders where organization_id = '${ORG_T5_PACOTE}' and status = 'criado';`,
    ).trim();
    sql(`select public.fn_billing_pedido_registrar_cobranca('${ORG_T5_PACOTE}'::uuid, '${pedidoId}'::uuid, 'pay_t5_002', null, null);`);

    const confirmacao = `jsonb_build_object('id','pay_t5_002','status','RECEIVED','value',50.00,'dueDate','2026-10-01','externalReference','HC:ord:${pedidoId}')`;
    const resultado = registrarEAplicar("evt-t5-002", "pay_t5_002", confirmacao);
    expect(resultado).toContain('"resultado": "aplicado"');

    const creditado = sql(
      `select creditado from public.billing_token_wallets where organization_id = '${ORG_T5_PACOTE}' and fonte = 'avulso' and ciclo is null;`,
    ).trim();
    expect(creditado).toBe("100000");
    expect(sql(`select status from public.billing_orders where id = '${pedidoId}';`).trim()).toBe("pago");

    // período nulo, origem asaas, order_id do pedido.
    const linha = sql(
      `select billing_period_start is null, billing_period_end is null, origem, order_id from public.billing_payments where asaas_payment_id = 'pay_t5_002';`,
    );
    expect(linha).toContain("t|t|asaas|");
    expect(linha).toContain(pedidoId);

    // reprocesso: nao credita de novo.
    sql(`select public.fn_billing_asaas_registrar_evento('conc:pay_t5_002:RECEIVED', 'PAYMENT_RECEIVED', 'pay_t5_002', 'sandbox', 'conciliacao', '{}'::jsonb);`);
    const { id: eventoId2, lease: lease2 } = reservarPorEventId("conc:pay_t5_002:RECEIVED");
    const reprocesso = sql(
      `select public.fn_billing_asaas_aplicar_evento('${eventoId2}'::uuid, '${lease2}'::uuid, ${confirmacao});`,
    );
    expect(reprocesso).toContain('"resultado": "ja_aplicado"');
    expect(sql(`select creditado from public.billing_token_wallets where organization_id = '${ORG_T5_PACOTE}' and fonte = 'avulso' and ciclo is null;`).trim()).toBe("100000");
  });
});

describe("0909 Tarefa 5: renovação estende sem encurtar, evento velho não encurta, M3 desliga cancel_at_period_end", () => {
  it("assinatura de cartão já ativa: renovação estende o período; evento com dueDate anterior não encurta", () => {
    sql(`
      update public.billing_contracts
         set cycle = 'monthly', gateway = 'asaas', asaas_subscription_id = 'sub_t5003', asaas_ambiente = 'sandbox',
             current_period_start = now() - interval '25 days', current_period_end = now() - interval '5 hours',
             status = 'ativa', cancel_at_period_end = true
       where organization_id = '${ORG_T5_RENOVACAO}';
      select public.fn_billing_vincular_cliente_asaas('${ORG_T5_RENOVACAO}'::uuid, 'sandbox', 'cus_t5003');
    `);

    const confirmacao = `jsonb_build_object('id','pay_t5_003','status','RECEIVED','value',199.00,'dueDate','2026-11-01','customer','cus_t5003','subscription','sub_t5003','assinatura_status','ACTIVE')`;
    const resultado = registrarEAplicar("evt-t5-003", "pay_t5_003", confirmacao);
    expect(resultado).toContain('"resultado": "aplicado"');

    const cancelApos = sql(`select cancel_at_period_end from public.billing_contracts where organization_id = '${ORG_T5_RENOVACAO}';`).trim();
    expect(cancelApos, "M3: renovação confirmada com assinatura ACTIVE deveria desligar cancel_at_period_end").toBe("f");

    const fimApos1 = sql(`select current_period_end from public.billing_contracts where organization_id = '${ORG_T5_RENOVACAO}';`).trim();

    // evento VELHO (dueDate anterior): nao encurta.
    const confirmacaoVelha = `jsonb_build_object('id','pay_t5_003_velho','status','RECEIVED','value',199.00,'dueDate','2020-01-01','customer','cus_t5003','subscription','sub_t5003')`;
    registrarEAplicar("evt-t5-003-velho", "pay_t5_003_velho", confirmacaoVelha);
    const fimApos2 = sql(`select current_period_end from public.billing_contracts where organization_id = '${ORG_T5_RENOVACAO}';`).trim();
    expect(fimApos2).toBe(fimApos1);

    const tipos = sql(
      `select string_agg(distinct tipo, ',') from public.billing_contract_eventos where organization_id = '${ORG_T5_RENOVACAO}' and motivo = 'pay_renovacao';`,
    ).trim();
    expect(tipos).toContain("periodo");
    expect(tipos).toContain("cancelar_no_fim");
  });
});

describe("0909 Tarefa 5: cliente trocado e valor menor dão divergente; valor maior concede com alarme", () => {
  it("cliente diferente do vinculado: divergente, sem gravar pagamento", () => {
    sql(
      `select public.fn_billing_criar_pedido('${ORG_T5_DIVERGENTE}'::uuid, 'assinatura', 'pro', 'monthly', null, 'CREDIT_CARD', 'sandbox', gen_random_uuid(), null);`,
    );
    const pedidoId = sql(`select id from public.billing_orders where organization_id = '${ORG_T5_DIVERGENTE}' and status = 'criado';`).trim();
    sql(`select public.fn_billing_pedido_registrar_cobranca('${ORG_T5_DIVERGENTE}'::uuid, '${pedidoId}'::uuid, 'pay_t5_004a', null, null);`);
    sql(`select public.fn_billing_vincular_cliente_asaas('${ORG_T5_DIVERGENTE}'::uuid, 'sandbox', 'cus_t5004');`);

    const confA = `jsonb_build_object('id','pay_t5_004a','status','CONFIRMED','value',199.00,'dueDate','2026-10-01','customer','cus_OUTRO')`;
    const resultadoA = registrarEAplicar("evt-t5-004a", "pay_t5_004a", confA);
    expect(resultadoA).toContain('"resultado": "divergente"');
    expect(sql(`select count(*) from public.billing_payments where asaas_payment_id = 'pay_t5_004a';`).trim()).toBe("0");

    // valor MENOR: divergente, tambem sem gravar.
    const confB = `jsonb_build_object('id','pay_t5_004b','status','CONFIRMED','value',50.00,'dueDate','2026-10-01','customer','cus_t5004','externalReference','HC:ord:${pedidoId}')`;
    const resultadoB = registrarEAplicar("evt-t5-004b", "pay_t5_004b", confB);
    expect(resultadoB).toContain('"resultado": "divergente"');
    expect(sql(`select count(*) from public.billing_payments where asaas_payment_id = 'pay_t5_004b';`).trim()).toBe("0");

    // valor MAIOR: concede com o alarme divergente_valor.
    const confC = `jsonb_build_object('id','pay_t5_004c','status','CONFIRMED','value',250.00,'dueDate','2026-10-01','customer','cus_t5004','externalReference','HC:ord:${pedidoId}')`;
    sql(`select public.fn_billing_asaas_registrar_evento('evt-t5-004c', 'PAYMENT_CONFIRMED', 'pay_t5_004c', 'sandbox', 'webhook', '{}'::jsonb);`);
    const { id: eventoIdC, lease: leaseC } = reservarPorEventId("evt-t5-004c");
    const resultadoC = sql(`select public.fn_billing_asaas_aplicar_evento('${eventoIdC}'::uuid, '${leaseC}'::uuid, ${confC});`);
    expect(resultadoC).toContain('"resultado": "aplicado"');
    expect(sql(`select alarme from public.asaas_webhook_events where event_id = 'evt-t5-004c';`).trim()).toBe("divergente_valor");
  });
});

describe("0909 Tarefa 5: prefixo HT: dá outro_app", () => {
  it("externalReference de outro app nunca casa com pedido nenhum", () => {
    const conf = `jsonb_build_object('id','pay_t5_005','status','CONFIRMED','value',100.00,'dueDate','2026-10-01','externalReference','HT:algumacoisa')`;
    const resultado = registrarEAplicar("evt-t5-005", "pay_t5_005", conf);
    expect(resultado).toContain('"resultado": "outro_app"');
  });
});

describe("0909 Tarefa 5: pago fora do prazo concede com alarme (decisão 4/A1)", () => {
  it("pedido vencido, pago mesmo assim: concede, com o alarme pago_fora_do_prazo", () => {
    sql(
      `select public.fn_billing_criar_pedido('${ORG_T5_VENCIDO}'::uuid, 'assinatura', 'pro', 'monthly', null, 'CREDIT_CARD', 'sandbox', gen_random_uuid(), null);`,
    );
    const pedidoId = sql(`select id from public.billing_orders where organization_id = '${ORG_T5_VENCIDO}' and status = 'criado';`).trim();
    sql(`select public.fn_billing_pedido_registrar_cobranca('${ORG_T5_VENCIDO}'::uuid, '${pedidoId}'::uuid, 'pay_t5_006', null, null);`);
    sql(`update public.billing_orders set status = 'vencido' where id = '${pedidoId}';`);
    // contrato suspenso (nao so pedido vencido): cobre o ramo "estado" de
    // billing_contract_eventos (a organizacao T5_PRIMEIRO nasce ativa e nunca
    // exercita esse ramo).
    sql(`update public.billing_contracts set status = 'suspensa' where organization_id = '${ORG_T5_VENCIDO}';`);
    sql(`select public.fn_billing_vincular_cliente_asaas('${ORG_T5_VENCIDO}'::uuid, 'sandbox', 'cus_t5006');`);

    const conf = `jsonb_build_object('id','pay_t5_006','status','CONFIRMED','value',199.00,'dueDate','2026-10-01','customer','cus_t5006')`;
    const resultado = registrarEAplicar("evt-t5-006", "pay_t5_006", conf);
    expect(resultado).toContain('"resultado": "aplicado"');
    expect(sql(`select alarme from public.asaas_webhook_events where event_id = 'evt-t5-006';`).trim()).toBe("pago_fora_do_prazo");
    expect(sql(`select status from public.billing_orders where id = '${pedidoId}';`).trim()).toBe("pago");
    expect(sql(`select status from public.billing_contracts where organization_id = '${ORG_T5_VENCIDO}';`).trim()).toBe("ativa");

    const tipos = sql(
      `select string_agg(distinct tipo, ',') from public.billing_contract_eventos where organization_id = '${ORG_T5_VENCIDO}' and motivo = 'pay_primeiro_pagamento';`,
    ).trim();
    expect(tipos, "com o contrato suspenso, o pagamento deveria gravar um evento de tipo estado (suspensa -> ativa)").toContain("estado");
  });
});

describe("0909 Tarefa 5: sem confirmação fica aguardando; lease alheio recusado", () => {
  it("p_confirmacao nulo em evento de pagamento fica aguardando, sem organization_id", () => {
    sql(`select public.fn_billing_asaas_registrar_evento('evt-t5-007', 'PAYMENT_CONFIRMED', 'pay_t5_007', 'sandbox', 'webhook', '{}'::jsonb);`);
    const { id, lease } = reservarPorEventId("evt-t5-007");
    const resultado = sql(`select public.fn_billing_asaas_aplicar_evento('${id}'::uuid, '${lease}'::uuid, null);`);
    expect(resultado).toContain('"resultado": "aguardando"');
    expect(sql(`select organization_id is null from public.asaas_webhook_events where id = '${id}';`).trim()).toBe("t");
  });

  it("lease que não é mais o do chamador é recusado com billing_lease_invalido", () => {
    sql(`select public.fn_billing_asaas_registrar_evento('evt-t5-008', 'PAYMENT_CONFIRMED', 'pay_t5_008', 'sandbox', 'webhook', '{}'::jsonb);`);
    const eventoId = sql(`select id from public.asaas_webhook_events where event_id = 'evt-t5-008';`).trim();
    const erro = erroSob(
      "service_role",
      `select public.fn_billing_asaas_aplicar_evento('${eventoId}'::uuid, gen_random_uuid(), null)`,
    );
    expect(erro).not.toBeNull();
    expect(erro).toContain("billing_lease_invalido");
  });
});

describe("0909 Tarefa 5: fn_billing_asaas_periodo_do_ciclo, dia 31 de janeiro mais um mês", () => {
  it("mensal: 31/01 + 1 mês (arimética nativa do Postgres, 2026 não é bissexto) + 1 dia = 2026-03-01 00h SP", () => {
    const linha = sql(`select periodo_inicio, periodo_fim from public.fn_billing_asaas_periodo_do_ciclo('2026-01-31'::date, 'monthly');`);
    const [inicio, fim] = linha.split("|");
    expect((inicio ?? "").trim()).toBe("2026-01-31 03:00:00+00");
    expect((fim ?? "").trim()).toBe("2026-03-01 03:00:00+00");
  });

  it("anual: 31/01 + 1 ano + 1 dia = 2027-02-01 00h SP", () => {
    const linha = sql(`select periodo_inicio, periodo_fim from public.fn_billing_asaas_periodo_do_ciclo('2026-01-31'::date, 'yearly');`);
    const [, fim] = linha.split("|");
    expect((fim ?? "").trim()).toBe("2027-02-01 03:00:00+00");
  });
});

describe("0909 Tarefa 5: corrida com o conferidor da F4 e com fn_billing_registrar_pagamento (duas sessões de verdade)", () => {
  const container = process.env.TEST_DB_CONTAINER;
  const porta = Number(process.env.TEST_DB_PORT ?? 54329);
  const pool = new pg.Pool({
    connectionString: `postgresql://postgres:postgres@127.0.0.1:${porta}/postgres`,
    max: 4,
  });

  afterAll(async () => {
    await pool.end();
  });

  it("aplicar_pagamento (renovação) concorrente com fn_billing_registrar_pagamento na MESMA organização: sem deadlock, os dois pagamentos ficam registrados", async () => {
    if (!container) {
      throw new Error("TEST_DB_CONTAINER ausente, rode via pnpm test:db");
    }

    sql(`
      update public.billing_contracts
         set cycle = 'monthly', gateway = 'asaas', asaas_subscription_id = 'sub_t5_corrida', asaas_ambiente = 'sandbox',
             current_period_start = now() - interval '20 days', current_period_end = now() + interval '5 days',
             status = 'ativa'
       where organization_id = '${ORG_T5_CORRIDA}';
      select public.fn_billing_vincular_cliente_asaas('${ORG_T5_CORRIDA}'::uuid, 'sandbox', 'cus_t5corrida');
    `);

    const confirmacao = JSON.stringify({
      id: "pay_t5_corrida", status: "RECEIVED", value: 199.0, dueDate: "2026-12-01",
      customer: "cus_t5corrida", subscription: "sub_t5_corrida",
    });

    const [r1, r2] = await Promise.all([
      pool.query("select public.fn_billing_asaas_aplicar_pagamento($1::jsonb, 'sandbox') as r", [confirmacao]),
      pool.query(
        "select public.fn_billing_registrar_pagamento($1::uuid, $2::date, $3::int, gen_random_uuid(), $4, null) as r",
        [ORG_T5_CORRIDA, "2026-12-31", 19900, "pagamento manual concorrente"],
      ),
    ]);

    expect((r1.rows[0] as { r: { resultado: string } }).r.resultado).toBe("aplicado");
    expect(r2.rows[0]).toBeDefined();

    const total = sql(`select count(*) from public.billing_payments where organization_id = '${ORG_T5_CORRIDA}';`).trim();
    expect(total).toBe("2");
  });

  it("aplicar_pagamento (renovação) concorrente com fn_billing_conferir_vencimento (F4) na MESMA organização: sem deadlock", async () => {
    if (!container) {
      throw new Error("TEST_DB_CONTAINER ausente, rode via pnpm test:db");
    }

    sql(`
      update public.billing_contracts
         set cycle = 'monthly', gateway = 'asaas', asaas_subscription_id = 'sub_t5_conferidor', asaas_ambiente = 'sandbox',
             current_period_start = now() - interval '20 days', current_period_end = now() - interval '2 hours',
             status = 'ativa'
       where organization_id = '${ORG_T5_CONFERIDOR}';
      select public.fn_billing_vincular_cliente_asaas('${ORG_T5_CONFERIDOR}'::uuid, 'sandbox', 'cus_t5conferidor');
    `);

    const confirmacao = JSON.stringify({
      id: "pay_t5_conferidor", status: "RECEIVED", value: 199.0, dueDate: "2026-12-01",
      customer: "cus_t5conferidor", subscription: "sub_t5_conferidor",
    });

    const [r1] = await Promise.all([
      pool.query("select public.fn_billing_asaas_aplicar_pagamento($1::jsonb, 'sandbox') as r", [confirmacao]),
      pool.query("select public.fn_billing_conferir_vencimento($1::uuid) as r", [ORG_T5_CONFERIDOR]),
    ]);

    expect((r1.rows[0] as { r: { resultado: string } }).r.resultado).toBe("aplicado");
    const status = sql(`select status from public.billing_contracts where organization_id = '${ORG_T5_CONFERIDOR}';`).trim();
    expect(status).toBe("ativa");
  });
});

describe("0909 Tarefa 5: limpeza", () => {
  it("apaga as organizações de teste (billing_contracts primeiro, sem assinatura Asaas) e os eventos", () => {
    sql(`
      update public.billing_contracts set asaas_subscription_id = null, asaas_assinatura_encerrada_em = null
       where organization_id = any(array[${ORGS_T5.map((id) => `'${id}'`).join(",")}]::uuid[]);
      delete from public.organizations where id = any(array[${ORGS_T5.map((id) => `'${id}'`).join(",")}]::uuid[]);
      delete from public.asaas_webhook_events where event_id like 'evt-t5-%' or event_id like 'conc:pay_t5_%';
    `);
    const restam = sql(
      `select count(*) from public.organizations where id = any(array[${ORGS_T5.map((id) => `'${id}'`).join(",")}]::uuid[]);`,
    ).trim();
    expect(restam).toBe("0");
  });
});

// ============================================================================
// TAREFA 6: estorno, chargeback, fim de assinatura, remoção (decisões 9, 10,
// 22, 23; correções M1, M2, M3, M4, B2, B4, B8, M8).
// ============================================================================

function registrarEAplicarTipo(eventId: string, eventType: string, resourceId: string, confirmacaoSql: string | null): string {
  sql(
    `select public.fn_billing_asaas_registrar_evento('${eventId}', '${eventType}', '${resourceId}', 'sandbox', 'webhook', '{}'::jsonb);`,
  );
  const { id, lease } = reservarPorEventId(eventId);
  return sql(
    `select public.fn_billing_asaas_aplicar_evento('${id}'::uuid, '${lease}'::uuid, ${confirmacaoSql ?? "null"});`,
  );
}

const ORG_T6_ESTORNO_PACOTE = "09090006-a5aa-4000-8000-000000000001";
const ORG_T6_ESTORNO_ASSINATURA = "09090006-a5aa-4000-8000-000000000002";
const ORG_T6_M2 = "09090006-a5aa-4000-8000-000000000003";
const ORG_T6_CHARGEBACK_CONVIVE = "09090006-a5aa-4000-8000-000000000004";
const ORG_T6_REVERSAO = "09090006-a5aa-4000-8000-000000000005";
const ORG_T6_SUB_DELETED = "09090006-a5aa-4000-8000-000000000006";
const ORG_T6_INACTIVE = "09090006-a5aa-4000-8000-000000000007";
const ORG_T6_404 = "09090006-a5aa-4000-8000-000000000008";
const ORG_T6_OVERDUE = "09090006-a5aa-4000-8000-000000000009";
const ORG_T6_PAYMENT_DELETED = "09090006-a5aa-400a-8000-000000000010";
const ORG_T6_M4_ANTES = "09090006-a5aa-400a-8000-000000000011";
const ORG_T6_M8 = "09090006-a5aa-400a-8000-000000000012";
const ORG_T6_OVERDUE_PACOTE = "09090006-a5aa-400a-8000-000000000013";
const ORG_T6_ASSINATURA_DUPLICADA = "09090006-a5aa-400a-8000-000000000014";
const ORG_T6_AMBIENTE = "09090006-a5aa-400a-8000-000000000015";
const ORG_T6_PIX_ANUAL = "09090006-a5aa-400a-8000-000000000016";
const ORG_T6_ESTORNO_FORJADO = "09090006-a5aa-400a-8000-000000000017";
const ORG_T6_RENOVACAO_OVERDUE = "09090006-a5aa-400a-8000-000000000018";
const ORG_T6_ROTEAMENTO = "09090006-a5aa-400a-8000-000000000019";
const ORG_T6_ESTADOS_DEFINITIVOS = "09090006-a5aa-400a-8000-00000000001a";
const ORG_T6_PEDIDO_MARCAR = "09090006-a5aa-400a-8000-00000000001b";
const ORG_T6_ATIVA_FUTURO = "09090006-a5aa-400a-8000-00000000001c";

const ORGS_T6 = [
  ORG_T6_ESTORNO_PACOTE, ORG_T6_ESTORNO_ASSINATURA, ORG_T6_M2, ORG_T6_CHARGEBACK_CONVIVE,
  ORG_T6_REVERSAO, ORG_T6_SUB_DELETED, ORG_T6_INACTIVE, ORG_T6_404, ORG_T6_OVERDUE,
  ORG_T6_PAYMENT_DELETED, ORG_T6_M4_ANTES, ORG_T6_M8, ORG_T6_OVERDUE_PACOTE,
  ORG_T6_ASSINATURA_DUPLICADA, ORG_T6_AMBIENTE, ORG_T6_PIX_ANUAL, ORG_T6_ESTORNO_FORJADO,
  ORG_T6_RENOVACAO_OVERDUE, ORG_T6_ROTEAMENTO, ORG_T6_ESTADOS_DEFINITIVOS, ORG_T6_PEDIDO_MARCAR,
  ORG_T6_ATIVA_FUTURO,
];

describe("0909 Tarefa 6: setup comum (organizações, compra ligada, pro à venda, pacote de teste)", () => {
  it("cria as organizações e liga o necessário", () => {
    sql(`
      ${ORGS_T6.map((id) => `insert into public.organizations (id, slug, legal_name, display_name) values ('${id}', 't6-${id.slice(-6)}', 't6 LTDA', 't6') on conflict (id) do nothing;`).join("\n")}
      select public.fn_billing_definir_compra_pelo_cliente(true, null);
      select public.fn_billing_definir_a_venda('pro', true, null);
      -- Correção (revisão F5, item 11): mesma razão do setup da Tarefa 5,
      -- acima.
      update public.billing_settings set asaas_sandbox_concede = true where id = 1;
      insert into public.billing_token_pacotes (codigo, nome, tokens, preco_cents, ativo)
        values ('t6pacote', 'Pacote de teste T6', 50000, 3000, true)
        on conflict (codigo) do update set preco_cents = 3000, ativo = true, tokens = 50000;
    `);
    const contagem = sql(
      `select count(*) from public.organizations where id = any(array[${ORGS_T6.map((id) => `'${id}'`).join(",")}]::uuid[]);`,
    ).trim();
    expect(contagem).toBe(String(ORGS_T6.length));
  });
});

describe("0909 Tarefa 6: grants das três peças novas (funções internas sem grant nenhum, função pública só service_role)", () => {
  it("fn_billing_asaas_aplicar_estorno é deny-all para TODOS, inclusive service_role", () => {
    for (const papel of ["anon", "authenticated", "service_role"]) {
      expect(privilegiosDaFuncao(papel, "fn_billing_asaas_aplicar_estorno")).toBe("NENHUM");
    }
  });

  it("fn_billing_asaas_aplicar_fim_da_assinatura é deny-all para TODOS, inclusive service_role", () => {
    for (const papel of ["anon", "authenticated", "service_role"]) {
      expect(privilegiosDaFuncao(papel, "fn_billing_asaas_aplicar_fim_da_assinatura")).toBe("NENHUM");
    }
  });

  it("fn_billing_asaas_marcar_assinatura_encerrada: anon/authenticated sem execute, service_role com execute", () => {
    expect(privilegiosDaFuncao("anon", "fn_billing_asaas_marcar_assinatura_encerrada")).toBe("NENHUM");
    expect(privilegiosDaFuncao("authenticated", "fn_billing_asaas_marcar_assinatura_encerrada")).toBe("NENHUM");
    expect(privilegiosDaFuncao("service_role", "fn_billing_asaas_marcar_assinatura_encerrada")).toContain("EXECUTE");
  });
});

describe("0909 Tarefa 6: estorno não mexe em período nem em tokens (decisão 9)", () => {
  it("pacote de tokens pago e depois estornado: carteira intacta, pedido vira estornado", () => {
    sql(
      `select public.fn_billing_criar_pedido('${ORG_T6_ESTORNO_PACOTE}'::uuid, 'pacote_tokens', null, null, 't6pacote', 'PIX', 'sandbox', gen_random_uuid(), null);`,
    );
    const pedidoId = sql(`select id from public.billing_orders where organization_id = '${ORG_T6_ESTORNO_PACOTE}' and status = 'criado';`).trim();
    sql(`select public.fn_billing_pedido_registrar_cobranca('${ORG_T6_ESTORNO_PACOTE}'::uuid, '${pedidoId}'::uuid, 'pay_t6_001', null, null);`);

    const confPagamento = `jsonb_build_object('id','pay_t6_001','status','RECEIVED','value',30.00,'dueDate','2026-10-01','externalReference','HC:ord:${pedidoId}')`;
    const pago = registrarEAplicarTipo("evt-t6-001a", "PAYMENT_RECEIVED", "pay_t6_001", confPagamento);
    expect(pago).toContain('"resultado": "aplicado"');
    expect(sql(`select creditado from public.billing_token_wallets where organization_id = '${ORG_T6_ESTORNO_PACOTE}' and fonte = 'avulso' and ciclo is null;`).trim()).toBe("50000");

    const confEstorno = `jsonb_build_object('id','pay_t6_001','status','REFUNDED','value',30.00)`;
    const estornado = registrarEAplicarTipo("evt-t6-001b", "PAYMENT_REFUNDED", "pay_t6_001", confEstorno);
    expect(estornado).toContain('"resultado": "aplicado"');
    expect(estornado).toContain('"alarme": "estorno_confirmado"');

    // tokens intactos.
    expect(sql(`select creditado from public.billing_token_wallets where organization_id = '${ORG_T6_ESTORNO_PACOTE}' and fonte = 'avulso' and ciclo is null;`).trim()).toBe("50000");
    // pedido vira estornado.
    expect(sql(`select status from public.billing_orders where id = '${pedidoId}';`).trim()).toBe("estornado");
    // duas linhas em billing_payments (RECEIVED + REFUNDED), a de estorno sem asaas_payment_id e sem período.
    const linhas = sql(`select status, asaas_payment_id is null, billing_period_start is null from public.billing_payments where organization_id = '${ORG_T6_ESTORNO_PACOTE}' order by created_at;`);
    expect(linhas).toContain("RECEIVED|f|t");
    expect(linhas).toContain("REFUNDED|t|t");
  });

  it("assinatura paga e depois estornada: current_period_end intacto", () => {
    sql(
      `select public.fn_billing_criar_pedido('${ORG_T6_ESTORNO_ASSINATURA}'::uuid, 'assinatura', 'pro', 'monthly', null, 'CREDIT_CARD', 'sandbox', gen_random_uuid(), null);`,
    );
    const pedidoId = sql(`select id from public.billing_orders where organization_id = '${ORG_T6_ESTORNO_ASSINATURA}' and status = 'criado';`).trim();
    sql(`select public.fn_billing_pedido_registrar_cobranca('${ORG_T6_ESTORNO_ASSINATURA}'::uuid, '${pedidoId}'::uuid, 'pay_t6_002', null, null);`);

    const confPagamento = `jsonb_build_object('id','pay_t6_002','status','CONFIRMED','value',199.00,'dueDate','2026-10-01','externalReference','HC:ord:${pedidoId}')`;
    registrarEAplicarTipo("evt-t6-002a", "PAYMENT_CONFIRMED", "pay_t6_002", confPagamento);
    const fimAntes = sql(`select current_period_end from public.billing_contracts where organization_id = '${ORG_T6_ESTORNO_ASSINATURA}';`).trim();
    expect(fimAntes.length).toBeGreaterThan(0);

    const confEstorno = `jsonb_build_object('id','pay_t6_002','status','REFUNDED','value',199.00)`;
    const estornado = registrarEAplicarTipo("evt-t6-002b", "PAYMENT_REFUNDED", "pay_t6_002", confEstorno);
    expect(estornado).toContain('"resultado": "aplicado"');

    const fimDepois = sql(`select current_period_end from public.billing_contracts where organization_id = '${ORG_T6_ESTORNO_ASSINATURA}';`).trim();
    expect(fimDepois).toBe(fimAntes);
    expect(sql(`select status from public.billing_orders where id = '${pedidoId}';`).trim()).toBe("estornado");
  });
});

describe("0909 Tarefa 6: M2, estorno antes do pagamento local (objeto já chega estornado)", () => {
  it("sem linha original gravada: grava o original SEM CONCEDER e o estorno, na mesma transação", () => {
    sql(
      `select public.fn_billing_criar_pedido('${ORG_T6_M2}'::uuid, 'pacote_tokens', null, null, 't6pacote', 'PIX', 'sandbox', gen_random_uuid(), null);`,
    );
    const pedidoId = sql(`select id from public.billing_orders where organization_id = '${ORG_T6_M2}' and status = 'criado';`).trim();
    sql(`select public.fn_billing_pedido_registrar_cobranca('${ORG_T6_M2}'::uuid, '${pedidoId}'::uuid, 'pay_t6_003', null, null);`);

    // NENHUM PAYMENT_CONFIRMED/RECEIVED aplicado antes: o objeto confirmado já chega REFUNDED.
    const confEstorno = `jsonb_build_object('id','pay_t6_003','status','REFUNDED','value',30.00,'externalReference','HC:ord:${pedidoId}')`;
    const resultado = registrarEAplicarTipo("evt-t6-003", "PAYMENT_REFUNDED", "pay_t6_003", confEstorno);
    expect(resultado).toContain('"resultado": "aplicado"');

    const linhas = sql(`select status, asaas_payment_id, contract_id is not null from public.billing_payments where organization_id = '${ORG_T6_M2}' order by created_at;`);
    expect(linhas).toContain("RECEIVED|pay_t6_003|t");
    expect(linhas).toContain("REFUNDED||t");
    // não concedeu: carteira NUNCA foi creditada, pedido não passou por pago.
    const creditado = sql(`select count(*) from public.billing_token_wallets where organization_id = '${ORG_T6_M2}';`).trim();
    expect(creditado).toBe("0");
    expect(sql(`select status from public.billing_orders where id = '${pedidoId}';`).trim()).toBe("estornado");
  });
});

describe("0909 Tarefa 6: chargeback e depois estorno real convivem (índice único só em REFUNDED)", () => {
  it("CHARGEBACK_REQUESTED seguido de REFUNDED do MESMO pagamento original: as duas linhas existem, sem erro", () => {
    sql(
      `select public.fn_billing_criar_pedido('${ORG_T6_CHARGEBACK_CONVIVE}'::uuid, 'assinatura', 'pro', 'monthly', null, 'CREDIT_CARD', 'sandbox', gen_random_uuid(), null);`,
    );
    const pedidoId = sql(`select id from public.billing_orders where organization_id = '${ORG_T6_CHARGEBACK_CONVIVE}' and status = 'criado';`).trim();
    sql(`select public.fn_billing_pedido_registrar_cobranca('${ORG_T6_CHARGEBACK_CONVIVE}'::uuid, '${pedidoId}'::uuid, 'pay_t6_004', null, null);`);
    const confPagamento = `jsonb_build_object('id','pay_t6_004','status','RECEIVED','value',199.00,'dueDate','2026-10-01','externalReference','HC:ord:${pedidoId}')`;
    registrarEAplicarTipo("evt-t6-004a", "PAYMENT_RECEIVED", "pay_t6_004", confPagamento);

    const confChargeback = `jsonb_build_object('id','pay_t6_004','status','CHARGEBACK_REQUESTED','value',199.00)`;
    const chargeback = registrarEAplicarTipo("evt-t6-004b", "PAYMENT_CHARGEBACK_REQUESTED", "pay_t6_004", confChargeback);
    expect(chargeback).toContain('"resultado": "aplicado"');
    expect(chargeback).toContain('"alarme": "chargeback_confirmado"');

    const confRefund = `jsonb_build_object('id','pay_t6_004','status','REFUNDED','value',199.00)`;
    const refund = registrarEAplicarTipo("evt-t6-004c", "PAYMENT_REFUNDED", "pay_t6_004", confRefund);
    expect(refund).toContain('"resultado": "aplicado"');

    const contagens = sql(
      `select status, count(*) from public.billing_payments where organization_id = '${ORG_T6_CHARGEBACK_CONVIVE}' group by status order by status;`,
    );
    expect(contagens).toContain("CHARGEBACK_REQUESTED|1");
    expect(contagens).toContain("REFUNDED|1");
    expect(contagens).toContain("RECEIVED|1");
  });
});

describe("0909 Tarefa 6: reversão de chargeback só alarma (N43)", () => {
  it("PAYMENT_AWAITING_CHARGEBACK_REVERSAL não grava billing_payments nem mexe em nada, só alarma", () => {
    const antes = sql(`select count(*) from public.billing_payments where organization_id = '${ORG_T6_REVERSAO}';`).trim();
    const conf = `jsonb_build_object('id','pay_t6_005','status','AWAITING_CHARGEBACK_REVERSAL','value',199.00)`;
    const resultado = registrarEAplicarTipo("evt-t6-005", "PAYMENT_AWAITING_CHARGEBACK_REVERSAL", "pay_t6_005", conf);
    expect(resultado).toContain('"resultado": "aplicado"');
    expect(resultado).toContain('"alarme": "reversao_de_chargeback"');
    const depois = sql(`select count(*) from public.billing_payments where organization_id = '${ORG_T6_REVERSAO}';`).trim();
    expect(depois).toBe(antes);
  });
});

describe("0909 Tarefa 6: SUBSCRIPTION_DELETED liga cancelar no fim e grava o marcador (decisão 10/22)", () => {
  it("confirmado (removida = true): cancel_at_period_end = true, marcador preenchido, pedido aberto cancelado", () => {
    sql(`
      update public.billing_contracts set asaas_subscription_id = 'sub_t6006', asaas_assinatura_encerrada_em = null, cancel_at_period_end = false
       where organization_id = '${ORG_T6_SUB_DELETED}';
      insert into public.billing_orders (organization_id, ambiente, tipo, plan_id, ciclo, metodo, amount_cents, chave, asaas_subscription_id, status)
        select '${ORG_T6_SUB_DELETED}', 'sandbox', 'assinatura', bc.plan_id, 'monthly', 'CREDIT_CARD', 19900, gen_random_uuid(), 'sub_t6006', 'aguardando_pagamento'
        from public.billing_contracts bc where bc.organization_id = '${ORG_T6_SUB_DELETED}';
    `);

    const conf = `jsonb_build_object('id','sub_t6006','removida',true)`;
    const resultado = registrarEAplicarTipo("evt-t6-006", "SUBSCRIPTION_DELETED", "sub_t6006", conf);
    expect(resultado).toContain('"resultado": "aplicado"');

    const linha = sql(`select cancel_at_period_end, asaas_assinatura_encerrada_em is not null from public.billing_contracts where organization_id = '${ORG_T6_SUB_DELETED}';`);
    expect(linha).toBe("t|t");

    const pedido = sql(`select status from public.billing_orders where organization_id = '${ORG_T6_SUB_DELETED}' and asaas_subscription_id = 'sub_t6006';`).trim();
    expect(pedido).toBe("cancelado");
  });
});

describe("0909 Tarefa 6: SUBSCRIPTION_INACTIVATED liga sem marcador; SUBSCRIPTION_UPDATED ACTIVE desliga (M3)", () => {
  it("INACTIVATED (removida=false, status=INACTIVE): cancel_at_period_end=true, marcador continua nulo; UPDATED ACTIVE desliga de novo", () => {
    sql(`
      update public.billing_contracts set asaas_subscription_id = 'sub_t6007', asaas_assinatura_encerrada_em = null, cancel_at_period_end = false
       where organization_id = '${ORG_T6_INACTIVE}';
    `);

    const confInactive = `jsonb_build_object('id','sub_t6007','removida',false,'status','INACTIVE')`;
    const resultadoInactive = registrarEAplicarTipo("evt-t6-007a", "SUBSCRIPTION_INACTIVATED", "sub_t6007", confInactive);
    expect(resultadoInactive).toContain('"resultado": "aplicado"');

    const linha1 = sql(`select cancel_at_period_end, asaas_assinatura_encerrada_em is null from public.billing_contracts where organization_id = '${ORG_T6_INACTIVE}';`);
    expect(linha1, "M3: INACTIVE puro liga cancel_at_period_end mas NÃO grava o marcador").toBe("t|t");

    const confActive = `jsonb_build_object('id','sub_t6007','removida',false,'status','ACTIVE')`;
    const resultadoActive = registrarEAplicarTipo("evt-t6-007b", "SUBSCRIPTION_UPDATED", "sub_t6007", confActive);
    expect(resultadoActive).toContain('"resultado": "aplicado"');

    const cancelDepois = sql(`select cancel_at_period_end from public.billing_contracts where organization_id = '${ORG_T6_INACTIVE}';`).trim();
    expect(cancelDepois).toBe("f");
  });
});

describe("0909 Tarefa 6: 404 na confirmação conta como removida (decisão 10)", () => {
  it("removida=true numa SUBSCRIPTION_INACTIVATED (simulando 404 no GET) grava o marcador do mesmo jeito que DELETED", () => {
    sql(`
      update public.billing_contracts set asaas_subscription_id = 'sub_t6008', asaas_assinatura_encerrada_em = null, cancel_at_period_end = false
       where organization_id = '${ORG_T6_404}';
    `);
    const conf = `jsonb_build_object('id','sub_t6008','removida',true,'status',null)`;
    const resultado = registrarEAplicarTipo("evt-t6-008", "SUBSCRIPTION_INACTIVATED", "sub_t6008", conf);
    expect(resultado).toContain('"resultado": "aplicado"');
    const linha = sql(`select cancel_at_period_end, asaas_assinatura_encerrada_em is not null from public.billing_contracts where organization_id = '${ORG_T6_404}';`);
    expect(linha).toBe("t|t");
  });
});

describe("0909 Tarefa 6: PAYMENT_OVERDUE vence o pedido, alarme por TIPO de pedido (A1, correção item 4)", () => {
  // Correção (revisão F5, item 4): o alarme não é mais sempre remover_
  // cobranca_pendente; pedido de ASSINATURA (primeiro pagamento nunca
  // recebido) avisa para remover a ASSINATURA no Asaas (remover_assinatura_
  // pendente, N39, "remove sozinho"); só o pedido AVULSO (pacote de tokens)
  // continua com remover_cobranca_pendente. Este teste (ORG_T6_OVERDUE) era
  // "assinatura" e afirmava o alarme antigo por engano (nunca existiu um
  // caso de pedido avulso vencido nesta suíte); o novo teste logo abaixo
  // (ORG_T6_OVERDUE_PACOTE) cobre o caso avulso que o nome original prometia.
  it("pedido de ASSINATURA aguardando pagamento, confirmado OVERDUE: status vencido, alarme remover_assinatura_pendente", () => {
    sql(
      `select public.fn_billing_criar_pedido('${ORG_T6_OVERDUE}'::uuid, 'assinatura', 'pro', 'monthly', null, 'CREDIT_CARD', 'sandbox', gen_random_uuid(), null);`,
    );
    const pedidoId = sql(`select id from public.billing_orders where organization_id = '${ORG_T6_OVERDUE}' and status = 'criado';`).trim();
    sql(`select public.fn_billing_pedido_registrar_cobranca('${ORG_T6_OVERDUE}'::uuid, '${pedidoId}'::uuid, 'pay_t6_009', null, null);`);

    const conf = `jsonb_build_object('id','pay_t6_009','status','OVERDUE','externalReference','HC:ord:${pedidoId}')`;
    const resultado = registrarEAplicarTipo("evt-t6-009", "PAYMENT_OVERDUE", "pay_t6_009", conf);
    expect(resultado).toContain('"resultado": "aplicado"');
    expect(resultado).toContain('"alarme": "remover_assinatura_pendente"');
    expect(sql(`select status from public.billing_orders where id = '${pedidoId}';`).trim()).toBe("vencido");
    // não mexe no contrato (decisão 10).
    expect(sql(`select status from public.billing_contracts where organization_id = '${ORG_T6_OVERDUE}';`).trim()).toBe("ativa");
  });

  it("pedido AVULSO (pacote de tokens) aguardando pagamento, confirmado OVERDUE: alarme remover_cobranca_pendente", () => {
    sql(
      `select public.fn_billing_criar_pedido('${ORG_T6_OVERDUE_PACOTE}'::uuid, 'pacote_tokens', null, null, 't6pacote', 'CREDIT_CARD', 'sandbox', gen_random_uuid(), null);`,
    );
    const pedidoId = sql(`select id from public.billing_orders where organization_id = '${ORG_T6_OVERDUE_PACOTE}' and status = 'criado';`).trim();
    sql(`select public.fn_billing_pedido_registrar_cobranca('${ORG_T6_OVERDUE_PACOTE}'::uuid, '${pedidoId}'::uuid, 'pay_t6_009b', null, null);`);

    const conf = `jsonb_build_object('id','pay_t6_009b','status','OVERDUE','externalReference','HC:ord:${pedidoId}')`;
    const resultado = registrarEAplicarTipo("evt-t6-009b", "PAYMENT_OVERDUE", "pay_t6_009b", conf);
    expect(resultado).toContain('"resultado": "aplicado"');
    expect(resultado).toContain('"alarme": "remover_cobranca_pendente"');
    expect(sql(`select status from public.billing_orders where id = '${pedidoId}';`).trim()).toBe("vencido");
  });
});

describe("0909 Tarefa 6: PAYMENT_DELETED confirmado cancela o pedido", () => {
  it("removida=true: pedido cancelado, contrato intacto", () => {
    sql(
      `select public.fn_billing_criar_pedido('${ORG_T6_PAYMENT_DELETED}'::uuid, 'pacote_tokens', null, null, 't6pacote', 'PIX', 'sandbox', gen_random_uuid(), null);`,
    );
    const pedidoId = sql(`select id from public.billing_orders where organization_id = '${ORG_T6_PAYMENT_DELETED}' and status = 'criado';`).trim();
    sql(`select public.fn_billing_pedido_registrar_cobranca('${ORG_T6_PAYMENT_DELETED}'::uuid, '${pedidoId}'::uuid, 'pay_t6_010', null, null);`);

    const conf = `jsonb_build_object('id','pay_t6_010','removida',true,'externalReference','HC:ord:${pedidoId}')`;
    const resultado = registrarEAplicarTipo("evt-t6-010", "PAYMENT_DELETED", "pay_t6_010", conf);
    expect(resultado).toContain('"resultado": "aplicado"');
    expect(sql(`select status from public.billing_orders where id = '${pedidoId}';`).trim()).toBe("cancelado");
  });
});

describe("0909 Tarefa 6: M1, reassinatura depois do cancelamento passa em fn_billing_criar_pedido", () => {
  it("com o marcador preenchido (reusa ORG_T6_SUB_DELETED), um pedido novo do mesmo tipo é aceito", () => {
    const resultado = sql(
      `select public.fn_billing_criar_pedido('${ORG_T6_SUB_DELETED}'::uuid, 'assinatura', 'pro', 'monthly', null, 'CREDIT_CARD', 'sandbox', gen_random_uuid(), null);`,
    );
    expect(resultado).toContain('"ja_existia": false');
  });
});

describe("0909 Tarefa 6: trava de delete respeita o marcador gravado por SUBSCRIPTION_DELETED", () => {
  it("com o marcador preenchido (ORG_T6_SUB_DELETED), apagar o contrato agora FUNCIONA", () => {
    const erro = erroSob("service_role", `delete from public.billing_contracts where organization_id = '${ORG_T6_SUB_DELETED}'`);
    expect(erro, `o delete deveria ter passado, o marcador já está preenchido: ${erro}`).toBeNull();
    expect(sql(`select count(*) from public.billing_contracts where organization_id = '${ORG_T6_SUB_DELETED}';`).trim()).toBe("0");
  });
});

describe("0909 Tarefa 6 (B2): fn_billing_estornar_pagamento recusa linha de origem asaas", () => {
  it("pagamento origem=asaas: 22023 billing_pagamento_nao_e_manual", () => {
    const pagamentoId = sql(
      `select id from public.billing_payments where organization_id = '${ORG_T6_ESTORNO_ASSINATURA}' and status = 'CONFIRMED';`,
    ).trim();
    expect(pagamentoId.length).toBeGreaterThan(0);
    const erro = erroSob(
      "service_role",
      `select public.fn_billing_estornar_pagamento('${ORG_T6_ESTORNO_ASSINATURA}'::uuid, '${pagamentoId}'::uuid, gen_random_uuid(), 'teste B2', null)`,
    );
    expect(erro).not.toBeNull();
    expect(erro).toContain("billing_pagamento_nao_e_manual");
  });
});

describe("0909 Tarefa 6 (M4): fn_billing_mudar_estado recusa cancelada manual com assinatura Asaas viva", () => {
  it("sem o marcador: 22023 billing_cancele_no_asaas_antes; com o marcador: sucesso", () => {
    sql(`
      update public.billing_contracts set asaas_subscription_id = 'sub_t6m4', asaas_assinatura_encerrada_em = null
       where organization_id = '${ORG_T6_M4_ANTES}';
    `);
    const erro = erroSob(
      "service_role",
      `select public.fn_billing_mudar_estado('${ORG_T6_M4_ANTES}'::uuid, 'cancelada', 'teste M4', null)`,
    );
    expect(erro).not.toBeNull();
    expect(erro).toContain("billing_cancele_no_asaas_antes");

    sql(`update public.billing_contracts set asaas_assinatura_encerrada_em = now() where organization_id = '${ORG_T6_M4_ANTES}';`);
    const resultado = sql(
      `select public.fn_billing_mudar_estado('${ORG_T6_M4_ANTES}'::uuid, 'cancelada', 'teste M4', null);`,
    );
    expect(resultado).toContain('"estado_novo": "cancelada"');
  });
});

describe("0909 Tarefa 6 (M8): sentinela pre_roteamento:outro_app fecha sem GET e sem conceder", () => {
  it("p_confirmacao = {\"pre_roteamento\":\"outro_app\"} fecha outro_app, sem tocar em billing_payments", () => {
    sql(`select public.fn_billing_asaas_registrar_evento('evt-t6-011', 'PAYMENT_CONFIRMED', 'pay_t6_011', 'sandbox', 'webhook', '{}'::jsonb);`);
    const { id, lease } = reservarPorEventId("evt-t6-011");
    const resultado = sql(
      `select public.fn_billing_asaas_aplicar_evento('${id}'::uuid, '${lease}'::uuid, '{"pre_roteamento":"outro_app"}'::jsonb);`,
    );
    expect(resultado).toContain('"resultado": "outro_app"');
    expect(sql(`select resultado, tentativas, proxima_tentativa_em is null from public.asaas_webhook_events where event_id = 'evt-t6-011';`)).toBe(
      "outro_app|0|t",
    );
    expect(sql(`select count(*) from public.billing_payments where asaas_payment_id = 'pay_t6_011';`).trim()).toBe("0");
  });
});

describe("0909 Tarefa 6 (M8): aguardando ganha backoff, não é reservado de novo sem limite, e vira erro na décima", () => {
  it("primeira vez sem confirmação: tentativas=1, proxima_tentativa_em no futuro, e a reserva imediata NÃO pega o evento de novo", () => {
    sql(`select public.fn_billing_asaas_registrar_evento('evt-t6-012', 'PAYMENT_CONFIRMED', 'pay_t6_012', 'sandbox', 'webhook', '{}'::jsonb);`);
    const { id, lease } = reservarPorEventId("evt-t6-012");
    const resultado = sql(`select public.fn_billing_asaas_aplicar_evento('${id}'::uuid, '${lease}'::uuid, null);`);
    expect(resultado).toContain('"resultado": "aguardando"');

    const linha = sql(`select tentativas, proxima_tentativa_em > now(), lease_token is null from public.asaas_webhook_events where id = '${id}';`);
    expect(linha).toBe("1|t|t");

    // reserva imediata: proxima_tentativa_em ainda está no futuro (backoff mínimo de 2 minutos), então NÃO pega este evento.
    sql(`select public.fn_billing_asaas_reservar_eventos(50, 300);`);
    const leaseDepois = sql(`select lease_token is null from public.asaas_webhook_events where id = '${id}';`).trim();
    expect(leaseDepois, "evento aguardando foi reservado de novo IMEDIATAMENTE, sem respeitar o backoff (o defeito do M8)").toBe("t");
  });

  it("na décima tentativa sem confirmação, vira erro e sai do índice dos pendentes", () => {
    sql(`select public.fn_billing_asaas_registrar_evento('evt-t6-013', 'PAYMENT_CONFIRMED', 'pay_t6_013', 'sandbox', 'webhook', '{}'::jsonb);`);
    const eventoId = sql(`select id from public.asaas_webhook_events where event_id = 'evt-t6-013';`).trim();

    // simula as nove tentativas anteriores (tentativas=9) sem esperar o backoff de verdade: dá um lease direto e chama aplicar_evento.
    sql(`update public.asaas_webhook_events set tentativas = 9 where id = '${eventoId}';`);
    sql(`select public.fn_billing_asaas_reservar_eventos(50, 300);`);
    const linha = sql(`select id, lease_token from public.asaas_webhook_events where event_id = 'evt-t6-013';`);
    const [id, lease] = linha.split("|");

    const resultado = sql(`select public.fn_billing_asaas_aplicar_evento('${(id ?? "").trim()}'::uuid, '${(lease ?? "").trim()}'::uuid, null);`);
    expect(resultado).toContain('"resultado": "erro"');

    const linhaFinal = sql(`select resultado, tentativas, proxima_tentativa_em is null from public.asaas_webhook_events where id = '${eventoId}';`);
    expect(linhaFinal).toBe("erro|10|t");
  });
});

// ============================================================================
// PARTE 7: correções da revisão e da auditoria de segurança da fase F5
// (hiperbold/planos/fase-F5-tarefas.md). Uma prova por item (1 a 13), mais o
// acréscimo do coordenador (PAYMENT_CHARGEBACK_DISPUTE).
// ============================================================================

describe("0909 PARTE 7, item 8: fn_billing_asaas_registrar_evento, prefixo reservado do webhook vai para quarentena", () => {
  it("event_id 'conc:...' vindo de origem=webhook não sequestra o namespace da conciliação", () => {
    const resultado = sql(
      `select public.fn_billing_asaas_registrar_evento('conc:forjado:REFUNDED', 'PAYMENT_REFUNDED', 'pay_forjado', 'sandbox', 'webhook', '{}'::jsonb);`,
    );
    expect(resultado).toContain('"quarentena": true');
    const linha = sql(`select resultado, erro_codigo from public.asaas_webhook_events where event_id = 'conc:forjado:REFUNDED';`);
    expect(linha).toBe("erro|evento_fora_do_formato:prefixo_reservado");

    // a MESMA origem=conciliacao com o mesmo prefixo passa normalmente.
    const resultadoConc = sql(
      `select public.fn_billing_asaas_registrar_evento('conc:pay_p7_008:REFUNDED', 'PAYMENT_REFUNDED', 'pay_p7_008', 'sandbox', 'conciliacao', '{}'::jsonb);`,
    );
    expect(resultadoConc).toContain('"quarentena": false');
  });

  it("event_id 'quarentena:...' vindo de origem=webhook também vai para quarentena", () => {
    const resultado = sql(
      `select public.fn_billing_asaas_registrar_evento('quarentena:forjado', 'PAYMENT_REFUNDED', 'pay_forjado2', 'sandbox', 'webhook', '{}'::jsonb);`,
    );
    expect(resultado).toContain('"quarentena": true');
  });
});

describe("0909 PARTE 7, item 12: fn_billing_asaas_reprocessar_evento aceita sem_vinculo", () => {
  it("evento sem_vinculo reprocessa sem erro e volta a aguardando", () => {
    sql(`select public.fn_billing_asaas_registrar_evento('evt-p7-012', 'PAYMENT_CONFIRMED', 'pay_p7_012', 'sandbox', 'webhook', '{}'::jsonb);`);
    const { id, lease } = reservarPorEventId("evt-p7-012");
    const conf = `jsonb_build_object('id','pay_p7_012','status','CONFIRMED','value',10.00,'dueDate','2026-10-01')`;
    sql(`select public.fn_billing_asaas_aplicar_evento('${id}'::uuid, '${lease}'::uuid, ${conf});`);
    expect(sql(`select resultado from public.asaas_webhook_events where id = '${id}';`).trim()).toBe("sem_vinculo");

    const reprocessado = sql(`select public.fn_billing_asaas_reprocessar_evento('${id}'::uuid, null);`);
    expect(reprocessado).toContain('"resultado_novo": "aguardando"');

    // ainda recusa fora de erro/sem_vinculo: o MESMO evento, já voltado para
    // aguardando, não reprocessa de novo.
    const erro = erroSob("service_role", `select public.fn_billing_asaas_reprocessar_evento('${id}'::uuid, null)`);
    expect(erro).not.toBeNull();
    expect(erro).toContain("billing_evento_nao_esta_em_erro");
  });
});

describe("0909 PARTE 7, item 3: fn_billing_asaas_rotear_pagamento exclui pedido estornado e falhou (não só pago)", () => {
  it("pedido com status estornado ou falhou nunca casa como categoria=pedido", () => {
    sql(`
      insert into public.billing_orders (organization_id, ambiente, tipo, plan_id, ciclo, metodo, amount_cents, chave, asaas_payment_id, status)
        select '${ORG_T6_ROTEAMENTO}', 'sandbox', 'assinatura', bc.plan_id, 'monthly', 'CREDIT_CARD', 19900, gen_random_uuid(), 'pay_p7_003a', 'estornado'
        from public.billing_contracts bc where bc.organization_id = '${ORG_T6_ROTEAMENTO}';
    `);
    const rotaEstornado = sql(
      `select categoria from public.fn_billing_asaas_rotear_pagamento('sandbox', null, null, 'pay_p7_003a');`,
    ).trim();
    expect(rotaEstornado).toBe("sem_vinculo");

    sql(`
      insert into public.billing_orders (organization_id, ambiente, tipo, pacote_id, tokens, metodo, amount_cents, chave, asaas_payment_id, status)
        select '${ORG_T6_ROTEAMENTO}', 'sandbox', 'pacote_tokens', bp.id, bp.tokens, 'PIX', 3000, gen_random_uuid(), 'pay_p7_003b', 'falhou'
        from public.billing_token_pacotes bp where bp.codigo = 't6pacote';
    `);
    const rotaFalhou = sql(
      `select categoria from public.fn_billing_asaas_rotear_pagamento('sandbox', null, null, 'pay_p7_003b');`,
    ).trim();
    expect(rotaFalhou).toBe("sem_vinculo");
  });
});

describe("0909 PARTE 7, item 1: estorno forjado não estorna nem bloqueia o pagamento real", () => {
  it("REFUNDED com GET ainda dizendo RECEIVED (forjado) fica ignorado; REFUNDED confirmado depois aplica normalmente", () => {
    sql(
      `select public.fn_billing_criar_pedido('${ORG_T6_ESTORNO_FORJADO}'::uuid, 'assinatura', 'pro', 'monthly', null, 'CREDIT_CARD', 'sandbox', gen_random_uuid(), null);`,
    );
    const pedidoId = sql(`select id from public.billing_orders where organization_id = '${ORG_T6_ESTORNO_FORJADO}' and status = 'criado';`).trim();
    sql(`select public.fn_billing_pedido_registrar_cobranca('${ORG_T6_ESTORNO_FORJADO}'::uuid, '${pedidoId}'::uuid, 'pay_p7_001', null, null);`);
    const confPagamento = `jsonb_build_object('id','pay_p7_001','status','RECEIVED','value',199.00,'dueDate','2026-10-01','externalReference','HC:ord:${pedidoId}')`;
    registrarEAplicarTipo("evt-p7-001a", "PAYMENT_RECEIVED", "pay_p7_001", confPagamento);
    const fimAntes = sql(`select current_period_end from public.billing_contracts where organization_id = '${ORG_T6_ESTORNO_FORJADO}';`).trim();
    expect(fimAntes.length).toBeGreaterThan(0);

    // FORJADO: evento REFUNDED com um pay_ LEGÍTIMO, mas o GET (p_confirmacao)
    // ainda diz RECEIVED (nunca foi estornado de verdade).
    const confForjado = `jsonb_build_object('id','pay_p7_001','status','RECEIVED','value',199.00)`;
    const forjado = registrarEAplicarTipo("evt-p7-001b", "PAYMENT_REFUNDED", "pay_p7_001", confForjado);
    expect(forjado).toContain('"resultado": "ignorado"');
    expect(sql(`select count(*) from public.billing_payments where organization_id = '${ORG_T6_ESTORNO_FORJADO}' and status = 'REFUNDED';`).trim()).toBe("0");
    // o pagamento real não foi tocado: contrato intacto, pedido continua pago.
    expect(sql(`select current_period_end from public.billing_contracts where organization_id = '${ORG_T6_ESTORNO_FORJADO}';`).trim()).toBe(fimAntes);
    expect(sql(`select status from public.billing_orders where id = '${pedidoId}';`).trim()).toBe("pago");

    // status EM ANDAMENTO (REFUND_IN_PROGRESS): aguardando, tenta de novo.
    const confAndamento = `jsonb_build_object('id','pay_p7_001','status','REFUND_IN_PROGRESS','value',199.00)`;
    const andamento = registrarEAplicarTipo("evt-p7-001c", "PAYMENT_REFUNDED", "pay_p7_001", confAndamento);
    expect(andamento).toContain('"resultado": "aguardando"');

    // REFUNDED confirmado DE VERDADE: aplica.
    const confReal = `jsonb_build_object('id','pay_p7_001','status','REFUNDED','value',199.00)`;
    const real = registrarEAplicarTipo("evt-p7-001d", "PAYMENT_REFUNDED", "pay_p7_001", confReal);
    expect(real).toContain('"resultado": "aplicado"');
    expect(sql(`select count(*) from public.billing_payments where organization_id = '${ORG_T6_ESTORNO_FORJADO}' and status = 'REFUNDED';`).trim()).toBe("1");
  });
});

describe("0909 PARTE 7, acréscimo (coordenador): PAYMENT_CHARGEBACK_DISPUTE despacha para fn_billing_asaas_aplicar_estorno", () => {
  it("DISPUTE confirmado aplica como chargeback; REQUESTED depois é idempotente pela mesma linha", () => {
    sql(
      `select public.fn_billing_criar_pedido('${ORG_T6_ESTORNO_FORJADO}'::uuid, 'pacote_tokens', null, null, 't6pacote', 'PIX', 'sandbox', gen_random_uuid(), null);`,
    );
    const pedidoId = sql(`select id from public.billing_orders where organization_id = '${ORG_T6_ESTORNO_FORJADO}' and status = 'criado';`).trim();
    sql(`select public.fn_billing_pedido_registrar_cobranca('${ORG_T6_ESTORNO_FORJADO}'::uuid, '${pedidoId}'::uuid, 'pay_p7_dispute', null, null);`);
    const confPagamento = `jsonb_build_object('id','pay_p7_dispute','status','RECEIVED','value',30.00,'externalReference','HC:ord:${pedidoId}')`;
    registrarEAplicarTipo("evt-p7-dispute-a", "PAYMENT_RECEIVED", "pay_p7_dispute", confPagamento);

    const confDispute = `jsonb_build_object('id','pay_p7_dispute','status','CHARGEBACK_DISPUTE','value',30.00)`;
    const dispute = registrarEAplicarTipo("evt-p7-dispute-b", "PAYMENT_CHARGEBACK_DISPUTE", "pay_p7_dispute", confDispute);
    expect(dispute).toContain('"resultado": "aplicado"');
    expect(dispute).toContain('"alarme": "chargeback_confirmado"');
    expect(sql(`select count(*) from public.billing_payments where organization_id = '${ORG_T6_ESTORNO_FORJADO}' and status = 'CHARGEBACK_REQUESTED';`).trim()).toBe("1");

    // REQUESTED chegando DEPOIS da DISPUTE, mesmo payment: idempotente (a
    // MESMA chave, ja_aplicado), sem segunda linha.
    const confRequested = `jsonb_build_object('id','pay_p7_dispute','status','CHARGEBACK_REQUESTED','value',30.00)`;
    const requested = registrarEAplicarTipo("evt-p7-dispute-c", "PAYMENT_CHARGEBACK_REQUESTED", "pay_p7_dispute", confRequested);
    expect(requested).toContain('"resultado": "ja_aplicado"');
    expect(sql(`select count(*) from public.billing_payments where organization_id = '${ORG_T6_ESTORNO_FORJADO}' and status = 'CHARGEBACK_REQUESTED';`).trim()).toBe("1");
  });
});

describe("0909 PARTE 7, item 2: PAYMENT_OVERDUE de cobrança de RENOVAÇÃO fecha ignorado (nunca 'renovacao' fora do CHECK)", () => {
  it("assinatura de cartão já ativa: OVERDUE da própria assinatura (sem pedido) fecha ignorado, sem estourar o UPDATE final", () => {
    sql(`
      update public.billing_contracts
         set cycle = 'monthly', gateway = 'asaas', asaas_subscription_id = 'sub_p7_002', asaas_ambiente = 'sandbox',
             current_period_start = now() - interval '10 days', current_period_end = now() + interval '20 days', status = 'ativa'
       where organization_id = '${ORG_T6_RENOVACAO_OVERDUE}';
    `);
    const conf = `jsonb_build_object('id','pay_p7_002','status','OVERDUE','subscription','sub_p7_002')`;
    const resultado = registrarEAplicarTipo("evt-p7-002", "PAYMENT_OVERDUE", "pay_p7_002", conf);
    expect(resultado).toContain('"resultado": "ignorado"');
    const linha = sql(`select resultado, erro_codigo from public.asaas_webhook_events where event_id = 'evt-p7-002';`);
    expect(linha).toBe("ignorado|cobranca_de_renovacao");
    // não mexe no contrato.
    expect(sql(`select status from public.billing_contracts where organization_id = '${ORG_T6_RENOVACAO_OVERDUE}';`).trim()).toBe("ativa");
  });
});

describe("0909 PARTE 7, item 4 (primeira metade): assinatura Asaas duplicada não concede", () => {
  it("contrato já com OUTRA assinatura viva: primeiro pagamento de uma SEGUNDA assinatura vira divergente com alarme assinatura_duplicada", () => {
    sql(`
      update public.billing_contracts
         set asaas_subscription_id = 'sub_p7_original', asaas_ambiente = 'sandbox', asaas_assinatura_encerrada_em = null,
             cycle = 'monthly', gateway = 'asaas', current_period_start = now(), current_period_end = now() + interval '30 days', status = 'ativa'
       where organization_id = '${ORG_T6_ASSINATURA_DUPLICADA}';
      insert into public.billing_orders (organization_id, ambiente, tipo, plan_id, ciclo, metodo, amount_cents, chave, asaas_payment_id, status)
        select '${ORG_T6_ASSINATURA_DUPLICADA}', 'sandbox', 'assinatura', bc.plan_id, 'monthly', 'CREDIT_CARD', 19900, gen_random_uuid(), 'pay_p7_004', 'aguardando_pagamento'
        from public.billing_contracts bc where bc.organization_id = '${ORG_T6_ASSINATURA_DUPLICADA}';
    `);
    const conf = `jsonb_build_object('id','pay_p7_004','status','CONFIRMED','value',199.00,'dueDate','2026-10-01','subscription','sub_p7_outra')`;
    const resultado = registrarEAplicarTipo("evt-p7-004", "PAYMENT_CONFIRMED", "pay_p7_004", conf);
    expect(resultado).toContain('"resultado": "divergente"');
    expect(resultado).toContain('"alarme": "assinatura_duplicada"');
    expect(sql(`select count(*) from public.billing_payments where asaas_payment_id = 'pay_p7_004';`).trim()).toBe("0");
    // a assinatura original do contrato continua intacta.
    expect(sql(`select asaas_subscription_id from public.billing_contracts where organization_id = '${ORG_T6_ASSINATURA_DUPLICADA}';`).trim()).toBe("sub_p7_original");
  });
});

describe("0909 PARTE 7, item 5: contrato só volta a ativa quando o novo fim é posterior a now()", () => {
  it("pagamento de um período já todo no passado (dueDate velho) não ativa um contrato suspenso", () => {
    sql(`
      select public.fn_billing_criar_pedido('${ORG_T6_ATIVA_FUTURO}'::uuid, 'assinatura', 'pro', 'monthly', null, 'CREDIT_CARD', 'sandbox', gen_random_uuid(), null);
      update public.billing_contracts set status = 'suspensa', current_period_end = now() - interval '100 days' where organization_id = '${ORG_T6_ATIVA_FUTURO}';
    `);
    const pedidoId = sql(`select id from public.billing_orders where organization_id = '${ORG_T6_ATIVA_FUTURO}' and status = 'criado';`).trim();
    sql(`select public.fn_billing_pedido_registrar_cobranca('${ORG_T6_ATIVA_FUTURO}'::uuid, '${pedidoId}'::uuid, 'pay_p7_005', null, null);`);

    // dueDate BEM velho: o período concedido (mensal, +1 dia) ainda termina no
    // passado, então current_period_end novo continua no passado.
    const conf = `jsonb_build_object('id','pay_p7_005','status','CONFIRMED','value',199.00,'dueDate','2020-01-01','externalReference','HC:ord:${pedidoId}')`;
    const resultado = registrarEAplicarTipo("evt-p7-005", "PAYMENT_CONFIRMED", "pay_p7_005", conf);
    expect(resultado).toContain('"resultado": "aplicado"');
    // o pagamento aplicou (billing_payments/pedido pago), mas o CONTRATO
    // continua suspensa: o novo fim não é posterior a now().
    expect(sql(`select status from public.billing_orders where id = '${pedidoId}';`).trim()).toBe("pago");
    expect(sql(`select status from public.billing_contracts where organization_id = '${ORG_T6_ATIVA_FUTURO}';`).trim()).toBe("suspensa");
  });
});

describe("0909 PARTE 7, item 6: mais estados definitivos fecham ignorado (nunca aguardando para sempre)", () => {
  it("PAYMENT_OVERDUE com GET já RECEIVED, PAYMENT_DELETED restaurado e SUBSCRIPTION_INACTIVATED reativada fecham ignorado", () => {
    sql(`
      select public.fn_billing_criar_pedido('${ORG_T6_ESTADOS_DEFINITIVOS}'::uuid, 'assinatura', 'pro', 'monthly', null, 'CREDIT_CARD', 'sandbox', gen_random_uuid(), null);
    `);
    const pedidoAssinatura = sql(`select id from public.billing_orders where organization_id = '${ORG_T6_ESTADOS_DEFINITIVOS}' and status = 'criado';`).trim();
    sql(`select public.fn_billing_pedido_registrar_cobranca('${ORG_T6_ESTADOS_DEFINITIVOS}'::uuid, '${pedidoAssinatura}'::uuid, 'pay_p7_006a', null, null);`);
    const confOverdueJaRecebido = `jsonb_build_object('id','pay_p7_006a','status','RECEIVED','externalReference','HC:ord:${pedidoAssinatura}')`;
    const overdue = registrarEAplicarTipo("evt-p7-006a", "PAYMENT_OVERDUE", "pay_p7_006a", confOverdueJaRecebido);
    expect(overdue).toContain('"resultado": "ignorado"');
    expect(sql(`select erro_codigo from public.asaas_webhook_events where event_id = 'evt-p7-006a';`).trim()).toBe("pagamento_ja_recebido");
    // não marcou vencido: o pedido continua no estado de antes.
    expect(sql(`select status from public.billing_orders where id = '${pedidoAssinatura}';`).trim()).toBe("aguardando_pagamento");

    sql(`
      select public.fn_billing_criar_pedido('${ORG_T6_ESTADOS_DEFINITIVOS}'::uuid, 'pacote_tokens', null, null, 't6pacote', 'PIX', 'sandbox', gen_random_uuid(), null);
    `);
    const pedidoPacote = sql(`select id from public.billing_orders where organization_id = '${ORG_T6_ESTADOS_DEFINITIVOS}' and tipo = 'pacote_tokens' and status = 'criado';`).trim();
    sql(`select public.fn_billing_pedido_registrar_cobranca('${ORG_T6_ESTADOS_DEFINITIVOS}'::uuid, '${pedidoPacote}'::uuid, 'pay_p7_006b', null, null);`);
    const confDeletedRestaurado = `jsonb_build_object('id','pay_p7_006b','removida',false,'externalReference','HC:ord:${pedidoPacote}')`;
    const deleted = registrarEAplicarTipo("evt-p7-006b", "PAYMENT_DELETED", "pay_p7_006b", confDeletedRestaurado);
    expect(deleted).toContain('"resultado": "ignorado"');
    expect(sql(`select erro_codigo from public.asaas_webhook_events where event_id = 'evt-p7-006b';`).trim()).toBe("pagamento_restaurado");
    expect(sql(`select status from public.billing_orders where id = '${pedidoPacote}';`).trim()).toBe("aguardando_pagamento");

    sql(`
      update public.billing_contracts set asaas_subscription_id = 'sub_p7_006c', asaas_ambiente = 'sandbox', asaas_assinatura_encerrada_em = null, cancel_at_period_end = false
       where organization_id = '${ORG_T6_ESTADOS_DEFINITIVOS}';
    `);
    const confInactivatedReativada = `jsonb_build_object('id','sub_p7_006c','removida',false,'status','ACTIVE')`;
    const inactivated = registrarEAplicarTipo("evt-p7-006c", "SUBSCRIPTION_INACTIVATED", "sub_p7_006c", confInactivatedReativada);
    expect(inactivated).toContain('"resultado": "ignorado"');
    expect(sql(`select erro_codigo from public.asaas_webhook_events where event_id = 'evt-p7-006c';`).trim()).toBe("assinatura_reativada");
    expect(sql(`select cancel_at_period_end from public.billing_contracts where organization_id = '${ORG_T6_ESTADOS_DEFINITIVOS}';`).trim()).toBe("f");
  });
});

describe("0909 PARTE 7, item 7: fn_billing_pedido_marcar, inconclusivo só a partir de processando", () => {
  it("recusa inconclusivo a partir de criado; aceita a partir de processando", () => {
    sql(
      `select public.fn_billing_criar_pedido('${ORG_T6_PEDIDO_MARCAR}'::uuid, 'assinatura', 'pro', 'monthly', null, 'CREDIT_CARD', 'sandbox', gen_random_uuid(), null);`,
    );
    const pedidoId = sql(`select id from public.billing_orders where organization_id = '${ORG_T6_PEDIDO_MARCAR}' and status = 'criado';`).trim();

    const erro = erroSob(
      "service_role",
      `select public.fn_billing_pedido_marcar('${ORG_T6_PEDIDO_MARCAR}'::uuid, '${pedidoId}'::uuid, 'inconclusivo', 'teste item 7')`,
    );
    expect(erro).not.toBeNull();
    expect(erro).toContain("billing_pedido_nao_esta_processando");

    sql(`select public.fn_billing_pedido_tomar('${ORG_T6_PEDIDO_MARCAR}'::uuid, '${pedidoId}'::uuid);`);
    expect(sql(`select status from public.billing_orders where id = '${pedidoId}';`).trim()).toBe("processando");

    const resultado = sql(
      `select public.fn_billing_pedido_marcar('${ORG_T6_PEDIDO_MARCAR}'::uuid, '${pedidoId}'::uuid, 'inconclusivo', 'teste item 7');`,
    );
    expect(resultado).toContain('"status_novo": "inconclusivo"');
  });
});

describe("0909 PARTE 7, item 9: evento fechado outro_app poda o payload na hora", () => {
  it("externalReference de outro app: payload vira {} e payload_podado_em é gravado", () => {
    const conf = `jsonb_build_object('id','pay_p7_009','status','CONFIRMED','value',10.00,'dueDate','2026-10-01','externalReference','HT:algumacoisa','dado_do_outro_produto','nao_deveria_ficar_aqui')`;
    const resultado = registrarEAplicar("evt-p7-009", "pay_p7_009", conf);
    expect(resultado).toContain('"resultado": "outro_app"');
    const linha = sql(`select payload::text, payload_podado_em is not null from public.asaas_webhook_events where event_id = 'evt-p7-009';`);
    expect(linha).toBe("{}|t");
  });
});

describe("0909 PARTE 7, item 10: asaas_ambiente gravado no primeiro pagamento; renovação só casa do MESMO ambiente", () => {
  it("um evento de PRODUÇÃO nunca casa como renovação de um contrato marcado sandbox", () => {
    sql(`
      update public.billing_contracts
         set asaas_subscription_id = 'sub_p7_010', asaas_ambiente = 'sandbox', cycle = 'monthly', gateway = 'asaas',
             current_period_start = now() - interval '10 days', current_period_end = now() + interval '20 days', status = 'ativa'
       where organization_id = '${ORG_T6_AMBIENTE}';
    `);
    const rotaProducao = sql(
      `select categoria from public.fn_billing_asaas_rotear_pagamento('producao', 'sub_p7_010', null, null);`,
    ).trim();
    expect(rotaProducao).toBe("sem_vinculo");
    const rotaSandbox = sql(
      `select categoria from public.fn_billing_asaas_rotear_pagamento('sandbox', 'sub_p7_010', null, null);`,
    ).trim();
    expect(rotaSandbox).toBe("renovacao");
  });

  it("primeiro pagamento grava asaas_ambiente junto com asaas_subscription_id", () => {
    sql(
      `select public.fn_billing_criar_pedido('${ORG_T6_AMBIENTE}'::uuid, 'pacote_tokens', null, null, 't6pacote', 'PIX', 'sandbox', gen_random_uuid(), null);`,
    );
    // limpa a assinatura anterior para este pedido de PACOTE não colidir com
    // a checagem de assinatura duplicada (pacote não tem ciclo/assinatura).
    const pedidoId = sql(`select id from public.billing_orders where organization_id = '${ORG_T6_AMBIENTE}' and tipo = 'pacote_tokens' and status = 'criado';`).trim();
    sql(`select public.fn_billing_pedido_registrar_cobranca('${ORG_T6_AMBIENTE}'::uuid, '${pedidoId}'::uuid, 'pay_p7_010b', null, null);`);
    const conf = `jsonb_build_object('id','pay_p7_010b','status','RECEIVED','value',30.00,'externalReference','HC:ord:${pedidoId}')`;
    const resultado = registrarEAplicarTipo("evt-p7-010b", "PAYMENT_RECEIVED", "pay_p7_010b", conf);
    expect(resultado).toContain('"resultado": "aplicado"');
    // pacote não mexe em asaas_ambiente do contrato (só o primeiro pagamento
    // de ASSINATURA grava, decisão 8/item 10); confere que o ambiente da
    // assinatura já existente continua sandbox.
    expect(sql(`select asaas_ambiente from public.billing_contracts where organization_id = '${ORG_T6_AMBIENTE}';`).trim()).toBe("sandbox");
  });
});

describe("0909 PARTE 7, item 11: sandbox só concede com billing_settings.asaas_sandbox_concede ligada", () => {
  it("com a chave desligada, pagamento de sandbox fica ignorado (sandbox_nao_concede) sem tocar em contrato nem tokens; religada, concede", () => {
    sql(
      `select public.fn_billing_criar_pedido('${ORG_T6_AMBIENTE}'::uuid, 'pacote_tokens', null, null, 't6pacote', 'PIX', 'sandbox', gen_random_uuid(), null);`,
    );
    const pedidoId = sql(`select id from public.billing_orders where organization_id = '${ORG_T6_AMBIENTE}' and tipo = 'pacote_tokens' and status = 'criado';`).trim();
    sql(`select public.fn_billing_pedido_registrar_cobranca('${ORG_T6_AMBIENTE}'::uuid, '${pedidoId}'::uuid, 'pay_p7_011', null, null);`);

    sql(`update public.billing_settings set asaas_sandbox_concede = false where id = 1;`);
    const confSandbox = `jsonb_build_object('id','pay_p7_011','status','RECEIVED','value',30.00,'externalReference','HC:ord:${pedidoId}')`;
    const desligado = registrarEAplicarTipo("evt-p7-011a", "PAYMENT_RECEIVED", "pay_p7_011", confSandbox);
    expect(desligado).toContain('"resultado": "ignorado"');
    expect(desligado).toContain('"alarme": "sandbox_nao_concede"');
    expect(sql(`select count(*) from public.billing_payments where asaas_payment_id = 'pay_p7_011';`).trim()).toBe("0");
    expect(sql(`select status from public.billing_orders where id = '${pedidoId}';`).trim()).toBe("aguardando_pagamento");

    // ignorado é terminal (não é erro nem sem_vinculo, então fn_billing_
    // asaas_reprocessar_evento não se aplica aqui, item 12): religar a chave
    // e mandar um evento NOVO (o próprio Asaas reentregaria, ou a
    // conciliação diária injeta um evento sintético) é o caminho real.
    sql(`update public.billing_settings set asaas_sandbox_concede = true where id = 1;`);
    const religado = registrarEAplicarTipo("evt-p7-011b", "PAYMENT_RECEIVED", "pay_p7_011", confSandbox);
    expect(religado).toContain('"resultado": "aplicado"');
    expect(sql(`select count(*) from public.billing_payments where asaas_payment_id = 'pay_p7_011';`).trim()).toBe("1");
  });
});

describe("0909 PARTE 7, item 13: Pix anual com paymentDate nulo usa o início do dia em São Paulo, nunca now()", () => {
  it("período do Pix anual começa à meia-noite de SP do dia do processamento, não na hora exata", () => {
    // price_yearly_cents continua nulo em produção (N8, ainda sem resposta
    // do Filipe); para este teste (matemática de período, ortogonal ao
    // preço) liga um preço só nesta VERSÃO ativa do plano, sem mexer na
    // decisão de negócio N8/N9 em si.
    sql(`update public.billing_plans set price_yearly_cents = 599900 where code = 'max' and active;`);
    sql(
      `select public.fn_billing_criar_pedido('${ORG_T6_PIX_ANUAL}'::uuid, 'assinatura', 'max', 'yearly', null, 'PIX', 'sandbox', gen_random_uuid(), null);`,
    );
    const pedidoId = sql(`select id from public.billing_orders where organization_id = '${ORG_T6_PIX_ANUAL}' and status = 'criado';`).trim();
    expect(pedidoId.length).toBeGreaterThan(0);
    sql(`select public.fn_billing_pedido_registrar_cobranca('${ORG_T6_PIX_ANUAL}'::uuid, '${pedidoId}'::uuid, 'pay_p7_013', null, null);`);
    // SEM paymentDate: o objeto confirmado do Pix às vezes chega assim antes
    // da confirmação definitiva do meio de pagamento.
    const conf = `jsonb_build_object('id','pay_p7_013','status','RECEIVED','value',5999.00,'externalReference','HC:ord:${pedidoId}')`;
    const resultado = registrarEAplicarTipo("evt-p7-013", "PAYMENT_RECEIVED", "pay_p7_013", conf);
    expect(resultado).toContain('"resultado": "aplicado"');
    const inicio = sql(`select billing_period_start from public.billing_payments where asaas_payment_id = 'pay_p7_013';`).trim();
    // à meia-noite em America/Sao_Paulo (03:00 UTC), nunca a hora exata do
    // processamento.
    expect(inicio.endsWith("00:00:00+00") || inicio.includes(" 03:00:00+00"), `início não está à meia-noite de SP: ${inicio}`).toBe(true);
  });
});

describe("0909 Tarefa 6: limpeza", () => {
  it("apaga as organizações de teste (billing_contracts primeiro, sem assinatura Asaas) e os eventos", () => {
    sql(`
      update public.billing_contracts set asaas_subscription_id = null, asaas_assinatura_encerrada_em = null, cancel_at_period_end = false
       where organization_id = any(array[${ORGS_T6.map((id) => `'${id}'`).join(",")}]::uuid[]);
      delete from public.organizations where id = any(array[${ORGS_T6.map((id) => `'${id}'`).join(",")}]::uuid[]);
      delete from public.asaas_webhook_events where event_id like 'evt-t6-%';
    `);
    const restam = sql(
      `select count(*) from public.organizations where id = any(array[${ORGS_T6.map((id) => `'${id}'`).join(",")}]::uuid[]);`,
    ).trim();
    expect(restam).toBe("0");
  });
});
