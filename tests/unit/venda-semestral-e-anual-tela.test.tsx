/**
 * D-176: a tela `/app/settings/plano/assinar` oferece mensal, semestral e anual por plano, mostra o
 * total do período e a economia contra o mensal (calculada dos preços do catálogo) e manda ao
 * servidor o ciclo e o método escolhidos. A ação de servidor é o limite do teste (a regra dela é
 * provada em `asaas-compra-acoes.test.ts`); o que se mede aqui é o que a pessoa vê e o que a tela
 * pede.
 *
 * D-180: a tela é um passo a passo (1 Plano, 2 Ciclo, 3 Pagamento, 4 Resumo). As asserções de
 * comportamento são as mesmas de antes; mudou o caminho até elas. O passo a passo em si (avançar,
 * voltar, resumo, foco) é provado em `assinar-passo-a-passo-tela.test.tsx`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const iniciarAssinatura = vi.fn();
const comprarPacote = vi.fn();
vi.mock("@/app/actions/settings/compraDoPlano", () => ({
  iniciarAssinatura: (...args: unknown[]) => iniciarAssinatura(...args),
  comprarPacote: (...args: unknown[]) => comprarPacote(...args),
}));

import { AssinarOuComprarClient } from "@/app/app/settings/plano/assinar/_client";
import { VERSAO_DOS_TERMOS } from "@/lib/legal/versao-dos-termos";
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

// Atalhos entre os passos do plano (1 Plano, 2 Ciclo, 3 Pagamento, 4 Resumo).
const escolherPlano = (code = "pro") => fireEvent.click(screen.getByTestId(`escolher-${code}`));
const escolherCiclo = (code: string, ciclo: string) => fireEvent.click(screen.getByTestId(`ciclo-${code}-${ciclo}`));
const continuar = () => fireEvent.click(screen.getByTestId("continuar"));
const aceitarTermos = (code = "pro") => fireEvent.click(document.getElementById(`termos-plano-${code}`) as HTMLElement);
/** Plano e ciclo escolhidos, tela parada no passo 3 (pagamento). */
const ateOPagamento = (code: string, ciclo: string) => {
  escolherPlano(code);
  escolherCiclo(code, ciclo);
  continuar();
};
/** Do passo 3 ao resumo, com o aceite dos Termos marcado. */
const ateOResumo = (code = "pro") => {
  aceitarTermos(code);
  continuar();
};

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
    escolherPlano();

    expect(screen.getByTestId("ciclo-pro-monthly")).toHaveTextContent("Mensal");
    expect(screen.getByTestId("ciclo-pro-semiannual")).toHaveTextContent(/Semestral/);
    expect(screen.getByTestId("ciclo-pro-semiannual").textContent).toMatch(reais("1.049,00"));
    expect(screen.getByTestId("ciclo-pro-yearly")).toHaveTextContent(/Anual/);
    expect(screen.getByTestId("ciclo-pro-yearly").textContent).toMatch(reais("1.899,00"));
  });

  it("começa no mensal, sem o resumo do período e sem a escolha de forma de pagamento (só cartão)", () => {
    tela([PRO]);
    escolherPlano();

    expect(within(screen.getByTestId("ciclo-pro-monthly")).getByRole("radio")).toBeChecked();
    expect(screen.queryByTestId("resumo-pro-monthly")).toBeNull();
    expect(screen.queryByTestId("resumo-pro-semiannual")).not.toBeNull();

    continuar();
    expect(screen.getByTestId("metodo-unico")).toHaveTextContent("Cartão de crédito");
    expect(screen.queryByTestId("metodo-PIX")).toBeNull();
  });

  it("semestral: total do período, seis meses e a economia contra o mensal (12% pelos preços)", () => {
    tela([PRO]);
    escolherPlano();
    escolherCiclo("pro", "semiannual");

    const resumo = screen.getByTestId("resumo-pro-semiannual");
    expect(resumo.textContent).toContain("Total do período");
    expect(screen.getByTestId("ciclo-pro-semiannual").textContent).toMatch(reais("1.049,00"));
    expect(resumo.textContent).toContain("6 meses");
    expect(resumo.textContent).toMatch(reais("145,00"));
    expect(resumo.textContent).toContain("(12%)");
    expect(resumo.textContent).toContain("em relação ao mensal");

    continuar();
    expect(screen.getByText("Forma de pagamento")).toBeInTheDocument();
  });

  it("anual: total do período, doze meses e a economia (R$ 489,00, 20%)", () => {
    tela([PRO]);
    escolherPlano();
    escolherCiclo("pro", "yearly");

    const resumo = screen.getByTestId("resumo-pro-yearly");
    expect(screen.getByTestId("ciclo-pro-yearly").textContent).toMatch(reais("1.899,00"));
    expect(resumo.textContent).toContain("12 meses");
    expect(resumo.textContent).toMatch(reais("489,00"));
    expect(resumo.textContent).toContain("(20%)");
  });

  it("plano sem preço semestral não oferece o semestral, só mensal e anual", () => {
    tela([SO_MENSAL_E_ANUAL]);
    escolherPlano("max");

    expect(screen.getByTestId("ciclo-max-monthly")).toBeInTheDocument();
    expect(screen.queryByTestId("ciclo-max-semiannual")).toBeNull();
    expect(screen.getByTestId("ciclo-max-yearly")).toBeInTheDocument();
  });

  it("voltar ao mensal esconde o resumo e força o cartão (o mensal não tem Pix)", async () => {
    iniciarAssinatura.mockResolvedValue({ tipo: "erro", mensagem: "parou aqui" });
    tela([PRO]);

    ateOPagamento("pro", "semiannual");
    fireEvent.click(within(screen.getByTestId("metodo-PIX")).getByRole("radio"));
    fireEvent.click(screen.getByTestId("voltar"));
    escolherCiclo("pro", "monthly");

    expect(screen.queryByTestId("resumo-pro-monthly")).toBeNull();
    continuar();
    expect(screen.queryByTestId("metodo-PIX")).toBeNull();
    ateOResumo();
    fireEvent.click(screen.getByTestId("assinar-pro"));
    await waitFor(() => expect(iniciarAssinatura).toHaveBeenCalledTimes(1));
    expect(iniciarAssinatura.mock.calls[0]![0]).toMatchObject({ planCode: "pro", ciclo: "monthly", metodo: "CREDIT_CARD" });
  });
});

describe("a tela pede ao servidor o ciclo e o método escolhidos", () => {
  it("semestral no cartão (padrão)", async () => {
    tela([PRO]);

    ateOPagamento("pro", "semiannual");
    ateOResumo();
    fireEvent.click(screen.getByTestId("assinar-pro"));

    await waitFor(() => expect(iniciarAssinatura).toHaveBeenCalledTimes(1));
    expect(iniciarAssinatura.mock.calls[0]![0]).toMatchObject({ planCode: "pro", ciclo: "semiannual", metodo: "CREDIT_CARD" });
  });

  it("anual no Pix", async () => {
    tela([PRO]);

    ateOPagamento("pro", "yearly");
    fireEvent.click(within(screen.getByTestId("metodo-PIX")).getByRole("radio"));
    ateOResumo();
    fireEvent.click(screen.getByTestId("assinar-pro"));

    await waitFor(() => expect(iniciarAssinatura).toHaveBeenCalledTimes(1));
    expect(iniciarAssinatura.mock.calls[0]![0]).toMatchObject({ planCode: "pro", ciclo: "yearly", metodo: "PIX" });
  });

  it("a entrada nunca leva preço, valor nem total: o servidor decide pelo catálogo", async () => {
    tela([PRO]);

    ateOPagamento("pro", "semiannual");
    ateOResumo();
    fireEvent.click(screen.getByTestId("assinar-pro"));

    await waitFor(() => expect(iniciarAssinatura).toHaveBeenCalledTimes(1));
    expect(Object.keys(iniciarAssinatura.mock.calls[0]![0] as object).sort()).toEqual(["chave", "ciclo", "metodo", "pagador", "planCode", "termosVersao"]);
  });
});

describe("os textos novos aparecem em espanhol", () => {
  it("rótulos e resumo do semestral em es", () => {
    tela([PRO], "es");
    escolherPlano();

    expect(screen.getByTestId("ciclo-pro-monthly")).toHaveTextContent("Mensual");
    escolherCiclo("pro", "semiannual");

    const resumo = screen.getByTestId("resumo-pro-semiannual");
    expect(resumo.textContent).toContain("Total del período");
    expect(resumo.textContent).toContain("Ahorro de");
    expect(resumo.textContent).toContain("frente al plan mensual");
  });

  it("os passos do fluxo também saem em es", () => {
    tela([PRO], "es");

    expect(screen.getByRole("navigation", { name: "Etapas de la suscripción" })).toBeInTheDocument();
    expect(screen.getByText("Elige el plan")).toBeInTheDocument();
    expect(screen.getByTestId("escolher-pro")).toHaveTextContent("Elegir");
  });
});

describe("D-133: aceite dos Termos de Uso na tela de compra", () => {
  it("sem marcar o aceite o Continuar do pagamento fica desligado e o resumo não abre, nada é enviado", () => {
    tela([PRO]);
    ateOPagamento("pro", "monthly");

    expect(screen.getByTestId("continuar")).toBeDisabled();
    fireEvent.click(screen.getByTestId("continuar"));
    expect(screen.queryByTestId("assinar-pro")).toBeNull();
    expect(iniciarAssinatura).not.toHaveBeenCalled();
  });

  it("o aceite tem o link para /legal/terms e, marcado, libera o caminho e manda a versão vigente", async () => {
    tela([PRO]);
    ateOPagamento("pro", "monthly");

    const link = screen.getByRole("link", { name: "Termos de Uso" });
    expect(link).toHaveAttribute("href", "/legal/terms");
    aceitarTermos();
    expect(screen.getByTestId("continuar")).not.toBeDisabled();
    continuar();
    expect(screen.getByTestId("assinar-pro")).not.toBeDisabled();
    fireEvent.click(screen.getByTestId("assinar-pro"));

    await waitFor(() => expect(iniciarAssinatura).toHaveBeenCalledTimes(1));
    expect(iniciarAssinatura.mock.calls[0]![0]).toMatchObject({ termosVersao: VERSAO_DOS_TERMOS });
  });

  it("o pacote de tokens também exige o aceite e manda a versão", async () => {
    comprarPacote.mockReset();
    comprarPacote.mockResolvedValue({ tipo: "erro", mensagem: "parou aqui" });
    render(
      <IdiomaProvider locale="pt-BR">
        <AssinarOuComprarClient
          planos={[]}
          pacotes={[{ codigo: "mil", nome: "Mil", tokens: 1000, precoCents: 5000 } as never]}
          precisaPagador={false}
          leituraFalhou={false}
        />
      </IdiomaProvider>,
    );

    expect(screen.getByTestId("comprar-mil")).toBeDisabled();
    fireEvent.click(document.getElementById("termos-pacote-mil") as HTMLElement);
    fireEvent.click(screen.getByTestId("comprar-mil"));
    await waitFor(() => expect(comprarPacote).toHaveBeenCalledTimes(1));
    expect(comprarPacote.mock.calls[0]![0]).toMatchObject({ pacote: "mil", termosVersao: VERSAO_DOS_TERMOS });
  });
});
