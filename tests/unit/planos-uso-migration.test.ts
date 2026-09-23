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
      // Idempotência por resultado, não por no-op: nunca soma ao valor
      // existente (senão rodar a migration de novo dobraria a contagem).
      expect(sql).not.toMatch(/valor = (public\.)?billing_usage_counters\.valor \+/);
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

  it("nenhum gatilho de trava (Tarefa 3) nasce nesta parte da migração", () => {
    for (const sql of [MIGRATION, extraiBlocoBaseline()]) {
      expect(sql).not.toMatch(/fn_billing_conferir_teto/);
      expect(sql).not.toMatch(/fn_billing_conferir_contadores/);
      // Só os dois gatilhos de updated_at (não são trava) nascem aqui.
      const criasDeTrigger = [...sql.matchAll(/create trigger\s+(\S+)/g)].map((m) => m[1]);
      expect(criasDeTrigger).toEqual([
        "trg_billing_settings_updated_at",
        "trg_billing_usage_counters_updated_at",
      ]);
    }
  });
});
