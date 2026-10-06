/**
 * Migração 0942: correção da auditoria do lote 15 (venda semestral e anual, 0941). Provado no
 * Postgres real, pelo mesmo caminho do processador (registrar evento, reservar com lease, aplicar
 * com o objeto confirmado):
 *
 *   1. troca de PLANO com período pago vigente é recusada na criação do pedido (cartão e Pix) e,
 *      se o pagamento chegar mesmo assim, não troca o plano; mesmo plano empilha; o início do
 *      período do contrato nunca vai para o futuro;
 *   2. estorno com pagamentos empilhados: o do ÚLTIMO só encurta o período (o primeiro ainda vale),
 *      o do PRIMEIRO só alarma, e o corte inteiro só vem quando nenhum pagamento restante cobre o
 *      futuro;
 *   3. os preços semestral e anual são semeados uma vez: preço zerado pelo admin não volta na
 *      reaplicação do bloco do baseline, e plano em versão nova não herda preço velho;
 *   4. renovação abaixo do preço do ciclo não estende o período, assinatura encerrada não é
 *      roteada como renovação, e o Pix depois de encerrar o cartão não guarda o id encerrado;
 *   6. o Pix empilhado dura exatamente o ciclo, sem o dia extra.
 *
 * Roda via `pnpm test:db tests/invariants/lote15-auditoria-banco.test.ts`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

const U = (n: number) => `0942a000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ORG_TROCA_PIX = U(1);
const ORG_CORTESIA = U(2);
const ORG_DEFESA = U(3);
const ORG_EMPILHA = U(4);
const ORG_EST_ULTIMO = U(5);
const ORG_EST_PRIMEIRO = U(6);
const ORG_RENOVACAO = U(7);
const ORG_PIX_DEPOIS_CARTAO = U(8);
const ORGS = [
  ORG_TROCA_PIX, ORG_CORTESIA, ORG_DEFESA, ORG_EMPILHA, ORG_EST_ULTIMO, ORG_EST_PRIMEIRO,
  ORG_RENOVACAO, ORG_PIX_DEPOIS_CARTAO,
];

const CICLO = "public.fn_billing_ciclo_de(now())";
const HOJE = "to_char(current_date, 'YYYY-MM-DD')";
const SP = "'America/Sao_Paulo'";

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

/** Compra e paga um Pix (anual por padrão) e devolve o resultado da aplicação. */
function pagarPix(org: string, plano: string, pagamento: string, evento: string, reais = "1899.00", ciclo = "yearly"): string {
  const pedido = abrirPedido(org, plano, ciclo, "PIX", pagamento, null);
  return registrarEAplicar(evento, "PAYMENT_RECEIVED", pagamento, confirmacao(pagamento, "RECEIVED", reais, HOJE, `,'paymentDate',${HOJE},'externalReference','HC:ord:${pedido}'`));
}

const contrato = (org: string, colunas: string) =>
  sql(`select ${colunas} from public.billing_contracts where organization_id = '${org}';`);
const tentar = (org: string, plano: string, ciclo: string, metodo: string) =>
  erroDe(`select public.fn_billing_criar_pedido('${org}'::uuid, 'assinatura', '${plano}', '${ciclo}', null, '${metodo}', 'sandbox', gen_random_uuid(), null);`);
const cancelarAbertos = (org: string) =>
  sql(`update public.billing_orders set status = 'cancelado' where organization_id = '${org}' and status in ('criado', 'aguardando_pagamento');`);
const fimDoPagamento = (pagamento: string) =>
  sql(`select billing_period_end from public.billing_payments where asaas_payment_id = '${pagamento}';`);

describe("0942: setup", () => {
  it("cria as organizações e liga a compra, a venda do Pro e do Max e a concessão de sandbox", () => {
    sql(`
      ${ORGS.map((id) => `insert into public.organizations (id, slug, legal_name, display_name) values ('${id}', 'i942-${id.slice(-2)}', 'i942 LTDA', 'i942') on conflict (id) do nothing;`).join("\n")}
      select public.fn_billing_definir_compra_pelo_cliente(true, null);
      select public.fn_billing_definir_a_venda('pro', true, null);
      select public.fn_billing_definir_a_venda('max', true, null);
      update public.billing_settings set asaas_sandbox_concede = true where id = 1;
    `);
    expect(sql(`select count(*) from public.organizations where id = any(array[${ORGS.map((id) => `'${id}'`).join(",")}]::uuid[]);`)).toBe(String(ORGS.length));
  });
});

describe("0942 item 1: troca de plano com período pago vigente", () => {
  it("quem tem Pix anual do Pro vigente não pode comprar outro plano, nem no Pix nem no cartão, e nenhum pedido nasce", () => {
    expect(pagarPix(ORG_TROCA_PIX, "pro", "pay_i942_t1", "evt-i942-t1")).toContain('"resultado": "aplicado"');
    expect(tentar(ORG_TROCA_PIX, "max", "yearly", "PIX")).toContain("billing_troca_de_plano_indisponivel");
    expect(tentar(ORG_TROCA_PIX, "max", "yearly", "CREDIT_CARD")).toContain("billing_troca_de_plano_indisponivel");
    expect(tentar(ORG_TROCA_PIX, "max", "semiannual", "PIX")).toContain("billing_troca_de_plano_indisponivel");
    expect(sql(`select count(*) from public.billing_orders where organization_id = '${ORG_TROCA_PIX}' and status = 'criado';`)).toBe("0");
    expect(contrato(ORG_TROCA_PIX, "(select code from public.billing_plans where id = plan_id)")).toBe("pro");
  });

  it("o mesmo plano e o mesmo ciclo continua podendo empilhar", () => {
    expect(tentar(ORG_TROCA_PIX, "pro", "yearly", "PIX")).toBeNull();
    cancelarAbertos(ORG_TROCA_PIX);
  });

  it("período vigente SEM pagamento (cortesia) não impede a compra de outro plano", () => {
    sql(`update public.billing_contracts
            set plan_id = (select id from public.billing_plans where code = 'pro' and active), status = 'ativa',
                cycle = null, current_period_end = now() + interval '30 days'
          where organization_id = '${ORG_CORTESIA}';`);
    expect(sql(`select count(*) from public.billing_payments where organization_id = '${ORG_CORTESIA}';`)).toBe("0");
    expect(tentar(ORG_CORTESIA, "max", "yearly", "PIX")).toBeNull();
    cancelarAbertos(ORG_CORTESIA);
  });

  it("defesa na aplicação: pagamento de pedido de OUTRO plano com período pago vigente é divergente e não troca o plano", () => {
    // O pedido do Max nasce quando a organização ainda não tem período pago.
    const pedido = abrirPedido(ORG_DEFESA, "max", "yearly", "PIX", "pay_i942_d1", null);
    // Depois disso o contrato passa a ter o Pro com um período pago a frente (pagamento manual).
    sql(`
      update public.billing_contracts
         set plan_id = (select id from public.billing_plans where code = 'pro' and active), status = 'ativa',
             cycle = 'yearly', current_period_start = now() - interval '1 day', current_period_end = now() + interval '200 days'
       where organization_id = '${ORG_DEFESA}';
      insert into public.billing_payments (organization_id, contract_id, gross_cents, status, paid_at, billing_period_start, billing_period_end, chave, origem)
        select '${ORG_DEFESA}', id, 189900, 'RECEIVED_IN_CASH', now(), now() - interval '1 day', now() + interval '200 days', gen_random_uuid(), 'manual'
          from public.billing_contracts where organization_id = '${ORG_DEFESA}';
    `);
    const fimAntes = contrato(ORG_DEFESA, "current_period_end");
    const r = registrarEAplicar("evt-i942-d1", "PAYMENT_RECEIVED", "pay_i942_d1", confirmacao("pay_i942_d1", "RECEIVED", "3799.00", HOJE, `,'paymentDate',${HOJE},'externalReference','HC:ord:${pedido}'`));
    expect(r).toContain('"resultado": "divergente"');
    expect(r).toContain("troca_de_plano_com_periodo_vigente");
    expect(contrato(ORG_DEFESA, "(select code from public.billing_plans where id = plan_id)")).toBe("pro");
    expect(contrato(ORG_DEFESA, "current_period_end")).toBe(fimAntes);
    expect(sql(`select count(*) from public.billing_payments where asaas_payment_id = 'pay_i942_d1';`)).toBe("0");
    expect(sql(`select status from public.billing_orders where id = '${pedido}';`)).not.toBe("pago");
  });
});

describe("0942 item 6 e item 1: Pix empilhado sem o dia extra e sem início no futuro", () => {
  it("o primeiro Pix anual vai até o mesmo dia do ano seguinte mais um dia (limite exclusivo)", () => {
    expect(pagarPix(ORG_EMPILHA, "pro", "pay_i942_e1", "evt-i942-e1")).toContain('"resultado": "aplicado"');
    expect(contrato(ORG_EMPILHA, `((current_period_end at time zone ${SP})::date = (current_date + interval '1 year')::date + 1)::text`)).toBe("true");
  });

  it("o segundo Pix do mesmo plano começa no fim do primeiro e dura exatamente um ano, sem dia extra", () => {
    const fim1 = fimDoPagamento("pay_i942_e1");
    expect(pagarPix(ORG_EMPILHA, "pro", "pay_i942_e2", "evt-i942-e2")).toContain('"resultado": "aplicado"');
    expect(sql(`select billing_period_start = '${fim1}'::timestamptz from public.billing_payments where asaas_payment_id = 'pay_i942_e2';`)).toBe("t");
    expect(sql(`select ((billing_period_end at time zone ${SP})::date = (('${fim1}'::timestamptz at time zone ${SP})::date + interval '1 year')::date)::text from public.billing_payments where asaas_payment_id = 'pay_i942_e2';`)).toBe("true");
    expect(contrato(ORG_EMPILHA, "current_period_end = (select billing_period_end from public.billing_payments where asaas_payment_id = 'pay_i942_e2')")).toBe("t");
  });

  it("o início do período do contrato nunca fica no futuro, mesmo com o pagamento empilhado", () => {
    expect(contrato(ORG_EMPILHA, "(current_period_start <= now())::text")).toBe("true");
  });
});

describe("0942 item 2: estorno com pagamentos empilhados", () => {
  const estornar = (evento: string, pagamento: string, valor = "1899.00") =>
    registrarEAplicar(evento, "PAYMENT_REFUNDED", pagamento, confirmacao(pagamento, "REFUNDED", valor, HOJE));
  const carteiraDoPlano = (org: string) =>
    sql(`select coalesce(creditado - consumido, 0) from public.billing_token_wallets where organization_id = '${org}' and fonte = 'plano' and ciclo = ${CICLO};`);

  it("B: estornar o ÚLTIMO dos dois só encurta o período para o fim do primeiro, sem cancelar nem zerar tokens", () => {
    expect(pagarPix(ORG_EST_ULTIMO, "pro", "pay_i942_u1", "evt-i942-u1")).toContain('"resultado": "aplicado"');
    expect(pagarPix(ORG_EST_ULTIMO, "pro", "pay_i942_u2", "evt-i942-u2")).toContain('"resultado": "aplicado"');
    sql(`select public.fn_billing_saldo_da_carteira('${ORG_EST_ULTIMO}'::uuid);`);
    const tokensAntes = carteiraDoPlano(ORG_EST_ULTIMO);
    expect(Number(tokensAntes)).toBeGreaterThan(0);

    const r = estornar("evt-i942-u3", "pay_i942_u2");
    expect(r).toContain('"resultado": "aplicado"');
    expect(r).toContain('"alarme": "estorno_confirmado,estorno_encurtou_periodo"');
    expect(r).not.toContain("estorno_cortou_acesso");
    expect(contrato(ORG_EST_ULTIMO, "status || '|' || cancel_at_period_end")).toBe("ativa|false");
    expect(contrato(ORG_EST_ULTIMO, `current_period_end = '${fimDoPagamento("pay_i942_u1")}'::timestamptz`)).toBe("t");
    expect(carteiraDoPlano(ORG_EST_ULTIMO)).toBe(tokensAntes);
    expect(sql(`select count(*) from public.billing_token_ledger where organization_id = '${ORG_EST_ULTIMO}' and chave like 'ajuste:estorno-plano:%';`)).toBe("0");
    expect(sql(`select count(*) from public.billing_contract_eventos where organization_id = '${ORG_EST_ULTIMO}' and motivo = 'estorno_asaas' and tipo = 'periodo';`)).toBe("1");
  });

  it("B, depois: estornar também o primeiro (nada mais cobre o futuro) cancela e zera os tokens do mês", () => {
    const r = estornar("evt-i942-u4", "pay_i942_u1");
    expect(r).toContain('"alarme": "estorno_confirmado,estorno_cortou_acesso"');
    expect(contrato(ORG_EST_ULTIMO, "status || '|' || cancel_at_period_end || '|' || (current_period_end <= now())")).toBe("cancelada|true|true");
    expect(carteiraDoPlano(ORG_EST_ULTIMO)).toBe("0");
  });

  it("A: estornar o PRIMEIRO dos dois só alarma: o pagamento seguinte segue valendo e o período fica inteiro", () => {
    expect(pagarPix(ORG_EST_PRIMEIRO, "pro", "pay_i942_p1", "evt-i942-p1")).toContain('"resultado": "aplicado"');
    expect(pagarPix(ORG_EST_PRIMEIRO, "pro", "pay_i942_p2", "evt-i942-p2")).toContain('"resultado": "aplicado"');
    sql(`select public.fn_billing_saldo_da_carteira('${ORG_EST_PRIMEIRO}'::uuid);`);
    const fimAntes = contrato(ORG_EST_PRIMEIRO, "current_period_end");
    const tokensAntes = carteiraDoPlano(ORG_EST_PRIMEIRO);

    const r = estornar("evt-i942-p3", "pay_i942_p1");
    expect(r).toContain('"alarme": "estorno_confirmado,estorno_de_periodo_antigo"');
    expect(contrato(ORG_EST_PRIMEIRO, "status")).toBe("ativa");
    expect(contrato(ORG_EST_PRIMEIRO, "current_period_end")).toBe(fimAntes);
    expect(carteiraDoPlano(ORG_EST_PRIMEIRO)).toBe(tokensAntes);
  });

  it("A, depois: estornar o segundo, que é o último que sobrou, cancela e zera os tokens do mês", () => {
    const r = estornar("evt-i942-p4", "pay_i942_p2");
    expect(r).toContain('"alarme": "estorno_confirmado,estorno_cortou_acesso"');
    expect(contrato(ORG_EST_PRIMEIRO, "status")).toBe("cancelada");
    expect(carteiraDoPlano(ORG_EST_PRIMEIRO)).toBe("0");
  });
});

describe("0942 item 3: os preços de ciclo são semeados uma vez", () => {
  const BASELINE = readFileSync(join(process.cwd(), "supabase/baseline.sql"), "utf8");
  const DO_DA_0941 = BASELINE.match(/do \$ciclos_semestral_e_anual\$[\s\S]*?\$ciclos_semestral_e_anual\$;/)?.[0] ?? "";
  // psql imprime a etiqueta de cada comando (ROLLBACK, DO...): o que interessa é o único true/false.
  const ultima = (saida: string) => saida.split("\n").filter((l) => l === "true" || l === "false").at(-1);

  it("a sonda está viva: o bloco da 0941 foi achado no baseline e a marca já foi gravada na instalação", () => {
    expect(DO_DA_0941.length).toBeGreaterThan(500);
    expect(sql(`select (precos_de_ciclo_semeados_em is not null)::text from public.billing_settings where id = 1;`)).toBe("true");
  });

  it("preço zerado pelo admin não volta quando o bloco da 0941 é reaplicado", () => {
    const saida = sql(`
      begin;
      update public.billing_plans set price_semiannual_cents = null, price_yearly_cents = null where code = 'pro' and active;
      ${DO_DA_0941}
      select (price_semiannual_cents is null and price_yearly_cents is null)::text from public.billing_plans where code = 'pro' and active;
      rollback;
    `);
    expect(ultima(saida)).toBe("true");
  });

  it("controle: sem a marca (instalação que nunca semeou) o bloco semeia os preços decididos e grava a marca", () => {
    const saida = sql(`
      begin;
      update public.billing_plans set price_semiannual_cents = null, price_yearly_cents = null where code = 'pro' and active;
      update public.billing_settings set precos_de_ciclo_semeados_em = null where id = 1;
      ${DO_DA_0941}
      select (price_semiannual_cents = 104900 and price_yearly_cents = 189900 and (select precos_de_ciclo_semeados_em is not null from public.billing_settings where id = 1))::text
        from public.billing_plans where code = 'pro' and active;
      rollback;
    `);
    expect(ultima(saida)).toBe("true");
  });

  it("plano em versão nova não herda o preço velho, nem sem a marca", () => {
    const saida = sql(`
      begin;
      update public.billing_plans set active = false where code = 'pro' and active;
      insert into public.billing_plans (code, version, active, name, for_sale, price_monthly_cents, grace_days, limits)
        select code, 2, true, name, for_sale, price_monthly_cents, grace_days, limits from public.billing_plans where code = 'pro' and version = 1;
      update public.billing_settings set precos_de_ciclo_semeados_em = null where id = 1;
      ${DO_DA_0941}
      select (price_semiannual_cents is null and price_yearly_cents is null)::text from public.billing_plans where code = 'pro' and version = 2;
      rollback;
    `);
    expect(ultima(saida)).toBe("true");
  });
});

describe("0942 item 4: renovação", () => {
  const SUB = "sub_i942_ren";
  const due = (meses: number) => `to_char(current_date + interval '${meses} months', 'YYYY-MM-DD')`;
  const renovar = (evento: string, pagamento: string, reais: string, meses: number, assinatura = SUB) =>
    registrarEAplicar(evento, "PAYMENT_CONFIRMED", pagamento, confirmacao(pagamento, "CONFIRMED", reais, due(meses), `,'subscription','${assinatura}','assinatura_status','ACTIVE'`));

  it("setup: semestral no cartão pago pelo preço do ciclo", () => {
    const pedido = abrirPedido(ORG_RENOVACAO, "pro", "semiannual", "CREDIT_CARD", "pay_i942_r1", SUB);
    const r = registrarEAplicar("evt-i942-r1", "PAYMENT_CONFIRMED", "pay_i942_r1", confirmacao("pay_i942_r1", "CONFIRMED", "1049.00", HOJE, `,'subscription','${SUB}','externalReference','HC:ord:${pedido}'`));
    expect(r).toContain('"resultado": "aplicado"');
  });

  it("renovação com valor ABAIXO do preço do ciclo é divergente: o período não anda e nada é gravado", () => {
    const fimAntes = contrato(ORG_RENOVACAO, "current_period_end");
    const r = renovar("evt-i942-r2", "pay_i942_r2", "199.00", 6);
    expect(r).toContain('"resultado": "divergente"');
    expect(r).toContain("renovacao_valor_abaixo_do_ciclo");
    expect(contrato(ORG_RENOVACAO, "current_period_end")).toBe(fimAntes);
    expect(sql(`select count(*) from public.billing_payments where asaas_payment_id = 'pay_i942_r2';`)).toBe("0");
  });

  it("controle: renovação pelo preço do ciclo estende, e acima do preço estende com o alarme divergente_valor", () => {
    expect(renovar("evt-i942-r3", "pay_i942_r3", "1049.00", 6)).toContain('"resultado": "aplicado"');
    const r = renovar("evt-i942-r4", "pay_i942_r4", "1500.00", 12);
    expect(r).toContain('"resultado": "aplicado"');
    expect(r).toContain("divergente_valor");
  });

  it("assinatura com o marcador de encerramento não é roteada como renovação: sem vínculo, nada estende", () => {
    sql(`select public.fn_billing_asaas_marcar_assinatura_encerrada('${ORG_RENOVACAO}'::uuid, '${SUB}', null);`);
    expect(sql(`select categoria from public.fn_billing_asaas_rotear_pagamento('sandbox', '${SUB}', null, 'pay_i942_r5');`)).toBe("sem_vinculo");
    const fimAntes = contrato(ORG_RENOVACAO, "current_period_end");
    const r = renovar("evt-i942-r5", "pay_i942_r5", "1049.00", 18);
    expect(r).toContain('"resultado": "sem_vinculo"');
    expect(contrato(ORG_RENOVACAO, "current_period_end")).toBe(fimAntes);
    expect(sql(`select count(*) from public.billing_payments where asaas_payment_id = 'pay_i942_r5';`)).toBe("0");
  });

  it("controle do roteamento: a assinatura viva continua sendo renovação", () => {
    sql(`update public.billing_contracts set asaas_assinatura_encerrada_em = null where organization_id = '${ORG_RENOVACAO}';`);
    expect(sql(`select categoria from public.fn_billing_asaas_rotear_pagamento('sandbox', '${SUB}', null, 'pay_i942_r6');`)).toBe("renovacao");
    sql(`update public.billing_contracts set asaas_assinatura_encerrada_em = now() where organization_id = '${ORG_RENOVACAO}';`);
  });

  it("Pix comprado depois de encerrar o cartão não guarda o id da assinatura encerrada no contrato", () => {
    const SUB2 = "sub_i942_cartao";
    const pedido = abrirPedido(ORG_PIX_DEPOIS_CARTAO, "pro", "yearly", "CREDIT_CARD", "pay_i942_c1", SUB2);
    expect(registrarEAplicar("evt-i942-c1", "PAYMENT_CONFIRMED", "pay_i942_c1", confirmacao("pay_i942_c1", "CONFIRMED", "1899.00", HOJE, `,'subscription','${SUB2}','externalReference','HC:ord:${pedido}'`))).toContain('"resultado": "aplicado"');
    sql(`select public.fn_billing_asaas_marcar_assinatura_encerrada('${ORG_PIX_DEPOIS_CARTAO}'::uuid, '${SUB2}', null);`);
    expect(contrato(ORG_PIX_DEPOIS_CARTAO, "(asaas_subscription_id is not null)::text || '|' || (asaas_assinatura_encerrada_em is not null)::text")).toBe("true|true");

    expect(pagarPix(ORG_PIX_DEPOIS_CARTAO, "pro", "pay_i942_c2", "evt-i942-c2")).toContain('"resultado": "aplicado"');
    expect(contrato(ORG_PIX_DEPOIS_CARTAO, "coalesce(asaas_subscription_id, 'nenhum') || '|' || (asaas_assinatura_encerrada_em is null)::text")).toBe("nenhum|true");
    expect(contrato(ORG_PIX_DEPOIS_CARTAO, "cycle || '|' || status")).toBe("yearly|ativa");
  });
});

describe("0942: forma", () => {
  it("fn_billing_criar_pedido segue só do servidor e as internas seguem deny-all", () => {
    const acl = (funcao: string) =>
      sql(`select has_function_privilege('anon', '${funcao}', 'execute')::text || '|' || has_function_privilege('authenticated', '${funcao}', 'execute')::text || '|' || has_function_privilege('service_role', '${funcao}', 'execute')::text;`);
    expect(acl("public.fn_billing_criar_pedido(uuid, text, text, text, text, text, text, uuid, uuid, text, integer, integer)")).toBe("false|false|true");
    expect(acl("public.fn_billing_asaas_aplicar_pagamento(jsonb, text)")).toBe("false|false|false");
    expect(acl("public.fn_billing_asaas_rotear_pagamento(text, text, text, text)")).toBe("false|false|false");
    expect(acl("public.fn_billing_asaas_cortar_por_estorno_total(uuid, text, text, uuid, timestamptz, timestamptz, boolean)")).toBe("false|false|false");
  });
});
