import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Migration 0912 (D-053 item 1, fork Hiperbold): o aceite de convite conta a
 * pessoa uma vez. Este arquivo cobre a FORMA (migration e baseline dizem a
 * mesma coisa, no lugar certo, com as garantias de segurança da F2); o
 * COMPORTAMENTO em banco (aceitar convite no teto não avisa, e a pessoa conta
 * uma vez entre os dois passos do aceite) é provado por
 * `tests/invariants/planos-aceite-conta-uma-vez.test.ts`, que precisa de
 * Docker (`pnpm test:db`).
 */

const MIGRATION = readFileSync(
  join(process.cwd(), "supabase/migrations/20260930100000_0912_aceite_de_convite_nao_dobra_o_aviso.sql"),
  "utf8",
);
const BASELINE = readFileSync(join(process.cwd(), "supabase/baseline.sql"), "utf8");
const MANIFEST = readFileSync(join(process.cwd(), "supabase/migrations/MANIFEST.md"), "utf8");

/** Do marcador do bloco 0912 até (sem incluir) o cabeçalho do PRÓXIMO bloco. */
function extraiBloco0912Baseline(): string {
  const marcadorInicio = "-- ---- aceitar um convite não dobra a conta do membro (migration 0912";
  const posicaoMarcador = BASELINE.indexOf(marcadorInicio);
  const fim = BASELINE.indexOf("\n-- ---- ", posicaoMarcador + marcadorInicio.length);
  return BASELINE.slice(posicaoMarcador, fim + 1);
}

function semComentariosEBrancas(sql: string): string {
  return sql
    .split("\n")
    .map((linha) => linha.trim())
    .filter((linha) => linha.length > 0 && !linha.startsWith("--"))
    .join("\n");
}

/** O corpo da função de gatilho, do `create or replace` até o `$$;` que a fecha. */
function corpoDoGatilho(sql: string): string {
  // O texto do bloco/migration 0912 tem UMA definição; no baseline inteiro há
  // várias, e quem vale é a última (por isso aqui se passa o bloco, nunca o arquivo).
  const inicio = sql.lastIndexOf("create or replace function public.fn_billing_trava_user_organizations()");
  expect(inicio, "definição não achada").toBeGreaterThan(-1);
  return sql.slice(inicio, sql.indexOf("$$;", sql.indexOf("as $$", inicio)) + 3);
}

describe("0912: aceite de convite nao dobra o aviso (posição e igualdade)", () => {
  it("o bloco do baseline vem depois do bloco da 0910 e antes da VARREDURA anon", () => {
    const inicio0910 = BASELINE.indexOf("-- ---- saneamento do módulo de planos (migration 0910");
    const inicio0912 = BASELINE.indexOf("-- ---- aceitar um convite não dobra a conta do membro (migration 0912");
    const varreduraAnon = BASELINE.lastIndexOf("-- ---- VARREDURA anon:");
    expect(inicio0910).toBeGreaterThan(-1);
    expect(inicio0912).toBeGreaterThan(-1);
    expect(varreduraAnon).toBeGreaterThan(-1);
    expect(inicio0910).toBeLessThan(inicio0912);
    // A VARREDURA anon é o último bloco de propósito: função criada depois dela
    // nasceria exposta a anon em quem atualiza.
    expect(inicio0912).toBeLessThan(varreduraAnon);
  });

  it("o SQL da migração e o SQL do bloco do baseline são iguais, ignorando comentários e linhas em branco", () => {
    expect(semComentariosEBrancas(extraiBloco0912Baseline())).toBe(semComentariosEBrancas(MIGRATION));
  });

  it("a ÚLTIMA definição do gatilho no baseline é a da 0912 (última definição vale)", () => {
    const ultimaNoBaseline = BASELINE.lastIndexOf(
      "create or replace function public.fn_billing_trava_user_organizations()",
    );
    const inicioDoBloco = BASELINE.indexOf("-- ---- aceitar um convite não dobra a conta do membro (migration 0912");
    expect(ultimaNoBaseline).toBeGreaterThan(inicioDoBloco);
  });

  it("está registrada no MANIFEST", () => {
    expect(MANIFEST).toMatch(/\| `20260930100000` \| `0912_aceite_de_convite_nao_dobra_o_aviso` \|/);
  });

  it("nenhuma linha da migração usa travessão (U+2014)", () => {
    expect(MIGRATION.split("\n").filter((linha) => linha.includes(String.fromCharCode(0x2014)))).toEqual([]);
  });
});

describe("0912: o que o gatilho passa a fazer no aceite", () => {
  for (const [nome, sql] of [
    ["migração", MIGRATION],
    ["bloco do baseline", extraiBloco0912Baseline()],
  ] as const) {
    describe(nome, () => {
      const corpo = corpoDoGatilho(sql);

      it("guarda a isenção do convite pendente numa variável, que decide o bloqueio E o aviso", () => {
        expect(corpo).toMatch(/v_convite_ja_ocupava_a_vaga boolean;/);
        expect(corpo).toMatch(
          /v_convite_ja_ocupava_a_vaga :=\s*public\.fn_billing_convite_pendente_do_membro\(new\.organization_id, new\.user_id\);/,
        );
      });

      it("a conferência de aviso só roda quando o convite NÃO ocupava a vaga (a pessoa conta uma vez)", () => {
        const chamadas = [...corpo.matchAll(/fn_billing_conferir_teto\(new\.organization_id, 'membros', null\)/g)];
        expect(chamadas).toHaveLength(1);
        expect(corpo).toMatch(
          /if not v_convite_ja_ocupava_a_vaga then\s*perform public\.fn_billing_conferir_teto\(new\.organization_id, 'membros', null\);\s*end if;/,
        );
      });

      it("o bloqueio de verdade continua com as TRÊS isenções da 0907, e a recusa PT402 fora de bloco exception", () => {
        expect(corpo).toMatch(/v_convite_ja_ocupava_a_vaga\s+or public\.fn_billing_veio_de_aceite_de_convite\(/);
        expect(corpo).toMatch(/or public\.fn_billing_dono_do_provisionamento\(new\.organization_id, new\.user_id, new\.role\)/);
        expect(corpo).toMatch(
          /if public\.fn_billing_bloqueia\(new\.organization_id, 'membros', null\) then\s*raise exception 'Limite do plano atingido' using errcode = 'PT402', detail = 'membros';/,
        );
        expect(corpo).not.toMatch(/exception\s+when/);
      });

      it("regras de desenho da F2 (D-049): security definer, search_path fixo, e nunca lê organizations.settings", () => {
        expect(corpo).toMatch(/security definer\s*set search_path = public, pg_temp/);
        expect(corpo).not.toMatch(/settings/);
        expect(corpo).not.toMatch(/(from|join)\s+public\.organizations/);
      });

      it("não recria o gatilho nem mexe em tabela: só o corpo da função (reaplicável com o app no ar)", () => {
        const codigo = semComentariosEBrancas(sql);
        expect(codigo).not.toMatch(/create trigger/);
        expect(codigo).not.toMatch(/drop trigger/);
        expect(codigo).not.toMatch(/alter table/);
        expect(codigo).not.toMatch(/create index/);
      });

      it("revoga de public, anon e authenticated e dá execute só ao service_role", () => {
        expect(sql).toMatch(
          /revoke execute on function public\.fn_billing_trava_user_organizations\(\) from public, anon, authenticated;/,
        );
        expect(sql).toMatch(
          /grant execute on function public\.fn_billing_trava_user_organizations\(\) to service_role;/,
        );
      });
    });
  }
});
