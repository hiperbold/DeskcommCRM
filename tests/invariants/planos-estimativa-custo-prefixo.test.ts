import { describe, expect, it } from "vitest";

import { sql } from "./psql-transporte";

/**
 * D-082 (migration 0913, fork Hiperbold): a estimativa de custo de
 * `fn_billing_margem_do_ciclo` casa o modelo pelo prefixo "fabricante/".
 *
 * A linha de embedding pelo gateway grava em `llm_calls` `provider = 'gateway'`
 * e `model = 'openai/text-embedding-3-small'`. Com `cost_cents` nulo, a
 * estimativa tirava o prefixo só quando ele era igual ao provider da linha, não
 * achava o preço no catálogo (`ai_models`: provider `openai`, model_id
 * `text-embedding-3-small`) e contava a chamada em `chamadas_sem_preco`.
 *
 * Molde de `planos-aceite-conta-uma-vez.test.ts`: cada caso vive dentro de
 * `begin; ...; rollback;`, com o catálogo `ai_models` limpo DENTRO da transação
 * dos modelos que o caso usa (o banco descartável pode ter o catálogo
 * sincronizado, e a linha real de um deles mudaria o resultado), e a margem
 * lida como o servidor lê (papel da sessão do container).
 *
 * Rodar (precisa de Docker, é banco): `pnpm test:db tests/invariants/planos-estimativa-custo-prefixo.test.ts`.
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

const ORG_GATEWAY = "d0820001-0000-4000-8000-000000000001";
const ORG_JA_CASAVAM = "d0820002-0000-4000-8000-000000000001";
const ORG_SEM_PRECO = "d0820003-0000-4000-8000-000000000001";
const ORG_CONFLITO = "d0820004-0000-4000-8000-000000000001";

function fixtureOrg(org: string, sufixo: string): string {
  return `
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${org}', 'inv-estimativa-${sufixo}', 'Estimativa ${sufixo} LTDA', 'Estimativa ${sufixo}')
      on conflict (id) do nothing;
  `;
}

/**
 * Preço no catálogo, na transação. `on conflict` porque o banco descartável
 * pode ter a linha real (o delete antes já a tira, mas o insert não depende disso).
 */
function precoNoCatalogo(provider: string, modelId: string, entrada: number, saida: number, deprecado = false): string {
  return `
    insert into public.ai_models (provider, model_id, display_name, input_price_per_million_cents, output_price_per_million_cents, deprecated_at)
      values ('${provider}', '${modelId}', '${modelId}', ${entrada}, ${saida}, ${deprecado ? "now()" : "null"})
      on conflict (provider, model_id) do update set
        input_price_per_million_cents = excluded.input_price_per_million_cents,
        output_price_per_million_cents = excluded.output_price_per_million_cents,
        deprecated_at = excluded.deprecated_at;
  `;
}

function limpaCatalogo(...modelIds: string[]): string {
  const lista = modelIds.map((m) => `'${m}'`).join(", ");
  return `delete from public.ai_models where model_id in (${lista});`;
}

/** Chamada de IA SEM custo gravado (o catálogo estava ilegível na hora da gravação). */
function chamadaSemCusto(org: string, provider: string, model: string, entrada: number, saida: number): string {
  return `
    insert into public.llm_calls
      (organization_id, purpose, provider, model, input_tokens, output_tokens, cache_read_tokens, cost_cents)
      values ('${org}', 'agent_turn', '${provider}', '${model}', ${entrada}, ${saida}, 0, null);
  `;
}

/** A margem do ciclo corrente, do jeito que o painel a lê. */
function margemDe(org: string): string {
  return `
    select 'SONDA|estimadas=' || (m ->> 'chamadas_estimadas')
      || '|sem_preco=' || (m ->> 'chamadas_sem_preco')
      || '|custo=' || (m ->> 'custo_estimado_cents')
      from (select public.fn_billing_margem_do_ciclo('${org}'::uuid, public.fn_billing_ciclo_de(now())) as m) x;
  `;
}

describe("D-082: a estimativa de custo da margem casa o modelo pelo prefixo do fabricante", () => {
  it("embedding pelo gateway (provider 'gateway', model 'openai/text-embedding-3-small') com cost_cents nulo entra na estimativa e NÃO em chamadas_sem_preco", () => {
    const linhas = comoServico(`
      begin;
      ${fixtureOrg(ORG_GATEWAY, "gateway")}
      ${limpaCatalogo("text-embedding-3-small", "openai/text-embedding-3-small")}
      -- Catálogo como o sync o guarda: provider real e model_id SEM prefixo.
      ${precoNoCatalogo("openai", "text-embedding-3-small", 15, 60)}
      ${chamadaSemCusto(ORG_GATEWAY, "gateway", "openai/text-embedding-3-small", 400000, 100000)}
      ${margemDe(ORG_GATEWAY)}
      rollback;
    `);
    // (400000 * 15 + 100000 * 60) / 1e6 = 12
    expect(linhas, "a chamada pelo gateway tem preço no catálogo e tem que ser estimada").toEqual([
      "estimadas=1|sem_preco=0|custo=12",
    ]);
  });

  it("controle: sem preço no catálogo a chamada pelo gateway continua em chamadas_sem_preco (o casamento novo não inventa preço), e linha deprecada não vale", () => {
    const linhas = comoServico(`
      begin;
      ${fixtureOrg(ORG_SEM_PRECO, "sempreco")}
      ${limpaCatalogo("inexistente-0913", "deprecada-0913")}
      ${precoNoCatalogo("openai", "deprecada-0913", 15, 60, true)}
      ${chamadaSemCusto(ORG_SEM_PRECO, "gateway", "openai/inexistente-0913", 1000, 1000)}
      ${chamadaSemCusto(ORG_SEM_PRECO, "gateway", "inexistente-0913", 1000, 1000)}
      ${chamadaSemCusto(ORG_SEM_PRECO, "gateway", "openai/deprecada-0913", 1000, 1000)}
      ${margemDe(ORG_SEM_PRECO)}
      rollback;
    `);
    expect(linhas).toEqual(["estimadas=0|sem_preco=3|custo=0"]);
  });

  it("controle: as linhas que JÁ casavam continuam estimadas do mesmo jeito (provider exato, prefixo igual ao provider, model sem barra em outro provider)", () => {
    const linhas = comoServico(`
      begin;
      ${fixtureOrg(ORG_JA_CASAVAM, "jacasavam")}
      ${limpaCatalogo("exato-0913", "com-prefixo-0913", "sem-barra-0913")}
      ${precoNoCatalogo("openai", "exato-0913", 10, 0)}
      ${precoNoCatalogo("openai", "com-prefixo-0913", 20, 0)}
      ${precoNoCatalogo("anthropic", "sem-barra-0913", 30, 0)}
      -- Casa por (provider, modelo exato): 1000000 * 10 / 1e6 = 10.
      ${chamadaSemCusto(ORG_JA_CASAVAM, "openai", "exato-0913", 1000000, 0)}
      -- Casa por (provider, modelo sem o prefixo igual ao provider): 1000000 * 20 / 1e6 = 20.
      ${chamadaSemCusto(ORG_JA_CASAVAM, "openai", "openai/com-prefixo-0913", 1000000, 0)}
      -- Casa por model_id em QUALQUER provider (sem barra, provider da linha diferente): 1000000 * 30 / 1e6 = 30.
      ${chamadaSemCusto(ORG_JA_CASAVAM, "gateway", "sem-barra-0913", 1000000, 0)}
      ${margemDe(ORG_JA_CASAVAM)}
      rollback;
    `);
    expect(linhas).toEqual(["estimadas=3|sem_preco=0|custo=60"]);
  });

  it("controle: quando o casamento antigo por (openrouter, modelo com prefixo) existe, ele segue mandando; o par novo é só a última preferência", () => {
    const linhas = comoServico(`
      begin;
      ${fixtureOrg(ORG_CONFLITO, "conflito")}
      ${limpaCatalogo("conflito-0913", "openai/conflito-0913")}
      -- Antes da 0913 esta chamada era precificada pela linha do openrouter (100 por milhão).
      ${precoNoCatalogo("openrouter", "openai/conflito-0913", 100, 0)}
      -- A linha do fabricante (1000 por milhão) só passa a ser candidata agora, e perde.
      ${precoNoCatalogo("openai", "conflito-0913", 1000, 0)}
      ${chamadaSemCusto(ORG_CONFLITO, "gateway", "openai/conflito-0913", 1000000, 0)}
      ${margemDe(ORG_CONFLITO)}
      rollback;
    `);
    expect(linhas, "quem já casava não pode mudar de preço").toEqual(["estimadas=1|sem_preco=0|custo=100"]);
  });
});
