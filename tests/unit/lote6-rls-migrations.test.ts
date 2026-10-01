import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Migrations 0923 a 0927 (lote 6 da auditoria, fork Hiperbold). Este arquivo cobre a FORMA:
 * migration e baseline dizem a mesma coisa, no lugar certo (depois da 0922 e antes da
 * VARREDURA anon), registradas no MANIFEST, reaplicáveis com o app no ar. O COMPORTAMENTO
 * em banco é provado por `tests/invariants/lote6-rls-e-banco.test.ts` (`pnpm test:db`).
 */

const BASELINE = readFileSync(join(process.cwd(), "supabase/baseline.sql"), "utf8");
const MANIFEST = readFileSync(join(process.cwd(), "supabase/migrations/MANIFEST.md"), "utf8");

const MIGRACOES = [
  { n: "0923", arquivo: "20260930174000_0923_financeiro_escrita_por_papel.sql" },
  { n: "0924", arquivo: "20260930175000_0924_roteiros_de_followup_so_manager_grava.sql" },
  { n: "0925", arquivo: "20260930180000_0925_voz_numeros_so_manager_e_resolucao_so_servico.sql" },
  { n: "0926", arquivo: "20260930181000_0926_tabelas_do_servidor_sem_escrita_de_membro.sql" },
  { n: "0927", arquivo: "20260930182000_0927_emit_event_agent_e_organizacao_obrigatoria.sql" },
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

describe("0923 a 0927: posição, igualdade e registro", () => {
  const varredura = BASELINE.lastIndexOf("-- ---- VARREDURA anon:");
  let anterior = BASELINE.lastIndexOf("-- ---- mesclar contatos");
  for (const { n, arquivo } of MIGRACOES) {
    const migration = readFileSync(join(process.cwd(), "supabase/migrations", arquivo), "utf8");

    it(`${n}: bloco único no baseline, depois do anterior e antes da VARREDURA anon`, () => {
      const inicio = BASELINE.lastIndexOf(marcador(n));
      expect(BASELINE.split(marcador(n)).length - 1).toBe(1);
      expect(inicio).toBeGreaterThan(anterior > 0 ? anterior : 0);
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
      const travessao = String.fromCharCode(0x2014);
      expect(migration.includes(travessao)).toBe(false);
      const c = codigo(migration);
      if (c.includes("create policy") || c.includes("create or replace trigger")) {
        expect(c).toMatch(/set_config\('lock_timeout','3s',true\)/);
      }
      expect(c).not.toMatch(/drop table|drop function|alter table public\.\w|delete from|truncate table|update public\./);
      expect(c).not.toMatch(/drop policy (?!if exists)/);
    });
  }
});

describe("0923 a 0927: o que cada uma fecha", () => {
  const le = (arquivo: string) => codigo(readFileSync(join(process.cwd(), "supabase/migrations", arquivo), "utf8"));

  it("0923: nenhuma policy `for all` no financeiro; delete de lançamento só não pago e manual", () => {
    const c = le(MIGRACOES[0].arquivo);
    expect(c).not.toMatch(/for all/);
    expect(c).toMatch(/for delete using \(public\.fn_is_platform_admin\(\) or \(.*paid_at is null and status <> 'paid' and origin = 'manual'\)\)/);
    expect(c).toMatch(/on public\.sale_items for insert with check \(.*s\.organization_id = sale_items\.organization_id and s\.status = 'open'/);
  });

  it("0924: nenhuma policy `for all` nos roteiros; gatilho da versão ativa só quando a coluna muda", () => {
    const c = le(MIGRACOES[1].arquivo);
    expect(c).not.toMatch(/for all/);
    expect(c).toMatch(/new\.active_version_id is distinct from old\.active_version_id/);
    expect(c).toMatch(/revoke execute on function public\.fn_followup_pointer_versao_da_organizacao\(\) from public, anon, authenticated;/);
  });

  it("0925: resolução só do serviço, com search_path; agenda confere a organização", () => {
    const c = le(MIGRACOES[2].arquivo);
    expect(c).toMatch(/revoke execute on function public\.fn_resolve_inbound_number\(text\) from public, anon, authenticated;/);
    expect(c).toMatch(/grant execute on function public\.fn_resolve_inbound_number\(text\) to service_role;/);
    expect(c).toMatch(/set search_path = public\nas \$\$\nselect organization_id, routing_mode/);
    expect(c).toMatch(/p_org not in \(select public\.fn_user_org_ids\(\)\)/);
  });

  it("0926: toda tabela do servidor perde a escrita do authenticated e a varredura cria só SELECT", () => {
    const c = le(MIGRACOES[3].arquivo);
    const revogadas = c.match(/revoke insert, update, delete, truncate, references, trigger on public\.\w+ from authenticated, anon;/g) ?? [];
    expect(revogadas.length).toBeGreaterThanOrEqual(39);
    expect(c).not.toMatch(/for all/);
    expect(c).toMatch(/create policy tenant_isolation_%s_all on public\.%I for select/);
    for (const tabela of ["job_queue", "cron_jobs_nao_entra"]) {
      expect(c.includes(`on public.${tabela} from authenticated`)).toBe(tabela === "job_queue");
    }
  });

  it("0927: emit_event pede agent, organização explícita e mantém a exceção do próprio perfil", () => {
    const c = le(MIGRACOES[4].arquivo);
    expect(c).toMatch(/public\.fn_role_at_least\(v_org_id, 'agent'\)/);
    expect(c).toMatch(/p_event_type = 'user\.profile_updated'/);
    expect(c).not.toMatch(/limit 1/);
    expect(c).toMatch(/raise exception 'emit_event: organization_id obrigatorio'/);
  });
});
