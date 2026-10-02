import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Migrations 0932 a 0934 (lote 11a da auditoria, fork Hiperbold). Este arquivo cobre a FORMA:
 * migration e baseline dizem a mesma coisa, no lugar certo (depois da 0931 e antes da
 * VARREDURA anon), registradas no MANIFEST, reaplicáveis com o app no ar. O COMPORTAMENTO em
 * banco é provado por `tests/invariants/lote11a-sobras-de-banco.test.ts` (`pnpm test:db`).
 */

const BASELINE = readFileSync(join(process.cwd(), "supabase/baseline.sql"), "utf8");
const MANIFEST = readFileSync(join(process.cwd(), "supabase/migrations/MANIFEST.md"), "utf8");

const MIGRACOES = [
  { n: "0932", arquivo: "20260930187000_0932_escrita_por_papel_nas_tabelas_do_usuario.sql" },
  { n: "0933", arquivo: "20260930188000_0933_vinculos_da_mesma_organizacao.sql" },
  { n: "0934", arquivo: "20260930189000_0934_etapa_do_negocio_no_mesmo_funil.sql" },
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

describe("0932 a 0934: posição, igualdade e registro", () => {
  const varredura = BASELINE.lastIndexOf("-- ---- VARREDURA anon:");
  let anterior = BASELINE.lastIndexOf("-- ---- tokens do plano só com contrato em dia");
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

    it(`${n}: sem travessão, lock_timeout curto e nada que reescreva ou apague linha`, () => {
      expect(migration.includes(String.fromCharCode(0x2014))).toBe(false);
      const c = codigo(migration);
      if (c.includes("create policy") || c.includes("create trigger")) {
        expect(c).toMatch(/set_config\('lock_timeout','3s',true\)/);
      }
      // A 0934 redefine a RPC de lote, cujo corpo (herdado da 0263) contém o UPDATE do movimento;
      // não é reescrita de dados.
      const proibido =
        n === "0934"
          ? /drop table|drop function|alter table public\.\w|delete from|truncate table/
          : /drop table|drop function|alter table public\.\w|delete from|truncate table|update public\./;
      expect(c).not.toMatch(proibido);
      expect(c).not.toMatch(/drop policy (?!if exists)/);
    });
  }
});

describe("0932 a 0934: o que cada uma fecha", () => {
  const le = (arquivo: string) => codigo(readFileSync(join(process.cwd(), "supabase/migrations", arquivo), "utf8"));

  it("0932: nenhuma policy `for all` nas tabelas da sessão; viewer nunca escreve", () => {
    const c = le(MIGRACOES[0].arquivo);
    expect(c).not.toMatch(/for all/);
    expect(c).not.toMatch(/fn_role_at_least\(organization_id, 'viewer'\)/);
    expect(c).toMatch(/and kind = 'at' and job_kind = 'followup_turn'/);
    for (const t of ["contacts", "cron_jobs", "idempotency_keys", "lead_state", "lead_checkpoints", "contact_field_proposals", "lead_notes", "crm_lead_reactivations"]) {
      expect(c).toMatch(new RegExp(`on public\\.${t} for insert with check`));
    }
  });

  it("0933: gatilho por tabela, só confere o campo que mudou e ninguém executa a função", () => {
    const c = le(MIGRACOES[1].arquivo);
    const gatilhos = c.match(/create trigger trg_\w+_vinculos_da_organizacao/g) ?? [];
    expect(gatilhos.length).toBe(10);
    expect(c).toMatch(/tg_op = 'INSERT' or new\.conversation_id is distinct from old\.conversation_id/);
    expect((c.match(/revoke execute on function public\.fn_\w+_vinculos_da_organizacao\(\) from public, anon, authenticated;/g) ?? []).length).toBe(10);
  });

  it("0934: a RPC e o gatilho conferem organização e funil", () => {
    const c = le(MIGRACOES[2].arquivo);
    expect(c).toMatch(/errcode = 'PT404'/);
    expect(c).toMatch(/errcode = 'PT422'/);
    expect(c).toMatch(/before insert or update of stage_id, pipeline_id on public\.crm_leads/);
    expect(c).toMatch(/revoke execute on function public\.fn_lead_etapa_do_mesmo_funil\(\) from public, anon, authenticated;/);
  });
});
