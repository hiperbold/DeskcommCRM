import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Migration 0950 (D-092, 2a parte, fork Hiperbold): a sessão sem o segundo fator não troca o que a IA e o
 * robô mandam ao cliente final (agente, versões, roteador, conhecimento, guardrail, automação, modelos de
 * mensagem e fluxos de follow-up). Este arquivo cobre a FORMA: migration e baseline dizem a mesma coisa, no
 * lugar certo (depois da 0949, antes da reaplicação dos módulos), registradas no MANIFEST e reaplicáveis com o
 * app no ar, um DO (uma transação curta) por tabela. O COMPORTAMENTO em banco (aal1 com fator recusado, aal2 e
 * quem não tem fator passam) é provado por `tests/invariants/sessao-aal1-agente-roteador-conhecimento.test.ts`
 * (`pnpm test:db`).
 */

const BASELINE = readFileSync(join(process.cwd(), "supabase/baseline.sql"), "utf8");
const MANIFEST = readFileSync(join(process.cwd(), "supabase/migrations/MANIFEST.md"), "utf8");
const ARQUIVO = "20261008150000_0950_sessao_aal1_nao_troca_o_que_a_ia_e_o_robo_mandam.sql";
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

const TABELAS = [
  "ai_agents",
  "ai_agent_versions",
  "ai_routers",
  "ai_router_members",
  "ai_budgets",
  "ai_knowledge_sources",
  "ai_faq_items",
  "ai_chunks",
  "ai_knowledge_versions",
  "org_guardrail_layers",
  "automation_rules",
  "message_templates",
  "followup_flow_pointers",
  "followup_flow_versions",
];

/** Decididas FORA de propósito (ver o cabeçalho da migration): execução e telemetria, não conteúdo. */
const FORA_DE_PROPOSITO = [
  "followup_enrollments",
  "followup_enrollment_events",
  "ai_router_decisions",
  "automation_rule_runs",
  "agent_cases",
  "knowledge_searches",
];

describe("0950: posição, igualdade e registro", () => {
  it("bloco único no baseline, depois da 0949 e de TODA tabela que ele alcança, antes da reaplicação dos módulos", () => {
    const inicio = BASELINE.lastIndexOf(marcador("0950"));
    expect(BASELINE.split(marcador("0950")).length - 1).toBe(1);
    expect(inicio).toBeGreaterThan(BASELINE.lastIndexOf(marcador("0949")));
    for (const tabela of TABELAS) {
      const criacao = BASELINE.search(
        new RegExp(`^create table (if not exists )?"?(public"?\\.)?"?${tabela}"?[ (]`, "mi"),
      );
      expect(criacao, `${tabela} não é criada no baseline`).toBeGreaterThan(-1);
      expect(criacao, `${tabela} nasce depois do bloco da 0950`).toBeLessThan(inicio);
    }
    expect(inicio).toBeLessThan(
      BASELINE.indexOf("-- ---- módulos instalados são reaplicados, depois de toda tabela do núcleo"),
    );
    expect(inicio).toBeLessThan(
      BASELINE.indexOf("-- ---- travas do modo somente leitura do suporte, depois de toda tabela"),
    );
  });

  it("o SQL da migration e o do bloco são iguais, ignorando comentários", () => {
    expect(codigo(extraiBloco("0950"))).toBe(c);
  });

  it("registrada no MANIFEST, depois da 0949", () => {
    expect(MANIFEST).toContain("`0950_sessao_aal1_nao_troca_o_que_a_ia_e_o_robo_mandam`");
    expect(MANIFEST.indexOf("`0949_sessao_aal1")).toBeLessThan(
      MANIFEST.indexOf("`0950_sessao_aal1_nao_troca_o_que_a_ia_e_o_robo_mandam`"),
    );
  });

  it("nenhuma linha da migration nem do bloco usa travessão (U+2014)", () => {
    const travessao = String.fromCharCode(0x2014);
    for (const texto of [migration, extraiBloco("0950")]) {
      expect(texto.split("\n").filter((linha) => linha.includes(travessao))).toEqual([]);
    }
  });
});

describe("0950: o que ela faz, e a reaplicação com o app no ar", () => {
  it("não derruba nem trava a tabela: sem drop, alter table, create table, nem função nova", () => {
    expect(c).not.toMatch(/drop |alter table|create table|create or replace function|delete from|update public\./);
  });

  it("um DO por tabela, cada um com lock_timeout curto e política só criada se não existir", () => {
    expect(c).toMatch(/if not exists \(select 1 from pg_policy where polname = nome/);
    expect(c.match(/^do \$mfa_[a-z_]+\$$/gm)).toHaveLength(TABELAS.length);
    expect(c.match(/perform set_config\('lock_timeout','3s',true\);/g)).toHaveLength(TABELAS.length);
  });

  it("uma política RESTRICTIVE por comando de escrita, só para authenticated, pela ponte da 0918", () => {
    expect(c).toMatch(/array\['insert','update','delete'\]/);
    expect(c).toMatch(/as restrictive for %s to authenticated/);
    expect(c.match(/\(select public\.fn_session_mfa_proven_rls\(\)\)/g)?.length).toBeGreaterThanOrEqual(TABELAS.length * 4);
    expect(c).not.toMatch(/for select|for all/);
  });

  it("alcança exatamente as quatorze tabelas, cada DO mexendo só na sua", () => {
    const achadas = [...c.matchAll(/^do \$mfa_([a-z_]+)\$$/gm)].map((m) => m[1]).sort();
    expect(achadas).toEqual([...TABELAS].sort());
    for (const t of TABELAS) {
      expect(c).toContain(`nome := '${t}_mfa_' || cmd;`);
      expect(c).toContain(`polrelid = 'public.${t}'::regclass`);
      expect(c).toContain(`create policy %I on public.${t} as restrictive`);
    }
  });

  it("deixa de fora, de propósito, a execução e a telemetria (e o cabeçalho explica)", () => {
    for (const t of FORA_DE_PROPOSITO) expect(c).not.toContain(`public.${t} `);
    expect(migration).toContain("FICAM DE FORA");
  });

  it("a ponte da 0918 existe no baseline ANTES do bloco que a usa", () => {
    const ponte = BASELINE.indexOf("create or replace function public.fn_session_mfa_proven_rls()");
    expect(ponte).toBeGreaterThan(-1);
    expect(ponte).toBeLessThan(BASELINE.lastIndexOf(marcador("0950")));
  });
});
