import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATION = readFileSync(
  join(process.cwd(), "supabase/migrations/20260923100000_0905_planos_uso_e_trava.sql"),
  "utf8",
);
const BASELINE = readFileSync(join(process.cwd(), "supabase/baseline.sql"), "utf8");

const TABELAS = ["billing_settings", "billing_usage_counters"] as const;

const FUNCOES_DE_LEITURA = ["fn_billing_uso(uuid)", "fn_billing_pode_criar(uuid, text, uuid)"] as const;

/**
 * Extrai o bloco 0905 do baseline: do marcador de início até (sem incluir) o
 * cabeçalho do PRÓXIMO bloco (`-- ---- `), qualquer que seja ele. Cortar na
 * VARREDURA anon quebraria no dia em que outro bloco entrar entre este e ela,
 * que foi exatamente o que aconteceu com o teste da 0904 quando a 0905 chegou.
 */
function extraiBlocoBaseline(): string {
  const marcadorInicio = "-- ---- uso dos planos e trava (migration 0905";
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

describe("0905 uso dos planos e trava (parte 1, Tarefa 2)", () => {
  it("o bloco do baseline vem depois do bloco da 0904 e antes da VARREDURA anon", () => {
    const inicioBloco0904 = BASELINE.indexOf(
      "catálogo de planos e contrato da organização (migration 0904",
    );
    const inicioBloco0905 = BASELINE.indexOf("-- ---- uso dos planos e trava (migration 0905");
    const varreduraAnon = BASELINE.lastIndexOf("-- ---- VARREDURA anon:");

    expect(inicioBloco0904).toBeGreaterThan(-1);
    expect(inicioBloco0905).toBeGreaterThan(-1);
    expect(varreduraAnon).toBeGreaterThan(-1);
    expect(inicioBloco0904).toBeLessThan(inicioBloco0905);
    expect(inicioBloco0905).toBeLessThan(varreduraAnon);
  });

  it("o SQL da migração e o SQL do bloco do baseline são iguais, ignorando comentários e linhas em branco", () => {
    const sqlMigracao = removeComentariosEBrancas(MIGRATION);
    const sqlBloco = removeComentariosEBrancas(extraiBlocoBaseline());
    expect(sqlBloco).toBe(sqlMigracao);
  });

  it("as duas tabelas têm RLS ligada, na migration e no baseline", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      for (const tabela of TABELAS) {
        expect(sql).toMatch(
          new RegExp(`alter table public\\.${tabela} enable row level security`),
        );
      }
    }
  });

  it("billing_settings: check de singleton (id = 1) e check de modo", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      expect(sql).toContain("constraint billing_settings_id_singleton check (id = 1)");
      expect(sql).toContain(
        "constraint billing_settings_modo_check check (modo in ('desligado', 'avisar', 'bloquear'))",
      );
    }
  });

  it("billing_settings semeia a linha única com on conflict do nothing", () => {
    for (const sql of [MIGRATION, extraiBlocoBaseline()]) {
      expect(sql).toMatch(/insert into public\.billing_settings \(id, modo\)/);
      expect(sql).toMatch(/values \(1, 'avisar'\)/);
      expect(sql).toMatch(/on conflict \(id\) do nothing/);
    }
  });

  it("billing_usage_counters: chave primária composta e check do item fechado em leads", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      expect(sql).toMatch(/primary key \(organization_id, item\)/);
      expect(sql).toContain("constraint billing_usage_counters_item_check check (item in ('leads'))");
      expect(sql).toContain("constraint billing_usage_counters_valor_nao_negativo check (valor >= 0)");
    }
  });

  it("o preenchimento inicial conta leads abertos e é idempotente por on conflict do update", () => {
    for (const sql of [MIGRATION, extraiBlocoBaseline()]) {
      expect(sql).toMatch(/from public\.crm_leads cl/);
      expect(sql).toMatch(/where cl\.status = 'open'/);
      expect(sql).toMatch(/group by cl\.organization_id/);
      expect(sql).toMatch(/on conflict \(organization_id, item\) do update/);
      expect(sql).toMatch(/set valor = excluded\.valor/);
      // Idempotência por resultado, não por no-op: o PREENCHIMENTO INICIAL
      // nunca soma ao valor existente (senão rodar a migration de novo dobraria
      // a contagem). A busca fica só no primeiro insert do contador, que é o
      // preenchimento: o gatilho de leads, mais abaixo no arquivo, soma de
      // propósito, e é assim que ele tem de funcionar.
      const inicioDoPreenchimento = sql.indexOf("insert into public.billing_usage_counters");
      const fimDoPreenchimento = sql.indexOf(";", inicioDoPreenchimento);
      const preenchimento = sql.slice(inicioDoPreenchimento, fimDoPreenchimento);
      expect(inicioDoPreenchimento).toBeGreaterThan(-1);
      expect(preenchimento).toMatch(/group by cl\.organization_id/);
      expect(preenchimento).not.toMatch(/valor = (public\.)?billing_usage_counters\.valor \+/);
    }
  });

  it("authenticated perde tudo nas duas tabelas e recebe de volta só o select de billing_usage_counters", () => {
    const listaDuas = "public\\.billing_settings, public\\.billing_usage_counters";
    for (const sql of [MIGRATION, BASELINE]) {
      expect(sql).toMatch(new RegExp(`revoke all on ${listaDuas} from anon, authenticated;`));
      expect(sql).toMatch(/grant select on public\.billing_usage_counters to authenticated;/);

      // billing_settings não aparece em nenhum "grant select" de CÓDIGO (sql
      // puro, comentários fora): nada para authenticated. Comentários citam
      // "billing_settings" perto de "grant select" em prosa, por isso o
      // filtro de comentários vem antes desta checagem.
      const sqlSemComentarios = removeComentariosEBrancas(sql);
      expect(sqlSemComentarios).not.toMatch(/grant select[^;]*public\.billing_settings/);
    }
  });

  it("a policy de leitura de billing_usage_counters é só select, por organização ou admin da plataforma", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      expect(sql).toMatch(/create policy billing_usage_counters_select on public\.billing_usage_counters/);
      expect(sql).toMatch(/for select using/);
      expect(sql).toMatch(/organization_id in \(select public\.fn_user_org_ids\(\)\) or public\.fn_is_platform_admin\(\)/);
    }

    // billing_settings não ganha policy nenhuma nesta migração (sem grant, a
    // RLS fica moot para authenticated/anon; só service_role, que é bypassrls,
    // escreve e lê).
    for (const sql of [MIGRATION, extraiBlocoBaseline()]) {
      expect(sql).not.toMatch(/create policy[^;]*on public\.billing_settings/);
    }
  });

  it("fn_billing_uso e fn_billing_pode_criar são volatile, security definer, com search_path fixo", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      for (const nome of ["fn_billing_uso", "fn_billing_pode_criar"]) {
        const inicio = sql.indexOf(`create or replace function public.${nome}(`);
        expect(inicio).toBeGreaterThan(-1);
        const trecho = sql.slice(inicio, inicio + 300);
        expect(trecho).toMatch(/\bvolatile\b/);
        expect(trecho).not.toMatch(/\bstable\b/);
        expect(trecho).toMatch(/security definer/);
        expect(trecho).toMatch(/set search_path = public, pg_temp/);
      }
    }
  });

  it("as duas funções de leitura revogam execute de public, anon e authenticated, e concedem só a service_role", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      for (const assinatura of FUNCOES_DE_LEITURA) {
        const nome = assinatura.slice(0, assinatura.indexOf("("));
        const regexRevoke = new RegExp(
          `revoke execute on function public\\.${nome}\\([^)]*\\) from public, anon, authenticated`,
        );
        const regexGrant = new RegExp(
          `grant execute on function public\\.${nome}\\([^)]*\\) to service_role`,
        );
        expect(sql).toMatch(regexRevoke);
        expect(sql).toMatch(regexGrant);
      }
    }
  });

  it("fn_billing_pode_criar devolve pode/motivo/atual/teto, e pode só é falso quando atual >= teto", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      expect(sql).toMatch(/v_pode := v_atual < v_teto;/);
      expect(sql).toMatch(/v_motivo := case when v_pode then 'ok' else 'teto_atingido' end;/);
      expect(sql).toMatch(
        /'motivo', 'sem_limite', 'atual', null, 'teto', null/,
      );
      expect(sql).toMatch(
        /jsonb_build_object\('pode', v_pode, 'motivo', v_motivo, 'atual', v_atual, 'teto', v_teto\)/,
      );
    }
  });

  it("item desconhecido em fn_billing_pode_criar levanta exceção com mensagem fixa", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      expect(sql).toMatch(
        /if p_item not in \('funis', 'etapas_por_funil', 'leads', 'membros', 'conexoes', 'integracoes_webhook'\) then/,
      );
      expect(sql).toMatch(/raise exception 'billing_item_desconhecido' using errcode = '22023';/);
    }
  });

  it("etapas_por_funil em fn_billing_uso é o maior entre os funis ativos; em fn_billing_pode_criar é o do funil informado", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      expect(sql).toMatch(/select coalesce\(max\(t\.qtd\), 0\) into v_etapas_por_funil/);
      expect(sql).toMatch(
        /where pipeline_id = p_pipeline and organization_id = p_org and is_archived = false/,
      );
      expect(sql).toMatch(
        /raise exception 'billing_pipeline_obrigatorio_para_etapas_por_funil' using errcode = '22023';/,
      );
    }
  });

  it("contagem de membros exclui o admin provisório e soma convites pendentes não vencidos", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      expect(sql).toMatch(/and not uo\.provisional_until_handover/);
      expect(sql).toMatch(/from public\.team_invites ti/);
      expect(sql).toMatch(/and ti\.accepted_at is null/);
      expect(sql).toMatch(/and ti\.revoked_at is null/);
      expect(sql).toMatch(/and ti\.expires_at > now\(\)/);
    }
  });

  it("o bloco da role agent_worker cobre as duas tabelas novas e as duas funções novas", () => {
    for (const sql of [MIGRATION, extraiBlocoBaseline()]) {
      expect(sql).toMatch(/if exists \(select 1 from pg_roles where rolname = 'agent_worker'\) then/);
      expect(sql).toMatch(
        /revoke insert, update, delete, truncate on public\.billing_settings, public\.billing_usage_counters from agent_worker/,
      );
      expect(sql).toMatch(
        /revoke execute on function public\.fn_billing_uso\(uuid\), public\.fn_billing_pode_criar\(uuid, text, uuid\) from agent_worker/,
      );
    }
  });

  it("os dois gatilhos de updated_at da parte 1 nascem antes de qualquer gatilho de trava (Tarefa 3)", () => {
    // Substitui o caso homônimo anterior: quando só a Tarefa 2 existia, a
    // migração inteira só tinha os dois gatilhos de updated_at. Agora a
    // Tarefa 3 (parte 2) vive no MESMO arquivo (mesma exigência do
    // enunciado: "acrescenta a parte 2 no fim desse arquivo"), então a
    // migração inteira passa a ter mais gatilhos, o que este caso confere
    // é que a ORDEM continua certa: os dois de updated_at (parte 1) vêm
    // antes de qualquer gatilho de trava (parte 2).
    for (const sql of [MIGRATION, extraiBlocoBaseline()]) {
      const criasDeTrigger = [...sql.matchAll(/create trigger\s+(\S+)/g)].map((m) => m[1]);
      expect(criasDeTrigger.slice(0, 2)).toEqual([
        "trg_billing_settings_updated_at",
        "trg_billing_usage_counters_updated_at",
      ]);
      expect(criasDeTrigger.length).toBeGreaterThan(2);
    }
  });
});

describe("0905 os gatilhos que avisam (parte 2, Tarefa 3)", () => {
  const FUNCOES_DE_TRAVA_SEGURANCA_DEFINER = [
    "fn_billing_conferir_teto(uuid, text, uuid)",
    "fn_billing_trava_crm_pipelines()",
    "fn_billing_trava_crm_stages()",
    "fn_billing_trava_channel_sessions()",
    "fn_billing_trava_webhook_sources()",
    "fn_billing_trava_team_invites()",
    "fn_billing_trava_user_organizations()",
    "fn_billing_trava_crm_leads()",
    "fn_billing_conferir_contador(uuid)",
  ] as const;

  it("todas as nove funções novas da parte 2 são security definer com search_path fixo", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      for (const assinatura of FUNCOES_DE_TRAVA_SEGURANCA_DEFINER) {
        const nome = assinatura.slice(0, assinatura.indexOf("("));
        const inicio = sql.indexOf(`create or replace function public.${nome}(`);
        expect(inicio, `${nome} não encontrada`).toBeGreaterThan(-1);
        const trecho = sql.slice(inicio, inicio + 300);
        expect(trecho).toMatch(/security definer/);
        expect(trecho).toMatch(/set search_path = public, pg_temp/);
      }
    }
  });

  it("todas as nove funções novas revogam execute de public/anon/authenticated e concedem só a service_role", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      for (const assinatura of FUNCOES_DE_TRAVA_SEGURANCA_DEFINER) {
        const nome = assinatura.slice(0, assinatura.indexOf("("));
        const chamada = assinatura.slice(assinatura.indexOf("("));
        const escapado = chamada.replace(/[().]/g, (c) => `\\${c}`);
        const regexRevoke = new RegExp(
          `revoke execute on function public\\.${nome}${escapado} from public, anon, authenticated`,
        );
        const regexGrant = new RegExp(`grant execute on function public\\.${nome}${escapado} to service_role`);
        expect(sql, `${nome}: revoke ausente`).toMatch(regexRevoke);
        expect(sql, `${nome}: grant ausente`).toMatch(regexGrant);
      }
    }
  });

  it("fn_billing_conferir_teto e fn_billing_conferir_contador são volatile", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      for (const nome of ["fn_billing_conferir_teto", "fn_billing_conferir_contador"]) {
        const inicio = sql.indexOf(`create or replace function public.${nome}(`);
        const trecho = sql.slice(inicio, inicio + 300);
        expect(trecho).toMatch(/\bvolatile\b/);
      }
    }
  });

  it("fn_billing_conferir_teto lê o modo e sai em 'desligado' antes de ler o teto", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      expect(sql).toMatch(/select modo into v_modo from public\.billing_settings where id = 1;/);
      expect(sql).toMatch(/if v_modo is null or v_modo = 'desligado' then/);
    }
  });

  it("fn_billing_conferir_teto lê o teto ANTES do advisory lock, e sai sem travar quando não há teto", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      const inicio = sql.indexOf("create or replace function public.fn_billing_conferir_teto(");
      const trecho = sql.slice(inicio, inicio + 1500);
      const posTeto = trecho.indexOf("v_teto := (public.fn_billing_limites_efetivos(p_org) ->> p_item)::integer;");
      const posSeTetoNulo = trecho.indexOf("if v_teto is null then");
      const posLock = trecho.indexOf("perform pg_advisory_xact_lock(");
      expect(posTeto).toBeGreaterThan(-1);
      expect(posSeTetoNulo).toBeGreaterThan(posTeto);
      expect(posLock).toBeGreaterThan(posSeTetoNulo);
    }
  });

  it("o advisory lock é pela chave (organização, item)", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      expect(sql).toMatch(
        /pg_advisory_xact_lock\(hashtextextended\('billing:' \|\| p_org::text \|\| ':' \|\| p_item, 0\)\)/,
      );
    }
  });

  it("modo bloquear se comporta como avisar nesta fase, com um raise warning a mais", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      expect(sql).toMatch(/if v_modo = 'bloquear' then/);
      expect(sql).toMatch(/raise warning 'billing_teto_ultrapassado_bloquearia_na_f3/);
    }
  });

  it("o aviso da Central é kind='other', ref_kind='billing_limite', deduplicado por organização + título ENQUANTO status='open'", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      expect(sql).toMatch(/and kind = 'other'/);
      expect(sql).toMatch(/and ref_kind = 'billing_limite'/);
      expect(sql).toMatch(/and title = v_titulo/);
      expect(sql).toMatch(/and status = 'open'/);
      expect(sql).toMatch(
        /insert into public\.agent_inbox_items \(organization_id, kind, severity, title, body, ref_kind, ref_id\)/,
      );
    }
  });

  it("fn_billing_conferir_teto captura qualquer erro (nunca derruba a operação)", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      const inicio = sql.indexOf("create or replace function public.fn_billing_conferir_teto(");
      const trecho = sql.slice(inicio, sql.indexOf("$$;", inicio));
      expect(trecho).toMatch(/exception\s*\n\s*when others then/);
    }
  });

  it("os seis gatilhos de transição são 'before insert or update of <coluna>', sem exceção de crm_leads", () => {
    const ESPERADOS = [
      { tabela: "crm_pipelines", coluna: "is_archived", nome: "trg_billing_trava_crm_pipelines" },
      { tabela: "crm_stages", coluna: "is_archived", nome: "trg_billing_trava_crm_stages" },
      { tabela: "channel_sessions", coluna: "archived_at", nome: "trg_billing_trava_channel_sessions" },
      { tabela: "webhook_sources", coluna: "is_active", nome: "trg_billing_trava_webhook_sources" },
      {
        tabela: "user_organizations",
        coluna: "accepted_at, revoked_at",
        nome: "trg_billing_trava_user_organizations",
      },
    ] as const;
    for (const sql of [MIGRATION, BASELINE]) {
      for (const { tabela, coluna, nome } of ESPERADOS) {
        const escapado = coluna.replace(/[(),]/g, (c) => `\\${c}`);
        const regex = new RegExp(
          `create trigger\\s+${nome}\\s+before insert or update of ${escapado} on public\\.${tabela}`,
        );
        expect(sql, `${nome} não bate com "before insert or update of ${coluna}"`).toMatch(regex);
      }
      // team_invites: só before insert (o convite nunca volta a ficar pendente por update).
      expect(sql).toMatch(
        /create trigger\s+trg_billing_trava_team_invites\s+before insert on public\.team_invites/,
      );
    }
  });

  it("o gatilho de crm_leads é after insert or update or delete, SEM lista de colunas", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      expect(sql).toMatch(
        /create trigger\s+trg_billing_trava_crm_leads\s+after insert or update or delete on public\.crm_leads/,
      );
      // "of" logo depois do nome da tabela provaria lista de colunas, não pode existir aqui.
      const inicio = sql.indexOf("create trigger\n  trg_billing_trava_crm_leads");
      const inicioAlt = sql.indexOf("trg_billing_trava_crm_leads\n  after insert or update or delete on public.crm_leads");
      expect(inicio > -1 || inicioAlt > -1).toBe(true);
    }
  });

  it("o gatilho de crm_leads soma por upsert ao entrar em open e subtrai por update simples (greatest) ao sair", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      expect(sql).toMatch(/if v_status_novo = 'open' then/);
      expect(sql).toMatch(/on conflict \(organization_id, item\) do update/);
      expect(sql).toMatch(/set valor = public\.billing_usage_counters\.valor \+ 1,/);
      expect(sql).toMatch(/elsif v_status_antigo = 'open' then/);
      expect(sql).toMatch(/set valor = greatest\(valor - 1, 0\),/);
      // A subtração é só update: não pode existir um "insert into
      // billing_usage_counters" no ramo de subtração (senão recriaria a
      // linha no meio de uma exclusão em cascata de organização).
      const ocorrenciasDeInsert = [
        ...sql.matchAll(/insert into public\.billing_usage_counters/g),
      ].length;
      // Uma no preenchimento inicial da parte 1, uma no ramo de soma do
      // gatilho de leads da parte 2, uma no ramo "sem linha" de
      // fn_billing_conferir_contador (achado 3, cria a linha que falta).
      // Nenhuma no ramo de subtração do gatilho de leads.
      expect(ocorrenciasDeInsert).toBe(3);
    }
  });

  it("o gatilho de crm_leads captura qualquer erro", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      const inicio = sql.indexOf("create or replace function public.fn_billing_trava_crm_leads(");
      const trecho = sql.slice(inicio, sql.indexOf("$$;", inicio));
      expect(trecho).toMatch(/exception\s*\n\s*when others then/);
    }
  });

  it("fn_billing_conferir_contador trava a linha (for update) e só num comando SEGUINTE conta e corrige", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      const inicio = sql.indexOf("create or replace function public.fn_billing_conferir_contador(");
      const trecho = sql.slice(inicio, sql.indexOf("$$;", inicio));
      const posFor = trecho.indexOf("for update;");
      const posCount = trecho.indexOf("select count(*) into v_real");
      const posUpdate = trecho.indexOf("update public.billing_usage_counters");
      expect(posFor).toBeGreaterThan(-1);
      expect(posCount).toBeGreaterThan(posFor);
      expect(posUpdate).toBeGreaterThan(posCount);
      expect(trecho).toMatch(/return v_divergia;/);
    }
  });

  it("fn_billing_conferir_contador, achado 3: recebe UMA organização (p_org uuid) e devolve boolean, não integer", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      expect(sql).toMatch(/create or replace function public\.fn_billing_conferir_contador\(p_org uuid\)/);
      const inicio = sql.indexOf("create or replace function public.fn_billing_conferir_contador(");
      const trecho = sql.slice(inicio, inicio + 200);
      expect(trecho).toMatch(/returns boolean/);
      // A versão antiga (sem argumento, retornava integer) foi removida: o
      // baseline precisa do drop para ficar idempotente (a 0905 nunca foi a
      // produção).
      expect(sql).toMatch(/drop function if exists public\.fn_billing_conferir_contadores\(\);/);
      expect(sql).not.toMatch(/create or replace function public\.fn_billing_conferir_contadores\(\)/);
    }
  });

  it("fn_billing_conferir_contador cria a linha do contador quando ela não existe, com a contagem real", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      const inicio = sql.indexOf("create or replace function public.fn_billing_conferir_contador(");
      const trecho = sql.slice(inicio, sql.indexOf("$$;", inicio));
      expect(trecho).toMatch(/insert into public\.billing_usage_counters \(organization_id, item, valor\)/);
      expect(trecho).toMatch(/values \(p_org, 'leads', v_real\)/);
      expect(trecho).toMatch(/on conflict \(organization_id, item\) do update/);
    }
  });

  it("o segundo bloco da role agent_worker revoga execute das nove funções novas da parte 2", () => {
    for (const sql of [MIGRATION, extraiBlocoBaseline()]) {
      // 3, não 2: um bloco por parte (1, 2 e 3; a Tarefa 4 acrescentou o
      // terceiro, próprio da função fn_billing_trava_ai_mcp_connections,
      // conferido à parte no describe do teto técnico de conexões MCP).
      const ocorrencias = [...sql.matchAll(/if exists \(select 1 from pg_roles where rolname = 'agent_worker'\) then/g)];
      expect(ocorrencias.length).toBe(3);
      for (const assinatura of FUNCOES_DE_TRAVA_SEGURANCA_DEFINER) {
        const nome = assinatura.slice(0, assinatura.indexOf("("));
        expect(sql).toMatch(new RegExp(`revoke execute on function[^;]*public\\.${nome}\\([^;]*from agent_worker`));
      }
    }
  });
});

describe("0905 teto técnico de conexões MCP (parte 3, Tarefa 4, D-034)", () => {
  it("fn_billing_trava_ai_mcp_connections é security definer com search_path fixo", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      const inicio = sql.indexOf("create or replace function public.fn_billing_trava_ai_mcp_connections(");
      expect(inicio, "fn_billing_trava_ai_mcp_connections não encontrada").toBeGreaterThan(-1);
      const trecho = sql.slice(inicio, inicio + 300);
      expect(trecho).toMatch(/security definer/);
      expect(trecho).toMatch(/set search_path = public, pg_temp/);
    }
  });

  it("revoga execute de public/anon/authenticated e concede só a service_role", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      expect(sql).toMatch(
        /revoke execute on function public\.fn_billing_trava_ai_mcp_connections\(\) from public, anon, authenticated/,
      );
      expect(sql).toMatch(
        /grant execute on function public\.fn_billing_trava_ai_mcp_connections\(\) to service_role/,
      );
    }
  });

  it("o gatilho é before insert (sem update) em ai_mcp_connections", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      expect(sql).toMatch(
        /create trigger\s+trg_billing_trava_ai_mcp_connections\s+before insert on public\.ai_mcp_connections/,
      );
    }
  });

  it("trava por pg_advisory_xact_lock com chave própria, fora da família 'billing:...'", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      expect(sql).toMatch(
        /pg_advisory_xact_lock\(hashtextextended\('ai_mcp_connections:' \|\| new\.organization_id::text, 0\)\)/,
      );
    }
  });

  it("conta as conexões da organização e recusa a partir de 10, com mensagem fixa e errcode PT422", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      expect(sql).toMatch(/from public\.ai_mcp_connections\s+where organization_id = new\.organization_id;/);
      expect(sql).toMatch(/if v_atual >= 10 then/);
      expect(sql).toMatch(/raise exception 'Limite de 10 conexões por organização' using errcode = 'PT422';/);
    }
  });

  it("o bloco da role agent_worker cobre a função nova desta parte 3", () => {
    for (const sql of [MIGRATION, extraiBlocoBaseline()]) {
      expect(sql).toMatch(
        /revoke execute on function public\.fn_billing_trava_ai_mcp_connections\(\) from agent_worker/,
      );
    }
  });
});
