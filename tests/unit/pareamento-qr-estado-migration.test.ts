import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { LIMITE_DE_PAREAMENTOS_PENDENTES } from "@/lib/channels/uazapi/pareamento";

/**
 * Migration 0953 (o estado do pareamento por QR Code mora em colunas do servidor, e a criação é uma
 * reserva atômica, fork Hiperbold): este arquivo cobre a FORMA. Migration e baseline dizem a mesma coisa,
 * no lugar certo (depois da 0952 e antes da VARREDURA anon), registradas no MANIFEST, com a transação
 * única que fecha a janela de ACL. O COMPORTAMENTO em banco (gatilho, trava, teto) é provado por
 * `tests/invariants/pareamento-qr-estado-no-banco.test.ts` (`pnpm test:db`).
 */

const BASELINE = readFileSync(join(process.cwd(), "supabase/baseline.sql"), "utf8");
const MANIFEST = readFileSync(join(process.cwd(), "supabase/migrations/MANIFEST.md"), "utf8");
const ARQUIVO = "20261009100000_0953_pareamento_qr_estado_no_banco.sql";
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

describe("0953: posição, igualdade e registro", () => {
  it("bloco único no baseline, depois da 0952 e antes da VARREDURA anon", () => {
    const inicio = BASELINE.lastIndexOf(marcador("0953"));
    expect(BASELINE.split(marcador("0953")).length - 1).toBe(1);
    expect(inicio).toBeGreaterThan(BASELINE.lastIndexOf(marcador("0952")));
    expect(inicio).toBeLessThan(BASELINE.lastIndexOf("-- ---- VARREDURA anon:"));
  });

  it("o SQL da migration e o do bloco são iguais, ignorando comentários", () => {
    expect(codigo(extraiBloco("0953"))).toBe(c);
  });

  it("registrada no MANIFEST", () => {
    expect(MANIFEST).toContain("`0953_pareamento_qr_estado_no_banco`");
  });

  it("sem travessão e sem apagar nada existente", () => {
    expect(migration.includes(String.fromCharCode(0x2014))).toBe(false);
    expect(c).not.toMatch(/drop (table|function|policy|trigger|column|constraint)|truncate table|delete from|\bupdate public\./);
  });
});

describe("0953: o que ela faz", () => {
  it("as seis colunas, com padrão que não mexe em canal comum", () => {
    for (const coluna of [
      "pareamento_qr_estado text",
      "pareamento_qr_iniciado_em timestamptz",
      "criada_pelo_crm boolean not null default false",
      "pareamento_qr_falhas integer not null default 0",
      "pareamento_qr_codigos integer not null default 0",
      "pareamento_qr_codigo_em timestamptz",
    ]) {
      expect(c).toContain(`add column if not exists ${coluna}`);
    }
    expect(c).toContain("check (pareamento_qr_estado in ('pendente', 'concluido'))");
  });

  it("gatilho BEFORE INSERT OR UPDATE OF as seis colunas, recusa com 42501 quando quem grava não é o servidor", () => {
    expect(c).toMatch(
      /create or replace trigger trg_channel_sessions_trava_pareamento_qr\s+before insert or update of\s+pareamento_qr_estado, pareamento_qr_iniciado_em, criada_pelo_crm,\s+pareamento_qr_falhas, pareamento_qr_codigos, pareamento_qr_codigo_em\s+on public\.channel_sessions\s+for each row/,
    );
    expect(c).toMatch(/if public\.fn_billing_e_servidor\(\) then\s+return new;/);
    expect(c).toMatch(/raise exception 'estado do pareamento por QR só pode ser alterado pelo servidor' using errcode = '42501';/);
    expect(c).toMatch(
      /create or replace function public\.fn_channel_sessions_trava_pareamento_qr\(\)\s*returns trigger\s*language plpgsql\s*security definer\s*set search_path = public, pg_temp/,
    );
    expect(c).toMatch(/revoke execute on function public\.fn_channel_sessions_trava_pareamento_qr\(\) from public, anon, authenticated;/);
    expect(c).toMatch(/grant execute on function public\.fn_channel_sessions_trava_pareamento_qr\(\) to service_role;/);
  });

  it("a reserva: definer, search_path fixo, trava por organização, 2 pendentes, teto = limite conexoes do plano (50 sem limite) sobre todas as conexões ativas, só service_role", () => {
    expect(c).toMatch(
      /create or replace function public\.fn_channel_pareamento_qr_reservar\(\s*p_organization_id uuid,[\s\S]*?\)\s*returns jsonb\s*language plpgsql\s*volatile\s*security definer\s*set search_path = public, pg_temp/,
    );
    expect(c).toContain("pg_advisory_xact_lock(hashtextextended('pareamento_qr:' || p_organization_id::text, 0))");
    // O mesmo número da constante do código: o SQL decide, o código só dá a frase.
    expect(c).toContain(`if v_pendentes >= ${LIMITE_DE_PAREAMENTOS_PENDENTES} then`);
    expect(c).toContain("(public.fn_billing_limites_efetivos(p_organization_id) ->> 'conexoes')::integer");
    expect(c).toContain("v_teto := greatest(coalesce(v_limite, 50), 0);");
    // Conta TODAS as conexões não arquivadas, de qualquer canal (não só as criadas pelo CRM).
    expect(c).toMatch(/select count\(\*\) into v_ativas\s+from public\.channel_sessions\s+where organization_id = p_organization_id\s+and archived_at is null;/);
    expect(c).not.toContain("and criada_pelo_crm;");
    expect(c).toContain("'do_plano', v_limite is not null");
    // Não olha o modo da trava de planos.
    expect(c).not.toMatch(/(from|join|update) public.billing_settings/);
    expect(c).toMatch(/revoke execute on function public\.fn_channel_pareamento_qr_reservar\(uuid, uuid, text, text, jsonb\) from public, anon, authenticated;/);
    expect(c).toMatch(/grant execute on function public\.fn_channel_pareamento_qr_reservar\(uuid, uuid, text, text, jsonb\) to service_role;/);
  });

  it("o gatilho da instância do CRM: BEFORE DELETE OR UPDATE OF as seis colunas (instância, token, endereço, provider e segredo do webhook), 42501 a quem não é o servidor, só em linha criada pelo CRM", () => {
    expect(c).toMatch(
      /create or replace trigger trg_channel_sessions_trava_instancia_do_crm\s+before delete or update of archived_at, uazapi_instance_id, uazapi_token_encrypted, uazapi_base_url, provider, webhook_secret_encrypted\s+on public\.channel_sessions\s+for each row/,
    );
    expect(c).toMatch(
      /create or replace function public\.fn_channel_sessions_trava_instancia_do_crm\(\)\s*returns trigger\s*language plpgsql\s*security definer\s*set search_path = public, pg_temp/,
    );
    // O servidor passa; a linha comum passa; só a criada pelo CRM é protegida.
    expect(c).toMatch(/if public\.fn_billing_e_servidor\(\) then/);
    expect(c).toContain("if old.criada_pelo_crm is not true then");
    expect(c).toContain("raise exception 'a instância criada pelo CRM só pode ser removida ou trocada pelo servidor' using errcode = '42501';");
    for (const coluna of [
      "archived_at",
      "uazapi_instance_id",
      "uazapi_token_encrypted",
      "uazapi_base_url",
      "provider",
      "webhook_secret_encrypted",
    ]) {
      expect(c).toContain(`new.${coluna} is distinct from old.${coluna}`);
    }
    expect(c).toMatch(/revoke execute on function public\.fn_channel_sessions_trava_instancia_do_crm\(\) from public, anon, authenticated;/);
    expect(c).toMatch(/grant execute on function public\.fn_channel_sessions_trava_instancia_do_crm\(\) to service_role;/);
  });

  it("o freio de taxa no banco: 10 criações pelo CRM na última hora (arquivadas inclusive) antes do teto, código taxa_de_criacao", () => {
    expect(c).toMatch(
      /select count\(\*\) into v_criadas\s+from public\.channel_sessions\s+where organization_id = p_organization_id\s+and criada_pelo_crm\s+and pareamento_qr_iniciado_em > now\(\) - interval '1 hour';/,
    );
    expect(c).toContain("if v_criadas >= 10 then");
    expect(c).toContain("'codigo', 'taxa_de_criacao'");
    // A conta de taxa não filtra arquivada: criar e cancelar em laço é o que ela existe para barrar.
    const trecho = c.slice(c.indexOf("select count(*) into v_criadas"), c.indexOf("if v_criadas >= 10 then"));
    expect(trecho).not.toContain("archived_at");
    expect(c.indexOf("if v_criadas >= 10 then")).toBeLessThan(c.indexOf("v_teto := greatest("));
  });

  it("transação única com lock_timeout curto (a janela de ACL da função nova fecha no commit)", () => {
    expect(c.startsWith("begin;\nset lock_timeout = '3s';")).toBe(true);
    expect(c).toMatch(/commit;\nreset lock_timeout;$/);
  });
});
