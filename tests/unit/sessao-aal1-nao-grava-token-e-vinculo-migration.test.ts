import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Migration 0918 (D-092, fork Hiperbold): sessão sem o segundo fator não grava em
 * `api_tokens` nem em `user_organizations`. Este arquivo cobre a FORMA: migration e
 * baseline dizem a mesma coisa, no lugar certo, e a migração é reaplicável com o
 * app no ar. O COMPORTAMENTO em banco (aal1 com fator recusado, aal2 e quem não tem
 * fator passam) é provado por
 * `tests/invariants/sessao-aal1-nao-grava-token-e-vinculo.test.ts` (`pnpm test:db`).
 */

const MIGRATION = readFileSync(
  join(process.cwd(), "supabase/migrations/20260930160000_0918_sessao_aal1_nao_grava_token_e_vinculo.sql"),
  "utf8",
);
const BASELINE = readFileSync(join(process.cwd(), "supabase/baseline.sql"), "utf8");
const MANIFEST = readFileSync(join(process.cwd(), "supabase/migrations/MANIFEST.md"), "utf8");

const MARCADOR_0917 = "-- ---- anonimizar contato: o admin de plataforma de fora da empresa precisa do escopo full (migration 0917";
const MARCADOR_0918 = "-- ---- sessão sem o segundo fator não grava em api_tokens nem em user_organizations (migration 0918";

function extraiBloco(marcador: string): string {
  const inicio = BASELINE.lastIndexOf(marcador);
  const fim = BASELINE.indexOf("\n-- ---- ", inicio + marcador.length);
  return BASELINE.slice(inicio, fim + 1);
}

function semComentariosEBrancas(sql: string): string {
  return sql
    .split("\n")
    .map((linha) => linha.trim())
    .filter((linha) => linha.length > 0 && !linha.startsWith("--"))
    .join("\n");
}

describe("0918: posição e igualdade", () => {
  it("o bloco do baseline vem depois do da 0917 e antes da VARREDURA anon, uma vez só", () => {
    const inicio0917 = BASELINE.lastIndexOf(MARCADOR_0917);
    const inicio0918 = BASELINE.lastIndexOf(MARCADOR_0918);
    const varreduraAnon = BASELINE.lastIndexOf("-- ---- VARREDURA anon:");
    expect(inicio0917).toBeGreaterThan(-1);
    expect(inicio0918).toBeGreaterThan(inicio0917);
    expect(inicio0918).toBeLessThan(varreduraAnon);
    expect(BASELINE.split(MARCADOR_0918).length - 1).toBe(1);
  });

  it("o SQL da migração e o do bloco do baseline são iguais, ignorando comentários e linhas em branco", () => {
    expect(semComentariosEBrancas(extraiBloco(MARCADOR_0918))).toBe(semComentariosEBrancas(MIGRATION));
  });

  it("está registrada no MANIFEST, depois da 0917", () => {
    expect(MANIFEST).toMatch(/\| `20260930160000` \| `0918_sessao_aal1_nao_grava_token_e_vinculo` \|/);
    expect(MANIFEST.indexOf("`0917_anonimizar_contato")).toBeLessThan(
      MANIFEST.indexOf("`0918_sessao_aal1"),
    );
  });

  it("nenhuma linha da migração nem do bloco usa travessão (U+2014)", () => {
    const travessao = String.fromCharCode(0x2014);
    for (const texto of [MIGRATION, extraiBloco(MARCADOR_0918)]) {
      expect(texto.split("\n").filter((linha) => linha.includes(travessao))).toEqual([]);
    }
  });
});

describe("0918: reaplicável com o app no ar", () => {
  for (const [nome, sql] of [
    ["migração", MIGRATION],
    ["bloco do baseline", extraiBloco(MARCADOR_0918)],
  ] as const) {
    describe(nome, () => {
      const codigo = semComentariosEBrancas(sql);

      it("não derruba nem trava a tabela: sem drop policy, sem alter table, sem tocar em linha", () => {
        expect(codigo).not.toMatch(/drop policy|drop |alter table|create table|add constraint|delete from|update public\./);
      });

      it("cada policy só é criada se não existir, com lock_timeout curto", () => {
        expect(codigo).toMatch(/if not exists \(select 1 from pg_policy where polname = nome/);
        expect(codigo).toMatch(/set_config\('lock_timeout','3s',true\)/);
      });

      it("cria só a ponte como função, security definer com search_path fixo, só authenticated executa", () => {
        expect(codigo.match(/create or replace function/g)).toHaveLength(1);
        expect(codigo).toMatch(/security definer set search_path=public/);
        expect(codigo).toMatch(
          /revoke all on function public\.fn_session_mfa_proven_rls\(\) from public,anon,authenticated;/,
        );
        expect(codigo).toMatch(
          /grant execute on function public\.fn_session_mfa_proven_rls\(\) to authenticated;/,
        );
      });

      it("seis policies RESTRICTIVE (insert, update, delete nas duas tabelas) para authenticated", () => {
        expect(codigo).toMatch(/array\['api_tokens','user_organizations'\]/);
        expect(codigo).toMatch(/array\['insert','update','delete'\]/);
        expect(codigo).toMatch(/as restrictive for %s to authenticated/);
        // A prova entra pela ponte, em subselect (avaliada uma vez por consulta).
        expect(codigo.match(/\(select public\.fn_session_mfa_proven_rls\(\)\)/g)?.length).toBeGreaterThanOrEqual(4);
      });
    });
  }

  it("fn_session_mfa_proven existe no baseline ANTES do bloco que a usa", () => {
    const definicao = BASELINE.indexOf("create or replace function public.fn_session_mfa_proven()");
    expect(definicao).toBeGreaterThan(-1);
    expect(definicao).toBeLessThan(BASELINE.lastIndexOf(MARCADOR_0918));
  });
});
