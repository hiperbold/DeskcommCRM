import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Migration 0944 (reserva atômica de vaga no ritmo de envio por token, D-167, fork Hiperbold): este
 * arquivo cobre a FORMA. Migration e baseline dizem a mesma coisa, no lugar certo (depois da 0943 e
 * antes da VARREDURA anon), registradas no MANIFEST. O COMPORTAMENTO em banco é provado por
 * `tests/invariants/reserva-de-vaga-no-ritmo-banco.test.ts` (`pnpm test:db`).
 */

const BASELINE = readFileSync(join(process.cwd(), "supabase/baseline.sql"), "utf8");
const MANIFEST = readFileSync(join(process.cwd(), "supabase/migrations/MANIFEST.md"), "utf8");

const ARQUIVO = "20261007130000_0944_reserva_de_vaga_no_ritmo_por_token.sql";
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

describe("0944: posição, igualdade e registro", () => {
  it("bloco único no baseline, depois da 0943 e antes da VARREDURA anon", () => {
    const inicio = BASELINE.lastIndexOf(marcador("0944"));
    expect(BASELINE.split(marcador("0944")).length - 1).toBe(1);
    expect(inicio).toBeGreaterThan(BASELINE.lastIndexOf(marcador("0943")));
    expect(inicio).toBeLessThan(BASELINE.lastIndexOf("-- ---- VARREDURA anon:"));
  });

  it("o SQL da migration e o do bloco são iguais, ignorando comentários", () => {
    expect(codigo(extraiBloco("0944"))).toBe(c);
  });

  it("registrada no MANIFEST", () => {
    expect(MANIFEST).toContain("`0944_reserva_de_vaga_no_ritmo_por_token`");
  });

  it("sem travessão, sem DDL de tabela e sem drop", () => {
    expect(migration.includes(String.fromCharCode(0x2014))).toBe(false);
    expect(c).not.toMatch(/drop |alter table|truncate|update public\./);
  });
});

describe("0944: o que ela faz", () => {
  it("serializa por canal com a mesma chave do agente e não espera para sempre pela trava", () => {
    expect(c).toMatch(/perform pg_advisory_xact_lock\(hashtext\(p_canal::text\)\);/);
    expect(c).toMatch(/set_config\('lock_timeout', '3s', true\)/);
  });

  it("confere o teto do dia e o espaçamento e reserva a vaga no ledger", () => {
    expect(c).toMatch(/if v_enviados_hoje >= p_teto then\s+return jsonb_build_object\('liberado', false, 'motivo', 'teto_diario'\)/);
    expect(c).toMatch(/'motivo', 'espacamento', 'libera_em', v_libera_em/);
    expect(c).toMatch(/insert into public\.pacing_ledger \(organization_id, channel_session_id, sent_at\)\s+values \(p_org, p_canal, v_vaga_em\)/);
  });

  it("a devolução só apaga a vaga da própria organização e do próprio canal", () => {
    expect(c).toMatch(/delete from public\.pacing_ledger\s+where id = p_vaga and organization_id = p_org and channel_session_id = p_canal;/);
  });

  it("as duas funções são só do servidor", () => {
    expect(c).toMatch(/revoke execute on function public\.fn_pacing_reservar_vaga\(.*\) from public, anon, authenticated;/);
    expect(c).toMatch(/grant execute on function public\.fn_pacing_reservar_vaga\(.*\) to service_role;/);
    expect(c).toMatch(/revoke execute on function public\.fn_pacing_liberar_vaga\(.*\) from public, anon, authenticated;/);
    expect(c).toMatch(/grant execute on function public\.fn_pacing_liberar_vaga\(.*\) to service_role;/);
  });
});
