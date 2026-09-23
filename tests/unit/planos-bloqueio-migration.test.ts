import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATION_0905 = readFileSync(
  join(process.cwd(), "supabase/migrations/20260923100000_0905_planos_uso_e_trava.sql"),
  "utf8",
);
const MIGRATION_0907 = readFileSync(
  join(process.cwd(), "supabase/migrations/20260923120000_0907_planos_bloqueio.sql"),
  "utf8",
);
const BASELINE = readFileSync(join(process.cwd(), "supabase/baseline.sql"), "utf8");

/**
 * Extrai o bloco 0907 do baseline: do marcador de início até (sem incluir) o
 * cabeçalho do PRÓXIMO bloco (`-- ---- `). Mesmo extrator das migrações
 * 0905/0906 (tests/unit/planos-uso-migration.test.ts,
 * tests/unit/planos-carteira-migration.test.ts): cortar numa VARREDURA fixa
 * quebraria no dia em que outro bloco entrasse no meio.
 */
function extraiBloco0907Baseline(): string {
  const marcadorInicio = "-- ---- bloqueio do plano (migration 0907";
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

describe("0907 bloqueio do plano (Tarefa 1): posição e igualdade do bloco no baseline", () => {
  it("o bloco do baseline vem depois do bloco da 0906 e antes da VARREDURA anon", () => {
    const inicioBloco0906 = BASELINE.indexOf("-- ---- carteira de tokens de IA (migration 0906");
    const inicioBloco0907 = BASELINE.indexOf("-- ---- bloqueio do plano (migration 0907");
    const varreduraAnon = BASELINE.lastIndexOf("-- ---- VARREDURA anon:");

    expect(inicioBloco0906).toBeGreaterThan(-1);
    expect(inicioBloco0907).toBeGreaterThan(-1);
    expect(varreduraAnon).toBeGreaterThan(-1);
    expect(inicioBloco0906).toBeLessThan(inicioBloco0907);
    expect(inicioBloco0907).toBeLessThan(varreduraAnon);
  });

  it("o SQL da migração 0907 e o SQL do bloco do baseline são iguais, ignorando comentários e linhas em branco", () => {
    const sqlMigracao = removeComentariosEBrancas(MIGRATION_0907);
    const sqlBloco = removeComentariosEBrancas(extraiBloco0907Baseline());
    expect(sqlBloco).toBe(sqlMigracao);
  });

  it("o SQL da migração 0905 (editada nesta fase) e o SQL do bloco dela no baseline continuam iguais", () => {
    // Mesmo extrator de tests/unit/planos-uso-migration.test.ts: garante que
    // a edição NO LUGAR dos quatro gatilhos (decisão 3 da fase F3) foi
    // replicada IDÊNTICA nos dois arquivos, não só na migração.
    const marcadorInicio = "-- ---- uso dos planos e trava (migration 0905";
    const posicaoMarcador = BASELINE.indexOf(marcadorInicio);
    const fim = BASELINE.indexOf("\n-- ---- ", posicaoMarcador);
    const blocoBaseline0905 = BASELINE.slice(posicaoMarcador, fim + 1);

    const sqlMigracao = removeComentariosEBrancas(MIGRATION_0905);
    const sqlBloco = removeComentariosEBrancas(blocoBaseline0905);
    expect(sqlBloco).toBe(sqlMigracao);
  });
});

describe("0907: billing_settings.carencia_dias e billing_contracts.bloqueio_a_partir_de", () => {
  it("carencia_dias nasce com add column if not exists, default 7, check 0..90 idempotente", () => {
    for (const sql of [MIGRATION_0907, BASELINE]) {
      expect(sql).toMatch(
        /alter table public\.billing_settings add column if not exists carencia_dias integer not null default 7;/,
      );
      expect(sql).toMatch(/check \(carencia_dias between 0 and 90\)/);
    }
    for (const sql of [MIGRATION_0907, extraiBloco0907Baseline()]) {
      expect(sql).toMatch(
        /if not exists \(select 1 from pg_constraint where conname = 'billing_settings_carencia_dias_check'\) then/,
      );
    }
  });

  it("bloqueio_a_partir_de nasce nulo (nulo = não bloqueia), sem FK, add column if not exists", () => {
    for (const sql of [MIGRATION_0907, BASELINE]) {
      expect(sql).toMatch(
        /alter table public\.billing_contracts add column if not exists bloqueio_a_partir_de timestamptz;/,
      );
      expect(sql).not.toMatch(/bloqueio_a_partir_de timestamptz references/);
    }
  });

  it("a ordem no baseline é DDL primeiro: as duas colunas novas aparecem antes de qualquer função que as usa", () => {
    const bloco = extraiBloco0907Baseline();
    const posCarenciaDias = bloco.indexOf("add column if not exists carencia_dias");
    const posBloqueioAPartirDe = bloco.indexOf("add column if not exists bloqueio_a_partir_de");
    const posPrimeiraFuncao = bloco.indexOf("create or replace function public.fn_billing_dar_carencia(");
    expect(posCarenciaDias).toBeGreaterThan(-1);
    expect(posBloqueioAPartirDe).toBeGreaterThan(-1);
    expect(posPrimeiraFuncao).toBeGreaterThan(-1);
    expect(posCarenciaDias).toBeLessThan(posPrimeiraFuncao);
    expect(posBloqueioAPartirDe).toBeLessThan(posPrimeiraFuncao);
  });
});

const FUNCOES_0907 = [
  "fn_billing_dar_carencia(uuid, integer)",
  "fn_billing_definir_modo(text, uuid)",
  "fn_billing_trava_carencia_contrato_novo()",
  "fn_billing_trava_carencia_troca_de_plano()",
  "fn_billing_bloqueia(uuid, text, uuid)",
] as const;

describe("0907: padrão de segurança das cinco funções novas", () => {
  it("todas são security definer com search_path fixo em public, pg_temp", () => {
    for (const sql of [MIGRATION_0907, BASELINE]) {
      for (const assinatura of FUNCOES_0907) {
        const nome = assinatura.slice(0, assinatura.indexOf("("));
        const inicio = sql.indexOf(`create or replace function public.${nome}(`);
        expect(inicio, `${nome} não encontrada`).toBeGreaterThan(-1);
        const trecho = sql.slice(inicio, inicio + 400);
        expect(trecho).toMatch(/security definer/);
        expect(trecho).toMatch(/set search_path = public, pg_temp/);
      }
    }
  });

  it("todas revogam execute de public/anon/authenticated e concedem só a service_role", () => {
    for (const sql of [MIGRATION_0907, BASELINE]) {
      for (const assinatura of FUNCOES_0907) {
        const nome = assinatura.slice(0, assinatura.indexOf("("));
        const chamada = assinatura.slice(assinatura.indexOf("("));
        const escapado = chamada.replace(/[().,]/g, (c) => `\\${c}`).replace(/ /g, "\\s*");
        const regexRevoke = new RegExp(
          `revoke execute on function public\\.${nome}${escapado} from public, anon, authenticated`,
        );
        const regexGrant = new RegExp(`grant execute on function public\\.${nome}${escapado} to service_role`);
        expect(sql, `${nome}: revoke ausente`).toMatch(regexRevoke);
        expect(sql, `${nome}: grant ausente`).toMatch(regexGrant);
      }
    }
  });

  it("o bloco da role agent_worker revoga execute das cinco funções novas", () => {
    for (const sql of [MIGRATION_0907, extraiBloco0907Baseline()]) {
      expect(sql).toMatch(/if exists \(select 1 from pg_roles where rolname = 'agent_worker'\) then/);
      for (const assinatura of FUNCOES_0907) {
        const nome = assinatura.slice(0, assinatura.indexOf("("));
        expect(sql).toMatch(new RegExp(`public\\.${nome}\\(`));
      }
      expect(sql).toMatch(
        /revoke execute on function public\.fn_billing_dar_carencia\(uuid, integer\), public\.fn_billing_definir_modo\(text, uuid\), public\.fn_billing_trava_carencia_contrato_novo\(\), public\.fn_billing_trava_carencia_troca_de_plano\(\), public\.fn_billing_bloqueia\(uuid, text, uuid\) from agent_worker/,
      );
    }
  });
});

describe("0907: fn_billing_dar_carencia (helper compartilhado)", () => {
  it("só grava quando bloqueio_a_partir_de ainda é nulo (update condicional, sem select prévio)", () => {
    for (const sql of [MIGRATION_0907, BASELINE]) {
      const inicio = sql.indexOf("create or replace function public.fn_billing_dar_carencia(");
      const corpo = sql.slice(inicio, sql.indexOf("$$;", inicio));
      expect(corpo).toMatch(
        /where id = p_contract_id and bloqueio_a_partir_de is null\s*\n\s*returning organization_id into v_org;/,
      );
      expect(corpo).toMatch(/if v_org is null then\s*\n\s*-- [^\n]*\n\s*return false;/);
      expect(corpo).toMatch(/return true;/);
    }
  });

  it("o título do aviso é texto fixo com a data, kind=other, ref_kind=billing_limite, deduplicado enquanto status=open", () => {
    for (const sql of [MIGRATION_0907, BASELINE]) {
      const inicio = sql.indexOf("create or replace function public.fn_billing_dar_carencia(");
      const corpo = sql.slice(inicio, sql.indexOf("$$;", inicio));
      expect(corpo).toMatch(
        /v_titulo := 'Bloqueio do plano fica ativo em ' \|\| to_char\(v_data, 'DD\/MM\/YYYY'\);/,
      );
      expect(corpo).toMatch(/and kind = 'other'/);
      expect(corpo).toMatch(/and ref_kind = 'billing_limite'/);
      expect(corpo).toMatch(/and title = v_titulo/);
      expect(corpo).toMatch(/and status = 'open'/);
      expect(corpo).toMatch(
        /insert into public\.agent_inbox_items \(organization_id, kind, severity, title, body, ref_kind, ref_id\)/,
      );
    }
  });
});

describe("0907: fn_billing_definir_modo", () => {
  it("recusa modo fora do conjunto fechado com errcode 22023", () => {
    for (const sql of [MIGRATION_0907, BASELINE]) {
      const inicio = sql.indexOf("create or replace function public.fn_billing_definir_modo(");
      const corpo = sql.slice(inicio, sql.indexOf("$$;", inicio));
      expect(corpo).toMatch(
        /if p_modo not in \('desligado', 'avisar', 'bloquear'\) then\s*\n\s*raise exception 'billing_modo_invalido' using errcode = '22023';/,
      );
    }
  });

  it("trava a linha única (for update) antes de ler o modo anterior", () => {
    for (const sql of [MIGRATION_0907, BASELINE]) {
      const inicio = sql.indexOf("create or replace function public.fn_billing_definir_modo(");
      const corpo = sql.slice(inicio, sql.indexOf("$$;", inicio));
      expect(corpo).toMatch(
        /select modo, carencia_dias into v_modo_anterior, v_carencia_dias\s*\n\s*from public\.billing_settings\s*\n\s*where id = 1\s*\n\s*for update;/,
      );
    }
  });

  it("só dá carência em massa ao ENTRAR em bloquear (nunca ao sair), varrendo contratos com data nula", () => {
    for (const sql of [MIGRATION_0907, BASELINE]) {
      const inicio = sql.indexOf("create or replace function public.fn_billing_definir_modo(");
      const corpo = sql.slice(inicio, sql.indexOf("$$;", inicio));
      expect(corpo).toMatch(/if p_modo = 'bloquear' then/);
      expect(corpo).toMatch(
        /select id from public\.billing_contracts where bloqueio_a_partir_de is null/,
      );
      expect(corpo).toMatch(
        /if public\.fn_billing_dar_carencia\(v_contract_id, v_carencia_dias\) then\s*\n\s*v_qtd := v_qtd \+ 1;/,
      );
    }
  });

  it("devolve modo_anterior, modo_novo e organizacoes_com_carencia", () => {
    for (const sql of [MIGRATION_0907, BASELINE]) {
      const inicio = sql.indexOf("create or replace function public.fn_billing_definir_modo(");
      const corpo = sql.slice(inicio, sql.indexOf("$$;", inicio));
      expect(corpo).toMatch(
        /jsonb_build_object\(\s*\n\s*'modo_anterior', v_modo_anterior,\s*\n\s*'modo_novo', p_modo,\s*\n\s*'organizacoes_com_carencia', v_qtd\s*\n\s*\);/,
      );
    }
  });
});

describe("0907: os dois gatilhos NOSSOS de carência (organização nova e troca de plano)", () => {
  it("organização nova: after insert em billing_contracts, sem editar fn_billing_contrato_da_organizacao_nova (0904)", () => {
    for (const sql of [MIGRATION_0907, BASELINE]) {
      expect(sql).toMatch(
        /create trigger trg_billing_trava_carencia_contrato_novo\s*\n\s*after insert on public\.billing_contracts\s*\n\s*for each row\s*\n\s*execute function public\.fn_billing_trava_carencia_contrato_novo\(\);/,
      );
      expect(sql).toMatch(/drop trigger if exists trg_billing_trava_carencia_contrato_novo on public\.billing_contracts;/);
    }
    // fn_billing_contrato_da_organizacao_nova (0904) não é tocada por esta migração.
    expect(MIGRATION_0907).not.toMatch(/create or replace function public\.fn_billing_contrato_da_organizacao_nova/);
  });

  it("organização nova: só dá carência quando o modo já está em bloquear, nunca lança (captura qualquer erro)", () => {
    for (const sql of [MIGRATION_0907, BASELINE]) {
      const inicio = sql.indexOf("create or replace function public.fn_billing_trava_carencia_contrato_novo(");
      const corpo = sql.slice(inicio, sql.indexOf("$$;", inicio));
      expect(corpo).toMatch(/if v_modo is distinct from 'bloquear' then\s*\n\s*return null;/);
      expect(corpo).toMatch(/perform public\.fn_billing_dar_carencia\(new\.id, v_carencia_dias\);/);
      expect(corpo).toMatch(/exception\s*\n\s*when others then/);
      expect(corpo).toMatch(/raise warning 'billing_trava_carencia_contrato_novo_falhou/);
    }
  });

  it("troca de plano: after update OF plan_id em billing_contracts, sem editar fn_billing_trocar_plano (0904)", () => {
    for (const sql of [MIGRATION_0907, BASELINE]) {
      expect(sql).toMatch(
        /create trigger trg_billing_trava_carencia_troca_de_plano\s*\n\s*after update of plan_id on public\.billing_contracts\s*\n\s*for each row\s*\n\s*execute function public\.fn_billing_trava_carencia_troca_de_plano\(\);/,
      );
      expect(sql).toMatch(
        /drop trigger if exists trg_billing_trava_carencia_troca_de_plano on public\.billing_contracts;/,
      );
    }
    expect(MIGRATION_0907).not.toMatch(/create or replace function public\.fn_billing_trocar_plano/);
  });

  it("troca de plano: ignora quando plan_id não mudou de fato (upsert do autor sempre lista a coluna no SET)", () => {
    for (const sql of [MIGRATION_0907, BASELINE]) {
      const inicio = sql.indexOf("create or replace function public.fn_billing_trava_carencia_troca_de_plano(");
      const corpo = sql.slice(inicio, sql.indexOf("$$;", inicio));
      expect(corpo).toMatch(/if new\.plan_id is not distinct from old\.plan_id then\s*\n\s*return null;/);
    }
  });

  it("troca de plano: considera reducao quando qualquer chave do plano novo tem teto menor (inclusive ilimitado virando limitado)", () => {
    for (const sql of [MIGRATION_0907, BASELINE]) {
      const inicio = sql.indexOf("create or replace function public.fn_billing_trava_carencia_troca_de_plano(");
      const corpo = sql.slice(inicio, sql.indexOf("$$;", inicio));
      expect(corpo).toMatch(/for v_chave in select jsonb_object_keys\(v_limites_novos\)/);
      expect(corpo).toMatch(
        /if \(v_limites_novos ->> v_chave\) is not null\s*\n\s*and \(\s*\n\s*\(v_limites_antigos ->> v_chave\) is null\s*\n\s*or \(v_limites_novos ->> v_chave\)::bigint < \(v_limites_antigos ->> v_chave\)::bigint\s*\n\s*\)\s*\n\s*then/,
      );
      expect(corpo).toMatch(/if not v_teve_reducao then\s*\n\s*return null;/);
      expect(corpo).toMatch(/perform public\.fn_billing_dar_carencia\(new\.id, v_carencia_dias\);/);
      expect(corpo).toMatch(/exception\s*\n\s*when others then/);
    }
  });
});

describe("0907: fn_billing_bloqueia (o veredito de bloqueio de verdade)", () => {
  it("é VOLATILE (não STABLE), security definer, search_path fixo", () => {
    for (const sql of [MIGRATION_0907, BASELINE]) {
      const inicio = sql.indexOf("create or replace function public.fn_billing_bloqueia(");
      const trecho = sql.slice(inicio, inicio + 300);
      expect(trecho).toMatch(/\bvolatile\b/);
      expect(trecho).not.toMatch(/\bstable\b/);
      expect(trecho).toMatch(/security definer/);
      expect(trecho).toMatch(/set search_path = public, pg_temp/);
    }
  });

  it("lê o modo ANTES de qualquer outra coisa e sai sem travar fora do modo bloquear", () => {
    for (const sql of [MIGRATION_0907, BASELINE]) {
      const inicio = sql.indexOf("create or replace function public.fn_billing_bloqueia(");
      const corpo = sql.slice(inicio, sql.indexOf("$$;", inicio));
      const posModo = corpo.indexOf("select modo into v_modo from public.billing_settings where id = 1;");
      const posSaidaModo = corpo.indexOf("if v_modo is distinct from 'bloquear' then");
      const posCarencia = corpo.indexOf("select bc.bloqueio_a_partir_de into v_bloqueio_a_partir_de");
      const posTeto = corpo.indexOf("v_teto := (public.fn_billing_limites_efetivos(p_org) ->> p_item)::integer;");
      const posLock = corpo.indexOf("perform pg_advisory_xact_lock(");
      expect(posModo).toBeGreaterThan(-1);
      expect(posSaidaModo).toBeGreaterThan(posModo);
      expect(posCarencia).toBeGreaterThan(posSaidaModo);
      expect(posTeto).toBeGreaterThan(posCarencia);
      expect(posLock).toBeGreaterThan(posTeto);
    }
  });

  it("carência nula ou ainda não vencida devolve false, sem travar", () => {
    for (const sql of [MIGRATION_0907, BASELINE]) {
      const inicio = sql.indexOf("create or replace function public.fn_billing_bloqueia(");
      const corpo = sql.slice(inicio, sql.indexOf("$$;", inicio));
      expect(corpo).toMatch(
        /if v_bloqueio_a_partir_de is null or v_bloqueio_a_partir_de > now\(\) then\s*\n\s*return false;/,
      );
    }
  });

  it("teto efetivo nulo (organização Ilimitado) devolve false, sem travar", () => {
    for (const sql of [MIGRATION_0907, BASELINE]) {
      const inicio = sql.indexOf("create or replace function public.fn_billing_bloqueia(");
      const corpo = sql.slice(inicio, sql.indexOf("$$;", inicio));
      expect(corpo).toMatch(/if v_teto is null then\s*\n\s*return false;/);
    }
  });

  it("usa pg_advisory_xact_lock BLOQUEANTE (nunca a variante _try_), mesma chave de fn_billing_conferir_teto", () => {
    for (const sql of [MIGRATION_0907, BASELINE]) {
      const inicio = sql.indexOf("create or replace function public.fn_billing_bloqueia(");
      const corpo = sql.slice(inicio, sql.indexOf("$$;", inicio));
      expect(corpo).toMatch(
        /perform pg_advisory_xact_lock\(hashtextextended\('billing:' \|\| p_org::text \|\| ':' \|\| p_item, 0\)\);/,
      );
      expect(corpo).not.toMatch(/pg_try_advisory_xact_lock\(/);
    }
  });

  it("a contagem roda dentro de begin/exception que devolve false em qualquer falha interna (raise warning)", () => {
    for (const sql of [MIGRATION_0907, BASELINE]) {
      const inicio = sql.indexOf("create or replace function public.fn_billing_bloqueia(");
      const corpo = sql.slice(inicio, sql.indexOf("$$;", inicio));
      const posLock = corpo.indexOf("perform pg_advisory_xact_lock(");
      const posBeginInterno = corpo.indexOf("\n  begin\n", posLock);
      const posPodeCriar = corpo.indexOf("v_resultado := public.fn_billing_pode_criar(p_org, p_item, p_pipeline);");
      const posReturnVeredito = corpo.indexOf("return not (v_resultado ->> 'pode')::boolean;");
      const posExceptionInterno = corpo.indexOf("exception\n    when others then", posPodeCriar);
      const posRaiseWarning = corpo.indexOf("raise warning 'billing_bloqueia_falhou", posExceptionInterno);
      const posReturnFalseNaExcecao = corpo.indexOf("return false;", posRaiseWarning);
      expect(posLock).toBeGreaterThan(-1);
      expect(posBeginInterno).toBeGreaterThan(posLock);
      expect(posPodeCriar).toBeGreaterThan(posBeginInterno);
      expect(posReturnVeredito).toBeGreaterThan(posPodeCriar);
      expect(posExceptionInterno).toBeGreaterThan(posReturnVeredito);
      expect(posRaiseWarning).toBeGreaterThan(posExceptionInterno);
      expect(posReturnFalseNaExcecao).toBeGreaterThan(posRaiseWarning);
    }
  });
});

const ITENS_DOS_QUATRO_GATILHOS = [
  { funcao: "fn_billing_trava_crm_pipelines", item: "funis" },
  { funcao: "fn_billing_trava_crm_stages", item: "etapas_por_funil" },
  { funcao: "fn_billing_trava_channel_sessions", item: "conexoes" },
  { funcao: "fn_billing_trava_webhook_sources", item: "integracoes_webhook" },
] as const;

describe("0907: os quatro gatilhos de funis/etapas/conexões/webhooks (editados NO LUGAR na 0905)", () => {
  it("cada gatilho chama fn_billing_bloqueia ANTES de fn_billing_conferir_teto, ao menos uma vez por item", () => {
    for (const sql of [MIGRATION_0905, BASELINE]) {
      for (const { funcao, item } of ITENS_DOS_QUATRO_GATILHOS) {
        const inicio = sql.indexOf(`create or replace function public.${funcao}(`);
        expect(inicio, `${funcao} não encontrada`).toBeGreaterThan(-1);
        const corpo = sql.slice(inicio, sql.indexOf("$$;", inicio));
        const posBloqueia = corpo.indexOf(`if public.fn_billing_bloqueia(new.organization_id, '${item}'`);
        const posConferir = corpo.indexOf(`perform public.fn_billing_conferir_teto(new.organization_id, '${item}'`);
        expect(posBloqueia, `${funcao}: fn_billing_bloqueia('${item}') ausente`).toBeGreaterThan(-1);
        expect(posConferir, `${funcao}: fn_billing_conferir_teto('${item}') ausente`).toBeGreaterThan(-1);
        expect(posBloqueia).toBeLessThan(posConferir);
      }
    }
  });

  it("o raise 'Limite do plano atingido' (PT402, detail=<item>) fica FORA de qualquer bloco exception, nos quatro gatilhos", () => {
    for (const sql of [MIGRATION_0905, BASELINE]) {
      for (const { funcao, item } of ITENS_DOS_QUATRO_GATILHOS) {
        const inicio = sql.indexOf(`create or replace function public.${funcao}(`);
        const corpo = sql.slice(inicio, sql.indexOf("$$;", inicio));
        // Nenhum destes quatro gatilhos tem "exception when others" no corpo:
        // diferente de fn_billing_conferir_teto e fn_billing_trava_crm_leads
        // (0905, que capturam tudo), estes quatro deixam o PT402 propagar.
        expect(corpo, `${funcao}: não pode ter bloco exception`).not.toMatch(/exception\s*\n\s*when others/);
        expect(corpo).toMatch(
          new RegExp(
            `raise exception 'Limite do plano atingido' using errcode = 'PT402', detail = '${item}';`,
          ),
        );
      }
    }
  });

  it("cada raise de bloqueio está imediatamente dentro do 'if fn_billing_bloqueia(...) then', antes do 'end if' seguinte", () => {
    for (const sql of [MIGRATION_0905, BASELINE]) {
      for (const { funcao, item } of ITENS_DOS_QUATRO_GATILHOS) {
        const inicio = sql.indexOf(`create or replace function public.${funcao}(`);
        const corpo = sql.slice(inicio, sql.indexOf("$$;", inicio));
        const regex = new RegExp(
          `if public\\.fn_billing_bloqueia\\(new\\.organization_id, '${item}'[^)]*\\) then\\s*\\n\\s*raise exception 'Limite do plano atingido' using errcode = 'PT402', detail = '${item}';\\s*\\n\\s*end if;`,
        );
        expect(corpo, `${funcao} (${item})`).toMatch(regex);
      }
    }
  });

  it("crm_stages: a checagem de bloqueio de etapas_por_funil usa new.pipeline_id nos três ramos (insert, desarquivar, mover)", () => {
    for (const sql of [MIGRATION_0905, BASELINE]) {
      const inicio = sql.indexOf("create or replace function public.fn_billing_trava_crm_stages(");
      const corpo = sql.slice(inicio, sql.indexOf("$$;", inicio));
      const ocorrencias = [
        ...corpo.matchAll(/if public\.fn_billing_bloqueia\(new\.organization_id, 'etapas_por_funil', new\.pipeline_id\) then/g),
      ];
      expect(ocorrencias.length).toBe(3);
    }
  });

  it("crm_pipelines: o ramo de desarquivar confere bloqueio de funis E de etapas_por_funil, nessa ordem", () => {
    for (const sql of [MIGRATION_0905, BASELINE]) {
      const inicio = sql.indexOf("create or replace function public.fn_billing_trava_crm_pipelines(");
      const corpo = sql.slice(inicio, sql.indexOf("$$;", inicio));
      const posElsif = corpo.indexOf("elsif old.is_archived = true and new.is_archived = false then");
      const posBloqueiaFunis = corpo.indexOf("if public.fn_billing_bloqueia(new.organization_id, 'funis', null) then", posElsif);
      const posBloqueiaEtapas = corpo.indexOf(
        "if public.fn_billing_bloqueia(new.organization_id, 'etapas_por_funil', new.id) then",
        posElsif,
      );
      expect(posElsif).toBeGreaterThan(-1);
      expect(posBloqueiaFunis).toBeGreaterThan(posElsif);
      expect(posBloqueiaEtapas).toBeGreaterThan(posBloqueiaFunis);
    }
  });

  it("nenhum dos quatro gatilhos foi tocado fora do corpo (mesma assinatura, mesmo security definer, mesmo trigger de criação)", () => {
    // As linhas de "create trigger" (fora do corpo da função) não mudam
    // nesta fase: só o CORPO de cada função de gatilho foi editado.
    for (const sql of [MIGRATION_0905, BASELINE]) {
      expect(sql).toMatch(
        /create trigger trg_billing_trava_crm_pipelines\s*\n\s*before insert or update of is_archived on public\.crm_pipelines/,
      );
      expect(sql).toMatch(
        /create trigger trg_billing_trava_crm_stages\s*\n\s*before insert or update of is_archived, pipeline_id on public\.crm_stages/,
      );
      expect(sql).toMatch(
        /create trigger trg_billing_trava_channel_sessions\s*\n\s*before insert or update of archived_at on public\.channel_sessions/,
      );
      expect(sql).toMatch(
        /create trigger trg_billing_trava_webhook_sources\s*\n\s*before insert or update of is_active on public\.webhook_sources/,
      );
    }
  });
});

describe("0907: modo continua 'avisar' por padrão, a fase não liga nada sozinha", () => {
  it("a migração 0907 não escreve em billing_settings.modo (não muda o default 'avisar' semeado pela 0905)", () => {
    // A única escrita em billing_settings.modo desta migração é DENTRO do
    // corpo de fn_billing_definir_modo (chamada só pelo admin, pela tela);
    // "set modo = p_modo" só pode aparecer uma vez, e dentro daquela função.
    // Nenhum "insert"/"update" solto fora de função pode mexer no valor
    // semeado pela 0905, que é o que mantém o banco em 'avisar' por padrão.
    const ocorrencias = [...MIGRATION_0907.matchAll(/set modo = /g)];
    expect(ocorrencias.length).toBe(1);
    const inicioDefinirModo = MIGRATION_0907.indexOf("create or replace function public.fn_billing_definir_modo(");
    const fimDefinirModo = MIGRATION_0907.indexOf("$$;", inicioDefinirModo);
    const posUpdateModo = MIGRATION_0907.indexOf("set modo = p_modo");
    expect(posUpdateModo).toBeGreaterThan(inicioDefinirModo);
    expect(posUpdateModo).toBeLessThan(fimDefinirModo);
    expect(MIGRATION_0907).not.toMatch(/values \([^)]*'bloquear'[^)]*\)/);
  });
});

const FUNCOES_0907_PARTE2 = [
  "fn_billing_convite_pendente_do_membro(uuid, uuid)",
  "fn_billing_veio_de_aceite_de_convite(uuid, timestamptz, uuid, timestamptz, boolean)",
  "fn_billing_dono_do_provisionamento(uuid, uuid, text)",
  "fn_billing_convite_ja_tem_vinculo_ativo(uuid)",
] as const;

describe("0907 parte 2 (Tarefa 2): padrão de segurança das quatro funções de isenção/contagem de membros", () => {
  it("todas são security definer com search_path fixo em public, pg_temp", () => {
    for (const sql of [MIGRATION_0907, BASELINE]) {
      for (const assinatura of FUNCOES_0907_PARTE2) {
        const nome = assinatura.slice(0, assinatura.indexOf("("));
        const inicio = sql.indexOf(`create or replace function public.${nome}(`);
        expect(inicio, `${nome} não encontrada`).toBeGreaterThan(-1);
        const trecho = sql.slice(inicio, inicio + 400);
        expect(trecho).toMatch(/security definer/);
        expect(trecho).toMatch(/set search_path = public, pg_temp/);
      }
    }
  });

  it("todas revogam execute de public/anon/authenticated e concedem só a service_role", () => {
    for (const sql of [MIGRATION_0907, BASELINE]) {
      for (const assinatura of FUNCOES_0907_PARTE2) {
        const nome = assinatura.slice(0, assinatura.indexOf("("));
        const chamada = assinatura.slice(assinatura.indexOf("("));
        const escapado = chamada.replace(/[().,]/g, (c) => `\\${c}`).replace(/ /g, "\\s*");
        const regexRevoke = new RegExp(
          `revoke execute on function public\\.${nome}${escapado} from public, anon, authenticated`,
        );
        const regexGrant = new RegExp(`grant execute on function public\\.${nome}${escapado} to service_role`);
        expect(sql, `${nome}: revoke ausente`).toMatch(regexRevoke);
        expect(sql, `${nome}: grant ausente`).toMatch(regexGrant);
      }
    }
  });

  it("o bloco da role agent_worker (parte 2) revoga execute das quatro funções novas", () => {
    for (const sql of [MIGRATION_0907, extraiBloco0907Baseline()]) {
      for (const assinatura of FUNCOES_0907_PARTE2) {
        const nome = assinatura.slice(0, assinatura.indexOf("("));
        expect(sql).toMatch(new RegExp(`public\\.${nome}\\(`));
      }
      expect(sql).toMatch(
        /revoke execute on function public\.fn_billing_convite_pendente_do_membro\(uuid, uuid\), public\.fn_billing_veio_de_aceite_de_convite\(uuid, timestamptz, uuid, timestamptz, boolean\), public\.fn_billing_dono_do_provisionamento\(uuid, uuid, text\), public\.fn_billing_convite_ja_tem_vinculo_ativo\(uuid\) from agent_worker/,
      );
      // Dois blocos de agent_worker nesta migração: um da parte 1 (Tarefa 1,
      // cinco funções), outro da parte 2 (Tarefa 2, quatro funções).
      const ocorrencias = [...sql.matchAll(/if exists \(select 1 from pg_roles where rolname = 'agent_worker'\) then/g)];
      expect(ocorrencias.length).toBe(2);
    }
  });
});

describe("0907 parte 2: isenção 1, fn_billing_convite_pendente_do_membro", () => {
  it("compara auth.users.email x team_invites.email sem diferença de maiúsculas, convite pendente e válido", () => {
    for (const sql of [MIGRATION_0907, BASELINE]) {
      const inicio = sql.indexOf("create or replace function public.fn_billing_convite_pendente_do_membro(");
      const corpo = sql.slice(inicio, sql.indexOf("$$;", inicio));
      expect(corpo).toMatch(/join auth\.users au on au\.id = p_user/);
      expect(corpo).toMatch(/lower\(ti\.email\) = lower\(au\.email\)/);
      expect(corpo).toMatch(/ti\.accepted_at is null/);
      expect(corpo).toMatch(/ti\.revoked_at is null/);
      expect(corpo).toMatch(/ti\.expires_at > now\(\)/);
    }
  });
});

describe("0907 parte 2: isenção 2, fn_billing_veio_de_aceite_de_convite", () => {
  it("em inserção, isento quando invited_by OU invited_at vêm preenchidos", () => {
    for (const sql of [MIGRATION_0907, BASELINE]) {
      const inicio = sql.indexOf("create or replace function public.fn_billing_veio_de_aceite_de_convite(");
      const corpo = sql.slice(inicio, sql.indexOf("$$;", inicio));
      expect(corpo).toMatch(
        /when p_insercao then p_invited_by_novo is not null or p_invited_at_novo is not null/,
      );
    }
  });

  it("em atualização, isento só quando invited_by ou invited_at MUDARAM (novo distinto do antigo)", () => {
    for (const sql of [MIGRATION_0907, BASELINE]) {
      const inicio = sql.indexOf("create or replace function public.fn_billing_veio_de_aceite_de_convite(");
      const corpo = sql.slice(inicio, sql.indexOf("$$;", inicio));
      expect(corpo).toMatch(
        /else p_invited_by_novo is distinct from p_invited_by_antigo\s*\n\s*or p_invited_at_novo is distinct from p_invited_at_antigo/,
      );
    }
  });
});

describe("0907 parte 2: isenção 3, fn_billing_dono_do_provisionamento", () => {
  it("exige role admin E organizations.created_by = p_user (o dono que criou a própria organização)", () => {
    for (const sql of [MIGRATION_0907, BASELINE]) {
      const inicio = sql.indexOf("create or replace function public.fn_billing_dono_do_provisionamento(");
      const corpo = sql.slice(inicio, sql.indexOf("$$;", inicio));
      expect(corpo).toMatch(
        /select p_role = 'admin' and exists \(\s*\n\s*select 1 from public\.organizations o\s*\n\s*where o\.id = p_org and o\.created_by = p_user\s*\n\s*\);/,
      );
    }
  });
});

describe("0907 parte 2: fn_billing_convite_ja_tem_vinculo_ativo (fecha o dobro da contagem no aceite)", () => {
  it("um convite só está 'já com vínculo ativo' quando existe membro ativo, não revogado, não provisório, do mesmo e-mail", () => {
    for (const sql of [MIGRATION_0907, BASELINE]) {
      const inicio = sql.indexOf("create or replace function public.fn_billing_convite_ja_tem_vinculo_ativo(");
      const corpo = sql.slice(inicio, sql.indexOf("$$;", inicio));
      expect(corpo).toMatch(/uo\.accepted_at is not null/);
      expect(corpo).toMatch(/uo\.revoked_at is null/);
      expect(corpo).toMatch(/not uo\.provisional_until_handover/);
      expect(corpo).toMatch(/lower\(au\.email\) = lower\(ti\.email\)/);
    }
  });
});

describe("0905 (editado NO LUGAR, Tarefa 2): gatilho de team_invites bloqueia sem isenção nenhuma", () => {
  it("fn_billing_bloqueia(membros) roda ANTES de fn_billing_conferir_teto, dentro da mesma transição de pendente", () => {
    for (const sql of [MIGRATION_0905, BASELINE]) {
      const inicio = sql.indexOf("create or replace function public.fn_billing_trava_team_invites(");
      const corpo = sql.slice(inicio, sql.indexOf("$$;", inicio));
      const posSe = corpo.indexOf("if v_novo_pendente and not v_antigo_pendente then");
      const posBloqueia = corpo.indexOf("if public.fn_billing_bloqueia(new.organization_id, 'membros', null) then", posSe);
      const posConferir = corpo.indexOf("perform public.fn_billing_conferir_teto(new.organization_id, 'membros', null);", posSe);
      expect(posSe).toBeGreaterThan(-1);
      expect(posBloqueia).toBeGreaterThan(posSe);
      expect(posConferir).toBeGreaterThan(posBloqueia);
    }
  });

  it("o raise PT402 fica fora de qualquer bloco exception (a função inteira não tem exception when others)", () => {
    for (const sql of [MIGRATION_0905, BASELINE]) {
      const inicio = sql.indexOf("create or replace function public.fn_billing_trava_team_invites(");
      const corpo = sql.slice(inicio, sql.indexOf("$$;", inicio));
      expect(corpo).not.toMatch(/exception\s*\n\s*when others/);
      expect(corpo).toMatch(
        /if public\.fn_billing_bloqueia\(new\.organization_id, 'membros', null\) then\s*\n\s*raise exception 'Limite do plano atingido' using errcode = 'PT402', detail = 'membros';\s*\n\s*end if;/,
      );
    }
  });
});

describe("0905 (editado NO LUGAR, Tarefa 2): gatilho de user_organizations com as três isenções da decisão 4", () => {
  it("compara invited_by/invited_at novo x antigo antes de chamar a isenção de aceite (guarda contra 'old' em INSERT)", () => {
    for (const sql of [MIGRATION_0905, BASELINE]) {
      const inicio = sql.indexOf("create or replace function public.fn_billing_trava_user_organizations(");
      const corpo = sql.slice(inicio, sql.indexOf("$$;", inicio));
      expect(corpo).toMatch(/v_invited_by_antigo uuid;/);
      expect(corpo).toMatch(/v_invited_at_antigo timestamptz;/);
      expect(corpo).toMatch(
        /if tg_op = 'INSERT' then\s*\n\s*v_antigo_ativo := false;\s*\n\s*v_invited_by_antigo := null;\s*\n\s*v_invited_at_antigo := null;/,
      );
      expect(corpo).toMatch(/v_invited_by_antigo := old\.invited_by;/);
      expect(corpo).toMatch(/v_invited_at_antigo := old\.invited_at;/);
    }
  });

  it("as três isenções (convite pendente, aceite sem convite, dono do provisionamento) são OR'adas antes do bloqueio", () => {
    for (const sql of [MIGRATION_0905, BASELINE]) {
      const inicio = sql.indexOf("create or replace function public.fn_billing_trava_user_organizations(");
      const corpo = sql.slice(inicio, sql.indexOf("$$;", inicio));
      const posIf = corpo.indexOf("if not (");
      const posIsencao1 = corpo.indexOf("public.fn_billing_convite_pendente_do_membro(new.organization_id, new.user_id)", posIf);
      const posIsencao2 = corpo.indexOf("public.fn_billing_veio_de_aceite_de_convite(", posIf);
      const posIsencao3 = corpo.indexOf("public.fn_billing_dono_do_provisionamento(new.organization_id, new.user_id, new.role)", posIf);
      const posBloqueia = corpo.indexOf("if public.fn_billing_bloqueia(new.organization_id, 'membros', null) then", posIf);
      expect(posIf).toBeGreaterThan(-1);
      expect(posIsencao1).toBeGreaterThan(posIf);
      expect(posIsencao2).toBeGreaterThan(posIsencao1);
      expect(posIsencao3).toBeGreaterThan(posIsencao2);
      expect(posBloqueia).toBeGreaterThan(posIsencao3);
    }
  });

  it("fn_billing_veio_de_aceite_de_convite recebe novo x antigo e o booleano de inserção (tg_op = 'INSERT')", () => {
    for (const sql of [MIGRATION_0905, BASELINE]) {
      const inicio = sql.indexOf("create or replace function public.fn_billing_trava_user_organizations(");
      const corpo = sql.slice(inicio, sql.indexOf("$$;", inicio));
      expect(corpo).toMatch(
        /public\.fn_billing_veio_de_aceite_de_convite\(\s*\n\s*new\.invited_by, new\.invited_at, v_invited_by_antigo, v_invited_at_antigo, tg_op = 'INSERT'\s*\n\s*\)/,
      );
    }
  });

  it("o raise PT402 do bloqueio fica DENTRO do 'if not (isenções)', mas fora de qualquer bloco exception", () => {
    for (const sql of [MIGRATION_0905, BASELINE]) {
      const inicio = sql.indexOf("create or replace function public.fn_billing_trava_user_organizations(");
      const corpo = sql.slice(inicio, sql.indexOf("$$;", inicio));
      expect(corpo).not.toMatch(/exception\s*\n\s*when others/);
      expect(corpo).toMatch(
        /if public\.fn_billing_bloqueia\(new\.organization_id, 'membros', null\) then\s*\n\s*raise exception 'Limite do plano atingido' using errcode = 'PT402', detail = 'membros';\s*\n\s*end if;/,
      );
    }
  });

  it("a conferência de AVISO continua rodando incondicionalmente, mesmo quando a isenção libera o bloqueio", () => {
    for (const sql of [MIGRATION_0905, BASELINE]) {
      const inicio = sql.indexOf("create or replace function public.fn_billing_trava_user_organizations(");
      const corpo = sql.slice(inicio, sql.indexOf("$$;", inicio));
      // "perform fn_billing_conferir_teto" tem que estar FORA do "if not
      // (isenções)" (que só envolve o bloqueio), mas ainda dentro do "if
      // v_novo_ativo and not v_antigo_ativo".
      const posFimIsencoes = corpo.indexOf("end if;\n    end if;\n    perform public.fn_billing_conferir_teto");
      expect(posFimIsencoes).toBeGreaterThan(-1);
    }
  });
});

describe("0905 (editado NO LUGAR, Tarefa 2): fn_billing_uso e fn_billing_pode_criar não dobram a contagem no aceite", () => {
  it("as duas funções filtram o convite pendente cujo e-mail já tem vínculo ativo", () => {
    for (const sql of [MIGRATION_0905, BASELINE]) {
      const ocorrencias = [
        ...sql.matchAll(/and not public\.fn_billing_convite_ja_tem_vinculo_ativo\(ti\.id\)/g),
      ];
      // Uma em fn_billing_uso, outra em fn_billing_pode_criar.
      expect(ocorrencias.length).toBe(2);
    }
  });

  it("o filtro está dentro da subconsulta de team_invites de cada função de leitura", () => {
    for (const sql of [MIGRATION_0905, BASELINE]) {
      for (const nome of ["fn_billing_uso", "fn_billing_pode_criar"]) {
        const inicio = sql.indexOf(`create or replace function public.${nome}(`);
        const corpo = sql.slice(inicio, sql.indexOf("$$;", inicio));
        expect(corpo, nome).toMatch(
          /from public\.team_invites ti\s*\n\s*where ti\.organization_id = p_org\s*\n\s*and ti\.accepted_at is null\s*\n\s*and ti\.revoked_at is null\s*\n\s*and ti\.expires_at > now\(\)\s*\n\s*and not public\.fn_billing_convite_ja_tem_vinculo_ativo\(ti\.id\)/,
        );
      }
    }
  });
});
