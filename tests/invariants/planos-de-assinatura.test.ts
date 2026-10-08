import { beforeAll, describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

/**
 * O CATÁLOGO DE PLANOS E O CONTRATO DA ORGANIZAÇÃO, migration 0904 (fase F1,
 * fork Hiperbold, `hiperbold/planos/fase-F1-tarefas.md`, Tarefa 2).
 *
 * Oito provas, na ordem do enunciado da Tarefa 2:
 *
 *  1. organização nova nasce com contrato no Ilimitado ativo (gatilho);
 *  2. sem Ilimitado ativo, a organização ainda nasce, sem contrato, sem erro;
 *  3. isolamento por RLS: membro de A lê o próprio contrato/ajuste, não o de B;
 *  4. nem membro comum nem admin da ORGANIZAÇÃO escrevem nas três tabelas nem
 *     executam as funções, só `service_role` escreve (decisão 7/8 da fase);
 *  5. `fn_billing_limites_validos` nas seis recusas e nas duas aceitações;
 *  6. `fn_billing_limites_efetivos`: precedência do ajuste sobre o plano;
 *  7. `fn_billing_trocar_plano`: upsert, antes/depois sob troca em sequência,
 *     plano inexistente/inativo recusados;
 *  8. a semeadura rodada de novo não duplica nem sobrescreve preço alterado.
 *
 * Como `caso-so-nasce-do-motor.test.ts`, fala com o Postgres por
 * `tests/invariants/psql-transporte.ts` (não `gov-helpers.ts`, congelado) e usa
 * `authenticated` + `request.jwt.claims`, o MESMO caminho que `auth.uid()` e as
 * policies de produção leem, não uma inspeção de catálogo. `postgres` (o papel
 * do container) é superusuário: bypassa GRANT/REVOKE mas NÃO as exceções que as
 * funções `security definer` lançam de propósito, por isso as provas 5 a 8
 * (regra de negócio, não RLS) rodam como `postgres`, e só as provas 3 e 4
 * (isolamento e ausência de escrita para `authenticated`) trocam de papel.
 */

const ORG_A = "09040000-0000-4000-8000-00000000000a";
const ORG_B = "09040000-0000-4000-8000-00000000000b";
const USER_A = "09040000-1111-4000-8000-00000000000a";
const USER_B = "09040000-1111-4000-8000-00000000000b";
/** Mesma organização de A, papel `admin`, prova que nem admin de ORG escreve. */
const USER_A_ADMIN = "09040000-1111-4000-8000-00000000000c";

const ORG_NOVA = "09040000-2222-4000-8000-000000000001";
const ORG_SEM_ILIMITADO = "09040000-2222-4000-8000-000000000002";
const ORG_LIMITES = "09040000-3333-4000-8000-000000000001";
const ORG_TROCA = "09040000-3333-4000-8000-000000000002";

/** Marcador das linhas de resultado, o psql também imprime SET, INSERT 0 1 etc. */
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
 * usuário logado: papel `authenticated` + `request.jwt.claims`, o caminho que
 * `auth.uid()` e as policies de produção leem (mesmo padrão de
 * `rls-isolation.test.ts` e `caso-so-nasce-do-motor.test.ts`).
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

/**
 * Afirma que `authenticated` foi recusado por PRIVILÉGIO, não por uma coluna
 * NOT NULL esquecida no DML de prova, que devolveria "erro" sem medir a cerca.
 */
function esperaBarrado(userId: string, dml: string, contexto: string): void {
  const erro = erroDe(`${comoMembro(userId)}\n${dml};`);
  expect(erro, `${contexto}: passou SEM erro, está exposto a "authenticated"`).not.toBeNull();
  expect(erro).toContain("permission denied");
}

beforeAll(() => {
  comoServico(`
    insert into auth.users (id, email) values
      ('${USER_A}', 'billing-inv-a@invariant.test'),
      ('${USER_B}', 'billing-inv-b@invariant.test'),
      ('${USER_A_ADMIN}', 'billing-inv-a-admin@invariant.test')
    on conflict (id) do nothing;

    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'billing-inv-a', 'Billing Invariant A LTDA', 'Billing A'),
      ('${ORG_B}', 'billing-inv-b', 'Billing Invariant B LTDA', 'Billing B')
    on conflict (id) do nothing;

    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${USER_A}', '${ORG_A}', 'agent', now()),
      ('${USER_A_ADMIN}', '${ORG_A}', 'admin', now()),
      ('${USER_B}', '${ORG_B}', 'agent', now())
    on conflict do nothing;

    -- billing_contracts de A e B já nasceram pelo gatilho (organizations
    -- inseridas acima). O ajuste não tem gatilho: semeado direto, um por
    -- organização, para o caso 3 ter o que ler como controle positivo.
    insert into public.billing_plan_adjustments (organization_id, limits, note) values
      ('${ORG_A}', '{"leads": 111}'::jsonb, 'ajuste invariante A'),
      ('${ORG_B}', '{"leads": 222}'::jsonb, 'ajuste invariante B')
    on conflict (organization_id) do nothing;
  `);
});

describe("1. organização nova nasce com contrato no Ilimitado ativo", () => {
  it("o gatilho after insert cria o contrato apontando para a versão ATIVA do Ilimitado", () => {
    const linhas = comoServico(`
      insert into public.organizations (id, slug, legal_name, display_name)
        values ('${ORG_NOVA}', 'billing-inv-nova', 'Billing Invariant Nova LTDA', 'Billing Nova')
        on conflict (id) do nothing;
      select 'SONDA|' || bp.code || ',' || bp.version || ',' || bp.active
        from public.billing_contracts bc
        join public.billing_plans bp on bp.id = bc.plan_id
        where bc.organization_id = '${ORG_NOVA}';
    `);
    expect(linhas).toEqual(["ilimitado,1,true"]);
  });
});

describe("2. sem Ilimitado ativo, a organização ainda nasce, sem contrato, sem erro", () => {
  it("desativa o Ilimitado, cria a organização, confere e desfaz", () => {
    // Dentro de uma transação DESFEITA (rollback), como o enunciado da
    // Tarefa 2 pede: o Ilimitado volta a ficar ativo para os casos seguintes.
    const linhas = comoServico(`
      begin;
      update public.billing_plans set active = false where code = 'ilimitado' and active;
      insert into public.organizations (id, slug, legal_name, display_name)
        values ('${ORG_SEM_ILIMITADO}', 'billing-inv-sem-ilimitado', 'Billing Invariant Sem Ilimitado LTDA', 'Billing Sem Ilimitado');
      select 'SONDA|org=' || count(*) from public.organizations where id = '${ORG_SEM_ILIMITADO}';
      select 'SONDA|contrato=' || count(*) from public.billing_contracts where organization_id = '${ORG_SEM_ILIMITADO}';
      rollback;
    `);
    expect(linhas).toEqual(["org=1", "contrato=0"]);
  });

  it("o Ilimitado segue ativo depois do rollback, não vazou para os casos seguintes", () => {
    const linhas = comoServico(
      `select 'SONDA|' || active from public.billing_plans where code = 'ilimitado' and version = 1;`,
    );
    expect(linhas).toEqual(["true"]);
  });
});

describe("3. RLS: membro de A lê o próprio contrato e ajuste, não os de B", () => {
  it("lê o próprio contrato", () => {
    expect(
      membro(USER_A, `select 'SONDA|' || count(*) from public.billing_contracts where organization_id = '${ORG_A}';`),
    ).toEqual(["1"]);
  });

  it("NÃO lê o contrato de B", () => {
    expect(
      membro(USER_A, `select 'SONDA|' || count(*) from public.billing_contracts where organization_id = '${ORG_B}';`),
    ).toEqual(["0"]);
  });

  it("lê o próprio ajuste", () => {
    expect(
      membro(
        USER_A,
        `select 'SONDA|' || count(*) from public.billing_plan_adjustments where organization_id = '${ORG_A}';`,
      ),
    ).toEqual(["1"]);
  });

  it("NÃO lê o ajuste de B", () => {
    expect(
      membro(
        USER_A,
        `select 'SONDA|' || count(*) from public.billing_plan_adjustments where organization_id = '${ORG_B}';`,
      ),
    ).toEqual(["0"]);
  });

  // Antes a policy de billing_plans era `using (true)`: catálogo aberto,
  // qualquer usuário de qualquer organização lia o preço de um plano sob
  // medida (for_sale=false) que não era o dele. A correção troca por: lê o
  // plano do CONTRATO da própria organização (ou um plano for_sale=true, ou
  // o admin da plataforma), não lê um plano fora de venda alheio.
  it("lê o plano do próprio contrato (pro), não um plano fora de venda que não é dele", () => {
    comoServico(`select public.fn_billing_trocar_plano('${ORG_A}'::uuid, 'pro', null);`);
    expect(
      membro(USER_A, `select 'SONDA|' || count(*) from public.billing_plans where code = 'pro' and active;`),
    ).toEqual(["1"]);
    expect(
      membro(USER_B, `select 'SONDA|' || count(*) from public.billing_plans where code = 'pro' and active;`),
    ).toEqual(["0"]);
  });
});

describe("3b. RLS: authenticated lê só as colunas liberadas de billing_plan_adjustments", () => {
  it("membro lê organization_id e limits do próprio ajuste", () => {
    expect(
      membro(USER_A, `select 'SONDA|' || organization_id from public.billing_plan_adjustments where organization_id = '${ORG_A}';`),
    ).toEqual([ORG_A]);
    expect(
      membro(
        USER_A,
        `select 'SONDA|' || (limits ->> 'leads') from public.billing_plan_adjustments where organization_id = '${ORG_A}';`,
      ),
    ).toEqual(["111"]);
  });

  it("membro recebe erro de permissão ao selecionar note", () => {
    esperaBarrado(
      USER_A,
      `select note from public.billing_plan_adjustments where organization_id = '${ORG_A}'`,
      "select note em billing_plan_adjustments",
    );
  });

  it("membro recebe erro de permissão ao selecionar granted_by", () => {
    esperaBarrado(
      USER_A,
      `select granted_by from public.billing_plan_adjustments where organization_id = '${ORG_A}'`,
      "select granted_by em billing_plan_adjustments",
    );
  });
});

describe("4. nem membro comum nem admin da organização escrevem", () => {
  const PAPEIS = [
    ["agent", USER_A] as const,
    ["admin da organização", USER_A_ADMIN] as const,
  ];

  const ESCRITAS = [
    {
      tabela: "billing_plans",
      insert: `insert into public.billing_plans (code, name, price_monthly_cents, limits) values ('hackeado', 'Hackeado', 0, jsonb_build_object('funis',null,'etapas_por_funil',null,'leads',null,'membros',null,'conexoes',null,'integracoes_webhook',null,'tokens_ia_mes',null))`,
      update: `update public.billing_plans set price_monthly_cents = 1 where code = 'pro' and active`,
      delete: `delete from public.billing_plans where code = 'pro' and active`,
    },
    {
      tabela: "billing_contracts",
      insert: `insert into public.billing_contracts (organization_id, plan_id) select '${ORG_A}', id from public.billing_plans where code = 'max' and active`,
      update: `update public.billing_contracts set status = 'cancelada' where organization_id = '${ORG_A}'`,
      delete: `delete from public.billing_contracts where organization_id = '${ORG_A}'`,
    },
    {
      tabela: "billing_plan_adjustments",
      insert: `insert into public.billing_plan_adjustments (organization_id, limits) values ('${ORG_B}', '{"leads":1}'::jsonb)`,
      update: `update public.billing_plan_adjustments set note = 'hackeado' where organization_id = '${ORG_A}'`,
      delete: `delete from public.billing_plan_adjustments where organization_id = '${ORG_A}'`,
    },
  ] as const;

  for (const [rotulo, userId] of PAPEIS) {
    for (const { tabela, insert, update, delete: apagar } of ESCRITAS) {
      it(`${rotulo} não insere em ${tabela}`, () => {
        esperaBarrado(userId, insert, `insert em ${tabela} como ${rotulo}`);
      });
      it(`${rotulo} não atualiza ${tabela}`, () => {
        esperaBarrado(userId, update, `update em ${tabela} como ${rotulo}`);
      });
      it(`${rotulo} não apaga de ${tabela}`, () => {
        esperaBarrado(userId, apagar, `delete em ${tabela} como ${rotulo}`);
      });
    }

    it(`${rotulo} não executa fn_billing_trocar_plano`, () => {
      esperaBarrado(
        userId,
        `select public.fn_billing_trocar_plano('${ORG_A}'::uuid, 'pro', '${userId}'::uuid)`,
        `fn_billing_trocar_plano como ${rotulo}`,
      );
    });

    it(`${rotulo} não executa fn_billing_ajustar_limites`, () => {
      esperaBarrado(
        userId,
        `select public.fn_billing_ajustar_limites('${ORG_A}'::uuid, '{"leads":1}'::jsonb, null, '${userId}'::uuid)`,
        `fn_billing_ajustar_limites como ${rotulo}`,
      );
    });
  }
});

describe("5. fn_billing_limites_validos", () => {
  function valida(objJsonSql: string, parcial: boolean): boolean {
    const linhas = comoServico(`select 'SONDA|' || public.fn_billing_limites_validos(${objJsonSql}, ${parcial})::text;`);
    return linhas[0] === "true";
  }

  const COMPLETO_VALIDO =
    "jsonb_build_object('funis',5,'etapas_por_funil',10,'leads',5000,'membros',3,'conexoes',3,'integracoes_webhook',3,'tokens_ia_mes',1000000)";

  it("aceita objeto completo válido (controle positivo)", () => {
    expect(valida(COMPLETO_VALIDO, false)).toBe(true);
  });

  it("recusa chave desconhecida", () => {
    expect(
      valida(
        "jsonb_build_object('funis',5,'etapas_por_funil',10,'leads',5000,'membros',3,'conexoes',3,'integracoes_webhook',3,'tokens_ia_mes',1000000,'chave_estranha',1)",
        false,
      ),
    ).toBe(false);
  });

  it("recusa chave faltando no modo completo", () => {
    expect(
      valida(
        "jsonb_build_object('funis',5,'etapas_por_funil',10,'leads',5000,'membros',3,'conexoes',3,'integracoes_webhook',3)",
        false,
      ),
    ).toBe(false);
  });

  it("recusa número negativo", () => {
    expect(
      valida(
        "jsonb_build_object('funis',-1,'etapas_por_funil',10,'leads',5000,'membros',3,'conexoes',3,'integracoes_webhook',3,'tokens_ia_mes',1000000)",
        false,
      ),
    ).toBe(false);
  });

  it("recusa número quebrado", () => {
    expect(
      valida(
        "jsonb_build_object('funis',1.5,'etapas_por_funil',10,'leads',5000,'membros',3,'conexoes',3,'integracoes_webhook',3,'tokens_ia_mes',1000000)",
        false,
      ),
    ).toBe(false);
  });

  it("recusa número acima de 2147483647", () => {
    expect(
      valida(
        "jsonb_build_object('funis',2147483648,'etapas_por_funil',10,'leads',5000,'membros',3,'conexoes',3,'integracoes_webhook',3,'tokens_ia_mes',1000000)",
        false,
      ),
    ).toBe(false);
  });

  it("recusa texto", () => {
    expect(
      valida(
        "jsonb_build_object('funis','muito','etapas_por_funil',10,'leads',5000,'membros',3,'conexoes',3,'integracoes_webhook',3,'tokens_ia_mes',1000000)",
        false,
      ),
    ).toBe(false);
  });

  it("recusa 5.0 (a fase seguinte faz (limits->>'x')::int, e '5.0'::int quebra)", () => {
    expect(
      valida(
        "jsonb_build_object('funis',5.0,'etapas_por_funil',10,'leads',5000,'membros',3,'conexoes',3,'integracoes_webhook',3,'tokens_ia_mes',1000000)",
        false,
      ),
    ).toBe(false);
  });

  it("aceita subconjunto no modo parcial", () => {
    expect(valida("jsonb_build_object('leads',100)", true)).toBe(true);
  });

  it("aceita objeto vazio no modo parcial", () => {
    expect(valida("'{}'::jsonb", true)).toBe(true);
  });
});

describe("6. fn_billing_limites_efetivos", () => {
  beforeAll(() => {
    comoServico(`
      insert into public.organizations (id, slug, legal_name, display_name)
        values ('${ORG_LIMITES}', 'billing-inv-limites', 'Billing Invariant Limites LTDA', 'Billing Limites')
        on conflict (id) do nothing;
      select public.fn_billing_trocar_plano('${ORG_LIMITES}'::uuid, 'pro', null);
      insert into public.billing_plan_adjustments (organization_id, limits, note)
        values ('${ORG_LIMITES}', jsonb_build_object('leads', 999, 'membros', null), 'ajuste teste efetivos')
        on conflict (organization_id) do update set limits = excluded.limits;
    `);
  });

  it("o ajuste vence sobre o valor do plano (leads: 999 em vez de 5000 do Pro)", () => {
    expect(
      comoServico(`select 'SONDA|' || (public.fn_billing_limites_efetivos('${ORG_LIMITES}'::uuid) ->> 'leads');`),
    ).toEqual(["999"]);
  });

  it("o ajuste com valor null LIBERA o limite (membros: null em vez de 3 do Pro)", () => {
    expect(
      comoServico(
        `select 'SONDA|' || coalesce(public.fn_billing_limites_efetivos('${ORG_LIMITES}'::uuid) ->> 'membros', 'NULL-JSON');`,
      ),
    ).toEqual(["NULL-JSON"]);
  });

  it("chave ausente no ajuste herda o valor do plano (etapas_por_funil: 10 do Pro)", () => {
    expect(
      comoServico(
        `select 'SONDA|' || (public.fn_billing_limites_efetivos('${ORG_LIMITES}'::uuid) ->> 'etapas_por_funil');`,
      ),
    ).toEqual(["10"]);
  });

  it("organização sem contrato recebe os limites do Ilimitado (funis: sem limite, antes era 5 do Pro)", () => {
    // 'funis' não está no ajuste ({"leads":999,"membros":null}), então sob
    // contrato Pro este teste leria 5 (o plano), a prova real de "sem
    // contrato" está em cair para o Ilimitado (null), não em o ajuste vencer.
    const linhas = comoServico(`
      begin;
      delete from public.billing_contracts where organization_id = '${ORG_LIMITES}';
      select 'SONDA|' || coalesce(public.fn_billing_limites_efetivos('${ORG_LIMITES}'::uuid) ->> 'funis', 'NULL-JSON');
      rollback;
    `);
    expect(linhas).toEqual(["NULL-JSON"]);
  });
});

describe("7. fn_billing_trocar_plano", () => {
  beforeAll(() => {
    comoServico(`
      insert into public.organizations (id, slug, legal_name, display_name)
        values ('${ORG_TROCA}', 'billing-inv-troca', 'Billing Invariant Troca LTDA', 'Billing Troca')
        on conflict (id) do nothing;
      delete from public.billing_contracts where organization_id = '${ORG_TROCA}';
    `);
  });

  it("organização sem contrato RECEBE contrato (upsert), antes é nulo", () => {
    const linhas = comoServico(
      `select 'SONDA|' || public.fn_billing_trocar_plano('${ORG_TROCA}'::uuid, 'pro', null)::text;`,
    );
    const resultado = JSON.parse(linhas[0]!) as { antes: unknown; depois: { plan_code: string; version: number } };
    expect(resultado.antes).toBeNull();
    expect(resultado.depois).toEqual({ plan_code: "pro", version: 1 });
  });

  it("troca concorrente: a SEGUNDA troca devolve o 'antes' certo (o resultado da primeira)", () => {
    const linhas = comoServico(
      `select 'SONDA|' || public.fn_billing_trocar_plano('${ORG_TROCA}'::uuid, 'max', null)::text;`,
    );
    const resultado = JSON.parse(linhas[0]!) as {
      antes: { plan_code: string; version: number };
      depois: { plan_code: string; version: number };
    };
    expect(resultado.antes).toEqual({ plan_code: "pro", version: 1 });
    expect(resultado.depois).toEqual({ plan_code: "max", version: 1 });
  });

  it("plano inexistente é recusado", () => {
    const erro = erroDe(`select public.fn_billing_trocar_plano('${ORG_TROCA}'::uuid, 'nao_existe', null);`);
    expect(erro).not.toBeNull();
    expect(erro).toContain("plano_nao_encontrado_ou_inativo");
  });

  it("plano inativo é recusado (desativa 'escale' numa transação desfeita)", () => {
    const erro = erroDe(`
      begin;
      update public.billing_plans set active = false where code = 'escale' and active;
      select public.fn_billing_trocar_plano('${ORG_TROCA}'::uuid, 'escale', null);
      rollback;
    `);
    expect(erro).not.toBeNull();
    expect(erro).toContain("plano_nao_encontrado_ou_inativo");
  });

  it("'escale' segue ativo depois do rollback, não vazou para outros casos", () => {
    expect(comoServico(`select 'SONDA|' || active from public.billing_plans where code = 'escale' and version = 1;`)).toEqual([
      "true",
    ]);
  });
});

describe("8. a semeadura rodada duas vezes não duplica nem sobrescreve preço alterado", () => {
  it("muda o preço do Pro, reaplica o INSERT ... ON CONFLICT DO NOTHING da migration, e o preço mudado fica", () => {
    // Trecho copiado literalmente do item 6 da migration 20260923020000_0904.
    const linhas = comoServico(`
      begin;
      update public.billing_plans set price_monthly_cents = 12345 where code = 'pro' and active;

      insert into public.billing_plans
        (code, version, active, name, for_sale, price_monthly_cents, price_yearly_cents, grace_days, limits)
      values
        ('ilimitado', 1, true, 'Ilimitado', false, 0, null, 7, jsonb_build_object(
          'funis', null, 'etapas_por_funil', null, 'leads', null, 'membros', null,
          'conexoes', null, 'integracoes_webhook', null, 'tokens_ia_mes', null
        )),
        ('pro', 1, true, 'Pro', false, 19900, null, 7, jsonb_build_object(
          'funis', 5, 'etapas_por_funil', 10, 'leads', 5000, 'membros', 3,
          'conexoes', 3, 'integracoes_webhook', 3, 'tokens_ia_mes', 3000000
        )),
        ('max', 1, true, 'Max', false, 39900, null, 7, jsonb_build_object(
          'funis', 10, 'etapas_por_funil', 15, 'leads', 50000, 'membros', 15,
          'conexoes', 10, 'integracoes_webhook', 10, 'tokens_ia_mes', 3000000
        )),
        ('escale', 1, true, 'Scale', false, 59900, null, 7, jsonb_build_object(
          'funis', 25, 'etapas_por_funil', 20, 'leads', 100000, 'membros', 30,
          'conexoes', 20, 'integracoes_webhook', 20, 'tokens_ia_mes', 3000000
        ))
      on conflict (code, version) do nothing;

      select 'SONDA|linhas=' || count(*) from public.billing_plans where code = 'pro';
      select 'SONDA|preco=' || price_monthly_cents from public.billing_plans where code = 'pro' and active;
      rollback;
    `);
    expect(linhas).toEqual(["linhas=1", "preco=12345"]);
  });
});
