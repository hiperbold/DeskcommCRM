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
