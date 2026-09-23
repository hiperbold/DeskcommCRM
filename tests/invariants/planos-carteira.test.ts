import { spawn } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

/**
 * A CARTEIRA DE TOKENS DE IA, migration 0906 (fase F2-B, fork Hiperbold,
 * `hiperbold/planos/fase-F2-B-tarefas.md`, Tarefa 3).
 *
 * O banco (partes 1 a 4 da 0906) já está pronto; este arquivo só prova o que
 * a Tarefa 3 pede, na ordem do enunciado:
 *
 *  1. isolamento com dois usuários reais: gerente de A lê a carteira e o
 *     agregado de A e lê 0 de B; agente de A lê 0 da carteira de A;
 *  2. `authenticated` sem privilégio nenhum em billing_token_ledger,
 *     billing_token_adicionais e billing_token_avisos_emitidos;
 *  3. ninguém faz update, delete nem truncate no livro-caixa, nem o
 *     service_role;
 *  4. débito: ordem plano, adicional, avulso;
 *  5. o caso que atravessa o saldo (100 de saldo, 600 de consumo, uma linha
 *     de plano de -600);
 *  6. repetição não duplica (livro-caixa, carteira e agregado iguais);
 *  7. Ilimitado registra sem concessão;
 *  8 a 11. legacy_invocation_id, chamada anterior a carteira_desde,
 *     origem_da_chave nula e credencial_da_organizacao não debitam;
 *  12. ponderado zero (embedding, peso 0) não gera linha;
 *  13. concorrência real (duas sessões psql): duas inserções simultâneas na
 *      mesma organização não duplicam débito, e depois de
 *      fn_billing_debitos_pendentes + fn_billing_debitar_chamada as duas
 *      estão debitadas exatamente uma vez; a trava ocupada não atrasa o
 *      insert em llm_calls (molde do caso 15 de planos-trava-avisa.test.ts);
 *  14 a 16. idempotência de crédito, adicional e ajuste pela chave;
 *  17. ajuste que compensa linha de OUTRA organização recusado;
 *  18. ajuste sem nota recusado;
 *  19. saldo negativo não bloqueia nada (o insert em llm_calls passa);
 *  20. avisos de 50/80/100 um por ciclo;
 *  21. encerrar não recria;
 *  22. débito tardio de ciclo fechado não avisa;
 *  23 e 24. travas diárias por organização e por conversa;
 *  25 e 26. erro forçado dentro do débito e dentro do aviso (gatilho
 *      temporário que lança) não derrubam o insert em llm_calls;
 *  27. fn_billing_conferir_carteira corrige carteira adulterada;
 *  28. fn_billing_debitos_pendentes acha chamada sem débito e deixa de achar
 *      depois de debitada;
 *  29. exclusão da organização como service_role apaga em cascata
 *      livro-caixa, carteira, agregado, adicionais e avisos emitidos.
 *
 * Como `planos-trava-avisa.test.ts` (0905): fala com o Postgres por
 * `tests/invariants/psql-transporte.ts`, `authenticated` + JWT real
 * (`request.jwt.claims`) para os casos de RLS/leitura, e `postgres`
 * (superusuário do container) para os demais, que bypassa GRANT/REVOKE, mas
 * não as regras que as próprias funções aplicam (checks, exceptions,
 * advisory lock). Cada caso usa organização própria (namespace
 * `09060003-...`), para o ciclo, o teto e as travas globais de
 * `billing_settings` de um caso nunca contaminarem outro.
 *
 * `fn_billing_ajustar_limites` sobrepõe `tokens_ia_mes` do plano efetivo
 * independentemente do plano do contrato (confirmado lendo
 * `fn_billing_limites_efetivos`, 0904): não é preciso trocar de plano antes,
 * um `fn_billing_ajustar_limites(org, '{"tokens_ia_mes": N}', null, null)`
 * numa organização recém-criada (que nasce no Ilimitado) já basta para um
 * teto controlado e pequeno.
 *
 * O ponderado de cada chamada é controlado direto: `input_tokens = 0`,
 * `cache_read_tokens = 0`, `purpose = 'agent_turn'` (peso 100, fora do jsonb
 * de pesos por propósito) fazem `ponderado = output_tokens` exatamente
 * (fórmula da decisão 1, `fn_billing_tokens_ponderados`), sem precisar
 * calcular nada na mão em cada caso.
 */

const ORG_ISO_A = "09060003-0000-4000-8000-000000000001";
const ORG_ISO_B = "09060003-0000-4000-8000-000000000002";
const USER_ISO_A_MANAGER = "09060003-1111-4000-8000-000000000001";
const USER_ISO_A_AGENT = "09060003-1111-4000-8000-000000000002";
const USER_ISO_B_MANAGER = "09060003-1111-4000-8000-000000000003";

const ORG_PRIV = "09060003-0000-4000-8000-000000000003";
const USER_PRIV = "09060003-1111-4000-8000-000000000004";

const ORG_GRANTS = "09060003-0000-4000-8000-000000000004";

const ORG_ORDEM = "09060003-0000-4000-8000-000000000005";
const ORG_ATRAVESSA = "09060003-0000-4000-8000-000000000006";
const ORG_ILIMITADO = "09060003-0000-4000-8000-000000000007";
const ORG_LEGACY = "09060003-0000-4000-8000-000000000008";
const ORG_ANTES_CARTEIRA = "09060003-0000-4000-8000-000000000009";
const ORG_ORIGEM_NULA = "09060003-0000-4000-8000-00000000000a";
const ORG_ORIGEM_CREDENCIAL = "09060003-0000-4000-8000-00000000000b";
const ORG_PONDERADO_ZERO = "09060003-0000-4000-8000-00000000000c";
const ORG_CONCORRENCIA = "09060003-0000-4000-8000-00000000000d";
const ORG_CREDITO = "09060003-0000-4000-8000-00000000000e";
const ORG_ADICIONAL = "09060003-0000-4000-8000-00000000000f";
const ORG_AJUSTE = "09060003-0000-4000-8000-000000000010";
const ORG_AJUSTE_COMPENSA_A = "09060003-0000-4000-8000-000000000011";
const ORG_AJUSTE_COMPENSA_B = "09060003-0000-4000-8000-000000000012";
const ORG_AJUSTE_SEM_NOTA = "09060003-0000-4000-8000-000000000013";
const ORG_SALDO_NEGATIVO = "09060003-0000-4000-8000-000000000014";
const ORG_AVISOS = "09060003-0000-4000-8000-000000000015";
const ORG_CICLO_FECHADO = "09060003-0000-4000-8000-000000000016";
const ORG_TETO_ORG_DIA = "09060003-0000-4000-8000-000000000017";
const ORG_TETO_CONVERSA_DIA = "09060003-0000-4000-8000-000000000018";
const CONTACT_TETO_CONVERSA = "09060003-2222-4000-8000-000000000001";
const ORG_FALHA_DEBITO = "09060003-0000-4000-8000-000000000019";
const ORG_FALHA_AVISO = "09060003-0000-4000-8000-00000000001a";
const ORG_CONFERIR_CARTEIRA = "09060003-0000-4000-8000-00000000001b";
const ORG_DEBITOS_PENDENTES = "09060003-0000-4000-8000-00000000001c";
const ORG_DELETE_CASCATA = "09060003-0000-4000-8000-00000000001d";
const ORG_TRAVA_SO_CARTEIRA = "09060003-0000-4000-8000-00000000001e";

// Casos 30 a 34: correções da auditoria de segurança da fase F2-B (23/09/2026).
const ORG_A1_LLM_CALLS = "09060003-0000-4000-8000-00000000001f";
const USER_A1_VIEWER = "09060003-1111-4000-8000-000000000005";
const ORG_CONFERIR_SEM_LLM_CALLS = "09060003-0000-4000-8000-000000000020";
const ORG_M1_CREDITO_ENTRE_DEBITOS = "09060003-0000-4000-8000-000000000021";
const ORG_B1_ADICIONAL_OUTRA_ORG_A = "09060003-0000-4000-8000-000000000022";
const ORG_B1_ADICIONAL_OUTRA_ORG_B = "09060003-0000-4000-8000-000000000023";
const ORG_B2_AJUSTE_DUPLO = "09060003-0000-4000-8000-000000000024";

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
 * `planos-trava-avisa.test.ts` e `rls-isolation.test.ts`).
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

/**
 * Afirma que UM PAPEL QUALQUER (aqui, `service_role`) foi recusado por
 * privilégio ao rodar `comando`. `postgres` (superusuário da sessão) bypassa
 * GRANT/REVOKE, então o caso de "nem o service_role" precisa de `set role`.
 */
function esperaBarradoComoPapel(papel: string, comando: string, contexto: string): void {
  const erro = erroDe(`set role ${papel};\n${comando};`);
  expect(erro, `${contexto}: passou SEM erro sob "${papel}"`).not.toBeNull();
  expect(erro).toContain("permission denied");
}

/**
 * Como `sql` (`psql-transporte.ts`), mas ASSÍNCRONA e numa sessão psql
 * PRÓPRIA, para o caso de concorrência real, que precisa de DUAS conexões
 * vivas ao mesmo tempo. `sql()` é síncrona (`execFileSync`), então duas
 * chamadas dela nunca se sobrepõem; aqui, sem tocar em `psql-transporte.ts`
 * (fora do escopo desta tarefa), a mesma lógica de transporte (container ou
 * psql local) é reaberta como processo assíncrono. Cópia do mesmo helper de
 * `planos-trava-avisa.test.ts` (caso 15), duplicação registrada, não um
 * módulo compartilhado, pelo mesmo motivo de `psql-transporte.ts` existir: um
 * arquivo de `tests/invariants/**` não deve importar de outro para não
 * arrastar `describe`/`beforeAll` alheios.
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

function criarOrgSql(id: string, slug: string): string {
  return `insert into public.organizations (id, slug, legal_name, display_name)
    values ('${id}', '${slug}', '${slug} LTDA', '${slug}')
    on conflict (id) do nothing;`;
}

function ajustarTeto(org: string, tokensIaMes: number | null): string {
  const valor = tokensIaMes === null ? "null" : String(tokensIaMes);
  return `select public.fn_billing_ajustar_limites('${org}'::uuid, '{"tokens_ia_mes": ${valor}}'::jsonb, null, null);`;
}

/**
 * Uma chamada de IA com ponderado CONTROLADO: `input_tokens = 0`,
 * `cache_read_tokens = 0` fazem `ponderado = output_tokens` exatamente
 * (decisão 1: `ceil((max(0-0,0) + output + 0*peso/100) * peso_proposito/100)`,
 * e `peso_proposito` de `agent_turn` é 100, fora do jsonb de pesos). `model`
 * é único por chamada de propósito, para o caso que precisa reachar o `id`
 * depois (`select ... where model = '...'`).
 */
function sqlChamada(
  org: string,
  model: string,
  ponderado: number,
  opts: {
    purpose?: string;
    origemDaChave?: string | null;
    legacyInvocationId?: string;
    createdAtExpr?: string;
    contactId?: string;
  } = {},
): string {
  const purpose = opts.purpose ?? "agent_turn";
  const origem = opts.origemDaChave === undefined ? "'chave_da_instalacao'" : opts.origemDaChave === null ? "null" : `'${opts.origemDaChave}'`;
  const legacy = opts.legacyInvocationId ? `'${opts.legacyInvocationId}'` : "null";
  const createdAt = opts.createdAtExpr ?? "now()";
  const contact = opts.contactId ? `'${opts.contactId}'` : "null";
  return `insert into public.llm_calls
    (organization_id, contact_id, purpose, provider, model, input_tokens, output_tokens, cache_read_tokens, origem_da_chave, legacy_invocation_id, created_at)
    values ('${org}', ${contact}, '${purpose}', 'anthropic', '${model}', 0, ${ponderado}, 0, ${origem}, ${legacy}, ${createdAt});`;
}

/** Conta linhas de consumo (`chave like 'consumo:%'`) da organização no livro-caixa. */
function linhasDeConsumoDe(org: string): number {
  return Number(
    comoServico(
      `select 'SONDA|' || count(*) from public.billing_token_ledger where organization_id = '${org}' and chave like 'consumo:%';`,
    )[0],
  );
}

/** Avisos de carteira (limiar OU teto), abertos, prefixo fixo do título (decisão 14/15). */
function avisosTokenAbertosDe(org: string): number {
  return Number(
    comoServico(
      `select 'SONDA|' || count(*) from public.agent_inbox_items where organization_id = '${org}' and kind = 'other' and ref_kind = 'billing_limite' and title like 'Tokens de IA%' and status = 'open';`,
    )[0],
  );
}

/** Como acima, mas SEM filtrar status, para provar que encerrar não some da contagem total. */
function avisosTokenTotalDe(org: string): number {
  return Number(
    comoServico(
      `select 'SONDA|' || count(*) from public.agent_inbox_items where organization_id = '${org}' and kind = 'other' and ref_kind = 'billing_limite' and title like 'Tokens de IA%';`,
    )[0],
  );
}

describe("1. Isolamento: gerente lê a própria carteira e agregado, 0 de outra organização; agente da mesma organização lê 0 (decisão 19)", () => {
  beforeAll(() => {
    comoServico(`
      insert into auth.users (id, email) values
        ('${USER_ISO_A_MANAGER}', 'carteira-gerente-a@invariant.test'),
        ('${USER_ISO_A_AGENT}', 'carteira-agente-a@invariant.test'),
        ('${USER_ISO_B_MANAGER}', 'carteira-gerente-b@invariant.test')
      on conflict (id) do nothing;
      ${criarOrgSql(ORG_ISO_A, "carteira-iso-a")}
      ${criarOrgSql(ORG_ISO_B, "carteira-iso-b")}
      insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
        ('${USER_ISO_A_MANAGER}', '${ORG_ISO_A}', 'manager', now()),
        ('${USER_ISO_A_AGENT}', '${ORG_ISO_A}', 'agent', now()),
        ('${USER_ISO_B_MANAGER}', '${ORG_ISO_B}', 'manager', now())
      on conflict do nothing;
      ${ajustarTeto(ORG_ISO_A, 1000)}
      ${ajustarTeto(ORG_ISO_B, 1000)}
      ${sqlChamada(ORG_ISO_A, "iso-a", 50)}
      ${sqlChamada(ORG_ISO_B, "iso-b", 40)}
    `);
  });

  it("gerente de A lê a própria carteira (billing_token_wallets) e 0 linhas da carteira de B", () => {
    expect(
      membro(USER_ISO_A_MANAGER, `select 'SONDA|' || count(*) from public.billing_token_wallets where organization_id = '${ORG_ISO_A}';`),
    ).toEqual(["1"]);
    expect(
      membro(USER_ISO_A_MANAGER, `select 'SONDA|' || count(*) from public.billing_token_wallets where organization_id = '${ORG_ISO_B}';`),
    ).toEqual(["0"]);
  });

  it("gerente de A lê o próprio agregado (billing_token_consumo_diario) e 0 linhas do agregado de B", () => {
    expect(
      membro(USER_ISO_A_MANAGER, `select 'SONDA|' || count(*) from public.billing_token_consumo_diario where organization_id = '${ORG_ISO_A}';`),
    ).toEqual(["1"]);
    expect(
      membro(USER_ISO_A_MANAGER, `select 'SONDA|' || count(*) from public.billing_token_consumo_diario where organization_id = '${ORG_ISO_B}';`),
    ).toEqual(["0"]);
  });

  it("agente da PRÓPRIA organização A lê 0 da carteira e 0 do agregado (leitura exige gerente)", () => {
    expect(
      membro(USER_ISO_A_AGENT, `select 'SONDA|' || count(*) from public.billing_token_wallets where organization_id = '${ORG_ISO_A}';`),
    ).toEqual(["0"]);
    expect(
      membro(USER_ISO_A_AGENT, `select 'SONDA|' || count(*) from public.billing_token_consumo_diario where organization_id = '${ORG_ISO_A}';`),
    ).toEqual(["0"]);
  });
});

describe("2. `authenticated` tem privilégio NENHUM em livro-caixa, adicionais e avisos emitidos (decisão 19)", () => {
  const TABELAS_SERVER_ONLY = ["billing_token_ledger", "billing_token_adicionais", "billing_token_avisos_emitidos"] as const;

  beforeAll(() => {
    comoServico(`
      insert into auth.users (id, email) values ('${USER_PRIV}', 'carteira-priv@invariant.test')
        on conflict (id) do nothing;
      ${criarOrgSql(ORG_PRIV, "carteira-priv")}
    `);
  });

  function privilegiosDe(papel: string, tabela: string): string {
    return (
      comoServico(
        `select 'SONDA|' || coalesce(string_agg(distinct privilege_type, ',' order by privilege_type), 'NENHUM')
           from information_schema.role_table_grants
          where table_schema = 'public' and table_name = '${tabela}' and grantee = '${papel}';`,
      )[0] ?? ""
    );
  }

  it.each(TABELAS_SERVER_ONLY)("`authenticated` tem privilégio NENHUM em %s (catálogo)", (tabela) => {
    expect(privilegiosDe("authenticated", tabela)).toBe("NENHUM");
  });

  it.each(TABELAS_SERVER_ONLY)("`authenticated` é barrado por permission denied ao LER %s", (tabela) => {
    esperaBarrado(USER_PRIV, `select id from public.${tabela} limit 1`, `select em ${tabela}`);
  });

  it("`authenticated` é barrado ao inserir em billing_token_ledger", () => {
    esperaBarrado(
      USER_PRIV,
      `insert into public.billing_token_ledger (organization_id, fonte, tokens, chave) values ('${ORG_PRIV}', 'avulso', 1, 'forja:ledger')`,
      "insert em billing_token_ledger",
    );
  });

  it("`authenticated` é barrado ao inserir em billing_token_adicionais", () => {
    esperaBarrado(
      USER_PRIV,
      `insert into public.billing_token_adicionais (organization_id, tokens_por_ciclo) values ('${ORG_PRIV}', 1)`,
      "insert em billing_token_adicionais",
    );
  });

  it("`authenticated` é barrado ao inserir em billing_token_avisos_emitidos", () => {
    esperaBarrado(
      USER_PRIV,
      `insert into public.billing_token_avisos_emitidos (organization_id, chave) values ('${ORG_PRIV}', 'forja:aviso')`,
      "insert em billing_token_avisos_emitidos",
    );
  });
});

describe("3. Ninguém faz update, delete nem truncate no livro-caixa, nem o service_role (decisão 7)", () => {
  beforeAll(() => {
    comoServico(`
      ${criarOrgSql(ORG_GRANTS, "carteira-grants")}
      select public.fn_billing_creditar_tokens('${ORG_GRANTS}'::uuid, 10, '09060003-c0de-4000-8000-0000000000f0'::uuid, null, 'seed do caso 3', null);
    `);
  });

  it("`service_role` é barrado ao dar UPDATE no livro-caixa", () => {
    esperaBarradoComoPapel(
      "service_role",
      `update public.billing_token_ledger set tokens = 0 where organization_id = '${ORG_GRANTS}'`,
      "update em billing_token_ledger sob service_role",
    );
  });

  it("`service_role` é barrado ao dar DELETE no livro-caixa", () => {
    esperaBarradoComoPapel(
      "service_role",
      `delete from public.billing_token_ledger where organization_id = '${ORG_GRANTS}'`,
      "delete em billing_token_ledger sob service_role",
    );
  });

  it("`service_role` é barrado ao dar TRUNCATE no livro-caixa", () => {
    esperaBarradoComoPapel("service_role", `truncate public.billing_token_ledger`, "truncate em billing_token_ledger sob service_role");
  });

  it("a linha semeada continua intacta (nenhum dos três comandos acima passou de verdade)", () => {
    const linhas = comoServico(
      `select 'SONDA|' || tokens from public.billing_token_ledger where organization_id = '${ORG_GRANTS}' and chave = 'credito:09060003-c0de-4000-8000-0000000000f0';`,
    );
    expect(linhas).toEqual(["10"]);
  });
});

describe("4. Débito: ordem de consumo plano, adicional, avulso (decisão 6)", () => {
  const CHAVE_ADICIONAL = "09060003-c0de-4000-8000-000000000001";
  const CHAVE_CREDITO = "09060003-c0de-4000-8000-000000000002";

  beforeAll(() => {
    comoServico(`
      ${criarOrgSql(ORG_ORDEM, "carteira-ordem")}
      ${ajustarTeto(ORG_ORDEM, 100)}
      select public.fn_billing_contratar_adicional('${ORG_ORDEM}'::uuid, 50, '${CHAVE_ADICIONAL}'::uuid, null, 'adicional do caso 4', null);
      select public.fn_billing_creditar_tokens('${ORG_ORDEM}'::uuid, 30, '${CHAVE_CREDITO}'::uuid, null, 'avulso do caso 4', null);
      ${sqlChamada(ORG_ORDEM, "ordem-170", 170)}
    `);
  });

  it("o plano (saldo 100) é debitado primeiro, por inteiro: linha -100", () => {
    const linhas = comoServico(
      `select 'SONDA|' || tokens from public.billing_token_ledger where organization_id = '${ORG_ORDEM}' and fonte = 'plano' and chave like 'consumo:%';`,
    );
    expect(linhas).toEqual(["-100"]);
  });

  it("o adicional (saldo 50) é debitado em seguida, por inteiro: linha -50", () => {
    const linhas = comoServico(
      `select 'SONDA|' || tokens from public.billing_token_ledger where organization_id = '${ORG_ORDEM}' and fonte = 'adicional' and chave like 'consumo:%';`,
    );
    expect(linhas).toEqual(["-50"]);
  });

  it("o avulso (saldo 30) recebe só o resto (170 - 100 - 50 = 20): linha -20", () => {
    const linhas = comoServico(
      `select 'SONDA|' || tokens from public.billing_token_ledger where organization_id = '${ORG_ORDEM}' and fonte = 'avulso' and chave like 'consumo:%';`,
    );
    expect(linhas).toEqual(["-20"]);
  });

  it("as três carteiras batem: plano 100/100, adicional 50/50, avulso 20/30", () => {
    const linhas = comoServico(`
      select 'SONDA|' || fonte || ':' || creditado || ':' || consumido
        from public.billing_token_wallets where organization_id = '${ORG_ORDEM}' order by fonte;
    `);
    expect(linhas).toEqual(["adicional:50:50", "avulso:30:20", "plano:100:100"]);
  });
});

describe("5. O caso que atravessa o fim do saldo (100 de saldo, 600 de consumo, uma linha de plano de -600, decisão 6)", () => {
  let idChamada = "";

  beforeAll(() => {
    comoServico(`
      ${criarOrgSql(ORG_ATRAVESSA, "carteira-atravessa")}
      ${ajustarTeto(ORG_ATRAVESSA, 100)}
      ${sqlChamada(ORG_ATRAVESSA, "atravessa-600", 600)}
    `);
    idChamada =
      comoServico(
        `select 'SONDA|' || id from public.llm_calls where organization_id = '${ORG_ATRAVESSA}' and model = 'atravessa-600';`,
      )[0] ?? "";
  });

  it("nasce EXATAMENTE uma linha de consumo, de plano, com o total (-600, nunca -100 e -500 separadas)", () => {
    expect(linhasDeConsumoDe(ORG_ATRAVESSA)).toBe(1);
    const linhas = comoServico(
      `select 'SONDA|' || fonte || ':' || tokens from public.billing_token_ledger where organization_id = '${ORG_ATRAVESSA}' and chave like 'consumo:%';`,
    );
    expect(linhas).toEqual(["plano:-600"]);
  });

  it("a carteira de plano fica com creditado 100, consumido 600 (saldo -500, sem travar)", () => {
    const linhas = comoServico(
      `select 'SONDA|' || creditado || ':' || consumido from public.billing_token_wallets where organization_id = '${ORG_ATRAVESSA}' and fonte = 'plano';`,
    );
    expect(linhas).toEqual(["100:600"]);
  });

  describe("6. repetir o débito da MESMA chamada não duplica (livro-caixa, carteira e agregado iguais)", () => {
    it("chamar fn_billing_debitar_chamada de novo para o mesmo id devolve false (não debitou de novo)", () => {
      const linhas = comoServico(`select 'SONDA|' || public.fn_billing_debitar_chamada('${idChamada}'::uuid);`);
      expect(linhas).toEqual(["false"]);
    });

    it("o livro-caixa continua com uma linha só", () => {
      expect(linhasDeConsumoDe(ORG_ATRAVESSA)).toBe(1);
    });

    it("a carteira não mudou (creditado 100, consumido 600, ainda)", () => {
      const linhas = comoServico(
        `select 'SONDA|' || creditado || ':' || consumido from public.billing_token_wallets where organization_id = '${ORG_ATRAVESSA}' and fonte = 'plano';`,
      );
      expect(linhas).toEqual(["100:600"]);
    });

    it("o agregado do dia continua com 1 chamada (não conta a repetição)", () => {
      const linhas = comoServico(
        `select 'SONDA|' || chamadas from public.billing_token_consumo_diario where organization_id = '${ORG_ATRAVESSA}';`,
      );
      expect(linhas).toEqual(["1"]);
    });
  });
});

describe("7. Ilimitado registra sem concessão (decisão 9: sem teto, consumo cai direto em plano, sem saldo)", () => {
  it("chamada Ilimitado gera linha de consumo em plano, carteira com creditado 0 e consumido = ponderado", () => {
    comoServico(`
      ${criarOrgSql(ORG_ILIMITADO, "carteira-ilimitado")}
      ${sqlChamada(ORG_ILIMITADO, "ilimitado-777", 777)}
    `);
    expect(linhasDeConsumoDe(ORG_ILIMITADO)).toBe(1);
    const linhas = comoServico(
      `select 'SONDA|' || fonte || ':' || creditado || ':' || consumido from public.billing_token_wallets where organization_id = '${ORG_ILIMITADO}';`,
    );
    expect(linhas).toEqual(["plano:0:777"]);
  });
});

describe("8. legacy_invocation_id preenchido não debita (decisão 5, histórico copiado)", () => {
  it("nenhuma linha de consumo nasce para a chamada com legacy_invocation_id", () => {
    comoServico(`
      ${criarOrgSql(ORG_LEGACY, "carteira-legacy")}
      ${ajustarTeto(ORG_LEGACY, 1000)}
      ${sqlChamada(ORG_LEGACY, "legacy-100", 100, { legacyInvocationId: "09060003-1e6a-4000-8000-000000000001" })}
    `);
    expect(linhasDeConsumoDe(ORG_LEGACY)).toBe(0);
  });
});

describe("9. Chamada anterior a carteira_desde não debita (decisão 5)", () => {
  it("nenhuma linha de consumo nasce para a chamada criada antes da marca", () => {
    comoServico(`
      ${criarOrgSql(ORG_ANTES_CARTEIRA, "carteira-antes-marca")}
      ${ajustarTeto(ORG_ANTES_CARTEIRA, 1000)}
      insert into public.llm_calls
        (organization_id, purpose, provider, model, input_tokens, output_tokens, cache_read_tokens, origem_da_chave, created_at)
        values ('${ORG_ANTES_CARTEIRA}', 'agent_turn', 'anthropic', 'antes-marca-100', 0, 100, 0, 'chave_da_instalacao',
                (select carteira_desde - interval '1 hour' from public.billing_settings where id = 1));
    `);
    expect(linhasDeConsumoDe(ORG_ANTES_CARTEIRA)).toBe(0);
  });
});

describe("10. origem_da_chave NULA não debita (decisão 3/N17, ponto do código que não sabe a origem)", () => {
  it("nenhuma linha de consumo nasce quando origem_da_chave é nula", () => {
    comoServico(`
      ${criarOrgSql(ORG_ORIGEM_NULA, "carteira-origem-nula")}
      ${ajustarTeto(ORG_ORIGEM_NULA, 1000)}
      ${sqlChamada(ORG_ORIGEM_NULA, "origem-nula-100", 100, { origemDaChave: null })}
    `);
    expect(linhasDeConsumoDe(ORG_ORIGEM_NULA)).toBe(0);
  });
});

describe("11. origem_da_chave credencial_da_organizacao não debita (decisão 3/N17, BYOK)", () => {
  it("nenhuma linha de consumo nasce quando a organização paga com a própria chave", () => {
    comoServico(`
      ${criarOrgSql(ORG_ORIGEM_CREDENCIAL, "carteira-origem-org")}
      ${ajustarTeto(ORG_ORIGEM_CREDENCIAL, 1000)}
      ${sqlChamada(ORG_ORIGEM_CREDENCIAL, "origem-org-100", 100, { origemDaChave: "credencial_da_organizacao" })}
    `);
    expect(linhasDeConsumoDe(ORG_ORIGEM_CREDENCIAL)).toBe(0);
  });
});

describe("12. Ponderado zero (embedding, peso 0) não gera linha (decisão 1/2/N16)", () => {
  it("chamada de embedding_indexar, com tokens brutos altos, gera ponderado 0 e nenhuma linha", () => {
    comoServico(`
      ${criarOrgSql(ORG_PONDERADO_ZERO, "carteira-ponderado-zero")}
      ${ajustarTeto(ORG_PONDERADO_ZERO, 1000)}
      ${sqlChamada(ORG_PONDERADO_ZERO, "embedding-500", 500, { purpose: "embedding_indexar" })}
    `);
    expect(linhasDeConsumoDe(ORG_PONDERADO_ZERO)).toBe(0);
  });

  it("o agregado diário também não é tocado (v_entrou = false, decisão 13)", () => {
    const linhas = comoServico(
      `select 'SONDA|' || count(*) from public.billing_token_consumo_diario where organization_id = '${ORG_PONDERADO_ZERO}';`,
    );
    expect(linhas).toEqual(["0"]);
  });
});

describe("13. Concorrência real: duas sessões psql inserindo na MESMA organização ao mesmo tempo (molde do caso 15 de planos-trava-avisa)", () => {
  // Sessão A abre uma transação, insere uma chamada (o gatilho toma o
  // advisory lock da organização e debita por inteiro, ainda dentro da
  // transação) e SEGURA a transação aberta com pg_sleep antes do commit, o
  // lock só solta no commit. Sessão B, disparada logo depois, tenta inserir
  // outra chamada da MESMA organização: o gatilho DO 0906 (fn_billing_trg_
  // debitar_chamada) usa pg_try_advisory_xact_lock (decisão 11), então NÃO
  // espera, sai sem debitar (confirmado abaixo pelas asserções de
  // corretude). O sub-caso de TEMPO fica marcado como DEFEITO CONHECIDO, fora
  // do 0906: ver o comentário no `it` de baixo.
  let duracaoB = 0;
  let resultadoB: { ok: boolean; erro: string | null } = { ok: false, erro: null };

  beforeAll(async () => {
    comoServico(`
      ${criarOrgSql(ORG_CONCORRENCIA, "carteira-concorrencia")}
      ${ajustarTeto(ORG_CONCORRENCIA, 1000)}
    `);

    const sessaoA = `
      begin;
      ${sqlChamada(ORG_CONCORRENCIA, "concorrencia-a", 10)}
      select pg_sleep(2.5);
      commit;
    `;
    const sessaoB = `
      select pg_sleep(0.15);
      ${sqlChamada(ORG_CONCORRENCIA, "concorrencia-b", 15)}
    `;

    const inicioB = Date.now();
    const [, resB] = await Promise.all([
      sqlAsync(sessaoA),
      sqlAsync(sessaoB).then((r) => {
        duracaoB = Date.now() - inicioB;
        return r;
      }),
    ]);
    resultadoB = resB;

    // O "conferidor" (Tarefa 8): acha quem ficou pendente (a sessão B, cujo
    // gatilho desistiu sem debitar) e debita, uma organização por vez.
    comoServico(
      `select public.fn_billing_debitar_chamada(t.id) from public.fn_billing_debitos_pendentes('${ORG_CONCORRENCIA}'::uuid) as t(id);`,
    );
  });

  // Sem asserção de TEMPO aqui, de propósito. Medido com `pg_locks` numa
  // sessão paralela: B espera a TRANSAÇÃO de A (`wait_event = transactionid`)
  // por causa de um gatilho do autor anterior a esta fase, `trg_llm_calls_budget`
  // (0095), cujo upsert em `ai_budgets` é bloqueante por organização. Isso não
  // tem relação com a carteira e, em produção, cada insert em `llm_calls` é a
  // própria transação (milissegundos), então a espera real é curta. Registrado
  // como D-058. A promessa da decisão 11 (a trava da CARTEIRA não faz esperar)
  // é provada no caso 13b, que segura só o advisory lock da carteira.
  it("a sessão B termina sem erro (o insert em llm_calls nunca é recusado)", () => {
    expect(resultadoB.ok, resultadoB.erro ?? "").toBe(true);
    expect(duracaoB).toBeGreaterThan(0);
  });

  it("as duas chamadas da organização têm exatamente uma linha de consumo cada (nenhuma duplicou, nenhuma ficou sem debitar)", () => {
    expect(linhasDeConsumoDe(ORG_CONCORRENCIA)).toBe(2);
  });

  it("a carteira de plano soma exatamente os dois ponderados (10 + 15 = 25), sem duplicar nem perder nenhum", () => {
    const linhas = comoServico(
      `select 'SONDA|' || consumido from public.billing_token_wallets where organization_id = '${ORG_CONCORRENCIA}' and fonte = 'plano';`,
    );
    expect(linhas).toEqual(["25"]);
  });

  it("depois de debitada pelo conferidor, a chamada da sessão B não aparece mais em fn_billing_debitos_pendentes", () => {
    const linhas = comoServico(
      `select 'SONDA|' || count(*) from (select * from public.fn_billing_debitos_pendentes('${ORG_CONCORRENCIA}'::uuid)) t;`,
    );
    expect(linhas).toEqual(["0"]);
  });
});

describe("13b. A trava da carteira ocupada não faz o insert em llm_calls esperar (decisão 11)", () => {
  // Sessão A segura SÓ o advisory lock da carteira da organização (a mesma
  // chave que o débito usa), sem inserir nada em llm_calls, e dorme. Sessão B
  // insere uma chamada: o gatilho tenta a trava com pg_try_, não consegue,
  // desiste sem debitar e o insert termina na hora. Depois o conferidor
  // debita. É a prova direta da decisão 11, sem o gatilho do orçamento do
  // autor no meio (ver o comentário do caso 13).
  let duracaoB = 0;
  let resultadoB: { ok: boolean; erro: string | null } = { ok: false, erro: null };
  let consumoLogoDepois: string[] = [];

  beforeAll(async () => {
    comoServico(`
      ${criarOrgSql(ORG_TRAVA_SO_CARTEIRA, "carteira-trava-so-carteira")}
      ${ajustarTeto(ORG_TRAVA_SO_CARTEIRA, 1000)}
    `);

    const sessaoA = `
      begin;
      select pg_advisory_xact_lock(hashtextextended('billing_tokens:' || '${ORG_TRAVA_SO_CARTEIRA}', 0));
      select pg_sleep(2.5);
      commit;
    `;
    const sessaoB = `
      select pg_sleep(0.3);
      ${sqlChamada(ORG_TRAVA_SO_CARTEIRA, "trava-so-carteira-b", 20)}
    `;

    const inicioB = Date.now();
    const [, resB] = await Promise.all([
      sqlAsync(sessaoA),
      sqlAsync(sessaoB).then((r) => {
        duracaoB = Date.now() - inicioB;
        consumoLogoDepois = comoServico(
          `select 'SONDA|' || count(*) from public.billing_token_ledger where organization_id = '${ORG_TRAVA_SO_CARTEIRA}' and chave like 'consumo:%';`,
        );
        return r;
      }),
    ]);
    resultadoB = resB;

    comoServico(
      `select public.fn_billing_debitar_chamada(t.id) from public.fn_billing_debitos_pendentes('${ORG_TRAVA_SO_CARTEIRA}'::uuid) as t(id);`,
    );
  });

  it("o insert termina bem antes dos 2.5 s em que a trava da carteira fica ocupada", () => {
    expect(resultadoB.ok, resultadoB.erro ?? "").toBe(true);
    expect(duracaoB).toBeLessThan(1800);
  });

  it("com a trava ocupada, o gatilho não debitou (desistiu sem esperar)", () => {
    expect(consumoLogoDepois).toEqual(["0"]);
  });

  it("depois, o conferidor debita a chamada exatamente uma vez", () => {
    expect(linhasDeConsumoDe(ORG_TRAVA_SO_CARTEIRA)).toBe(1);
  });
});

describe("14. Idempotência de crédito pela chave (fn_billing_creditar_tokens, decisão 16)", () => {
  const CHAVE = "09060003-c0de-4000-8000-000000000003";

  beforeAll(() => {
    comoServico(criarOrgSql(ORG_CREDITO, "carteira-credito"));
  });

  it("a primeira chamada credita e devolve creditado=true", () => {
    const linhas = comoServico(
      `select 'SONDA|' || (public.fn_billing_creditar_tokens('${ORG_CREDITO}'::uuid, 1000, '${CHAVE}'::uuid, null, 'nota do caso 14', null) ->> 'creditado');`,
    );
    expect(linhas).toEqual(["true"]);
  });

  it("a segunda chamada com a MESMA chave devolve creditado=false e não credita de novo", () => {
    const linhas = comoServico(
      `select 'SONDA|' || (public.fn_billing_creditar_tokens('${ORG_CREDITO}'::uuid, 1000, '${CHAVE}'::uuid, null, 'nota do caso 14', null) ->> 'creditado');`,
    );
    expect(linhas).toEqual(["false"]);
  });

  it("o saldo avulso continua em 1000, não 2000", () => {
    const linhas = comoServico(
      `select 'SONDA|' || creditado from public.billing_token_wallets where organization_id = '${ORG_CREDITO}' and fonte = 'avulso';`,
    );
    expect(linhas).toEqual(["1000"]);
  });
});

describe("15. Idempotência de adicional pela chave (fn_billing_contratar_adicional, decisão 16)", () => {
  const CHAVE = "09060003-c0de-4000-8000-000000000004";

  beforeAll(() => {
    comoServico(criarOrgSql(ORG_ADICIONAL, "carteira-adicional"));
  });

  it("a primeira chamada contrata e devolve criado=true", () => {
    const linhas = comoServico(
      `select 'SONDA|' || (public.fn_billing_contratar_adicional('${ORG_ADICIONAL}'::uuid, 500, '${CHAVE}'::uuid, null, 'nota do caso 15', null) ->> 'criado');`,
    );
    expect(linhas).toEqual(["true"]);
  });

  it("a segunda chamada com a MESMA chave devolve criado=false e não duplica a linha", () => {
    const linhas = comoServico(
      `select 'SONDA|' || (public.fn_billing_contratar_adicional('${ORG_ADICIONAL}'::uuid, 500, '${CHAVE}'::uuid, null, 'nota do caso 15', null) ->> 'criado');`,
    );
    expect(linhas).toEqual(["false"]);
  });

  it("existe exatamente UMA linha em billing_token_adicionais para esta organização", () => {
    const linhas = comoServico(
      `select 'SONDA|' || count(*) from public.billing_token_adicionais where organization_id = '${ORG_ADICIONAL}';`,
    );
    expect(linhas).toEqual(["1"]);
  });
});

describe("16. Idempotência de ajuste pela chave (fn_billing_ajustar_tokens, decisão 16/plano da fase item 4)", () => {
  const CHAVE = "09060003-c0de-4000-8000-000000000005";

  beforeAll(() => {
    comoServico(criarOrgSql(ORG_AJUSTE, "carteira-ajuste"));
  });

  it("a primeira chamada ajusta e devolve ajustado=true", () => {
    const primeira = comoServico(
      `select 'SONDA|' || (public.fn_billing_ajustar_tokens('${ORG_AJUSTE}'::uuid, 'plano', -50, '${CHAVE}'::uuid, null, 'estorno do caso 16', null) ->> 'ajustado');`,
    );
    expect(primeira).toEqual(["true"]);
  });

  it("a segunda chamada com a MESMA chave devolve ajustado=false (não aplica de novo)", () => {
    const segunda = comoServico(
      `select 'SONDA|' || (public.fn_billing_ajustar_tokens('${ORG_AJUSTE}'::uuid, 'plano', -50, '${CHAVE}'::uuid, null, 'estorno do caso 16', null) ->> 'ajustado');`,
    );
    expect(segunda).toEqual(["false"]);
  });

  it("o saldo final é -50, não -100 (o reenvio não dobrou o ajuste)", () => {
    const saldo = comoServico(
      `select 'SONDA|' || creditado from public.billing_token_wallets
         where organization_id = '${ORG_AJUSTE}' and fonte = 'plano'
           and ciclo = public.fn_billing_ciclo_de(now());`,
    );
    expect(saldo).toEqual(["-50"]);
  });
});

describe("17. Ajuste que compensa linha de OUTRA organização é recusado (42501)", () => {
  it("fn_billing_ajustar_tokens com compensa_id de outra organização explode com ajuste_compensa_linha_invalida", () => {
    comoServico(`
      ${criarOrgSql(ORG_AJUSTE_COMPENSA_A, "carteira-compensa-a")}
      ${criarOrgSql(ORG_AJUSTE_COMPENSA_B, "carteira-compensa-b")}
      select public.fn_billing_creditar_tokens('${ORG_AJUSTE_COMPENSA_A}'::uuid, 100, '09060003-c0de-4000-8000-000000000007'::uuid, null, 'linha de A', null);
    `);
    const idDeA = comoServico(
      `select 'SONDA|' || id from public.billing_token_ledger where organization_id = '${ORG_AJUSTE_COMPENSA_A}' and chave = 'credito:09060003-c0de-4000-8000-000000000007';`,
    )[0];

    const erro = erroDe(`
      select public.fn_billing_ajustar_tokens('${ORG_AJUSTE_COMPENSA_B}'::uuid, 'avulso', 10, '09060003-c0de-4000-8000-000000000008'::uuid, '${idDeA}'::uuid, 'tenta compensar linha de A', null);
    `);
    expect(erro).not.toBeNull();
    expect(erro).toContain("ajuste_compensa_linha_invalida");
  });
});

describe("18. Ajuste sem nota é recusado (22023)", () => {
  beforeAll(() => {
    comoServico(criarOrgSql(ORG_AJUSTE_SEM_NOTA, "carteira-ajuste-sem-nota"));
  });

  it("nota NULA explode com ajuste_precisa_de_nota", () => {
    const erro = erroDe(
      `select public.fn_billing_ajustar_tokens('${ORG_AJUSTE_SEM_NOTA}'::uuid, 'plano', 10, '09060003-c0de-4000-8000-000000000009'::uuid, null, null, null);`,
    );
    expect(erro).not.toBeNull();
    expect(erro).toContain("ajuste_precisa_de_nota");
  });

  it("nota em branco (só espaço) também explode com ajuste_precisa_de_nota", () => {
    const erro = erroDe(
      `select public.fn_billing_ajustar_tokens('${ORG_AJUSTE_SEM_NOTA}'::uuid, 'plano', 10, '09060003-c0de-4000-8000-00000000000a'::uuid, null, '   ', null);`,
    );
    expect(erro).not.toBeNull();
    expect(erro).toContain("ajuste_precisa_de_nota");
  });
});

describe("19. Saldo negativo não bloqueia nada: o insert em llm_calls passa (decisão 15, nesta fase nada bloqueia)", () => {
  it("uma organização já bem negativa continua aceitando chamadas normalmente", () => {
    comoServico(`
      ${criarOrgSql(ORG_SALDO_NEGATIVO, "carteira-saldo-negativo")}
      ${ajustarTeto(ORG_SALDO_NEGATIVO, 10)}
      ${sqlChamada(ORG_SALDO_NEGATIVO, "saldo-negativo-1000", 1000)}
    `);
    const antes = comoServico(
      `select 'SONDA|' || consumido from public.billing_token_wallets where organization_id = '${ORG_SALDO_NEGATIVO}' and fonte = 'plano';`,
    );
    expect(antes).toEqual(["1000"]);

    const erro = erroDe(sqlChamada(ORG_SALDO_NEGATIVO, "saldo-negativo-mais-5", 5));
    expect(erro).toBeNull();

    const depois = comoServico(
      `select 'SONDA|' || consumido from public.billing_token_wallets where organization_id = '${ORG_SALDO_NEGATIVO}' and fonte = 'plano';`,
    );
    expect(depois).toEqual(["1005"]);
  });
});

describe("20. Avisos de 50/80/100% do total disponível no ciclo, um por limiar por ciclo (decisão 14)", () => {
  beforeAll(() => {
    comoServico(`
      ${criarOrgSql(ORG_AVISOS, "carteira-avisos")}
      ${ajustarTeto(ORG_AVISOS, 1000)}
    `);
  });

  it("400 de 1000 (40%): nenhum aviso", () => {
    comoServico(sqlChamada(ORG_AVISOS, "avisos-400", 400));
    expect(avisosTokenAbertosDe(ORG_AVISOS)).toBe(0);
  });

  it("mais 100 (total 500, 50%): nasce o aviso de 50%", () => {
    comoServico(sqlChamada(ORG_AVISOS, "avisos-500", 100));
    expect(avisosTokenAbertosDe(ORG_AVISOS)).toBe(1);
  });

  it("mais 100 (total 600, 60%, ainda abaixo de 80%): continua só 1 aviso", () => {
    comoServico(sqlChamada(ORG_AVISOS, "avisos-600", 100));
    expect(avisosTokenAbertosDe(ORG_AVISOS)).toBe(1);
  });

  it("mais 200 (total 800, 80%): nasce o segundo aviso (2 no total)", () => {
    comoServico(sqlChamada(ORG_AVISOS, "avisos-800", 200));
    expect(avisosTokenAbertosDe(ORG_AVISOS)).toBe(2);
  });

  it("mais 200 (total 1000, 100%): nasce o terceiro aviso, crítico (3 no total)", () => {
    comoServico(sqlChamada(ORG_AVISOS, "avisos-1000", 200));
    expect(avisosTokenAbertosDe(ORG_AVISOS)).toBe(3);
    const criticos = comoServico(
      `select 'SONDA|' || severity from public.agent_inbox_items where organization_id = '${ORG_AVISOS}' and title like 'Tokens de IA: 100%%%';`,
    );
    expect(criticos).toEqual(["critical"]);
  });

  it("mais consumo além de 100% NÃO gera um quarto aviso (dedup por limiar+ciclo, chave já usada)", () => {
    comoServico(sqlChamada(ORG_AVISOS, "avisos-1050", 50));
    expect(avisosTokenAbertosDe(ORG_AVISOS)).toBe(3);
  });

  describe("21. Encerrar o aviso não recria (dedup sobrevive ao encerramento, decisão 14)", () => {
    it("encerrar o aviso de 100% e continuar consumindo não recria um aviso de 100% novo", () => {
      comoServico(
        `update public.agent_inbox_items set status = 'resolved' where organization_id = '${ORG_AVISOS}' and title like 'Tokens de IA: 100%%%';`,
      );
      expect(avisosTokenAbertosDe(ORG_AVISOS)).toBe(2);
      expect(avisosTokenTotalDe(ORG_AVISOS)).toBe(3);

      comoServico(sqlChamada(ORG_AVISOS, "avisos-pos-encerrar", 100));
      expect(avisosTokenTotalDe(ORG_AVISOS), "total continua 3: nenhum aviso de 100% novo nasceu").toBe(3);
      expect(avisosTokenAbertosDe(ORG_AVISOS), "abertos continuam 2 (o de 100% segue resolvido)").toBe(2);
    });
  });
});

describe("22. Débito tardio de um ciclo já fechado não avisa (decisão 14, mesmo debitando)", () => {
  it("chamada de um mês fechado é debitada (ledger tem a linha) mas não gera aviso nenhum", () => {
    // billing_settings é linha única (id = 1): abaixa carteira_desde só
    // DENTRO da transação e desfaz com rollback, como o caso 5 (modo
    // desligado) de planos-trava-avisa.test.ts, nunca vaza para outro caso.
    const linhas = comoServico(`
      begin;
      ${criarOrgSql(ORG_CICLO_FECHADO, "carteira-ciclo-fechado")}
      ${ajustarTeto(ORG_CICLO_FECHADO, 100)}
      update public.billing_settings set carteira_desde = '2026-01-01T00:00:00-03:00' where id = 1;
      ${sqlChamada(ORG_CICLO_FECHADO, "ciclo-fechado-150", 150, { createdAtExpr: "'2026-08-15T12:00:00-03:00'" })}
      select 'SONDA|' || count(*) from public.agent_inbox_items where organization_id = '${ORG_CICLO_FECHADO}' and ref_kind = 'billing_limite';
      select 'SONDA|' || count(*) from public.billing_token_ledger where organization_id = '${ORG_CICLO_FECHADO}' and chave like 'consumo:%';
      rollback;
    `);
    expect(linhas, "[avisos, linhas de consumo]: debitou (o ciclo fechado nem concede, mas o consumo ainda entra) e mesmo assim 0 avisos").toEqual(["0", "1"]);
  });
});

describe("23. Trava diária por organização: teto ultrapassado no dia avisa (decisão 15/N14)", () => {
  it("50 no dia não avisa; mais 60 (110 > teto 100) avisa", () => {
    const linhas = comoServico(`
      begin;
      ${criarOrgSql(ORG_TETO_ORG_DIA, "carteira-teto-org-dia")}
      ${ajustarTeto(ORG_TETO_ORG_DIA, 100000)}
      update public.billing_settings set teto_org_tokens_dia = 100 where id = 1;
      ${sqlChamada(ORG_TETO_ORG_DIA, "teto-org-dia-50", 50)}
      select 'SONDA|' || count(*) from public.agent_inbox_items
        where organization_id = '${ORG_TETO_ORG_DIA}' and title like 'Tokens de IA: teto de segurança da organiza%';
      ${sqlChamada(ORG_TETO_ORG_DIA, "teto-org-dia-60", 60)}
      select 'SONDA|' || count(*) from public.agent_inbox_items
        where organization_id = '${ORG_TETO_ORG_DIA}' and title like 'Tokens de IA: teto de segurança da organiza%';
      rollback;
    `);
    expect(linhas, "[antes de passar do teto, depois de passar]").toEqual(["0", "1"]);
  });
});

describe("24. Trava diária por conversa: teto ultrapassado no dia, na MESMA conversa, avisa (decisão 15/N14)", () => {
  it("50 na conversa não avisa; mais 60 (110 > teto 100) avisa", () => {
    const linhas = comoServico(`
      begin;
      ${criarOrgSql(ORG_TETO_CONVERSA_DIA, "carteira-teto-conversa-dia")}
      insert into public.contacts (id, organization_id, name) values ('${CONTACT_TETO_CONVERSA}', '${ORG_TETO_CONVERSA_DIA}', 'Contato Teto Conversa');
      ${ajustarTeto(ORG_TETO_CONVERSA_DIA, 100000)}
      update public.billing_settings set teto_conversa_tokens_dia = 100 where id = 1;
      ${sqlChamada(ORG_TETO_CONVERSA_DIA, "teto-conversa-dia-50", 50, { contactId: CONTACT_TETO_CONVERSA })}
      select 'SONDA|' || count(*) from public.agent_inbox_items
        where organization_id = '${ORG_TETO_CONVERSA_DIA}' and title like 'Tokens de IA: teto de segurança de uma conversa%';
      ${sqlChamada(ORG_TETO_CONVERSA_DIA, "teto-conversa-dia-60", 60, { contactId: CONTACT_TETO_CONVERSA })}
      select 'SONDA|' || count(*) from public.agent_inbox_items
        where organization_id = '${ORG_TETO_CONVERSA_DIA}' and title like 'Tokens de IA: teto de segurança de uma conversa%';
      rollback;
    `);
    expect(linhas, "[antes de passar do teto, depois de passar]").toEqual(["0", "1"]);
  });
});

/**
 * Roda `corpo` dentro de uma transação em que TODO insert na tabela `alvo`
 * explode. DDL é transacional: o gatilho e a função nascem e morrem com a
 * transação, o `rollback` no fim desfaz tudo e não deixa rastro para os
 * outros casos. Mesmo molde de `dentroDeFalhaForcada` em
 * planos-trava-avisa.test.ts (achado 4), generalizado para a tabela-alvo:
 * aqui há DUAS falhas forçadas diferentes a provar (dentro do débito, dentro
 * do aviso), não uma só.
 */
function dentroDeFalhaForcadaEm(alvo: string, corpo: string): string[] {
  const sufixo = alvo.replace(/[^a-z_]/g, "");
  return comoServico(`
    begin;
    create or replace function public.fn_forca_falha_teste_${sufixo}() returns trigger
    language plpgsql as $BODY$
    begin
      raise exception 'falha_forcada_teste_${sufixo}';
    end;
    $BODY$;
    create trigger trg_forca_falha_teste_${sufixo}
      before insert on public.${alvo}
      for each row execute function public.fn_forca_falha_teste_${sufixo}();

    ${corpo}
    rollback;
  `);
}

describe("25. Erro forçado DENTRO do débito (gatilho que lança em billing_token_ledger) não derruba o insert em llm_calls", () => {
  it("a chamada sobrevive (existe em llm_calls), mas nenhuma linha de consumo entra (o débito falhou, capturado no gatilho de llm_calls)", () => {
    const linhas = dentroDeFalhaForcadaEm(
      "billing_token_ledger",
      `
        ${criarOrgSql(ORG_FALHA_DEBITO, "carteira-falha-debito")}
        ${ajustarTeto(ORG_FALHA_DEBITO, 1000)}
        ${sqlChamada(ORG_FALHA_DEBITO, "falha-debito-100", 100)}
        select 'SONDA|' || count(*) from public.llm_calls where organization_id = '${ORG_FALHA_DEBITO}' and model = 'falha-debito-100';
        select 'SONDA|' || count(*) from public.billing_token_ledger where organization_id = '${ORG_FALHA_DEBITO}' and chave like 'consumo:%';
      `,
    );
    expect(linhas, "[a chamada existe?, quantas linhas de consumo entraram]").toEqual(["1", "0"]);
  });
});

describe("26. Erro forçado DENTRO do aviso (gatilho que lança em agent_inbox_items) não derruba o insert nem o débito", () => {
  it("a chamada sobrevive, o débito ACONTECE de verdade (a carteira muda), mas nenhum aviso é gravado", () => {
    const linhas = dentroDeFalhaForcadaEm(
      "agent_inbox_items",
      `
        ${criarOrgSql(ORG_FALHA_AVISO, "carteira-falha-aviso")}
        ${ajustarTeto(ORG_FALHA_AVISO, 100)}
        ${sqlChamada(ORG_FALHA_AVISO, "falha-aviso-100", 100)}
        select 'SONDA|' || count(*) from public.llm_calls where organization_id = '${ORG_FALHA_AVISO}' and model = 'falha-aviso-100';
        select 'SONDA|' || count(*) from public.billing_token_ledger where organization_id = '${ORG_FALHA_AVISO}' and chave like 'consumo:%';
        select 'SONDA|' || consumido from public.billing_token_wallets where organization_id = '${ORG_FALHA_AVISO}' and fonte = 'plano';
        select 'SONDA|' || count(*) from public.agent_inbox_items where organization_id = '${ORG_FALHA_AVISO}' and ref_kind = 'billing_limite';
      `,
    );
    expect(linhas, "[chamada existe?, linhas de consumo, consumido na carteira, avisos gravados]").toEqual(["1", "1", "100", "0"]);
  });
});

describe("27. fn_billing_conferir_carteira corrige uma carteira adulterada (decisão 8)", () => {
  it("uma carteira com creditado e consumido errados é corrigida a partir do livro-caixa", () => {
    comoServico(`
      ${criarOrgSql(ORG_CONFERIR_CARTEIRA, "carteira-conferir")}
      ${ajustarTeto(ORG_CONFERIR_CARTEIRA, 500)}
      ${sqlChamada(ORG_CONFERIR_CARTEIRA, "conferir-200", 200)}
      update public.billing_token_wallets set creditado = 1, consumido = 999999
        where organization_id = '${ORG_CONFERIR_CARTEIRA}' and fonte = 'plano';
    `);

    const antes = comoServico(
      `select 'SONDA|' || creditado || ':' || consumido from public.billing_token_wallets where organization_id = '${ORG_CONFERIR_CARTEIRA}' and fonte = 'plano';`,
    );
    expect(antes).toEqual(["1:999999"]);

    const divergentes = comoServico(`select 'SONDA|' || public.fn_billing_conferir_carteira('${ORG_CONFERIR_CARTEIRA}'::uuid);`);
    expect(Number(divergentes[0])).toBeGreaterThanOrEqual(1);

    const depois = comoServico(
      `select 'SONDA|' || creditado || ':' || consumido from public.billing_token_wallets where organization_id = '${ORG_CONFERIR_CARTEIRA}' and fonte = 'plano';`,
    );
    expect(depois).toEqual(["500:200"]);
  });
});

describe("28. fn_billing_debitos_pendentes acha uma chamada sem débito e deixa de achar depois de debitada (decisão 12)", () => {
  it("chamada inserida com o gatilho desligado aparece como pendente; depois de debitada, some da lista", () => {
    comoServico(`
      ${criarOrgSql(ORG_DEBITOS_PENDENTES, "carteira-debitos-pendentes")}
      ${ajustarTeto(ORG_DEBITOS_PENDENTES, 1000)}
      alter table public.llm_calls disable trigger trg_billing_debitar_llm_call;
      ${sqlChamada(ORG_DEBITOS_PENDENTES, "pendente-50", 50)}
      alter table public.llm_calls enable trigger trg_billing_debitar_llm_call;
    `);

    const pendentesAntes = comoServico(
      `select 'SONDA|' || count(*) from (select * from public.fn_billing_debitos_pendentes('${ORG_DEBITOS_PENDENTES}'::uuid)) t;`,
    );
    expect(pendentesAntes).toEqual(["1"]);
    expect(linhasDeConsumoDe(ORG_DEBITOS_PENDENTES), "controle: ainda não debitou (o gatilho estava desligado)").toBe(0);

    comoServico(
      `select public.fn_billing_debitar_chamada(t.id) from public.fn_billing_debitos_pendentes('${ORG_DEBITOS_PENDENTES}'::uuid) as t(id);`,
    );

    expect(linhasDeConsumoDe(ORG_DEBITOS_PENDENTES), "debitada pelo conferidor").toBe(1);
    const pendentesDepois = comoServico(
      `select 'SONDA|' || count(*) from (select * from public.fn_billing_debitos_pendentes('${ORG_DEBITOS_PENDENTES}'::uuid)) t;`,
    );
    expect(pendentesDepois).toEqual(["0"]);
  });
});

describe("29. Exclusão da organização, como service_role, apaga em cascata livro-caixa, carteira, agregado, adicionais e avisos emitidos (decisão 7)", () => {
  beforeAll(() => {
    comoServico(`
      ${criarOrgSql(ORG_DELETE_CASCATA, "carteira-delete-cascata")}
      ${ajustarTeto(ORG_DELETE_CASCATA, 100)}
      select public.fn_billing_contratar_adicional('${ORG_DELETE_CASCATA}'::uuid, 50, '09060003-c0de-4000-8000-00000000000b'::uuid, null, 'adicional do caso 29', null);
      select public.fn_billing_creditar_tokens('${ORG_DELETE_CASCATA}'::uuid, 30, '09060003-c0de-4000-8000-00000000000c'::uuid, null, 'avulso do caso 29', null);
      ${sqlChamada(ORG_DELETE_CASCATA, "delete-cascata-100", 100)}
    `);
  });

  it("controle positivo: as cinco tabelas têm linha para esta organização antes de apagar", () => {
    const linhas = comoServico(`
      select 'SONDA|' || (select count(*) from public.billing_token_ledger where organization_id = '${ORG_DELETE_CASCATA}')
        || ':' || (select count(*) from public.billing_token_wallets where organization_id = '${ORG_DELETE_CASCATA}')
        || ':' || (select count(*) from public.billing_token_consumo_diario where organization_id = '${ORG_DELETE_CASCATA}')
        || ':' || (select count(*) from public.billing_token_adicionais where organization_id = '${ORG_DELETE_CASCATA}')
        || ':' || (select count(*) from public.billing_token_avisos_emitidos where organization_id = '${ORG_DELETE_CASCATA}');
    `);
    const [ledger, wallets, diario, adicionais, avisos] = (linhas[0] ?? "").split(":").map(Number);
    expect(ledger, "livro-caixa").toBeGreaterThan(0);
    expect(wallets, "carteira").toBeGreaterThan(0);
    expect(diario, "agregado").toBeGreaterThan(0);
    expect(adicionais, "adicionais").toBeGreaterThan(0);
    expect(avisos, "avisos emitidos").toBeGreaterThan(0);
  });

  it("apagar a organização COMO service_role não dá erro (a ação referencial roda como dono da tabela, decisão 7)", () => {
    const erro = erroDe(`set role service_role;\ndelete from public.organizations where id = '${ORG_DELETE_CASCATA}';`);
    expect(erro).toBeNull();
  });

  it("as cinco tabelas ficam com ZERO linhas da organização apagada", () => {
    const linhas = comoServico(`
      select 'SONDA|' || (select count(*) from public.billing_token_ledger where organization_id = '${ORG_DELETE_CASCATA}')
        || ':' || (select count(*) from public.billing_token_wallets where organization_id = '${ORG_DELETE_CASCATA}')
        || ':' || (select count(*) from public.billing_token_consumo_diario where organization_id = '${ORG_DELETE_CASCATA}')
        || ':' || (select count(*) from public.billing_token_adicionais where organization_id = '${ORG_DELETE_CASCATA}')
        || ':' || (select count(*) from public.billing_token_avisos_emitidos where organization_id = '${ORG_DELETE_CASCATA}');
    `);
    expect(linhas).toEqual(["0:0:0:0:0"]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Casos 30 a 34: correções da AUDITORIA DE SEGURANÇA da fase F2-B (23/09/2026).
// ───────────────────────────────────────────────────────────────────────────

describe("30. A1 (auditoria de segurança): viewer não escreve em llm_calls pela sessão, continua lendo; service_role continua debitando", () => {
  beforeAll(() => {
    comoServico(`
      insert into auth.users (id, email) values ('${USER_A1_VIEWER}', 'carteira-a1-viewer@invariant.test')
        on conflict (id) do nothing;
      ${criarOrgSql(ORG_A1_LLM_CALLS, "carteira-a1-llm-calls")}
      insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
        ('${USER_A1_VIEWER}', '${ORG_A1_LLM_CALLS}', 'viewer', now())
      on conflict do nothing;
      ${ajustarTeto(ORG_A1_LLM_CALLS, 1000)}
      ${sqlChamada(ORG_A1_LLM_CALLS, "a1-seed", 10)}
    `);
  });

  it("viewer lê a própria organização em llm_calls normalmente (RLS de leitura intacta)", () => {
    expect(
      membro(USER_A1_VIEWER, `select 'SONDA|' || count(*) from public.llm_calls where organization_id = '${ORG_A1_LLM_CALLS}';`),
    ).toEqual(["1"]);
  });

  it("viewer é barrado por permission denied ao inserir em llm_calls", () => {
    esperaBarrado(
      USER_A1_VIEWER,
      `insert into public.llm_calls (organization_id, purpose, provider, model, input_tokens, output_tokens, cache_read_tokens) values ('${ORG_A1_LLM_CALLS}', 'agent_turn', 'anthropic', 'a1-forja-insert', 0, 1, 0)`,
      "insert em llm_calls pela sessão",
    );
  });

  it("viewer é barrado por permission denied ao dar UPDATE em llm_calls", () => {
    esperaBarrado(
      USER_A1_VIEWER,
      `update public.llm_calls set model = 'a1-forjado' where organization_id = '${ORG_A1_LLM_CALLS}'`,
      "update em llm_calls pela sessão",
    );
  });

  it("viewer é barrado por permission denied ao dar DELETE em llm_calls", () => {
    esperaBarrado(
      USER_A1_VIEWER,
      `delete from public.llm_calls where organization_id = '${ORG_A1_LLM_CALLS}'`,
      "delete em llm_calls pela sessão",
    );
  });

  it("service_role continua inserindo em llm_calls, e o gatilho continua debitando", () => {
    const antes = linhasDeConsumoDe(ORG_A1_LLM_CALLS);
    comoServico(sqlChamada(ORG_A1_LLM_CALLS, "a1-service-depois", 20));
    expect(linhasDeConsumoDe(ORG_A1_LLM_CALLS)).toBe(antes + 1);
  });
});

describe("31. A1, item 2 (defesa em profundidade): fn_billing_conferir_carteira não depende de llm_calls (nenhum join)", () => {
  it("apagar a linha de llm_calls (como postgres) não muda o consumido recalculado", () => {
    comoServico(`
      ${criarOrgSql(ORG_CONFERIR_SEM_LLM_CALLS, "carteira-conferir-sem-llm-calls")}
      ${ajustarTeto(ORG_CONFERIR_SEM_LLM_CALLS, 500)}
      ${sqlChamada(ORG_CONFERIR_SEM_LLM_CALLS, "conferir-sem-llm-calls-150", 150)}
    `);

    const consumidoAntes = comoServico(
      `select 'SONDA|' || consumido from public.billing_token_wallets where organization_id = '${ORG_CONFERIR_SEM_LLM_CALLS}' and fonte = 'plano';`,
    );
    expect(consumidoAntes).toEqual(["150"]);

    comoServico(
      `delete from public.llm_calls where organization_id = '${ORG_CONFERIR_SEM_LLM_CALLS}' and model = 'conferir-sem-llm-calls-150';`,
    );

    const divergentes = comoServico(`select 'SONDA|' || public.fn_billing_conferir_carteira('${ORG_CONFERIR_SEM_LLM_CALLS}'::uuid);`);
    expect(divergentes, "a llm_call apagada não pode zerar o consumido recalculado").toEqual(["0"]);

    const consumidoDepois = comoServico(
      `select 'SONDA|' || consumido from public.billing_token_wallets where organization_id = '${ORG_CONFERIR_SEM_LLM_CALLS}' and fonte = 'plano';`,
    );
    expect(consumidoDepois).toEqual(["150"]);
  });
});

describe("32. M1 (auditoria de segurança): crédito avulso entre duas execuções do débito da MESMA chamada não duplica nem debita duas vezes", () => {
  it("reenviar fn_billing_debitar_chamada da MESMA chamada, depois de um crédito avulso mudar a divisão, devolve false e não grava linha nova", () => {
    comoServico(`
      ${criarOrgSql(ORG_M1_CREDITO_ENTRE_DEBITOS, "carteira-m1-credito-entre-debitos")}
      ${ajustarTeto(ORG_M1_CREDITO_ENTRE_DEBITOS, 100)}
      ${sqlChamada(ORG_M1_CREDITO_ENTRE_DEBITOS, "m1-atravessa-600", 600)}
    `);

    const idDaChamada = comoServico(
      `select 'SONDA|' || id from public.llm_calls where organization_id = '${ORG_M1_CREDITO_ENTRE_DEBITOS}' and model = 'm1-atravessa-600';`,
    )[0];

    // O gatilho já debitou (caso 5: o que passa do saldo cai todo em plano).
    expect(linhasDeConsumoDe(ORG_M1_CREDITO_ENTRE_DEBITOS)).toBe(1);
    const totalAntes = comoServico(
      `select 'SONDA|' || (-tokens) from public.billing_token_ledger where organization_id = '${ORG_M1_CREDITO_ENTRE_DEBITOS}' and chave like 'consumo:%';`,
    );
    expect(totalAntes).toEqual(["600"]);

    // Um crédito avulso chega DEPOIS do primeiro débito: muda o que a divisão
    // por fonte faria se recalculada do zero (o defeito do M1).
    comoServico(
      `select public.fn_billing_creditar_tokens('${ORG_M1_CREDITO_ENTRE_DEBITOS}'::uuid, 1000, '09060003-c0de-4000-8000-0000000000f1'::uuid, null, 'credito do caso 32', null);`,
    );

    // Reenvio manual do débito da MESMA chamada (o cenário do conferidor
    // reprocessando, ou um segundo disparo): a guarda M1 devolve false ANTES
    // de recalcular a divisão por fonte.
    const reenvio = comoServico(`select 'SONDA|' || public.fn_billing_debitar_chamada('${idDaChamada}'::uuid);`);
    expect(reenvio).toEqual(["false"]);

    // Continua com UMA única linha de consumo, total 600 (não uma segunda
    // linha de fonte avulso somando mais 600, que faria 30.000 virar 31.000
    // no cenário real medido).
    expect(linhasDeConsumoDe(ORG_M1_CREDITO_ENTRE_DEBITOS)).toBe(1);
    const totalDepois = comoServico(
      `select 'SONDA|' || (-tokens) from public.billing_token_ledger where organization_id = '${ORG_M1_CREDITO_ENTRE_DEBITOS}' and chave like 'consumo:%';`,
    );
    expect(totalDepois).toEqual(["600"]);
  });
});

describe("33. B1 (auditoria de segurança): reenvio de fn_billing_contratar_adicional com a MESMA chave de OUTRA organização é recusado (42501)", () => {
  it("a segunda organização não reaproveita o adicional da primeira", () => {
    const CHAVE = "09060003-c0de-4000-8000-0000000000f2";
    comoServico(`
      ${criarOrgSql(ORG_B1_ADICIONAL_OUTRA_ORG_A, "carteira-b1-adicional-a")}
      ${criarOrgSql(ORG_B1_ADICIONAL_OUTRA_ORG_B, "carteira-b1-adicional-b")}
      select public.fn_billing_contratar_adicional('${ORG_B1_ADICIONAL_OUTRA_ORG_A}'::uuid, 500, '${CHAVE}'::uuid, null, 'adicional de A', null);
    `);

    const erro = erroDe(
      `select public.fn_billing_contratar_adicional('${ORG_B1_ADICIONAL_OUTRA_ORG_B}'::uuid, 500, '${CHAVE}'::uuid, null, 'tenta reaproveitar de B', null);`,
    );
    expect(erro).not.toBeNull();
    expect(erro).toContain("adicional_de_outra_organizacao");

    const donoContinua = comoServico(
      `select 'SONDA|' || organization_id from public.billing_token_adicionais where id = '${CHAVE}';`,
    );
    expect(donoContinua).toEqual([ORG_B1_ADICIONAL_OUTRA_ORG_A]);
  });
});

describe("34. B2 (auditoria de segurança): a mesma linha compensada não pode ser estornada duas vezes por ajustes diferentes (22023)", () => {
  it("um segundo ajuste com p_chave NOVA, mesmo p_compensa, é recusado", () => {
    comoServico(`
      ${criarOrgSql(ORG_B2_AJUSTE_DUPLO, "carteira-b2-ajuste-duplo")}
      select public.fn_billing_creditar_tokens('${ORG_B2_AJUSTE_DUPLO}'::uuid, 100, '09060003-c0de-4000-8000-0000000000f3'::uuid, null, 'linha a compensar', null);
    `);
    const idDaLinha = comoServico(
      `select 'SONDA|' || id from public.billing_token_ledger where organization_id = '${ORG_B2_AJUSTE_DUPLO}' and chave = 'credito:09060003-c0de-4000-8000-0000000000f3';`,
    )[0];

    comoServico(
      `select public.fn_billing_ajustar_tokens('${ORG_B2_AJUSTE_DUPLO}'::uuid, 'avulso', -100, '09060003-c0de-4000-8000-0000000000f4'::uuid, '${idDaLinha}'::uuid, 'primeiro estorno', null);`,
    );

    const erro = erroDe(
      `select public.fn_billing_ajustar_tokens('${ORG_B2_AJUSTE_DUPLO}'::uuid, 'avulso', -100, '09060003-c0de-4000-8000-0000000000f5'::uuid, '${idDaLinha}'::uuid, 'segundo estorno da MESMA linha', null);`,
    );
    expect(erro).not.toBeNull();
    expect(erro).toContain("ajuste_compensa_ja_usado");
  });
});
