import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Migration 0917 (D-103, fork Hiperbold): o botão "Anonimizar contato" só aceita,
 * de fora da empresa, o admin de plataforma de escopo `full`. Este arquivo cobre a
 * FORMA: migration e baseline dizem a mesma coisa, no lugar certo, e o portão usa
 * `fn_is_platform_admin_full()`. O COMPORTAMENTO em banco (support_readonly recusado,
 * full e admin da empresa passam) é provado por
 * `tests/invariants/anonimizar-contato-so-admin-de-plataforma-full.test.ts`
 * (`pnpm test:db`).
 */

const MIGRATION = readFileSync(
  join(process.cwd(), "supabase/migrations/20260930150000_0917_anonimizar_contato_so_admin_de_plataforma_full.sql"),
  "utf8",
);
const BASELINE = readFileSync(join(process.cwd(), "supabase/baseline.sql"), "utf8");
const MANIFEST = readFileSync(join(process.cwd(), "supabase/migrations/MANIFEST.md"), "utf8");

const MARCADOR_0916 = "-- ---- estorno total pelo Asaas corta o acesso e os tokens (migration 0916";
const MARCADOR_0917 = "-- ---- anonimizar contato: o admin de plataforma de fora da empresa precisa do escopo full (migration 0917";

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

describe("0917: posição e igualdade", () => {
  it("o bloco do baseline vem depois do da 0916 e antes da VARREDURA anon, uma vez só", () => {
    const inicio0916 = BASELINE.lastIndexOf(MARCADOR_0916);
    const inicio0917 = BASELINE.lastIndexOf(MARCADOR_0917);
    const varreduraAnon = BASELINE.lastIndexOf("-- ---- VARREDURA anon:");
    expect(inicio0916).toBeGreaterThan(-1);
    expect(inicio0917).toBeGreaterThan(inicio0916);
    expect(inicio0917).toBeLessThan(varreduraAnon);
    expect(BASELINE.split(MARCADOR_0917).length - 1).toBe(1);
  });

  it("o SQL da migração e o do bloco do baseline são iguais, ignorando comentários e linhas em branco", () => {
    expect(semComentariosEBrancas(extraiBloco(MARCADOR_0917))).toBe(semComentariosEBrancas(MIGRATION));
  });

  it("está registrada no MANIFEST, depois da 0916", () => {
    expect(MANIFEST).toMatch(/\| `20260930150000` \| `0917_anonimizar_contato_so_admin_de_plataforma_full` \|/);
    expect(MANIFEST.indexOf("`0916_estorno_total")).toBeLessThan(MANIFEST.indexOf("`0917_anonimizar_contato"));
  });

  it("nenhuma linha da migração nem do bloco usa travessão (U+2014)", () => {
    const travessao = String.fromCharCode(0x2014);
    for (const texto of [MIGRATION, extraiBloco(MARCADOR_0917)]) {
      expect(texto.split("\n").filter((linha) => linha.includes(travessao))).toEqual([]);
    }
  });

  it("só função, revoke e grant: reaplicável com o app no ar", () => {
    const codigo = semComentariosEBrancas(MIGRATION);
    expect(codigo).not.toMatch(/alter table|create table|create (unique )?index|create (or replace )?trigger|drop |add constraint|delete from|update public\./);
    expect(codigo.match(/create or replace function/g)).toHaveLength(1);
  });
});

describe("0917: o portão", () => {
  for (const [nome, sql] of [
    ["migração", MIGRATION],
    ["bloco do baseline", extraiBloco(MARCADOR_0917)],
  ] as const) {
    describe(nome, () => {
      const codigo = semComentariosEBrancas(sql);

      it("o ramo de fora da empresa usa fn_is_platform_admin_full(), nunca fn_is_platform_admin()", () => {
        expect(codigo).toMatch(/fn_is_platform_admin_full\(\) and support is null/);
        expect(codigo).not.toMatch(/fn_is_platform_admin\(\)/);
      });

      it("o resto do portão continua: suporte de escrita, admin da organização, MFA comprovado e mutex", () => {
        expect(codigo).toMatch(/not public\.fn_support_write_allowed\(p_organization_id\)/);
        expect(codigo).toMatch(/public\.fn_role_at_least\(p_organization_id,'admin'\)/);
        expect(codigo).toMatch(/not public\.fn_session_mfa_proven\(\)/);
        expect(codigo).toMatch(/fn_service_lock\(p_organization_id,p_contact_id\)/);
        expect(codigo).toMatch(/fn_lgpd_cascade_redact_contact\(p_organization_id,p_contact_id,null\)/);
      });

      it("continua security definer com search_path fixo, e só authenticated executa", () => {
        expect(codigo).toMatch(/security definer set search_path=public/);
        expect(codigo).toMatch(
          /revoke all on function public\.fn_lgpd_anonymize_contact\(uuid,uuid\) from public,anon,authenticated,service_role;/,
        );
        expect(codigo).toMatch(
          /grant execute on function public\.fn_lgpd_anonymize_contact\(uuid,uuid\) to authenticated;/,
        );
      });
    });
  }

  it("fn_is_platform_admin_full existe no baseline ANTES do bloco que a usa", () => {
    const definicao = BASELINE.indexOf("create or replace function public.fn_is_platform_admin_full()");
    expect(definicao).toBeGreaterThan(-1);
    expect(definicao).toBeLessThan(BASELINE.lastIndexOf(MARCADOR_0917));
  });
});
