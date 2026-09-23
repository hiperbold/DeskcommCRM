import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATION = readFileSync(
  join(process.cwd(), "supabase/migrations/20260923110000_0906_planos_carteira_de_tokens.sql"),
  "utf8",
);
const BASELINE = readFileSync(join(process.cwd(), "supabase/baseline.sql"), "utf8");

const TABELAS_NOVAS = [
  "billing_token_ledger",
  "billing_token_wallets",
  "billing_token_adicionais",
  "billing_token_consumo_diario",
] as const;

/**
 * Extrai o bloco 0906 do baseline: do marcador de início até (sem incluir) o
 * cabeçalho do PRÓXIMO bloco (`-- ---- `). Mesmo extrator de
 * planos-uso-migration.test.ts: cortar numa VARREDURA fixa quebraria no dia
 * em que outro bloco entrasse no meio.
 */
function extraiBlocoBaseline(): string {
  const marcadorInicio = "-- ---- carteira de tokens de IA (migration 0906";
  const posicaoMarcador = BASELINE.indexOf(marcadorInicio);
  const fim = BASELINE.indexOf("\n-- ---- ", posicaoMarcador);
  return BASELINE.slice(posicaoMarcador, fim + 1);
}

/** Remove linhas de comentário (--) e linhas em branco, para comparar só o SQL. */
function removeComentariosEBrancas(sql: string): string {
  return sql
    .split("\n")
    .map((linha) => linha.trim())
    .filter((linha) => linha.length > 0 && !linha.startsWith("--"))
    .join("\n");
}

describe("0906 carteira de tokens de IA (parte 1, Tarefa 1)", () => {
  it("o bloco do baseline vem depois do bloco da 0905 e antes da VARREDURA anon", () => {
    const inicioBloco0905 = BASELINE.indexOf("-- ---- uso dos planos e trava (migration 0905");
    const inicioBloco0906 = BASELINE.indexOf("-- ---- carteira de tokens de IA (migration 0906");
    const varreduraAnon = BASELINE.lastIndexOf("-- ---- VARREDURA anon:");

    expect(inicioBloco0905).toBeGreaterThan(-1);
    expect(inicioBloco0906).toBeGreaterThan(-1);
    expect(varreduraAnon).toBeGreaterThan(-1);
    expect(inicioBloco0905).toBeLessThan(inicioBloco0906);
    expect(inicioBloco0906).toBeLessThan(varreduraAnon);
  });

  it("o SQL da migração e o SQL do bloco do baseline são iguais, ignorando comentários e linhas em branco", () => {
    const sqlMigracao = removeComentariosEBrancas(MIGRATION);
    const sqlBloco = removeComentariosEBrancas(extraiBlocoBaseline());
    expect(sqlBloco).toBe(sqlMigracao);
  });

  it("billing_settings ganha os pesos, a marca de início e os três tetos, todos add column if not exists", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      expect(sql).toMatch(
        /alter table public\.billing_settings add column if not exists peso_cache_leitura_pct integer not null default 10;/,
      );
      expect(sql).toMatch(
        /alter table public\.billing_settings add column if not exists pesos_por_proposito jsonb not null default '\{"embedding_indexar": 0, "embedding_consultar": 0\}'::jsonb;/,
      );
      expect(sql).toMatch(
        /alter table public\.billing_settings add column if not exists carteira_desde timestamptz;/,
      );
      for (const teto of ["teto_org_tokens_dia", "teto_conversa_tokens_dia", "teto_instalacao_tokens_dia"]) {
        expect(sql).toMatch(
          new RegExp(`alter table public\\.billing_settings add column if not exists ${teto} bigint;`),
        );
        expect(sql).toMatch(
          new RegExp(`check \\(${teto} is null or ${teto} > 0\\)`),
        );
      }
    }
  });

  it("carteira_desde é preenchida uma vez com coalesce, nunca sobrescrita", () => {
    for (const sql of [MIGRATION, extraiBlocoBaseline()]) {
      expect(sql).toMatch(
        /update public\.billing_settings set carteira_desde = coalesce\(carteira_desde, now\(\)\) where id = 1;/,
      );
    }
  });

  it("pesos_por_proposito é validado por fn_billing_pesos_validos, criada ANTES do CHECK que a usa", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      const posFuncao = sql.indexOf("create or replace function public.fn_billing_pesos_validos(");
      const posCheck = sql.indexOf("billing_settings_pesos_por_proposito_check");
      expect(posFuncao).toBeGreaterThan(-1);
      expect(posCheck).toBeGreaterThan(posFuncao);
      expect(sql).toMatch(/check \(public\.fn_billing_pesos_validos\(pesos_por_proposito\)\)/);
    }
  });

  it("fn_billing_pesos_validos é immutable, plpgsql, e aceita conjunto de chaves aberto (0..100)", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      const inicio = sql.indexOf("create or replace function public.fn_billing_pesos_validos(");
      const trecho = sql.slice(inicio, inicio + 400);
      expect(trecho).toMatch(/language plpgsql/);
      expect(trecho).toMatch(/\bimmutable\b/);
      expect(trecho).toMatch(/set search_path = pg_catalog, pg_temp/);
      const corpo = sql.slice(inicio, sql.indexOf("$$;", inicio));
      expect(corpo).toMatch(/\(v_valor::text\)::int < 0/);
      expect(corpo).toMatch(/\(v_valor::text\)::int > 100/);
    }
  });

  it("as constraints novas de billing_settings são criadas de forma idempotente (if not exists em pg_constraint)", () => {
    for (const sql of [MIGRATION, extraiBlocoBaseline()]) {
      for (const nome of [
        "billing_settings_peso_cache_leitura_pct_check",
        "billing_settings_pesos_por_proposito_check",
        "billing_settings_teto_org_tokens_dia_check",
        "billing_settings_teto_conversa_tokens_dia_check",
        "billing_settings_teto_instalacao_tokens_dia_check",
      ]) {
        expect(sql).toMatch(
          new RegExp(`if not exists \\(select 1 from pg_constraint where conname = '${nome}'\\) then`),
        );
      }
    }
  });

  it("llm_calls ganha origem_da_chave (add column if not exists) com check nomeado idempotente", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      expect(sql).toMatch(/alter table public\.llm_calls add column if not exists origem_da_chave text;/);
      expect(sql).toMatch(
        /if not exists \(select 1 from pg_constraint where conname = 'llm_calls_origem_da_chave_check'\) then/,
      );
      expect(sql).toMatch(
        /check \(origem_da_chave is null or origem_da_chave in \('chave_da_instalacao', 'credencial_da_organizacao'\)\)/,
      );
    }
  });

  it("as quatro tabelas novas nascem com organization_id not null references organizations(id) on delete cascade", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      for (const tabela of TABELAS_NOVAS) {
        const inicio = sql.indexOf(`create table if not exists public.${tabela} (`);
        expect(inicio, `${tabela} não encontrada`).toBeGreaterThan(-1);
        const trecho = sql.slice(inicio, sql.indexOf("\n);", inicio));
        expect(trecho).toMatch(
          /organization_id uuid not null references public\.organizations\(id\) on delete cascade,/,
        );
      }
    }
  });

  it("billing_token_ledger: fonte fechada em plano|adicional|avulso, tokens bigint, chave única por organização", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      const inicio = sql.indexOf("create table if not exists public.billing_token_ledger (");
      const trecho = sql.slice(inicio, sql.indexOf("\n);", inicio));
      expect(trecho).toMatch(/constraint billing_token_ledger_fonte_check check \(fonte in \('plano', 'adicional', 'avulso'\)\)/);
      expect(trecho).toMatch(/tokens bigint not null,/);
      expect(trecho).toMatch(/constraint billing_token_ledger_org_chave_unique unique \(organization_id, chave\)/);
    }
  });

  it("billing_token_ledger: llm_call_id e criado_por são uuid SEM chave estrangeira, e llm_call_id fica indexado", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      const inicio = sql.indexOf("create table if not exists public.billing_token_ledger (");
      const trecho = sql.slice(inicio, sql.indexOf("\n);", inicio));
      // As duas colunas existem cruas, sem "references" na mesma linha.
      expect(trecho).toMatch(/^\s*llm_call_id uuid,$/m);
      expect(trecho).toMatch(/^\s*criado_por uuid,$/m);
      expect(trecho).not.toMatch(/llm_call_id uuid references/);
      expect(trecho).not.toMatch(/criado_por uuid references/);
    }
    for (const sql of [MIGRATION, extraiBlocoBaseline()]) {
      expect(sql).toMatch(
        /create index if not exists billing_token_ledger_llm_call_id_idx\s*\n\s*on public\.billing_token_ledger \(llm_call_id\);/,
      );
    }
  });

  it("billing_token_ledger: nota e valor_cents existem, valor_cents pode ser nulo", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      const inicio = sql.indexOf("create table if not exists public.billing_token_ledger (");
      const trecho = sql.slice(inicio, sql.indexOf("\n);", inicio));
      expect(trecho).toMatch(/^\s*nota text,$/m);
      expect(trecho).toMatch(/^\s*valor_cents bigint,$/m);
    }
  });

  it("billing_token_wallets: creditado/consumido bigint com unique nulls not distinct por organização, fonte e ciclo", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      const inicio = sql.indexOf("create table if not exists public.billing_token_wallets (");
      const trecho = sql.slice(inicio, sql.indexOf("\n);", inicio));
      expect(trecho).toMatch(/creditado bigint not null default 0,/);
      expect(trecho).toMatch(/consumido bigint not null default 0,/);
      expect(trecho).toMatch(
        /constraint billing_token_wallets_org_fonte_ciclo_unique unique nulls not distinct \(organization_id, fonte, ciclo\)/,
      );
    }
  });

  it("billing_token_consumo_diario: unique nulls not distinct por organização, dia, agente, contato e purpose, sem FK em agente/contato", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      const inicio = sql.indexOf("create table if not exists public.billing_token_consumo_diario (");
      const trecho = sql.slice(inicio, sql.indexOf("\n);", inicio));
      expect(trecho).toMatch(/^\s*agent_id uuid,$/m);
      expect(trecho).toMatch(/^\s*contact_id uuid,$/m);
      expect(trecho).not.toMatch(/agent_id uuid references/);
      expect(trecho).not.toMatch(/contact_id uuid references/);
      expect(trecho).toMatch(
        /constraint billing_token_consumo_diario_unique\s*\n\s*unique nulls not distinct \(organization_id, dia, agent_id, contact_id, purpose\)/,
      );
    }
    for (const sql of [MIGRATION, extraiBlocoBaseline()]) {
      expect(sql).toMatch(
        /create index if not exists billing_token_consumo_diario_org_dia_contato_idx\s*\n\s*on public\.billing_token_consumo_diario \(organization_id, dia, contact_id\);/,
      );
    }
  });

  it("RLS ligada nas quatro tabelas novas", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      for (const tabela of TABELAS_NOVAS) {
        expect(sql).toMatch(new RegExp(`alter table public\\.${tabela} enable row level security;`));
      }
    }
  });

  it("as quatro tabelas perdem tudo de anon e authenticated", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      expect(sql).toMatch(
        /revoke all on\s*\n\s*public\.billing_token_ledger,\s*\n\s*public\.billing_token_wallets,\s*\n\s*public\.billing_token_adicionais,\s*\n\s*public\.billing_token_consumo_diario\s*\n\s*from anon, authenticated;/,
      );
    }
  });

  it("carteira (wallets) e agregado (consumo_diario) ganham select para authenticated e policy de gerente/admin", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      expect(sql).toMatch(
        /grant select on public\.billing_token_wallets, public\.billing_token_consumo_diario to authenticated;/,
      );
      expect(sql).toMatch(/create policy billing_token_wallets_select on public\.billing_token_wallets/);
      expect(sql).toMatch(/create policy billing_token_consumo_diario_select on public\.billing_token_consumo_diario/);
      // As duas policies usam a mesma régua de "Plano e uso" (0905).
      const ocorrencias = [
        ...sql.matchAll(/public\.fn_role_at_least\(organization_id, 'manager'\) or public\.fn_is_platform_admin\(\)/g),
      ];
      expect(ocorrencias.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("livro-caixa e adicionais não têm select/policy para authenticated (privilégio nenhum, decisão 19)", () => {
    // Cada "grant ... to authenticated" desta migração, isolado por ";": nenhum
    // deles pode citar billing_token_ledger nem billing_token_adicionais. Não
    // usa um regex genérico "grant select ... billing_token_ledger" porque
    // "grant select, insert on public.billing_token_ledger to service_role"
    // (linha legítima) também casaria com esse padrão.
    const sqlSemComentarios = removeComentariosEBrancas(MIGRATION);
    const grantsParaAuthenticated = sqlSemComentarios
      .split(";")
      .filter((trecho) => /to authenticated\b/.test(trecho));
    expect(grantsParaAuthenticated.length).toBeGreaterThan(0);
    for (const trecho of grantsParaAuthenticated) {
      expect(trecho).not.toMatch(/billing_token_ledger/);
      expect(trecho).not.toMatch(/billing_token_adicionais/);
    }
    for (const sql of [MIGRATION, extraiBlocoBaseline()]) {
      expect(sql).not.toMatch(/create policy[^;]*on public\.billing_token_ledger/);
      expect(sql).not.toMatch(/create policy[^;]*on public\.billing_token_adicionais/);
    }
  });

  it("livro-caixa: service_role só ganha select e insert, sem update/delete/truncate (nem para ele)", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      expect(sql).toMatch(/grant select, insert on public\.billing_token_ledger to service_role;/);
      expect(sql).toMatch(/revoke update, delete, truncate on public\.billing_token_ledger from service_role;/);
      // Nenhum "grant all" nem "grant update"/"grant delete"/"grant truncate" tocando o livro-caixa.
      expect(sql).not.toMatch(/grant all[^;]*public\.billing_token_ledger/);
      expect(sql).not.toMatch(/grant update[^;]*public\.billing_token_ledger/);
    }
  });

  it("livro-caixa: nenhum gatilho BEFORE UPDATE/DELETE na tabela", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      expect(sql).not.toMatch(/create trigger[^;]*billing_token_ledger/);
    }
  });

  it("fn_billing_ciclo_de é STABLE, com search_path fixo, execute só service_role", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      const inicio = sql.indexOf("create or replace function public.fn_billing_ciclo_de(");
      expect(inicio).toBeGreaterThan(-1);
      const trecho = sql.slice(inicio, inicio + 300);
      expect(trecho).toMatch(/\bstable\b/);
      expect(trecho).not.toMatch(/\bimmutable\b/);
      expect(trecho).toMatch(/set search_path = pg_catalog, pg_temp/);
      expect(sql).toMatch(
        /revoke execute on function public\.fn_billing_ciclo_de\(timestamptz\) from public, anon, authenticated;/,
      );
      expect(sql).toMatch(
        /grant execute on function public\.fn_billing_ciclo_de\(timestamptz\) to service_role;/,
      );
    }
  });

  it("fn_billing_ciclo_de: primeiro dia do mês no fuso America/Sao_Paulo", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      expect(sql).toMatch(
        /select date_trunc\('month', p_momento at time zone 'America\/Sao_Paulo'\)::date/,
      );
    }
  });

  it("fn_billing_tokens_ponderados é IMMUTABLE, com search_path fixo, execute só service_role", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      const inicio = sql.indexOf("create or replace function public.fn_billing_tokens_ponderados(");
      expect(inicio).toBeGreaterThan(-1);
      const trecho = sql.slice(inicio, inicio + 500);
      expect(trecho).toMatch(/\bimmutable\b/);
      expect(trecho).toMatch(/set search_path = pg_catalog, pg_temp/);
      expect(sql).toMatch(
        /revoke execute on function public\.fn_billing_tokens_ponderados\(int, int, int, int, int\) from public, anon, authenticated;/,
      );
      expect(sql).toMatch(
        /grant execute on function public\.fn_billing_tokens_ponderados\(int, int, int, int, int\) to service_role;/,
      );
    }
  });

  it("fn_billing_tokens_ponderados: a fórmula exata da decisão 1 (greatest, ceil, os dois pesos)", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      const inicio = sql.indexOf("create or replace function public.fn_billing_tokens_ponderados(");
      const corpo = sql.slice(inicio, sql.indexOf("$$;", inicio));
      expect(corpo).toMatch(/greatest\(p_input - p_cache_read, 0\)/);
      expect(corpo).toMatch(/p_cache_read::numeric \* p_peso_cache::numeric \/ 100/);
      expect(corpo).toMatch(/\* p_peso_proposito::numeric \/ 100/);
      expect(corpo).toMatch(/select ceil\(/);
    }
  });

  it("o bloco da role agent_worker revoga escrita nas quatro tabelas e execute das duas funções novas", () => {
    for (const sql of [MIGRATION, extraiBlocoBaseline()]) {
      expect(sql).toMatch(/if exists \(select 1 from pg_roles where rolname = 'agent_worker'\) then/);
      expect(sql).toMatch(
        /revoke insert, update, delete, truncate on public\.billing_token_ledger, public\.billing_token_wallets, public\.billing_token_adicionais, public\.billing_token_consumo_diario from agent_worker/,
      );
      expect(sql).toMatch(
        /revoke execute on function public\.fn_billing_ciclo_de\(timestamptz\), public\.fn_billing_tokens_ponderados\(int, int, int, int, int\) from agent_worker/,
      );
    }
  });
});

const FUNCOES_PARTE2 = [
  "fn_billing_garantir_concessoes(uuid, date)",
  "fn_billing_debitar_chamada(uuid)",
  "fn_billing_trg_debitar_chamada()",
] as const;

describe("0906 carteira de tokens de IA (parte 2, Tarefa 2a)", () => {
  it("a parte 2 está no MESMO arquivo da parte 1, depois dela, e o bloco do baseline continua idêntico ao arquivo inteiro da migração", () => {
    const sqlMigracao = removeComentariosEBrancas(MIGRATION);
    const sqlBloco = removeComentariosEBrancas(extraiBlocoBaseline());
    expect(sqlBloco).toBe(sqlMigracao);
    // A parte 2 vem DEPOIS do bloco final de agent_worker da parte 1 (item 9).
    const fimParte1 = MIGRATION.indexOf(
      "9. agent_worker não escreve nem confere carteira pelas peças novas desta",
    );
    const inicioParte2 = MIGRATION.indexOf("fn_billing_garantir_concessoes: concessão preguiçosa");
    expect(fimParte1).toBeGreaterThan(-1);
    expect(inicioParte2).toBeGreaterThan(fimParte1);
  });

  it("as três funções novas são security definer, com search_path fixo em public, pg_temp", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      for (const assinatura of FUNCOES_PARTE2) {
        const nome = assinatura.split("(")[0];
        const inicio = sql.indexOf(`create or replace function public.${nome}(`);
        expect(inicio, `${nome} não encontrada`).toBeGreaterThan(-1);
        const trecho = sql.slice(inicio, inicio + 500);
        expect(trecho).toMatch(/security definer/);
        expect(trecho).toMatch(/set search_path = public, pg_temp/);
      }
    }
  });

  it("fn_billing_trg_debitar_chamada tem lock_timeout de 1s no próprio create function", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      const inicio = sql.indexOf("create or replace function public.fn_billing_trg_debitar_chamada()");
      const fimCorpo = sql.indexOf("as $$", inicio);
      const cabecalho = sql.slice(inicio, fimCorpo);
      expect(cabecalho).toMatch(/set lock_timeout = '1s'/);
    }
  });

  it("fn_billing_trg_debitar_chamada: corpo inteiro em begin...exception when others, nunca derruba o insert", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      const inicio = sql.indexOf("create or replace function public.fn_billing_trg_debitar_chamada()");
      const corpo = sql.slice(inicio, sql.indexOf("$$;", inicio));
      expect(corpo).toMatch(/\bbegin\b/);
      expect(corpo).toMatch(/perform public\.fn_billing_debitar_chamada\(new\.id\);/);
      expect(corpo).toMatch(/exception\s*\n\s*when others then/);
      expect(corpo).toMatch(/raise warning/);
      // Duas saídas "return null": uma no fluxo normal, outra no handler de exceção.
      expect([...corpo.matchAll(/return null;/g)].length).toBeGreaterThanOrEqual(2);
    }
  });

  it("o gatilho after insert em llm_calls chama a função de débito", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      expect(sql).toMatch(
        /create trigger trg_billing_debitar_llm_call\s*\n\s*after insert on public\.llm_calls\s*\n\s*for each row\s*\n\s*execute function public\.fn_billing_trg_debitar_chamada\(\);/,
      );
      expect(sql).toMatch(/drop trigger if exists trg_billing_debitar_llm_call on public\.llm_calls;/);
    }
  });

  it("fn_billing_debitar_chamada usa pg_try_advisory_xact_lock (não pg_advisory_xact_lock) pela chave billing_tokens:<org>", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      const inicio = sql.indexOf("create or replace function public.fn_billing_debitar_chamada(");
      const corpo = sql.slice(inicio, sql.indexOf("$$;", inicio));
      expect(corpo).toMatch(
        /pg_try_advisory_xact_lock\(hashtextextended\('billing_tokens:' \|\| v_chamada\.organization_id::text, 0\)\)/,
      );
      // Garante que NÃO é a variante bloqueante em nenhum ponto do corpo.
      expect(corpo).not.toMatch(/[^_]pg_advisory_xact_lock\(/);
    }
  });

  it("fn_billing_debitar_chamada sai sem debitar em legacy_invocation_id, origem_da_chave errada e created_at anterior à carteira", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      const inicio = sql.indexOf("create or replace function public.fn_billing_debitar_chamada(");
      const corpo = sql.slice(inicio, sql.indexOf("$$;", inicio));
      expect(corpo).toMatch(/if v_chamada\.legacy_invocation_id is not null then\s*\n\s*return false;/);
      expect(corpo).toMatch(
        /if v_chamada\.origem_da_chave is distinct from 'chave_da_instalacao' then\s*\n\s*return false;/,
      );
      expect(corpo).toMatch(/if v_chamada\.created_at < v_settings\.carteira_desde then\s*\n\s*return false;/);
      expect(corpo).toMatch(/if v_ponderado = 0 then\s*\n\s*return false;/);
    }
  });

  it("fn_billing_debitar_chamada calcula ciclo e dia SEMPRE de created_at da chamada, nunca de now()", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      const inicio = sql.indexOf("create or replace function public.fn_billing_debitar_chamada(");
      const corpo = sql.slice(inicio, sql.indexOf("$$;", inicio));
      expect(corpo).toMatch(/v_ciclo := public\.fn_billing_ciclo_de\(v_chamada\.created_at\);/);
      expect(corpo).toMatch(
        /v_dia := \(v_chamada\.created_at at time zone 'America\/Sao_Paulo'\)::date;/,
      );
    }
  });

  it("fn_billing_debitar_chamada divide plano, adicional, avulso nesta ordem e soma a sobra na linha de plano", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      const inicio = sql.indexOf("create or replace function public.fn_billing_debitar_chamada(");
      const corpo = sql.slice(inicio, sql.indexOf("$$;", inicio));
      const posPlano = corpo.indexOf("fonte = 'plano' and ciclo = v_ciclo");
      const posAdicional = corpo.indexOf("fonte = 'adicional' and ciclo = v_ciclo");
      const posAvulso = corpo.indexOf("fonte = 'avulso' and ciclo is null");
      const posSobra = corpo.indexOf("v_debito_plano := v_debito_plano + v_restante;");
      expect(posPlano).toBeGreaterThan(-1);
      expect(posAdicional).toBeGreaterThan(posPlano);
      expect(posAvulso).toBeGreaterThan(posAdicional);
      expect(posSobra).toBeGreaterThan(posAvulso);
      // Cada fonte só grava UMA linha por chamada (chave por fonte, on conflict do nothing).
      expect(corpo).toMatch(/'consumo:' \|\| p_llm_call_id::text \|\| ':plano'/);
      expect(corpo).toMatch(/'consumo:' \|\| p_llm_call_id::text \|\| ':adicional'/);
      expect(corpo).toMatch(/'consumo:' \|\| p_llm_call_id::text \|\| ':avulso'/);
      expect([...corpo.matchAll(/on conflict \(organization_id, chave\) do nothing;/g)].length).toBe(3);
    }
  });

  it("fn_billing_debitar_chamada só atualiza a carteira e o agregado quando alguma linha de consumo entrou de fato (get diagnostics row_count)", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      const inicio = sql.indexOf("create or replace function public.fn_billing_debitar_chamada(");
      const corpo = sql.slice(inicio, sql.indexOf("$$;", inicio));
      expect([...corpo.matchAll(/get diagnostics v_linhas = row_count;/g)].length).toBe(3);
      expect(corpo).toMatch(/v_entrou := true;/);
      expect(corpo).toMatch(/if v_entrou then\s*\n\s*insert into public\.billing_token_consumo_diario/);
      expect(corpo).toMatch(/return v_entrou;/);
    }
  });

  it("fn_billing_garantir_concessoes nunca concede para ciclo anterior ao ciclo atual e não concede no Ilimitado (teto nulo)", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      const inicio = sql.indexOf("create or replace function public.fn_billing_garantir_concessoes(");
      const corpo = sql.slice(inicio, sql.indexOf("$$;", inicio));
      expect(corpo).toMatch(/if p_ciclo < public\.fn_billing_ciclo_de\(now\(\)\) then\s*\n\s*return;/);
      expect(corpo).toMatch(/if v_teto is not null then/);
      expect(corpo).toMatch(
        /v_teto := \(public\.fn_billing_limites_efetivos\(p_org\) ->> 'tokens_ia_mes'\)::bigint;/,
      );
    }
  });

  it("as três funções novas: revoke de public/anon/authenticated e grant só para service_role", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      for (const assinatura of FUNCOES_PARTE2) {
        expect(sql).toMatch(
          new RegExp(
            `revoke execute on function public\\.${assinatura.replace(/[()]/g, (c) => `\\${c}`)} from public, anon, authenticated;`,
          ),
        );
        expect(sql).toMatch(
          new RegExp(
            `grant execute on function public\\.${assinatura.replace(/[()]/g, (c) => `\\${c}`)} to service_role;`,
          ),
        );
      }
    }
  });

  it("o bloco da role agent_worker da parte 2 revoga execute das três funções novas", () => {
    for (const sql of [MIGRATION, extraiBlocoBaseline()]) {
      expect(sql).toMatch(
        /revoke execute on function public\.fn_billing_garantir_concessoes\(uuid, date\), public\.fn_billing_debitar_chamada\(uuid\), public\.fn_billing_trg_debitar_chamada\(\) from agent_worker/,
      );
    }
  });

  it("livro-caixa continua sem nenhum gatilho na parte 2 (o gatilho novo é em llm_calls, não em billing_token_ledger)", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      expect(sql).not.toMatch(/create trigger[^;]*on public\.billing_token_ledger/);
    }
  });
});
