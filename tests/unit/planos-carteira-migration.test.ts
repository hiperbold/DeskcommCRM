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

describe("0906 carteira de tokens de IA (parte 3, Tarefa 2b)", () => {
  it("a parte 3 está no MESMO arquivo, depois da parte 2, e o bloco do baseline continua idêntico ao arquivo inteiro da migração", () => {
    const sqlMigracao = removeComentariosEBrancas(MIGRATION);
    const sqlBloco = removeComentariosEBrancas(extraiBlocoBaseline());
    expect(sqlBloco).toBe(sqlMigracao);
    const fimParte2 = MIGRATION.indexOf(
      "13. agent_worker não concede nem debita pelas peças novas desta parte 2",
    );
    const inicioParte3 = MIGRATION.indexOf("14. billing_token_avisos_emitidos: dedup dos avisos de carteira");
    expect(fimParte2).toBeGreaterThan(-1);
    expect(inicioParte3).toBeGreaterThan(fimParte2);
  });

  it("billing_token_avisos_emitidos: chave única por organização, sem update/delete/truncate para ninguém", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      const inicio = sql.indexOf("create table if not exists public.billing_token_avisos_emitidos (");
      expect(inicio, "tabela não encontrada").toBeGreaterThan(-1);
      const trecho = sql.slice(inicio, sql.indexOf("\n);", inicio));
      expect(trecho).toMatch(
        /organization_id uuid not null references public\.organizations\(id\) on delete cascade,/,
      );
      expect(trecho).toMatch(
        /constraint billing_token_avisos_emitidos_org_chave_unique unique \(organization_id, chave\)/,
      );
      expect(sql).toMatch(/alter table public\.billing_token_avisos_emitidos enable row level security;/);
      expect(sql).toMatch(/revoke all on public\.billing_token_avisos_emitidos from anon, authenticated;/);
      expect(sql).toMatch(/grant select, insert on public\.billing_token_avisos_emitidos to service_role;/);
      expect(sql).toMatch(
        /revoke update, delete, truncate on public\.billing_token_avisos_emitidos from service_role;/,
      );
      // Ninguém (nem authenticated, nem service_role) ganha update/delete/truncate.
      expect(sql).not.toMatch(/grant update[^;]*public\.billing_token_avisos_emitidos/);
      expect(sql).not.toMatch(/grant delete[^;]*public\.billing_token_avisos_emitidos/);
      expect(sql).not.toMatch(/create policy[^;]*on public\.billing_token_avisos_emitidos/);
      expect(sql).not.toMatch(/create trigger[^;]*billing_token_avisos_emitidos/);
    }
  });

  it("fn_billing_avisar_carteira é security definer, com search_path fixo em public, pg_temp", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      const inicio = sql.indexOf("create or replace function public.fn_billing_avisar_carteira(");
      expect(inicio, "função não encontrada").toBeGreaterThan(-1);
      const trecho = sql.slice(inicio, inicio + 400);
      expect(trecho).toMatch(/security definer/);
      expect(trecho).toMatch(/set search_path = public, pg_temp/);
    }
  });

  it("fn_billing_avisar_carteira: revoke de public/anon/authenticated e grant só para service_role", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      expect(sql).toMatch(
        /revoke execute on function public\.fn_billing_avisar_carteira\(uuid, date, date, uuid\) from public, anon, authenticated;/,
      );
      expect(sql).toMatch(
        /grant execute on function public\.fn_billing_avisar_carteira\(uuid, date, date, uuid\) to service_role;/,
      );
    }
  });

  it("fn_billing_debitar_chamada chama fn_billing_avisar_carteira só quando entrou E o ciclo da chamada é o ciclo ATUAL", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      const inicio = sql.indexOf("create or replace function public.fn_billing_debitar_chamada(");
      const corpo = sql.slice(inicio, sql.indexOf("$$;", inicio));
      expect(corpo).toMatch(
        /if v_entrou and v_ciclo = public\.fn_billing_ciclo_de\(now\(\)\) then\s*\n\s*perform public\.fn_billing_avisar_carteira\(v_chamada\.organization_id, v_ciclo, v_dia, v_chamada\.contact_id\);\s*\n\s*end if;/,
      );
      // A chamada do aviso vem DEPOIS do bloco que atualiza o agregado
      // (só faz sentido avisar depois de o consumo ter sido contabilizado).
      const posAgregado = corpo.indexOf("insert into public.billing_token_consumo_diario");
      const posAviso = corpo.indexOf("perform public.fn_billing_avisar_carteira(");
      expect(posAgregado).toBeGreaterThan(-1);
      expect(posAviso).toBeGreaterThan(posAgregado);
    }
  });

  it("fn_billing_avisar_carteira nunca lança: corpo inteiro sob exception when others / raise warning", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      const inicio = sql.indexOf("create or replace function public.fn_billing_avisar_carteira(");
      const corpo = sql.slice(inicio, sql.indexOf("$$;", inicio));
      expect(corpo).toMatch(/exception\s*\n\s*when others then/);
      expect(corpo).toMatch(/raise warning 'billing_avisar_carteira_falhou/);
    }
  });

  it("fn_billing_avisar_carteira: limiares 50/80/100 só avisam com teto efetivo (Ilimitado nunca avisa por teto nulo), avulso soma pela proporção do ciclo corrente, dedup por billing_token_avisos_emitidos", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      const inicio = sql.indexOf("create or replace function public.fn_billing_avisar_carteira(");
      const corpo = sql.slice(inicio, sql.indexOf("$$;", inicio));
      // Ilimitado (teto efetivo nulo) nunca avisa por limiar, mesmo que
      // v_teto_total (plano+adicional do ciclo, mais avulso) seja positivo.
      expect(corpo).toMatch(/if v_teto_efetivo is not null and v_teto_total > 0 then/);
      // Avulso entra pela proporção do MÊS (item 2 da revisão): creditado
      // (vida inteira) menos o consumido em ciclos ANTERIORES a este; o
      // consumido do ciclo soma só o consumo do avulso deste ciclo.
      expect(corpo).toMatch(
        /v_teto_total := v_teto_total \+ \(coalesce\(v_avulso_creditado_total, 0\) - v_avulso_consumido_antes\);/,
      );
      expect(corpo).toMatch(/v_consumido_ciclo := v_consumido_ciclo \+ v_avulso_consumido_mes;/);
      expect(corpo).toMatch(/foreach v_limiar in array array\[50, 80, 100\] loop/);
      expect(corpo).toMatch(/v_consumido_ciclo \* 100 >= v_teto_total \* v_limiar/);
      expect(corpo).toMatch(
        /'limiar:' \|\| to_char\(p_ciclo, 'YYYY-MM-DD'\) \|\| ':' \|\| v_limiar::text/,
      );
      expect(corpo).toMatch(/on conflict \(organization_id, chave\) do nothing;/);
      expect(corpo).toMatch(/get diagnostics v_linhas = row_count;/);
      // Texto fixo: só o número do limiar e o mês, nenhum outro dado do banco.
      expect(corpo).toMatch(
        /'Tokens de IA: ' \|\| v_limiar::text \|\| '% do mês usado \(' \|\| v_mes_ano \|\| '\)'/,
      );
    }
  });

  it("fn_billing_avisar_carteira: travas por organização e por conversa lidas de billing_settings, nulo desliga, chave por to_char (YYYY-MM-DD)", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      const inicio = sql.indexOf("create or replace function public.fn_billing_avisar_carteira(");
      const corpo = sql.slice(inicio, sql.indexOf("$$;", inicio));
      expect(corpo).toMatch(
        /select teto_org_tokens_dia, teto_conversa_tokens_dia\s*\n\s*into v_teto_org_dia, v_teto_conversa_dia\s*\n\s*from public\.billing_settings/,
      );
      expect(corpo).toMatch(/if v_teto_org_dia is not null then/);
      expect(corpo).toMatch(/if v_teto_conversa_dia is not null and p_contact_id is not null then/);
      // Item 8 da revisão: to_char('YYYY-MM-DD'), não ::text (não depende do
      // DateStyle da sessão).
      expect(corpo).toMatch(/'teto_org_dia:' \|\| to_char\(p_dia, 'YYYY-MM-DD'\)/);
      expect(corpo).toMatch(
        /'teto_conversa_dia:' \|\| to_char\(p_dia, 'YYYY-MM-DD'\) \|\| ':' \|\| p_contact_id::text/,
      );
      // teto_instalacao_tokens_dia NÃO é LIDO nem SOMADO aqui (decisão 15: é
      // do conferidor, Tarefa 8); só o comentário explicando o porquê pode
      // citar o nome da coluna, nunca um "select"/variável funcional.
      expect(corpo).not.toMatch(/select[^;]*teto_instalacao_tokens_dia/is);
      expect(corpo).not.toMatch(/v_teto_instalacao/);
    }
  });

  it("o bloco da role agent_worker da parte 3 revoga escrita na tabela nova e execute da função nova", () => {
    for (const sql of [MIGRATION, extraiBlocoBaseline()]) {
      expect(sql).toMatch(
        /revoke insert, update, delete, truncate on public\.billing_token_avisos_emitidos from agent_worker/,
      );
      expect(sql).toMatch(
        /revoke execute on function public\.fn_billing_avisar_carteira\(uuid, date, date, uuid\) from agent_worker/,
      );
    }
  });
});

const FUNCOES_PARTE4 = [
  "fn_billing_creditar_tokens(uuid, bigint, uuid, bigint, text, uuid)",
  "fn_billing_contratar_adicional(uuid, bigint, uuid, bigint, text, uuid)",
  "fn_billing_cancelar_adicional(uuid, uuid, uuid)",
  "fn_billing_ajustar_tokens(uuid, text, bigint, uuid, uuid, text, uuid)",
  "fn_billing_saldo_da_carteira(uuid)",
  "fn_billing_conferir_carteira(uuid)",
  "fn_billing_debitos_pendentes(uuid, integer)",
  "fn_billing_consumo_da_instalacao_no_dia(date)",
] as const;

// Admin (decisão 16) e conferidor de carteira (decisão 8, Tarefa 8): travam
// com pg_advisory_xact_lock BLOQUEANTE, mesma chave do débito. Deliberadamente
// NÃO inclui fn_billing_saldo_da_carteira (usa a variante _try_, exigida pelo
// próprio comentário de fn_billing_garantir_concessoes na Parte 2) nem
// fn_billing_debitos_pendentes/fn_billing_consumo_da_instalacao_no_dia
// (leituras puras, sem trava nenhuma).
const FUNCOES_ADMIN_E_CONFERENCIA_TRAVA_BLOQUEANTE = [
  "fn_billing_creditar_tokens",
  "fn_billing_contratar_adicional",
  "fn_billing_cancelar_adicional",
  "fn_billing_ajustar_tokens",
  "fn_billing_conferir_carteira",
] as const;

describe("0906 carteira de tokens de IA (parte 4, Tarefas 4, 5 e 8)", () => {
  it("a parte 4 está no MESMO arquivo, depois da parte 3, e o bloco do baseline continua idêntico ao arquivo inteiro da migração", () => {
    const sqlMigracao = removeComentariosEBrancas(MIGRATION);
    const sqlBloco = removeComentariosEBrancas(extraiBlocoBaseline());
    expect(sqlBloco).toBe(sqlMigracao);
    const fimParte3 = MIGRATION.indexOf(
      "16. agent_worker não emite aviso de carteira nem escreve na tabela nova",
    );
    const inicioParte4 = MIGRATION.indexOf(
      "17. billing_token_ledger ganha ciclo e compensa_id",
    );
    expect(fimParte3).toBeGreaterThan(-1);
    expect(inicioParte4).toBeGreaterThan(fimParte3);
  });

  it("billing_token_ledger ganha ciclo e compensa_id por add column if not exists, sem FK", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      expect(sql).toMatch(/alter table public\.billing_token_ledger add column if not exists ciclo date;/);
      expect(sql).toMatch(
        /alter table public\.billing_token_ledger add column if not exists compensa_id uuid;/,
      );
      // Nenhuma das duas colunas novas ganha "references" (sem FK, mesmo
      // racional de llm_call_id e criado_por, decisão 7).
      expect(sql).not.toMatch(/compensa_id uuid references/);
    }
  });

  it("billing_token_wallets_creditado_nao_negativo é derrubada (ajuste negativo pode deixar creditado negativo)", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      expect(sql).toMatch(
        /alter table public\.billing_token_wallets drop constraint if exists billing_token_wallets_creditado_nao_negativo;/,
      );
    }
  });

  it("as oito funções novas são security definer, com search_path fixo em public, pg_temp", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      for (const assinatura of FUNCOES_PARTE4) {
        const nome = assinatura.split("(")[0];
        const inicio = sql.indexOf(`create or replace function public.${nome}(`);
        expect(inicio, `${nome} não encontrada`).toBeGreaterThan(-1);
        const trecho = sql.slice(inicio, inicio + 700);
        expect(trecho).toMatch(/security definer/);
        expect(trecho).toMatch(/set search_path = public, pg_temp/);
      }
    }
  });

  it("as oito funções novas: revoke de public/anon/authenticated e grant só para service_role", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      for (const assinatura of FUNCOES_PARTE4) {
        const escapado = assinatura.replace(/[()]/g, (c) => `\\${c}`);
        expect(sql).toMatch(
          new RegExp(`revoke execute on function public\\.${escapado} from public, anon, authenticated;`),
        );
        expect(sql).toMatch(
          new RegExp(`grant execute on function public\\.${escapado} to service_role;`),
        );
      }
    }
  });

  it("o bloco da role agent_worker da parte 4 revoga execute das oito funções novas", () => {
    for (const sql of [MIGRATION, extraiBlocoBaseline()]) {
      for (const assinatura of FUNCOES_PARTE4) {
        const nome = assinatura.split("(")[0];
        expect(sql).toMatch(new RegExp(`public\\.${nome}\\(`));
      }
      expect(sql).toMatch(
        /revoke execute on function public\.fn_billing_creditar_tokens\([^)]*\), public\.fn_billing_contratar_adicional\([^)]*\), public\.fn_billing_cancelar_adicional\([^)]*\), public\.fn_billing_ajustar_tokens\([^)]*\), public\.fn_billing_saldo_da_carteira\(uuid\), public\.fn_billing_conferir_carteira\(uuid\), public\.fn_billing_debitos_pendentes\(uuid, integer\), public\.fn_billing_consumo_da_instalacao_no_dia\(date\) from agent_worker/,
      );
    }
  });

  it("as funções do admin e a do conferidor de carteira travam com pg_advisory_xact_lock BLOQUEANTE, chave billing_tokens:<org>", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      for (const nome of FUNCOES_ADMIN_E_CONFERENCIA_TRAVA_BLOQUEANTE) {
        const inicio = sql.indexOf(`create or replace function public.${nome}(`);
        expect(inicio, `${nome} não encontrada`).toBeGreaterThan(-1);
        const corpo = sql.slice(inicio, sql.indexOf("$$;", inicio));
        expect(corpo, `${nome} sem pg_advisory_xact_lock bloqueante`).toMatch(
          /pg_advisory_xact_lock\(hashtextextended\('billing_tokens:' \|\| p_org::text, 0\)\)/,
        );
        // Garante que NÃO é a variante _try_ (essa é só do débito e da leitura de saldo).
        expect(corpo).not.toMatch(/pg_try_advisory_xact_lock\(/);
      }
    }
  });

  it("fn_billing_saldo_da_carteira usa pg_try_advisory_xact_lock (não a variante bloqueante), mesma chave billing_tokens:<org>", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      const inicio = sql.indexOf("create or replace function public.fn_billing_saldo_da_carteira(");
      const corpo = sql.slice(inicio, sql.indexOf("$$;", inicio));
      expect(corpo).toMatch(
        /pg_try_advisory_xact_lock\(hashtextextended\('billing_tokens:' \|\| p_org::text, 0\)\)/,
      );
      expect(corpo).not.toMatch(/[^_]pg_advisory_xact_lock\(/);
    }
  });

  it("fn_billing_debitos_pendentes e fn_billing_consumo_da_instalacao_no_dia não travam (leitura pura)", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      for (const nome of ["fn_billing_debitos_pendentes", "fn_billing_consumo_da_instalacao_no_dia"]) {
        const inicio = sql.indexOf(`create or replace function public.${nome}(`);
        const corpo = sql.slice(inicio, sql.indexOf("$$;", inicio));
        expect(corpo).not.toMatch(/advisory_xact_lock/);
      }
    }
  });

  it("fn_billing_creditar_tokens recusa tokens <= 0 com errcode fixo 22023", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      const inicio = sql.indexOf("create or replace function public.fn_billing_creditar_tokens(");
      const corpo = sql.slice(inicio, sql.indexOf("$$;", inicio));
      expect(corpo).toMatch(
        /if p_tokens <= 0 then\s*\n\s*raise exception 'credito_tokens_deve_ser_positivo' using errcode = '22023';/,
      );
    }
  });

  it("fn_billing_contratar_adicional grava id = p_chave (idempotente) e concede o ciclo atual", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      const inicio = sql.indexOf("create or replace function public.fn_billing_contratar_adicional(");
      const corpo = sql.slice(inicio, sql.indexOf("$$;", inicio));
      expect(corpo).toMatch(
        /insert into public\.billing_token_adicionais \(id, organization_id, tokens_por_ciclo, valor_cents, nota, criado_por\)\s*\n\s*values \(p_chave, p_org,/,
      );
      expect(corpo).toMatch(/on conflict \(id\) do nothing;/);
      expect(corpo).toMatch(
        /perform public\.fn_billing_garantir_concessoes\(p_org, public\.fn_billing_ciclo_de\(now\(\)\)\);/,
      );
    }
  });

  it("fn_billing_cancelar_adicional: adicional inexistente é P0002, de outra organização é 42501, idempotente", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      const inicio = sql.indexOf("create or replace function public.fn_billing_cancelar_adicional(");
      const corpo = sql.slice(inicio, sql.indexOf("$$;", inicio));
      expect(corpo).toMatch(
        /if not found then\s*\n\s*raise exception 'adicional_nao_encontrado' using errcode = 'P0002';/,
      );
      expect(corpo).toMatch(
        /if v_org_dono <> p_org then\s*\n\s*raise exception 'adicional_de_outra_organizacao' using errcode = '42501';/,
      );
      expect(corpo).toMatch(/if v_ativo then/);
    }
  });

  it("fn_billing_ajustar_tokens: tokens zero, fonte inválida e nota vazia recusados com 22023; compensa de outra organização com 42501", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      const inicio = sql.indexOf("create or replace function public.fn_billing_ajustar_tokens(");
      const corpo = sql.slice(inicio, sql.indexOf("$$;", inicio));
      expect(corpo).toMatch(
        /if p_tokens = 0 then\s*\n\s*raise exception 'ajuste_tokens_nao_pode_ser_zero' using errcode = '22023';/,
      );
      expect(corpo).toMatch(
        /if p_fonte not in \('plano', 'adicional', 'avulso'\) then\s*\n\s*raise exception 'ajuste_fonte_invalida' using errcode = '22023';/,
      );
      expect(corpo).toMatch(
        /if p_nota is null or btrim\(p_nota\) = '' then\s*\n\s*raise exception 'ajuste_precisa_de_nota' using errcode = '22023';/,
      );
      expect(corpo).toMatch(
        /raise exception 'ajuste_compensa_linha_invalida' using errcode = '42501';/,
      );
    }
  });

  it("fn_billing_ajustar_tokens: ciclo atual para plano/adicional, nulo para avulso; upsert soma o sinal em creditado, nunca em consumido", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      const inicio = sql.indexOf("create or replace function public.fn_billing_ajustar_tokens(");
      const corpo = sql.slice(inicio, sql.indexOf("$$;", inicio));
      expect(corpo).toMatch(
        /v_ciclo := case when p_fonte = 'avulso' then null else public\.fn_billing_ciclo_de\(now\(\)\) end;/,
      );
      expect(corpo).toMatch(/chave, ciclo, compensa_id, nota, criado_por\)/);
      expect(corpo).toMatch(
        /set creditado = public\.billing_token_wallets\.creditado \+ excluded\.creditado,\s*\n\s*updated_at = now\(\);/,
      );
      expect(corpo).not.toMatch(/consumido = public\.billing_token_wallets\.consumido/);
    }
  });

  it("fn_billing_saldo_da_carteira garante concessões, devolve por_fonte com as três fontes, sem_limite e totais do ciclo", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      const inicio = sql.indexOf("create or replace function public.fn_billing_saldo_da_carteira(");
      const corpo = sql.slice(inicio, sql.indexOf("$$;", inicio));
      expect(corpo).toMatch(/perform public\.fn_billing_garantir_concessoes\(p_org, v_ciclo\);/);
      expect(corpo).toMatch(/from \(values \('plano'\), \('adicional'\), \('avulso'\)\) as f\(fonte\)/);
      expect(corpo).toMatch(/'sem_limite', v_teto is null,/);
      expect(corpo).toMatch(/'total_disponivel', v_disponivel,/);
      expect(corpo).toMatch(/'total_consumido', v_consumido/);
    }
  });

  it("fn_billing_conferir_carteira recalcula só o ciclo atual, o anterior e o avulso (creditado por concessão/crédito/ajuste, consumido por chave), e corrige divergência", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      const inicio = sql.indexOf("create or replace function public.fn_billing_conferir_carteira(");
      const corpo = sql.slice(inicio, sql.indexOf("$$;", inicio));
      expect(corpo).toMatch(/for v_linha in\s*\n\s*select id, fonte, ciclo, creditado, consumido/);
      // Item 5 da revisão: varre só o ciclo atual, o anterior (débito tardio
      // ainda pode gravar nele) e o avulso (nunca tem ciclo, nunca fecha),
      // não a carteira inteira desde carteira_desde.
      expect(corpo).toMatch(
        /from public\.billing_token_wallets\s*\n\s*where organization_id = p_org\s*\n\s*and \(ciclo in \(v_ciclo_atual, v_ciclo_anterior\) or fonte = 'avulso'\)\s*\n\s*for update/,
      );
      expect(corpo).toMatch(/v_ciclo_atual date := public\.fn_billing_ciclo_de\(now\(\)\);/);
      expect(corpo).toMatch(
        /v_ciclo_anterior date := \(public\.fn_billing_ciclo_de\(now\(\)\) - interval '1 month'\)::date;/,
      );
      // Item 8 da revisão: to_char('YYYY-MM-DD') na comparação com a chave,
      // não ::text (a chave foi gravada com a mesma conversão).
      expect(corpo).toMatch(/l\.chave = 'plano:' \|\| to_char\(v_linha\.ciclo, 'YYYY-MM-DD'\)/);
      expect(corpo).toMatch(
        /l\.chave like 'adicional:%:' \|\| to_char\(v_linha\.ciclo, 'YYYY-MM-DD'\)/,
      );
      expect(corpo).toMatch(/l\.chave like 'credito:%'/);
      expect(corpo).toMatch(/l\.chave like 'ajuste:%' and l\.ciclo is not distinct from v_linha\.ciclo/);
      expect(corpo).toMatch(/l\.chave like 'consumo:%'/);
      expect(corpo).toMatch(
        /if v_linha\.creditado <> v_creditado_real or v_linha\.consumido <> v_consumido_real then/,
      );
      expect(corpo).toMatch(/v_divergentes := v_divergentes \+ 1;/);
      expect(corpo).toMatch(/return v_divergentes;/);
    }
  });

  it("fn_billing_debitos_pendentes usa os mesmos filtros do débito (carteira_desde/pesos_alterados_em/35 dias, legacy nulo, chave da instalação, ponderado > 0) e anti-join por llm_call_id", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      const inicio = sql.indexOf("create or replace function public.fn_billing_debitos_pendentes(");
      const corpo = sql.slice(inicio, sql.indexOf("$$;", inicio));
      // Item 3 da revisão: pesos_alterados_em entra no greatest (ao lado de
      // carteira_desde e "hoje - 35 dias") para nunca recalcular, com o peso
      // NOVO, uma chamada anterior à última troca de peso.
      expect(corpo).toMatch(
        /c\.created_at >= greatest\(s\.carteira_desde, s\.pesos_alterados_em, now\(\) - interval '35 days'\)/,
      );
      expect(corpo).toMatch(/c\.legacy_invocation_id is null/);
      expect(corpo).toMatch(/c\.origem_da_chave = 'chave_da_instalacao'/);
      expect(corpo).toMatch(/public\.fn_billing_tokens_ponderados\(/);
      expect(corpo).toMatch(
        /not exists \(\s*\n\s*select 1 from public\.billing_token_ledger l where l\.llm_call_id = c\.id\s*\n\s*\)/,
      );
      expect(corpo).toMatch(/order by c\.created_at\s*\n\s*limit p_limite/);
    }
  });

  it("fn_billing_consumo_da_instalacao_no_dia soma tokens_ponderados de TODAS as organizações no dia, sem filtro de organização", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      const inicio = sql.indexOf("create or replace function public.fn_billing_consumo_da_instalacao_no_dia(");
      const corpo = sql.slice(inicio, sql.indexOf("$$;", inicio));
      expect(corpo).toMatch(/select coalesce\(sum\(tokens_ponderados\), 0\)/);
      expect(corpo).toMatch(/from public\.billing_token_consumo_diario\s*\n\s*where dia = p_dia/);
      expect(corpo).not.toMatch(/organization_id/);
    }
  });

  it("billing_token_ledger_llm_call_id_idx (Parte 1) sustenta o anti-join sem índice novo na Parte 4; billing_token_ledger_org_fonte_ciclo_idx (Parte 6) é o índice novo de apoio ao conferidor, por (organization_id, fonte, ciclo)", () => {
    // O índice usado pelo anti-join de fn_billing_debitos_pendentes já nasceu
    // na Parte 1 (item 3, "3. billing_token_ledger"); a Parte 4 (delimitada
    // até o início da Parte 5, senão o "create index" da Parte 6 mais abaixo
    // no mesmo arquivo faria esta checagem falhar) não precisou criar nenhum
    // "create index" novo para o anti-join.
    const inicioParte4 = MIGRATION.indexOf("17. billing_token_ledger ganha ciclo e compensa_id");
    const inicioParte5 = MIGRATION.indexOf("Parte 5: correções da auditoria de segurança");
    expect(inicioParte4).toBeGreaterThan(-1);
    expect(inicioParte5).toBeGreaterThan(inicioParte4);
    const trechoParte4 = MIGRATION.slice(inicioParte4, inicioParte5);
    expect(trechoParte4).not.toMatch(/create index/);

    const posLlmCallIdIdx = MIGRATION.indexOf(
      "create index if not exists billing_token_ledger_llm_call_id_idx",
    );
    expect(posLlmCallIdIdx).toBeGreaterThan(-1);
    expect(posLlmCallIdIdx).toBeLessThan(inicioParte4);
    expect(MIGRATION).toMatch(
      /create index if not exists billing_token_ledger_llm_call_id_idx\s*\n\s*on public\.billing_token_ledger \(llm_call_id\);/,
    );

    // Item 5 da revisão (Parte 6, depois da Parte 5): índice novo de apoio ao
    // `like 'consumo:%'` dentro do loop de fn_billing_conferir_carteira, para
    // o conferidor não varrer a fatia (organização, fonte) inteira por
    // sequential scan a cada linha da carteira conferida.
    const posOrgFonteCicloIdx = MIGRATION.indexOf(
      "create index if not exists billing_token_ledger_org_fonte_ciclo_idx",
    );
    expect(posOrgFonteCicloIdx).toBeGreaterThan(inicioParte5);
    for (const sql of [MIGRATION, extraiBlocoBaseline()]) {
      expect(sql).toMatch(
        /create index if not exists billing_token_ledger_org_fonte_ciclo_idx\s*\n\s*on public\.billing_token_ledger \(organization_id, fonte, ciclo\);/,
      );
    }
  });
});

describe("0906 carteira de tokens de IA (parte 5, correções da auditoria de segurança de 23/09/2026)", () => {
  it("a parte 5 está no MESMO arquivo, e o bloco do baseline continua idêntico ao arquivo inteiro da migração", () => {
    const sqlMigracao = removeComentariosEBrancas(MIGRATION);
    const sqlBloco = removeComentariosEBrancas(extraiBlocoBaseline());
    expect(sqlBloco).toBe(sqlMigracao);
    const inicioParte5 = MIGRATION.indexOf("Parte 5: correções da auditoria de segurança");
    expect(inicioParte5).toBeGreaterThan(-1);
  });

  it("A1: llm_calls perde insert/update/delete/truncate para authenticated e anon", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      expect(sql).toMatch(/revoke insert, update, delete, truncate on public\.llm_calls from authenticated, anon;/);
    }
  });

  it("A1: três policies RESTRICTIVE separadas (insert/update/delete) para authenticated, sem tocar a policy do autor", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      expect(sql).toMatch(/create policy billing_llm_calls_restringe_insert on public\.llm_calls\s*\n\s*as restrictive\s*\n\s*for insert\s*\n\s*to authenticated\s*\n\s*with check \(false\);/);
      expect(sql).toMatch(/create policy billing_llm_calls_restringe_update on public\.llm_calls\s*\n\s*as restrictive\s*\n\s*for update\s*\n\s*to authenticated\s*\n\s*using \(false\);/);
      expect(sql).toMatch(/create policy billing_llm_calls_restringe_delete on public\.llm_calls\s*\n\s*as restrictive\s*\n\s*for delete\s*\n\s*to authenticated\s*\n\s*using \(false\);/);
    }
    // Nenhuma alteração na policy do autor (0050): esta migration nunca
    // recria (create/drop policy) tenant_isolation_llm_calls_all: só a
    // MENCIONA em comentário, explicando por que não foi tocada.
    for (const sql of [MIGRATION, extraiBlocoBaseline()]) {
      expect(sql).not.toMatch(/(create|drop) policy[^\n]*tenant_isolation_llm_calls_all/);
    }
  });

  it("A1, item 2: fn_billing_debitar_chamada grava ciclo nas três linhas de consumo, e a coluna nasce ANTES desta função (reordenada para a Parte 2)", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      const inicioAlterCedo = sql.indexOf("alter table public.billing_token_ledger add column if not exists ciclo date;");
      const inicioFuncao = sql.indexOf("create or replace function public.fn_billing_debitar_chamada(");
      expect(inicioAlterCedo, "alter table ciclo não encontrado").toBeGreaterThan(-1);
      expect(inicioFuncao, "fn_billing_debitar_chamada não encontrada").toBeGreaterThan(-1);
      expect(inicioAlterCedo).toBeLessThan(inicioFuncao);

      const corpo = sql.slice(inicioFuncao, sql.indexOf("$$;", inicioFuncao));
      expect(corpo).toMatch(/'consumo:' \|\| p_llm_call_id::text \|\| ':plano', p_llm_call_id, v_ciclo\)/);
      expect(corpo).toMatch(/'consumo:' \|\| p_llm_call_id::text \|\| ':adicional', p_llm_call_id, v_ciclo\)/);
      expect(corpo).toMatch(/'consumo:' \|\| p_llm_call_id::text \|\| ':avulso', p_llm_call_id, v_ciclo\)/);
    }
  });

  it("M1: fn_billing_debitar_chamada recusa reenvio da MESMA chamada logo depois da trava, antes de recalcular a divisão por fonte", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      const inicio = sql.indexOf("create or replace function public.fn_billing_debitar_chamada(");
      const corpo = sql.slice(inicio, sql.indexOf("$$;", inicio));
      const posTrava = corpo.indexOf("pg_try_advisory_xact_lock(hashtextextended('billing_tokens:'");
      const posGuardaM1 = corpo.indexOf(
        "select 1 from public.billing_token_ledger\n    where organization_id = v_chamada.organization_id and llm_call_id = p_llm_call_id",
      );
      const posGarantirConcessoes = corpo.indexOf("perform public.fn_billing_garantir_concessoes(v_chamada.organization_id, v_ciclo);");
      expect(posTrava, "trava não encontrada").toBeGreaterThan(-1);
      expect(posGuardaM1, "guarda M1 não encontrada").toBeGreaterThan(-1);
      expect(posGarantirConcessoes, "garantir_concessoes não encontrada").toBeGreaterThan(-1);
      expect(posTrava).toBeLessThan(posGuardaM1);
      expect(posGuardaM1).toBeLessThan(posGarantirConcessoes);
    }
  });

  it("fn_billing_conferir_carteira recalcula consumido só pela coluna ciclo do livro-caixa, sem nenhum join em llm_calls", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      const inicio = sql.indexOf("create or replace function public.fn_billing_conferir_carteira(");
      const corpo = sql.slice(inicio, sql.indexOf("$$;", inicio));
      expect(corpo).not.toMatch(/left join public\.llm_calls/);
      expect(corpo).not.toMatch(/fn_billing_ciclo_de\(c\.created_at\)/);
      expect(corpo).toMatch(/v_linha\.fonte = 'avulso'\s*\n\s*or l\.ciclo = v_linha\.ciclo/);
    }
  });

  it("backfill idempotente preenche ciclo das linhas de consumo antigas a partir de llm_calls.created_at (o único UPDATE no livro-caixa, roda como dono)", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      expect(sql).toMatch(
        /update public\.billing_token_ledger l\s*\n\s*set ciclo = public\.fn_billing_ciclo_de\(c\.created_at\)\s*\n\s*from public\.llm_calls c\s*\n\s*where l\.llm_call_id = c\.id\s*\n\s*and l\.chave like 'consumo:%'\s*\n\s*and l\.ciclo is null;/,
      );
    }
  });

  it("comentário do LGPD/0019 (causa errada da lacuna) não existe mais NESTA migration (só no bloco 0906, outras migrations podem falar de LGPD por outro motivo)", () => {
    for (const sql of [MIGRATION, extraiBlocoBaseline()]) {
      expect(sql).not.toMatch(/expurgo de LGPD/);
      expect(sql).not.toMatch(/LGPD, 0019/);
    }
  });

  it("B1: fn_billing_contratar_adicional recusa reenvio da MESMA chave de OUTRA organização (42501)", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      const inicio = sql.indexOf("create or replace function public.fn_billing_contratar_adicional(");
      const corpo = sql.slice(inicio, sql.indexOf("$$;", inicio));
      expect(corpo).toMatch(
        /if v_linhas = 0 and not exists \(\s*\n\s*select 1 from public\.billing_token_adicionais where id = p_chave and organization_id = p_org\s*\n\s*\) then\s*\n\s*raise exception 'adicional_de_outra_organizacao' using errcode = '42501';/,
      );
    }
  });

  it("B2: fn_billing_ajustar_tokens recusa um segundo ajuste com o mesmo compensa_id na organização (22023)", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      const inicio = sql.indexOf("create or replace function public.fn_billing_ajustar_tokens(");
      const corpo = sql.slice(inicio, sql.indexOf("$$;", inicio));
      expect(corpo).toMatch(
        /if p_compensa is not null and exists \(\s*\n\s*select 1 from public\.billing_token_ledger\s*\n\s*where organization_id = p_org and chave like 'ajuste:%' and compensa_id = p_compensa\s*\n\s*\) then\s*\n\s*raise exception 'ajuste_compensa_ja_usado' using errcode = '22023';/,
      );
    }
  });

  it("B3: agent_worker perde SELECT nas cinco tabelas da carteira, no bloco da Parte 5", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      expect(sql).toMatch(
        /revoke select on public\.billing_token_ledger, public\.billing_token_wallets, public\.billing_token_adicionais, public\.billing_token_consumo_diario, public\.billing_token_avisos_emitidos from agent_worker/,
      );
    }
  });
});
