import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Migrations 0928 a 0931 (lote 7b da auditoria, fork Hiperbold). Cobre a FORMA: migration e
 * baseline dizem a mesma coisa, no lugar certo (depois da 0927 e antes da VARREDURA anon),
 * registradas no MANIFEST, reaplicáveis com o app no ar. O COMPORTAMENTO em banco é provado por
 * `tests/invariants/lote7-conta-e-cobranca-banco.test.ts` (`pnpm test:db`).
 */

const BASELINE = readFileSync(join(process.cwd(), "supabase/baseline.sql"), "utf8");
const MANIFEST = readFileSync(join(process.cwd(), "supabase/migrations/MANIFEST.md"), "utf8");

const MIGRACOES = [
  { n: "0928", arquivo: "20260930183000_0928_organizacao_nova_nasce_em_avaliacao.sql" },
  { n: "0929", arquivo: "20260930184000_0929_vinculo_so_pelo_servidor_e_nunca_zero_admin.sql" },
  { n: "0930", arquivo: "20260930185000_0930_troca_de_plano_e_ajuste_deixam_trilha.sql" },
  { n: "0931", arquivo: "20260930186000_0931_tokens_do_plano_so_com_contrato_em_dia.sql" },
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

const le = (arquivo: string) => readFileSync(join(process.cwd(), "supabase/migrations", arquivo), "utf8");

describe("0928 a 0931: posição, igualdade e registro", () => {
  const varredura = BASELINE.lastIndexOf("-- ---- VARREDURA anon:");
  let anterior = BASELINE.lastIndexOf("-- ---- emit_event pede agent");
  for (const { n, arquivo } of MIGRACOES) {
    const migration = le(arquivo);

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

    it(`${n}: registrada no MANIFEST, sem travessão e nada que apague tabela ou linha`, () => {
      expect(MANIFEST).toContain(`\`${arquivo.replace(".sql", "").replace(/^\d+_/, "")}\``);
      expect(migration.includes(String.fromCharCode(0x2014))).toBe(false);
      expect(codigo(migration)).not.toMatch(/drop table|truncate table/);
    });
  }
});

describe("0928 a 0931: o que cada uma fecha", () => {
  it("0928: avaliação só com o marcador, no plano pro, sem tocar o Ilimitado dos outros caminhos", () => {
    const c = codigo(le(MIGRACOES[0].arquivo));
    expect(c).toMatch(/new\.settings ->> 'billing_inicio', ''\) = 'avaliacao'/);
    expect(c).toMatch(/v_modo is distinct from 'desligado'/);
    expect(c).toMatch(/code = 'pro' and active/);
    expect(c).toMatch(/values \(new\.id, v_plan_id, 'avaliacao', now\(\), v_fim\)/);
    expect(c).toMatch(/code = 'ilimitado' and active/);
  });

  it("0929: dois gatilhos, servidor-só e último admin com trava por organização", () => {
    const c = codigo(le(MIGRACOES[1].arquivo));
    expect(c).toMatch(/before insert or update of user_id, role, revoked_at, accepted_at on public\.user_organizations/);
    expect(c).toMatch(/before update of role, revoked_at or delete on public\.user_organizations/);
    expect(c).toMatch(/pg_advisory_xact_lock\(hashtextextended\('user_orgs_admins:'/);
    expect(c).toMatch(/raise exception 'organizacao_sem_admin' using errcode = '23514'/);
    expect(c).toMatch(/set lock_timeout = '5s';/);
  });

  it("0930: evento plano na troca e no ajuste, sem mexer no CHECK do vocabulário", () => {
    const c = codigo(le(MIGRACOES[2].arquivo));
    expect(c).toMatch(/'plano', v_plan_id_antes::text, v_plan_id::text, 'troca_manual', p_actor/);
    expect(c).toMatch(/'plano', v_antes::text, v_depois::text, left\('ajuste_de_limites: ' \|\| coalesce\(p_note, ''\), 500\), p_actor/);
    expect(c).not.toMatch(/constraint/);
  });

  it("0931: só contrato em dia recebe ciclo novo e a primeira concessão é proporcional", () => {
    const c = codigo(le(MIGRACOES[3].arquivo));
    expect(c).toMatch(/v_status not in \('ativa', 'avaliacao'\) or \(v_fim is not null and v_fim <= now\(\)\)/);
    expect(c).toMatch(/v_valor := \(v_teto \* v_dias_restantes\) \/ v_dias_do_mes;/);
    expect(c).toMatch(/revoke execute on function public\.fn_billing_garantir_concessoes\(uuid, date\) from public, anon, authenticated;/);
  });
});
