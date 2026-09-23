import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATION = readFileSync(
  join(process.cwd(), "supabase/migrations/20260923020000_0904_planos_de_assinatura.sql"),
  "utf8",
);
const BASELINE = readFileSync(join(process.cwd(), "supabase/baseline.sql"), "utf8");

const TABELAS = ["billing_plans", "billing_contracts", "billing_plan_adjustments"] as const;

// Números semeados na fase F1 (hiperbold/planos/fase-F1-tarefas.md, seção
// "Dados semeados"). Se a migration mudar um valor sem atualizar este teste,
// o teste tem que quebrar: é a prova de que a tabela do documento e o banco
// concordam.
const PLANOS_SEMEADOS = [
  {
    code: "ilimitado",
    price_monthly_cents: 0,
    grace_days: 7,
    limits: {
      funis: null,
      etapas_por_funil: null,
      leads: null,
      membros: null,
      conexoes: null,
      integracoes_webhook: null,
      tokens_ia_mes: null,
    },
  },
  {
    code: "pro",
    price_monthly_cents: 19900,
    grace_days: 7,
    limits: {
      funis: 5,
      etapas_por_funil: 10,
      leads: 5000,
      membros: 3,
      conexoes: 3,
      integracoes_webhook: 3,
      tokens_ia_mes: 1000000,
    },
  },
  {
    code: "max",
    price_monthly_cents: 39900,
    grace_days: 7,
    limits: {
      funis: 10,
      etapas_por_funil: 15,
      leads: 50000,
      membros: 15,
      conexoes: 10,
      integracoes_webhook: 10,
      tokens_ia_mes: 1000000,
    },
  },
  {
    code: "escale",
    price_monthly_cents: 59900,
    grace_days: 7,
    limits: {
      funis: 25,
      etapas_por_funil: 20,
      leads: 100000,
      membros: 30,
      conexoes: 20,
      integracoes_webhook: 20,
      tokens_ia_mes: 1000000,
    },
  },
];

/**
 * Extrai o bloco 0904 do baseline: do começo da linha do marcador de início
 * até (sem incluir) o cabeçalho do PRÓXIMO bloco (`-- ---- `), qualquer que
 * seja ele. A primeira versão cortava na VARREDURA anon, supondo que o bloco
 * da 0904 seria sempre o último antes dela; a 0905 entrou no meio (tem de
 * entrar, porque função nova não pode nascer depois da varredura) e a
 * comparação quebrou. Achar o próximo cabeçalho não depende de qual bloco vem
 * depois.
 */
function extraiBlocoBaseline(): string {
  const marcadorInicio = "catálogo de planos e contrato da organização (migration 0904";
  const posicaoMarcador = BASELINE.indexOf(marcadorInicio);
  const inicioLinha = BASELINE.lastIndexOf("\n", posicaoMarcador) + 1;
  const fim = BASELINE.indexOf("\n-- ---- ", posicaoMarcador);
  return BASELINE.slice(inicioLinha, fim + 1);
}

/** Remove linhas de comentário (--) e linhas em branco, para comparar só o SQL. */
function removeComentariosEBrancas(sql: string): string {
  return sql
    .split("\n")
    .map((linha) => linha.trim())
    .filter((linha) => linha.length > 0 && !linha.startsWith("--"))
    .join("\n");
}

describe("0904 catálogo de planos e contrato da organização", () => {
  it("o bloco do baseline vem depois do último apêndice 09xx e antes da VARREDURA anon", () => {
    const inicioBloco = BASELINE.indexOf(
      "catálogo de planos e contrato da organização (migration 0904",
    );
    const varreduraAnon = BASELINE.lastIndexOf("-- ---- VARREDURA anon:");

    expect(inicioBloco).toBeGreaterThan(-1);
    expect(varreduraAnon).toBeGreaterThan(-1);
    expect(inicioBloco).toBeLessThan(varreduraAnon);
  });

  it("o SQL da migração e o SQL do bloco do baseline são iguais, ignorando comentários e linhas em branco", () => {
    const sqlMigracao = removeComentariosEBrancas(MIGRATION);
    const sqlBloco = removeComentariosEBrancas(extraiBlocoBaseline());
    expect(sqlBloco).toBe(sqlMigracao);
  });

  it("as três tabelas têm RLS ligada, na migration e no baseline", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      for (const tabela of TABELAS) {
        expect(sql).toMatch(
          new RegExp(`alter table public\\.${tabela} enable row level security`),
        );
      }
    }
  });

  it("não existe política de escrita (insert, update, delete ou all) nas três tabelas", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      // Toda `create policy` das três tabelas tem que ser `for select`.
      const criasDePolicy = [
        ...sql.matchAll(/create policy\s+(\S+)\s+on\s+public\.(\S+)\s*\n?\s*for\s+(\w+)/g),
      ].filter((m) => (TABELAS as readonly string[]).includes(m[2] ?? ""));

      expect(criasDePolicy.length).toBeGreaterThan(0);
      for (const match of criasDePolicy) {
        expect(match[3]).toBe("select");
      }

      // E nenhuma dessas três tabelas aparece num `create policy ... for all`.
      for (const tabela of TABELAS) {
        const regexPolicyAll = new RegExp(
          `create policy\\s+\\S+\\s+on\\s+public\\.${tabela}[\\s\\S]{0,80}for\\s+all`,
        );
        expect(sql).not.toMatch(regexPolicyAll);
      }
    }
  });

  it("a semeadura dos planos usa on conflict do nothing", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      expect(sql).toMatch(/on conflict \(code, version\) do nothing/);
    }
  });

  it("o backfill de contrato das organizações existentes usa where not exists e on conflict do nothing", () => {
    // Busca só dentro do bloco da 0904: o baseline inteiro tem outras
    // migrations com `where not exists`/`on conflict (organization_id) do
    // nothing` que satisfazem a busca sem provar nada sobre esta migração.
    for (const sql of [MIGRATION, extraiBlocoBaseline()]) {
      expect(sql).toMatch(/where not exists/);
      expect(sql).toMatch(/on conflict \(organization_id\) do nothing/);
    }
  });

  it("os números semeados batem com a tabela da fase F1", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      for (const plano of PLANOS_SEMEADOS) {
        const regexLinha = new RegExp(
          `\\('${plano.code}',\\s*1,\\s*true,[^)]*${plano.price_monthly_cents},\\s*null,\\s*${plano.grace_days}`,
        );
        expect(sql).toMatch(regexLinha);

        for (const [chave, valor] of Object.entries(plano.limits)) {
          const valorEsperado = valor === null ? "null" : String(valor);
          expect(sql).toMatch(new RegExp(`'${chave}',\\s*${valorEsperado}\\b`));
        }
      }
    }
  });

  it("as funções de escrita revogam execute de authenticated (e de public e anon)", () => {
    const funcoesDeEscrita = [
      "fn_billing_contrato_da_organizacao_nova()",
      "fn_billing_limites_efetivos(uuid)",
      "fn_billing_trocar_plano(uuid, text, uuid)",
      "fn_billing_ajustar_limites(uuid, jsonb, text, uuid)",
    ];

    for (const sql of [MIGRATION, BASELINE]) {
      for (const assinatura of funcoesDeEscrita) {
        const nome = assinatura.slice(0, assinatura.indexOf("("));
        const regexRevoke = new RegExp(
          `revoke execute on function public\\.${nome}\\([^)]*\\) from public, anon, authenticated`,
        );
        expect(sql).toMatch(regexRevoke);
      }
    }
  });

  it("fn_billing_limites_validos é a exceção documentada: sem revoke/grant próprio", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      expect(sql).not.toMatch(
        /revoke execute on function public\.fn_billing_limites_validos/,
      );
      expect(sql).not.toMatch(
        /grant execute on function public\.fn_billing_limites_validos/,
      );
    }
  });

  it("a função que confere os limites é security definer com search_path fixo", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      for (const nome of [
        "fn_billing_contrato_da_organizacao_nova",
        "fn_billing_limites_efetivos",
        "fn_billing_trocar_plano",
        "fn_billing_ajustar_limites",
      ]) {
        const inicio = sql.indexOf(`create or replace function public.${nome}(`);
        expect(inicio).toBeGreaterThan(-1);
        const trecho = sql.slice(inicio, inicio + 400);
        expect(trecho).toMatch(/security definer/);
        expect(trecho).toMatch(/set search_path = public, pg_temp/);
      }
    }
  });

  it("a coluna code do plano tem o formato do documento e uma única versão ativa por code", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      expect(sql).toContain("code ~ '^[a-z][a-z0-9_]{1,30}$'");
      expect(sql).toMatch(/create unique index if not exists billing_plans_code_ativo_unique/);
      expect(sql).toMatch(/on public\.billing_plans \(code\)\s*\n\s*where active/);
    }
  });

  it("billing_contracts tem uma linha por organização", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      expect(sql).toMatch(/constraint billing_contracts_organization_id_key unique \(organization_id\)/);
    }
  });

  /**
   * A primeira versão revogava só insert, update e delete de `authenticated`.
   * O grant padrão do Supabase dá também truncate, references e trigger, e
   * truncate passa por cima da RLS: medido no banco local, as três tabelas
   * ficavam com TRUNCATE para qualquer usuário logado. Revogar tudo e devolver
   * só o select é a única forma que não depende de lembrar cada privilégio.
   */
  it("authenticated perde tudo e recebe de volta só o select", () => {
    const listaTres = "public\\.billing_plans, public\\.billing_contracts, public\\.billing_plan_adjustments";
    // billing_plan_adjustments saiu do grant select de tabela inteira (nota e
    // autor do ajuste não são assunto do membro): o select dela volta por
    // coluna, conferido no caso seguinte.
    const listaSemAjuste = "public\\.billing_plans, public\\.billing_contracts";
    for (const sql of [MIGRATION, BASELINE]) {
      expect(sql).toMatch(new RegExp(`revoke all on ${listaTres} from anon, authenticated;`));
      expect(sql).toMatch(new RegExp(`grant select on ${listaSemAjuste} to authenticated;`));
      expect(sql).not.toMatch(/revoke insert, update, delete on public\.billing_/);
    }
  });

  it("nota e autor do ajuste (note, granted_by) não vazam pelo grant: select só por coluna, sem billing_plan_adjustments na lista inteira", () => {
    for (const sql of [MIGRATION, BASELINE]) {
      expect(sql).toMatch(
        /grant select \(organization_id, limits, created_at, updated_at\) on public\.billing_plan_adjustments to authenticated;/,
      );
      // Nenhum `grant select on` com as três tabelas na mesma lista: essa
      // era a falha (billing_plan_adjustments recebia select da tabela
      // inteira, então note e granted_by ficavam legíveis por authenticated).
      expect(sql).not.toMatch(
        /grant select on public\.billing_plans, public\.billing_contracts, public\.billing_plan_adjustments to authenticated;/,
      );
    }
  });
});
