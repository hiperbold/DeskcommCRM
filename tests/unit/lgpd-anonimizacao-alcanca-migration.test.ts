import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Migration 0921 (D-142, fork Hiperbold). Este arquivo cobre a FORMA: migration e
 * baseline dizem a mesma coisa, no lugar certo, e a migração é reaplicável com o
 * app no ar. O COMPORTAMENTO em banco é provado por
 * `tests/invariants/lgpd-anonimizacao-alcanca-o-que-sobrava.test.ts` (`pnpm test:db`).
 */

const MIGRATION = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/20260930172000_0921_lgpd_anonimizacao_alcanca_o_que_sobrava.sql",
  ),
  "utf8",
);
const BASELINE = readFileSync(join(process.cwd(), "supabase/baseline.sql"), "utf8");
const MANIFEST = readFileSync(join(process.cwd(), "supabase/migrations/MANIFEST.md"), "utf8");

const MARCADOR_0920 = "-- ---- rodízio da rodada de campanhas: campaigns.last_tick_at (migration 0920";
const MARCADOR_0921 = "-- ---- a anonimização LGPD alcança o que sobrava do titular (migration 0921";

function extraiBloco(marcador: string): string {
  const inicio = BASELINE.lastIndexOf(marcador);
  const fim = BASELINE.indexOf("\n-- ---- ", inicio + marcador.length);
  return BASELINE.slice(inicio, fim + 1);
}

function codigoDe(sql: string): string {
  return sql
    .split("\n")
    .map((linha) => linha.trim())
    .filter((linha) => linha.length > 0 && !linha.startsWith("--"))
    .join("\n");
}

describe("0921: posição e igualdade", () => {
  it("o bloco do baseline vem depois do da 0920 e antes da VARREDURA anon, uma vez só", () => {
    const inicio0920 = BASELINE.lastIndexOf(MARCADOR_0920);
    const inicio0921 = BASELINE.lastIndexOf(MARCADOR_0921);
    expect(inicio0920).toBeGreaterThan(-1);
    expect(inicio0921).toBeGreaterThan(inicio0920);
    expect(inicio0921).toBeLessThan(BASELINE.lastIndexOf("-- ---- VARREDURA anon:"));
    expect(BASELINE.split(MARCADOR_0921).length - 1).toBe(1);
  });

  it("o SQL da migração e o do bloco são iguais, ignorando comentários", () => {
    expect(codigoDe(extraiBloco(MARCADOR_0921))).toBe(codigoDe(MIGRATION));
  });

  it("está no MANIFEST, depois da 0920, e sem travessão", () => {
    expect(MANIFEST).toMatch(
      /\| `20260930172000` \| `0921_lgpd_anonimizacao_alcanca_o_que_sobrava` \|/,
    );
    expect(MANIFEST.indexOf("`0920_campanha_rodizio")).toBeLessThan(
      MANIFEST.indexOf("`0921_lgpd_anonimizacao"),
    );
    const travessao = String.fromCharCode(0x2014);
    expect(MIGRATION.includes(travessao)).toBe(false);
  });
});

describe("0921: o gatilho cobre o que sobrava e a cura é reaplicável", () => {
  const codigo = codigoDe(MIGRATION);

  it("a função segue security definer, com search_path fixo e sem execute para quem consulta", () => {
    expect(codigo).toMatch(
      /create or replace function public\.fn_redigir_conversas_ao_anonimizar\(\)\s+returns trigger\s+language plpgsql\s+security definer\s+set search_path = public, pg_temp/,
    );
    expect(codigo).toMatch(/revoke all on function public\.fn_redigir_conversas_ao_anonimizar\(\) from public;/);
    expect(codigo).toMatch(/revoke execute on function public\.fn_redigir_conversas_ao_anonimizar\(\) from anon;/);
    expect(codigo).toMatch(/revoke execute on function public\.fn_redigir_conversas_ao_anonimizar\(\) from authenticated;/);
  });

  it("cada lugar do D-142 tem seu comando no corpo da função", () => {
    expect(codigo).toMatch(/media_derived_text = null,\s+media_derived_status = null,\s+metadata = '\{\}'::jsonb/);
    expect(codigo).toMatch(/update public\.lead_notes set[\s\S]*embedding = null/);
    expect(codigo).toMatch(/update public\.conversation_notes set/);
    expect(codigo).toMatch(/delete from public\.ai_chunks a/);
    expect(codigo).toMatch(/update public\.event_log e set payload = e\.payload - 'body_preview'/);
    expect(codigo).toMatch(/update public\.webhook_events_log set\s+raw_body = '\[redigido\]'/);
    expect(codigo).toMatch(/update public\.lgpd_requests set\s+request_payload = request_payload - 'customer'/);
  });

  it("o rastro operacional vai numa função própria, chamada pelo gatilho e fechada para quem consulta", () => {
    expect(codigo).toMatch(/create or replace function public\.fn_limpar_rastro_do_titular\(p_org uuid, p_contato uuid, p_ext text\)/);
    expect(codigo).toMatch(/perform public\.fn_limpar_rastro_do_titular\(new\.organization_id, new\.id, v_ext\);/);
    expect(codigo).toMatch(/revoke all on function public\.fn_limpar_rastro_do_titular\(uuid, uuid, text\) from public;/);
    expect(codigo).toMatch(/revoke execute on function public\.fn_limpar_rastro_do_titular\(uuid, uuid, text\) from anon;/);
  });

  it("as colunas not null recebem texto fixo, nunca null", () => {
    expect(codigo).toMatch(/headline = '\[nota anonimizada\]',\s+body = '\[nota anonimizada\]'/);
    expect(codigo).not.toMatch(/\bbody = null/);
    expect(codigo).not.toMatch(/\braw_body = null/);
  });

  it("o gatilho que chama a função não é recriado aqui (a 0391 já o criou)", () => {
    expect(codigo).not.toMatch(/create (or replace )?trigger/);
    expect(codigo).not.toMatch(/drop trigger/);
  });

  it("a cura roda num bloco do com lock_timeout curto e só até anonymized_at", () => {
    const cura = codigo.slice(codigo.indexOf("do $cura_0921$"));
    expect(cura).toMatch(/set_config\('lock_timeout','3s',true\)/);
    expect(cura).toMatch(/<= k\.anonymized_at/);
    expect(cura).not.toMatch(/drop |truncate|alter table/);
  });
});
