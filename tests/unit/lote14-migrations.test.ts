import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Migration 0940 (lote 14, D-094 revisto em 06/10/2026, fork Hiperbold): a organização do cadastro
 * próprio nasce sem plano ativo, não em avaliação. Este arquivo cobre a FORMA: migration e baseline
 * dizem a mesma coisa, no lugar certo (depois da 0939 e antes da VARREDURA anon), registradas no
 * MANIFEST, reaplicáveis com o app no ar. O COMPORTAMENTO em banco é provado por
 * `tests/invariants/lote14-banco.test.ts` (`pnpm test:db`).
 */

const BASELINE = readFileSync(join(process.cwd(), "supabase/baseline.sql"), "utf8");
const MANIFEST = readFileSync(join(process.cwd(), "supabase/migrations/MANIFEST.md"), "utf8");

const ARQUIVO = "20261006100000_0940_cadastro_proprio_nasce_sem_plano.sql";
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

describe("0940: posição, igualdade e registro", () => {
  it("bloco único no baseline, depois da 0939 e antes da VARREDURA anon", () => {
    const inicio = BASELINE.lastIndexOf(marcador("0940"));
    expect(BASELINE.split(marcador("0940")).length - 1).toBe(1);
    expect(inicio).toBeGreaterThan(BASELINE.lastIndexOf(marcador("0939")));
    expect(inicio).toBeLessThan(BASELINE.lastIndexOf("-- ---- VARREDURA anon:"));
  });

  it("o SQL da migration e o do bloco são iguais, ignorando comentários", () => {
    expect(codigo(extraiBloco("0940"))).toBe(codigo(migration));
  });

  it("registrada no MANIFEST", () => {
    expect(MANIFEST).toContain("`0940_cadastro_proprio_nasce_sem_plano`");
  });

  it("sem travessão, sem DDL em tabela e nada que apague ou reescreva linha", () => {
    expect(migration.includes(String.fromCharCode(0x2014))).toBe(false);
    const c = codigo(migration);
    expect(c).not.toMatch(/drop table|drop function|alter table|delete from|truncate table|update public\./);
  });
});

describe("0940: o que ela muda", () => {
  const c = codigo(migration);

  it("só o marcador do cadastro próprio (sem_plano, e o antigo avaliacao) entra no ramo novo, e só fora do billing desligado", () => {
    expect(c).toMatch(/in \('sem_plano', 'avaliacao'\)/);
    expect(c).toMatch(/v_modo is distinct from 'desligado'/);
  });

  it("grava suspensa, sem período e sem ciclo, com o bloqueio já preenchido (pula a carência da 0907) e 5 segundos de margem para a semeadura da criação", () => {
    expect(c).toMatch(/\(organization_id, plan_id, status, bloqueio_a_partir_de\)/);
    expect(c).toMatch(/values \(new\.id, v_plan_id, 'suspensa', now\(\) \+ interval '5 seconds'\)/);
    expect(c).not.toMatch(/current_period_end|current_period_start|cycle/);
  });

  it("o plano da linha é o de entrada já cadastrado (pro) e, na falta dele, o Ilimitado: nenhum plano ou preço novo", () => {
    expect(c).toMatch(/code = 'pro' and active/);
    expect(c).not.toMatch(/insert into public\.billing_plans/);
  });

  it("os outros caminhos seguem ativos no Ilimitado, e a função segue só do servidor", () => {
    expect(c).toMatch(/values \(new\.id, v_plan_id, 'ativa'\)/);
    expect(c).toMatch(/revoke execute on function public\.fn_billing_contrato_da_organizacao_nova\(\) from public, anon, authenticated;/);
    expect(c).toMatch(/grant execute on function public\.fn_billing_contrato_da_organizacao_nova\(\) to service_role;/);
  });
});
