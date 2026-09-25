import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATION_0910 = readFileSync(
  join(process.cwd(), "supabase/migrations/20260925010000_0910_planos_saneamento.sql"),
  "utf8",
);
const BASELINE = readFileSync(join(process.cwd(), "supabase/baseline.sql"), "utf8");

/**
 * Extrai o bloco 0910 do baseline: do marcador de início até (sem incluir) o
 * cabeçalho do PRÓXIMO bloco (`-- ---- `). Mesmo extrator das migrações
 * 0905/0906/0907 (tests/unit/planos-uso-migration.test.ts,
 * tests/unit/planos-carteira-migration.test.ts, tests/unit/planos-bloqueio-migration.test.ts).
 */
function extraiBloco0910Baseline(): string {
  const marcadorInicio = "-- ---- saneamento do módulo de planos (migration 0910";
  const posicaoMarcador = BASELINE.indexOf(marcadorInicio);
  const fim = BASELINE.indexOf("\n-- ---- ", posicaoMarcador);
  return BASELINE.slice(posicaoMarcador, fim + 1);
}

/** Remove linhas de comentário (--) e linhas em branco, para comparar só o SQL. */
function removeComentariosEBrancas(sql: string): string {
  return sql
    .split("\n")
    .map((linha) => linha.trim())
    .filter((linha) => linha.length > 0 && !linha.startsWith("--"))
    .join("\n");
}

describe("0910 saneamento do plano: posição e igualdade do bloco no baseline", () => {
  it("o bloco do baseline vem depois do bloco da 0909 e antes da VARREDURA anon", () => {
    const inicioBloco0909 = BASELINE.indexOf("-- ---- cobrança pelo Asaas: tabelas (migration 0909");
    const inicioBloco0910 = BASELINE.indexOf("-- ---- saneamento do módulo de planos (migration 0910");
    const varreduraAnon = BASELINE.lastIndexOf("-- ---- VARREDURA anon:");

    expect(inicioBloco0909).toBeGreaterThan(-1);
    expect(inicioBloco0910).toBeGreaterThan(-1);
    expect(varreduraAnon).toBeGreaterThan(-1);
    expect(inicioBloco0909).toBeLessThan(inicioBloco0910);
    expect(inicioBloco0910).toBeLessThan(varreduraAnon);
  });

  it("o SQL da migração 0910 e o SQL do bloco do baseline são iguais, ignorando comentários e linhas em branco", () => {
    const sqlMigracao = removeComentariosEBrancas(MIGRATION_0910);
    const sqlBloco = removeComentariosEBrancas(extraiBloco0910Baseline());
    expect(sqlBloco).toBe(sqlMigracao);
  });

  it("nenhuma linha da migração usa travessão (U+2014)", () => {
    const linhasComTravessao = MIGRATION_0910.split("\n").filter((linha) => linha.includes("—"));
    expect(linhasComTravessao).toEqual([]);
  });
});

describe("0910 D-069: billing_payments e billing_contracts só escritos pelas funções", () => {
  it("revoga INSERT de billing_payments do service_role", () => {
    for (const sql of [MIGRATION_0910, extraiBloco0910Baseline()]) {
      expect(sql).toMatch(/revoke insert on public\.billing_payments from service_role;/);
    }
  });

  it("revoga INSERT, DELETE e TRUNCATE de billing_contracts do service_role, sem tocar em UPDATE nem SELECT", () => {
    for (const sql of [MIGRATION_0910, extraiBloco0910Baseline()]) {
      expect(sql).toMatch(/revoke insert, delete, truncate on public\.billing_contracts from service_role;/);
      expect(sql).not.toMatch(/revoke[^;]*\bupdate\b[^;]*on public\.billing_contracts from service_role/);
      expect(sql).not.toMatch(/revoke[^;]*\bselect\b[^;]*on public\.billing_contracts from service_role/);
    }
  });

  it("documenta a exceção do UPDATE de billing_contracts (planoDaOrganizacao.ts) no comentário da tabela", () => {
    expect(MIGRATION_0910).toMatch(/EXCEÇÃO DELIBERADA: UPDATE continua concedido/);
    expect(MIGRATION_0910).toMatch(/planoDaOrganizacao\.ts/);
  });
});

describe("0910 D-047: TRUNCATE revogado de anon e authenticated, inclusive tabela futura", () => {
  it("revoga truncate em todas as tabelas do schema public", () => {
    for (const sql of [MIGRATION_0910, extraiBloco0910Baseline()]) {
      expect(sql).toMatch(/revoke truncate on all tables in schema public from anon, authenticated;/);
    }
  });

  it("altera privilégio padrão para tabela futura, mesmo padrão de role-agent-worker.sql", () => {
    for (const sql of [MIGRATION_0910, extraiBloco0910Baseline()]) {
      expect(sql).toMatch(
        /alter default privileges for role postgres in schema public\s*\n\s*revoke truncate on tables from anon, authenticated;/,
      );
    }
  });
});

describe("0910 D-055: billing_trigger_alarmes e a redefinição de fn_billing_trava_crm_leads", () => {
  it("a tabela nasce com RLS ligada, zero policy e só select+insert para service_role", () => {
    for (const sql of [MIGRATION_0910, extraiBloco0910Baseline()]) {
      expect(sql).toMatch(/create table if not exists public\.billing_trigger_alarmes/);
      expect(sql).toMatch(/alter table public\.billing_trigger_alarmes enable row level security;/);
      expect(sql).not.toMatch(/create policy[^;]*billing_trigger_alarmes/);
      expect(sql).toMatch(/revoke all on public\.billing_trigger_alarmes from anon, authenticated;/);
      expect(sql).toMatch(/grant select, insert on public\.billing_trigger_alarmes to service_role;/);
      expect(sql).toMatch(/revoke update, delete, truncate on public\.billing_trigger_alarmes from service_role;/);
    }
  });

  it("organization_id é not null com FK para organizations on delete cascade", () => {
    for (const sql of [MIGRATION_0910, extraiBloco0910Baseline()]) {
      expect(sql).toMatch(
        /organization_id uuid not null references public\.organizations\(id\) on delete cascade,/,
      );
    }
  });

  it("agent_worker perde acesso à tabela nova quando a role existe", () => {
    for (const sql of [MIGRATION_0910, extraiBloco0910Baseline()]) {
      expect(sql).toMatch(
        /revoke select, insert, update, delete, truncate on public\.billing_trigger_alarmes from agent_worker/,
      );
    }
  });

  it("redefine fn_billing_trava_crm_leads (última definição vale) com o bloco exception gravando o alarme", () => {
    for (const sql of [MIGRATION_0910, extraiBloco0910Baseline()]) {
      const posicao = sql.lastIndexOf("create or replace function public.fn_billing_trava_crm_leads()");
      expect(posicao).toBeGreaterThan(-1);
      const trecho = sql.slice(posicao, posicao + 3500);
      // Comportamento preservado: mesma soma/subtração do contador, mesmo uso
      // de fn_billing_bloqueio_ativo antes de somar.
      expect(trecho).toMatch(/fn_billing_bloqueio_ativo\(v_org\)/);
      expect(trecho).toMatch(/raise warning 'billing_trava_crm_leads_falhou/);
      // Rastro novo: insere no alarme dentro do PRÓPRIO bloco exception.
      expect(trecho).toMatch(/insert into public\.billing_trigger_alarmes \(organization_id, gatilho, falha\)/);
      expect(trecho).toMatch(/values \(v_org, 'fn_billing_trava_crm_leads', sqlerrm\);/);
      expect(trecho).toMatch(/raise warning 'billing_trava_crm_leads_alarme_falhou/);
      // O corpo termina com return null nos dois casos (sucesso e falha
      // engolida): a função nunca lança para o chamador (decisão 11 da 0905).
      expect(trecho).toMatch(/security definer/);
    }
  });

  it("a redefinição vem DEPOIS da criação de billing_trigger_alarmes (DDL antes da função que a usa)", () => {
    const bloco = extraiBloco0910Baseline();
    const posTabela = bloco.indexOf("create table if not exists public.billing_trigger_alarmes");
    const posFuncao = bloco.lastIndexOf(
      "create or replace function public.fn_billing_trava_crm_leads()",
    );
    expect(posTabela).toBeGreaterThan(-1);
    expect(posFuncao).toBeGreaterThan(-1);
    expect(posTabela).toBeLessThan(posFuncao);
  });
});

describe("0910 D-070/D-060: sem mudança de SQL, só justificativa documentada", () => {
  it("o comentário da migração cita as três funções e o rolbypassrls das três roles chamadoras", () => {
    expect(MIGRATION_0910).toContain("fn_billing_modo_leitura, fn_billing_limites_efetivos e");
    expect(MIGRATION_0910).toContain("postgres       | rolbypassrls = true");
    expect(MIGRATION_0910).toContain("service_role   | rolbypassrls = true");
    expect(MIGRATION_0910).toContain("agent_worker   | rolbypassrls = true");
  });

  it("não altera nenhum grant/revoke de execute nas três funções (SEM instrução SQL para D-070/D-060)", () => {
    expect(MIGRATION_0910).not.toMatch(/^\s*revoke execute on function public\.fn_billing_modo_leitura/m);
    expect(MIGRATION_0910).not.toMatch(/^\s*revoke execute on function public\.fn_billing_limites_efetivos/m);
    expect(MIGRATION_0910).not.toMatch(/^\s*revoke execute on function public\.fn_billing_ia_pode_responder/m);
  });
});

describe("0910 D-068: prova de atualização documentada, sem SQL nesta migração", () => {
  it("o cabeçalho da migração cita o roteiro e o commit da 0905 antiga", () => {
    expect(MIGRATION_0910).toContain("D-068");
    expect(MIGRATION_0910).toContain("é só prova de banco (roteiro fora desta migration, em transação com");
  });
});
