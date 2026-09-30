import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { sql } from "./psql-transporte";

/**
 * D-053 item 2 (migration 0912, fork Hiperbold): o preenchimento inicial de
 * `billing_usage_counters` que o BASELINE reaplica a cada atualização de
 * produção só CRIA a linha que falta; nunca sobrescreve um contador que já
 * existe.
 *
 * O defeito era a sobrescrita (`on conflict do update set valor =
 * excluded.valor`, e depois um segundo recálculo por `greatest`, 0910) rodando
 * sem trava a cada reaplicação do arquivo inteiro: um lead confirmado entre a
 * foto (`count(*)`) e o upsert deixava o contador com erro de 1 até o
 * conferidor diário. Agora o comando do baseline é `on conflict do nothing`, e
 * a deriva de contador existente é só do `fn_billing_conferir_contador` (cron
 * diário, provado em `planos-trava-avisa.test.ts`, caso 9).
 *
 * O trecho executado aqui é LIDO do `supabase/baseline.sql` (a fonte que
 * `pnpm test:db` aplica), e não copiado à mão, para a prova nunca divergir do
 * SQL que roda de verdade. A âncora ocorre UMA vez no arquivo.
 *
 * Rodar (precisa de Docker, é banco): `pnpm test:db tests/invariants/planos-preenchimento-do-contador.test.ts`.
 */

const MARCA = "SONDA|";

function linhasMarcadas(saida: string): string[] {
  return saida
    .split("\n")
    .filter((linha) => linha.startsWith(MARCA))
    .map((linha) => linha.slice(MARCA.length));
}

function comoServico(corpo: string): string[] {
  return linhasMarcadas(sql(corpo));
}

/** O ÚNICO preenchimento inicial do baseline, do `insert` até o `;` que o fecha. */
function preenchimentoDoBaseline(): string {
  const baseline = readFileSync(join(process.cwd(), "supabase/baseline.sql"), "utf8");
  const ancora =
    "insert into public.billing_usage_counters (organization_id, item, valor)\nselect cl.organization_id, 'leads', count(*)";
  const posicao = baseline.indexOf(ancora);
  if (posicao === -1) throw new Error("preenchimento inicial do contador não achado no baseline");
  return baseline.slice(posicao, baseline.indexOf(";", posicao) + 1);
}

const ORG_EXISTENTE = "d0532001-0000-4000-8000-000000000001";
const PIPELINE_EXISTENTE = "d0532001-0000-4000-8000-000000000002";
const STAGE_EXISTENTE = "d0532001-0000-4000-8000-000000000003";

const ORG_AUSENTE = "d0532001-0000-4000-8000-000000000011";
const PIPELINE_AUSENTE = "d0532001-0000-4000-8000-000000000012";
const STAGE_AUSENTE = "d0532001-0000-4000-8000-000000000013";

function orgComFunil(org: string, pipeline: string, stage: string, slug: string): string {
  return `
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${org}', '${slug}', '${slug} LTDA', '${slug}')
      on conflict (id) do nothing;
    insert into public.crm_pipelines (id, organization_id, name, slug)
      values ('${pipeline}', '${org}', 'Funil ${slug}', 'funil-${slug}');
    insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position)
      values ('${stage}', '${org}', '${pipeline}', 'Entrada', 'entrada-${slug}', 1000);
  `;
}

function leadAberto(org: string, pipeline: string, stage: string, titulo: string): string {
  return `insert into public.crm_leads (organization_id, pipeline_id, stage_id, title)
    values ('${org}', '${pipeline}', '${stage}', '${titulo}');`;
}

describe("D-053 item 2: a reaplicação do baseline só cria a linha de contador que falta", () => {
  it("contador que JÁ existe não é sobrescrito, nem para cima nem para baixo (quem corrige é o conferidor diário)", () => {
    const linhas = comoServico(`
      begin;
      ${orgComFunil(ORG_EXISTENTE, PIPELINE_EXISTENTE, STAGE_EXISTENTE, "d053-existente")}
      -- 2 leads abertos de verdade: o gatilho já deixa o contador em 2.
      ${leadAberto(ORG_EXISTENTE, PIPELINE_EXISTENTE, STAGE_EXISTENTE, "Lead D053 um")}
      ${leadAberto(ORG_EXISTENTE, PIPELINE_EXISTENTE, STAGE_EXISTENTE, "Lead D053 dois")}
      select 'SONDA|antes=' || valor from public.billing_usage_counters
        where organization_id = '${ORG_EXISTENTE}' and item = 'leads';

      -- Um valor que um incremento concorrente já tinha elevado além da foto.
      update public.billing_usage_counters set valor = 7
        where organization_id = '${ORG_EXISTENTE}' and item = 'leads';

      ${preenchimentoDoBaseline()}

      select 'SONDA|depois_para_cima=' || valor from public.billing_usage_counters
        where organization_id = '${ORG_EXISTENTE}' and item = 'leads';

      -- E o inverso: um valor abaixo do real também fica como está (a correção
      -- dos dois sentidos é do fn_billing_conferir_contador, não do baseline).
      update public.billing_usage_counters set valor = 1
        where organization_id = '${ORG_EXISTENTE}' and item = 'leads';

      ${preenchimentoDoBaseline()}

      select 'SONDA|depois_para_baixo=' || valor from public.billing_usage_counters
        where organization_id = '${ORG_EXISTENTE}' and item = 'leads';

      -- O conferidor diário segue cobrindo a deriva, nos dois sentidos.
      select 'SONDA|conferidor_divergia=' || public.fn_billing_conferir_contador('${ORG_EXISTENTE}'::uuid);
      select 'SONDA|conferidor_corrigiu=' || valor from public.billing_usage_counters
        where organization_id = '${ORG_EXISTENTE}' and item = 'leads';
      rollback;
    `);
    expect(linhas).toEqual([
      "antes=2",
      "depois_para_cima=7",
      "depois_para_baixo=1",
      "conferidor_divergia=true",
      "conferidor_corrigiu=2",
    ]);
  });

  it("organização com leads abertos e SEM linha de contador ganha a linha, com a contagem real", () => {
    const linhas = comoServico(`
      begin;
      ${orgComFunil(ORG_AUSENTE, PIPELINE_AUSENTE, STAGE_AUSENTE, "d053-ausente")}
      ${leadAberto(ORG_AUSENTE, PIPELINE_AUSENTE, STAGE_AUSENTE, "Lead D053 a")}
      ${leadAberto(ORG_AUSENTE, PIPELINE_AUSENTE, STAGE_AUSENTE, "Lead D053 b")}
      ${leadAberto(ORG_AUSENTE, PIPELINE_AUSENTE, STAGE_AUSENTE, "Lead D053 c")}

      -- Simula o estado de antes do contador existir (instalação que ainda não
      -- tinha a linha): apaga a que o gatilho criou.
      delete from public.billing_usage_counters
        where organization_id = '${ORG_AUSENTE}' and item = 'leads';
      select 'SONDA|sem_linha=' || count(*) from public.billing_usage_counters
        where organization_id = '${ORG_AUSENTE}' and item = 'leads';

      ${preenchimentoDoBaseline()}

      select 'SONDA|com_linha=' || valor from public.billing_usage_counters
        where organization_id = '${ORG_AUSENTE}' and item = 'leads';
      rollback;
    `);
    expect(linhas).toEqual(["sem_linha=0", "com_linha=3"]);
  });
});
