/**
 * Migração 0941 (D-176): venda do plano no ciclo semestral e anual, à vista. Provado no Postgres
 * real: os preços decididos em 29/09/2026 na versão ativa de cada plano, o pedido por ciclo (valor
 * do período vindo do catálogo, cartão ou Pix), o período do contrato (seis ou doze meses mais um
 * dia, igual ao nextDueDate do Asaas mais um dia), a renovação conferida contra o preço do ciclo, a
 * concessão mensal de tokens com período longo, o estorno total e a recusa da troca de ciclo.
 *
 * Roda via `pnpm test:db tests/invariants/venda-semestral-e-anual-banco.test.ts`.
 */
import { describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

const U = (n: number) => `0941a000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ORG_SEMESTRAL = U(1);
const ORG_ANUAL = U(2);
const ORG_PIX_SEMESTRAL = U(3);
const ORG_PIX_ANUAL = U(4);
const ORG_PEDIDOS = U(5);
const ORG_TROCA = U(6);
const ORG_ESTORNO = U(7);
const ORGS = [ORG_SEMESTRAL, ORG_ANUAL, ORG_PIX_SEMESTRAL, ORG_PIX_ANUAL, ORG_PEDIDOS, ORG_TROCA, ORG_ESTORNO];

const CICLO = "public.fn_billing_ciclo_de(now())";
const HOJE = "to_char(current_date, 'YYYY-MM-DD')";

function erroDe(comando: string): string | null {
  try {
    sql(comando);
    return null;
  } catch (err) {
    return motivoDoErro(err);
  }
}

function registrarEAplicar(eventId: string, tipo: string, pagamento: string, confirmacao: string): string {
  sql(`select public.fn_billing_asaas_registrar_evento('${eventId}', '${tipo}', '${pagamento}', 'sandbox', 'webhook', '{}'::jsonb);`);
  sql(`select public.fn_billing_asaas_reservar_eventos(50, 300);`);
  const linha = sql(`select id, lease_token from public.asaas_webhook_events where event_id = '${eventId}';`);
  const [id, lease] = linha.split("|");
  expect(id, `evento ${eventId} não foi reservado`).toBeTruthy();
  return sql(`select public.fn_billing_asaas_aplicar_evento('${(id ?? "").trim()}'::uuid, '${(lease ?? "").trim()}'::uuid, ${confirmacao});`);
}

function confirmacao(pagamento: string, status: string, reais: string, due: string, extra = ""): string {
  return `jsonb_build_object('id','${pagamento}','status','${status}','value',${reais},'dueDate',${due}${extra})`;
}

function abrirPedido(org: string, plano: string, ciclo: string, metodo: string, pagamento: string, assinatura: string | null): string {
  sql(`select public.fn_billing_criar_pedido('${org}'::uuid, 'assinatura', '${plano}', '${ciclo}', null, '${metodo}', 'sandbox', gen_random_uuid(), null);`);
  const pedido = sql(`select id from public.billing_orders where organization_id = '${org}' and status = 'criado' order by created_at desc limit 1;`);
  sql(`select public.fn_billing_pedido_registrar_cobranca('${org}'::uuid, '${pedido}'::uuid, '${pagamento}', ${assinatura ? `'${assinatura}'` : "null"}, null);`);
  return pedido;
}

const contrato = (org: string, colunas: string) =>
  sql(`select ${colunas} from public.billing_contracts where organization_id = '${org}';`);

/** O fim do período em data civil de São Paulo, comparado com data + N meses + 1 dia. */
const fimEh = (org: string, due: string, meses: number) =>
  contrato(org, `((current_period_end at time zone 'America/Sao_Paulo')::date = ((${due})::date + interval '${meses} months')::date + 1)::text`);

describe("0941: setup", () => {
  it("cria as organizações e liga a compra, a venda do Pro e a concessão de sandbox", () => {
    sql(`
      ${ORGS.map((id) => `insert into public.organizations (id, slug, legal_name, display_name) values ('${id}', 'i941-${id.slice(-2)}', 'i941 LTDA', 'i941') on conflict (id) do nothing;`).join("\n")}
      select public.fn_billing_definir_compra_pelo_cliente(true, null);
      select public.fn_billing_definir_a_venda('pro', true, null);
      select public.fn_billing_definir_a_venda('max', true, null);
      update public.billing_settings set asaas_sandbox_concede = true where id = 1;
    `);
    expect(sql(`select count(*) from public.organizations where id = any(array[${ORGS.map((id) => `'${id}'`).join(",")}]::uuid[]);`)).toBe(String(ORGS.length));
  });
});

describe("0941: os preços decididos em 29/09/2026 estão na versão ativa", () => {
  it("semestral e anual de Pro, Max e Escale, em centavos", () => {
    const linhas = sql(`select code || '|' || price_semiannual_cents || '|' || price_yearly_cents from public.billing_plans where active and code in ('pro','max','escale') order by price_monthly_cents;`).split("\n");
    expect(linhas).toEqual(["pro|104900|189900", "max|214900|379900", "escale|319900|574900"]);
  });

  it("o mensal não mudou e o Ilimitado segue sem preço de ciclo", () => {
    expect(sql(`select code || '|' || price_monthly_cents from public.billing_plans where active and code in ('pro','max','escale') order by price_monthly_cents;`).split("\n")).toEqual(["pro|19900", "max|39900", "escale|59900"]);
    expect(sql(`select coalesce(price_semiannual_cents::text,'nulo') || '|' || coalesce(price_yearly_cents::text,'nulo') from public.billing_plans where active and code = 'ilimitado';`)).toBe("nulo|nulo");
  });

  it("reaplicar a atualização de preço não sobrescreve o que o admin definiu depois", () => {
    sql(`update public.billing_plans set price_semiannual_cents = 111100 where code = 'escale' and active;`);
    sql(`
      update public.billing_plans set price_semiannual_cents = case code when 'pro' then 104900 when 'max' then 214900 when 'escale' then 319900 end
       where active and code in ('pro','max','escale') and price_semiannual_cents is null;`);
    expect(sql(`select price_semiannual_cents from public.billing_plans where code = 'escale' and active;`)).toBe("111100");
    sql(`update public.billing_plans set price_semiannual_cents = 319900 where code = 'escale' and active;`);
  });

  it("preço negativo é barrado pela constraint nova", () => {
    expect(erroDe(`update public.billing_plans set price_semiannual_cents = -1 where code = 'pro' and active;`)).toContain("billing_plans_preco_semestral_nao_negativo");
  });
});

describe("0941: o pedido por ciclo", () => {
  const pedido = (org: string, plano: string, ciclo: string, metodo: string) =>
    sql(`select public.fn_billing_criar_pedido('${org}'::uuid, 'assinatura', '${plano}', '${ciclo}', null, '${metodo}', 'sandbox', gen_random_uuid(), null)->>'amount_cents';`);

  it("o valor do período vem do catálogo, no cartão e no Pix, e cada pedido guarda o ciclo", () => {
    expect(pedido(ORG_PEDIDOS, "pro", "semiannual", "CREDIT_CARD")).toBe("104900");
    sql(`update public.billing_orders set status = 'cancelado' where organization_id = '${ORG_PEDIDOS}';`);
    expect(pedido(ORG_PEDIDOS, "pro", "semiannual", "PIX")).toBe("104900");
    sql(`update public.billing_orders set status = 'cancelado' where organization_id = '${ORG_PEDIDOS}';`);
    expect(pedido(ORG_PEDIDOS, "max", "yearly", "CREDIT_CARD")).toBe("379900");
    sql(`update public.billing_orders set status = 'cancelado' where organization_id = '${ORG_PEDIDOS}';`);
    expect(pedido(ORG_PEDIDOS, "pro", "yearly", "PIX")).toBe("189900");
    expect(sql(`select string_agg(distinct ciclo, ',' order by ciclo) from public.billing_orders where organization_id = '${ORG_PEDIDOS}';`)).toBe("semiannual,yearly");
    sql(`update public.billing_orders set status = 'cancelado' where organization_id = '${ORG_PEDIDOS}';`);
  });

  it("o mensal continua só no cartão e a entrada nunca decide o valor", () => {
    expect(erroDe(`select public.fn_billing_criar_pedido('${ORG_PEDIDOS}'::uuid, 'assinatura', 'pro', 'monthly', null, 'PIX', 'sandbox', gen_random_uuid(), null);`)).toContain("billing_metodo_invalido_para_oferta");
    expect(pedido(ORG_PEDIDOS, "pro", "monthly", "CREDIT_CARD")).toBe("19900");
    sql(`update public.billing_orders set status = 'cancelado' where organization_id = '${ORG_PEDIDOS}';`);
  });

  it("ciclo desconhecido é recusado", () => {
    expect(erroDe(`select public.fn_billing_criar_pedido('${ORG_PEDIDOS}'::uuid, 'assinatura', 'pro', 'quarterly', null, 'CREDIT_CARD', 'sandbox', gen_random_uuid(), null);`)).toContain("billing_ciclo_invalido");
  });

  it("plano sem preço no ciclo não vende o ciclo (semestral nulo e anual zero), sem afetar o outro", () => {
    expect(erroDe(`
      begin;
      update public.billing_plans set price_semiannual_cents = null where code = 'pro' and active;
      select public.fn_billing_criar_pedido('${ORG_PEDIDOS}'::uuid, 'assinatura', 'pro', 'semiannual', null, 'CREDIT_CARD', 'sandbox', gen_random_uuid(), null);
      rollback;`)).toContain("billing_preco_nao_definido");
    expect(erroDe(`
      begin;
      update public.billing_plans set price_yearly_cents = 0 where code = 'pro' and active;
      select public.fn_billing_criar_pedido('${ORG_PEDIDOS}'::uuid, 'assinatura', 'pro', 'yearly', null, 'PIX', 'sandbox', gen_random_uuid(), null);
      rollback;`)).toContain("billing_preco_nao_definido");
  });
});

describe("0941: o período do ciclo", () => {
  const periodo = (due: string, ciclo: string) =>
    sql(`select periodo_inicio || '|' || periodo_fim from public.fn_billing_asaas_periodo_do_ciclo('${due}'::date, '${ciclo}');`);

  it("semestral: vencimento + 6 meses + 1 dia, à meia-noite de São Paulo", () => {
    expect(periodo("2026-10-08", "semiannual")).toBe("2026-10-08 03:00:00+00|2027-04-09 03:00:00+00");
  });

  it("semestral no dia 31: o fim do mês curto prende (31/08 + 6 meses = 28/02), como o nextDueDate do Asaas", () => {
    expect(periodo("2026-08-31", "semiannual")).toBe("2026-08-31 03:00:00+00|2027-03-01 03:00:00+00");
  });

  it("anual e mensal seguem iguais", () => {
    expect(periodo("2026-10-08", "yearly")).toBe("2026-10-08 03:00:00+00|2027-10-09 03:00:00+00");
    expect(periodo("2026-10-08", "monthly")).toBe("2026-10-08 03:00:00+00|2026-11-09 03:00:00+00");
  });

  it("ciclo fora do vocabulário é recusado", () => {
    expect(erroDe(`select * from public.fn_billing_asaas_periodo_do_ciclo('2026-10-08'::date, 'quarterly');`)).toContain("billing_ciclo_invalido");
  });
});

describe("0941: semestral no cartão, do primeiro pagamento à renovação", () => {
  const SUB = "sub_i941_sem";
  let pedido = "";

  it("o primeiro pagamento grava plano, ciclo semiannual e o período de seis meses mais um dia", () => {
    pedido = abrirPedido(ORG_SEMESTRAL, "pro", "semiannual", "CREDIT_CARD", "pay_i941_s1", SUB);
    const r = registrarEAplicar("evt-i941-s1", "PAYMENT_CONFIRMED", "pay_i941_s1", confirmacao("pay_i941_s1", "CONFIRMED", "1049.00", HOJE, `,'subscription','${SUB}','externalReference','HC:ord:${pedido}'`));
    expect(r).toContain('"resultado": "aplicado"');
    expect(r).not.toContain("divergente_valor");
    expect(contrato(ORG_SEMESTRAL, "cycle || '|' || status || '|' || gateway")).toBe("semiannual|ativa|asaas");
    expect(fimEh(ORG_SEMESTRAL, HOJE, 6)).toBe("true");
    expect(sql(`select status from public.billing_orders where id = '${pedido}';`)).toBe("pago");
    expect(sql(`select (billing_period_end = (select current_period_end from public.billing_contracts where organization_id = '${ORG_SEMESTRAL}'))::text from public.billing_payments where asaas_payment_id = 'pay_i941_s1';`)).toBe("true");
  });

  it("pagar menos que o preço do período é divergente e não concede", () => {
    const orgFraca = ORG_PEDIDOS;
    sql(`update public.billing_orders set status = 'cancelado' where organization_id = '${orgFraca}';`);
    const p = abrirPedido(orgFraca, "pro", "semiannual", "CREDIT_CARD", "pay_i941_barato", "sub_i941_barato");
    const r = registrarEAplicar("evt-i941-barato", "PAYMENT_CONFIRMED", "pay_i941_barato", confirmacao("pay_i941_barato", "CONFIRMED", "199.00", HOJE, `,'subscription','sub_i941_barato','externalReference','HC:ord:${p}'`));
    expect(r).toContain('"resultado": "divergente"');
    expect(sql(`select count(*) from public.billing_payments where asaas_payment_id = 'pay_i941_barato';`)).toBe("0");
    sql(`update public.billing_orders set status = 'cancelado' where organization_id = '${orgFraca}';`);
  });

  it("a renovação (cobrança nova da mesma assinatura, seis meses depois) estende o período e confere o valor contra o semestral", () => {
    const dueRenovacao = `to_char(current_date + interval '6 months', 'YYYY-MM-DD')`;
    const r = registrarEAplicar("evt-i941-s2", "PAYMENT_CONFIRMED", "pay_i941_s2", confirmacao("pay_i941_s2", "CONFIRMED", "1049.00", dueRenovacao, `,'customer',null,'subscription','${SUB}','assinatura_status','ACTIVE'`));
    expect(r).toContain('"resultado": "aplicado"');
    expect(r).not.toContain("divergente_valor");
    expect(fimEh(ORG_SEMESTRAL, `current_date + interval '6 months'`, 6)).toBe("true");
    expect(contrato(ORG_SEMESTRAL, "cycle || '|' || status")).toBe("semiannual|ativa");
    expect(sql(`select count(*) from public.billing_payments where organization_id = '${ORG_SEMESTRAL}' and origem = 'asaas';`)).toBe("2");
  });

  it("renovação com valor diferente do preço do ciclo alarma (nunca compara com o mensal): abaixo é divergente (0942), acima concede com divergente_valor", () => {
    const due = `to_char(current_date + interval '12 months', 'YYYY-MM-DD')`;
    const abaixo = registrarEAplicar("evt-i941-s3", "PAYMENT_CONFIRMED", "pay_i941_s3", confirmacao("pay_i941_s3", "CONFIRMED", "199.00", due, `,'subscription','${SUB}'`));
    expect(abaixo).toContain('"resultado": "divergente"');
    const acima = registrarEAplicar("evt-i941-s3b", "PAYMENT_CONFIRMED", "pay_i941_s3b", confirmacao("pay_i941_s3b", "CONFIRMED", "1500.00", due, `,'subscription','${SUB}'`));
    expect(acima).toContain('"resultado": "aplicado"');
    expect(acima).toContain("divergente_valor");
  });

  it("a mesma confirmação de novo é ja_aplicado e nada duplica", () => {
    const due = `to_char(current_date + interval '6 months', 'YYYY-MM-DD')`;
    const r = registrarEAplicar("evt-i941-s2b", "PAYMENT_RECEIVED", "pay_i941_s2", confirmacao("pay_i941_s2", "RECEIVED", "1049.00", due, `,'subscription','${SUB}'`));
    expect(r).toContain('"resultado": "ja_aplicado"');
    expect(sql(`select count(*) from public.billing_payments where asaas_payment_id = 'pay_i941_s2';`)).toBe("1");
  });
});

describe("0941: tokens do plano com período longo (a carteira segue o mês civil, D-106)", () => {
  const cicloMais = (meses: number) => `(${CICLO} + interval '${meses} months')::date`;
  const chaveDo = (meses: number) => `'plano:' || to_char(${cicloMais(meses)}, 'YYYY-MM-DD')`;

  it("o contrato semestral ativo recebe o plano de cada mês do período, inteiro, uma vez por mês", () => {
    for (const m of [0, 1, 3, 5]) {
      sql(`select public.fn_billing_garantir_concessoes('${ORG_SEMESTRAL}'::uuid, ${cicloMais(m)});`);
      sql(`select public.fn_billing_garantir_concessoes('${ORG_SEMESTRAL}'::uuid, ${cicloMais(m)});`);
      expect(sql(`select count(*) || '|' || coalesce(max(tokens), 0) from public.billing_token_ledger where organization_id = '${ORG_SEMESTRAL}' and chave = ${chaveDo(m)};`), `mês +${m}`).toMatch(/^1\|(3000000|\d+)$/);
    }
    // Os meses de depois do primeiro levam o teto inteiro.
    expect(sql(`select tokens from public.billing_token_ledger where organization_id = '${ORG_SEMESTRAL}' and chave = ${chaveDo(3)};`)).toBe("3000000");
    expect(sql(`select creditado from public.billing_token_wallets where organization_id = '${ORG_SEMESTRAL}' and fonte = 'plano' and ciclo = ${cicloMais(3)};`)).toBe("3000000");
  });

  it("o contrato anual ativo também recebe o mês seguinte", () => {
    const pedido = abrirPedido(ORG_ANUAL, "pro", "yearly", "CREDIT_CARD", "pay_i941_a1", "sub_i941_anu");
    const r = registrarEAplicar("evt-i941-a1", "PAYMENT_CONFIRMED", "pay_i941_a1", confirmacao("pay_i941_a1", "CONFIRMED", "1899.00", HOJE, `,'subscription','sub_i941_anu','externalReference','HC:ord:${pedido}'`));
    expect(r).toContain('"resultado": "aplicado"');
    expect(contrato(ORG_ANUAL, "cycle || '|' || status")).toBe("yearly|ativa");
    expect(fimEh(ORG_ANUAL, HOJE, 12)).toBe("true");
    sql(`select public.fn_billing_garantir_concessoes('${ORG_ANUAL}'::uuid, ${cicloMais(1)});`);
    expect(sql(`select tokens from public.billing_token_ledger where organization_id = '${ORG_ANUAL}' and chave = ${chaveDo(1)};`)).toBe("3000000");
  });

  it("controle negativo: período vencido não recebe o mês novo, mesmo tendo contratado seis meses", () => {
    sql(`update public.billing_contracts set current_period_end = now() - interval '1 hour' where organization_id = '${ORG_SEMESTRAL}';`);
    sql(`select public.fn_billing_garantir_concessoes('${ORG_SEMESTRAL}'::uuid, ${cicloMais(4)});`);
    expect(sql(`select count(*) from public.billing_token_ledger where organization_id = '${ORG_SEMESTRAL}' and chave = ${chaveDo(4)};`)).toBe("0");
  });
});

describe("0941: Pix semestral e anual (cobrança avulsa, sem assinatura no Asaas)", () => {
  it("Pix semestral: início no dia do pagamento, fim seis meses e um dia depois", () => {
    const pedido = abrirPedido(ORG_PIX_SEMESTRAL, "pro", "semiannual", "PIX", "pay_i941_px1", null);
    const r = registrarEAplicar("evt-i941-px1", "PAYMENT_RECEIVED", "pay_i941_px1", confirmacao("pay_i941_px1", "RECEIVED", "1049.00", HOJE, `,'paymentDate',${HOJE},'externalReference','HC:ord:${pedido}'`));
    expect(r).toContain('"resultado": "aplicado"');
    expect(contrato(ORG_PIX_SEMESTRAL, "cycle || '|' || status || '|' || coalesce(asaas_subscription_id, 'sem-assinatura')")).toBe("semiannual|ativa|sem-assinatura");
    expect(fimEh(ORG_PIX_SEMESTRAL, HOJE, 6)).toBe("true");
  });

  it("Pix anual: fim um ano e um dia depois (comportamento anterior preservado)", () => {
    const pedido = abrirPedido(ORG_PIX_ANUAL, "pro", "yearly", "PIX", "pay_i941_px2", null);
    const r = registrarEAplicar("evt-i941-px2", "PAYMENT_RECEIVED", "pay_i941_px2", confirmacao("pay_i941_px2", "RECEIVED", "1899.00", HOJE, `,'paymentDate',${HOJE},'externalReference','HC:ord:${pedido}'`));
    expect(r).toContain('"resultado": "aplicado"');
    expect(fimEh(ORG_PIX_ANUAL, HOJE, 12)).toBe("true");
  });

  it("Pix semestral com período ainda pago soma seis meses exatos ao fim atual (0942: sem o dia extra), sem encurtar nem sobrepor", () => {
    const fimAntes = contrato(ORG_PIX_SEMESTRAL, "current_period_end");
    const pedido = abrirPedido(ORG_PIX_SEMESTRAL, "pro", "semiannual", "PIX", "pay_i941_px3", null);
    const r = registrarEAplicar("evt-i941-px3", "PAYMENT_RECEIVED", "pay_i941_px3", confirmacao("pay_i941_px3", "RECEIVED", "1049.00", HOJE, `,'paymentDate',${HOJE},'externalReference','HC:ord:${pedido}'`));
    expect(r).toContain('"resultado": "aplicado"');
    expect(sql(`select ((current_period_end at time zone 'America/Sao_Paulo')::date = (('${fimAntes}'::timestamptz at time zone 'America/Sao_Paulo')::date + interval '6 months')::date)::text from public.billing_contracts where organization_id = '${ORG_PIX_SEMESTRAL}';`)).toBe("true");
  });
});

describe("0941: troca de ciclo de quem já tem contrato em andamento é recusada", () => {
  const tentar = (org: string, ciclo: string, metodo = "CREDIT_CARD") =>
    erroDe(`select public.fn_billing_criar_pedido('${org}'::uuid, 'assinatura', 'pro', '${ciclo}', null, '${metodo}', 'sandbox', gen_random_uuid(), null);`);

  it("Pix anual ativo não aceita semestral nem mensal, e nenhum pedido é criado", () => {
    expect(tentar(ORG_PIX_ANUAL, "semiannual", "PIX")).toContain("billing_troca_de_ciclo_indisponivel");
    expect(tentar(ORG_PIX_ANUAL, "monthly")).toContain("billing_troca_de_ciclo_indisponivel");
    expect(sql(`select count(*) from public.billing_orders where organization_id = '${ORG_PIX_ANUAL}' and status = 'criado';`)).toBe("0");
  });

  it("anual com assinatura viva: outro ciclo recebe a mensagem de troca, o mesmo ciclo a de assinatura ativa", () => {
    expect(tentar(ORG_ANUAL, "monthly")).toContain("billing_troca_de_ciclo_indisponivel");
    expect(tentar(ORG_ANUAL, "semiannual")).toContain("billing_troca_de_ciclo_indisponivel");
    expect(tentar(ORG_ANUAL, "yearly")).toContain("billing_ja_tem_assinatura_asaas");
  });

  it("o mesmo ciclo por Pix, com período pago e sem assinatura viva, renova antecipado (não é troca)", () => {
    expect(tentar(ORG_PIX_ANUAL, "yearly", "PIX")).toBeNull();
    sql(`update public.billing_orders set status = 'cancelado' where organization_id = '${ORG_PIX_ANUAL}';`);
  });

  it("contrato sem ciclo (registro manual) ou com período vencido pode escolher qualquer ciclo", () => {
    sql(`select public.fn_billing_registrar_pagamento('${ORG_TROCA}'::uuid, (current_date + 40)::date, 1000, '${U(900)}'::uuid, 'manual', null);`);
    expect(contrato(ORG_TROCA, "coalesce(cycle, 'sem-ciclo')")).toBe("sem-ciclo");
    // 0942: o pagamento manual é período pago, então outro PLANO fica recusado; este caso mede só o
    // ciclo, por isso o contrato é posto no próprio Pro.
    sql(`update public.billing_contracts set plan_id = (select id from public.billing_plans where code = 'pro' and active) where organization_id = '${ORG_TROCA}';`);
    expect(tentar(ORG_TROCA, "semiannual")).toBeNull();
    sql(`update public.billing_orders set status = 'cancelado' where organization_id = '${ORG_TROCA}';`);

    sql(`update public.billing_contracts set cycle = 'yearly', current_period_end = now() - interval '1 day' where organization_id = '${ORG_TROCA}';`);
    expect(tentar(ORG_TROCA, "monthly")).toBeNull();
  });
});

describe("0941: estorno total do semestral (D-086) corta acesso e tokens do período vigente", () => {
  const SUB = "sub_i941_est";
  const CICLO_TXT = `to_char(${CICLO}, 'YYYY-MM-DD')`;

  it("estornar a cobrança do semestral cancela o contrato na hora, zera os tokens do mês e pede a remoção da assinatura", () => {
    const pedido = abrirPedido(ORG_ESTORNO, "pro", "semiannual", "CREDIT_CARD", "pay_i941_e1", SUB);
    registrarEAplicar("evt-i941-e1a", "PAYMENT_CONFIRMED", "pay_i941_e1", confirmacao("pay_i941_e1", "CONFIRMED", "1049.00", HOJE, `,'subscription','${SUB}','externalReference','HC:ord:${pedido}'`));
    sql(`update public.billing_contracts set current_period_start = ${CICLO}::timestamp at time zone 'America/Sao_Paulo'
          where organization_id = '${ORG_ESTORNO}' and current_period_start > ${CICLO}::timestamp at time zone 'America/Sao_Paulo';`);
    sql(`select public.fn_billing_saldo_da_carteira('${ORG_ESTORNO}'::uuid);`);
    expect(sql(`select creditado || '|' || consumido from public.billing_token_wallets where organization_id = '${ORG_ESTORNO}' and fonte = 'plano' and ciclo = ${CICLO};`)).toBe("3000000|0");

    const r = registrarEAplicar("evt-i941-e1b", "PAYMENT_REFUNDED", "pay_i941_e1", confirmacao("pay_i941_e1", "REFUNDED", "1049.00", HOJE, `,'subscription','${SUB}'`));
    expect(r).toContain('"resultado": "aplicado"');
    expect(r).toContain('"alarme": "estorno_confirmado,estorno_cortou_acesso,remover_assinatura_pendente"');
    expect(contrato(ORG_ESTORNO, "status || '|' || cancel_at_period_end || '|' || (current_period_end <= now())")).toBe("cancelada|true|true");
    expect(sql(`select status from public.billing_orders where id = '${pedido}';`)).toBe("estornado");
    expect(sql(`select creditado - consumido from public.billing_token_wallets where organization_id = '${ORG_ESTORNO}' and fonte = 'plano' and ciclo = ${CICLO};`)).toBe("0");
    expect(sql(`select count(*) from public.billing_token_ledger where organization_id = '${ORG_ESTORNO}' and chave like 'ajuste:estorno-plano:' || ${CICLO_TXT} || ':%';`)).toBe("1");
  });

  it("depois do corte o contrato cancelado não recebe o plano do mês seguinte", () => {
    sql(`select public.fn_billing_garantir_concessoes('${ORG_ESTORNO}'::uuid, (${CICLO} + interval '1 month')::date);`);
    expect(sql(`select count(*) from public.billing_token_ledger where organization_id = '${ORG_ESTORNO}' and chave = 'plano:' || to_char((${CICLO} + interval '1 month')::date, 'YYYY-MM-DD');`)).toBe("0");
  });
});
