import { spawn } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

/**
 * OS GATILHOS QUE AVISAM, migration 0905 parte 2 (fase F2, fork Hiperbold,
 * `hiperbold/planos/fase-F2-tarefas.md`, Tarefa 3).
 *
 * Treze provas, na ordem do enunciado da Tarefa 3:
 *
 *  1. Pro com teto de funis = 1: o segundo funil avisa, o terceiro não duplica;
 *  2. desarquivar um funil acima do teto também avisa;
 *  3. religar uma integração de webhook desligada acima do teto avisa; criar
 *     desligada NÃO avisa;
 *  4. um INSERT só com várias etapas, passando do teto por funil, avisa (prova
 *     do VOLATILE: cada linha conta as etapas já commitadas ANTES dela no
 *     mesmo comando, não a foto do início);
 *  5. modo `desligado`: nenhum aviso;
 *  6. organização no Ilimitado: nenhum aviso;
 *  7. o contador materializado de leads fica coerente com
 *     `select count(*) ... where status = 'open'` depois de CADA passo
 *     (criar, ganhar por update direto de stage_id, criar de novo, perder em
 *     lote por `fn_mover_leads_em_lote`, reabrir em lote, apagar);
 *  8. apagar a organização inteira não erra, e a linha do contador some junto
 *     (cascade, sem a exclusão recriar a linha no meio do caminho);
 *  9. `fn_billing_conferir_contadores` corrige um contador adulterado e
 *     devolve 1; rodada de novo, já consistente, devolve 0;
 *  10. criar lead como membro comum, com `authenticated` e JWT real, continua
 *      funcionando (o gatilho `security definer` não quebra o insert da
 *      sessão do usuário);
 *  11. `fn_billing_uso`: convite vencido não conta, admin provisório não
 *      conta;
 *  12. `billing_usage_counters` isolado por RLS entre organizações;
 *  13. membro comum não escreve em `billing_usage_counters` nem executa
 *      `fn_billing_conferir_teto`, `fn_billing_conferir_contadores`,
 *      `fn_billing_uso` nem `fn_billing_pode_criar`.
 *
 * Mais duas, da Tarefa 4 (D-034, teto TÉCNICO de conexões MCP, não é item de
 * plano, por isso mora no mesmo arquivo, mas fora da lista acima):
 *
 *  14. a 10ª conexão MCP da organização passa, a 11ª é recusada com a
 *      mensagem fixa; outra organização já no teto não interfere;
 *  15. concorrência real (duas sessões psql separadas): a 10ª conexão fica
 *      presa numa transação aberta enquanto uma 11ª tenta inserir ao mesmo
 *      tempo, e só uma das duas grava.
 *
 * Como `planos-de-assinatura.test.ts` (fase F1), fala com o Postgres por
 * `tests/invariants/psql-transporte.ts` (não `gov-helpers.ts`, congelado) e usa
 * `authenticated` + `request.jwt.claims` para os casos que exigem RLS de
 * verdade (10, 12, 13); os demais são regra de negócio dos gatilhos
 * `security definer`, e rodam como `postgres` (superusuário do container:
 * bypassa GRANT/REVOKE, mas não as regras que os próprios gatilhos aplicam).
 *
 * Cada caso usa uma organização própria (namespace `09050001-...`), para o
 * teto e o modo de um caso nunca contaminar a contagem de outro.
 */

const ORG_FUNIS = "09050001-0000-4000-8000-000000000001";
const ORG_DESARQUIVAR = "09050001-0000-4000-8000-000000000002";
const ORG_WEBHOOK = "09050001-0000-4000-8000-000000000003";
const ORG_ETAPAS = "09050001-0000-4000-8000-000000000004";
const ORG_DESLIGADO = "09050001-0000-4000-8000-000000000005";
const ORG_ILIMITADO = "09050001-0000-4000-8000-000000000006";
const ORG_LEADS = "09050001-0000-4000-8000-000000000007";
const ORG_DELETE = "09050001-0000-4000-8000-000000000008";
const ORG_CONTADOR = "09050001-0000-4000-8000-000000000009";
const ORG_MEMBRO_INS = "09050001-0000-4000-8000-00000000000a";
const ORG_MEMBROS = "09050001-0000-4000-8000-00000000000b";
const ORG_ISO_A = "09050001-0000-4000-8000-00000000000c";
const ORG_ISO_B = "09050001-0000-4000-8000-00000000000d";
const ORG_RBAC = "09050001-0000-4000-8000-00000000000e";
const ORG_MCP_A = "09050001-0000-4000-8000-00000000000f";
const ORG_MCP_B = "09050001-0000-4000-8000-000000000010";
const ORG_MCP_CONCORRENCIA = "09050001-0000-4000-8000-000000000011";

const USER_MEMBRO_INS = "09050001-1111-4000-8000-00000000000a";
const USER_MEMBROS_REAL = "09050001-1111-4000-8000-00000000000b";
const USER_MEMBROS_PROV = "09050001-1111-4000-8000-00000000000c";
const USER_ISO_A = "09050001-1111-4000-8000-00000000000d";
const USER_RBAC = "09050001-1111-4000-8000-00000000000e";

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
 * `planos-de-assinatura.test.ts` e `rls-isolation.test.ts`).
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
 * Como `sql` (`psql-transporte.ts`), mas ASSÍNCRONA e numa sessão psql
 * PRÓPRIA, só para o caso 15 (concorrência real), que precisa de DUAS
 * conexões vivas ao mesmo tempo (uma presa numa transação aberta enquanto a
 * outra tenta inserir). `sql()` é síncrona (`execFileSync`), então duas
 * chamadas dela nunca se sobrepõem; aqui, sem tocar em `psql-transporte.ts`
 * (fora do escopo desta tarefa), a mesma lógica de transporte (container ou
 * psql local) é reaberta como processo assíncrono.
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

/** Conta os avisos de trava de plano ABERTOS da organização, sem olhar título. */
function avisosDe(org: string): number {
  const linhas = comoServico(
    `select 'SONDA|' || count(*) from public.agent_inbox_items where organization_id = '${org}' and kind = 'other' and ref_kind = 'billing_limite' and status = 'open';`,
  );
  return Number(linhas[0]);
}

describe("1. Pro com teto de funis = 2: o funil que passa do teto avisa, o seguinte não duplica", () => {
  // Teto 2, não 1: toda organização já NASCE com 1 funil ativo (o seed
  // "Pedidos" de trg_seed_default_pipeline_for_org, baseline.sql). Com teto 1
  // esse funil sozinho já preencheria o teto e o PRIMEIRO insert nosso já
  // quebraria (foi o defeito do primeiro rascunho deste teste, achado ao
  // rodar). Teto 2 dá margem para um funil nosso antes de estourar.
  beforeAll(() => {
    comoServico(`
      insert into public.organizations (id, slug, legal_name, display_name)
        values ('${ORG_FUNIS}', 'trava-funis', 'Trava Funis LTDA', 'Trava Funis')
        on conflict (id) do nothing;
      select public.fn_billing_trocar_plano('${ORG_FUNIS}'::uuid, 'pro', null);
      select public.fn_billing_ajustar_limites('${ORG_FUNIS}'::uuid, '{"funis": 2}'::jsonb, null, null);
    `);
  });

  it("o funil A (1 seedado + este = 2, no teto mas não acima) não avisa", () => {
    comoServico(
      `insert into public.crm_pipelines (organization_id, name, slug) values ('${ORG_FUNIS}', 'Funil A', 'funil-a');`,
    );
    expect(avisosDe(ORG_FUNIS)).toBe(0);
  });

  it("o funil B (3 > 2) nasce UM aviso", () => {
    comoServico(
      `insert into public.crm_pipelines (organization_id, name, slug) values ('${ORG_FUNIS}', 'Funil B', 'funil-b');`,
    );
    expect(avisosDe(ORG_FUNIS)).toBe(1);
  });

  it("o funil C não duplica o aviso (dedup por organização + ref_kind + título, enquanto aberto)", () => {
    comoServico(
      `insert into public.crm_pipelines (organization_id, name, slug) values ('${ORG_FUNIS}', 'Funil C', 'funil-c');`,
    );
    expect(avisosDe(ORG_FUNIS)).toBe(1);
  });
});

describe("2. Desarquivar um funil acima do teto também avisa", () => {
  // Teto 1: a organização já nasce com 1 funil ativo (o seed "Pedidos"), que
  // sozinho preenche o teto sem precisar de nenhum funil manual "ativo"
  // extra (diferente do caso 1, que soma acima do seed).
  beforeAll(() => {
    comoServico(`
      insert into public.organizations (id, slug, legal_name, display_name)
        values ('${ORG_DESARQUIVAR}', 'trava-desarquivar', 'Trava Desarquivar LTDA', 'Trava Desarquivar')
        on conflict (id) do nothing;
      select public.fn_billing_trocar_plano('${ORG_DESARQUIVAR}'::uuid, 'pro', null);
      select public.fn_billing_ajustar_limites('${ORG_DESARQUIVAR}'::uuid, '{"funis": 1}'::jsonb, null, null);
      -- o único funil deste caso NASCE arquivado: o gatilho de insert só olha
      -- is_archived = false, então este insert não dispara conferência
      -- nenhuma (o funil "Pedidos" seedado é quem preenche o teto sozinho).
      insert into public.crm_pipelines (organization_id, name, slug, is_archived)
        values ('${ORG_DESARQUIVAR}', 'Funil Arquivado', 'funil-arquivado', true);
    `);
  });

  it("nasceu sem aviso (o funil deste caso nasceu arquivado)", () => {
    expect(avisosDe(ORG_DESARQUIVAR)).toBe(0);
  });

  it("desarquivar o funil acima do teto (o seed já ocupava a vaga) avisa", () => {
    comoServico(
      `update public.crm_pipelines set is_archived = false where organization_id = '${ORG_DESARQUIVAR}' and slug = 'funil-arquivado';`,
    );
    expect(avisosDe(ORG_DESARQUIVAR)).toBe(1);
  });
});

describe("3. Webhook: criar desligada NÃO avisa; religar acima do teto avisa", () => {
  beforeAll(() => {
    comoServico(`
      insert into public.organizations (id, slug, legal_name, display_name)
        values ('${ORG_WEBHOOK}', 'trava-webhook', 'Trava Webhook LTDA', 'Trava Webhook')
        on conflict (id) do nothing;
      select public.fn_billing_trocar_plano('${ORG_WEBHOOK}'::uuid, 'pro', null);
      select public.fn_billing_ajustar_limites('${ORG_WEBHOOK}'::uuid, '{"integracoes_webhook": 1}'::jsonb, null, null);
      insert into public.crm_pipelines (organization_id, name, slug)
        values ('${ORG_WEBHOOK}', 'Funil Webhook', 'funil-webhook');
      insert into public.crm_stages (organization_id, pipeline_id, name, slug, position)
        values ('${ORG_WEBHOOK}',
                (select id from public.crm_pipelines where organization_id = '${ORG_WEBHOOK}' and slug = 'funil-webhook'),
                'Etapa Webhook', 'etapa-webhook', 1000);
      -- primeira integração, ativa, sozinha preenche o teto (0 < 1, não avisa).
      insert into public.webhook_sources (organization_id, name, path_token, default_pipeline_id, default_stage_id)
        values ('${ORG_WEBHOOK}', 'Webhook 1', 'trava-webhook-1',
                (select id from public.crm_pipelines where organization_id = '${ORG_WEBHOOK}' and slug = 'funil-webhook'),
                (select id from public.crm_stages where organization_id = '${ORG_WEBHOOK}' and slug = 'etapa-webhook'));
    `);
  });

  it("criar a segunda integração já DESLIGADA não avisa", () => {
    comoServico(`
      insert into public.webhook_sources (organization_id, name, path_token, default_pipeline_id, default_stage_id, is_active)
        values ('${ORG_WEBHOOK}', 'Webhook 2', 'trava-webhook-2',
                (select id from public.crm_pipelines where organization_id = '${ORG_WEBHOOK}' and slug = 'funil-webhook'),
                (select id from public.crm_stages where organization_id = '${ORG_WEBHOOK}' and slug = 'etapa-webhook'),
                false);
    `);
    expect(avisosDe(ORG_WEBHOOK)).toBe(0);
  });

  it("religar a segunda integração acima do teto avisa", () => {
    comoServico(
      `update public.webhook_sources set is_active = true where organization_id = '${ORG_WEBHOOK}' and path_token = 'trava-webhook-2';`,
    );
    expect(avisosDe(ORG_WEBHOOK)).toBe(1);
  });
});

describe("4. Um INSERT só com várias etapas, passando do teto por funil, avisa (prova do VOLATILE)", () => {
  beforeAll(() => {
    comoServico(`
      insert into public.organizations (id, slug, legal_name, display_name)
        values ('${ORG_ETAPAS}', 'trava-etapas', 'Trava Etapas LTDA', 'Trava Etapas')
        on conflict (id) do nothing;
      select public.fn_billing_trocar_plano('${ORG_ETAPAS}'::uuid, 'pro', null);
      select public.fn_billing_ajustar_limites('${ORG_ETAPAS}'::uuid, '{"etapas_por_funil": 2}'::jsonb, null, null);
      insert into public.crm_pipelines (organization_id, name, slug)
        values ('${ORG_ETAPAS}', 'Funil Etapas', 'funil-etapas');
    `);
  });

  it("um INSERT só com 3 etapas (teto 2) avisa uma vez, na terceira etapa", () => {
    // Se fn_billing_pode_criar enxergasse a foto do INÍCIO do comando (como
    // uma função STABLE enxergaria), as três linhas contariam zero etapas
    // preexistentes e nenhuma avisaria. VOLATILE (decisão 9) faz a terceira
    // linha contar as duas já commitadas pelas linhas anteriores DO MESMO
    // comando.
    comoServico(`
      insert into public.crm_stages (organization_id, pipeline_id, name, slug, position) values
        ('${ORG_ETAPAS}', (select id from public.crm_pipelines where organization_id = '${ORG_ETAPAS}' and slug = 'funil-etapas'), 'Etapa 1', 'etapa-1', 1000),
        ('${ORG_ETAPAS}', (select id from public.crm_pipelines where organization_id = '${ORG_ETAPAS}' and slug = 'funil-etapas'), 'Etapa 2', 'etapa-2', 2000),
        ('${ORG_ETAPAS}', (select id from public.crm_pipelines where organization_id = '${ORG_ETAPAS}' and slug = 'funil-etapas'), 'Etapa 3', 'etapa-3', 3000);
    `);
    expect(avisosDe(ORG_ETAPAS)).toBe(1);
  });
});

describe("5. Modo desligado: nenhum aviso", () => {
  // Teto 1: como no caso 2, o funil "Pedidos" seedado na criação da
  // organização já preenche o teto sozinho, sem precisar de nenhum funil
  // manual extra fora da transação (o que criaria um aviso REAL, fora do
  // rollback, e contaminaria a asserção "nenhum aviso").
  beforeAll(() => {
    comoServico(`
      insert into public.organizations (id, slug, legal_name, display_name)
        values ('${ORG_DESLIGADO}', 'trava-desligado', 'Trava Desligado LTDA', 'Trava Desligado')
        on conflict (id) do nothing;
      select public.fn_billing_trocar_plano('${ORG_DESLIGADO}'::uuid, 'pro', null);
      select public.fn_billing_ajustar_limites('${ORG_DESLIGADO}'::uuid, '{"funis": 1}'::jsonb, null, null);
    `);
  });

  it("com modo desligado, criar mais um funil (acima do teto, o seed já ocupava a vaga) não avisa", () => {
    // Transação DESFEITA (rollback), como no caso 2 de planos-de-assinatura:
    // billing_settings é linha única, e o modo volta a 'avisar' para não
    // vazar para os outros casos deste arquivo.
    const linhas = comoServico(`
      begin;
      update public.billing_settings set modo = 'desligado' where id = 1;
      insert into public.crm_pipelines (organization_id, name, slug)
        values ('${ORG_DESLIGADO}', 'Funil Extra', 'funil-extra');
      select 'SONDA|' || count(*) from public.agent_inbox_items
        where organization_id = '${ORG_DESLIGADO}' and ref_kind = 'billing_limite' and status = 'open';
      rollback;
    `);
    expect(linhas).toEqual(["0"]);
  });

  it("o modo volta a 'avisar' depois do rollback, não vazou para os outros casos", () => {
    const linhas = comoServico(`select 'SONDA|' || modo from public.billing_settings where id = 1;`);
    expect(linhas).toEqual(["avisar"]);
  });
});

describe("6. Organização no Ilimitado: nenhum aviso", () => {
  it("criar vários funis sem teto não avisa", () => {
    comoServico(`
      insert into public.organizations (id, slug, legal_name, display_name)
        values ('${ORG_ILIMITADO}', 'trava-ilimitado', 'Trava Ilimitado LTDA', 'Trava Ilimitado')
        on conflict (id) do nothing;
      insert into public.crm_pipelines (organization_id, name, slug) values ('${ORG_ILIMITADO}', 'Funil 1', 'funil-1');
      insert into public.crm_pipelines (organization_id, name, slug) values ('${ORG_ILIMITADO}', 'Funil 2', 'funil-2');
      insert into public.crm_pipelines (organization_id, name, slug) values ('${ORG_ILIMITADO}', 'Funil 3', 'funil-3');
    `);
    expect(avisosDe(ORG_ILIMITADO)).toBe(0);
  });
});

describe("7. O contador de leads fica coerente com o count(*) real depois de CADA passo", () => {
  beforeAll(() => {
    comoServico(`
      insert into public.organizations (id, slug, legal_name, display_name)
        values ('${ORG_LEADS}', 'trava-leads', 'Trava Leads LTDA', 'Trava Leads')
        on conflict (id) do nothing;
      insert into public.crm_pipelines (organization_id, name, slug)
        values ('${ORG_LEADS}', 'Funil Leads', 'funil-leads');
      insert into public.crm_stages (organization_id, pipeline_id, name, slug, position, is_won, is_lost) values
        ('${ORG_LEADS}', (select id from public.crm_pipelines where organization_id = '${ORG_LEADS}' and slug = 'funil-leads'), 'Comum', 'comum', 1000, false, false),
        ('${ORG_LEADS}', (select id from public.crm_pipelines where organization_id = '${ORG_LEADS}' and slug = 'funil-leads'), 'Ganho', 'ganho', 2000, true, false),
        ('${ORG_LEADS}', (select id from public.crm_pipelines where organization_id = '${ORG_LEADS}' and slug = 'funil-leads'), 'Perda', 'perda', 3000, false, true);
    `);
  });

  /** Roda a ação, lê o contador materializado e a contagem real, e exige que os três batam. */
  function coerente(titulo: string, acao: string, esperado: number): void {
    it(titulo, () => {
      const linhas = comoServico(`
        ${acao}
        select 'SONDA|' || coalesce((select valor from public.billing_usage_counters where organization_id = '${ORG_LEADS}' and item = 'leads'), -1);
        select 'SONDA|' || (select count(*) from public.crm_leads where organization_id = '${ORG_LEADS}' and status = 'open');
      `);
      const [contador, real] = linhas.map(Number);
      expect(contador, "contador materializado").toBe(esperado);
      expect(real, "count(*) real").toBe(esperado);
    });
  }

  coerente(
    "cria o lead 1 aberto: contador sobe para 1",
    `insert into public.crm_leads (organization_id, pipeline_id, stage_id, title)
       values ('${ORG_LEADS}', (select id from public.crm_pipelines where organization_id = '${ORG_LEADS}' and slug = 'funil-leads'),
               (select id from public.crm_stages where organization_id = '${ORG_LEADS}' and slug = 'comum'), 'Lead 1');`,
    1,
  );

  coerente(
    "move o lead 1 para a etapa de GANHO só por update direto de stage_id: contador desce para 0",
    `update public.crm_leads set stage_id = (select id from public.crm_stages where organization_id = '${ORG_LEADS}' and slug = 'ganho')
       where organization_id = '${ORG_LEADS}' and title = 'Lead 1';`,
    0,
  );

  coerente(
    "cria o lead 2 aberto: contador sobe para 1",
    `insert into public.crm_leads (organization_id, pipeline_id, stage_id, title)
       values ('${ORG_LEADS}', (select id from public.crm_pipelines where organization_id = '${ORG_LEADS}' and slug = 'funil-leads'),
               (select id from public.crm_stages where organization_id = '${ORG_LEADS}' and slug = 'comum'), 'Lead 2');`,
    1,
  );

  coerente(
    "move o lead 2 em lote (fn_mover_leads_em_lote) para a etapa de PERDA: contador desce para 0",
    `select public.fn_mover_leads_em_lote('${ORG_LEADS}'::uuid,
        (select array_agg(id) from public.crm_leads where organization_id = '${ORG_LEADS}' and title = 'Lead 2'),
        (select id from public.crm_stages where organization_id = '${ORG_LEADS}' and slug = 'perda'),
        'other');`,
    0,
  );

  coerente(
    "volta o lead 2 em lote para a etapa comum: contador sobe para 1",
    `select public.fn_mover_leads_em_lote('${ORG_LEADS}'::uuid,
        (select array_agg(id) from public.crm_leads where organization_id = '${ORG_LEADS}' and title = 'Lead 2'),
        (select id from public.crm_stages where organization_id = '${ORG_LEADS}' and slug = 'comum'));`,
    1,
  );

  coerente(
    "apaga o lead 2: contador desce para 0",
    `delete from public.crm_leads where organization_id = '${ORG_LEADS}' and title = 'Lead 2';`,
    0,
  );
});

describe("8. Apagar a organização inteira não dá erro, e a linha do contador some junto", () => {
  beforeAll(() => {
    comoServico(`
      insert into public.organizations (id, slug, legal_name, display_name)
        values ('${ORG_DELETE}', 'trava-delete', 'Trava Delete LTDA', 'Trava Delete')
        on conflict (id) do nothing;
      insert into public.crm_pipelines (organization_id, name, slug)
        values ('${ORG_DELETE}', 'Funil Delete', 'funil-delete');
      insert into public.crm_stages (organization_id, pipeline_id, name, slug, position)
        values ('${ORG_DELETE}', (select id from public.crm_pipelines where organization_id = '${ORG_DELETE}' and slug = 'funil-delete'), 'Comum', 'comum', 1000);
      insert into public.crm_leads (organization_id, pipeline_id, stage_id, title)
        values ('${ORG_DELETE}', (select id from public.crm_pipelines where organization_id = '${ORG_DELETE}' and slug = 'funil-delete'),
                (select id from public.crm_stages where organization_id = '${ORG_DELETE}' and slug = 'comum'), 'Lead Delete');
    `);
  });

  it("a linha do contador nasceu (controle positivo, antes de apagar)", () => {
    const linhas = comoServico(
      `select 'SONDA|' || count(*) from public.billing_usage_counters where organization_id = '${ORG_DELETE}' and item = 'leads';`,
    );
    expect(linhas).toEqual(["1"]);
  });

  it("apagar a organização não dá erro", () => {
    const erro = erroDe(`delete from public.organizations where id = '${ORG_DELETE}';`);
    expect(erro).toBeNull();
  });

  it("a linha do contador some junto (on delete cascade, sem recriar no meio do caminho)", () => {
    const linhas = comoServico(
      `select 'SONDA|' || count(*) from public.billing_usage_counters where organization_id = '${ORG_DELETE}' and item = 'leads';`,
    );
    expect(linhas).toEqual(["0"]);
  });
});

describe("9. fn_billing_conferir_contadores corrige um contador adulterado e devolve 1; de novo, devolve 0", () => {
  beforeAll(() => {
    comoServico(`
      insert into public.organizations (id, slug, legal_name, display_name)
        values ('${ORG_CONTADOR}', 'trava-contador', 'Trava Contador LTDA', 'Trava Contador')
        on conflict (id) do nothing;
      insert into public.crm_pipelines (organization_id, name, slug)
        values ('${ORG_CONTADOR}', 'Funil Contador', 'funil-contador');
      insert into public.crm_stages (organization_id, pipeline_id, name, slug, position)
        values ('${ORG_CONTADOR}', (select id from public.crm_pipelines where organization_id = '${ORG_CONTADOR}' and slug = 'funil-contador'), 'Comum', 'comum', 1000);
      insert into public.crm_leads (organization_id, pipeline_id, stage_id, title)
        values ('${ORG_CONTADOR}', (select id from public.crm_pipelines where organization_id = '${ORG_CONTADOR}' and slug = 'funil-contador'),
                (select id from public.crm_stages where organization_id = '${ORG_CONTADOR}' and slug = 'comum'), 'Lead Contador');
      -- adultera o contador na marra, como um bug ou uma escrita concorrente perdida faria.
      update public.billing_usage_counters set valor = 999 where organization_id = '${ORG_CONTADOR}' and item = 'leads';
    `);
  });

  it("o contador está adulterado (999) antes de conferir", () => {
    const linhas = comoServico(
      `select 'SONDA|' || valor from public.billing_usage_counters where organization_id = '${ORG_CONTADOR}' and item = 'leads';`,
    );
    expect(linhas).toEqual(["999"]);
  });

  it("a primeira rodada corrige e devolve 1", () => {
    const linhas = comoServico(`select 'SONDA|' || public.fn_billing_conferir_contadores();`);
    expect(linhas).toEqual(["1"]);
  });

  it("o valor foi corrigido para o real (1 lead aberto)", () => {
    const linhas = comoServico(
      `select 'SONDA|' || valor from public.billing_usage_counters where organization_id = '${ORG_CONTADOR}' and item = 'leads';`,
    );
    expect(linhas).toEqual(["1"]);
  });

  it("a segunda rodada, já consistente, devolve 0", () => {
    const linhas = comoServico(`select 'SONDA|' || public.fn_billing_conferir_contadores();`);
    expect(linhas).toEqual(["0"]);
  });
});

describe("10. Criar lead como membro comum, com authenticated e JWT real, continua funcionando", () => {
  beforeAll(() => {
    comoServico(`
      insert into auth.users (id, email) values ('${USER_MEMBRO_INS}', 'trava-membro-ins@invariant.test')
        on conflict (id) do nothing;
      insert into public.organizations (id, slug, legal_name, display_name)
        values ('${ORG_MEMBRO_INS}', 'trava-membro-ins', 'Trava Membro Ins LTDA', 'Trava Membro Ins')
        on conflict (id) do nothing;
      insert into public.user_organizations (user_id, organization_id, role, accepted_at)
        values ('${USER_MEMBRO_INS}', '${ORG_MEMBRO_INS}', 'agent', now())
        on conflict do nothing;
      insert into public.crm_pipelines (organization_id, name, slug)
        values ('${ORG_MEMBRO_INS}', 'Funil Membro', 'funil-membro');
      insert into public.crm_stages (organization_id, pipeline_id, name, slug, position)
        values ('${ORG_MEMBRO_INS}', (select id from public.crm_pipelines where organization_id = '${ORG_MEMBRO_INS}' and slug = 'funil-membro'), 'Comum', 'comum', 1000);
    `);
  });

  it("o insert como authenticated (agent) passa sem erro", () => {
    const erro = erroDe(`
      ${comoMembro(USER_MEMBRO_INS)}
      insert into public.crm_leads (organization_id, pipeline_id, stage_id, title)
        values ('${ORG_MEMBRO_INS}', (select id from public.crm_pipelines where organization_id = '${ORG_MEMBRO_INS}' and slug = 'funil-membro'),
                (select id from public.crm_stages where organization_id = '${ORG_MEMBRO_INS}' and slug = 'comum'), 'Lead do Membro');
    `);
    expect(erro).toBeNull();
  });

  it("o gatilho de plano (security definer) atualizou o contador mesmo rodando dentro da sessão do usuário", () => {
    const linhas = comoServico(
      `select 'SONDA|' || valor from public.billing_usage_counters where organization_id = '${ORG_MEMBRO_INS}' and item = 'leads';`,
    );
    expect(linhas).toEqual(["1"]);
  });
});

describe("11. fn_billing_uso: convite vencido não conta; admin provisório não conta", () => {
  beforeAll(() => {
    comoServico(`
      insert into auth.users (id, email) values
        ('${USER_MEMBROS_REAL}', 'trava-membros-real@invariant.test'),
        ('${USER_MEMBROS_PROV}', 'trava-membros-prov@invariant.test')
      on conflict (id) do nothing;
      insert into public.organizations (id, slug, legal_name, display_name)
        values ('${ORG_MEMBROS}', 'trava-membros', 'Trava Membros LTDA', 'Trava Membros')
        on conflict (id) do nothing;
      -- membro real, aceito, não revogado: conta.
      insert into public.user_organizations (user_id, organization_id, role, accepted_at)
        values ('${USER_MEMBROS_REAL}', '${ORG_MEMBROS}', 'agent', now())
        on conflict do nothing;
      -- admin provisório: NÃO conta, mesmo aceito e sem revogação (decisão 3 da fase F2).
      insert into public.user_organizations (user_id, organization_id, role, accepted_at, provisional_until_handover)
        values ('${USER_MEMBROS_PROV}', '${ORG_MEMBROS}', 'admin', now(), true)
        on conflict do nothing;
      -- convite pendente e NÃO vencido: conta.
      insert into public.team_invites (organization_id, email, role, expires_at)
        values ('${ORG_MEMBROS}', 'trava-convite-valido@invariant.test', 'agent', now() + interval '7 days');
      -- convite pendente e VENCIDO: não conta.
      insert into public.team_invites (organization_id, email, role, expires_at)
        values ('${ORG_MEMBROS}', 'trava-convite-vencido@invariant.test', 'agent', now() - interval '1 day');
    `);
  });

  it("fn_billing_uso conta só o membro real e o convite não vencido (2 de 4 linhas semeadas)", () => {
    const linhas = comoServico(
      `select 'SONDA|' || (public.fn_billing_uso('${ORG_MEMBROS}'::uuid) ->> 'membros');`,
    );
    expect(linhas).toEqual(["2"]);
  });
});

describe("12. billing_usage_counters isolado por RLS entre organizações", () => {
  beforeAll(() => {
    comoServico(`
      insert into auth.users (id, email) values ('${USER_ISO_A}', 'trava-iso-a@invariant.test')
        on conflict (id) do nothing;
      insert into public.organizations (id, slug, legal_name, display_name) values
        ('${ORG_ISO_A}', 'trava-iso-a', 'Trava Iso A LTDA', 'Trava Iso A'),
        ('${ORG_ISO_B}', 'trava-iso-b', 'Trava Iso B LTDA', 'Trava Iso B')
      on conflict (id) do nothing;
      insert into public.user_organizations (user_id, organization_id, role, accepted_at)
        values ('${USER_ISO_A}', '${ORG_ISO_A}', 'agent', now())
        on conflict do nothing;
      insert into public.billing_usage_counters (organization_id, item, valor) values
        ('${ORG_ISO_A}', 'leads', 3),
        ('${ORG_ISO_B}', 'leads', 7)
      on conflict (organization_id, item) do update set valor = excluded.valor;
    `);
  });

  it("membro de A lê a própria linha (controle positivo)", () => {
    expect(
      membro(USER_ISO_A, `select 'SONDA|' || count(*) from public.billing_usage_counters where organization_id = '${ORG_ISO_A}';`),
    ).toEqual(["1"]);
  });

  it("membro de A NÃO lê a linha de B", () => {
    expect(
      membro(USER_ISO_A, `select 'SONDA|' || count(*) from public.billing_usage_counters where organization_id = '${ORG_ISO_B}';`),
    ).toEqual(["0"]);
  });
});

describe("13. Membro comum não escreve em billing_usage_counters nem executa as funções de plano", () => {
  beforeAll(() => {
    comoServico(`
      insert into auth.users (id, email) values ('${USER_RBAC}', 'trava-rbac@invariant.test')
        on conflict (id) do nothing;
      insert into public.organizations (id, slug, legal_name, display_name)
        values ('${ORG_RBAC}', 'trava-rbac', 'Trava Rbac LTDA', 'Trava Rbac')
        on conflict (id) do nothing;
      insert into public.user_organizations (user_id, organization_id, role, accepted_at)
        values ('${USER_RBAC}', '${ORG_RBAC}', 'agent', now())
        on conflict do nothing;
    `);
  });

  it("não insere em billing_usage_counters", () => {
    esperaBarrado(
      USER_RBAC,
      `insert into public.billing_usage_counters (organization_id, item, valor) values ('${ORG_RBAC}', 'leads', 1)`,
      "insert em billing_usage_counters",
    );
  });

  it("não atualiza billing_usage_counters", () => {
    esperaBarrado(
      USER_RBAC,
      `update public.billing_usage_counters set valor = 1 where organization_id = '${ORG_RBAC}' and item = 'leads'`,
      "update em billing_usage_counters",
    );
  });

  it("não apaga de billing_usage_counters", () => {
    esperaBarrado(
      USER_RBAC,
      `delete from public.billing_usage_counters where organization_id = '${ORG_RBAC}' and item = 'leads'`,
      "delete em billing_usage_counters",
    );
  });

  it("não executa fn_billing_conferir_teto", () => {
    esperaBarrado(
      USER_RBAC,
      `select public.fn_billing_conferir_teto('${ORG_RBAC}'::uuid, 'leads', null)`,
      "fn_billing_conferir_teto",
    );
  });

  it("não executa fn_billing_conferir_contadores", () => {
    esperaBarrado(USER_RBAC, `select public.fn_billing_conferir_contadores()`, "fn_billing_conferir_contadores");
  });

  it("não executa fn_billing_uso", () => {
    esperaBarrado(USER_RBAC, `select public.fn_billing_uso('${ORG_RBAC}'::uuid)`, "fn_billing_uso");
  });

  it("não executa fn_billing_pode_criar", () => {
    esperaBarrado(
      USER_RBAC,
      `select public.fn_billing_pode_criar('${ORG_RBAC}'::uuid, 'leads', null)`,
      "fn_billing_pode_criar",
    );
  });
});

/** Um `insert` de conexão MCP com `slug`, `name` e `url` válidos (checks da migration 0901). */
function inserirConexaoMcp(org: string, slug: string): string {
  return `insert into public.ai_mcp_connections (organization_id, slug, name, url)
    values ('${org}', '${slug}', 'MCP ${slug}', 'https://mcp.invariant.test/${slug}');`;
}

describe("14. Teto técnico de 10 conexões MCP por organização (D-034, Tarefa 4)", () => {
  beforeAll(() => {
    comoServico(`
      insert into public.organizations (id, slug, legal_name, display_name) values
        ('${ORG_MCP_A}', 'trava-mcp-a', 'Trava MCP A LTDA', 'Trava MCP A'),
        ('${ORG_MCP_B}', 'trava-mcp-b', 'Trava MCP B LTDA', 'Trava MCP B')
      on conflict (id) do nothing;
      -- A nasce com 9 (uma vaga livre); B já nasce NO teto (10), para provar
      -- que o teto de B não vaza para A nem para o contrário.
      insert into public.ai_mcp_connections (organization_id, slug, name, url)
        select '${ORG_MCP_A}', 'mcpa' || lpad(i::text, 2, '0'), 'MCP A ' || i, 'https://mcp.invariant.test/a' || i
        from generate_series(1, 9) as i;
      insert into public.ai_mcp_connections (organization_id, slug, name, url)
        select '${ORG_MCP_B}', 'mcpb' || lpad(i::text, 2, '0'), 'MCP B ' || i, 'https://mcp.invariant.test/b' || i
        from generate_series(1, 10) as i;
    `);
  });

  it("a organização A tem 9 conexões antes do teste (controle positivo)", () => {
    const linhas = comoServico(
      `select 'SONDA|' || count(*) from public.ai_mcp_connections where organization_id = '${ORG_MCP_A}';`,
    );
    expect(linhas).toEqual(["9"]);
  });

  it("a 10ª conexão da organização A passa (9 < 10), mesmo com B já no teto desde o beforeAll", () => {
    const erro = erroDe(inserirConexaoMcp(ORG_MCP_A, "mcpa10"));
    expect(erro).toBeNull();
  });

  it("a 11ª conexão da organização A é recusada com a mensagem fixa (PT422)", () => {
    const erro = erroDe(inserirConexaoMcp(ORG_MCP_A, "mcpa11"));
    expect(erro).not.toBeNull();
    expect(erro).toContain("Limite de 10 conexões por organização");
  });

  it("a organização A termina com exatamente 10 (a 11ª não gravou)", () => {
    const linhas = comoServico(
      `select 'SONDA|' || count(*) from public.ai_mcp_connections where organization_id = '${ORG_MCP_A}';`,
    );
    expect(linhas).toEqual(["10"]);
  });

  it("a organização B, já no teto, também recusa a 11ª (o teto é por organização, não global)", () => {
    const erro = erroDe(inserirConexaoMcp(ORG_MCP_B, "mcpb11"));
    expect(erro).not.toBeNull();
    expect(erro).toContain("Limite de 10 conexões por organização");
  });

  it("a organização B continua com exatamente 10 (nunca foi afetada pela A)", () => {
    const linhas = comoServico(
      `select 'SONDA|' || count(*) from public.ai_mcp_connections where organization_id = '${ORG_MCP_B}';`,
    );
    expect(linhas).toEqual(["10"]);
  });
});

describe("15. Concorrência real: duas sessões inserindo ao mesmo tempo, só uma grava", () => {
  // A organização nasce com 9 (uma vaga livre). A sessão A abre uma
  // transação, insere a 10ª (o gatilho conta 9, passa) e SEGURA a transação
  // aberta com pg_sleep antes do commit: o pg_advisory_xact_lock que o
  // gatilho tomou só solta no commit. A sessão B, disparada quase ao mesmo
  // tempo, tenta inserir a 11ª: fica bloqueada no MESMO advisory lock até A
  // liberar, e só então conta de novo (a função é VOLATILE, decisão 9 da
  // fase, mesmo racional de crm_stages, então essa recontagem enxerga o
  // commit de A, não a foto de antes). Ou A ganha a corrida e B é recusada,
  // ou o inverso; o que este caso prova é que NUNCA as duas passam.
  beforeAll(() => {
    comoServico(`
      insert into public.organizations (id, slug, legal_name, display_name)
        values ('${ORG_MCP_CONCORRENCIA}', 'trava-mcp-conc', 'Trava MCP Conc LTDA', 'Trava MCP Conc')
        on conflict (id) do nothing;
      insert into public.ai_mcp_connections (organization_id, slug, name, url)
        select '${ORG_MCP_CONCORRENCIA}', 'mcpc' || lpad(i::text, 2, '0'), 'MCP C ' || i, 'https://mcp.invariant.test/c' || i
        from generate_series(1, 9) as i;
    `);
  });

  it("das duas tentativas simultâneas de 10ª conexão, exatamente uma grava e a organização termina com 10", async () => {
    const sessaoA = `
      begin;
      ${inserirConexaoMcp(ORG_MCP_CONCORRENCIA, "mcpca1")}
      select pg_sleep(0.5);
      commit;
    `;
    const sessaoB = `
      select pg_sleep(0.15);
      ${inserirConexaoMcp(ORG_MCP_CONCORRENCIA, "mcpcb1")}
    `;

    const [resultadoA, resultadoB] = await Promise.all([sqlAsync(sessaoA), sqlAsync(sessaoB)]);

    const quantasPassaram = [resultadoA.ok, resultadoB.ok].filter(Boolean).length;
    expect(quantasPassaram, `A: ${resultadoA.erro ?? "ok"} | B: ${resultadoB.erro ?? "ok"}`).toBe(1);

    const linhas = comoServico(
      `select 'SONDA|' || count(*) from public.ai_mcp_connections where organization_id = '${ORG_MCP_CONCORRENCIA}';`,
    );
    expect(linhas).toEqual(["10"]);
  });
});
