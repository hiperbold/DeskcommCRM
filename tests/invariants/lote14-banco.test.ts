/**
 * Migração 0940 (lote 14, D-094 revisto em 06/10/2026): a organização que se cadastra sozinha
 * nasce SEM plano ativo, não em avaliação. Provado no Postgres real, com o modo `bloquear` ligado
 * (é nele que o bloqueio vale): a criação da organização não quebra, o contrato nasce suspenso e,
 * passados os poucos segundos de margem da própria criação, o modo leitura vale; o primeiro
 * pagamento tira a organização do estado; quem nasce sem o marcador segue no Ilimitado.
 *
 * Cada arquivo de invariante roda num banco próprio (ver vitest.db.config.ts), então ligar o modo
 * `bloquear` aqui não vaza para outro arquivo.
 *
 * Roda via `pnpm test:db tests/invariants/lote14-banco.test.ts`.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { sql } from "./psql-transporte";

const U = (n: number) => `0940a000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ORG_SEM_PLANO = U(1);
const ORG_LEGADO = U(2);
const ORG_ILIMITADO = U(3);
const ORG_PAGA = U(4);

/** Linhas marcadas com SONDA| (uma saída por linha). Sem transação própria: cada comando é a sua. */
function sonda(corpo: string): string[] {
  return sql(corpo)
    .split("\n")
    .filter((l) => l.startsWith("SONDA|"))
    .map((l) => l.slice(6));
}

const modoLeitura = (id: string) => `select 'SONDA|' || public.fn_billing_modo_leitura('${id}')::text;`;

beforeAll(() => {
  // As organizações são criadas COM o modo bloquear já ligado e com carência de 7 dias na
  // instalação: é o cenário em que a semeadura do funil padrão podia derrubar a criação e em que
  // o gatilho da 0907 daria uma semana de uso à organização nova.
  sql(`
    update public.billing_settings set modo = 'bloquear', carencia_dias = 7 where id = 1;
    insert into public.organizations (id, slug, legal_name, display_name, settings) values
      ('${ORG_SEM_PLANO}', 'l14-sem-plano', 'X', 'X', '{"billing_inicio":"sem_plano"}'::jsonb),
      ('${ORG_LEGADO}', 'l14-legado', 'X', 'X', '{"billing_inicio":"avaliacao"}'::jsonb),
      ('${ORG_ILIMITADO}', 'l14-ilimitado', 'X', 'X', '{}'::jsonb),
      ('${ORG_PAGA}', 'l14-paga', 'X', 'X', '{"billing_inicio":"sem_plano"}'::jsonb);
  `);
  // A margem de 5 segundos da criação passa: dali em diante é outra requisição.
  sql(`select pg_sleep(6);`);
});

describe("0940: cadastro próprio nasce sem plano", () => {
  it("criar a organização no modo bloquear não quebra: o funil padrão da semeadura nasceu", () => {
    const linhas = sonda(`
      select 'SONDA|' || count(*) from public.crm_pipelines where organization_id = '${ORG_SEM_PLANO}';`);
    expect(linhas).toEqual(["1"]);
  });

  it("o contrato é suspenso, sem período e sem ciclo, e a carência de 7 dias do gatilho não foi dada", () => {
    const [linha] = sonda(`
      select 'SONDA|' || bc.status || '|' || (bc.current_period_end is null)::text || '|' || (bc.cycle is null)::text
        || '|' || (bc.gateway is null)::text || '|' || (bc.bloqueio_a_partir_de < now() + interval '1 day')::text
        from public.billing_contracts bc where bc.organization_id = '${ORG_SEM_PLANO}';`);
    expect(linha).toBe("suspensa|true|true|true|true");
  });

  it("passada a margem da criação o modo leitura vale; com o modo avisar a instalação não cobra e nada para", () => {
    expect(sonda(modoLeitura(ORG_SEM_PLANO))).toEqual(["true"]);
    try {
      sql(`update public.billing_settings set modo = 'avisar' where id = 1;`);
      expect(sonda(modoLeitura(ORG_SEM_PLANO))).toEqual(["false"]);
    } finally {
      sql(`update public.billing_settings set modo = 'bloquear' where id = 1;`);
    }
  });

  it("CONTROLE POSITIVO: quem nasce sem o marcador (instalação, provisionamento) segue ativa no Ilimitado e fora do modo leitura", () => {
    const linhas = sonda(`
      ${modoLeitura(ORG_ILIMITADO)}
      select 'SONDA|' || bc.status || '|' || bp.code from public.billing_contracts bc
        join public.billing_plans bp on bp.id = bc.plan_id where bc.organization_id = '${ORG_ILIMITADO}';`);
    expect(linhas).toEqual(["false", "ativa|ilimitado"]);
  });

  it("o marcador antigo (avaliacao, da 0928) vale como sinônimo e nunca cai no Ilimitado", () => {
    const linhas = sonda(`
      select 'SONDA|' || status from public.billing_contracts where organization_id = '${ORG_LEGADO}';
      ${modoLeitura(ORG_LEGADO)}`);
    expect(linhas).toEqual(["suspensa", "true"]);
  });

  it("a organização sem plano não ganha aviso de assinatura na Central (sem período, o conferidor não age)", () => {
    const [linha] = sonda(`
      select public.fn_billing_conferir_vencimento('${ORG_SEM_PLANO}');
      select 'SONDA|' || count(*) from public.agent_inbox_items
        where organization_id = '${ORG_SEM_PLANO}' and ref_kind = 'billing_assinatura';`);
    expect(linha).toBe("0");
  });

  it("o primeiro pagamento tira a organização do estado: ativa, com período, e o modo leitura cai", () => {
    expect(sonda(modoLeitura(ORG_PAGA))).toEqual(["true"]);
    const linhas = sonda(`
      select public.fn_billing_registrar_pagamento('${ORG_PAGA}'::uuid, (now() + interval '40 days')::date, 1000, '${U(500)}'::uuid, 'primeiro pagamento', null);
      select 'SONDA|' || status || '|' || (current_period_end > now())::text
        from public.billing_contracts where organization_id = '${ORG_PAGA}';
      ${modoLeitura(ORG_PAGA)}`);
    expect(linhas).toEqual(["ativa|true", "false"]);
  });
});
