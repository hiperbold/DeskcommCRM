import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Migration 0952 (fila de envio dos e-mails de conta e de cobrança, fork Hiperbold): este arquivo cobre a FORMA.
 * Migration e baseline dizem a mesma coisa, no lugar certo (depois da 0951 e antes da VARREDURA anon),
 * registradas no MANIFEST, com a transação única que fecha a janela de ACL e a função do claim com os dois
 * lados do EXECUTE. O COMPORTAMENTO em banco (unicidade, claim concorrente, RLS) é provado por
 * `tests/invariants/emails-de-conta-e-cobranca-banco.test.ts` (`pnpm test:db`).
 */

const BASELINE = readFileSync(join(process.cwd(), "supabase/baseline.sql"), "utf8");
const MANIFEST = readFileSync(join(process.cwd(), "supabase/migrations/MANIFEST.md"), "utf8");
const ARQUIVO = "20261008170000_0952_emails_de_conta_e_cobranca.sql";
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

describe("0952: posição, igualdade e registro", () => {
  it("bloco único no baseline, depois da 0951 e antes da VARREDURA anon", () => {
    const inicio = BASELINE.lastIndexOf(marcador("0952"));
    expect(BASELINE.split(marcador("0952")).length - 1).toBe(1);
    expect(inicio).toBeGreaterThan(BASELINE.lastIndexOf(marcador("0951")));
    expect(inicio).toBeLessThan(BASELINE.lastIndexOf("-- ---- VARREDURA anon:"));
  });

  it("o SQL da migration e o do bloco são iguais, ignorando comentários", () => {
    expect(codigo(extraiBloco("0952"))).toBe(c);
  });

  it("registrada no MANIFEST", () => {
    expect(MANIFEST).toContain("`0952_emails_de_conta_e_cobranca`");
  });

  it("sem travessão e sem apagar nada existente (nem tabela, nem coluna, nem função, nem linha)", () => {
    expect(migration.includes(String.fromCharCode(0x2014))).toBe(false);
    expect(c).not.toMatch(/drop (table|function|policy|trigger|column|constraint)|truncate table|delete from/);
  });
});

describe("0952: segurança e reaplicação", () => {
  it("uma transação só, com lock_timeout curto antes e reset depois", () => {
    expect(c.match(/^begin;$/gm)?.length).toBe(1);
    expect(c.match(/^commit;$/gm)?.length).toBe(1);
    expect(c.indexOf("set lock_timeout = '3s';")).toBeGreaterThan(c.indexOf("begin;"));
    expect(c.indexOf("reset lock_timeout;")).toBeGreaterThan(c.lastIndexOf("commit;"));
  });

  it("a tabela só nasce quando falta, com RLS ligada e sem policy nenhuma, tudo dentro da transação", () => {
    const dentro = c.slice(c.indexOf("begin;"), c.lastIndexOf("commit;"));
    expect(dentro).toContain("create table if not exists public.billing_emails_enviados");
    expect(dentro).toContain("alter table public.billing_emails_enviados enable row level security;");
    expect(dentro).toContain("revoke all on public.billing_emails_enviados from anon, authenticated;");
    expect(dentro).toContain("grant select, insert, update on public.billing_emails_enviados to service_role;");
    expect(dentro).toContain("revoke delete, truncate on public.billing_emails_enviados from service_role;");
    expect(c).not.toMatch(/create policy/);
  });

  it("o agent_worker perde tudo na tabela e a função (só quando o papel existe)", () => {
    expect(c).toContain("revoke select, insert, update, delete, truncate on public.billing_emails_enviados from agent_worker");
    expect(c).toContain("revoke execute on function public.fn_billing_emails_reservar_lote(integer, integer, integer) from agent_worker");
  });

  it("as colunas da fila nascem só quando faltam (reaplicável sobre a versão anterior), com a constraint junto", () => {
    for (const coluna of [
      "status text not null default 'pendente'",
      "dados jsonb not null default '{}'::jsonb",
      "copia_para_operador boolean not null default false",
      "destino text not null default 'admins'",
      "criador_user_id uuid",
      "tentativas integer not null default 0",
      "proxima_tentativa_em timestamptz not null default now()",
      "enviado_em timestamptz",
      "ultimo_erro text",
    ]) {
      expect(c, coluna).toContain(`add column if not exists ${coluna}`);
    }
    expect(c).toContain("check (status in ('pendente', 'enviando', 'enviado', 'falhou', 'sem_destinatario'))");
    expect(c).toContain("check (destino in ('admins', 'criador'))");
    // as constraints de tabela só nascem se faltarem
    expect(c).toMatch(/if not exists \(select 1 from pg_constraint where conname = 'billing_emails_enviados_criador_exigido'\)/);
    expect(c).toMatch(/if not exists \(select 1 from pg_constraint where conname = 'billing_emails_enviados_enviado_com_data'\)/);
  });

  it("o índice da fila é parcial (pendente e enviando) por proxima_tentativa_em", () => {
    expect(c).toMatch(
      /create index if not exists billing_emails_enviados_fila_idx\s+on public\.billing_emails_enviados \(proxima_tentativa_em\)\s+where status in \('pendente', 'enviando'\);/,
    );
  });

  it("o claim: definer com search_path fixo, for update skip locked, e EXECUTE só para service_role (as duas origens revogadas)", () => {
    expect(c).toContain("create or replace function public.fn_billing_emails_reservar_lote(");
    expect(c).toMatch(/security definer\s+set search_path = public, pg_temp/);
    expect(c).toContain("for update skip locked");
    expect(c).toContain("revoke execute on function public.fn_billing_emails_reservar_lote(integer, integer, integer) from public, anon, authenticated;");
    expect(c).toContain("grant execute on function public.fn_billing_emails_reservar_lote(integer, integer, integer) to service_role;");
    // o claim marca enviando, conta a tentativa e empurra a hora (a reserva)
    expect(c).toContain("status = 'enviando'");
    expect(c).toContain("tentativas = e.tentativas + 1");
    expect(c).toContain("proxima_tentativa_em = now() + make_interval(secs => p_reserva_segundos)");
  });

  it("a função vem DENTRO do bloco, antes da VARREDURA anon (nenhuma função nasce depois dela)", () => {
    const bloco = extraiBloco("0952");
    expect(bloco).toContain("create or replace function public.fn_billing_emails_reservar_lote(");
    expect(BASELINE.lastIndexOf("fn_billing_emails_reservar_lote")).toBeLessThan(BASELINE.lastIndexOf("-- ---- VARREDURA anon:"));
  });

  it("a idempotência é a unicidade de (organização, e-mail, chave)", () => {
    expect(c).toContain("unique (organization_id, email_id, chave)");
  });

  it("a organização é chave estrangeira com cascade, e o resultado é sempre um objeto", () => {
    expect(c).toContain("organization_id uuid not null references public.organizations(id) on delete cascade");
    expect(c).toContain("check (jsonb_typeof(resultado) = 'object')");
  });
});
