/**
 * D-180: a tela `/app/settings/plano/assinar` é um passo a passo (1 Plano, 2 Ciclo, 3 Pagamento, 4 Resumo).
 * Aqui se mede o PASSO A PASSO: o indicador e o foco, avançar e voltar preservando a escolha, o resumo, o
 * aceite que segura o botão final, os erros no passo em que a pessoa está e a separação dos pacotes de tokens.
 * Os valores, o aceite e a entrada da ação são provados com a mesma régua de antes em
 * `venda-semestral-e-anual-tela.test.tsx` e `parcelamento-tela.test.tsx`; a ação de servidor é o limite.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const toastError = vi.fn();
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: (...args: unknown[]) => toastError(...args) } }));

const iniciarAssinatura = vi.fn();
const comprarPacote = vi.fn();
vi.mock("@/app/actions/settings/compraDoPlano", () => ({
  iniciarAssinatura: (...args: unknown[]) => iniciarAssinatura(...args),
  comprarPacote: (...args: unknown[]) => comprarPacote(...args),
}));

import { AssinarOuComprarClient } from "@/app/app/settings/plano/assinar/_client";
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
const MAX: PlanoParaVenda = {
  code: "max",
  name: "Max",
  version: 1,
  forSale: true,
  priceMonthlyCents: 39900,
  priceSemiannualCents: null,
  priceYearlyCents: 379900,
};
const ESCALE: PlanoParaVenda = {
  code: "escale",
  name: "Scale",
  version: 1,
  forSale: true,
  priceMonthlyCents: 79900,
  priceSemiannualCents: 429900,
  priceYearlyCents: 799900,
};

const OPCOES = {
  pro: {
    semiannual: opcoesDeParcelamento(104900, "semiannual", PARAMETROS),
    yearly: opcoesDeParcelamento(189900, "yearly", PARAMETROS),
  },
  max: { semiannual: [], yearly: opcoesDeParcelamento(379900, "yearly", PARAMETROS) },
  escale: {
    semiannual: opcoesDeParcelamento(429900, "semiannual", PARAMETROS),
    yearly: opcoesDeParcelamento(799900, "yearly", PARAMETROS),
  },
};

function tela(extra: { planoAtualCode?: string | null; precisaPagador?: boolean; pacotes?: never[] } = {}) {
  return render(
    <IdiomaProvider locale="pt-BR">
      <AssinarOuComprarClient
        planos={[PRO, MAX, ESCALE]}
        pacotes={extra.pacotes ?? []}
        precisaPagador={extra.precisaPagador ?? false}
        leituraFalhou={false}
        opcoesDeParcelas={OPCOES}
        taxaMensalPercentual={1.99}
        planoAtualCode={extra.planoAtualCode ?? null}
      />
    </IdiomaProvider>,
  );
}

const reais = (valor: string) => new RegExp(`R\\$\\s*${valor.replace(/\./g, "\\.")}`);
const passoAtual = () => {
  const itens = screen.getAllByRole("listitem").filter((li) => li.hasAttribute("data-testid") && /^indicador-passo-/.test(li.getAttribute("data-testid")!));
  return itens.filter((li) => li.getAttribute("aria-current") === "step").map((li) => li.getAttribute("data-testid"));
};
const titulo = () => screen.getByTestId("titulo-do-passo");
const continuar = () => fireEvent.click(screen.getByTestId("continuar"));
const voltar = () => fireEvent.click(screen.getByTestId("voltar"));
const aceitar = (code = "pro") => fireEvent.click(document.getElementById(`termos-plano-${code}`) as HTMLElement);

beforeEach(() => {
  iniciarAssinatura.mockReset();
  iniciarAssinatura.mockResolvedValue({ tipo: "erro", mensagem: "parou aqui" });
  comprarPacote.mockReset();
  toastError.mockReset();
});
afterEach(() => cleanup());

describe("passo 1: o plano", () => {
  it("mostra Pro, Max e Scale lado a lado, cada um com o preço mensal e o botão Escolher", () => {
    tela();

    for (const [code, preco] of [["pro", "199,00"], ["max", "399,00"], ["escale", "799,00"]] as const) {
      const cartao = screen.getByTestId(`plano-${code}`);
      expect(cartao.textContent).toContain("a partir de");
      expect(cartao.textContent).toMatch(reais(preco));
      expect(cartao.textContent).toContain("por mês");
      expect(within(cartao).getByRole("button", { name: /Escolher/ })).toBeInTheDocument();
    }
    // Só o que o catálogo tem: o Max não vende semestral e o cartão não promete esse ciclo.
    expect(screen.getByTestId("plano-max").textContent).toContain("Mensal, Anual");
    expect(screen.getByTestId("plano-pro").textContent).toContain("Mensal, Semestral, Anual");
    // As opções dos próximos passos ainda não aparecem.
    expect(screen.queryByTestId("passo-ciclo")).toBeNull();
    expect(screen.queryByTestId("passo-pagamento")).toBeNull();
  });

  it("marca o plano atual da organização, e só ele", () => {
    tela({ planoAtualCode: "max" });

    expect(within(screen.getByTestId("plano-max")).getByText("Plano atual")).toBeInTheDocument();
    expect(within(screen.getByTestId("plano-pro")).queryByText("Plano atual")).toBeNull();
    expect(screen.getAllByText("Plano atual")).toHaveLength(1);
  });

  it("sem plano atual nenhum cartão é marcado", () => {
    tela({ planoAtualCode: null });
    expect(screen.queryByText("Plano atual")).toBeNull();
  });

  it("cada cartão leva a 'Ver tudo incluso do plano', na seção de planos da página inicial, em nova aba", () => {
    tela({ planoAtualCode: null });
    for (const code of ["pro", "max", "escale"]) {
      const link = within(screen.getByTestId(`plano-${code}`)).getByRole("link", { name: "Ver tudo incluso do plano" });
      expect(link).toHaveAttribute("href", "/#planos");
      expect(link).toHaveAttribute("target", "_blank");
      expect(link.getAttribute("rel")).toContain("noopener");
    }
  });
});

describe("o indicador de passos e o foco", () => {
  it("o indicador tem os quatro passos nomeados e marca o passo atual com aria-current", () => {
    tela();

    const nav = screen.getByRole("navigation", { name: "Etapas da assinatura" });
    const itens = within(nav).getAllByRole("listitem");
    expect(itens.map((li) => li.textContent)).toEqual(["1Plano", "2Ciclo", "3Pagamento", "4Resumo"]);
    expect(passoAtual()).toEqual(["indicador-passo-1"]);

    fireEvent.click(screen.getByTestId("escolher-pro"));
    expect(passoAtual()).toEqual(["indicador-passo-2"]);
    continuar();
    expect(passoAtual()).toEqual(["indicador-passo-3"]);
    aceitar();
    continuar();
    expect(passoAtual()).toEqual(["indicador-passo-4"]);
  });

  it("ao avançar o foco vai para o título do passo novo, e ao voltar também", () => {
    tela();

    fireEvent.click(screen.getByTestId("escolher-pro"));
    expect(titulo()).toHaveTextContent("Escolha o ciclo de cobrança");
    expect(document.activeElement).toBe(titulo());

    continuar();
    expect(titulo()).toHaveTextContent("Como você quer pagar");
    expect(document.activeElement).toBe(titulo());

    aceitar();
    continuar();
    expect(titulo()).toHaveTextContent("Revise e confirme");
    expect(document.activeElement).toBe(titulo());

    voltar();
    expect(titulo()).toHaveTextContent("Como você quer pagar");
    expect(document.activeElement).toBe(titulo());
  });
});

describe("avançar e voltar preservando a escolha", () => {
  it("voltar do pagamento ao ciclo e do ciclo ao plano guarda o que já foi escolhido", () => {
    tela();

    fireEvent.click(screen.getByTestId("escolher-pro"));
    fireEvent.click(screen.getByTestId("ciclo-pro-semiannual"));
    continuar();
    fireEvent.click(within(screen.getByTestId("metodo-PIX")).getByRole("radio"));
    aceitar();

    voltar();
    expect(within(screen.getByTestId("ciclo-pro-semiannual")).getByRole("radio")).toBeChecked();
    voltar();
    expect(titulo()).toHaveTextContent("Escolha o plano");

    // Mesmo plano de novo: o ciclo, o Pix e o aceite continuam como estavam.
    fireEvent.click(screen.getByTestId("escolher-pro"));
    expect(within(screen.getByTestId("ciclo-pro-semiannual")).getByRole("radio")).toBeChecked();
    continuar();
    expect(within(screen.getByTestId("metodo-PIX")).getByRole("radio")).toBeChecked();
    expect(document.getElementById("termos-plano-pro")).toBeChecked();
  });

  it("a parcela escolhida volta marcada ao retornar do resumo", () => {
    tela();

    fireEvent.click(screen.getByTestId("escolher-pro"));
    fireEvent.click(screen.getByTestId("ciclo-pro-semiannual"));
    continuar();
    fireEvent.click(screen.getByTestId("parcelas-pro-4").querySelector("input") as HTMLElement);
    aceitar();
    continuar();
    voltar();

    expect(screen.getByTestId("parcelas-pro-4").querySelector("input")).toBeChecked();
  });

  it("trocar de plano recomeça o ciclo e a forma de pagamento (o ciclo antigo pode nem existir no outro plano)", () => {
    tela();

    fireEvent.click(screen.getByTestId("escolher-pro"));
    fireEvent.click(screen.getByTestId("ciclo-pro-semiannual"));
    voltar();
    fireEvent.click(screen.getByTestId("escolher-max"));

    expect(within(screen.getByTestId("ciclo-max-monthly")).getByRole("radio")).toBeChecked();
    expect(screen.queryByTestId("ciclo-max-semiannual")).toBeNull();
  });
});

describe("passo 4: o resumo", () => {
  it("cartão semestral em 4x: plano, ciclo, forma de pagamento, parcelas com juros e o total com juros", () => {
    tela();

    fireEvent.click(screen.getByTestId("escolher-pro"));
    fireEvent.click(screen.getByTestId("ciclo-pro-semiannual"));
    continuar();
    fireEvent.click(screen.getByTestId("parcelas-pro-4").querySelector("input") as HTMLElement);
    aceitar();
    continuar();

    expect(screen.getByTestId("resumo-plano")).toHaveTextContent("Pro");
    expect(screen.getByTestId("resumo-ciclo")).toHaveTextContent("Semestral");
    expect(screen.getByTestId("resumo-metodo")).toHaveTextContent("Cartão de crédito");
    const parcelas = screen.getByTestId("resumo-parcelas").textContent ?? "";
    expect(parcelas).toContain("4x");
    expect(parcelas).toMatch(reais("275,43"));
    expect(parcelas).toContain("com juros de 1,99% ao mês");
    expect(screen.getByTestId("resumo-total").textContent).toMatch(reais("1.101,72"));
    expect(screen.getByText(/Os dados do cartão são informados na fatura do Asaas/)).toBeInTheDocument();
  });

  it("cartão semestral em 3x: sem juros e a última parcela quando difere", () => {
    tela();

    fireEvent.click(screen.getByTestId("escolher-pro"));
    fireEvent.click(screen.getByTestId("ciclo-pro-semiannual"));
    continuar();
    fireEvent.click(screen.getByTestId("parcelas-pro-3").querySelector("input") as HTMLElement);
    aceitar();
    continuar();

    const parcelas = screen.getByTestId("resumo-parcelas").textContent ?? "";
    expect(parcelas).toContain("sem juros");
    expect(parcelas).toContain("última parcela");
    expect(parcelas).toMatch(reais("349,68"));
    expect(screen.getByTestId("resumo-total").textContent).toMatch(reais("1.049,00"));
  });

  it("Pix anual: sem linha de parcelas e o total é o preço do ciclo", () => {
    tela();

    fireEvent.click(screen.getByTestId("escolher-pro"));
    fireEvent.click(screen.getByTestId("ciclo-pro-yearly"));
    continuar();
    fireEvent.click(within(screen.getByTestId("metodo-PIX")).getByRole("radio"));
    aceitar();
    continuar();

    expect(screen.getByTestId("resumo-metodo")).toHaveTextContent("Pix");
    expect(screen.queryByTestId("resumo-parcelas")).toBeNull();
    expect(screen.getByTestId("resumo-total").textContent).toMatch(reais("1.899,00"));
    expect(screen.queryByText(/Os dados do cartão são informados na fatura do Asaas/)).toBeNull();
  });

  it("mensal: o total é o preço mensal, no cartão", () => {
    tela();

    fireEvent.click(screen.getByTestId("escolher-pro"));
    continuar();
    aceitar();
    continuar();

    expect(screen.getByTestId("resumo-ciclo")).toHaveTextContent("Mensal");
    expect(screen.getByTestId("resumo-total").textContent).toMatch(reais("199,00"));
    expect(screen.getByTestId("resumo-total").textContent).toContain("por mês");
  });

  it("cada linha tem Alterar que leva ao passo dela, e o resumo reflete a mudança", () => {
    tela();

    fireEvent.click(screen.getByTestId("escolher-pro"));
    fireEvent.click(screen.getByTestId("ciclo-pro-semiannual"));
    continuar();
    aceitar();
    continuar();

    fireEvent.click(within(screen.getByTestId("resumo-ciclo")).getByRole("button", { name: /Alterar/ }));
    expect(titulo()).toHaveTextContent("Escolha o ciclo de cobrança");
    fireEvent.click(screen.getByTestId("ciclo-pro-yearly"));
    continuar();
    continuar();
    expect(screen.getByTestId("resumo-ciclo")).toHaveTextContent("Anual");
    expect(screen.getByTestId("resumo-total").textContent).toMatch(reais("1.899,00"));

    fireEvent.click(within(screen.getByTestId("resumo-plano")).getByRole("button", { name: /Alterar/ }));
    expect(titulo()).toHaveTextContent("Escolha o plano");
    expect(passoAtual()).toEqual(["indicador-passo-1"]);

    fireEvent.click(screen.getByTestId("escolher-escale"));
    continuar();
    continuar();
    expect(screen.getByTestId("resumo-plano")).toHaveTextContent("Scale");
  });
});

describe("o botão final e o aceite dos Termos", () => {
  it("sem o aceite o Continuar do pagamento fica desligado e o resumo não abre; com ele, o botão final dispara a mesma ação", async () => {
    tela();

    fireEvent.click(screen.getByTestId("escolher-pro"));
    continuar();
    expect(screen.getByTestId("continuar")).toBeDisabled();
    expect(screen.queryByTestId("assinar-pro")).toBeNull();

    aceitar();
    expect(screen.getByTestId("continuar")).not.toBeDisabled();
    continuar();
    expect(screen.getByTestId("assinar-pro")).not.toBeDisabled();
    fireEvent.click(screen.getByTestId("assinar-pro"));

    await waitFor(() => expect(iniciarAssinatura).toHaveBeenCalledTimes(1));
    expect(iniciarAssinatura.mock.calls[0]![0]).toMatchObject({ planCode: "pro", ciclo: "monthly", metodo: "CREDIT_CARD" });
  });

  it("desmarcar o aceite ao voltar ao pagamento segura o caminho de novo, e a ação não é chamada", () => {
    tela();

    fireEvent.click(screen.getByTestId("escolher-pro"));
    continuar();
    aceitar();
    continuar();
    expect(screen.getByTestId("assinar-pro")).not.toBeDisabled();

    voltar();
    aceitar();
    expect(screen.getByTestId("continuar")).toBeDisabled();
    fireEvent.click(screen.getByTestId("continuar"));
    expect(screen.queryByTestId("assinar-pro")).toBeNull();
    expect(iniciarAssinatura).not.toHaveBeenCalled();
  });

  it("enquanto a ação roda o botão mostra Enviando e fica desligado (sem pedido duplo)", async () => {
    let terminar!: (v: unknown) => void;
    iniciarAssinatura.mockReturnValue(new Promise((resolve) => (terminar = resolve)));
    tela();

    fireEvent.click(screen.getByTestId("escolher-pro"));
    continuar();
    aceitar();
    continuar();
    fireEvent.click(screen.getByTestId("assinar-pro"));

    await waitFor(() => expect(screen.getByTestId("assinar-pro")).toHaveTextContent("Enviando..."));
    expect(screen.getByTestId("assinar-pro")).toBeDisabled();
    fireEvent.click(screen.getByTestId("assinar-pro"));
    expect(iniciarAssinatura).toHaveBeenCalledTimes(1);
    terminar({ tipo: "erro", mensagem: "parou aqui" });
    await waitFor(() => expect(screen.getByTestId("assinar-pro")).not.toBeDisabled());
  });
});

describe("mensagens de erro no passo certo", () => {
  it("a recusa da ação (ex.: pedido aberto, troca de ciclo indisponível) aparece no resumo e no toast, e dá para voltar e ajustar", async () => {
    const mensagem = "Sua assinatura atual ainda está no período pago em outro ciclo. A troca de ciclo ainda não está disponível: fale com o suporte ou contrate de novo depois do fim do período.";
    iniciarAssinatura.mockResolvedValue({ tipo: "erro", mensagem });
    tela();

    fireEvent.click(screen.getByTestId("escolher-pro"));
    fireEvent.click(screen.getByTestId("ciclo-pro-yearly"));
    continuar();
    aceitar();
    continuar();
    fireEvent.click(screen.getByTestId("assinar-pro"));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(mensagem));
    expect(toastError).toHaveBeenCalledWith(mensagem);
    expect(screen.getByTestId("passo-resumo")).toBeInTheDocument();

    // O erro some quando a pessoa muda de passo.
    fireEvent.click(within(screen.getByTestId("resumo-ciclo")).getByRole("button", { name: /Alterar/ }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("endereço de pagamento que não é do Asaas é recusado no resumo, sem navegar", async () => {
    iniciarAssinatura.mockResolvedValue({ tipo: "redirecionar", url: "https://evil.example/?next=https://asaas.com/" });
    tela();

    fireEvent.click(screen.getByTestId("escolher-pro"));
    continuar();
    aceitar();
    continuar();
    fireEvent.click(screen.getByTestId("assinar-pro"));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("o endereço de pagamento não é reconhecido"));
  });

  it("falha inesperada da ação mostra a frase de tentar de novo no resumo e libera o botão", async () => {
    iniciarAssinatura.mockRejectedValue(new Error("rede"));
    tela();

    fireEvent.click(screen.getByTestId("escolher-pro"));
    continuar();
    aceitar();
    continuar();
    fireEvent.click(screen.getByTestId("assinar-pro"));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Tente novamente em instantes"));
    expect(screen.getByTestId("assinar-pro")).not.toBeDisabled();
  });

  it("primeira compra: o formulário do pagador é conferido no passo de pagamento, o erro aparece ali e a ação não é chamada", () => {
    tela({ precisaPagador: true });

    fireEvent.click(screen.getByTestId("escolher-pro"));
    continuar();
    aceitar();
    continuar();

    expect(screen.getByRole("alert")).toHaveTextContent("Informe o nome de quem paga.");
    expect(screen.getByTestId("passo-pagamento")).toBeInTheDocument();
    expect(screen.queryByTestId("assinar-pro")).toBeNull();
    expect(iniciarAssinatura).not.toHaveBeenCalled();
  });

  it("primeira compra com o formulário certo: o pagador vai na entrada da ação", async () => {
    tela({ precisaPagador: true });

    fireEvent.click(screen.getByTestId("escolher-pro"));
    continuar();
    fireEvent.change(document.getElementById("pagador-plano-pro-nome") as HTMLElement, { target: { value: "Maria Souza" } });
    fireEvent.change(document.getElementById("pagador-plano-pro-documento") as HTMLElement, { target: { value: "529.982.247-25" } });
    aceitar();
    continuar();
    fireEvent.click(screen.getByTestId("assinar-pro"));

    await waitFor(() => expect(iniciarAssinatura).toHaveBeenCalledTimes(1));
    expect(iniciarAssinatura.mock.calls[0]![0]).toMatchObject({ pagador: { nome: "Maria Souza", documento: "529.982.247-25" } });
  });
});

describe("pacotes de tokens ficam fora do passo a passo", () => {
  it("a seção de pacotes é separada da seção de planos e a compra continua a mesma", async () => {
    comprarPacote.mockResolvedValue({ tipo: "erro", mensagem: "parou aqui" });
    tela({ pacotes: [{ codigo: "mil", nome: "Mil", tokens: 1000, precoCents: 5000 }] as never[] });

    const planos = document.getElementById("planos") as HTMLElement;
    const pacotes = document.getElementById("pacotes") as HTMLElement;
    expect(planos).not.toContainElement(pacotes);
    expect(within(planos).queryByTestId("comprar-mil")).toBeNull();
    expect(within(pacotes).getByTestId("comprar-mil")).toBeDisabled();

    // Escolher um plano não mexe nos pacotes.
    fireEvent.click(screen.getByTestId("escolher-pro"));
    expect(within(pacotes).getByTestId("comprar-mil")).toBeInTheDocument();

    fireEvent.click(document.getElementById("termos-pacote-mil") as HTMLElement);
    fireEvent.click(screen.getByTestId("comprar-mil"));
    await waitFor(() => expect(comprarPacote).toHaveBeenCalledTimes(1));
    expect(comprarPacote.mock.calls[0]![0]).toMatchObject({ pacote: "mil" });
  });
});
