import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Migration 0949 (D-092, fork Hiperbold): a sessão sem o segundo fator não grava nas tabelas de
 * credencial, de convite, de recuperação de acesso e de LGPD, nem na própria empresa. Este arquivo cobre
 * a FORMA: migration e baseline dizem a mesma coisa, no lugar certo (depois da 0948 e antes da VARREDURA
 * anon), registradas no MANIFEST e reaplicáveis com o app no ar. O COMPORTAMENTO em banco (aal1 com fator
 * recusado, aal2 e quem não tem fator passam) é provado por
 * `tests/invariants/sessao-aal1-credenciais-membros-e-lgpd.test.ts` (`pnpm test:db`).
 */

const BASELINE = readFileSync(join(process.cwd(), "supabase/baseline.sql"), "utf8");
const MANIFEST = readFileSync(join(process.cwd(), "supabase/migrations/MANIFEST.md"), "utf8");
const ARQUIVO = "20261008120000_0949_sessao_aal1_nao_grava_credencial_membro_lgpd.sql";
const migration = readFileSync(join(process.cwd(), "supabase/migrations", ARQUIVO), "utf8");

function marcador(n: string): string {
  const achado = BASELINE.match(new RegExp(`^-- ---- .*\\(migration ${n}, fork Hiperbold[^\\n]*$`, "m"));
  if (!achado) throw new Error(`bloco da ${n} não está no baseline`);
  return achado[0];
}

function extraiBloco(n: string): string {
  const m = marcador(n);
  const inicio = BASELINE.lastIndexOf(m);
  const fim = BASELINE.indexOf("\n-- ---- ", inicio + m.length);
  return BASELINE.slice(inicio, fim + 1);
}

function codigo(sql: string): string {
  return sql
    .split("\n")
    .map((linha) => linha.trim())
    .filter((linha) => linha.length > 0 && !linha.startsWith("--"))
    .join("\n");
}

const c = codigo(migration);

const TABELAS = [
  "ai_provider_credentials",
  "ai_purpose_bindings",
  "calendar_connections",
  "channel_sessions",
  "external_db_connections",
  "lgpd_requests",
  "organizations",
  "team_invites",
  "tenant_integrations",
  "user_recovery_codes",
  "voip_trunk_settings",
  "webhook_sources",
];

describe("0949: posição, igualdade e registro", () => {
  it("bloco único no baseline, depois da 0948 e de TODA tabela que ele alcança, antes das proteções finais", () => {
    const inicio = BASELINE.lastIndexOf(marcador("0949"));
    expect(BASELINE.split(marcador("0949")).length - 1).toBe(1);
    expect(inicio).toBeGreaterThan(BASELINE.lastIndexOf(marcador("0948")));
    // `external_db_connections` nasce no bloco do banco externo (0372), DEPOIS da VARREDURA anon:
    // a policy não pode vir antes da tabela, senão a primeira aplicação do arquivo falha.
    for (const tabela of TABELAS) {
      // O corpo vindo do `pg_dump` escreve `CREATE TABLE IF NOT EXISTS "public"."tabela"`; os apêndices, sem aspas.
      const criacao = BASELINE.search(
        new RegExp(`^create table (if not exists )?"?public"?\\."?${tabela}"?[ (]`, "mi"),
      );
      expect(criacao, `${tabela} não é criada no baseline`).toBeGreaterThan(-1);
      expect(criacao, `${tabela} nasce depois do bloco da 0949`).toBeLessThan(inicio);
    }
    // Sem função nova, o bloco não precisa da VARREDURA anon; mas entra antes da reaplicação dos
    // módulos e das travas de suporte, que fecham o arquivo (as travas leem as tabelas já prontas).
    expect(inicio).toBeLessThan(
      BASELINE.indexOf("-- ---- módulos instalados são reaplicados, depois de toda tabela do núcleo"),
    );
    expect(inicio).toBeLessThan(
      BASELINE.indexOf("-- ---- travas do modo somente leitura do suporte, depois de toda tabela"),
    );
  });

  it("o SQL da migration e o do bloco são iguais, ignorando comentários", () => {
    expect(codigo(extraiBloco("0949"))).toBe(c);
  });

  it("registrada no MANIFEST, depois da 0948", () => {
    expect(MANIFEST).toContain("`0949_sessao_aal1_nao_grava_credencial_membro_lgpd`");
    expect(MANIFEST.indexOf("`0948_token_de_webhook")).toBeLessThan(
      MANIFEST.indexOf("`0949_sessao_aal1_nao_grava_credencial_membro_lgpd`"),
    );
  });

  it("nenhuma linha da migration nem do bloco usa travessão (U+2014)", () => {
    const travessao = String.fromCharCode(0x2014);
    for (const texto of [migration, extraiBloco("0949")]) {
      expect(texto.split("\n").filter((linha) => linha.includes(travessao))).toEqual([]);
    }
  });
});

describe("0949: o que ela faz, e a reaplicação com o app no ar", () => {
  it("não derruba nem trava a tabela: sem drop, alter table, create table, nem função nova", () => {
    expect(c).not.toMatch(/drop |alter table|create table|create or replace function|delete from|update public\./);
  });

  it("cada política só é criada se não existir, num DO só, com lock_timeout curto", () => {
    expect(c).toMatch(/if not exists \(select 1 from pg_policy where polname = nome/);
    expect(c).toContain("perform set_config('lock_timeout','3s',true);");
    expect(c.match(/^do \$[a-z0-9_]+\$$/gm)).toHaveLength(1);
  });

  it("uma política RESTRICTIVE por comando de escrita, só para authenticated, pela ponte da 0918", () => {
    expect(c).toMatch(/array\['insert','update','delete'\]/);
    expect(c).toMatch(/as restrictive for %s to authenticated/);
    expect(c.match(/\(select public\.fn_session_mfa_proven_rls\(\)\)/g)?.length).toBeGreaterThanOrEqual(4);
    expect(c).not.toMatch(/for select|for all/);
  });

  it("alcança exatamente as doze tabelas, e nenhuma outra", () => {
    const lista = c.match(/foreach t in array array\[([^\]]+)\]/);
    expect(lista, "a lista de tabelas não foi achada").not.toBeNull();
    const achadas = [...(lista?.[1] ?? "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect(achadas).toEqual([...TABELAS].sort());
  });

  it("a ponte da 0918 existe no baseline ANTES do bloco que a usa", () => {
    const ponte = BASELINE.indexOf("create or replace function public.fn_session_mfa_proven_rls()");
    expect(ponte).toBeGreaterThan(-1);
    expect(ponte).toBeLessThan(BASELINE.lastIndexOf(marcador("0949")));
  });
});
