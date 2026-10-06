/**
 * Migração 0945: parcelamento do semestral e do anual no cartão (D-177, parte 1). Provado no Postgres
 * real, pelo mesmo caminho do processador (registrar evento, reservar com lease, aplicar com o objeto
 * confirmado):
 *
 *   1. a conta do total no banco é a da Tabela Price e é a mesma de lib/billing/asaas/parcelamento.ts;
 *   2. fn_billing_criar_pedido valida o parcelamento: só cartão, só semestral e anual, dentro do teto
 *      lido de billing_settings, com o total igual ao que o banco calcula; amount_cents do pedido é o total;
 *   3. cada parcela confirmada entra em billing_payments ligada ao pedido, o período é concedido UMA vez
 *      (a primeira parcela), a conferência de valor é pelo TOTAL do parcelamento e nada renova sozinho;
 *   4. estorno: parcela(s) estornada(s) só alarmam; estornadas todas, corta como o estorno total;
 *   5. os parâmetros são semeados uma vez (a reaplicação do bloco não desfaz o que o admin mudou).
 *
 * Roda via `pnpm test:db tests/invariants/parcelamento-banco.test.ts`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { calcularParcelamento } from "@/lib/billing/asaas/parcelamento";

import { motivoDoErro, sql } from "./psql-transporte";

const U = (n: number) => `0945a000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const INST = (n: number) => `0945b000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ORG_VALIDACAO = U(1);
const ORG_SEMESTRAL = U(2);
const ORG_ANUAL_3X = U(3);
const ORG_CONFERE_TOTAL = U(4);
const ORG_EMPILHA = U(5);
const ORG_ESTORNO = U(6);
const ORG_ESTORNO_ORDEM = U(7);
const ORG_IDEMPOTENCIA = U(8);
const ORG_REGISTRO = U(9);
const ORGS = [
  ORG_VALIDACAO, ORG_SEMESTRAL, ORG_ANUAL_3X, ORG_CONFERE_TOTAL, ORG_EMPILHA, ORG_ESTORNO,
  ORG_ESTORNO_ORDEM, ORG_IDEMPOTENCIA, ORG_REGISTRO,
];

/** Os parâmetros que a migration semeia (decisão do Filipe em 06/10/2026). */
const PARAMETROS = { taxaMensal: 0.0199, semJurosAte: 3, maxSemestral: 6, maxAnual: 12 };

const HOJE = "to_char(current_date, 'YYYY-MM-DD')";
const SP = "'America/Sao_Paulo'";
const CICLO = "public.fn_billing_ciclo_de(now())";

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

/** O objeto confirmado de UMA parcela, como o processador monta (com o total lido de GET /installments). */
function confirmacaoDaParcela(
  pagamento: string,
  reaisDaParcela: string,
  pedido: string,
  installment: string,
  totalReais: string,
  parcelas: number,
  extra = "",
): string {
  return `jsonb_build_object('id','${pagamento}','status','CONFIRMED','value',${reaisDaParcela},'dueDate',${HOJE},'paymentDate',${HOJE},'externalReference','HC:ord:${pedido}','installment','${installment}','parcelamento_total',${totalReais},'parcelamento_parcelas',${parcelas}${extra})`;
}

function confirmacaoDeEstorno(pagamento: string, reais: string): string {
  return `jsonb_build_object('id','${pagamento}','status','REFUNDED','value',${reais},'dueDate',${HOJE})`;
}

/** Cria o pedido parcelado (chamada interna, sem ator) e devolve o id. */
function pedirParcelado(org: string, plano: string, ciclo: string, parcelas: number, total: number | null, metodo = "CREDIT_CARD"): string {
  sql(`select public.fn_billing_criar_pedido('${org}'::uuid, 'assinatura', '${plano}', '${ciclo}', null, '${metodo}', 'sandbox', gen_random_uuid(), null, null, ${parcelas}, ${total === null ? "null" : total});`);
  return sql(`select id from public.billing_orders where organization_id = '${org}' and status = 'criado' order by created_at desc limit 1;`);
}

const tentar = (org: string, ciclo: string, parcelas: number, total: number | null, metodo = "CREDIT_CARD", tipo = "assinatura", plano = "pro") =>
  erroDe(`select public.fn_billing_criar_pedido('${org}'::uuid, '${tipo}', ${tipo === "assinatura" ? `'${plano}'` : "null"}, ${tipo === "assinatura" ? `'${ciclo}'` : "null"}, ${tipo === "assinatura" ? "null" : "'pacote_teste'"}, '${metodo}', 'sandbox', gen_random_uuid(), null, null, ${parcelas}, ${total === null ? "null" : total});`);

const cancelarAbertos = (org: string) =>
  sql(`update public.billing_orders set status = 'cancelado' where organization_id = '${org}' and status in ('criado', 'aguardando_pagamento');`);
const contrato = (org: string, colunas: string) =>
  sql(`select ${colunas} from public.billing_contracts where organization_id = '${org}';`);
const pedidoCol = (pedido: string, colunas: string) =>
  sql(`select ${colunas} from public.billing_orders where id = '${pedido}';`);
const linhasDe = (pedido: string) =>
  sql(`select count(*) from public.billing_payments where order_id = '${pedido}' and status in ('CONFIRMED', 'RECEIVED');`);

/** Registra a cobrança da primeira parcela e o id do parcelamento no pedido, como iniciarCompra. */
function registrarCobrancaEParcelamento(org: string, pedido: string, primeiraParcela: string, installment: string) {
  sql(`select public.fn_billing_pedido_registrar_parcelamento('${org}'::uuid, '${pedido}'::uuid, '${installment}');`);
  sql(`select public.fn_billing_pedido_registrar_cobranca('${org}'::uuid, '${pedido}'::uuid, '${primeiraParcela}', null, null);`);
}

/** Paga as N parcelas e devolve os resultados da aplicação, na ordem. */
function pagarParcelas(
  org: string,
  pedido: string,
  prefixo: string,
  installment: string,
  reaisDaParcela: string,
  totalReais: string,
  parcelas: number,
): string[] {
  const resultados: string[] = [];
  for (let k = 1; k <= parcelas; k += 1) {
    const pagamento = `pay_${prefixo}_${k}`;
    resultados.push(
      registrarEAplicar(`evt-${prefixo}-${k}`, "PAYMENT_CONFIRMED", pagamento, confirmacaoDaParcela(pagamento, reaisDaParcela, pedido, installment, totalReais, parcelas)),
    );
  }
  return resultados;
}

describe("0945: setup", () => {
  it("cria as organizações, liga a compra, a venda do Pro e a concessão de sandbox, e cria um pacote de teste", () => {
    sql(`
      ${ORGS.map((id) => `insert into public.organizations (id, slug, legal_name, display_name) values ('${id}', 'i945-${id.slice(-2)}', 'i945 LTDA', 'i945') on conflict (id) do nothing;`).join("\n")}
      select public.fn_billing_definir_compra_pelo_cliente(true, null);
      select public.fn_billing_definir_a_venda('pro', true, null);
      update public.billing_settings set asaas_sandbox_concede = true where id = 1;
      insert into public.billing_token_pacotes (codigo, nome, tokens, preco_cents, ativo)
        values ('pacote_teste', 'Pacote de teste', 1000, 5000, true) on conflict (codigo) do nothing;
    `);
    expect(sql(`select count(*) from public.organizations where id = any(array[${ORGS.map((id) => `'${id}'`).join(",")}]::uuid[]);`)).toBe(String(ORGS.length));
  });

  it("os parâmetros foram semeados: taxa 0,0199, 3x sem juros, semestral até 6x, anual até 12x", () => {
    expect(sql(`select parcelamento_taxa_mensal || '|' || parcelamento_sem_juros_ate || '|' || parcelamento_max_semestral || '|' || parcelamento_max_anual || '|' || (parcelamento_semeado_em is not null)::text from public.billing_settings where id = 1;`)).toBe("0.019900|3|6|12|true");
  });
});

describe("0945 item 1: a conta do total no banco", () => {
  const total = (preco: number, n: number) => sql(`select public.fn_billing_parcelamento_total(${preco}, ${n}, 0.0199, 3);`);

  it("os valores de conferência da decisão (Pro semestral e anual)", () => {
    expect(total(104900, 4)).toBe("110172");
    expect(total(104900, 6)).toBe("112326");
    expect(total(189900, 4)).toBe("199440");
    expect(total(189900, 12)).toBe("215352");
  });

  it("1x, 2x e 3x ficam no preço do ciclo", () => {
    for (const n of [1, 2, 3]) expect(total(104900, n)).toBe("104900");
  });

  it("é a mesma conta do TypeScript, centavo a centavo, para todos os preços de venda e todas as parcelas", () => {
    for (const preco of [104900, 214900, 319900, 189900, 379900, 574900, 100001, 99999]) {
      for (let n = 1; n <= 12; n += 1) {
        expect(total(preco, n), `preco ${preco} em ${n}x`).toBe(String(calcularParcelamento(preco, n, PARAMETROS).totalCents));
      }
    }
  });

  it("taxa nula devolve o preço, e parcelas inválidas são recusadas", () => {
    expect(sql(`select public.fn_billing_parcelamento_total(104900, 6, null, 3);`)).toBe("104900");
    expect(erroDe(`select public.fn_billing_parcelamento_total(104900, 0, 0.0199, 3);`)).toContain("billing_parcelamento_entrada_invalida");
  });
});

describe("0945 item 2: fn_billing_criar_pedido valida o parcelamento", () => {
  it("semestral 4x com o total certo: o pedido nasce com amount_cents = total e parcelas = 4", () => {
    expect(tentar(ORG_VALIDACAO, "semiannual", 4, 110172)).toBeNull();
    expect(sql(`select amount_cents || '|' || parcelas || '|' || metodo || '|' || ciclo from public.billing_orders where organization_id = '${ORG_VALIDACAO}' and status = 'criado';`)).toBe("110172|4|CREDIT_CARD|semiannual");
    cancelarAbertos(ORG_VALIDACAO);
  });

  it("3x é sem juros: o total do pedido é o preço do ciclo", () => {
    expect(tentar(ORG_VALIDACAO, "semiannual", 3, 104900)).toBeNull();
    expect(sql(`select amount_cents from public.billing_orders where organization_id = '${ORG_VALIDACAO}' and status = 'criado';`)).toBe("104900");
    cancelarAbertos(ORG_VALIDACAO);
  });

  it("total errado (também o do preço à vista num 4x) é recusado e nenhum pedido nasce", () => {
    expect(tentar(ORG_VALIDACAO, "semiannual", 4, 104900)).toContain("billing_parcelamento_total_divergente");
    expect(tentar(ORG_VALIDACAO, "semiannual", 4, 110171)).toContain("billing_parcelamento_total_divergente");
    expect(tentar(ORG_VALIDACAO, "semiannual", 4, null)).toContain("billing_parcelamento_total_divergente");
    expect(tentar(ORG_VALIDACAO, "yearly", 12, 189900)).toContain("billing_parcelamento_total_divergente");
    expect(sql(`select count(*) from public.billing_orders where organization_id = '${ORG_VALIDACAO}' and status = 'criado';`)).toBe("0");
  });

  it("à vista com total diferente do preço também é recusado; com o total certo ou sem total segue como antes", () => {
    expect(tentar(ORG_VALIDACAO, "semiannual", 1, 99999)).toContain("billing_parcelamento_total_divergente");
    expect(tentar(ORG_VALIDACAO, "semiannual", 1, 104900)).toBeNull();
    cancelarAbertos(ORG_VALIDACAO);
    expect(tentar(ORG_VALIDACAO, "semiannual", 1, null)).toBeNull();
    expect(sql(`select parcelas from public.billing_orders where organization_id = '${ORG_VALIDACAO}' and status = 'criado';`)).toBe("1");
    cancelarAbertos(ORG_VALIDACAO);
  });

  it("acima do teto do ciclo: semestral 7x e anual 13x são recusados, anual 12x passa", () => {
    expect(tentar(ORG_VALIDACAO, "semiannual", 7, 120000)).toContain("billing_parcelas_acima_do_teto");
    expect(tentar(ORG_VALIDACAO, "yearly", 13, 220000)).toContain("billing_parcelas_invalidas");
    expect(tentar(ORG_VALIDACAO, "yearly", 12, 215352)).toBeNull();
    cancelarAbertos(ORG_VALIDACAO);
  });

  it("parcelas fora de 1 a 12 são recusadas", () => {
    expect(tentar(ORG_VALIDACAO, "yearly", 0, 189900)).toContain("billing_parcelas_invalidas");
    expect(tentar(ORG_VALIDACAO, "yearly", -2, 189900)).toContain("billing_parcelas_invalidas");
  });

  it("o teto vem de billing_settings, não do código: baixando o teto do semestral para 3, o 4x é recusado", () => {
    sql(`update public.billing_settings set parcelamento_max_semestral = 3 where id = 1;`);
    try {
      expect(tentar(ORG_VALIDACAO, "semiannual", 4, 110172)).toContain("billing_parcelas_acima_do_teto");
      expect(tentar(ORG_VALIDACAO, "semiannual", 3, 104900)).toBeNull();
      cancelarAbertos(ORG_VALIDACAO);
    } finally {
      sql(`update public.billing_settings set parcelamento_max_semestral = 6 where id = 1;`);
    }
  });

  it("só no cartão: o Pix parcelado é recusado", () => {
    expect(tentar(ORG_VALIDACAO, "semiannual", 4, 110172, "PIX")).toContain("billing_parcelamento_so_no_cartao");
    expect(tentar(ORG_VALIDACAO, "yearly", 2, 189900, "PIX")).toContain("billing_parcelamento_so_no_cartao");
  });

  it("o mensal e o pacote de tokens não parcelam", () => {
    expect(tentar(ORG_VALIDACAO, "monthly", 2, 20000)).toContain("billing_parcelamento_indisponivel");
    expect(tentar(ORG_VALIDACAO, "monthly", 6, 20000)).toContain("billing_parcelamento_indisponivel");
    expect(tentar(ORG_VALIDACAO, "", 2, 5000, "CREDIT_CARD", "pacote_tokens")).toContain("billing_parcelamento_indisponivel");
  });

  it("a restrição da tabela impede parcelas fora do cartão semestral ou anual, mesmo por escrita direta", () => {
    sql(`select public.fn_billing_criar_pedido('${ORG_VALIDACAO}'::uuid, 'assinatura', 'pro', 'monthly', null, 'CREDIT_CARD', 'sandbox', gen_random_uuid(), null);`);
    expect(erroDe(`update public.billing_orders set parcelas = 3 where organization_id = '${ORG_VALIDACAO}' and status = 'criado';`)).toContain("billing_orders_parcelas_check");
    expect(erroDe(`update public.billing_orders set asaas_installment_id = 'inst_qualquer_coisa' where organization_id = '${ORG_VALIDACAO}' and status = 'criado';`)).toContain("billing_orders_parcelas_check");
    cancelarAbertos(ORG_VALIDACAO);
  });

  it("idempotência: a mesma chave com os mesmos valores devolve o pedido; com outro número de parcelas é recusada", () => {
    const chave = "'0945c000-0000-4000-8000-000000000001'::uuid";
    const pedir = (parcelas: number, total: number) =>
      sql(`select public.fn_billing_criar_pedido('${ORG_IDEMPOTENCIA}'::uuid, 'assinatura', 'pro', 'yearly', null, 'CREDIT_CARD', 'sandbox', ${chave}, null, null, ${parcelas}, ${total});`);
    const primeiro = pedir(4, 199440);
    expect(primeiro).toContain('"ja_existia": false');
    const repetido = pedir(4, 199440);
    expect(repetido).toContain('"ja_existia": true');
    expect(repetido).toContain('"parcelas": 4');
    const totalEm6x = calcularParcelamento(189900, 6, PARAMETROS).totalCents;
    expect(erroDe(`select public.fn_billing_criar_pedido('${ORG_IDEMPOTENCIA}'::uuid, 'assinatura', 'pro', 'yearly', null, 'CREDIT_CARD', 'sandbox', ${chave}, null, null, 6, ${totalEm6x});`)).toContain("billing_chave_com_valores_diferentes");
    expect(erroDe(`select public.fn_billing_criar_pedido('${ORG_IDEMPOTENCIA}'::uuid, 'assinatura', 'pro', 'yearly', null, 'CREDIT_CARD', 'sandbox', ${chave}, null);`)).toContain("billing_chave_com_valores_diferentes");
    expect(sql(`select count(*) from public.billing_orders where organization_id = '${ORG_IDEMPOTENCIA}';`)).toBe("1");
    cancelarAbertos(ORG_IDEMPOTENCIA);
  });
});

describe("0945 item 4: o id do parcelamento no pedido", () => {
  it("grava, repete sem erro, recusa id diferente e formato inválido, e recusa pedido à vista", () => {
    const pedido = pedirParcelado(ORG_REGISTRO, "pro", "yearly", 4, 199440);
    const registrar = (id: string) => sql(`select public.fn_billing_pedido_registrar_parcelamento('${ORG_REGISTRO}'::uuid, '${pedido}'::uuid, '${id}');`);
    expect(registrar(INST(1))).toContain('"ja_registrado": false');
    expect(pedidoCol(pedido, "asaas_installment_id")).toBe(INST(1));
    expect(registrar(INST(1))).toContain('"ja_registrado": true');
    expect(erroDe(`select public.fn_billing_pedido_registrar_parcelamento('${ORG_REGISTRO}'::uuid, '${pedido}'::uuid, '${INST(2)}');`)).toContain("billing_parcelamento_conflito");
    expect(erroDe(`select public.fn_billing_pedido_registrar_parcelamento('${ORG_REGISTRO}'::uuid, '${pedido}'::uuid, 'curto');`)).toContain("billing_asaas_installment_id_formato_invalido");
    cancelarAbertos(ORG_REGISTRO);

    const aVista = sql(`select public.fn_billing_criar_pedido('${ORG_REGISTRO}'::uuid, 'assinatura', 'pro', 'yearly', null, 'CREDIT_CARD', 'sandbox', gen_random_uuid(), null);`);
    const idAVista = (JSON.parse(aVista) as { pedido_id: string }).pedido_id;
    expect(erroDe(`select public.fn_billing_pedido_registrar_parcelamento('${ORG_REGISTRO}'::uuid, '${idAVista}'::uuid, '${INST(3)}');`)).toContain("billing_pedido_nao_e_parcelado");
    cancelarAbertos(ORG_REGISTRO);
  });

  it("pedido de outra organização: não encontrado", () => {
    const pedido = pedirParcelado(ORG_REGISTRO, "pro", "yearly", 2, 189900);
    expect(erroDe(`select public.fn_billing_pedido_registrar_parcelamento('${ORG_IDEMPOTENCIA}'::uuid, '${pedido}'::uuid, '${INST(4)}');`)).toContain("billing_pedido_nao_encontrado");
    cancelarAbertos(ORG_REGISTRO);
  });
});

describe("0945 item 3: as parcelas confirmadas", () => {
  let pedidoSemestral = "";

  it("semestral 4x: a primeira parcela concede o período (6 meses e um dia), as outras só entram em billing_payments", () => {
    pedidoSemestral = pedirParcelado(ORG_SEMESTRAL, "pro", "semiannual", 4, 110172);
    registrarCobrancaEParcelamento(ORG_SEMESTRAL, pedidoSemestral, "pay_i945_s_1", INST(10));

    const resultados = pagarParcelas(ORG_SEMESTRAL, pedidoSemestral, "i945_s", INST(10), "275.43", "1101.72", 4);
    // `pay_i945_s_1` já está em billing_orders.asaas_payment_id, e o resto chega pelo externalReference.
    for (const r of resultados) {
      expect(r).toContain('"resultado": "aplicado"');
      expect(r).not.toContain("divergente_valor");
    }

    expect(pedidoCol(pedidoSemestral, "status")).toBe("pago");
    expect(linhasDe(pedidoSemestral)).toBe("4");
    // Só a primeira tem período; as outras três têm período nulo.
    expect(sql(`select count(*) from public.billing_payments where order_id = '${pedidoSemestral}' and billing_period_end is not null;`)).toBe("1");
    expect(sql(`select billing_period_end is not null from public.billing_payments where asaas_payment_id = 'pay_i945_s_1';`)).toBe("t");
    expect(sql(`select sum(gross_cents) from public.billing_payments where order_id = '${pedidoSemestral}';`)).toBe("110172");
    // O período do contrato é o de seis meses mais o dia (limite exclusivo), concedido uma vez.
    expect(contrato(ORG_SEMESTRAL, `((current_period_end at time zone ${SP})::date = (current_date + interval '6 months')::date + 1)::text`)).toBe("true");
    expect(contrato(ORG_SEMESTRAL, "status || '|' || cycle")).toBe("ativa|semiannual");
    expect(sql(`select count(*) from public.billing_contract_eventos where organization_id = '${ORG_SEMESTRAL}' and tipo = 'periodo' and motivo = 'pay_primeiro_pagamento';`)).toBe("1");
  });

  it("nada renova sozinho: o contrato fica sem assinatura do Asaas, no gateway asaas", () => {
    expect(contrato(ORG_SEMESTRAL, "(asaas_subscription_id is null)::text || '|' || gateway")).toBe("true|asaas");
    expect(pedidoCol(pedidoSemestral, "asaas_subscription_id is null")).toBe("t");
  });

  it("os tokens do plano são concedidos uma vez, não uma por parcela", () => {
    sql(`select public.fn_billing_saldo_da_carteira('${ORG_SEMESTRAL}'::uuid);`);
    expect(sql(`select count(*) from public.billing_token_ledger where organization_id = '${ORG_SEMESTRAL}' and chave = 'plano:' || to_char(${CICLO}, 'YYYY-MM-DD');`)).toBe("1");
  });

  it("reentregar qualquer parcela é idempotente: nada muda no período nem em billing_payments", () => {
    const fim = contrato(ORG_SEMESTRAL, "current_period_end");
    const r = registrarEAplicar("evt-i945_s-2-de-novo", "PAYMENT_CONFIRMED", "pay_i945_s_2", confirmacaoDaParcela("pay_i945_s_2", "275.43", pedidoSemestral, INST(10), "1101.72", 4));
    expect(r).toContain('"resultado": "ja_aplicado"');
    const r1 = registrarEAplicar("evt-i945_s-1-de-novo", "PAYMENT_CONFIRMED", "pay_i945_s_1", confirmacaoDaParcela("pay_i945_s_1", "275.43", pedidoSemestral, INST(10), "1101.72", 4));
    expect(r1).toContain('"resultado": "ja_aplicado"');
    expect(contrato(ORG_SEMESTRAL, "current_period_end")).toBe(fim);
    expect(linhasDe(pedidoSemestral)).toBe("4");
  });

  it("anual 3x sem juros: parcelas de R$ 633,00, total 1.899,00 e período de um ano e um dia", () => {
    const pedido = pedirParcelado(ORG_ANUAL_3X, "pro", "yearly", 3, 189900);
    registrarCobrancaEParcelamento(ORG_ANUAL_3X, pedido, "pay_i945_a_1", INST(11));
    const resultados = pagarParcelas(ORG_ANUAL_3X, pedido, "i945_a", INST(11), "633.00", "1899.00", 3);
    for (const r of resultados) expect(r).toContain('"resultado": "aplicado"');
    expect(pedidoCol(pedido, "status || '|' || amount_cents || '|' || parcelas")).toBe("pago|189900|3");
    expect(contrato(ORG_ANUAL_3X, `((current_period_end at time zone ${SP})::date = (current_date + interval '1 year')::date + 1)::text`)).toBe("true");
  });
});

describe("0945 item 3: a conferência de valor é pelo TOTAL do parcelamento", () => {
  it("o valor de uma parcela, bem abaixo do preço do plano, NÃO é divergente (já provado acima); o total abaixo do pedido é", () => {
    const pedido = pedirParcelado(ORG_CONFERE_TOTAL, "pro", "yearly", 4, 199440);
    registrarCobrancaEParcelamento(ORG_CONFERE_TOTAL, pedido, "pay_i945_c_1", INST(20));
    const r = registrarEAplicar("evt-i945_c-1", "PAYMENT_CONFIRMED", "pay_i945_c_1", confirmacaoDaParcela("pay_i945_c_1", "498.60", pedido, INST(20), "1899.00", 4));
    expect(r).toContain('"resultado": "divergente"');
    expect(sql(`select count(*) from public.billing_payments where asaas_payment_id = 'pay_i945_c_1';`)).toBe("0");
    expect(pedidoCol(pedido, "status")).not.toBe("pago");
    expect(contrato(ORG_CONFERE_TOTAL, "(current_period_end is null or current_period_end < now())::text")).toBe("true");
  });

  it("sem o total do parcelamento (GET não feito) a parcela fica aguardando, sem conceder", () => {
    const pedidoAberto = sql(`select id from public.billing_orders where organization_id = '${ORG_CONFERE_TOTAL}' and status = 'aguardando_pagamento';`);
    const r = registrarEAplicar(
      "evt-i945_c-2",
      "PAYMENT_CONFIRMED",
      "pay_i945_c_2",
      `jsonb_build_object('id','pay_i945_c_2','status','CONFIRMED','value',498.60,'dueDate',${HOJE},'paymentDate',${HOJE},'externalReference','HC:ord:${pedidoAberto}')`,
    );
    expect(r).toContain('"resultado": "aguardando"');
    expect(sql(`select erro_codigo from public.asaas_webhook_events where event_id = 'evt-i945_c-2';`)).toBe("billing_parcelamento_sem_total");
    expect(sql(`select count(*) from public.billing_payments where asaas_payment_id = 'pay_i945_c_2';`)).toBe("0");
  });

  it("parcelamento de outro id ou com número de parcelas diferente do pedido é divergente", () => {
    const pedidoAberto = sql(`select id from public.billing_orders where organization_id = '${ORG_CONFERE_TOTAL}' and status = 'aguardando_pagamento';`);
    const outroId = registrarEAplicar("evt-i945_c-3", "PAYMENT_CONFIRMED", "pay_i945_c_3", confirmacaoDaParcela("pay_i945_c_3", "498.60", pedidoAberto, INST(21), "1994.40", 4));
    expect(outroId).toContain('"resultado": "divergente"');
    expect(outroId).toContain("parcelamento_diferente_do_pedido");
    const outrasParcelas = registrarEAplicar("evt-i945_c-4", "PAYMENT_CONFIRMED", "pay_i945_c_4", confirmacaoDaParcela("pay_i945_c_4", "332.40", pedidoAberto, INST(20), "1994.40", 6));
    expect(outrasParcelas).toContain('"resultado": "divergente"');
    expect(sql(`select count(*) from public.billing_payments where order_id = '${pedidoAberto}';`)).toBe("0");
  });

  it("com o total certo (R$ 1.994,40) a primeira parcela concede e o pedido fecha", () => {
    const pedidoAberto = sql(`select id from public.billing_orders where organization_id = '${ORG_CONFERE_TOTAL}' and status = 'aguardando_pagamento';`);
    const r = registrarEAplicar("evt-i945_c-5", "PAYMENT_CONFIRMED", "pay_i945_c_5", confirmacaoDaParcela("pay_i945_c_5", "498.60", pedidoAberto, INST(20), "1994.40", 4));
    expect(r).toContain('"resultado": "aplicado"');
    expect(r).not.toContain("divergente_valor");
    expect(pedidoCol(pedidoAberto, "status")).toBe("pago");
  });

  it("uma parcela de OUTRO parcelamento chegando depois do pedido pago é divergente, nunca entra no pedido", () => {
    const pedido = sql(`select id from public.billing_orders where organization_id = '${ORG_CONFERE_TOTAL}' and status = 'pago';`);
    const r = registrarEAplicar("evt-i945_c-6", "PAYMENT_CONFIRMED", "pay_i945_c_6", confirmacaoDaParcela("pay_i945_c_6", "498.60", pedido, INST(22), "1994.40", 4));
    expect(r).toContain('"resultado": "divergente"');
    expect(r).toContain("parcela_de_outro_parcelamento");
    expect(sql(`select count(*) from public.billing_payments where asaas_payment_id = 'pay_i945_c_6';`)).toBe("0");
  });
});

describe("0945: o parcelamento empilha como o Pix", () => {
  it("o segundo parcelamento do mesmo plano e ciclo começa no fim do primeiro e dura exatamente seis meses", () => {
    const p1 = pedirParcelado(ORG_EMPILHA, "pro", "semiannual", 2, 104900);
    registrarCobrancaEParcelamento(ORG_EMPILHA, p1, "pay_i945_e1_1", INST(30));
    for (const r of pagarParcelas(ORG_EMPILHA, p1, "i945_e1", INST(30), "524.50", "1049.00", 2)) expect(r).toContain('"resultado": "aplicado"');
    const fim1 = sql(`select billing_period_end from public.billing_payments where asaas_payment_id = 'pay_i945_e1_1';`);

    const p2 = pedirParcelado(ORG_EMPILHA, "pro", "semiannual", 3, 104900);
    registrarCobrancaEParcelamento(ORG_EMPILHA, p2, "pay_i945_e2_1", INST(31));
    for (const r of pagarParcelas(ORG_EMPILHA, p2, "i945_e2", INST(31), "349.67", "1049.00", 3)) expect(r).toContain('"resultado": "aplicado"');

    expect(sql(`select billing_period_start = '${fim1}'::timestamptz from public.billing_payments where asaas_payment_id = 'pay_i945_e2_1';`)).toBe("t");
    expect(sql(`select ((billing_period_end at time zone ${SP})::date = (('${fim1}'::timestamptz at time zone ${SP})::date + interval '6 months')::date)::text from public.billing_payments where asaas_payment_id = 'pay_i945_e2_1';`)).toBe("true");
    expect(contrato(ORG_EMPILHA, "current_period_end = (select billing_period_end from public.billing_payments where asaas_payment_id = 'pay_i945_e2_1')")).toBe("t");
    // Só as primeiras parcelas de cada pedido têm período.
    expect(sql(`select count(*) from public.billing_payments where organization_id = '${ORG_EMPILHA}' and billing_period_end is not null;`)).toBe("2");
  });
});

describe("0945 item 3: estorno de parcela(s)", () => {
  const carteiraDoPlano = (org: string) =>
    sql(`select coalesce(creditado - consumido, 0) from public.billing_token_wallets where organization_id = '${org}' and fonte = 'plano' and ciclo = ${CICLO};`);
  const estornar = (evento: string, pagamento: string, valor: string) =>
    registrarEAplicar(evento, "PAYMENT_REFUNDED", pagamento, confirmacaoDeEstorno(pagamento, valor));

  let pedido = "";

  it("pagas as três parcelas (anual 3x), o contrato fica ativo com os tokens do plano", () => {
    pedido = pedirParcelado(ORG_ESTORNO, "pro", "yearly", 3, 189900);
    registrarCobrancaEParcelamento(ORG_ESTORNO, pedido, "pay_i945_r_1", INST(40));
    for (const r of pagarParcelas(ORG_ESTORNO, pedido, "i945_r", INST(40), "633.00", "1899.00", 3)) expect(r).toContain('"resultado": "aplicado"');
    sql(`select public.fn_billing_saldo_da_carteira('${ORG_ESTORNO}'::uuid);`);
    expect(Number(carteiraDoPlano(ORG_ESTORNO))).toBeGreaterThan(0);
  });

  it("estornar a parcela que concedeu o período (a primeira) só alarma: não corta, não zera tokens, o pedido continua pago", () => {
    const tokens = carteiraDoPlano(ORG_ESTORNO);
    const r = estornar("evt-i945_r-e1", "pay_i945_r_1", "633.00");
    expect(r).toContain('"resultado": "aplicado"');
    expect(r).toContain('"alarme": "estorno_confirmado,estorno_parcial_do_parcelamento"');
    expect(r).not.toContain("estorno_cortou_acesso");
    expect(contrato(ORG_ESTORNO, "status || '|' || cancel_at_period_end")).toBe("ativa|false");
    expect(carteiraDoPlano(ORG_ESTORNO)).toBe(tokens);
    expect(pedidoCol(pedido, "status")).toBe("pago");
    expect(sql(`select count(*) from public.billing_payments where order_id = '${pedido}' and status = 'REFUNDED';`)).toBe("1");
  });

  it("estornar uma parcela de período nulo (a segunda) também só alarma", () => {
    const r = estornar("evt-i945_r-e2", "pay_i945_r_2", "633.00");
    expect(r).toContain('"alarme": "estorno_confirmado,estorno_parcial_do_parcelamento"');
    expect(contrato(ORG_ESTORNO, "status")).toBe("ativa");
    expect(pedidoCol(pedido, "status")).toBe("pago");
  });

  it("reentregar o estorno de uma parcela já estornada é idempotente", () => {
    const r = estornar("evt-i945_r-e2-de-novo", "pay_i945_r_2", "633.00");
    expect(r).toContain('"resultado": "ja_aplicado"');
    expect(sql(`select count(*) from public.billing_payments where order_id = '${pedido}' and status = 'REFUNDED';`)).toBe("2");
  });

  it("estornadas TODAS as parcelas, corta como o estorno total: pedido estornado, contrato cancelado e tokens do mês zerados", () => {
    const r = estornar("evt-i945_r-e3", "pay_i945_r_3", "633.00");
    expect(r).toContain('"resultado": "aplicado"');
    expect(r).toContain('"alarme": "estorno_confirmado,estorno_cortou_acesso"');
    expect(pedidoCol(pedido, "status")).toBe("estornado");
    expect(contrato(ORG_ESTORNO, "status || '|' || cancel_at_period_end || '|' || (current_period_end <= now())")).toBe("cancelada|true|true");
    expect(carteiraDoPlano(ORG_ESTORNO)).toBe("0");
    expect(sql(`select count(*) from public.billing_payments where order_id = '${pedido}' and status = 'REFUNDED';`)).toBe("3");
  });

  it("estornando as parcelas em outra ordem (a última primeiro), o corte só vem na que completa o pedido", () => {
    const p = pedirParcelado(ORG_ESTORNO_ORDEM, "pro", "semiannual", 2, 104900);
    registrarCobrancaEParcelamento(ORG_ESTORNO_ORDEM, p, "pay_i945_o_1", INST(41));
    for (const r of pagarParcelas(ORG_ESTORNO_ORDEM, p, "i945_o", INST(41), "524.50", "1049.00", 2)) expect(r).toContain('"resultado": "aplicado"');

    const primeiro = estornar("evt-i945_o-e2", "pay_i945_o_2", "524.50");
    expect(primeiro).toContain("estorno_parcial_do_parcelamento");
    expect(contrato(ORG_ESTORNO_ORDEM, "status")).toBe("ativa");

    const segundo = estornar("evt-i945_o-e1", "pay_i945_o_1", "524.50");
    expect(segundo).toContain('"alarme": "estorno_confirmado,estorno_cortou_acesso"');
    expect(pedidoCol(p, "status")).toBe("estornado");
    expect(contrato(ORG_ESTORNO_ORDEM, "status")).toBe("cancelada");
  });
});

describe("0945 item 5: parâmetros semeados uma vez", () => {
  it("reaplicar o bloco de DDL e semeadura não desfaz o que o admin mudou", () => {
    const migration = readFileSync(join(process.cwd(), "supabase/migrations/20261007140000_0945_parcelamento_do_semestral_e_do_anual.sql"), "utf8");
    const inicio = migration.indexOf("do $parcelamento_ddl$");
    const fim = migration.indexOf("$parcelamento_ddl$;", inicio + 10) + "$parcelamento_ddl$;".length;
    const bloco = migration.slice(inicio, fim);
    expect(bloco.length).toBeGreaterThan(200);

    sql(`update public.billing_settings set parcelamento_taxa_mensal = 0.0250, parcelamento_max_anual = 9, parcelamento_max_semestral = null where id = 1;`);
    try {
      sql(bloco);
      expect(sql(`select parcelamento_taxa_mensal || '|' || parcelamento_max_anual || '|' || coalesce(parcelamento_max_semestral::text, 'nulo') from public.billing_settings where id = 1;`)).toBe("0.025000|9|nulo");
      // Sem teto do semestral configurado, só o 1x existe.
      expect(tentar(ORG_VALIDACAO, "semiannual", 2, 104900)).toContain("billing_parcelas_acima_do_teto");
    } finally {
      sql(`update public.billing_settings set parcelamento_taxa_mensal = 0.0199, parcelamento_max_anual = 12, parcelamento_max_semestral = 6 where id = 1;`);
    }
  });

  it("os parâmetros fora da faixa são recusados pela restrição da tabela", () => {
    expect(erroDe(`update public.billing_settings set parcelamento_taxa_mensal = 0.5 where id = 1;`)).toContain("billing_settings_parcelamento_check");
    expect(erroDe(`update public.billing_settings set parcelamento_max_anual = 21 where id = 1;`)).toContain("billing_settings_parcelamento_check");
  });
});

describe("0945: forma", () => {
  it("só existe uma fn_billing_criar_pedido (12 parâmetros), e só service_role executa as funções de borda", () => {
    expect(sql(`select count(*) from pg_proc where proname = 'fn_billing_criar_pedido' and pronamespace = 'public'::regnamespace;`)).toBe("1");
    expect(sql(`select pronargs from pg_proc where proname = 'fn_billing_criar_pedido' and pronamespace = 'public'::regnamespace;`)).toBe("12");
    const acl = (nome: string) =>
      sql(`select has_function_privilege('anon', p.oid, 'execute')::text || '|' || has_function_privilege('authenticated', p.oid, 'execute')::text || '|' || has_function_privilege('service_role', p.oid, 'execute')::text from pg_proc p where proname = '${nome}' and pronamespace = 'public'::regnamespace;`);
    expect(acl("fn_billing_criar_pedido")).toBe("false|false|true");
    expect(acl("fn_billing_pedido_registrar_parcelamento")).toBe("false|false|true");
    expect(acl("fn_billing_parcelamento_total")).toBe("false|false|false");
  });
});
