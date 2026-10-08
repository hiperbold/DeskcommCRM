import { describe, expect, it, vi } from "vitest";

import type { ClienteAsaasHttp } from "@/lib/billing/asaas/cliente";
import type { ConfigAsaas } from "@/lib/billing/asaas/config";
import type { CobrancaAsaas } from "@/lib/billing/asaas/contratos";
import {
  processarEventosAsaas,
  type DbEventosAsaas,
  type EntradaDeAvisoDeCobranca,
} from "@/lib/billing/asaas/processar-eventos";
import type { MarcaDeSaida } from "@/lib/branding/saida";
import type { EmailParaEnfileirar } from "@/lib/email/conta-e-cobranca/fila";
import { criarAvisosDeCobrancaSobre } from "@/lib/email/conta-e-cobranca/gatilhos-de-cobranca";
import { montarEmailDeConta, type ContextoDoEmail } from "@/lib/email/conta-e-cobranca/montar";

import { clienteFalso, criarBancoFalso, type BancoFalso } from "./helpers/banco-de-emails-falso";

/**
 * Os gatilhos dos e-mails de cobrança: o que cada evento do Asaas, depois de aplicado, ENFILEIRA, para quem, com
 * que chave de idempotência e com que dados. O enfileiramento real é trocado por um espião (a borda); o conteúdo
 * é conferido montando a mensagem a partir dos `dados` enfileirados com a mesma `montarEmailDeConta` que o envio
 * usa. O último bloco prova a ligação com o processador de eventos: só depois de aplicar, dentro do fluxo do
 * evento, e falha de aviso não muda o resultado do evento.
 */

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const ORG = "0952b000-0000-4000-8000-00000000000a";
const MARCA: MarcaDeSaida = {
  nome: "HiperCRM",
  logoUrl: null,
  accent: "#0139B0",
  accentFg: "#ffffff",
  origens: { nome: "padrao", cor: "padrao" },
};
/** 00h de São Paulo de 01/11/2026: o último dia de acesso pago é 31/10. */
const FIM_DO_PERIODO = "2026-11-01T03:00:00+00:00";
const ANTES_DA_CARENCIA = new Date("2026-11-03T15:00:00Z");

function mundo(extra: Partial<BancoFalso["tabelas"]> = {}): BancoFalso {
  return criarBancoFalso({
    tabelas: {
      billing_plans: [
        { id: "plano-pro", code: "pro", name: "Pro", grace_days: 7 },
        { id: "plano-pro-v2", code: "pro", name: "Pro", grace_days: 7 },
        { id: "plano-max", code: "max", name: "Max", grace_days: 7 },
      ],
      billing_contracts: [
        { organization_id: ORG, plan_id: "plano-pro", status: "ativa", cycle: "monthly", current_period_end: FIM_DO_PERIODO },
      ],
      billing_orders: [
        { id: "ord-1", organization_id: ORG, tipo: "assinatura", plan_id: "plano-pro", ciclo: "monthly", metodo: "CREDIT_CARD", amount_cents: 34900, parcelas: 1, invoice_url: null },
        { id: "ord-pix", organization_id: ORG, tipo: "assinatura", plan_id: "plano-pro", ciclo: "semiannual", metodo: "PIX", amount_cents: 180000, parcelas: 1, invoice_url: "https://www.asaas.com/i/pix123" },
        { id: "ord-parc", organization_id: ORG, tipo: "assinatura", plan_id: "plano-pro", ciclo: "semiannual", metodo: "CREDIT_CARD", amount_cents: 195000, parcelas: 6, invoice_url: null },
        { id: "ord-pacote", organization_id: ORG, tipo: "pacote_tokens", plan_id: null, ciclo: null, metodo: "PIX", amount_cents: 9900, parcelas: 1, invoice_url: null, tokens: 500000 },
      ],
      billing_payments: [
        // primeiro pagamento do cartão à vista (concedeu período)
        { id: "bp-1", organization_id: ORG, order_id: "ord-1", contract_id: "c-1", asaas_payment_id: "pay_1", gross_cents: 34900, status: "CONFIRMED", paid_at: "2026-10-02T12:00:00+00:00", billing_period_start: "2026-10-02T03:00:00+00:00", billing_period_end: FIM_DO_PERIODO, estorna_pagamento_id: null },
        // renovação do cartão (sem pedido)
        { id: "bp-ren", organization_id: ORG, order_id: null, contract_id: "c-1", asaas_payment_id: "pay_ren", gross_cents: 34900, status: "CONFIRMED", paid_at: "2026-10-02T12:00:00+00:00", billing_period_start: "2026-10-02T03:00:00+00:00", billing_period_end: FIM_DO_PERIODO, estorna_pagamento_id: null },
        // a parcela que concedeu o período do parcelado, e a parcela seguinte (sem período)
        { id: "bp-parc-1", organization_id: ORG, order_id: "ord-parc", contract_id: "c-1", asaas_payment_id: "pay_parc_1", gross_cents: 32500, status: "CONFIRMED", paid_at: "2026-10-02T12:00:00+00:00", billing_period_start: "2026-10-02T03:00:00+00:00", billing_period_end: FIM_DO_PERIODO, estorna_pagamento_id: null },
        { id: "bp-parc-2", organization_id: ORG, order_id: "ord-parc", contract_id: "c-1", asaas_payment_id: "pay_parc_2", gross_cents: 32500, status: "CONFIRMED", paid_at: "2026-10-02T12:00:00+00:00", billing_period_start: null, billing_period_end: null, estorna_pagamento_id: null },
        // pacote de tokens
        { id: "bp-pac", organization_id: ORG, order_id: "ord-pacote", contract_id: "c-1", asaas_payment_id: "pay_pac", gross_cents: 9900, status: "CONFIRMED", paid_at: "2026-10-02T12:00:00+00:00", billing_period_start: null, billing_period_end: null, estorna_pagamento_id: null },
        // estorno do primeiro pagamento
        { id: "bp-est", organization_id: ORG, order_id: "ord-1", contract_id: "c-1", asaas_payment_id: null, gross_cents: 34900, status: "REFUNDED", paid_at: "2026-10-05T12:00:00+00:00", created_at: "2026-10-05T15:00:00+00:00", billing_period_start: null, billing_period_end: null, estorna_pagamento_id: "bp-1" },
      ],
      ...extra,
    },
  });
}

function cobranca(extra: Partial<CobrancaAsaas> = {}): CobrancaAsaas {
  return {
    id: "pay_x",
    customer: "cus_x",
    status: "OVERDUE",
    billingType: "CREDIT_CARD",
    value: 349,
    dueDate: "2026-11-01",
    externalReference: null,
    valorConfirmado: 349,
    ...extra,
  };
}

function aviso(extra: Partial<EntradaDeAvisoDeCobranca> = {}): EntradaDeAvisoDeCobranca {
  return {
    eventType: "PAYMENT_CONFIRMED",
    resultado: "aplicado",
    organizationId: ORG,
    alarmes: [],
    idDoPagamento: "pay_1",
    cobranca: null,
    ...extra,
  };
}

function ctx(idioma: "pt-BR" | "es" = "pt-BR"): ContextoDoEmail {
  const appUrl = "https://crm.exemplo.com.br";
  return {
    organizationId: ORG,
    empresa: "Empresa A",
    idioma,
    marca: MARCA,
    appUrl,
    nome: "Diego",
    base: (url) => ({ marca: MARCA, idioma, empresa: "Empresa A", url }),
  };
}

function cenario(banco: BancoFalso = mundo(), agora: Date = ANTES_DA_CARENCIA) {
  const enviadas: EmailParaEnfileirar[] = [];
  const avisos = criarAvisosDeCobrancaSobre(clienteFalso(banco), {
    enfileirar: async (e) => {
      enviadas.push(e);
      return "enfileirado";
    },
    agora: () => agora,
  });
  const renderizar = (e: EmailParaEnfileirar, idioma: "pt-BR" | "es" = "pt-BR") =>
    montarEmailDeConta(e.emailId, e.dados, ctx(idioma));
  const por = (id: string) => enviadas.find((e) => e.emailId === id);
  return { avisos, enviadas, renderizar, por };
}

describe("pagamento confirmado: COB-02 plano confirmado e COB-03 recibo", () => {
  it("primeiro pagamento do cartão: plano confirmado (com cópia, por pedido) e recibo (sem cópia, por pagamento)", async () => {
    const c = cenario();
    await c.avisos.aoAplicar(aviso());

    expect(c.enviadas.map((e) => [e.emailId, e.chave, e.copiaParaOperador, e.destino])).toEqual([
      ["COB-02", "pedido:ord-1", true, "admins"],
      ["COB-03", "pagamento:pay_1", false, "admins"],
    ]);
    const plano = c.renderizar(c.por("COB-02")!);
    expect(plano.subject).toBe("Seu plano Pro está ativo");
    expect(plano.text).toContain("Mensal");
    expect(plano.text).toContain("31/10/2026");
    expect(plano.text).toContain("https://crm.exemplo.com.br/app/settings/plano");
    const recibo = c.renderizar(c.por("COB-03")!);
    expect(recibo.subject).toBe("Recibo do seu pagamento de R$ 349,00");
    expect(recibo.text).toContain("02/10/2026 a 31/10/2026");
    expect(recibo.text).toContain("Cartão");
    expect(recibo.text).not.toContain("Parcela:");
  });

  it("Pix: forma Pix nos dois e-mails", async () => {
    const banco = mundo();
    banco.tabelas.billing_payments!.push({
      id: "bp-pix", organization_id: ORG, order_id: "ord-pix", contract_id: "c-1", asaas_payment_id: "pay_pix", gross_cents: 180000, status: "RECEIVED", paid_at: "2026-10-02T12:00:00+00:00", billing_period_start: "2026-10-02T03:00:00+00:00", billing_period_end: FIM_DO_PERIODO, estorna_pagamento_id: null,
    });
    const c = cenario(banco);
    await c.avisos.aoAplicar(aviso({ eventType: "PAYMENT_RECEIVED", idDoPagamento: "pay_pix" }));
    expect(c.renderizar(c.por("COB-02")!).text).toContain("Pix");
    expect(c.renderizar(c.por("COB-03")!).text).toContain("Pix");
  });

  it("parcelado: UM recibo por pedido, com o total e 'Cartão em 6x', sem a linha Parcela", async () => {
    const c = cenario();
    await c.avisos.aoAplicar(aviso({ idDoPagamento: "pay_parc_1" }));

    const recibo = c.por("COB-03")!;
    expect(recibo.chave).toBe("pedido:ord-parc");
    const mensagem = c.renderizar(recibo);
    expect(mensagem.subject).toBe("Recibo do seu pagamento de R$ 1.950,00");
    expect(mensagem.text).toContain("Cartão em 6x");
    expect(mensagem.text).not.toMatch(/Parcela/);
    expect(c.por("COB-02")!.chave).toBe("pedido:ord-parc");
    expect(c.renderizar(c.por("COB-02")!).text).toContain("Cartão em 6x");
  });

  it("a parcela seguinte do parcelamento (sem período) não manda nada", async () => {
    const c = cenario();
    await c.avisos.aoAplicar(aviso({ idDoPagamento: "pay_parc_2" }));
    expect(c.enviadas).toEqual([]);
  });

  it("renovação do cartão (sem pedido): só o recibo, que é por pagamento", async () => {
    const c = cenario();
    await c.avisos.aoAplicar(aviso({ idDoPagamento: "pay_ren" }));
    expect(c.enviadas.map((e) => [e.emailId, e.chave])).toEqual([["COB-03", "pagamento:pay_ren"]]);
  });

  it("pacote de tokens (COB-09): um e-mail com cópia ao operador, chave pelo pedido, tokens do pedido e valor pago, SEM recibo", async () => {
    const c = cenario();
    await c.avisos.aoAplicar(aviso({ eventType: "PAYMENT_RECEIVED", idDoPagamento: "pay_pac" }));

    expect(c.enviadas.map((e) => [e.emailId, e.chave, e.copiaParaOperador, e.destino])).toEqual([
      ["COB-09", "pacote:ord-pacote", true, "admins"],
    ]);
    const m = c.renderizar(c.por("COB-09")!);
    expect(m.subject).toBe("Seu pacote de 500.000 tokens está liberado");
    expect(m.text).toContain("Valor pago: R$ 99,00");
    expect(m.text).toContain("já está no saldo da Empresa A");
    // O pacote não tem validade no banco: o e-mail não promete data.
    expect(m.text).not.toContain("Válido até");
    expect(m.text).not.toContain("vale até");
    expect(m.text).toContain("https://crm.exemplo.com.br/app/settings/plano");
    expect(c.renderizar(c.por("COB-09")!, "es").subject).not.toBe(m.subject);
  });

  it("pacote: o mesmo pagamento aplicado de novo gera a mesma chave; pedido sem tokens não manda nada", async () => {
    const c = cenario();
    await c.avisos.aoAplicar(aviso({ idDoPagamento: "pay_pac" }));
    await c.avisos.aoAplicar(aviso({ idDoPagamento: "pay_pac" }));
    expect(c.enviadas.map((e) => e.chave)).toEqual(["pacote:ord-pacote", "pacote:ord-pacote"]);

    const banco = mundo();
    banco.tabelas.billing_orders!.find((o) => o.id === "ord-pacote")!.tokens = null;
    const semTokens = cenario(banco);
    await semTokens.avisos.aoAplicar(aviso({ idDoPagamento: "pay_pac" }));
    expect(semTokens.enviadas).toEqual([]);
  });

  it("pacote: evento que não fechou como aplicado (tokens não creditados) não manda nada", async () => {
    for (const resultado of ["ja_aplicado", "aguardando", "erro", "ignorado"]) {
      const c = cenario();
      await c.avisos.aoAplicar(aviso({ resultado, idDoPagamento: "pay_pac" }));
      expect(c.enviadas, resultado).toEqual([]);
    }
  });

  it.each(["ja_aplicado", "aguardando", "divergente", "sem_vinculo", "erro", "ignorado"])(
    "evento que fechou como %s não manda nada",
    async (resultado) => {
      const c = cenario();
      await c.avisos.aoAplicar(aviso({ resultado }));
      expect(c.enviadas).toEqual([]);
    },
  );

  it("o mesmo pagamento aplicado de novo gera as mesmas chaves (a unicidade do envio segura o resto)", async () => {
    const c = cenario();
    await c.avisos.aoAplicar(aviso());
    await c.avisos.aoAplicar(aviso());
    const chaves = c.enviadas.map((e) => `${e.emailId}/${e.chave}`);
    expect(chaves).toEqual(["COB-02/pedido:ord-1", "COB-03/pagamento:pay_1", "COB-02/pedido:ord-1", "COB-03/pagamento:pay_1"]);
  });

  it("o e-mail sai no espanhol quando o destinatário é de es", async () => {
    const c = cenario();
    await c.avisos.aoAplicar(aviso());
    expect(c.renderizar(c.por("COB-02")!, "es").subject).toBe("Tu plan Pro está activo");
  });
});

describe("pagamento não aprovado: COB-05", () => {
  const fatura = "https://www.asaas.com/i/abc123";

  it("renovação em atraso: acesso até o último dia da carência, botão para a fatura do Asaas, com cópia", async () => {
    const c = cenario();
    await c.avisos.aoAplicar(
      aviso({
        eventType: "PAYMENT_OVERDUE",
        resultado: "ignorado",
        idDoPagamento: "pay_ren2",
        cobranca: cobranca({ id: "pay_ren2", invoiceUrl: fatura }),
      }),
    );

    expect(c.enviadas).toHaveLength(1);
    const e = c.enviadas[0]!;
    expect([e.emailId, e.chave, e.copiaParaOperador, e.destino]).toEqual(["COB-05", "pagamento:pay_ren2", true, "admins"]);
    const m = c.renderizar(e);
    expect(m.subject).toBe("Não conseguimos cobrar a renovação do seu plano");
    // fim do período 01/11 (exclusivo) + 7 dias de carência = 08/11 é o 1o dia de leitura; o acesso vai até 07/11
    expect(m.text).toContain("07/11/2026");
    expect(m.text).toContain("R$ 349,00");
    expect(m.text).toContain(`Pagar agora: ${fatura}`);
  });

  it("sem fatura guardada, o botão leva à tela do plano", async () => {
    const c = cenario();
    await c.avisos.aoAplicar(
      aviso({ eventType: "PAYMENT_OVERDUE", resultado: "ignorado", idDoPagamento: "pay_ren2", cobranca: cobranca({ id: "pay_ren2" }) }),
    );
    expect(c.renderizar(c.enviadas[0]!).text).toContain("Pagar agora: https://crm.exemplo.com.br/app/settings/plano");
  });

  it("fatura de outro host não vira botão", async () => {
    const c = cenario();
    await c.avisos.aoAplicar(
      aviso({
        eventType: "PAYMENT_OVERDUE",
        resultado: "ignorado",
        idDoPagamento: "pay_ren2",
        cobranca: cobranca({ id: "pay_ren2", invoiceUrl: "https://phishing.example.com/asaas.com/i/1" }),
      }),
    );
    const texto = c.renderizar(c.enviadas[0]!).text;
    expect(texto).not.toContain("phishing");
    expect(texto).toContain("/app/settings/plano");
  });

  it("quem nunca pagou nada (sem período) não recebe 'não conseguimos cobrar a renovação'", async () => {
    const banco = mundo();
    banco.tabelas.billing_contracts![0]!.current_period_end = null;
    const c = cenario(banco);
    await c.avisos.aoAplicar(
      aviso({ eventType: "PAYMENT_OVERDUE", resultado: "aplicado", idDoPagamento: "pay_z", cobranca: cobranca({ id: "pay_z" }) }),
    );
    expect(c.enviadas).toEqual([]);
  });

  it("carência que já passou não manda 'seu acesso continua': a conta já está só leitura", async () => {
    const c = cenario(mundo(), new Date("2026-11-09T15:00:00Z"));
    await c.avisos.aoAplicar(
      aviso({ eventType: "PAYMENT_OVERDUE", resultado: "ignorado", idDoPagamento: "pay_z", cobranca: cobranca({ id: "pay_z" }) }),
    );
    expect(c.enviadas).toEqual([]);
  });

  it("sem organização (pagamento já recebido) ou sem o objeto confirmado, nada", async () => {
    const c = cenario();
    await c.avisos.aoAplicar(aviso({ eventType: "PAYMENT_OVERDUE", resultado: "ignorado", organizationId: null, cobranca: cobranca() }));
    await c.avisos.aoAplicar(aviso({ eventType: "PAYMENT_OVERDUE", resultado: "ignorado", cobranca: null }));
    expect(c.enviadas).toEqual([]);
  });

  it("vencimento de pedido de pacote de tokens não é falha de renovação", async () => {
    const uuid = "0952c000-0000-4000-8000-000000000001";
    const banco = mundo();
    banco.tabelas.billing_orders!.push({ id: uuid, organization_id: ORG, tipo: "pacote_tokens", plan_id: null, ciclo: null, metodo: "PIX", amount_cents: 9900, parcelas: 1, invoice_url: null });
    const c = cenario(banco);
    await c.avisos.aoAplicar(
      aviso({ eventType: "PAYMENT_OVERDUE", resultado: "aplicado", idDoPagamento: "pay_pacv", cobranca: cobranca({ id: "pay_pacv", externalReference: `HC:ord:${uuid}` }) }),
    );
    expect(c.enviadas).toEqual([]);
  });

  it("pedido vencido: a fatura guardada no pedido vale mais que a do objeto confirmado", async () => {
    const uuid = "0952c000-0000-4000-8000-000000000002";
    const banco = mundo();
    // Pix de renovação: mesmo plano (outra versão do mesmo code) e mesmo ciclo do contrato.
    banco.tabelas.billing_orders!.push({ id: uuid, organization_id: ORG, tipo: "assinatura", plan_id: "plano-pro-v2", ciclo: "monthly", metodo: "PIX", amount_cents: 34900, parcelas: 1, invoice_url: "https://www.asaas.com/i/guardada" });
    const c = cenario(banco);
    await c.avisos.aoAplicar(
      aviso({
        eventType: "PAYMENT_OVERDUE",
        resultado: "aplicado",
        idDoPagamento: "pay_v",
        cobranca: cobranca({ id: "pay_v", externalReference: `HC:ord:${uuid}`, invoiceUrl: "https://www.asaas.com/i/outra" }),
      }),
    );
    const texto = c.renderizar(c.enviadas[0]!).text;
    expect(texto).toContain("https://www.asaas.com/i/guardada");
    expect(texto).toContain("Pro");
  });

  it("fatura guardada no pedido fora da regra (http ou outro host) não vira botão: leva à tela do plano", async () => {
    for (const [i, ruim] of ["http://www.asaas.com/i/sem-tls", "https://phishing.example.com/i/1", "https://asaas.com.evil.example/i/1"].entries()) {
      const uuid = `0952c000-0000-4000-8000-00000000010${i}`;
      const banco = mundo();
      banco.tabelas.billing_orders!.push({ id: uuid, organization_id: ORG, tipo: "assinatura", plan_id: "plano-pro-v2", ciclo: "monthly", metodo: "PIX", amount_cents: 34900, parcelas: 1, invoice_url: ruim });
      const c = cenario(banco);
      await c.avisos.aoAplicar(
        aviso({
          eventType: "PAYMENT_OVERDUE",
          resultado: "aplicado",
          idDoPagamento: `pay_ruim${i}`,
          cobranca: cobranca({ id: `pay_ruim${i}`, externalReference: `HC:ord:${uuid}` }),
        }),
      );
      expect(c.enviadas).toHaveLength(1);
      expect((c.enviadas[0]!.dados as { faturaUrl: string | null }).faturaUrl).toBeNull();
      const texto = c.renderizar(c.enviadas[0]!).text;
      expect(texto).not.toContain("phishing");
      expect(texto).not.toContain("sem-tls");
      expect(texto).toContain("Pagar agora: https://crm.exemplo.com.br/app/settings/plano");
    }
  });
});

describe("pagamento não aprovado: COB-05 só para a RENOVAÇÃO do plano vigente", () => {
  const venceu = (id: string, ref: string | null, resultado = "aplicado") =>
    aviso({
      eventType: "PAYMENT_OVERDUE",
      resultado,
      idDoPagamento: id,
      cobranca: cobranca({ id, externalReference: ref }),
    });
  const novoPedido = (banco: BancoFalso, id: string, extra: Record<string, unknown>) =>
    banco.tabelas.billing_orders!.push({
      id,
      organization_id: ORG,
      tipo: "assinatura",
      plan_id: "plano-pro",
      ciclo: "monthly",
      metodo: "PIX",
      amount_cents: 34900,
      parcelas: 1,
      invoice_url: null,
      ...extra,
    });
  const U = (n: number) => `0952c000-0000-4000-8000-${String(n).padStart(12, "0")}`;

  it("Pix da renovação (mesmo plano e ciclo, período acabando): avisa", async () => {
    const banco = mundo();
    novoPedido(banco, U(10), {});
    const c = cenario(banco);
    await c.avisos.aoAplicar(venceu("pay_a", `HC:ord:${U(10)}`));
    expect(c.enviadas.map((e) => e.emailId)).toEqual(["COB-05"]);
  });

  it("cobrança da assinatura viva (sem pedido, o banco fecha como ignorado): avisa", async () => {
    const c = cenario();
    await c.avisos.aoAplicar(venceu("pay_b", null, "ignorado"));
    expect(c.enviadas.map((e) => e.emailId)).toEqual(["COB-05"]);
  });

  it("Pix abandonado de TROCA DE PLANO não avisa", async () => {
    const banco = mundo();
    novoPedido(banco, U(11), { plan_id: "plano-max" });
    const c = cenario(banco);
    await c.avisos.aoAplicar(venceu("pay_c", `HC:ord:${U(11)}`));
    expect(c.enviadas).toEqual([]);
  });

  it("pedido de OUTRO ciclo (troca de ciclo abandonada) não avisa", async () => {
    const banco = mundo();
    novoPedido(banco, U(12), { ciclo: "yearly" });
    const c = cenario(banco);
    await c.avisos.aoAplicar(venceu("pay_d", `HC:ord:${U(12)}`));
    expect(c.enviadas).toEqual([]);
  });

  it("pagamento ADIANTADO (período vigente longe do fim) não avisa, nem o da assinatura nem o do pedido", async () => {
    const banco = mundo();
    banco.tabelas.billing_contracts![0]!.current_period_end = "2026-12-01T03:00:00+00:00";
    novoPedido(banco, U(13), {});
    const c = cenario(banco);
    await c.avisos.aoAplicar(venceu("pay_e", `HC:ord:${U(13)}`));
    await c.avisos.aoAplicar(venceu("pay_f", null, "ignorado"));
    expect(c.enviadas).toEqual([]);
  });

  it("pedido de pacote de tokens não avisa", async () => {
    const banco = mundo();
    novoPedido(banco, U(14), { tipo: "pacote_tokens", plan_id: null, ciclo: null, tokens: 500000 });
    const c = cenario(banco);
    await c.avisos.aoAplicar(venceu("pay_g", `HC:ord:${U(14)}`));
    expect(c.enviadas).toEqual([]);
  });

  it("`aplicado` sem pedido legível (não dá para saber de que compra é) não avisa", async () => {
    const c = cenario();
    await c.avisos.aoAplicar(venceu("pay_h", null, "aplicado"));
    await c.avisos.aoAplicar(venceu("pay_i", `HC:ord:${U(99)}`, "aplicado"));
    expect(c.enviadas).toEqual([]);
  });

  it.each(["suspensa", "cancelada", "avaliacao"])("contrato %s não recebe o aviso de renovação", async (status) => {
    const banco = mundo();
    banco.tabelas.billing_contracts![0]!.status = status;
    const c = cenario(banco);
    await c.avisos.aoAplicar(venceu("pay_j", null, "ignorado"));
    expect(c.enviadas).toEqual([]);
  });

  it("contrato atrasado (período acabou, ainda na carência) recebe", async () => {
    const banco = mundo();
    banco.tabelas.billing_contracts![0]!.status = "atrasada";
    const c = cenario(banco);
    await c.avisos.aoAplicar(venceu("pay_k", null, "ignorado"));
    expect(c.enviadas.map((e) => e.emailId)).toEqual(["COB-05"]);
  });
});

describe("os dados são os do MOMENTO do evento", () => {
  it("o que é guardado não muda quando o banco muda depois (sem reler na hora do envio)", async () => {
    const banco = mundo();
    const c = cenario(banco);
    await c.avisos.aoAplicar(aviso());
    const antes = JSON.stringify(c.enviadas.map((e) => e.dados));

    // depois do evento: o plano é renomeado e o contrato muda de plano e de período
    banco.tabelas.billing_plans!.find((p) => p.id === "plano-pro")!.name = "Outro nome";
    banco.tabelas.billing_contracts![0]!.plan_id = "plano-max";
    banco.tabelas.billing_contracts![0]!.current_period_end = "2027-05-01T03:00:00+00:00";

    expect(JSON.stringify(c.enviadas.map((e) => e.dados))).toBe(antes);
    expect(c.renderizar(c.por("COB-02")!).subject).toBe("Seu plano Pro está ativo");
  });

  it("dados sem endereço de e-mail de ninguém", async () => {
    const c = cenario();
    await c.avisos.aoAplicar(aviso());
    await c.avisos.aoAplicar(aviso({ eventType: "PAYMENT_REFUNDED", alarmes: ["estorno_confirmado"] }));
    expect(JSON.stringify(c.enviadas)).not.toMatch(/@/);
  });
});

describe("estorno: COB-08", () => {
  it("estorno total aplicado: valor da linha REFUNDED, data do estorno, com cópia, chave pagamento + tipo", async () => {
    const c = cenario();
    await c.avisos.aoAplicar(
      aviso({ eventType: "PAYMENT_REFUNDED", alarmes: ["estorno_confirmado", "estorno_cortou_acesso"] }),
    );
    expect(c.enviadas).toHaveLength(1);
    const e = c.enviadas[0]!;
    expect([e.emailId, e.chave, e.copiaParaOperador]).toEqual(["COB-08", "pagamento:pay_1:estorno", true]);
    const m = c.renderizar(e);
    expect(m.subject).toBe("Estorno de R$ 349,00 feito");
    expect(m.text).toContain("05/10/2026");
    expect(m.text).toContain("Pro");
  });

  it("a linha REFUNDED de OUTRA organização que aponta para o mesmo pagamento nunca vira o estorno desta", async () => {
    const OUTRA = "0952b000-0000-4000-8000-00000000000b";
    const banco = mundo();
    // some o estorno da própria organização e fica só um REFUNDED alheio apontando para o mesmo id
    banco.tabelas.billing_payments = banco.tabelas.billing_payments!.filter((l) => l.id !== "bp-est");
    banco.tabelas.billing_payments!.push({
      id: "bp-alheio", organization_id: OUTRA, order_id: "ord-alheia", contract_id: "c-alheio", asaas_payment_id: null, gross_cents: 77700, status: "REFUNDED", paid_at: "2026-10-05T12:00:00+00:00", created_at: "2026-10-05T15:00:00+00:00", billing_period_start: null, billing_period_end: null, estorna_pagamento_id: "bp-1",
    });
    const c = cenario(banco);
    await c.avisos.aoAplicar(
      aviso({ eventType: "PAYMENT_REFUNDED", alarmes: ["estorno_confirmado", "estorno_cortou_acesso"] }),
    );
    expect(c.enviadas).toEqual([]);
  });

  it("com a linha REFUNDED da própria organização e uma alheia, usa o valor da própria", async () => {
    const OUTRA = "0952b000-0000-4000-8000-00000000000b";
    const banco = mundo();
    banco.tabelas.billing_payments!.unshift({
      id: "bp-alheio", organization_id: OUTRA, order_id: "ord-alheia", contract_id: "c-alheio", asaas_payment_id: null, gross_cents: 77700, status: "REFUNDED", paid_at: "2026-10-05T12:00:00+00:00", created_at: "2026-10-05T15:00:00+00:00", billing_period_start: null, billing_period_end: null, estorna_pagamento_id: "bp-1",
    });
    const c = cenario(banco);
    await c.avisos.aoAplicar(
      aviso({ eventType: "PAYMENT_REFUNDED", alarmes: ["estorno_confirmado", "estorno_cortou_acesso"] }),
    );
    const e = c.por("COB-08")!;
    expect(e).toBeDefined();
    const m = c.renderizar(e);
    expect(m.text).toContain("349,00");
    expect(m.text).not.toContain("777,00");
  });

  it("estorno de pacote de tokens nomeia o pacote, no idioma de quem lê", async () => {
    const banco = mundo();
    banco.tabelas.billing_payments!.push({
      id: "bp-est-pac", organization_id: ORG, order_id: "ord-pacote", contract_id: "c-1", asaas_payment_id: null, gross_cents: 9900, status: "REFUNDED", paid_at: "2026-10-05T12:00:00+00:00", created_at: "2026-10-05T15:00:00+00:00", billing_period_start: null, billing_period_end: null, estorna_pagamento_id: "bp-pac",
    });
    const c = cenario(banco);
    await c.avisos.aoAplicar(
      aviso({ eventType: "PAYMENT_REFUNDED", idDoPagamento: "pay_pac", alarmes: ["estorno_confirmado", "estorno_removeu_tokens_do_pacote"] }),
    );
    expect(c.renderizar(c.enviadas[0]!).text).toContain("Pacote de tokens");
    expect(c.renderizar(c.enviadas[0]!, "es").text).toContain("Paquete de tokens");
  });

  it.each([
    ["PAYMENT_PARTIALLY_REFUNDED", ["parcialmente_estornado"]],
    ["PAYMENT_CHARGEBACK_REQUESTED", ["chargeback_confirmado"]],
    ["PAYMENT_REFUNDED", []],
  ])("%s sem estorno total confirmado não manda nada", async (eventType, alarmes) => {
    const c = cenario();
    await c.avisos.aoAplicar(aviso({ eventType, alarmes }));
    expect(c.enviadas).toEqual([]);
  });

  it("estorno já aplicado antes (ja_aplicado) não manda de novo", async () => {
    const c = cenario();
    await c.avisos.aoAplicar(aviso({ eventType: "PAYMENT_REFUNDED", resultado: "ja_aplicado", alarmes: [] }));
    expect(c.enviadas).toEqual([]);
  });
});

describe("falha nunca derruba o processamento", () => {
  it("banco que erra dentro do gatilho: a promessa resolve e nada é enviado", async () => {
    const banco = mundo();
    banco.falhar.billing_payments = { code: "XX000", message: "boom" };
    const c = cenario(banco);
    await expect(c.avisos.aoAplicar(aviso())).resolves.toBeUndefined();
    expect(c.enviadas).toEqual([]);
  });
});

describe("ligação com o processador de eventos", () => {
  const CONFIG: ConfigAsaas = {
    habilitado: true,
    baseUrl: "https://api-sandbox.asaas.com/v3",
    apiKey: "$aact_hmlg_testeNuncaEUmaChaveReal000111222",
    webhookToken: "token-de-teste-nunca-real",
    webhookId: "",
    ambiente: "sandbox",
  };

  function processador(resultado: string, aviso: { aoAplicar: (e: EntradaDeAvisoDeCobranca) => Promise<void> }, falhaAoAplicar = false) {
    const evento = { id: "evt-1", eventType: "PAYMENT_CONFIRMED", idDoRecurso: "pay_1", leaseToken: "lease-1" };
    const db: DbEventosAsaas = {
      reservarEventos: vi.fn(async () => ({ data: [evento], error: null })),
      lerPayloads: vi.fn(async () => ({
        data: [{ id: "evt-1", payload: { id: "evt-1", event: "PAYMENT_CONFIRMED", payment: { id: "pay_1", customer: "cus_1", status: "CONFIRMED", billingType: "CREDIT_CARD", value: 349, dueDate: "2026-10-02", externalReference: "HC:ord:o1" } } }],
        error: null,
      })),
      pagamentoConhecido: vi.fn(async () => ({ data: false, error: null })),
      assinaturaConhecida: vi.fn(async () => ({ data: false, error: null })),
      clienteConhecido: vi.fn(async () => ({ data: false, error: null })),
      aplicarEvento: vi.fn(async () =>
        falhaAoAplicar
          ? { data: null, error: { code: "XX000", message: "boom" } }
          : { data: { resultado, organizationId: ORG, alarme: null }, error: null },
      ),
      registrarFalha: vi.fn(async () => ({ data: { tentativas: 1, resultado: "aguardando" }, error: null })),
      marcarAssinaturaEncerrada: vi.fn(async () => ({ data: { jaRegistrado: false }, error: null })),
    };
    const asaas = {
      buscarCobranca: vi.fn(async () => ({
        id: "pay_1", customer: "cus_1", status: "CONFIRMED", billingType: "CREDIT_CARD", value: 349, dueDate: "2026-10-02", externalReference: "HC:ord:o1", valorConfirmado: 349,
      })),
      buscarAssinatura: vi.fn(),
    } as unknown as ClienteAsaasHttp;
    return processarEventosAsaas({ db, asaas, config: CONFIG, logger: { warn: vi.fn(), error: vi.fn() }, avisos: aviso });
  }

  it("depois de aplicar, entrega ao aviso o evento, o resultado do banco e o objeto CONFIRMADO", async () => {
    const aoAplicar = vi.fn(async () => undefined);
    const resumo = await processador("aplicado", { aoAplicar });
    expect(resumo.aplicados).toBe(1);
    expect(aoAplicar).toHaveBeenCalledTimes(1);
    expect(aoAplicar).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "PAYMENT_CONFIRMED",
        resultado: "aplicado",
        organizationId: ORG,
        idDoPagamento: "pay_1",
        cobranca: expect.objectContaining({ id: "pay_1", status: "CONFIRMED" }),
      }),
    );
  });

  it("se o banco recusou aplicar o evento, nenhum aviso é chamado", async () => {
    const aoAplicar = vi.fn(async () => undefined);
    const resumo = await processador("aplicado", { aoAplicar }, true);
    expect(resumo.falhas).toBe(1);
    expect(aoAplicar).not.toHaveBeenCalled();
  });

  it("aviso que lança não muda o resultado do evento", async () => {
    const aoAplicar = vi.fn(async () => {
      throw new Error("smtp caiu");
    });
    const resumo = await processador("aplicado", { aoAplicar });
    expect(resumo.aplicados).toBe(1);
    expect(resumo.falhas).toBe(0);
  });
});
