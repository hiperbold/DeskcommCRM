/**
 * D-176: a tela `/app/settings/plano/assinar` oferece mensal, semestral e anual por plano, mostra o
 * total do período e a economia contra o mensal (calculada dos preços do catálogo) e manda ao
 * servidor o ciclo e o método escolhidos. A ação de servidor é o limite do teste (a regra dela é
 * provada em `asaas-compra-acoes.test.ts`); o que se mede aqui é o que a pessoa vê e o que a tela
 * pede.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const iniciarAssinatura = vi.fn();
const comprarPacote = vi.fn();
vi.mock("@/app/actions/settings/compraDoPlano", () => ({
  iniciarAssinatura: (...args: unknown[]) => iniciarAssinatura(...args),
  comprarPacote: (...args: unknown[]) => comprarPacote(...args),
}));

import { AssinarOuComprarClient } from "@/app/app/settings/plano/assinar/_client";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import type { PlanoParaVenda } from "@/lib/billing/asaas/leitura";

const PRO: PlanoParaVenda = {
  code: "pro",
  name: "Pro",
  version: 1,
  forSale: true,
  priceMonthlyCents: 19900,
  priceSemiannualCents: 104900,
  priceYearlyCents: 189900,
};

const SO_MENSAL_E_ANUAL: PlanoParaVenda = {
  code: "max",
  name: "Max",
  version: 1,
  forSale: true,
  priceMonthlyCents: 39900,
  priceSemiannualCents: null,
  priceYearlyCents: 379900,
};

function tela(planos: PlanoParaVenda[], locale = "pt-BR") {
  return render(
    <IdiomaProvider locale={locale}>
      <AssinarOuComprarClient planos={planos} pacotes={[]} precisaPagador={false} leituraFalhou={false} />
    </IdiomaProvider>,
  );
}

const reais = (valor: string) => new RegExp(`R\\$\\s*${valor.replace(/\./g, "\\.")}`);

beforeEach(() => {
  iniciarAssinatura.mockReset();
  iniciarAssinatura.mockResolvedValue({ tipo: "erro", mensagem: "parou aqui" });
});

afterEach(() => {
  cleanup();
});

describe("a tela de assinar oferece os três ciclos", () => {
  it("mostra Mensal, Semestral e Anual, com o preço do período nos dois longos", () => {
    tela([PRO]);

    expect(screen.getByTestId("ciclo-pro-monthly")).toHaveTextContent("Mensal");
    expect(screen.getByTestId("ciclo-pro-semiannual")).toHaveTextContent(/Semestral/);
    expect(screen.getByTestId("ciclo-pro-semiannual").textContent).toMatch(reais("1.049,00"));
    expect(screen.getByTestId("ciclo-pro-yearly")).toHaveTextContent(/Anual/);
    expect(screen.getByTestId("ciclo-pro-yearly").textContent).toMatch(reais("1.899,00"));
  });

  it("começa no mensal, sem o resumo do período e sem a escolha de forma de pagamento", () => {
    tela([PRO]);

    expect(screen.getByTestId("ciclo-pro-monthly")).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByTestId("resumo-pro")).toBeNull();
    expect(screen.queryByText("Forma de pagamento")).toBeNull();
  });

  it("semestral: total do período, seis meses e a economia contra o mensal (12% pelos preços)", () => {
    tela([PRO]);

    fireEvent.click(screen.getByTestId("ciclo-pro-semiannual"));

    const resumo = screen.getByTestId("resumo-pro");
    expect(resumo.textContent).toContain("Total do período");
    expect(resumo.textContent).toMatch(reais("1.049,00"));
    expect(resumo.textContent).toContain("6 meses");
    expect(resumo.textContent).toMatch(reais("145,00"));
    expect(resumo.textContent).toContain("(12%)");
    expect(resumo.textContent).toContain("em relação ao mensal");
    expect(screen.getByText("Forma de pagamento")).toBeInTheDocument();
  });

  it("anual: total do período, doze meses e a economia (R$ 489,00, 20%)", () => {
    tela([PRO]);

    fireEvent.click(screen.getByTestId("ciclo-pro-yearly"));

    const resumo = screen.getByTestId("resumo-pro");
    expect(resumo.textContent).toMatch(reais("1.899,00"));
    expect(resumo.textContent).toContain("12 meses");
    expect(resumo.textContent).toMatch(reais("489,00"));
    expect(resumo.textContent).toContain("(20%)");
  });

  it("plano sem preço semestral não oferece o semestral, só mensal e anual", () => {
    tela([SO_MENSAL_E_ANUAL]);

    expect(screen.getByTestId("ciclo-max-monthly")).toBeInTheDocument();
    expect(screen.queryByTestId("ciclo-max-semiannual")).toBeNull();
    expect(screen.getByTestId("ciclo-max-yearly")).toBeInTheDocument();
  });

  it("voltar ao mensal esconde o resumo e força o cartão (o mensal não tem Pix)", async () => {
    iniciarAssinatura.mockResolvedValue({ tipo: "erro", mensagem: "parou aqui" });
    tela([PRO]);

    fireEvent.click(screen.getByTestId("ciclo-pro-semiannual"));
    fireEvent.click(screen.getByRole("button", { name: "Pix" }));
    fireEvent.click(screen.getByTestId("ciclo-pro-monthly"));

    expect(screen.queryByTestId("resumo-pro")).toBeNull();
    fireEvent.click(screen.getByTestId("assinar-pro"));
    await waitFor(() => expect(iniciarAssinatura).toHaveBeenCalledTimes(1));
    expect(iniciarAssinatura.mock.calls[0]![0]).toMatchObject({ planCode: "pro", ciclo: "monthly", metodo: "CREDIT_CARD" });
  });
});

describe("a tela pede ao servidor o ciclo e o método escolhidos", () => {
  it("semestral no cartão (padrão)", async () => {
    tela([PRO]);

    fireEvent.click(screen.getByTestId("ciclo-pro-semiannual"));
    fireEvent.click(screen.getByTestId("assinar-pro"));

    await waitFor(() => expect(iniciarAssinatura).toHaveBeenCalledTimes(1));
    expect(iniciarAssinatura.mock.calls[0]![0]).toMatchObject({ planCode: "pro", ciclo: "semiannual", metodo: "CREDIT_CARD" });
  });

  it("anual no Pix", async () => {
    tela([PRO]);

    fireEvent.click(screen.getByTestId("ciclo-pro-yearly"));
    fireEvent.click(screen.getByRole("button", { name: "Pix" }));
    fireEvent.click(screen.getByTestId("assinar-pro"));

    await waitFor(() => expect(iniciarAssinatura).toHaveBeenCalledTimes(1));
    expect(iniciarAssinatura.mock.calls[0]![0]).toMatchObject({ planCode: "pro", ciclo: "yearly", metodo: "PIX" });
  });

  it("a entrada nunca leva preço, valor nem total: o servidor decide pelo catálogo", async () => {
    tela([PRO]);

    fireEvent.click(screen.getByTestId("ciclo-pro-semiannual"));
    fireEvent.click(screen.getByTestId("assinar-pro"));

    await waitFor(() => expect(iniciarAssinatura).toHaveBeenCalledTimes(1));
    expect(Object.keys(iniciarAssinatura.mock.calls[0]![0] as object).sort()).toEqual(["chave", "ciclo", "metodo", "pagador", "planCode"]);
  });
});

describe("os textos novos aparecem em espanhol", () => {
  it("rótulos e resumo do semestral em es", () => {
    tela([PRO], "es");

    expect(screen.getByTestId("ciclo-pro-monthly")).toHaveTextContent("Mensual");
    fireEvent.click(screen.getByTestId("ciclo-pro-semiannual"));

    const resumo = screen.getByTestId("resumo-pro");
    expect(resumo.textContent).toContain("Total del período");
    expect(resumo.textContent).toContain("Ahorro de");
    expect(resumo.textContent).toContain("frente al plan mensual");
  });
});
