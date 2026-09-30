import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Migration 0913 (D-082, fork Hiperbold): a estimativa de custo de
 * `fn_billing_margem_do_ciclo` casa o modelo pelo prefixo "fabricante/". Este
 * arquivo cobre a FORMA (migration e baseline dizem a mesma coisa, no lugar
 * certo, com as garantias de segurança da função); o COMPORTAMENTO em banco
 * (chamada pelo gateway entra na estimativa e não em chamadas_sem_preco, e as
 * linhas que já casavam ficam iguais) é provado por
 * `tests/invariants/planos-estimativa-custo-prefixo.test.ts`, que precisa de
 * Docker (`pnpm test:db`).
 */

const MIGRATION = readFileSync(
  join(process.cwd(), "supabase/migrations/20260930110000_0913_estimativa_de_custo_pelo_prefixo_do_modelo.sql"),
  "utf8",
);
const BASELINE = readFileSync(join(process.cwd(), "supabase/baseline.sql"), "utf8");
const MANIFEST = readFileSync(join(process.cwd(), "supabase/migrations/MANIFEST.md"), "utf8");

const MARCADOR_0913 = "-- ---- estimativa de custo da margem casa o modelo pelo prefixo (migration 0913";
const ASSINATURA = "create or replace function public.fn_billing_margem_do_ciclo(p_org uuid, p_ciclo date)";

/** Do marcador do bloco 0913 até (sem incluir) o cabeçalho do PRÓXIMO bloco. */
function extraiBloco0913Baseline(): string {
  const posicaoMarcador = BASELINE.indexOf(MARCADOR_0913);
  const fim = BASELINE.indexOf("\n-- ---- ", posicaoMarcador + MARCADOR_0913.length);
  return BASELINE.slice(posicaoMarcador, fim + 1);
}

function semComentariosEBrancas(sql: string): string {
  return sql
    .split("\n")
    .map((linha) => linha.trim())
    .filter((linha) => linha.length > 0 && !linha.startsWith("--"))
    .join("\n");
}

/** O corpo da função, do `create or replace` até o `$$;` que a fecha. */
function corpoDaFuncao(sql: string): string {
  // O texto do bloco/migration 0913 tem UMA definição; no baseline inteiro há
  // mais de uma, e quem vale é a última (por isso aqui se passa o bloco, nunca o arquivo).
  const inicio = sql.lastIndexOf(ASSINATURA);
  expect(inicio, "definição não achada").toBeGreaterThan(-1);
  return sql.slice(inicio, sql.indexOf("$$;", sql.indexOf("as $$", inicio)) + 3);
}

describe("0913: estimativa de custo pelo prefixo do modelo (posição e igualdade)", () => {
  it("o bloco do baseline vem depois do bloco da 0912 e antes da VARREDURA anon", () => {
    const inicio0912 = BASELINE.indexOf("-- ---- aceitar um convite não dobra a conta do membro (migration 0912");
    const inicio0913 = BASELINE.indexOf(MARCADOR_0913);
    const varreduraAnon = BASELINE.lastIndexOf("-- ---- VARREDURA anon:");
    expect(inicio0912).toBeGreaterThan(-1);
    expect(inicio0913).toBeGreaterThan(-1);
    expect(varreduraAnon).toBeGreaterThan(-1);
    expect(inicio0912).toBeLessThan(inicio0913);
    // A VARREDURA anon é o último bloco de propósito: função criada depois dela
    // nasceria exposta a anon em quem atualiza.
    expect(inicio0913).toBeLessThan(varreduraAnon);
  });

  it("o SQL da migração e o SQL do bloco do baseline são iguais, ignorando comentários e linhas em branco", () => {
    expect(semComentariosEBrancas(extraiBloco0913Baseline())).toBe(semComentariosEBrancas(MIGRATION));
  });

  it("a ÚLTIMA definição da função no baseline é a da 0913 (última definição vale)", () => {
    const ultimaNoBaseline = BASELINE.lastIndexOf(ASSINATURA);
    expect(ultimaNoBaseline).toBeGreaterThan(BASELINE.indexOf(MARCADOR_0913));
  });

  it("está registrada no MANIFEST", () => {
    expect(MANIFEST).toMatch(/\| `20260930110000` \| `0913_estimativa_de_custo_pelo_prefixo_do_modelo` \|/);
  });

  it("nenhuma linha da migração usa travessão (U+2014)", () => {
    expect(MIGRATION.split("\n").filter((linha) => linha.includes(String.fromCharCode(0x2014)))).toEqual([]);
  });
});

describe("0913: o que a estimativa passa a fazer", () => {
  for (const [nome, sql] of [
    ["migração", MIGRATION],
    ["bloco do baseline", extraiBloco0913Baseline()],
  ] as const) {
    describe(nome, () => {
      const corpo = corpoDaFuncao(sql);

      it("mantém as cinco condições antigas de busca no catálogo, na mesma forma", () => {
        expect(corpo).toMatch(/\(m\.provider = s\.provider and m\.model_id = s\.model\)/);
        expect(corpo).toMatch(/or \(m\.provider = s\.provider and m\.model_id = s\.modelo_sem_prefixo\)/);
        expect(corpo).toMatch(/or \(m\.provider = 'openrouter' and m\.model_id = s\.model\)/);
        expect(corpo).toMatch(/or m\.model_id = s\.model\s*\n/);
        expect(corpo).toMatch(/or m\.model_id = s\.modelo_sem_prefixo\s*\n/);
        expect(corpo).toMatch(
          /case when c\.model like c\.provider \|\| '\/%' then substring\(c\.model from length\(c\.provider\) \+ 2\) else c\.model end as modelo_sem_prefixo/,
        );
      });

      it("acrescenta o par (provider antes da barra, model_id depois dela), só para model com barra", () => {
        expect(corpo).toMatch(
          /case when position\('\/' in c\.model\) > 1 then split_part\(c\.model, '\/', 1\) else null end as provider_do_prefixo/,
        );
        expect(corpo).toMatch(
          /case when position\('\/' in c\.model\) > 1 then substring\(c\.model from position\('\/' in c\.model\) \+ 1\) else null end as modelo_depois_da_barra/,
        );
        expect(corpo).toMatch(
          /or \(m\.provider = s\.provider_do_prefixo and m\.model_id = s\.modelo_depois_da_barra\)/,
        );
      });

      it("o candidato novo tem a ÚLTIMA preferência: as quatro faixas antigas mantêm a ordem", () => {
        expect(corpo).toMatch(
          /when m\.provider = s\.provider and m\.model_id = s\.model then 1\s*when m\.provider = s\.provider and m\.model_id = s\.modelo_sem_prefixo then 2\s*when m\.provider = 'openrouter' and m\.model_id = s\.model then 3\s*when m\.model_id = s\.model or m\.model_id = s\.modelo_sem_prefixo then 4\s*else 5/,
        );
      });

      it("assinatura, STABLE, security definer e search_path fixo iguais aos da 0906", () => {
        expect(corpo).toMatch(
          /^create or replace function public\.fn_billing_margem_do_ciclo\(p_org uuid, p_ciclo date\)\s*returns jsonb\s*language plpgsql\s*stable\s*security definer\s*set search_path = public, pg_temp/,
        );
      });

      it("o retorno continua com as oito chaves", () => {
        for (const chave of [
          "receita_plano_cents",
          "receita_adicionais_cents",
          "receita_creditos_cents",
          "receita_total_cents",
          "custo_conhecido_cents",
          "custo_estimado_cents",
          "chamadas_estimadas",
          "chamadas_sem_preco",
        ]) {
          expect(corpo, chave).toContain(`'${chave}'`);
        }
      });

      it("não recria tabela, índice nem gatilho: só o corpo da função (reaplicável com o app no ar)", () => {
        const codigo = semComentariosEBrancas(sql);
        expect(codigo).not.toMatch(/create trigger/);
        expect(codigo).not.toMatch(/drop trigger/);
        expect(codigo).not.toMatch(/alter table/);
        expect(codigo).not.toMatch(/create table/);
        expect(codigo).not.toMatch(/create index/);
      });

      it("revoga de public, anon e authenticated e dá execute só ao service_role", () => {
        expect(sql).toMatch(
          /revoke execute on function public\.fn_billing_margem_do_ciclo\(uuid, date\) from public, anon, authenticated;/,
        );
        expect(sql).toMatch(/grant execute on function public\.fn_billing_margem_do_ciclo\(uuid, date\) to service_role;/);
      });
    });
  }
});
