import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Migration 0946 (régua de aviso de renovação, D-177 parte 2, fork Hiperbold): este arquivo cobre a FORMA.
 * Migration e baseline dizem a mesma coisa, no lugar certo (depois da 0945 e antes da VARREDURA anon),
 * registradas no MANIFEST, com a transação única que fecha a janela de ACL. O COMPORTAMENTO em banco é
 * provado por `tests/invariants/regua-de-renovacao-banco.test.ts` (`pnpm test:db`).
 */

const BASELINE = readFileSync(join(process.cwd(), "supabase/baseline.sql"), "utf8");
const MANIFEST = readFileSync(join(process.cwd(), "supabase/migrations/MANIFEST.md"), "utf8");
const ARQUIVO = "20261007150000_0946_regua_de_aviso_de_renovacao.sql";
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

const FUNCOES = [
  "fn_billing_assinatura_viva",
  "fn_billing_renovacao_marco",
  "fn_billing_renovacao_pendentes",
  "fn_billing_renovacao_reservar",
  "fn_billing_renovacao_criar_aviso",
  "fn_billing_renovacao_encerrar_avisos",
];

describe("0946: posição, igualdade e registro", () => {
  it("bloco único no baseline, depois da 0945 e antes da VARREDURA anon", () => {
    const inicio = BASELINE.lastIndexOf(marcador("0946"));
    expect(BASELINE.split(marcador("0946")).length - 1).toBe(1);
    expect(inicio).toBeGreaterThan(BASELINE.lastIndexOf(marcador("0945")));
    expect(inicio).toBeLessThan(BASELINE.lastIndexOf("-- ---- VARREDURA anon:"));
  });

  it("o SQL da migration e o do bloco são iguais, ignorando comentários", () => {
    expect(codigo(extraiBloco("0946"))).toBe(c);
  });

  it("registrada no MANIFEST", () => {
    expect(MANIFEST).toContain("`0946_regua_de_aviso_de_renovacao`");
  });

  it("sem travessão e sem drop de nada existente", () => {
    expect(migration.includes(String.fromCharCode(0x2014))).toBe(false);
    expect(c).not.toMatch(/drop (table|function|policy|trigger|column)|truncate table/);
  });
});

describe("0946: segurança e reaplicação", () => {
  it("uma transação só, com lock_timeout curto antes e reset depois", () => {
    expect(c.match(/^begin;$/gm)?.length).toBe(1);
    expect(c.match(/^commit;$/gm)?.length).toBe(1);
    expect(c.indexOf("set lock_timeout = '3s';")).toBeGreaterThan(c.indexOf("begin;"));
    expect(c.indexOf("reset lock_timeout;")).toBeGreaterThan(c.lastIndexOf("commit;"));
  });

  it("a tabela só nasce quando falta, com RLS ligada e sem policy nenhuma, tudo dentro da transação", () => {
    const dentro = c.slice(c.indexOf("begin;"), c.lastIndexOf("commit;"));
    expect(dentro).toContain("create table if not exists public.billing_avisos_de_renovacao");
    expect(dentro).toContain("alter table public.billing_avisos_de_renovacao enable row level security;");
    expect(dentro).toContain("revoke all on public.billing_avisos_de_renovacao from anon, authenticated;");
    expect(dentro).toContain("grant select, insert, update on public.billing_avisos_de_renovacao to service_role;");
    expect(dentro).toContain("revoke delete, truncate on public.billing_avisos_de_renovacao from service_role;");
    expect(c).not.toMatch(/create policy/);
  });

  it("a unicidade da régua é (organização, fim do período, marco)", () => {
    expect(c).toContain("unique (organization_id, fim_do_periodo, marco)");
  });

  it.each(FUNCOES)("%s: create or replace, comment, revoke de public/anon/authenticated e grant só ao service_role, dentro da transação", (nome) => {
    const dentro = c.slice(c.indexOf("begin;"), c.lastIndexOf("commit;"));
    const create = dentro.indexOf(`create or replace function public.${nome}(`);
    expect(create).toBeGreaterThan(-1);
    expect(dentro.indexOf(`revoke execute on function public.${nome}(`)).toBeGreaterThan(create);
    expect(dentro).toContain(`comment on function public.${nome}(`);
    expect(dentro).toMatch(new RegExp(`revoke execute on function public\\.${nome}\\(.*\\) from public, anon, authenticated;`));
    expect(dentro).toMatch(new RegExp(`grant execute on function public\\.${nome}\\(.*\\) to service_role;`));
    expect(dentro).toContain(`public.${nome}(`);
  });

  it("as funções que gravam são security definer com search_path fixo; agent_worker perde tudo", () => {
    for (const nome of ["fn_billing_renovacao_pendentes", "fn_billing_renovacao_reservar", "fn_billing_renovacao_criar_aviso", "fn_billing_renovacao_encerrar_avisos"]) {
      const corpo = c.slice(c.indexOf(`create or replace function public.${nome}(`));
      const cabecalho = corpo.slice(0, corpo.indexOf("as $$"));
      expect(cabecalho, nome).toContain("security definer");
      expect(cabecalho, nome).toContain("set search_path = public, pg_temp");
    }
    expect(c).toContain("revoke select, insert, update, delete, truncate on public.billing_avisos_de_renovacao from agent_worker");
  });
});

describe("0946: o que ela decide", () => {
  it("o último dia é o dia de São Paulo de (fim - 1 microssegundo), e os marcos são 0, 1, 7, 15 e 30", () => {
    expect(c).toContain("(p_fim - interval '1 microsecond') at time zone 'America/Sao_Paulo'");
    expect(c).toContain("array[0, 1, 7, 15, 30]");
  });

  it("a régua exclui assinatura viva, cancelamento no fim, organização inativa e gateway que não é asaas", () => {
    const pendentes = c.slice(c.indexOf("create or replace function public.fn_billing_renovacao_pendentes("));
    expect(pendentes).toContain("o.status = 'active'");
    expect(pendentes).toContain("bc.status = 'ativa'");
    expect(pendentes).toContain("bc.gateway = 'asaas'");
    expect(pendentes).toContain("not public.fn_billing_assinatura_viva(bc.asaas_subscription_id, bc.asaas_assinatura_encerrada_em)");
    expect(pendentes).toContain("not coalesce(bc.cancel_at_period_end, false)");
    expect(pendentes).toContain("bc.current_period_end > p_agora");
  });

  it("a reserva trava o contrato e revalida o período antes de gravar", () => {
    const reservar = c.slice(c.indexOf("create or replace function public.fn_billing_renovacao_reservar("));
    expect(reservar).toMatch(/from public\.billing_contracts\s+where id = p_contract and organization_id = p_org\s+for update;/);
    expect(reservar).toContain("v_contrato.current_period_end is distinct from p_fim");
    expect(reservar).toContain("on conflict (organization_id, fim_do_periodo, marco) do nothing");
  });

  it("o aviso da Central usa o ref_kind de plano que o membro não forja (billing_assinatura) e a organização como ref_id", () => {
    expect(c).toContain("'other', p_severidade, p_titulo, p_corpo, 'billing_assinatura', v_linha.organization_id");
  });
});
