import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Migrations 0937 a 0939 (lote 13a da auditoria, fork Hiperbold). Este arquivo cobre a FORMA:
 * migration e baseline dizem a mesma coisa, no lugar certo (depois da 0936 e antes da VARREDURA
 * anon), registradas no MANIFEST, reaplicáveis com o app no ar. O COMPORTAMENTO em banco é provado
 * por `tests/invariants/lote13a-banco.test.ts` (`pnpm test:db`).
 */

const BASELINE = readFileSync(join(process.cwd(), "supabase/baseline.sql"), "utf8");
const MANIFEST = readFileSync(join(process.cwd(), "supabase/migrations/MANIFEST.md"), "utf8");

const MIGRACOES = [
  { n: "0937", arquivo: "20260930192000_0937_agenda_sem_sobreposicao.sql" },
  { n: "0938", arquivo: "20260930193000_0938_tarefa_so_liga_a_propria_organizacao.sql" },
  { n: "0939", arquivo: "20260930194000_0939_visibilidade_por_atendente_nas_filhas.sql" },
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

const le = (arquivo: string) => codigo(readFileSync(join(process.cwd(), "supabase/migrations", arquivo), "utf8"));

describe("0937 a 0939: posição, igualdade e registro", () => {
  const varredura = BASELINE.lastIndexOf("-- ---- VARREDURA anon:");
  let anterior = BASELINE.lastIndexOf("-- ---- uma chave de organizations.settings por vez, atômica");
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
      expect(c).not.toMatch(/drop table|drop function|alter table public\.\w|delete from|truncate table|update public\./);
      expect(c).not.toMatch(/drop policy (?!if exists)/);
    });
  }
});

describe("0937 a 0939: o que cada uma fecha", () => {
  it("0937: gatilho por dono com trava de transação, 23P01, só linha nova ou alterada, sem Google", () => {
    const c = le(MIGRACOES[0].arquivo);
    expect(c).toMatch(/before insert or update of starts_at, ends_at, owner_user_id, organization_id on public\.calendar_appointments/);
    expect(c).toMatch(/pg_advisory_xact_lock\(hashtextextended\('agenda_dono:'/);
    expect(c).toMatch(/errcode = '23P01'/);
    expect(c).toMatch(/o\.status in \('pending', 'confirmed'\)/);
    expect(c).toMatch(/o\.id <> new\.id/);
    expect(c).not.toMatch(/calendar_external_events/);
    expect(c).toMatch(/revoke execute on function public\.fn_agenda_sem_sobreposicao\(\) from public, anon, authenticated;/);
  });

  it("0938: lead, contato e responsável ativo, 23503 genérico, só o campo que mudou", () => {
    const c = le(MIGRACOES[1].arquivo);
    expect(c).toMatch(/before insert or update of lead_id, contact_id, assigned_to, organization_id on public\.crm_tasks/);
    expect(c).toMatch(/uo\.revoked_at is null/);
    expect((c.match(/errcode = '23503'/g) ?? []).length).toBe(3);
    expect(c).toMatch(/new\.assigned_to is distinct from old\.assigned_to/);
    expect(c).toMatch(/revoke execute on function public\.fn_crm_tasks_vinculos_da_organizacao\(\) from public, anon, authenticated;/);
  });

  it("0939: 16 policies restritivas de SELECT pela regra única; as permissivas e a escrita ficam como estão; crm_tasks e agenda intactas", () => {
    const c = le(MIGRACOES[2].arquivo);
    expect((c.match(/create policy visibilidade_por_atendente on public\.\w+ as restrictive for select using/g) ?? []).length).toBe(16);
    expect((c.match(/public\.fn_registro_filho_visivel\(organization_id,/g) ?? []).length).toBe(16);
    // só a própria policy nova é derrubada e recriada: nenhuma permissiva (nem a `for all` de escrita) é tocada
    expect((c.match(/drop policy if exists (\w+) on/g) ?? []).every((d) => d.includes("visibilidade_por_atendente"))).toBe(true);
    expect(c).not.toMatch(/for all|for insert|for update|for delete|as permissive/);
    expect(c).not.toMatch(/on public\.(crm_tasks|calendar_appointments)/);
    expect(c).toMatch(/security definer/);
    expect(c).toMatch(/revoke execute on function public\.fn_registro_filho_visivel\(uuid, uuid, uuid\) from public, anon;/);
    expect(c).toMatch(/fn_can_view_conversation\(c\.organization_id, c\.assigned_to_user_id\)/);
    expect(c).toMatch(/fn_can_view_lead\(l\.organization_id, l\.owner_user_id\)/);
  });
});
