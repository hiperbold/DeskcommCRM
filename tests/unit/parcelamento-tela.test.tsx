/**
 * D-177: a tela `/app/settings/plano/assinar` mostra o seletor de parcelas só com cartão e ciclo semestral ou
 * anual, com o valor da parcela, o total e "sem juros" até 3x ou os juros a partir de 4x, e manda ao servidor só
 * o número de parcelas. As opções (e a conta) vêm calculadas do servidor; a ação de servidor é o limite do teste.
 * Também cobre a derivação "plano parcelado não renova sozinho" da tela de plano.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const iniciarAssinatura = vi.fn();
vi.mock("@/app/actions/settings/compraDoPlano", () => ({
  iniciarAssinatura: (...args: unknown[]) => iniciarAssinatura(...args),
  comprarPacote: vi.fn(),
}));

import { AssinarOuComprarClient } from "@/app/app/settings/plano/assinar/_client";
import { parcelasDoPlanoSemRenovacao } from "@/app/app/settings/plano/_logica-compra";
import { opcoesDeParcelamento } from "@/lib/billing/asaas/parcelamento";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import type { PlanoParaVenda } from "@/lib/billing/asaas/leitura";

const PARAMETROS = { taxaMensal: 0.0199, semJurosAte: 3, maxSemestral: 6, maxAnual: 12 };

const PRO: PlanoParaVenda = {
  code: "pro",
  name: "Pro",
  version: 1,
  forSale: true,
  priceMonthlyCents: 19900,
  priceSemiannualCents: 104900,
  priceYearlyCents: 189900,
};

const OPCOES = {
  pro: {
    semiannual: opcoesDeParcelamento(104900, "semiannual", PARAMETROS),
    yearly: opcoesDeParcelamento(189900, "yearly", PARAMETROS),
  },
};

function tela(locale = "pt-BR") {
  return render(
    <IdiomaProvider locale={locale}>
      <AssinarOuComprarClient
        planos={[PRO]}
        pacotes={[]}
        precisaPagador={false}
        leituraFalhou={false}
        opcoesDeParcelas={OPCOES}
        taxaMensalPercentual={1.99}
      />
    </IdiomaProvider>,
  );
}

const reais = (valor: string) => new RegExp(`R\\$\\s*${valor.replace(/\./g, "\\.")}`);

beforeEach(() => {
  iniciarAssinatura.mockReset();
  iniciarAssinatura.mockResolvedValue({ tipo: "erro", mensagem: "parou aqui" });
});
afterEach(() => cleanup());

describe("seletor de parcelas", () => {
  it("o mensal e o Pix não mostram parcelas", () => {
    tela();
    expect(screen.queryByTestId("parcelas-pro")).toBeNull();
    fireEvent.click(screen.getByTestId("ciclo-pro-semiannual"));
    expect(screen.getByTestId("parcelas-pro")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Pix"));
    expect(screen.queryByTestId("parcelas-pro")).toBeNull();
  });

  it("semestral: de 1x a 6x, sem juros até 3x e com juros de 1,99% ao mês de 4x em diante, com o total", () => {
    tela();
    fireEvent.click(screen.getByTestId("ciclo-pro-semiannual"));

    for (let n = 1; n <= 6; n += 1) expect(screen.getByTestId(`parcelas-pro-${n}`)).toBeInTheDocument();
    expect(screen.queryByTestId("parcelas-pro-7")).toBeNull();

    expect(screen.getByTestId("parcelas-pro-1").textContent).toContain("sem juros");
    expect(screen.getByTestId("parcelas-pro-3").textContent).toContain("sem juros");
    // 3x: R$ 349,67 com a última de R$ 349,66, total R$ 1.049,00.
    expect(screen.getByTestId("parcelas-pro-3").textContent).toMatch(reais("349,67"));
    expect(screen.getByTestId("parcelas-pro-3").textContent).toMatch(reais("349,66"));
    expect(screen.getByTestId("parcelas-pro-3").textContent).toMatch(reais("1.049,00"));

    const quatro = screen.getByTestId("parcelas-pro-4").textContent ?? "";
    expect(quatro).toContain("com juros de 1,99% ao mês");
    expect(quatro).toMatch(reais("275,43"));
    expect(quatro).toMatch(reais("1.101,72"));
    expect(screen.getByTestId("parcelas-pro-6").textContent).toMatch(reais("1.123,26"));
  });

  it("anual: até 12x (R$ 179,46 por parcela, total R$ 2.153,52)", () => {
    tela();
    fireEvent.click(screen.getByTestId("ciclo-pro-yearly"));
    expect(screen.getByTestId("parcelas-pro-12").textContent).toMatch(reais("179,46"));
    expect(screen.getByTestId("parcelas-pro-12").textContent).toMatch(reais("2.153,52"));
  });

  it("manda ao servidor só o número de parcelas escolhido (nenhum valor)", async () => {
    tela();
    fireEvent.click(screen.getByTestId("ciclo-pro-semiannual"));
    fireEvent.click(screen.getByTestId("parcelas-pro-4").querySelector("input") as HTMLElement);
    fireEvent.click(document.getElementById("termos-plano-pro") as HTMLElement);
    fireEvent.click(screen.getByTestId("assinar-pro"));

    await waitFor(() => expect(iniciarAssinatura).toHaveBeenCalledTimes(1));
    const enviado = iniciarAssinatura.mock.calls[0]![0] as Record<string, unknown>;
    expect(enviado).toMatchObject({ planCode: "pro", ciclo: "semiannual", metodo: "CREDIT_CARD", parcelas: 4 });
    expect(Object.keys(enviado).some((k) => /valor|total|amount|price/i.test(k))).toBe(false);
  });

  it("trocar de ciclo volta para 1x", async () => {
    tela();
    fireEvent.click(screen.getByTestId("ciclo-pro-semiannual"));
    fireEvent.click(screen.getByTestId("parcelas-pro-5").querySelector("input") as HTMLElement);
    fireEvent.click(screen.getByTestId("ciclo-pro-yearly"));
    fireEvent.click(document.getElementById("termos-plano-pro") as HTMLElement);
    fireEvent.click(screen.getByTestId("assinar-pro"));
    await waitFor(() => expect(iniciarAssinatura).toHaveBeenCalledTimes(1));
    expect(iniciarAssinatura.mock.calls[0]![0]).toMatchObject({ ciclo: "yearly" });
    expect(iniciarAssinatura.mock.calls[0]![0]).not.toHaveProperty("parcelas");
  });

  it("em espanhol o seletor sai traduzido", () => {
    tela("es");
    fireEvent.click(screen.getByTestId("ciclo-pro-semiannual"));
    expect(screen.getByText("Parcelamiento")).toBeInTheDocument();
    expect(screen.getByTestId("parcelas-pro-1").textContent).toContain("sin intereses");
  });
});

describe("plano parcelado não renova sozinho (derivação)", () => {
  const pedido = (parcelas: number, pagoEm: string | null = "2026-10-01T10:00:00Z", status = "pago") => ({
    tipo: "assinatura",
    status,
    parcelas,
    pagoEm,
  });

  it("sem assinatura viva e último pedido pago parcelado: devolve o número de parcelas", () => {
    expect(parcelasDoPlanoSemRenovacao({ assinaturaDoContrato: null, pedidos: [pedido(4)] })).toBe(4);
    expect(
      parcelasDoPlanoSemRenovacao({ assinaturaDoContrato: { asaasSubscriptionId: "sub_1", encerradaEm: "2026-10-02T00:00:00Z" }, pedidos: [pedido(6)] }),
    ).toBe(6);
  });

  it("com assinatura viva (renova sozinha), à vista ou sem pedido pago: nulo", () => {
    expect(parcelasDoPlanoSemRenovacao({ assinaturaDoContrato: { asaasSubscriptionId: "sub_1", encerradaEm: null }, pedidos: [pedido(4)] })).toBeNull();
    expect(parcelasDoPlanoSemRenovacao({ assinaturaDoContrato: null, pedidos: [pedido(1)] })).toBeNull();
    expect(parcelasDoPlanoSemRenovacao({ assinaturaDoContrato: null, pedidos: [pedido(4, null, "aguardando_pagamento")] })).toBeNull();
    expect(parcelasDoPlanoSemRenovacao({ assinaturaDoContrato: null, pedidos: [] })).toBeNull();
  });

  it("vale o último pedido pago: um Pix à vista depois do parcelado tira o aviso", () => {
    expect(
      parcelasDoPlanoSemRenovacao({
        assinaturaDoContrato: null,
        pedidos: [pedido(4, "2026-09-01T10:00:00Z"), pedido(1, "2026-10-01T10:00:00Z")],
      }),
    ).toBeNull();
  });
});
