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
 *  9. `fn_billing_conferir_contador(p_org)` corrige um contador adulterado e
 *     devolve true; rodada de novo, já consistente, devolve false; sem linha
 *     de contador, cria com a contagem real;
 *  10. criar lead como membro comum, com `authenticated` e JWT real, continua
 *      funcionando (o gatilho `security definer` não quebra o insert da
 *      sessão do usuário);
 *  11. `fn_billing_uso`: convite vencido não conta, admin provisório não
 *      conta;
 *  12. `billing_usage_counters` isolado por RLS entre organizações;
 *  13. membro comum não escreve em `billing_usage_counters` nem executa
 *      `fn_billing_conferir_teto`, `fn_billing_conferir_contador`,
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
 * Achado 4 da revisão fase F2 acrescenta mais seis casos (16 a 21, ao final
 * do arquivo): falha forçada dentro da conferência não perde a operação do
 * cliente nem grava aviso pela metade (funis e leads); o N-ésimo lead aberto
 * não avisa e o N+1-ésimo avisa (prova do achado 2); os avisos de
 * `user_organizations`, `team_invites` e `channel_sessions`; o Ilimitado não
 * toma advisory lock nenhum; e membro comum criando lead acima do teto
 * também gera aviso. O conferidor novo (achado 3) ganhou dois casos a mais
 * DENTRO do caso 9 (linha ausente vira linha criada; devolve false quando
 * já está certo).
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
const ORG_FALHA_FUNIS = "09050001-0000-4000-8000-000000000012";
const ORG_FALHA_LEADS = "09050001-0000-4000-8000-000000000013";
const ORG_LEADS_ACHADO2 = "09050001-0000-4000-8000-000000000014";
const ORG_AVISO_MEMBROS = "09050001-0000-4000-8000-000000000015";
const ORG_AVISO_CONVITE = "09050001-0000-4000-8000-000000000016";
const ORG_AVISO_CONEXAO = "09050001-0000-4000-8000-000000000017";
const ORG_ILIMITADO_LOCK = "09050001-0000-4000-8000-000000000018";
const ORG_MEMBRO_TETO = "09050001-0000-4000-8000-000000000019";

const USER_MEMBRO_INS = "09050001-1111-4000-8000-00000000000a";
const USER_MEMBROS_REAL = "09050001-1111-4000-8000-00000000000b";
const USER_MEMBROS_PROV = "09050001-1111-4000-8000-00000000000c";
const USER_ISO_A = "09050001-1111-4000-8000-00000000000d";
const USER_RBAC = "09050001-1111-4000-8000-00000000000e";
const USER_AVISO_MEMBROS = "09050001-1111-4000-8000-000000000012";
const USER_MEMBRO_TETO = "09050001-1111-4000-8000-000000000013";
const USER_ISO_A_AGENTE = "09050001-1111-4000-8000-000000000014";
const USER_PROVISORIO_ADMIN = "09050001-1111-4000-8000-000000000015";
const USER_PROVISORIO_ALVO = "09050001-1111-4000-8000-000000000016";
const USER_AVISO_FORJA = "09050001-1111-4000-8000-000000000017";
const USER_PROVISORIO_NOVO = "09050001-1111-4000-8000-000000000018";
const USER_REENVIO_CONVITE = "09050001-1111-4000-8000-000000000019";
const USER_AVISO_CARTEIRA = "09050001-1111-4000-8000-00000000001a";

const ORG_PROVISORIO = "09050001-0000-4000-8000-00000000001a";
const ORG_AVISO_FORJA = "09050001-0000-4000-8000-00000000001b";
const ORG_REENVIO_CONVITE = "09050001-0000-4000-8000-00000000001c";
const ORG_DESARQUIVAR_ETAPAS = "09050001-0000-4000-8000-00000000001d";
const ORG_MOVER_ETAPA = "09050001-0000-4000-8000-00000000001e";
const ORG_AVISO_CARTEIRA = "09050001-0000-4000-8000-00000000001f";

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

/**
 * Roda `corpo` dentro de uma transação em que TODO insert em
 * `agent_inbox_items` explode (achado 4: prova que uma falha na hora de
 * gravar o aviso não perde a operação do cliente). O gatilho e a função que
 * o cria são DDL transacional: nascem e morrem com a transação, o
 * `rollback` no fim desfaz os dois e não deixa rastro para os outros casos.
 * `corpo` deve terminar com as sondas (`select 'SONDA|' || ...`) que o
 * chamador quer ler.
 */
function dentroDeFalhaForcada(corpo: string): string[] {
  return comoServico(`
    begin;
    create or replace function public.fn_forca_falha_aviso_teste_achado4() returns trigger
    language plpgsql as $BODY$
    begin
      raise exception 'falha_forcada_teste_achado4';
    end;
    $BODY$;
    create trigger trg_forca_falha_aviso_teste_achado4
      before insert on public.agent_inbox_items
      for each row execute function public.fn_forca_falha_aviso_teste_achado4();

    ${corpo}
    rollback;
  `);
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

describe("9. fn_billing_conferir_contador(p_org) corrige um contador adulterado e devolve true; de novo, devolve false", () => {
  // Achado 3 da revisão fase F2: a função deixou de varrer todas as
  // organizações numa RPC só e passou a UMA organização por chamada,
  // devolvendo boolean (divergia ou não), não mais integer.
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

  it("a primeira rodada corrige e devolve true", () => {
    const linhas = comoServico(`select 'SONDA|' || public.fn_billing_conferir_contador('${ORG_CONTADOR}'::uuid);`);
    expect(linhas).toEqual(["true"]);
  });

  it("o valor foi corrigido para o real (1 lead aberto)", () => {
    const linhas = comoServico(
      `select 'SONDA|' || valor from public.billing_usage_counters where organization_id = '${ORG_CONTADOR}' and item = 'leads';`,
    );
    expect(linhas).toEqual(["1"]);
  });

  it("a segunda rodada, já consistente, devolve false", () => {
    const linhas = comoServico(`select 'SONDA|' || public.fn_billing_conferir_contador('${ORG_CONTADOR}'::uuid);`);
    expect(linhas).toEqual(["false"]);
  });

  it("organização SEM linha de contador: a função CRIA a linha com a contagem real e devolve true", () => {
    // Segundo funil e lead, na mesma organização, só para este caso: apaga a
    // linha do contador (sem apagar o lead) para simular uma organização que
    // nunca teve billing_usage_counters: a versão antiga (sem argumento)
    // nunca visitava quem não tinha linha; esta precisa criar.
    comoServico(
      `delete from public.billing_usage_counters where organization_id = '${ORG_CONTADOR}' and item = 'leads';`,
    );
    const semLinha = comoServico(
      `select 'SONDA|' || count(*) from public.billing_usage_counters where organization_id = '${ORG_CONTADOR}' and item = 'leads';`,
    );
    expect(semLinha, "controle: a linha precisa estar ausente antes de conferir").toEqual(["0"]);

    const linhas = comoServico(`select 'SONDA|' || public.fn_billing_conferir_contador('${ORG_CONTADOR}'::uuid);`);
    expect(linhas).toEqual(["true"]);

    const depois = comoServico(
      `select 'SONDA|' || valor from public.billing_usage_counters where organization_id = '${ORG_CONTADOR}' and item = 'leads';`,
    );
    expect(depois, "a linha nasceu com a contagem real (1 lead aberto)").toEqual(["1"]);
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

describe("12. billing_usage_counters isolado por RLS entre organizações (leitura exige gerente, achado B5)", () => {
  beforeAll(() => {
    comoServico(`
      insert into auth.users (id, email) values
        ('${USER_ISO_A}', 'trava-iso-a@invariant.test'),
        ('${USER_ISO_A_AGENTE}', 'trava-iso-a-agente@invariant.test')
      on conflict (id) do nothing;
      insert into public.organizations (id, slug, legal_name, display_name) values
        ('${ORG_ISO_A}', 'trava-iso-a', 'Trava Iso A LTDA', 'Trava Iso A'),
        ('${ORG_ISO_B}', 'trava-iso-b', 'Trava Iso B LTDA', 'Trava Iso B')
      on conflict (id) do nothing;
      -- Achado B5 (revisão fase F2): a policy passou a exigir fn_role_at_least
      -- 'manager'. USER_ISO_A é 'manager' (era 'agent' antes do achado);
      -- USER_ISO_A_AGENTE é 'agent' na MESMA organização, só para provar que
      -- um cargo abaixo de gerente não lê (caso novo, abaixo).
      insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
        ('${USER_ISO_A}', '${ORG_ISO_A}', 'manager', now()),
        ('${USER_ISO_A_AGENTE}', '${ORG_ISO_A}', 'agent', now())
      on conflict do nothing;
      insert into public.billing_usage_counters (organization_id, item, valor) values
        ('${ORG_ISO_A}', 'leads', 3),
        ('${ORG_ISO_B}', 'leads', 7)
      on conflict (organization_id, item) do update set valor = excluded.valor;
    `);
  });

  it("gerente de A lê a própria linha (controle positivo)", () => {
    expect(
      membro(USER_ISO_A, `select 'SONDA|' || count(*) from public.billing_usage_counters where organization_id = '${ORG_ISO_A}';`),
    ).toEqual(["1"]);
  });

  it("gerente de A NÃO lê a linha de B (isolamento entre organizações continua valendo)", () => {
    expect(
      membro(USER_ISO_A, `select 'SONDA|' || count(*) from public.billing_usage_counters where organization_id = '${ORG_ISO_B}';`),
    ).toEqual(["0"]);
  });

  it("achado B5: agente da PRÓPRIA organização A não lê o contador (cargo abaixo de gerente)", () => {
    expect(
      membro(USER_ISO_A_AGENTE, `select 'SONDA|' || count(*) from public.billing_usage_counters where organization_id = '${ORG_ISO_A}';`),
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

  it("não executa fn_billing_conferir_contador", () => {
    esperaBarrado(
      USER_RBAC,
      `select public.fn_billing_conferir_contador('${ORG_RBAC}'::uuid)`,
      "fn_billing_conferir_contador",
    );
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

// ── Achado 4 (revisão fase F2): casos 16 a 21 ──

describe("16. Falha forçada ao gravar o aviso (funis): o insert do funil sobrevive, nenhum aviso fica gravado", () => {
  it("funil acima do teto, com a gravação do aviso forçada a explodir: a linha do funil existe e não há aviso", () => {
    const linhas = dentroDeFalhaForcada(`
      insert into public.organizations (id, slug, legal_name, display_name)
        values ('${ORG_FALHA_FUNIS}', 'trava-falha-funis', 'Trava Falha Funis LTDA', 'Trava Falha Funis');
      select public.fn_billing_trocar_plano('${ORG_FALHA_FUNIS}'::uuid, 'pro', null);
      select public.fn_billing_ajustar_limites('${ORG_FALHA_FUNIS}'::uuid, '{"funis": 1}'::jsonb, null, null);
      -- o funil "Pedidos" seedado já ocupa a vaga (teto 1); este passa do teto
      -- e dispara a tentativa de aviso, que EXPLODE pelo gatilho forçado.
      insert into public.crm_pipelines (organization_id, name, slug) values ('${ORG_FALHA_FUNIS}', 'Funil Falha', 'funil-falha');

      select 'SONDA|' || count(*) from public.crm_pipelines where organization_id = '${ORG_FALHA_FUNIS}' and slug = 'funil-falha';
      select 'SONDA|' || count(*) from public.agent_inbox_items where organization_id = '${ORG_FALHA_FUNIS}' and ref_kind = 'billing_limite';
    `);
    expect(linhas, "[funil sobreviveu?, quantos avisos gravados]").toEqual(["1", "0"]);
  });
});

describe("17. Falha forçada ao gravar o aviso (leads): o insert do lead sobrevive, nenhum aviso fica gravado", () => {
  it("lead acima do teto, com a gravação do aviso forçada a explodir: os dois leads existem e não há aviso", () => {
    const linhas = dentroDeFalhaForcada(`
      insert into public.organizations (id, slug, legal_name, display_name)
        values ('${ORG_FALHA_LEADS}', 'trava-falha-leads', 'Trava Falha Leads LTDA', 'Trava Falha Leads');
      select public.fn_billing_trocar_plano('${ORG_FALHA_LEADS}'::uuid, 'pro', null);
      select public.fn_billing_ajustar_limites('${ORG_FALHA_LEADS}'::uuid, '{"leads": 1}'::jsonb, null, null);
      insert into public.crm_pipelines (organization_id, name, slug)
        values ('${ORG_FALHA_LEADS}', 'Funil Falha Leads', 'funil-falha-leads');
      insert into public.crm_stages (organization_id, pipeline_id, name, slug, position)
        values ('${ORG_FALHA_LEADS}',
                (select id from public.crm_pipelines where organization_id = '${ORG_FALHA_LEADS}' and slug = 'funil-falha-leads'),
                'Comum', 'comum', 1000);

      -- 1º lead, dentro do teto (0 < 1), não tenta gravar aviso nenhum.
      insert into public.crm_leads (organization_id, pipeline_id, stage_id, title)
        values ('${ORG_FALHA_LEADS}',
                (select id from public.crm_pipelines where organization_id = '${ORG_FALHA_LEADS}' and slug = 'funil-falha-leads'),
                (select id from public.crm_stages where organization_id = '${ORG_FALHA_LEADS}' and slug = 'comum'), 'Lead 1');
      -- 2º lead, acima do teto: dispara a tentativa de aviso, que EXPLODE.
      -- fn_billing_trava_crm_leads também captura qualquer erro (decisão 11
      -- da 0905), dupla proteção, e nenhuma delas pode perder o lead.
      insert into public.crm_leads (organization_id, pipeline_id, stage_id, title)
        values ('${ORG_FALHA_LEADS}',
                (select id from public.crm_pipelines where organization_id = '${ORG_FALHA_LEADS}' and slug = 'funil-falha-leads'),
                (select id from public.crm_stages where organization_id = '${ORG_FALHA_LEADS}' and slug = 'comum'), 'Lead 2');

      select 'SONDA|' || count(*) from public.crm_leads where organization_id = '${ORG_FALHA_LEADS}';
      select 'SONDA|' || count(*) from public.agent_inbox_items where organization_id = '${ORG_FALHA_LEADS}' and ref_kind = 'billing_limite';
    `);
    expect(linhas, "[quantos leads sobreviveram, quantos avisos gravados]").toEqual(["2", "0"]);
  });
});

describe("18. Aviso de leads: o N-ésimo lead aberto NÃO avisa, o N+1-ésimo avisa (prova do achado 2)", () => {
  beforeAll(() => {
    comoServico(`
      insert into public.organizations (id, slug, legal_name, display_name)
        values ('${ORG_LEADS_ACHADO2}', 'trava-leads-achado2', 'Trava Leads Achado2 LTDA', 'Trava Leads Achado2')
        on conflict (id) do nothing;
      select public.fn_billing_trocar_plano('${ORG_LEADS_ACHADO2}'::uuid, 'pro', null);
      select public.fn_billing_ajustar_limites('${ORG_LEADS_ACHADO2}'::uuid, '{"leads": 3}'::jsonb, null, null);
      insert into public.crm_pipelines (organization_id, name, slug)
        values ('${ORG_LEADS_ACHADO2}', 'Funil Achado2', 'funil-achado2');
      insert into public.crm_stages (organization_id, pipeline_id, name, slug, position)
        values ('${ORG_LEADS_ACHADO2}',
                (select id from public.crm_pipelines where organization_id = '${ORG_LEADS_ACHADO2}' and slug = 'funil-achado2'),
                'Comum', 'comum', 1000);
    `);
  });

  function criarLead(titulo: string): void {
    comoServico(`
      insert into public.crm_leads (organization_id, pipeline_id, stage_id, title)
        values ('${ORG_LEADS_ACHADO2}',
                (select id from public.crm_pipelines where organization_id = '${ORG_LEADS_ACHADO2}' and slug = 'funil-achado2'),
                (select id from public.crm_stages where organization_id = '${ORG_LEADS_ACHADO2}' and slug = 'comum'), '${titulo}');
    `);
  }

  it("o teto é 3: os leads 1, 2 e 3 (o N-ésimo) não avisam", () => {
    criarLead("Lead 1");
    criarLead("Lead 2");
    criarLead("Lead 3");
    // Achado 2: fn_billing_conferir_teto roda ANTES do upsert do contador,
    // no 3º lead o contador ainda lê 2 (< teto 3), não avisa. Na ordem
    // antiga (soma antes de conferir) o 3º já veria o contador em 3 e
    // avisaria um lead cedo demais.
    expect(avisosDe(ORG_LEADS_ACHADO2)).toBe(0);
  });

  it("o lead N+1 (o 4º, com o contador já em 3) avisa", () => {
    criarLead("Lead 4");
    expect(avisosDe(ORG_LEADS_ACHADO2)).toBe(1);
  });
});

describe("19. Aviso gerado pelos gatilhos de user_organizations, team_invites e channel_sessions", () => {
  it("aceitar um membro acima do teto (user_organizations) avisa", () => {
    comoServico(`
      insert into auth.users (id, email) values
        ('${USER_MEMBROS_REAL}', 'aviso-membros-ocupa@invariant.test')
      on conflict (id) do nothing;
      insert into auth.users (id, email) values
        ('${USER_AVISO_MEMBROS}', 'aviso-membros-novo@invariant.test')
      on conflict (id) do nothing;
      insert into public.organizations (id, slug, legal_name, display_name)
        values ('${ORG_AVISO_MEMBROS}', 'trava-aviso-membros', 'Trava Aviso Membros LTDA', 'Trava Aviso Membros')
        on conflict (id) do nothing;
      select public.fn_billing_trocar_plano('${ORG_AVISO_MEMBROS}'::uuid, 'pro', null);
      select public.fn_billing_ajustar_limites('${ORG_AVISO_MEMBROS}'::uuid, '{"membros": 1}'::jsonb, null, null);
      -- um membro já ativo ocupa a única vaga do teto.
      insert into public.user_organizations (user_id, organization_id, role, accepted_at)
        values ('${USER_MEMBROS_REAL}', '${ORG_AVISO_MEMBROS}', 'agent', now())
        on conflict do nothing;
      -- um segundo membro nasce PENDENTE (não conta ainda)...
      insert into public.user_organizations (user_id, organization_id, role, accepted_at)
        values ('${USER_AVISO_MEMBROS}', '${ORG_AVISO_MEMBROS}', 'agent', null)
        on conflict do nothing;
    `);
    expect(avisosDe(ORG_AVISO_MEMBROS), "controle: convite pendente ainda não avisa").toBe(0);

    comoServico(
      `update public.user_organizations set accepted_at = now()
         where user_id = '${USER_AVISO_MEMBROS}' and organization_id = '${ORG_AVISO_MEMBROS}';`,
    );
    expect(avisosDe(ORG_AVISO_MEMBROS), "aceite acima do teto avisa").toBe(1);
  });

  it("um convite pendente acima do teto (team_invites) avisa", () => {
    comoServico(`
      insert into auth.users (id, email) values ('${USER_MEMBROS_REAL}', 'aviso-convite-ocupa@invariant.test')
        on conflict (id) do nothing;
      insert into public.organizations (id, slug, legal_name, display_name)
        values ('${ORG_AVISO_CONVITE}', 'trava-aviso-convite', 'Trava Aviso Convite LTDA', 'Trava Aviso Convite')
        on conflict (id) do nothing;
      select public.fn_billing_trocar_plano('${ORG_AVISO_CONVITE}'::uuid, 'pro', null);
      select public.fn_billing_ajustar_limites('${ORG_AVISO_CONVITE}'::uuid, '{"membros": 1}'::jsonb, null, null);
      -- um membro ativo já ocupa a única vaga do teto.
      insert into public.user_organizations (user_id, organization_id, role, accepted_at)
        values ('${USER_MEMBROS_REAL}', '${ORG_AVISO_CONVITE}', 'agent', now())
        on conflict do nothing;
    `);
    expect(avisosDe(ORG_AVISO_CONVITE), "controle: nasceu sem convite, sem aviso").toBe(0);

    comoServico(`
      insert into public.team_invites (organization_id, email, role, expires_at)
        values ('${ORG_AVISO_CONVITE}', 'aviso-convite-novo@invariant.test', 'agent', now() + interval '7 days');
    `);
    expect(avisosDe(ORG_AVISO_CONVITE), "convite pendente acima do teto avisa").toBe(1);
  });

  it("conectar um canal acima do teto (channel_sessions) avisa", () => {
    comoServico(`
      insert into public.organizations (id, slug, legal_name, display_name)
        values ('${ORG_AVISO_CONEXAO}', 'trava-aviso-conexao', 'Trava Aviso Conexao LTDA', 'Trava Aviso Conexao')
        on conflict (id) do nothing;
      select public.fn_billing_trocar_plano('${ORG_AVISO_CONEXAO}'::uuid, 'pro', null);
      select public.fn_billing_ajustar_limites('${ORG_AVISO_CONEXAO}'::uuid, '{"conexoes": 1}'::jsonb, null, null);
      -- primeira conexão, ativa, sozinha preenche o teto (0 < 1, não avisa).
      insert into public.channel_sessions (organization_id, waha_session_name, webhook_secret_encrypted)
        values ('${ORG_AVISO_CONEXAO}', 'aviso-conexao-1', '\\x00'::bytea);
    `);
    expect(avisosDe(ORG_AVISO_CONEXAO), "controle: a primeira conexão não avisa").toBe(0);

    comoServico(`
      insert into public.channel_sessions (organization_id, waha_session_name, webhook_secret_encrypted)
        values ('${ORG_AVISO_CONEXAO}', 'aviso-conexao-2', '\\x00'::bytea);
    `);
    expect(avisosDe(ORG_AVISO_CONEXAO), "a segunda conexão, acima do teto, avisa").toBe(1);
  });
});

describe("20. Ilimitado não toma trava nenhuma (nenhum advisory lock)", () => {
  it("criar um funil numa organização Ilimitado não aparece em pg_locks como advisory lock desta transação", () => {
    const linhas = comoServico(`
      begin;
      insert into public.organizations (id, slug, legal_name, display_name)
        values ('${ORG_ILIMITADO_LOCK}', 'trava-ilimitado-lock', 'Trava Ilimitado Lock LTDA', 'Trava Ilimitado Lock')
        on conflict (id) do nothing;
      insert into public.crm_pipelines (organization_id, name, slug)
        values ('${ORG_ILIMITADO_LOCK}', 'Funil Ilimitado Lock', 'funil-ilimitado-lock');
      select 'SONDA|' || count(*) from pg_locks where locktype = 'advisory' and pid = pg_backend_pid();
      rollback;
    `);
    // fn_billing_conferir_teto lê o teto efetivo ANTES do pg_advisory_xact_lock
    // (decisão 8 da 0905) e sai sem travar quando não há teto: o Ilimitado
    // nunca chega perto do lock.
    expect(linhas).toEqual(["0"]);
  });
});

describe("21. Membro comum criando lead numa organização COM teto e acima dele: o insert passa e o aviso nasce", () => {
  beforeAll(() => {
    comoServico(`
      insert into auth.users (id, email) values ('${USER_MEMBRO_TETO}', 'aviso-membro-teto@invariant.test')
        on conflict (id) do nothing;
      insert into public.organizations (id, slug, legal_name, display_name)
        values ('${ORG_MEMBRO_TETO}', 'trava-membro-teto', 'Trava Membro Teto LTDA', 'Trava Membro Teto')
        on conflict (id) do nothing;
      select public.fn_billing_trocar_plano('${ORG_MEMBRO_TETO}'::uuid, 'pro', null);
      select public.fn_billing_ajustar_limites('${ORG_MEMBRO_TETO}'::uuid, '{"leads": 1}'::jsonb, null, null);
      insert into public.user_organizations (user_id, organization_id, role, accepted_at)
        values ('${USER_MEMBRO_TETO}', '${ORG_MEMBRO_TETO}', 'agent', now())
        on conflict do nothing;
      insert into public.crm_pipelines (organization_id, name, slug)
        values ('${ORG_MEMBRO_TETO}', 'Funil Membro Teto', 'funil-membro-teto');
      insert into public.crm_stages (organization_id, pipeline_id, name, slug, position)
        values ('${ORG_MEMBRO_TETO}',
                (select id from public.crm_pipelines where organization_id = '${ORG_MEMBRO_TETO}' and slug = 'funil-membro-teto'),
                'Comum', 'comum', 1000);
      -- 1º lead, criado pelo serviço, ocupa a única vaga do teto.
      insert into public.crm_leads (organization_id, pipeline_id, stage_id, title)
        values ('${ORG_MEMBRO_TETO}',
                (select id from public.crm_pipelines where organization_id = '${ORG_MEMBRO_TETO}' and slug = 'funil-membro-teto'),
                (select id from public.crm_stages where organization_id = '${ORG_MEMBRO_TETO}' and slug = 'comum'), 'Lead Serviço');
    `);
  });

  it("o membro comum consegue criar o 2º lead, acima do teto (nesta fase a trava só avisa)", () => {
    const erro = erroDe(`
      ${comoMembro(USER_MEMBRO_TETO)}
      insert into public.crm_leads (organization_id, pipeline_id, stage_id, title)
        values ('${ORG_MEMBRO_TETO}',
                (select id from public.crm_pipelines where organization_id = '${ORG_MEMBRO_TETO}' and slug = 'funil-membro-teto'),
                (select id from public.crm_stages where organization_id = '${ORG_MEMBRO_TETO}' and slug = 'comum'), 'Lead do Membro Acima do Teto');
    `);
    expect(erro).toBeNull();
  });

  it("o aviso nasceu", () => {
    expect(avisosDe(ORG_MEMBRO_TETO)).toBe(1);
  });
});

/**
 * Achados M1, M2, B1 e B4 da AUDITORIA DE SEGURANÇA da fase F2 (segunda
 * leva). B5 entrou dentro do caso 12, acima (a política mudou no lugar).
 */

describe("22. M1: só o servidor grava user_organizations.provisional_until_handover", () => {
  beforeAll(() => {
    comoServico(`
      insert into auth.users (id, email) values
        ('${USER_PROVISORIO_ADMIN}', 'm1-admin@invariant.test'),
        ('${USER_PROVISORIO_ALVO}', 'm1-alvo@invariant.test'),
        ('${USER_PROVISORIO_NOVO}', 'm1-novo@invariant.test')
      on conflict (id) do nothing;
      insert into public.organizations (id, slug, legal_name, display_name)
        values ('${ORG_PROVISORIO}', 'trava-m1-provisorio', 'Trava M1 LTDA', 'Trava M1')
        on conflict (id) do nothing;
      -- Sem plano/teto nesta fase de setup: só interessa quem PODE gravar a
      -- coluna aqui; a conferência do teto vem só no último caso.
      insert into public.user_organizations (user_id, organization_id, role, accepted_at)
        values ('${USER_PROVISORIO_ADMIN}', '${ORG_PROVISORIO}', 'admin', now())
        on conflict do nothing;
      -- o alvo já nasce PROVISÓRIO (gravado pelo servidor, como
      -- fn_create_tenant_with_owner faria): é ele que o admin comum vai tentar
      -- desmarcar indevidamente.
      insert into public.user_organizations (user_id, organization_id, role, accepted_at, provisional_until_handover)
        values ('${USER_PROVISORIO_ALVO}', '${ORG_PROVISORIO}', 'admin', now(), true)
        on conflict do nothing;
    `);
  });

  it("um admin comum NÃO consegue marcar o próprio vínculo como provisório (update recusado)", () => {
    const erro = erroDe(`
      ${comoMembro(USER_PROVISORIO_ADMIN)}
      update public.user_organizations set provisional_until_handover = true
        where organization_id = '${ORG_PROVISORIO}' and user_id = '${USER_PROVISORIO_ADMIN}';
    `);
    expect(erro).not.toBeNull();
    expect(erro).toContain("provisional_until_handover");
  });

  it("um admin comum NÃO consegue desmarcar o provisório de outra pessoa (update recusado, mesmo a favor do colega)", () => {
    const erro = erroDe(`
      ${comoMembro(USER_PROVISORIO_ADMIN)}
      update public.user_organizations set provisional_until_handover = false
        where organization_id = '${ORG_PROVISORIO}' and user_id = '${USER_PROVISORIO_ALVO}';
    `);
    expect(erro).not.toBeNull();
    expect(erro).toContain("provisional_until_handover");
  });

  it("um admin comum NÃO consegue inserir um vínculo já provisório (insert recusado)", () => {
    const erro = erroDe(`
      ${comoMembro(USER_PROVISORIO_ADMIN)}
      insert into public.user_organizations (user_id, organization_id, role, accepted_at, provisional_until_handover)
        values ('${USER_PROVISORIO_NOVO}', '${ORG_PROVISORIO}', 'agent', now(), true);
    `);
    expect(erro).not.toBeNull();
    expect(erro).toContain("provisional_until_handover");
  });

  it("o SERVIDOR grava e desmarca um provisório sem ser barrado, e desmarcar confere o teto de membros e avisa", () => {
    comoServico(`
      select public.fn_billing_trocar_plano('${ORG_PROVISORIO}'::uuid, 'pro', null);
      select public.fn_billing_ajustar_limites('${ORG_PROVISORIO}'::uuid, '{"membros": 1}'::jsonb, null, null);
      insert into public.user_organizations (user_id, organization_id, role, accepted_at, provisional_until_handover)
        values ('${USER_PROVISORIO_NOVO}', '${ORG_PROVISORIO}', 'admin', now(), true)
        on conflict (user_id, organization_id) do update set provisional_until_handover = true, accepted_at = now();
    `);
    // Provisório: não conta, sem aviso (o admin sozinho já preenche o teto 1,
    // mas nada NOVO transicionou para ativo ainda).
    expect(avisosDe(ORG_PROVISORIO)).toBe(0);

    comoServico(`
      update public.user_organizations set provisional_until_handover = false
        where organization_id = '${ORG_PROVISORIO}' and user_id = '${USER_PROVISORIO_NOVO}';
    `);
    // Desmarcar como postgres passa (current_user exempto) e a transição
    // provisório->ativo agora está na lista de colunas do gatilho de trava: o
    // admin já ocupava a única vaga (teto 1), o NOVO ficando ativo avisa.
    expect(avisosDe(ORG_PROVISORIO)).toBe(1);
  });
});

describe("23. M2: ninguém além do servidor forja, apaga ou reescreve o aviso de plano", () => {
  let avisoRealId = "";

  beforeAll(() => {
    comoServico(`
      insert into auth.users (id, email) values ('${USER_AVISO_FORJA}', 'm2-viewer@invariant.test')
        on conflict (id) do nothing;
      insert into public.organizations (id, slug, legal_name, display_name)
        values ('${ORG_AVISO_FORJA}', 'trava-m2-forja', 'Trava M2 LTDA', 'Trava M2')
        on conflict (id) do nothing;
      select public.fn_billing_trocar_plano('${ORG_AVISO_FORJA}'::uuid, 'pro', null);
      select public.fn_billing_ajustar_limites('${ORG_AVISO_FORJA}'::uuid, '{"funis": 1}'::jsonb, null, null);
      insert into public.user_organizations (user_id, organization_id, role, accepted_at)
        values ('${USER_AVISO_FORJA}', '${ORG_AVISO_FORJA}', 'viewer', now())
        on conflict do nothing;
      -- o seed "Pedidos" já ocupa o teto 1; este segundo funil estoura e nasce
      -- o aviso REAL que os casos abaixo tentam forjar, apagar e reescrever.
      insert into public.crm_pipelines (organization_id, name, slug)
        values ('${ORG_AVISO_FORJA}', 'Funil M2', 'funil-m2');
    `);
    const linhas = comoServico(
      `select 'SONDA|' || id from public.agent_inbox_items where organization_id = '${ORG_AVISO_FORJA}' and ref_kind = 'billing_limite' and status = 'open';`,
    );
    avisoRealId = linhas[0] ?? "";
  });

  it("o aviso real nasceu (controle)", () => {
    expect(avisosDe(ORG_AVISO_FORJA)).toBe(1);
    expect(avisoRealId).not.toBe("");
  });

  it("um viewer NÃO insere um aviso billing_limite forjado (policy restrictive de insert)", () => {
    const erro = erroDe(`
      ${comoMembro(USER_AVISO_FORJA)}
      insert into public.agent_inbox_items (organization_id, kind, severity, title, body, ref_kind, ref_id)
        values ('${ORG_AVISO_FORJA}', 'other', 'warn', 'Limite de funis do plano atingido', 'forjado', 'billing_limite', '${ORG_AVISO_FORJA}');
    `);
    expect(erro).not.toBeNull();
    expect(erro).toContain("row-level security");
  });

  it("um viewer NÃO apaga o aviso real (policy restrictive de delete: filtra a linha, sem erro, sem apagar)", () => {
    membro(USER_AVISO_FORJA, `delete from public.agent_inbox_items where id = '${avisoRealId}';`);
    expect(avisosDe(ORG_AVISO_FORJA)).toBe(1);
  });

  it("um viewer NÃO reescreve o título do aviso real (gatilho de update)", () => {
    const erro = erroDe(`
      ${comoMembro(USER_AVISO_FORJA)}
      update public.agent_inbox_items set title = 'hackeado' where id = '${avisoRealId}';
    `);
    expect(erro).not.toBeNull();
    expect(erro).toContain("só status e resolved_at podem mudar");
  });

  it("um viewer CONSEGUE encerrar o aviso real (status é coluna de estado permitida)", () => {
    const erro = erroDe(`
      ${comoMembro(USER_AVISO_FORJA)}
      update public.agent_inbox_items set status = 'resolved' where id = '${avisoRealId}';
    `);
    expect(erro).toBeNull();
    const linhas = comoServico(`select 'SONDA|' || status from public.agent_inbox_items where id = '${avisoRealId}';`);
    expect(linhas).toEqual(["resolved"]);
  });

  it("itens de OUTRO tipo (não billing_limite) continuam graváveis pelo membro como antes", () => {
    const erro = erroDe(`
      ${comoMembro(USER_AVISO_FORJA)}
      insert into public.agent_inbox_items (organization_id, kind, severity, title, ref_kind)
        values ('${ORG_AVISO_FORJA}', 'other', 'info', 'Aviso comum do membro', null);
    `);
    expect(erro).toBeNull();
  });
});

describe("24. B1: reenviar um convite vencido, com a organização no teto, avisa", () => {
  beforeAll(() => {
    comoServico(`
      insert into auth.users (id, email) values ('${USER_REENVIO_CONVITE}', 'b1-membro@invariant.test')
        on conflict (id) do nothing;
      insert into public.organizations (id, slug, legal_name, display_name)
        values ('${ORG_REENVIO_CONVITE}', 'trava-b1-reenvio', 'Trava B1 LTDA', 'Trava B1')
        on conflict (id) do nothing;
      select public.fn_billing_trocar_plano('${ORG_REENVIO_CONVITE}'::uuid, 'pro', null);
      select public.fn_billing_ajustar_limites('${ORG_REENVIO_CONVITE}'::uuid, '{"membros": 1}'::jsonb, null, null);
      insert into public.user_organizations (user_id, organization_id, role, accepted_at)
        values ('${USER_REENVIO_CONVITE}', '${ORG_REENVIO_CONVITE}', 'agent', now())
        on conflict do nothing;
      -- convite JÁ VENCIDO: não conta como pendente, não avisa ao nascer.
      insert into public.team_invites (organization_id, email, role, expires_at)
        values ('${ORG_REENVIO_CONVITE}', 'b1-convidado@invariant.test', 'agent', now() - interval '1 day');
    `);
  });

  it("o convite vencido nasceu sem aviso (não conta como pendente)", () => {
    expect(avisosDe(ORG_REENVIO_CONVITE)).toBe(0);
  });

  it("reenviar (update de expires_at/last_sent_at/resend_count, como emitirConvite/reenviarConvite) volta a pendente e avisa, org já no teto", () => {
    comoServico(`
      update public.team_invites
        set expires_at = now() + interval '7 days', last_sent_at = now(), resend_count = resend_count + 1
        where organization_id = '${ORG_REENVIO_CONVITE}' and email = 'b1-convidado@invariant.test';
    `);
    expect(avisosDe(ORG_REENVIO_CONVITE)).toBe(1);
  });
});

describe("25. B4: transições que mudam a contagem de etapas sem aviso", () => {
  it("B4.1: desarquivar um funil com etapas acima do teto avisa etapas_por_funil (não só funis)", () => {
    comoServico(`
      insert into public.organizations (id, slug, legal_name, display_name)
        values ('${ORG_DESARQUIVAR_ETAPAS}', 'trava-b4-desarquivar-etapas', 'Trava B4 Desarquivar LTDA', 'Trava B4 Desarquivar')
        on conflict (id) do nothing;
      select public.fn_billing_trocar_plano('${ORG_DESARQUIVAR_ETAPAS}'::uuid, 'pro', null);
      select public.fn_billing_ajustar_limites('${ORG_DESARQUIVAR_ETAPAS}'::uuid, '{"funis": 5, "etapas_por_funil": 5}'::jsonb, null, null);
      insert into public.crm_pipelines (organization_id, name, slug)
        values ('${ORG_DESARQUIVAR_ETAPAS}', 'Funil B4', 'funil-b4-etapas');
      -- 1 etapa ativa, folgado (teto 5 nesta hora).
      insert into public.crm_stages (organization_id, pipeline_id, name, slug, position)
        values ('${ORG_DESARQUIVAR_ETAPAS}',
                (select id from public.crm_pipelines where organization_id = '${ORG_DESARQUIVAR_ETAPAS}' and slug = 'funil-b4-etapas'),
                'Etapa B4', 'etapa-b4', 1000);
      -- arquivar o funil não confere nada, antes e depois deste achado.
      update public.crm_pipelines set is_archived = true
        where organization_id = '${ORG_DESARQUIVAR_ETAPAS}' and slug = 'funil-b4-etapas';
      -- o teto CAI para 0 enquanto o funil está arquivado (fn_billing_ajustar_limites
      -- nunca confere retroativamente), a etapa ativa já existente fica "fora do
      -- radar" até o funil ser desarquivado.
      select public.fn_billing_ajustar_limites('${ORG_DESARQUIVAR_ETAPAS}'::uuid, '{"etapas_por_funil": 0}'::jsonb, null, null);
    `);
    expect(avisosDe(ORG_DESARQUIVAR_ETAPAS)).toBe(0);

    comoServico(`
      update public.crm_pipelines set is_archived = false
        where organization_id = '${ORG_DESARQUIVAR_ETAPAS}' and slug = 'funil-b4-etapas';
    `);
    // Achado B4.1: antes, desarquivar só conferia 'funis' (folgado, teto 5).
    // Agora também confere etapas_por_funil DESTE funil (teto 0, com 1 etapa
    // ativa já dentro dele) e avisa.
    expect(avisosDe(ORG_DESARQUIVAR_ETAPAS)).toBe(1);
  });

  it("B4.2: mover uma etapa ATIVA para o funil de destino no teto avisa etapas_por_funil do destino", () => {
    comoServico(`
      insert into public.organizations (id, slug, legal_name, display_name)
        values ('${ORG_MOVER_ETAPA}', 'trava-b4-mover-etapa', 'Trava B4 Mover LTDA', 'Trava B4 Mover')
        on conflict (id) do nothing;
      select public.fn_billing_trocar_plano('${ORG_MOVER_ETAPA}'::uuid, 'pro', null);
      select public.fn_billing_ajustar_limites('${ORG_MOVER_ETAPA}'::uuid, '{"funis": 5, "etapas_por_funil": 1}'::jsonb, null, null);
      insert into public.crm_pipelines (organization_id, name, slug) values
        ('${ORG_MOVER_ETAPA}', 'Funil Origem B4', 'funil-origem-b4'),
        ('${ORG_MOVER_ETAPA}', 'Funil Destino B4', 'funil-destino-b4');
      -- cada funil com 1 etapa ativa, exatamente no teto (1), sem aviso.
      insert into public.crm_stages (organization_id, pipeline_id, name, slug, position)
        values ('${ORG_MOVER_ETAPA}',
                (select id from public.crm_pipelines where organization_id = '${ORG_MOVER_ETAPA}' and slug = 'funil-origem-b4'),
                'Etapa Origem', 'etapa-origem-b4', 1000);
      insert into public.crm_stages (organization_id, pipeline_id, name, slug, position)
        values ('${ORG_MOVER_ETAPA}',
                (select id from public.crm_pipelines where organization_id = '${ORG_MOVER_ETAPA}' and slug = 'funil-destino-b4'),
                'Etapa Destino', 'etapa-destino-b4', 1000);
    `);
    expect(avisosDe(ORG_MOVER_ETAPA)).toBe(0);

    comoServico(`
      update public.crm_stages
        set pipeline_id = (select id from public.crm_pipelines where organization_id = '${ORG_MOVER_ETAPA}' and slug = 'funil-destino-b4')
        where organization_id = '${ORG_MOVER_ETAPA}' and slug = 'etapa-origem-b4';
    `);
    // Achado B4.2: antes, mudar pipeline_id de uma etapa ativa não disparava
    // nada (não estava na lista de colunas do gatilho). Agora confere
    // etapas_por_funil do funil de DESTINO (2 etapas ativas ali, teto 1) e avisa.
    expect(avisosDe(ORG_MOVER_ETAPA)).toBe(1);
  });
});

describe("26. billing_carteira (achado baixo 9, revisão F3): a mesma proteção do M2 (caso 23) cobre o aviso de carteira zerada", () => {
  // Molde EXATO do caso 23 (M2), só trocando o ref_kind: a revisão pós-
  // auditoria da F3 estendeu as duas policies restrictive (insert e delete) e
  // o gatilho de update de ref_kind = 'billing_limite' para também cobrir
  // ref_kind = 'billing_carteira' (0905 parte 4, achado baixo 9), o aviso
  // crítico que `run-model-call.ts` grava quando a carteira de tokens de IA
  // do mês zera. Diferença do caso 23: nenhum gatilho de trava cria este
  // aviso sozinho (billing_carteira não nasce de nenhum teto de funil/etapa/
  // membro/webhook), então o aviso "real" nasce aqui por um insert direto,
  // no mesmo formato de `run-model-call.ts` (kind='other', severity='critical',
  // ref_kind='billing_carteira', ref_id=organization_id), simulando o
  // servidor gravando.
  let avisoRealId = "";

  beforeAll(() => {
    comoServico(`
      insert into auth.users (id, email) values ('${USER_AVISO_CARTEIRA}', 'carteira-viewer@invariant.test')
        on conflict (id) do nothing;
      insert into public.organizations (id, slug, legal_name, display_name)
        values ('${ORG_AVISO_CARTEIRA}', 'trava-carteira-forja', 'Trava Carteira LTDA', 'Trava Carteira')
        on conflict (id) do nothing;
      insert into public.user_organizations (user_id, organization_id, role, accepted_at)
        values ('${USER_AVISO_CARTEIRA}', '${ORG_AVISO_CARTEIRA}', 'viewer', now())
        on conflict do nothing;
      -- o aviso REAL que os casos abaixo tentam forjar, apagar e reescrever,
      -- gravado aqui como o SERVIDOR faria (run-model-call.ts).
      insert into public.agent_inbox_items (organization_id, kind, severity, title, body, ref_kind, ref_id)
        values ('${ORG_AVISO_CARTEIRA}', 'other', 'critical', 'Saldo de tokens de IA esgotado', 'carteira zerada', 'billing_carteira', '${ORG_AVISO_CARTEIRA}');
    `);
    const linhas = comoServico(
      `select 'SONDA|' || id from public.agent_inbox_items where organization_id = '${ORG_AVISO_CARTEIRA}' and ref_kind = 'billing_carteira' and status = 'open';`,
    );
    avisoRealId = linhas[0] ?? "";
  });

  it("o aviso real nasceu (controle)", () => {
    const linhas = comoServico(
      `select 'SONDA|' || count(*) from public.agent_inbox_items where organization_id = '${ORG_AVISO_CARTEIRA}' and kind = 'other' and ref_kind = 'billing_carteira' and status = 'open';`,
    );
    expect(linhas).toEqual(["1"]);
    expect(avisoRealId).not.toBe("");
  });

  it("um viewer NÃO insere um aviso billing_carteira forjado (policy restrictive de insert)", () => {
    const erro = erroDe(`
      ${comoMembro(USER_AVISO_CARTEIRA)}
      insert into public.agent_inbox_items (organization_id, kind, severity, title, body, ref_kind, ref_id)
        values ('${ORG_AVISO_CARTEIRA}', 'other', 'critical', 'Saldo de tokens de IA esgotado', 'forjado', 'billing_carteira', '${ORG_AVISO_CARTEIRA}');
    `);
    expect(erro).not.toBeNull();
    expect(erro).toContain("row-level security");
  });

  it("um viewer NÃO apaga o aviso real (policy restrictive de delete: filtra a linha, sem erro, sem apagar)", () => {
    membro(USER_AVISO_CARTEIRA, `delete from public.agent_inbox_items where id = '${avisoRealId}';`);
    const linhas = comoServico(
      `select 'SONDA|' || count(*) from public.agent_inbox_items where id = '${avisoRealId}';`,
    );
    expect(linhas).toEqual(["1"]);
  });

  it("um viewer NÃO reescreve título, corpo nem ref_kind do aviso real (gatilho de update)", () => {
    const erroTitulo = erroDe(`
      ${comoMembro(USER_AVISO_CARTEIRA)}
      update public.agent_inbox_items set title = 'hackeado' where id = '${avisoRealId}';
    `);
    expect(erroTitulo).not.toBeNull();
    expect(erroTitulo).toContain("só status e resolved_at podem mudar");

    const erroCorpo = erroDe(`
      ${comoMembro(USER_AVISO_CARTEIRA)}
      update public.agent_inbox_items set body = 'hackeado' where id = '${avisoRealId}';
    `);
    expect(erroCorpo).not.toBeNull();
    expect(erroCorpo).toContain("só status e resolved_at podem mudar");

    const erroRefKind = erroDe(`
      ${comoMembro(USER_AVISO_CARTEIRA)}
      update public.agent_inbox_items set ref_kind = 'other' where id = '${avisoRealId}';
    `);
    expect(erroRefKind).not.toBeNull();
    expect(erroRefKind).toContain("só status e resolved_at podem mudar");
  });

  it("um viewer CONSEGUE encerrar o aviso real (status é coluna de estado permitida)", () => {
    const erro = erroDe(`
      ${comoMembro(USER_AVISO_CARTEIRA)}
      update public.agent_inbox_items set status = 'resolved' where id = '${avisoRealId}';
    `);
    expect(erro).toBeNull();
    const linhas = comoServico(`select 'SONDA|' || status from public.agent_inbox_items where id = '${avisoRealId}';`);
    expect(linhas).toEqual(["resolved"]);
  });

  it("um item de OUTRO tipo (não billing_carteira) continua gravável pelo membro como antes", () => {
    const erro = erroDe(`
      ${comoMembro(USER_AVISO_CARTEIRA)}
      insert into public.agent_inbox_items (organization_id, kind, severity, title, ref_kind)
        values ('${ORG_AVISO_CARTEIRA}', 'other', 'info', 'Aviso comum do membro', null);
    `);
    expect(erro).toBeNull();
  });
});
