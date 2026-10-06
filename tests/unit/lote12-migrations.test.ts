import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Migrations 0935 e 0936 (lote 12 da auditoria, fork Hiperbold). Este arquivo cobre a FORMA:
 * migration e baseline dizem a mesma coisa, no lugar certo (depois da 0934 e antes da VARREDURA
 * anon), registradas no MANIFEST, reaplicáveis com o app no ar. O COMPORTAMENTO em banco é provado
 * por `tests/invariants/lote12-sobras-de-banco.test.ts` (`pnpm test:db`).
 */

const BASELINE = readFileSync(join(process.cwd(), "supabase/baseline.sql"), "utf8");
const MANIFEST = readFileSync(join(process.cwd(), "supabase/migrations/MANIFEST.md"), "utf8");

const MIGRACOES = [
  { n: "0935", arquivo: "20260930190000_0935_ack_de_campanha_antes_do_vinculo.sql" },
  { n: "0936", arquivo: "20260930191000_0936_atualizar_setting_da_organizacao.sql" },
] as const;

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

describe("0935 e 0936: posição, igualdade e registro", () => {
  const varredura = BASELINE.lastIndexOf("-- ---- VARREDURA anon:");
  let anterior = BASELINE.lastIndexOf("-- ---- a etapa do negócio é do mesmo funil e organização");
  for (const { n, arquivo } of MIGRACOES) {
    const migration = readFileSync(join(process.cwd(), "supabase/migrations", arquivo), "utf8");

    it(`${n}: bloco único no baseline, depois do anterior e antes da VARREDURA anon`, () => {
      const inicio = BASELINE.lastIndexOf(marcador(n));
      expect(BASELINE.split(marcador(n)).length - 1).toBe(1);
      expect(inicio).toBeGreaterThan(anterior);
      expect(inicio).toBeLessThan(varredura);
      anterior = inicio;
    });

    it(`${n}: o SQL da migration e o do bloco são iguais, ignorando comentários`, () => {
      expect(codigo(extraiBloco(n))).toBe(codigo(migration));
    });

    it(`${n}: registrada no MANIFEST`, () => {
      expect(MANIFEST).toContain(`\`${arquivo.replace(".sql", "").replace(/^\d+_/, "")}\``);
    });

    it(`${n}: sem travessão, só create or replace function e grants (reaplicável com o app no ar)`, () => {
      expect(migration.includes(String.fromCharCode(0x2014))).toBe(false);
      const c = codigo(migration);
      expect(c).toMatch(/create or replace function/);
      expect(c).not.toMatch(/drop table|drop function|alter table public\.\w|delete from|truncate table/);
      expect(c).toMatch(/revoke execute on function public\.\w+\([^)]*\)\s+from public, anon, authenticated;/);
      expect(c).toMatch(/grant execute on function public\.\w+\([^)]*\)\s+to service_role;/);
    });
  }
});

describe("0935 e 0936: o que cada uma fecha", () => {
  const le = (arquivo: string) => codigo(readFileSync(join(process.cwd(), "supabase/migrations", arquivo), "utf8"));

  it("0935: acha o destinatário pelo metadata só sem vínculo, na mesma organização, com uuid validado", () => {
    const c = le(MIGRACOES[0].arquivo);
    expect(c).toMatch(/where r\.message_id = new\.id/);
    expect(c).toMatch(/r\.message_id is null/);
    expect(c).toMatch(/r\.organization_id = new\.organization_id/);
    // O cast só acontece dentro do CASE, depois da regex: o planner não garante a ordem de um AND.
    expect(c).toMatch(/case\s+when new\.metadata ->> 'campaign_recipient_id'\s+~\*/);
  });

  it("0936: trava a linha, só servidor/admin, 22023 para entrada ruim e 42501 sem permissão", () => {
    const c = le(MIGRACOES[1].arquivo);
    expect(c).toMatch(/security definer/);
    expect(c).toMatch(/set search_path to 'public', 'pg_temp'/);
    expect(c).toMatch(/for update;/);
    expect(c).toMatch(/fn_billing_e_servidor\(\)/);
    expect(c).toMatch(/fn_role_at_least\(p_org, 'admin'\)/);
    expect(c).toMatch(/errcode = '42501'/);
    expect(c).toMatch(/errcode = '22023'/);
    expect(c).toMatch(/jsonb_set\(v_settings, p_caminho, p_valor, true\)/);
  });
});
