/**
 * D-086 (migration 0916, fork Hiperbold): o estorno TOTAL no Asaas é cancelamento.
 * Decisão do Filipe (30/09/2026): "em caso de estorno, é porque o cliente cancelou, e
 * se cancelou ele precisa não ter acesso e não ter os tokens mais."
 *
 * Aqui se prova o COMPORTAMENTO no banco (baseline aplicado de verdade), pelo mesmo
 * caminho do processador: `fn_billing_asaas_registrar_evento`, reserva com lease e
 * `fn_billing_asaas_aplicar_evento` com o objeto confirmado:
 *
 *   1. assinatura estornada: contrato `cancelada` com fim do período em now() e
 *      eventos com motivo `estorno_asaas`; o marcador de encerramento NÃO é gravado pelo
 *      banco (só depois do DELETE confirmado, pelo processador) e a recompra fica
 *      barrada até lá e LIBERADA depois dele; tokens do plano zerados por lançamento
 *      negativo no livro-caixa (nenhuma linha some); conferidor de carteira sem
 *      divergência;
 *   2. a concessão preguiçosa não devolve o plano no ciclo do corte nem no seguinte
 *      enquanto o contrato estiver cancelado, e volta a conceder depois de um novo
 *      pagamento (no mesmo ciclo, por reconcessão; no seguinte, pela chave normal);
 *   3. pacote estornado retira só os tokens do pacote que ainda restam (saldo nunca
 *      negativo por causa do estorno) e não mexe no contrato;
 *   4. idempotência: o mesmo evento reentregue e um segundo PAYMENT_REFUNDED do mesmo
 *      pagamento não duplicam lançamento nem corte;
 *   5. estorno parcial e chargeback seguem só alarmando, sem cancelar nada;
 *   6. estorno que chega ANTES do pagamento (M2) não retira nem cancela nada (nada foi
 *      concedido), mas ainda pede a remoção da assinatura.
 *
 * Roda via `pnpm test:db tests/invariants/estorno-total-corta-acesso-e-tokens.test.ts`
 * (banco novo por arquivo). Ids fixos com prefixo próprio.
 */
import { describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

const ORG_ASSINATURA = "09160001-a5aa-4000-8000-000000000001";
const ORG_PACOTE_PARCIAL = "09160001-a5aa-4000-8000-000000000002";
const ORG_PACOTE_INTEIRO = "09160001-a5aa-4000-8000-000000000003";
const ORG_PACOTE_GASTO = "09160001-a5aa-4000-8000-000000000004";
const ORG_PARCIAL = "09160001-a5aa-4000-8000-000000000005";
const ORG_CHARGEBACK = "09160001-a5aa-4000-8000-000000000006";
const ORG_M2 = "09160001-a5aa-4000-8000-000000000007";
const ORG_SEM_CONCESSAO = "09160001-a5aa-4000-8000-000000000008";
const ORG_MODO_LEITURA = "09160001-a5aa-4000-8000-000000000009";
const ORG_ANTIGA = "09160001-a5aa-4000-8000-00000000000a";
const ORG_FALHA = "09160001-a5aa-4000-8000-00000000000b";
const ORG_ADICIONAL = "09160001-a5aa-4000-8000-00000000000c";
const ORG_DIVERGENTE = "09160001-a5aa-4000-8000-00000000000d";
const ORG_DIVERGENTE_PACOTE = "09160001-a5aa-4000-8000-00000000000e";

const ORGS = [
  ORG_ASSINATURA, ORG_PACOTE_PARCIAL, ORG_PACOTE_INTEIRO, ORG_PACOTE_GASTO,
  ORG_PARCIAL, ORG_CHARGEBACK, ORG_M2, ORG_SEM_CONCESSAO, ORG_MODO_LEITURA,
  ORG_ANTIGA, ORG_FALHA, ORG_ADICIONAL, ORG_DIVERGENTE, ORG_DIVERGENTE_PACOTE,
];

const CICLO = "public.fn_billing_ciclo_de(now())";
const CICLO_TXT = `to_char(${CICLO}, 'YYYY-MM-DD')`;

function registrarEAplicar(eventId: string, tipo: string, pagamento: string, confirmacao: string): string {
  sql(`select public.fn_billing_asaas_registrar_evento('${eventId}', '${tipo}', '${pagamento}', 'sandbox', 'webhook', '{}'::jsonb);`);
  sql(`select public.fn_billing_asaas_reservar_eventos(50, 300);`);
  const linha = sql(`select id, lease_token from public.asaas_webhook_events where event_id = '${eventId}';`);
  const [id, lease] = linha.split("|");
  expect(id, `evento ${eventId} não foi reservado`).toBeTruthy();
  return sql(`select public.fn_billing_asaas_aplicar_evento('${(id ?? "").trim()}'::uuid, '${(lease ?? "").trim()}'::uuid, ${confirmacao});`);
}

function confirmacaoSql(pagamento: string, status: string, valor: number, extra: string): string {
  return `jsonb_build_object('id','${pagamento}','status','${status}','value',${valor}.00,'dueDate',to_char(current_date,'YYYY-MM-DD')${extra})`;
}

/** Cria o pedido, vincula a cobrança e devolve o id do pedido. */
function abrirPedido(org: string, tipoSql: string, pagamento: string, assinatura: string | null): string {
  sql(`select public.fn_billing_criar_pedido('${org}'::uuid, ${tipoSql}, 'sandbox', gen_random_uuid(), null);`);
  const pedido = sql(`select id from public.billing_orders where organization_id = '${org}' and status = 'criado' order by created_at desc limit 1;`);
  sql(
    `select public.fn_billing_pedido_registrar_cobranca('${org}'::uuid, '${pedido}'::uuid, '${pagamento}', ${assinatura ? `'${assinatura}'` : "null"}, null);`,
  );
  return pedido;
}

const PEDIDO_ASSINATURA = `'assinatura', 'pro', 'monthly', null, 'CREDIT_CARD'`;
const PEDIDO_PACOTE = `'pacote_tokens', null, null, 'i916pacote', 'PIX'`;

function pagarAssinatura(org: string, pagamento: string, assinatura: string, evento: string): string {
  const pedido = abrirPedido(org, PEDIDO_ASSINATURA, pagamento, assinatura);
  const r = registrarEAplicar(
    evento, "PAYMENT_CONFIRMED", pagamento,
    confirmacaoSql(pagamento, "CONFIRMED", 199, `,'subscription','${assinatura}','externalReference','HC:ord:${pedido}'`),
  );
  expect(r).toContain('"resultado": "aplicado"');
  // D-106 (0931): a primeira concessão de um período pago que começou no mês é proporcional aos
  // dias restantes. Estes casos provam o estorno, não a proporção (provada em
  // lote7-conta-e-cobranca-banco.test.ts), então o período pago começa no 1º dia do mês do ciclo.
  sql(`update public.billing_contracts set current_period_start = ${CICLO}::timestamp at time zone 'America/Sao_Paulo'
        where organization_id = '${org}' and current_period_start > ${CICLO}::timestamp at time zone 'America/Sao_Paulo';`);
  return pedido;
}

function pagarPacote(org: string, pagamento: string, evento: string): string {
  const pedido = abrirPedido(org, PEDIDO_PACOTE, pagamento, null);
  const r = registrarEAplicar(
    evento, "PAYMENT_RECEIVED", pagamento,
    confirmacaoSql(pagamento, "RECEIVED", 30, `,'externalReference','HC:ord:${pedido}'`),
  );
  expect(r).toContain('"resultado": "aplicado"');
  return pedido;
}

function estornar(evento: string, pagamento: string, assinatura: string | null): string {
  return registrarEAplicar(
    evento, "PAYMENT_REFUNDED", pagamento,
    confirmacaoSql(pagamento, "REFUNDED", 199, assinatura ? `,'subscription','${assinatura}'` : ""),
  );
}

const contrato = (org: string, colunas: string) =>
  sql(`select ${colunas} from public.billing_contracts where organization_id = '${org}';`);
const carteira = (org: string, fonte: string) =>
  sql(`select coalesce(creditado,0) || '|' || coalesce(consumido,0) from public.billing_token_wallets where organization_id = '${org}' and fonte = '${fonte}' and ciclo ${fonte === "avulso" ? "is null" : `= ${CICLO}`};`);
const linhasDoLivro = (org: string, filtro: string) =>
  Number(sql(`select count(*) from public.billing_token_ledger where organization_id = '${org}' and ${filtro};`));

/** Gasta tokens como o débito gastaria: linha de consumo no livro-caixa e consumido na carteira. */
function gastar(org: string, fonte: "plano" | "avulso", tokens: number) {
  sql(`
    insert into public.billing_token_ledger (organization_id, fonte, tokens, chave, ciclo)
      values ('${org}', '${fonte}', -${tokens}, 'consumo:' || gen_random_uuid()::text || ':${fonte}', ${CICLO});
    update public.billing_token_wallets set consumido = consumido + ${tokens}
      where organization_id = '${org}' and fonte = '${fonte}' and ${fonte === "avulso" ? "ciclo is null" : `ciclo = ${CICLO}`};
  `);
}

describe("D-086: setup", () => {
  it("cria as organizações e liga o necessário", () => {
    sql(`
      ${ORGS.map((id) => `insert into public.organizations (id, slug, legal_name, display_name) values ('${id}', 'i916-${id.slice(-3)}', 'i916 LTDA', 'i916') on conflict (id) do nothing;`).join("\n")}
      select public.fn_billing_definir_compra_pelo_cliente(true, null);
      select public.fn_billing_definir_a_venda('pro', true, null);
      update public.billing_settings set asaas_sandbox_concede = true where id = 1;
      insert into public.billing_token_pacotes (codigo, nome, tokens, preco_cents, ativo)
        values ('i916pacote', 'Pacote de teste 0916', 50000, 3000, true)
        on conflict (codigo) do update set preco_cents = 3000, ativo = true, tokens = 50000;
    `);
    expect(sql(`select count(*) from public.organizations where id = any(array[${ORGS.map((id) => `'${id}'`).join(",")}]::uuid[]);`)).toBe(String(ORGS.length));
  });
});

describe("D-086: estorno total de assinatura", () => {
  const PAG = "pay_i916_001";
  const SUB = "sub_i916_001";
  let pedido = "";
  let livroAntes = 0;

  it("antes do estorno: contrato Pro ativo e os 3 milhões do plano concedidos na primeira leitura", () => {
    pedido = pagarAssinatura(ORG_ASSINATURA, PAG, SUB, "evt-i916-001a");
    expect(contrato(ORG_ASSINATURA, "status || '|' || cancel_at_period_end || '|' || (asaas_subscription_id = '" + SUB + "')")).toBe("ativa|false|true");
    sql(`select public.fn_billing_saldo_da_carteira('${ORG_ASSINATURA}'::uuid);`);
    expect(carteira(ORG_ASSINATURA, "plano")).toBe("3000000|0");
    gastar(ORG_ASSINATURA, "plano", 1000);
    expect(carteira(ORG_ASSINATURA, "plano")).toBe("3000000|1000");
    livroAntes = linhasDoLivro(ORG_ASSINATURA, "true");
  });

  it("o estorno total cancela o contrato na hora, com os alarmes de corte e de remoção da assinatura", () => {
    const r = estornar("evt-i916-001b", PAG, SUB);
    expect(r).toContain('"resultado": "aplicado"');
    expect(r).toContain('"alarme": "estorno_confirmado,estorno_cortou_acesso,remover_assinatura_pendente"');

    expect(contrato(ORG_ASSINATURA, "status || '|' || cancel_at_period_end || '|' || (current_period_end <= now())")).toBe("cancelada|true|true");
    expect(sql(`select status from public.billing_orders where id = '${pedido}';`)).toBe("estornado");
    const eventos = sql(`select tipo || ':' || de || '>' || para from public.billing_contract_eventos where organization_id = '${ORG_ASSINATURA}' and motivo = 'estorno_asaas' order by tipo;`);
    expect(eventos).toContain("estado:ativa>cancelada");
    expect(eventos).toContain("cancelar_no_fim:false>true");
    expect(eventos).toMatch(/periodo:/);
  });

  it("o banco NÃO grava o marcador: a recompra fica barrada até o DELETE no Asaas ser confirmado", () => {
    expect(contrato(ORG_ASSINATURA, "asaas_assinatura_encerrada_em is null")).toBe("t");
    const erro = (() => {
      try {
        sql(`select public.fn_billing_criar_pedido('${ORG_ASSINATURA}'::uuid, ${PEDIDO_ASSINATURA}, 'sandbox', gen_random_uuid(), null);`);
        return null;
      } catch (err) {
        return motivoDoErro(err);
      }
    })();
    expect(erro, "recomprou com a assinatura velha ainda viva").not.toBeNull();
    expect(erro).toContain("billing_ja_tem_assinatura_asaas");
  });

  it("depois do marcador (o que o processador grava após o DELETE confirmado), a recompra é liberada", () => {
    sql(`select public.fn_billing_asaas_marcar_assinatura_encerrada('${ORG_ASSINATURA}'::uuid, '${SUB}', null);`);
    expect(contrato(ORG_ASSINATURA, "asaas_assinatura_encerrada_em is not null")).toBe("t");
    // A trava da recompra (0909) deixa de recusar: nasce um pedido novo.
    sql(`select public.fn_billing_criar_pedido('${ORG_ASSINATURA}'::uuid, ${PEDIDO_ASSINATURA}, 'sandbox', gen_random_uuid(), null);`);
    expect(sql(`select count(*) from public.billing_orders where organization_id = '${ORG_ASSINATURA}' and status = 'criado';`)).toBe("1");
  });

  it("os tokens do plano foram zerados por lançamento NEGATIVO; nenhuma linha do livro-caixa sumiu", () => {
    expect(carteira(ORG_ASSINATURA, "plano")).toBe("1000|1000");
    expect(sql(`select tokens from public.billing_token_ledger where organization_id = '${ORG_ASSINATURA}' and chave = 'ajuste:estorno-plano:' || ${CICLO_TXT} || ':1';`)).toBe("-2999000");
    expect(sql(`select nota from public.billing_token_ledger where organization_id = '${ORG_ASSINATURA}' and chave like 'ajuste:estorno-plano:%';`)).toContain(PAG);
    expect(linhasDoLivro(ORG_ASSINATURA, "true")).toBe(livroAntes + 1);
    expect(sql(`select count(*) from public.billing_token_ledger where organization_id = '${ORG_ASSINATURA}' and chave = 'plano:' || ${CICLO_TXT};`)).toBe("1");
    // O conferidor recalcula do livro-caixa e não acha divergência: o lançamento é um ajuste que ele soma.
    expect(sql(`select public.fn_billing_conferir_carteira('${ORG_ASSINATURA}'::uuid);`)).toBe("0");
    expect(carteira(ORG_ASSINATURA, "plano")).toBe("1000|1000");
  });

  it("a concessão preguiçosa NÃO devolve o plano: nem no ciclo do corte, nem no seguinte, com o contrato cancelado", () => {
    sql(`select public.fn_billing_saldo_da_carteira('${ORG_ASSINATURA}'::uuid);`);
    sql(`select public.fn_billing_garantir_concessoes('${ORG_ASSINATURA}'::uuid, ${CICLO});`);
    expect(carteira(ORG_ASSINATURA, "plano")).toBe("1000|1000");
    expect(linhasDoLivro(ORG_ASSINATURA, "chave like 'ajuste:reconcessao-plano:%'")).toBe(0);

    sql(`select public.fn_billing_garantir_concessoes('${ORG_ASSINATURA}'::uuid, (${CICLO} + interval '1 month')::date);`);
    expect(linhasDoLivro(ORG_ASSINATURA, `chave = 'plano:' || to_char((${CICLO} + interval '1 month')::date, 'YYYY-MM-DD')`)).toBe(0);
    expect(sql(`select count(*) from public.billing_token_wallets where organization_id = '${ORG_ASSINATURA}' and fonte = 'plano' and ciclo = (${CICLO} + interval '1 month')::date;`)).toBe("0");
  });

  it("idempotência: o MESMO evento reentregue não cria evento novo e um segundo PAYMENT_REFUNDED do mesmo pagamento é ja_aplicado", () => {
    const reentrega = sql(`select public.fn_billing_asaas_registrar_evento('evt-i916-001b', 'PAYMENT_REFUNDED', '${PAG}', 'sandbox', 'webhook', '{}'::jsonb);`);
    expect(reentrega).toContain('"novo": false');

    const segundo = estornar("evt-i916-001c", PAG, SUB);
    expect(segundo).toContain('"resultado": "ja_aplicado"');
    expect(segundo).not.toContain("remover_assinatura_pendente");

    expect(sql(`select count(*) from public.billing_payments where organization_id = '${ORG_ASSINATURA}' and status = 'REFUNDED';`)).toBe("1");
    expect(linhasDoLivro(ORG_ASSINATURA, "chave like 'ajuste:estorno-plano:%'")).toBe(1);
    expect(linhasDoLivro(ORG_ASSINATURA, "true")).toBe(livroAntes + 1);
    expect(carteira(ORG_ASSINATURA, "plano")).toBe("1000|1000");
    expect(sql(`select count(*) from public.billing_contract_eventos where organization_id = '${ORG_ASSINATURA}' and motivo = 'estorno_asaas' and tipo = 'estado';`)).toBe("1");
  });

  it("um NOVO pagamento reativa o contrato e a concessão volta: no mesmo ciclo por reconcessão, no seguinte pela chave normal", () => {
    // O pedido aberto do teste da recompra ainda existe e serve para o novo pagamento.
    const pedidoNovo = sql(`select id from public.billing_orders where organization_id = '${ORG_ASSINATURA}' and status = 'criado';`);
    sql(`select public.fn_billing_pedido_registrar_cobranca('${ORG_ASSINATURA}'::uuid, '${pedidoNovo}'::uuid, 'pay_i916_001n', 'sub_i916_001n', null);`);
    const r = registrarEAplicar(
      "evt-i916-001d", "PAYMENT_CONFIRMED", "pay_i916_001n",
      confirmacaoSql("pay_i916_001n", "CONFIRMED", 199, `,'subscription','sub_i916_001n','externalReference','HC:ord:${pedidoNovo}'`),
    );
    expect(r).toContain('"resultado": "aplicado"');
    expect(contrato(ORG_ASSINATURA, "status")).toBe("ativa");

    sql(`select public.fn_billing_saldo_da_carteira('${ORG_ASSINATURA}'::uuid);`);
    expect(carteira(ORG_ASSINATURA, "plano")).toBe("3001000|1000");
    expect(linhasDoLivro(ORG_ASSINATURA, `chave = 'ajuste:reconcessao-plano:' || ${CICLO_TXT} || ':1'`)).toBe(1);

    // Idempotente: ler de novo não concede de novo.
    sql(`select public.fn_billing_saldo_da_carteira('${ORG_ASSINATURA}'::uuid);`);
    sql(`select public.fn_billing_garantir_concessoes('${ORG_ASSINATURA}'::uuid, ${CICLO});`);
    expect(carteira(ORG_ASSINATURA, "plano")).toBe("3001000|1000");
    expect(sql(`select public.fn_billing_conferir_carteira('${ORG_ASSINATURA}'::uuid);`)).toBe("0");

    // Ciclo seguinte, contrato ativo: a chave normal concede.
    sql(`select public.fn_billing_garantir_concessoes('${ORG_ASSINATURA}'::uuid, (${CICLO} + interval '1 month')::date);`);
    expect(linhasDoLivro(ORG_ASSINATURA, `chave = 'plano:' || to_char((${CICLO} + interval '1 month')::date, 'YYYY-MM-DD')`)).toBe(1);
  });
});

describe("D-086: estorno total de pacote de tokens", () => {
  it("pacote com tokens ainda sobrando: saem só os que restam do pacote, o contrato não muda", () => {
    const pedido = pagarPacote(ORG_PACOTE_PARCIAL, "pay_i916_002", "evt-i916-002a");
    expect(carteira(ORG_PACOTE_PARCIAL, "avulso")).toBe("50000|0");
    gastar(ORG_PACOTE_PARCIAL, "avulso", 20000);
    const contratoAntes = contrato(ORG_PACOTE_PARCIAL, "status || '|' || plan_id || '|' || current_period_end::text");

    const r = estornar("evt-i916-002b", "pay_i916_002", null);
    expect(r).toContain('"alarme": "estorno_confirmado,estorno_removeu_tokens_do_pacote"');
    expect(sql(`select tokens from public.billing_token_ledger where organization_id = '${ORG_PACOTE_PARCIAL}' and chave = 'ajuste:estorno:${pedido}';`)).toBe("-30000");
    expect(carteira(ORG_PACOTE_PARCIAL, "avulso")).toBe("20000|20000");
    expect(contrato(ORG_PACOTE_PARCIAL, "status || '|' || plan_id || '|' || current_period_end::text")).toBe(contratoAntes);
    expect(sql(`select status from public.billing_orders where id = '${pedido}';`)).toBe("estornado");
    expect(sql(`select public.fn_billing_conferir_carteira('${ORG_PACOTE_PARCIAL}'::uuid);`)).toBe("0");
    // nada é apagado: a linha de crédito do pacote continua lá.
    expect(linhasDoLivro(ORG_PACOTE_PARCIAL, `chave = 'credito:${pedido}'`)).toBe(1);

    // idempotência: segundo PAYMENT_REFUNDED e reentrega não retiram de novo.
    const segundo = estornar("evt-i916-002c", "pay_i916_002", null);
    expect(segundo).toContain('"resultado": "ja_aplicado"');
    expect(carteira(ORG_PACOTE_PARCIAL, "avulso")).toBe("20000|20000");
    expect(linhasDoLivro(ORG_PACOTE_PARCIAL, "chave like 'ajuste:estorno:%'")).toBe(1);
  });

  it("pacote intacto: saem todos os tokens dele, e o saldo fica em zero, não negativo", () => {
    pagarPacote(ORG_PACOTE_INTEIRO, "pay_i916_003", "evt-i916-003a");
    estornar("evt-i916-003b", "pay_i916_003", null);
    expect(carteira(ORG_PACOTE_INTEIRO, "avulso")).toBe("0|0");
  });

  it("pacote já todo gasto: nada sai, o saldo não fica negativo por causa do estorno", () => {
    const pedido = pagarPacote(ORG_PACOTE_GASTO, "pay_i916_004", "evt-i916-004a");
    gastar(ORG_PACOTE_GASTO, "avulso", 50000);
    const r = estornar("evt-i916-004b", "pay_i916_004", null);
    expect(r).toContain("estorno_removeu_tokens_do_pacote");
    expect(sql(`select tokens from public.billing_token_ledger where organization_id = '${ORG_PACOTE_GASTO}' and chave = 'ajuste:estorno:${pedido}';`)).toBe("0");
    expect(carteira(ORG_PACOTE_GASTO, "avulso")).toBe("50000|50000");
    expect(sql(`select status from public.billing_orders where id = '${pedido}';`)).toBe("estornado");
  });
});

describe("D-086: o que NÃO corta", () => {
  it("estorno parcial só alarma: contrato ativo e tokens intactos", () => {
    pagarAssinatura(ORG_PARCIAL, "pay_i916_005", "sub_i916_005", "evt-i916-005a");
    sql(`select public.fn_billing_saldo_da_carteira('${ORG_PARCIAL}'::uuid);`);
    const r = registrarEAplicar(
      "evt-i916-005b", "PAYMENT_PARTIALLY_REFUNDED", "pay_i916_005",
      confirmacaoSql("pay_i916_005", "RECEIVED", 199, `,'subscription','sub_i916_005'`),
    );
    expect(r).toContain('"alarme": "parcialmente_estornado"');
    expect(contrato(ORG_PARCIAL, "status || '|' || cancel_at_period_end")).toBe("ativa|false");
    expect(carteira(ORG_PARCIAL, "plano")).toBe("3000000|0");
    expect(linhasDoLivro(ORG_PARCIAL, "chave like 'ajuste:%'")).toBe(0);
  });

  it("chargeback só alarma: contrato ativo, tokens intactos, nenhuma remoção pedida", () => {
    pagarAssinatura(ORG_CHARGEBACK, "pay_i916_006", "sub_i916_006", "evt-i916-006a");
    sql(`select public.fn_billing_saldo_da_carteira('${ORG_CHARGEBACK}'::uuid);`);
    const r = registrarEAplicar(
      "evt-i916-006b", "PAYMENT_CHARGEBACK_REQUESTED", "pay_i916_006",
      confirmacaoSql("pay_i916_006", "CHARGEBACK_REQUESTED", 199, `,'subscription','sub_i916_006'`),
    );
    expect(r).toContain('"alarme": "chargeback_confirmado"');
    expect(r).not.toContain("remover_assinatura_pendente");
    expect(contrato(ORG_CHARGEBACK, "status || '|' || cancel_at_period_end")).toBe("ativa|false");
    expect(carteira(ORG_CHARGEBACK, "plano")).toBe("3000000|0");
  });
});

describe("D-086: estorno que chega antes do pagamento (M2) e cobrança sem concessão no ciclo", () => {
  it("M2: nada foi concedido, então nada é cancelado nem retirado; a assinatura ainda é pedida para remoção; o pagamento que chega depois é ja_aplicado", () => {
    const pedido = abrirPedido(ORG_M2, PEDIDO_ASSINATURA, "pay_i916_007", "sub_i916_007");
    const r = registrarEAplicar(
      "evt-i916-007a", "PAYMENT_REFUNDED", "pay_i916_007",
      confirmacaoSql("pay_i916_007", "REFUNDED", 199, `,'subscription','sub_i916_007','externalReference','HC:ord:${pedido}'`),
    );
    expect(r).toContain('"alarme": "estorno_confirmado,remover_assinatura_pendente"');
    expect(r).not.toContain("estorno_cortou_acesso");
    expect(contrato(ORG_M2, "status || '|' || (asaas_subscription_id is null)")).toBe("ativa|true");
    expect(sql(`select count(*) from public.billing_token_ledger where organization_id = '${ORG_M2}';`)).toBe("0");

    const depois = registrarEAplicar(
      "evt-i916-007b", "PAYMENT_CONFIRMED", "pay_i916_007",
      confirmacaoSql("pay_i916_007", "CONFIRMED", 199, `,'subscription','sub_i916_007','externalReference','HC:ord:${pedido}'`),
    );
    expect(depois).toContain("ja_aplicado");
    expect(contrato(ORG_M2, "asaas_subscription_id is null")).toBe("t");
  });

  it("estorno de assinatura sem o plano ter sido concedido no ciclo: cancela, não cria lançamento de corte, e o pagamento seguinte concede pela chave normal", () => {
    pagarAssinatura(ORG_SEM_CONCESSAO, "pay_i916_008", "sub_i916_008", "evt-i916-008a");
    // Nenhuma leitura de saldo ainda: a concessão preguiçosa não rodou neste ciclo.
    expect(sql(`select count(*) from public.billing_token_ledger where organization_id = '${ORG_SEM_CONCESSAO}';`)).toBe("0");

    const r = estornar("evt-i916-008b", "pay_i916_008", "sub_i916_008");
    expect(r).toContain("estorno_cortou_acesso");
    expect(contrato(ORG_SEM_CONCESSAO, "status")).toBe("cancelada");
    expect(sql(`select count(*) from public.billing_token_ledger where organization_id = '${ORG_SEM_CONCESSAO}';`)).toBe("0");

    sql(`select public.fn_billing_saldo_da_carteira('${ORG_SEM_CONCESSAO}'::uuid);`);
    expect(sql(`select count(*) from public.billing_token_ledger where organization_id = '${ORG_SEM_CONCESSAO}';`)).toBe("0");

    sql(`select public.fn_billing_asaas_marcar_assinatura_encerrada('${ORG_SEM_CONCESSAO}'::uuid, 'sub_i916_008', null);`);
    sql(`select public.fn_billing_criar_pedido('${ORG_SEM_CONCESSAO}'::uuid, ${PEDIDO_ASSINATURA}, 'sandbox', gen_random_uuid(), null);`);
    const pedidoNovo = sql(`select id from public.billing_orders where organization_id = '${ORG_SEM_CONCESSAO}' and status = 'criado';`);
    sql(`select public.fn_billing_pedido_registrar_cobranca('${ORG_SEM_CONCESSAO}'::uuid, '${pedidoNovo}'::uuid, 'pay_i916_008n', 'sub_i916_008n', null);`);
    registrarEAplicar(
      "evt-i916-008c", "PAYMENT_CONFIRMED", "pay_i916_008n",
      confirmacaoSql("pay_i916_008n", "CONFIRMED", 199, `,'subscription','sub_i916_008n','externalReference','HC:ord:${pedidoNovo}'`),
    );
    // D-106 (0931): como em pagarAssinatura, o período pago começa no 1º dia do mês do ciclo.
    sql(`update public.billing_contracts set current_period_start = ${CICLO}::timestamp at time zone 'America/Sao_Paulo'
          where organization_id = '${ORG_SEM_CONCESSAO}' and current_period_start > ${CICLO}::timestamp at time zone 'America/Sao_Paulo';`);
    sql(`select public.fn_billing_saldo_da_carteira('${ORG_SEM_CONCESSAO}'::uuid);`);
    expect(carteira(ORG_SEM_CONCESSAO, "plano")).toBe("3000000|0");
    expect(linhasDoLivro(ORG_SEM_CONCESSAO, "chave like 'ajuste:reconcessao-plano:%'")).toBe(0);
  });
});

describe("D-086 A1: estorno total de cobrança ANTIGA não cancela o período pago por outra cobrança", () => {
  const SUB = "sub_i916_010";

  /** Pagamento de assinatura com vencimento relativo a hoje (em dias), sem pedido quando `pedido` é null. */
  function pagar(org: string, pagamento: string, evento: string, dias: number, pedido: string | null): string {
    const extra = `,'subscription','${SUB}'${pedido ? `,'externalReference','HC:ord:${pedido}'` : ""}`;
    return registrarEAplicar(
      evento, "PAYMENT_CONFIRMED", pagamento,
      `jsonb_build_object('id','${pagamento}','status','CONFIRMED','value',199.00,'dueDate',to_char(current_date + ${dias},'YYYY-MM-DD')${extra})`,
    );
  }

  it("P1 (vencida há 20 dias, o período dela ainda cobre hoje) estornada com P2 já paga: só alarma, não cancela, não remove a assinatura, não mexe nos tokens", () => {
    const pedido = abrirPedido(ORG_ANTIGA, PEDIDO_ASSINATURA, "pay_i916_010a", SUB);
    expect(pagar(ORG_ANTIGA, "pay_i916_010a", "evt-i916-010a", -20, pedido)).toContain('"resultado": "aplicado"');
    // P2: a renovação do mês seguinte, da mesma assinatura, sem pedido.
    expect(pagar(ORG_ANTIGA, "pay_i916_010b", "evt-i916-010b", 10, null)).toContain('"resultado": "aplicado"');
    sql(`select public.fn_billing_saldo_da_carteira('${ORG_ANTIGA}'::uuid);`);
    const fimAntes = contrato(ORG_ANTIGA, "current_period_end::text");
    const tokensAntes = carteira(ORG_ANTIGA, "plano");
    const livroAntes = linhasDoLivro(ORG_ANTIGA, "true");

    const r = estornar("evt-i916-010c", "pay_i916_010a", SUB);
    expect(r).toContain('"resultado": "aplicado"');
    expect(r).toContain('"alarme": "estorno_confirmado,estorno_de_periodo_antigo"');
    expect(r).not.toContain("remover_assinatura_pendente");
    expect(r).not.toContain("estorno_cortou_acesso");

    // O período que o cliente pagou com P2 continua inteiro.
    expect(contrato(ORG_ANTIGA, "status || '|' || cancel_at_period_end || '|' || (asaas_assinatura_encerrada_em is null)")).toBe("ativa|false|true");
    expect(contrato(ORG_ANTIGA, "current_period_end::text")).toBe(fimAntes);
    expect(carteira(ORG_ANTIGA, "plano")).toBe(tokensAntes);
    expect(linhasDoLivro(ORG_ANTIGA, "true")).toBe(livroAntes);
    expect(sql(`select count(*) from public.billing_contract_eventos where organization_id = '${ORG_ANTIGA}' and motivo = 'estorno_asaas';`)).toBe("0");
    // O estorno fica registrado mesmo assim.
    expect(sql(`select count(*) from public.billing_payments where organization_id = '${ORG_ANTIGA}' and status = 'REFUNDED';`)).toBe("1");
  });

  it("depois, o estorno total da cobrança do período VIGENTE (P2) corta normalmente", () => {
    const r = estornar("evt-i916-010d", "pay_i916_010b", SUB);
    expect(r).toContain('"alarme": "estorno_confirmado,estorno_cortou_acesso,remover_assinatura_pendente"');
    expect(contrato(ORG_ANTIGA, "status")).toBe("cancelada");
  });
});

describe("D-086 M1: o corte que falha não some: o alarme e o pedido de remoção da assinatura continuam", () => {
  it("falha inesperada no corte: o estorno fica registrado, o alarme é estorno_corte_falhou com remover_assinatura_pendente, e o contrato continua como estava", () => {
    pagarAssinatura(ORG_FALHA, "pay_i916_011", "sub_i916_011", "evt-i916-011a");
    sql(`
      create or replace function public.i916_falha_no_corte() returns trigger language plpgsql as $$
      begin
        raise exception 'falha simulada no corte';
      end;
      $$;
      create trigger i916_falha_no_corte before update on public.billing_contracts
        for each row when (new.status = 'cancelada' and new.organization_id = '${ORG_FALHA}')
        execute function public.i916_falha_no_corte();
    `);
    try {
      const r = estornar("evt-i916-011b", "pay_i916_011", "sub_i916_011");
      expect(r).toContain('"resultado": "aplicado"');
      expect(r).toContain('"alarme": "estorno_confirmado,estorno_corte_falhou,remover_assinatura_pendente"');
      expect(sql(`select count(*) from public.billing_payments where organization_id = '${ORG_FALHA}' and status = 'REFUNDED';`)).toBe("1");
      expect(contrato(ORG_FALHA, "status")).toBe("ativa");
    } finally {
      sql(`drop trigger if exists i916_falha_no_corte on public.billing_contracts; drop function if exists public.i916_falha_no_corte();`);
    }
  });
});

describe("D-086 M4: conta cancelada também não recebe os adicionais", () => {
  it("cancelada: o ciclo seguinte não concede adicional nem plano; com o novo pagamento os dois voltam", () => {
    pagarAssinatura(ORG_ADICIONAL, "pay_i916_012", "sub_i916_012", "evt-i916-012a");
    sql(`select public.fn_billing_contratar_adicional('${ORG_ADICIONAL}'::uuid, 1000, gen_random_uuid(), null, 'adicional do teste 0916', null);`);
    const PROXIMO = `(${CICLO} + interval '1 month')::date`;
    const doProximo = (padrao: string) =>
      sql(`select count(*) from public.billing_token_ledger where organization_id = '${ORG_ADICIONAL}' and chave like '${padrao}' || to_char(${PROXIMO}, 'YYYY-MM-DD');`);

    estornar("evt-i916-012b", "pay_i916_012", "sub_i916_012");
    expect(contrato(ORG_ADICIONAL, "status")).toBe("cancelada");

    sql(`select public.fn_billing_garantir_concessoes('${ORG_ADICIONAL}'::uuid, ${PROXIMO});`);
    expect(doProximo("adicional:%:")).toBe("0");
    expect(doProximo("plano:")).toBe("0");
    expect(sql(`select count(*) from public.billing_token_wallets where organization_id = '${ORG_ADICIONAL}' and ciclo = ${PROXIMO};`)).toBe("0");

    // Novo pagamento: reativa o contrato, e a concessão do ciclo seguinte traz o adicional e o plano.
    sql(`select public.fn_billing_asaas_marcar_assinatura_encerrada('${ORG_ADICIONAL}'::uuid, 'sub_i916_012', null);`);
    pagarAssinatura(ORG_ADICIONAL, "pay_i916_012n", "sub_i916_012n", "evt-i916-012c");
    expect(contrato(ORG_ADICIONAL, "status")).toBe("ativa");
    sql(`select public.fn_billing_garantir_concessoes('${ORG_ADICIONAL}'::uuid, ${PROXIMO});`);
    expect(doProximo("adicional:%:")).toBe("1");
    expect(doProximo("plano:")).toBe("1");
  });
});

describe("D-086 B3: a quantidade retirada vem do livro-caixa, com a carteira divergente nunca sai creditado negativo", () => {
  it("plano: carteira dizendo 100 e livro dizendo 3 milhões: sai o saldo do LIVRO e a carteira é realinhada, sem creditado negativo", () => {
    pagarAssinatura(ORG_DIVERGENTE, "pay_i916_013", "sub_i916_013", "evt-i916-013a");
    sql(`select public.fn_billing_saldo_da_carteira('${ORG_DIVERGENTE}'::uuid);`);
    sql(`update public.billing_token_wallets set creditado = 100 where organization_id = '${ORG_DIVERGENTE}' and fonte = 'plano' and ciclo = ${CICLO};`);

    estornar("evt-i916-013b", "pay_i916_013", "sub_i916_013");

    expect(sql(`select tokens from public.billing_token_ledger where organization_id = '${ORG_DIVERGENTE}' and chave = 'ajuste:estorno-plano:' || ${CICLO_TXT} || ':1';`)).toBe("-3000000");
    expect(carteira(ORG_DIVERGENTE, "plano")).toBe("0|0");
    expect(sql(`select public.fn_billing_conferir_carteira('${ORG_DIVERGENTE}'::uuid);`)).toBe("0");
  });

  it("pacote: carteira avulsa dizendo 10 e livro dizendo 50000: saem os 50000 do livro, a carteira vai a zero e nunca negativa", () => {
    pagarPacote(ORG_DIVERGENTE_PACOTE, "pay_i916_014", "evt-i916-014a");
    sql(`update public.billing_token_wallets set creditado = 10 where organization_id = '${ORG_DIVERGENTE_PACOTE}' and fonte = 'avulso' and ciclo is null;`);

    estornar("evt-i916-014b", "pay_i916_014", null);

    expect(carteira(ORG_DIVERGENTE_PACOTE, "avulso")).toBe("0|0");
    expect(sql(`select public.fn_billing_conferir_carteira('${ORG_DIVERGENTE_PACOTE}'::uuid);`)).toBe("0");
  });
});

describe("D-086: a conta estornada fica sem acesso na hora (modo leitura, carência zerada)", () => {
  it("com a plataforma em bloquear e uma carência ainda no futuro, o estorno total antecipa a carência para now() e fn_billing_modo_leitura vale na hora", () => {
    pagarAssinatura(ORG_MODO_LEITURA, "pay_i916_009", "sub_i916_009", "evt-i916-009a");
    // Liga o bloqueio: toda organização sem carência ganha N dias de carência a partir de agora.
    sql(`select public.fn_billing_definir_modo('bloquear', null);`);
    expect(contrato(ORG_MODO_LEITURA, "bloqueio_a_partir_de > now()")).toBe("t");
    expect(sql(`select public.fn_billing_modo_leitura('${ORG_MODO_LEITURA}'::uuid);`)).toBe("f");

    // Prova de que o contrato cancelado SOZINHO não bastaria: sem o estorno, a carência futura mantém o acesso.
    const r = estornar("evt-i916-009b", "pay_i916_009", "sub_i916_009");
    expect(r).toContain("estorno_cortou_acesso");

    expect(contrato(ORG_MODO_LEITURA, "status || '|' || (bloqueio_a_partir_de <= now())")).toBe("cancelada|true");
    expect(sql(`select public.fn_billing_modo_leitura('${ORG_MODO_LEITURA}'::uuid);`)).toBe("t");
    expect(sql(`select de is not null || '|' || (para::timestamptz <= now()) from public.billing_contract_eventos where organization_id = '${ORG_MODO_LEITURA}' and tipo = 'carencia' and motivo = 'estorno_asaas';`)).toBe("true|true");

    // Com o modo leitura, a criação de funil é recusada (PT402, assinatura_suspensa), o mesmo efeito de conta suspensa.
    let erro: string | null = null;
    try {
      sql(`insert into public.crm_pipelines (organization_id, name, slug) values ('${ORG_MODO_LEITURA}', 'funil depois do estorno', 'funil-depois-estorno');`);
    } catch (err) {
      erro = motivoDoErro(err);
    }
    expect(erro, "conta estornada ainda criou funil").not.toBeNull();
    expect(erro).toContain("assinatura_suspensa");
  });

  it("B6: um novo pagamento reativa a conta e devolve a carência de conta normal (agora + carencia_dias), em vez de deixar a do estorno no passado", () => {
    sql(`select public.fn_billing_asaas_marcar_assinatura_encerrada('${ORG_MODO_LEITURA}'::uuid, 'sub_i916_009', null);`);
    expect(sql(`select public.fn_billing_modo_leitura('${ORG_MODO_LEITURA}'::uuid);`)).toBe("t");

    pagarAssinatura(ORG_MODO_LEITURA, "pay_i916_009n", "sub_i916_009n", "evt-i916-009c");

    expect(contrato(ORG_MODO_LEITURA, "status")).toBe("ativa");
    expect(contrato(ORG_MODO_LEITURA, "bloqueio_a_partir_de > now()")).toBe("t");
    expect(sql(`select public.fn_billing_modo_leitura('${ORG_MODO_LEITURA}'::uuid);`)).toBe("f");
    const dias = sql(`select round(extract(epoch from (bloqueio_a_partir_de - now())) / 86400) from public.billing_contracts where organization_id = '${ORG_MODO_LEITURA}';`);
    expect(dias).toBe(sql(`select carencia_dias from public.billing_settings where id = 1;`));
    expect(sql(`select count(*) from public.billing_contract_eventos where organization_id = '${ORG_MODO_LEITURA}' and tipo = 'carencia' and motivo = 'reativacao_por_pagamento';`)).toBe("1");
  });

  it("B6: conta que NUNCA foi estornada não tem a carência mexida por um pagamento", () => {
    const antes = contrato(ORG_PARCIAL, "coalesce(bloqueio_a_partir_de::text, 'nula')");
    // um pagamento de renovação qualquer da mesma assinatura (sem pedido) não toca na carência.
    registrarEAplicar(
      "evt-i916-005c", "PAYMENT_CONFIRMED", "pay_i916_005r",
      confirmacaoSql("pay_i916_005r", "CONFIRMED", 199, `,'subscription','sub_i916_005'`),
    );
    expect(contrato(ORG_PARCIAL, "coalesce(bloqueio_a_partir_de::text, 'nula')")).toBe(antes);
    expect(sql(`select count(*) from public.billing_contract_eventos where organization_id = '${ORG_PARCIAL}' and motivo = 'reativacao_por_pagamento';`)).toBe("0");
  });

  it("conta estornada e NÃO reativada: ligar o bloqueio depois não lhe dá carência nova (a carência zerada no corte fica no passado)", () => {
    // ORG_ANTIGA foi cortada com o modo ainda desligado (carência nula): ganhou now() no corte, e
    // fn_billing_definir_modo('bloquear') só dá carência a quem tem a coluna nula.
    expect(contrato(ORG_ANTIGA, "status || '|' || (bloqueio_a_partir_de <= now())")).toBe("cancelada|true");
  });

  it("conta reativada com a plataforma FORA de bloquear volta sem carência, e o bloqueio ligado depois lhe dá a de conta nova", () => {
    // ORG_SEM_CONCESSAO foi estornada e reativada com o modo desligado: a carência foi apagada na
    // reativação (evento registrado) e fn_billing_definir_modo deu a normal ao ligar o bloqueio.
    expect(sql(`select count(*) from public.billing_contract_eventos where organization_id = '${ORG_SEM_CONCESSAO}' and tipo = 'carencia' and motivo = 'reativacao_por_pagamento';`)).toBe("1");
    expect(contrato(ORG_SEM_CONCESSAO, "status || '|' || (bloqueio_a_partir_de > now())")).toBe("ativa|true");
  });
});
