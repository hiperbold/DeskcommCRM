import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Migration 0954 (o limite de Conexões do plano bloqueia sempre, D-188, fork Hiperbold): este arquivo cobre
 * a FORMA. Migration e baseline dizem a mesma coisa, no lugar certo (depois da 0953 e antes da VARREDURA
 * anon), registradas no MANIFEST, em transação única. O COMPORTAMENTO em banco é provado por
 * `tests/invariants/limite-de-conexoes-bloqueia-sempre.test.ts` (`pnpm test:db`).
 */

const BASELINE = readFileSync(join(process.cwd(), "supabase/baseline.sql"), "utf8");
const MANIFEST = readFileSync(join(process.cwd(), "supabase/migrations/MANIFEST.md"), "utf8");
const ARQUIVO = "20261009110000_0954_limite_de_conexoes_bloqueia_sempre.sql";
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

describe("0954: posição, igualdade e registro", () => {
  it("bloco único no baseline, depois da 0953 e antes da VARREDURA anon", () => {
    const inicio = BASELINE.lastIndexOf(marcador("0954"));
    expect(BASELINE.split(marcador("0954")).length - 1).toBe(1);
    expect(inicio).toBeGreaterThan(BASELINE.lastIndexOf(marcador("0953")));
    expect(inicio).toBeLessThan(BASELINE.lastIndexOf("-- ---- VARREDURA anon:"));
  });

  it("depois da 0907 (a última definição da função é a da 0954)", () => {
    const ultimaDefinicao = BASELINE.lastIndexOf("create or replace function public.fn_billing_bloqueia(p_org uuid, p_item text, p_pipeline uuid)");
    expect(ultimaDefinicao).toBeGreaterThan(BASELINE.lastIndexOf(marcador("0953")));
  });

  it("o SQL da migration e o do bloco são iguais, ignorando comentários", () => {
    expect(codigo(extraiBloco("0954"))).toBe(c);
  });

  it("registrada no MANIFEST", () => {
    expect(MANIFEST).toContain("`0954_limite_de_conexoes_bloqueia_sempre`");
  });

  it("sem travessão e sem apagar nada existente", () => {
    expect(migration.includes(String.fromCharCode(0x2014))).toBe(false);
    expect(c).not.toMatch(/drop (table|function|policy|trigger|column|constraint)|truncate table|delete from|\bupdate public\./);
  });
});

describe("0954: o que ela faz", () => {
  it("fn_billing_bloqueia só lê modo e carência quando o item NÃO é conexoes", () => {
    expect(c).toMatch(/if p_item is distinct from 'conexoes' then\s+select modo into v_modo from public\.billing_settings where id = 1;/);
    // O desvio fecha antes de ler o teto efetivo: conexoes segue direto para ele.
    expect(c).toMatch(
      /if v_bloqueio_a_partir_de is null or v_bloqueio_a_partir_de > now\(\) then\s+return false;\s+end if;\s+end if;\s+v_teto := \(public\.fn_billing_limites_efetivos\(p_org\) ->> p_item\)::integer;/,
    );
  });

  it("plano sem limite nunca bloqueia, e o PT402 não nasce aqui (quem chama levanta)", () => {
    expect(c).toMatch(/if v_teto is null then\s+return false;/);
    expect(c).not.toContain("raise exception");
  });

  it("mesma assinatura, definer, search_path fixo, trava bloqueante e falha interna libera", () => {
    expect(c).toMatch(
      /create or replace function public\.fn_billing_bloqueia\(p_org uuid, p_item text, p_pipeline uuid\)\s*returns boolean\s*language plpgsql\s*volatile\s*security definer\s*set search_path = public, pg_temp/,
    );
    expect(c).toContain("pg_advisory_xact_lock(hashtextextended('billing:' || p_org::text || ':' || p_item, 0))");
    expect(c).toMatch(/exception\s+when others then[\s\S]*?return false;/);
  });

  it("ACL: nada para public, anon e authenticated; service_role executa; agent_worker não", () => {
    expect(c).toMatch(/revoke execute on function public\.fn_billing_bloqueia\(uuid, text, uuid\) from public, anon, authenticated;/);
    expect(c).toMatch(/grant execute on function public\.fn_billing_bloqueia\(uuid, text, uuid\) to service_role;/);
    expect(c).toContain("revoke execute on function public.fn_billing_bloqueia(uuid, text, uuid) from agent_worker");
  });

  it("transação única com lock_timeout curto", () => {
    expect(c.startsWith("begin;\nset lock_timeout = '3s';")).toBe(true);
    expect(c).toMatch(/commit;\nreset lock_timeout;$/);
  });
});
