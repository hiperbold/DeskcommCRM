/**
 * `lib/billing/asaas/leitura.ts`: fase F5, Tarefa 18 (telas do admin, leitura).
 *
 * Dublê de Supabase encadeável (`queryFalsa`): cada método de filtro
 * (`eq`/`in`/`gte`/`lt`/`is`/`not`/`order`/`limit`) devolve o próprio objeto,
 * e o objeto é "thenable": `await query` resolve para o resultado
 * configurado, o mesmo contrato que o `PostgrestFilterBuilder` real cumpre.
 * Não testa CADA função exaustivamente: cobre o que o briefing pede: falha
 * em cada leitura vira `leituraFalhou`, a chave nunca aparece no objeto
 * devolvido, o payload nunca é devolvido, e os contadores de alarme.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const ORIGINAL = { ...process.env };

async function importarComEnv(vars: Record<string, string>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(vars)) process.env[k] = v;
  return import("@/lib/billing/asaas/leitura");
}

afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.resetModules();
});

interface ResultadoFalso {
  data: unknown;
  error: unknown;
  count?: number;
}

/**
 * Uma query falsa encadeável. `resultadoPorTabela` decide o que cada
 * `.from(tabela)` devolve; chamadas repetidas na MESMA tabela (ex.:
 * `asaas_webhook_events` usada duas vezes em `contadoresDeAlarmeAsaas`) usam
 * uma fila: a primeira chamada consome o primeiro resultado da lista.
 */
function dbFalso(resultadoPorTabela: Record<string, ResultadoFalso | ResultadoFalso[]>) {
  const chamadasPorTabela: Record<string, number> = {};

  function queryFalsa(resultado: ResultadoFalso) {
    const builder: Record<string, unknown> = {};
    const encadeavel = ["select", "eq", "order", "in", "gte", "lt", "is", "not", "limit"];
    for (const metodo of encadeavel) {
      builder[metodo] = vi.fn(() => builder);
    }
    builder.maybeSingle = vi.fn(async () => resultado);
    builder.then = (
      resolve: (v: ResultadoFalso) => unknown,
      reject?: (e: unknown) => unknown,
    ) => Promise.resolve(resultado).then(resolve, reject);
    return builder;
  }

  const db = {
    from: vi.fn((tabela: string) => {
      const config = resultadoPorTabela[tabela];
      if (!config) throw new Error(`dbFalso: tabela não configurada: ${tabela}`);
      if (Array.isArray(config)) {
        const indice = chamadasPorTabela[tabela] ?? 0;
        chamadasPorTabela[tabela] = indice + 1;
        return queryFalsa(config[Math.min(indice, config.length - 1)] as ResultadoFalso);
      }
      return queryFalsa(config);
    }),
  };
  return db as unknown as SupabaseClient;
}

// ─────────────────────────────────────────────────────────────────────────
// 1. estadoDasChavesAsaas: a chave nunca aparece no objeto devolvido.
// ─────────────────────────────────────────────────────────────────────────

describe("estadoDasChavesAsaas", () => {
  it("nunca lança e nunca inclui a chave (ASAAS_API_KEY) no objeto devolvido", async () => {
    const { estadoDasChavesAsaas } = await importarComEnv({
      ASAAS_ENABLED: "true",
      ASAAS_BASE_URL: "https://api-sandbox.asaas.com/v3",
      ASAAS_API_KEY: "$aact_hmlg_segredoQueNuncaPodeAparecer",
    });
    const db = dbFalso({ billing_settings: { data: { compra_pelo_cliente: true }, error: null } });
    const estado = await estadoDasChavesAsaas(db);

    expect(estado.habilitado).toBe(true);
    expect(estado.ambiente).toBe("sandbox");
    expect(estado.compraPeloCliente).toBe(true);
    expect(estado.erroConfiguracao).toBeNull();

    const serializado = JSON.stringify(estado);
    expect(serializado).not.toContain("segredoQueNuncaPodeAparecer");
    expect(serializado).not.toContain("$aact_");
    expect(Object.keys(estado).sort()).toEqual(
      ["ambiente", "compraPeloCliente", "erroConfiguracao", "habilitado"].sort(),
    );
  });

  it("erro de configuração (base/chave incoerente) vira erroConfiguracao, nunca lança", async () => {
    const { estadoDasChavesAsaas } = await importarComEnv({
      ASAAS_ENABLED: "true",
      ASAAS_BASE_URL: "https://api-sandbox.asaas.com/v3",
      ASAAS_API_KEY: "$aact_prod_outroSegredo",
    });
    const db = dbFalso({ billing_settings: { data: null, error: null } });
    const estado = await estadoDasChavesAsaas(db);

    expect(estado.habilitado).toBe(true);
    expect(estado.erroConfiguracao).toBeTruthy();
    expect(estado.erroConfiguracao).not.toContain("outroSegredo");
    // Config incoerente: a compra pelo cliente nunca liga, mesmo que o banco
    // diga sim (aqui nem chega a perguntar: dbFalso devolveria erro se
    // chamado com o filtro errado).
    expect(estado.compraPeloCliente).toBe(false);
  });

  it("ASAAS_ENABLED desligada: ambiente neutro (sandbox), sem tocar o banco por compra desligada", async () => {
    const { estadoDasChavesAsaas } = await importarComEnv({});
    const db = dbFalso({ billing_settings: { data: { compra_pelo_cliente: true }, error: null } });
    const estado = await estadoDasChavesAsaas(db);
    expect(estado.habilitado).toBe(false);
    expect(estado.ambiente).toBe("sandbox");
    expect(estado.compraPeloCliente).toBe(false);
    expect(estado.erroConfiguracao).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. planosParaVenda: falha vira leituraFalhou.
// ─────────────────────────────────────────────────────────────────────────

describe("planosParaVenda", () => {
  it("lê planos ativos com for_sale e preço", async () => {
    const { planosParaVenda } = await importarComEnv({});
    const db = dbFalso({
      billing_plans: {
        data: [
          {
            code: "pro",
            name: "Pro",
            version: 3,
            for_sale: false,
            price_monthly_cents: 39900,
            price_yearly_cents: null,
          },
        ],
        error: null,
      },
    });
    const resultado = await planosParaVenda(db);
    expect(resultado.leituraFalhou).toBe(false);
    expect(resultado.planos).toEqual([
      {
        code: "pro",
        name: "Pro",
        version: 3,
        forSale: false,
        priceMonthlyCents: 39900,
        priceYearlyCents: null,
      },
    ]);
  });

  it("falha na leitura vira leituraFalhou:true e lista vazia, nunca lança", async () => {
    const { planosParaVenda } = await importarComEnv({});
    const db = dbFalso({ billing_plans: { data: null, error: { message: "conexão recusada" } } });
    await expect(planosParaVenda(db)).resolves.toEqual({ planos: [], leituraFalhou: true });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. pedidosAsaas: falha vira leituraFalhou.
// ─────────────────────────────────────────────────────────────────────────

describe("pedidosAsaas", () => {
  it("falha na leitura vira leituraFalhou:true, nunca lança", async () => {
    const { pedidosAsaas } = await importarComEnv({});
    const db = dbFalso({ billing_orders: { data: null, error: { message: "timeout" } } });
    await expect(pedidosAsaas(db, { organizationId: "org-1" })).resolves.toEqual({
      pedidos: [],
      leituraFalhou: true,
    });
  });

  it("lê e converte a linha crua para camelCase", async () => {
    const { pedidosAsaas } = await importarComEnv({});
    const db = dbFalso({
      billing_orders: {
        data: [
          {
            id: "pedido-1",
            organization_id: "org-1",
            ambiente: "sandbox",
            tipo: "assinatura",
            ciclo: "monthly",
            metodo: "CREDIT_CARD",
            amount_cents: 19900,
            status: "aguardando_pagamento",
            external_reference: "HC:ord:pedido-1",
            asaas_payment_id: null,
            asaas_subscription_id: null,
            invoice_url: null,
            created_at: "2026-09-24T10:00:00Z",
            updated_at: "2026-09-24T10:00:00Z",
            pago_em: null,
          },
        ],
        error: null,
      },
    });
    const resultado = await pedidosAsaas(db, { organizationId: "org-1" });
    expect(resultado.leituraFalhou).toBe(false);
    expect(resultado.pedidos[0]).toMatchObject({
      id: "pedido-1",
      organizationId: "org-1",
      externalReference: "HC:ord:pedido-1",
      amountCents: 19900,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 4. eventosAsaas: nunca traz o payload cru.
// ─────────────────────────────────────────────────────────────────────────

describe("eventosAsaas", () => {
  it("nunca seleciona a coluna payload", async () => {
    const { eventosAsaas } = await importarComEnv({});
    let colunasSelecionadas = "";
    const db = {
      from: vi.fn((tabela: string) => {
        expect(tabela).toBe("asaas_webhook_events");
        return {
          select: vi.fn((colunas: string) => {
            colunasSelecionadas = colunas;
            return {
              order: vi.fn(() => ({
                limit: vi.fn(async () => ({ data: [], error: null })),
              })),
            };
          }),
        };
      }),
    } as unknown as SupabaseClient;

    await eventosAsaas(db);
    expect(colunasSelecionadas).not.toContain("payload");
  });

  it("devolve tipo, datas, tentativas, erro_codigo, alarme e organization_id, e o payload nunca aparece no objeto devolvido", async () => {
    const { eventosAsaas } = await importarComEnv({});
    const db = dbFalso({
      asaas_webhook_events: {
        data: [
          {
            id: "evt-1",
            event_type: "PAYMENT_CONFIRMED",
            resource_id: "pay_123",
            ambiente: "sandbox",
            origem: "webhook",
            recebido_em: "2026-09-24T09:00:00Z",
            processado_em: "2026-09-24T09:00:05Z",
            resultado: "divergente",
            tentativas: 1,
            proxima_tentativa_em: null,
            erro_codigo: "billing_divergente",
            organization_id: "org-1",
            alarme: "divergente_valor",
            // Se o dublê devolvesse um `payload` (não deveria, ver o teste
            // acima), este teste prova que ele não escapa para o objeto final.
            payload: { cartao: "nao deveria vazar" },
          },
        ],
        error: null,
      },
    });
    const resultado = await eventosAsaas(db, { resultado: "divergente" });
    expect(resultado.leituraFalhou).toBe(false);
    expect(resultado.eventos).toHaveLength(1);
    expect(resultado.eventos[0]).toEqual({
      id: "evt-1",
      eventType: "PAYMENT_CONFIRMED",
      idDoRecurso: "pay_123",
      ambiente: "sandbox",
      origem: "webhook",
      recebidoEm: "2026-09-24T09:00:00Z",
      processadoEm: "2026-09-24T09:00:05Z",
      resultado: "divergente",
      tentativas: 1,
      proximaTentativaEm: null,
      erroCodigo: "billing_divergente",
      organizationId: "org-1",
      alarme: "divergente_valor",
    });
    expect(JSON.stringify(resultado)).not.toContain("nao deveria vazar");
  });

  it("falha na leitura vira leituraFalhou:true, nunca lança", async () => {
    const { eventosAsaas } = await importarComEnv({});
    const db = dbFalso({ asaas_webhook_events: { data: null, error: { message: "timeout" } } });
    await expect(eventosAsaas(db)).resolves.toEqual({ eventos: [], leituraFalhou: true });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 5. contadoresDeAlarmeAsaas.
// ─────────────────────────────────────────────────────────────────────────

describe("contadoresDeAlarmeAsaas", () => {
  it("soma os quatro contadores por count; o quinto é da INSTALAÇÃO: assinatura ativa e nenhum evento recente", async () => {
    const { contadoresDeAlarmeAsaas } = await importarComEnv({});

    const db = dbFalso({
      // pendente, erro, divergente, sem_vinculo, evento recente (3 dias):
      // cada `.from` desta tabela é uma consulta DIFERENTE por count.
      asaas_webhook_events: [
        { data: null, error: null, count: 2 }, // pendente > 1h
        { data: null, error: null, count: 1 }, // erro 24h
        { data: null, error: null, count: 0 }, // divergente 24h
        { data: null, error: null, count: 3 }, // sem_vinculo 24h
        { data: null, error: null, count: 0 }, // nenhum evento nos últimos 3 dias
      ],
      billing_contracts: { data: null, error: null, count: 1 }, // existe ao menos 1 assinatura ativa
    });

    const resultado = await contadoresDeAlarmeAsaas(db);
    expect(resultado.leituraFalhou).toBe(false);
    expect(resultado.contadores).toEqual({
      pendenteHaMaisDeUmaHora: 2,
      erroUltimas24h: 1,
      divergenteUltimas24h: 0,
      semVinculoUltimas24h: 3,
      semEventoHa3DiasComAssinaturaAtiva: 1,
    });
  });

  it("existe assinatura ativa, mas HOUVE evento recente: o quinto contador é zero", async () => {
    const { contadoresDeAlarmeAsaas } = await importarComEnv({});
    const db = dbFalso({
      asaas_webhook_events: [
        { data: null, error: null, count: 0 },
        { data: null, error: null, count: 0 },
        { data: null, error: null, count: 0 },
        { data: null, error: null, count: 0 },
        { data: null, error: null, count: 5 }, // eventos nos últimos 3 dias
      ],
      billing_contracts: { data: null, error: null, count: 2 },
    });
    const resultado = await contadoresDeAlarmeAsaas(db);
    expect(resultado.contadores.semEventoHa3DiasComAssinaturaAtiva).toBe(0);
  });

  it("sem NENHUMA assinatura ativa: o quinto contador é zero mesmo sem evento recente", async () => {
    const { contadoresDeAlarmeAsaas } = await importarComEnv({});
    const db = dbFalso({
      asaas_webhook_events: { data: null, error: null, count: 0 },
      billing_contracts: { data: null, error: null, count: 0 },
    });
    const resultado = await contadoresDeAlarmeAsaas(db);
    expect(resultado.contadores.semEventoHa3DiasComAssinaturaAtiva).toBe(0);
  });

  it("falha em qualquer contagem vira leituraFalhou:true, contadores zerados, nunca lança", async () => {
    const { contadoresDeAlarmeAsaas } = await importarComEnv({});
    const db = dbFalso({
      asaas_webhook_events: { data: null, error: { message: "indisponível" }, count: undefined },
      billing_contracts: { data: null, error: null, count: 0 },
    });
    const resultado = await contadoresDeAlarmeAsaas(db);
    expect(resultado.leituraFalhou).toBe(true);
    expect(resultado.contadores).toEqual({
      pendenteHaMaisDeUmaHora: 0,
      erroUltimas24h: 0,
      divergenteUltimas24h: 0,
      semVinculoUltimas24h: 0,
      semEventoHa3DiasComAssinaturaAtiva: 0,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 6. asaasDaOrganizacao: cliente só com id cus_/ambiente, nunca dado pessoal.
// ─────────────────────────────────────────────────────────────────────────

describe("asaasDaOrganizacao", () => {
  it("cliente, assinatura, pedidos e pagamentos com origem, sem dado pessoal", async () => {
    const { asaasDaOrganizacao } = await importarComEnv({});
    const db = dbFalso({
      billing_customers: {
        data: { asaas_customer_id: "cus_000abc", ambiente: "sandbox" },
        error: null,
      },
      billing_contracts: {
        data: { asaas_subscription_id: "sub_xyz", asaas_assinatura_encerrada_em: null },
        error: null,
      },
      billing_orders: { data: [], error: null },
      billing_payments: {
        data: [
          {
            id: "pag-1",
            status: "CONFIRMED",
            gross_cents: 39900,
            origem: "asaas",
            order_id: "pedido-1",
            paid_at: "2026-09-24T10:00:00Z",
            billing_period_start: "2026-09-24T03:00:00Z",
            billing_period_end: "2026-10-25T03:00:00Z",
            created_at: "2026-09-24T10:00:05Z",
          },
        ],
        error: null,
      },
    });

    const resultado = await asaasDaOrganizacao(db, "org-1");
    expect(resultado.leituraFalhou).toBe(false);
    expect(resultado.cliente).toEqual({ asaasCustomerId: "cus_000abc", ambiente: "sandbox" });
    expect(resultado.assinatura).toEqual({ asaasSubscriptionId: "sub_xyz", encerradaEm: null });
    expect(resultado.pagamentos[0]).toMatchObject({ origem: "asaas", orderId: "pedido-1" });

    // O cliente NUNCA guarda nome/CPF/e-mail/celular (decisão 16): o objeto
    // devolvido só pode ter as duas chaves esperadas.
    expect(Object.keys(resultado.cliente ?? {}).sort()).toEqual(["ambiente", "asaasCustomerId"]);
  });

  it("sem cliente vinculado e sem assinatura: null nos dois, sem lançar", async () => {
    const { asaasDaOrganizacao } = await importarComEnv({});
    const db = dbFalso({
      billing_customers: { data: null, error: null },
      billing_contracts: { data: { asaas_subscription_id: null, asaas_assinatura_encerrada_em: null }, error: null },
      billing_orders: { data: [], error: null },
      billing_payments: { data: [], error: null },
    });
    const resultado = await asaasDaOrganizacao(db, "org-1");
    expect(resultado.cliente).toBeNull();
    expect(resultado.assinatura).toBeNull();
  });

  it("falha em qualquer uma das leituras vira leituraFalhou:true, tudo vazio, nunca lança", async () => {
    const { asaasDaOrganizacao } = await importarComEnv({});
    const db = dbFalso({
      billing_customers: { data: null, error: null },
      billing_contracts: { data: null, error: null },
      billing_orders: { data: [], error: null },
      billing_payments: { data: null, error: { message: "conexão recusada" } },
    });
    const resultado = await asaasDaOrganizacao(db, "org-1");
    expect(resultado).toEqual({
      cliente: null,
      assinatura: null,
      pedidos: [],
      pagamentos: [],
      leituraFalhou: true,
    });
  });
});
