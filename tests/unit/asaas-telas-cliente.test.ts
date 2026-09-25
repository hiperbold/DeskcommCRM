import { describe, expect, it } from "vitest";

import {
  chaveParaProximaTentativaDeCompra,
  classificarDesfechoDaTentativa,
  devePararDePollarPedido,
  MENSAGEM_AGUARDE_ESPELHO,
  montarPagadorDoFormulario,
  pedidoEmEstadoFinal,
  TETO_DE_POLLING_MS,
  urlDeRedirecionamentoEhSegura,
  type EscolhaDeCompra,
} from "@/app/app/settings/plano/_logica-compra";
import { MENSAGEM_AGUARDE } from "@/lib/billing/asaas/compra";

/**
 * Fase F5, Tarefas 20 e 21: a lógica pura das telas do cliente (assinar e
 * pedido): validação da URL de redirecionamento (risco 8), a régua de
 * quando o polling do pedido para, e a montagem do formulário do pagador.
 * Nada de mock do próprio código: são funções puras, exercitadas direto.
 */

describe("urlDeRedirecionamentoEhSegura: risco 8, redirecionamento aberto", () => {
  it("aceita os três prefixos oficiais do Asaas, com caminho", () => {
    expect(urlDeRedirecionamentoEhSegura("https://www.asaas.com/i/abc123")).toBe(true);
    expect(urlDeRedirecionamentoEhSegura("https://asaas.com/i/abc123")).toBe(true);
    expect(urlDeRedirecionamentoEhSegura("https://sandbox.asaas.com/i/abc123")).toBe(true);
  });

  it("recusa outro domínio", () => {
    expect(urlDeRedirecionamentoEhSegura("https://evil.com/")).toBe(false);
  });

  it("recusa o prefixo oficial embutido depois de outro host (open redirect clássico)", () => {
    expect(urlDeRedirecionamentoEhSegura("https://evil.com/?next=https://asaas.com/")).toBe(false);
  });

  it("recusa um subdomínio de phishing que só CONTÉM o nome oficial", () => {
    expect(urlDeRedirecionamentoEhSegura("https://asaas.com.evil.com/")).toBe(false);
  });

  it("recusa http (sem TLS)", () => {
    expect(urlDeRedirecionamentoEhSegura("http://asaas.com/")).toBe(false);
  });

  it("recusa string vazia", () => {
    expect(urlDeRedirecionamentoEhSegura("")).toBe(false);
  });
});

describe("pedidoEmEstadoFinal / devePararDePollarPedido: parada em estado final e em 10 min", () => {
  it("todo estado final do pedido é reconhecido", () => {
    for (const status of ["pago", "vencido", "cancelado", "falhou", "estornado"]) {
      expect(pedidoEmEstadoFinal(status)).toBe(true);
    }
  });

  it("estado aberto não é final", () => {
    for (const status of ["criado", "processando", "aguardando_pagamento", "inconclusivo"]) {
      expect(pedidoEmEstadoFinal(status)).toBe(false);
    }
  });

  it("para assim que vê um estado final, mesmo bem antes do teto de tempo", () => {
    expect(devePararDePollarPedido("pago", 0)).toBe(true);
    expect(devePararDePollarPedido("cancelado", 1_000)).toBe(true);
  });

  it("continua pollando em estado aberto, dentro do teto de 10 minutos", () => {
    expect(devePararDePollarPedido("aguardando_pagamento", 0)).toBe(false);
    expect(devePararDePollarPedido("aguardando_pagamento", TETO_DE_POLLING_MS - 1)).toBe(false);
  });

  it("para ao estourar o teto de 10 minutos, mesmo sem estado final (e mesmo sem status nenhum ainda)", () => {
    expect(devePararDePollarPedido("aguardando_pagamento", TETO_DE_POLLING_MS)).toBe(true);
    expect(devePararDePollarPedido(null, TETO_DE_POLLING_MS)).toBe(true);
  });

  it("sem status ainda (antes da primeira resposta) e dentro do teto, não para", () => {
    expect(devePararDePollarPedido(null, 0)).toBe(false);
  });
});

describe("montarPagadorDoFormulario: decisão 16, dados do pagador", () => {
  const CAMPOS_VALIDOS = { nome: "Maria da Silva", documento: "123.456.789-09", email: "", celular: "" };

  it("monta o pagador com nome e documento, sem email/celular quando vazios", () => {
    const r = montarPagadorDoFormulario(CAMPOS_VALIDOS);
    expect(r).toEqual({
      ok: true,
      pagador: { nome: "Maria da Silva", documento: "123.456.789-09" },
    });
  });

  it("inclui email e celular só quando preenchidos, já sem espaço nas pontas", () => {
    const r = montarPagadorDoFormulario({
      nome: "  Maria da Silva  ",
      documento: "123.456.789-09",
      email: " maria@exemplo.com ",
      celular: " 11999998888 ",
    });
    expect(r).toEqual({
      ok: true,
      pagador: {
        nome: "Maria da Silva",
        documento: "123.456.789-09",
        email: "maria@exemplo.com",
        celular: "11999998888",
      },
    });
  });

  it("aceita CNPJ (14 dígitos), com ou sem pontuação", () => {
    const r = montarPagadorDoFormulario({ ...CAMPOS_VALIDOS, documento: "12.345.678/0001-99" });
    expect(r.ok).toBe(true);
  });

  it("recusa nome vazio (só espaço)", () => {
    const r = montarPagadorDoFormulario({ ...CAMPOS_VALIDOS, nome: "   " });
    expect(r).toEqual({ ok: false, erro: "Informe o nome de quem paga." });
  });

  it("recusa documento com quantidade de dígitos errada", () => {
    const r = montarPagadorDoFormulario({ ...CAMPOS_VALIDOS, documento: "123" });
    expect(r).toEqual({ ok: false, erro: "Informe um CPF ou CNPJ válido." });
  });

  it("recusa e-mail em formato inválido", () => {
    const r = montarPagadorDoFormulario({ ...CAMPOS_VALIDOS, email: "não-é-email" });
    expect(r).toEqual({ ok: false, erro: "Informe um e-mail válido, ou deixe em branco." });
  });

  it("e-mail em branco não é erro (é opcional)", () => {
    const r = montarPagadorDoFormulario({ ...CAMPOS_VALIDOS, email: "   " });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.pagador.email).toBeUndefined();
  });
});

describe("MENSAGEM_AGUARDE_ESPELHO: nunca diverge do original server-only (correção 6)", () => {
  it("é IDÊNTICA a MENSAGEM_AGUARDE de lib/billing/asaas/compra.ts", () => {
    expect(MENSAGEM_AGUARDE_ESPELHO).toBe(MENSAGEM_AGUARDE);
  });
});

describe("classificarDesfechoDaTentativa: correção 6", () => {
  it("erro com a mensagem de aguarde é 'aguarde'", () => {
    expect(classificarDesfechoDaTentativa({ tipo: "erro", mensagem: MENSAGEM_AGUARDE_ESPELHO })).toBe("aguarde");
  });

  it("qualquer outra mensagem de erro é terminal", () => {
    expect(classificarDesfechoDaTentativa({ tipo: "erro", mensagem: "Este pedido já foi pago." })).toBe("terminal");
    expect(classificarDesfechoDaTentativa({ tipo: "erro", mensagem: "O CPF ou CNPJ informado é inválido." })).toBe(
      "terminal",
    );
  });

  it("redirecionar e pix (sucesso) contam como terminal: não há próxima tentativa nesta mesma tela", () => {
    expect(classificarDesfechoDaTentativa({ tipo: "redirecionar" })).toBe("terminal");
    expect(classificarDesfechoDaTentativa({ tipo: "pix" })).toBe("terminal");
  });
});

describe("chaveParaProximaTentativaDeCompra: correção 6, decisão 13 do lado do cliente", () => {
  const ASSINATURA_PRO_MENSAL_CARTAO: EscolhaDeCompra = {
    tipo: "assinatura",
    planCode: "pro",
    ciclo: "monthly",
    metodo: "CREDIT_CARD",
  };

  it("sem tentativa anterior, sempre gera uma chave (não reaproveita a inicial às cegas)", () => {
    const chave = chaveParaProximaTentativaDeCompra({
      chaveAtual: "chave-inicial",
      escolhaAtual: ASSINATURA_PRO_MENSAL_CARTAO,
      tentativaAnterior: null,
    });
    expect(typeof chave).toBe("string");
    expect(chave.length).toBeGreaterThan(0);
  });

  it("mesma escolha depois de 'aguarde': repete a MESMA chave", () => {
    const chave = chaveParaProximaTentativaDeCompra({
      chaveAtual: "chave-em-voo",
      escolhaAtual: ASSINATURA_PRO_MENSAL_CARTAO,
      tentativaAnterior: { escolha: ASSINATURA_PRO_MENSAL_CARTAO, desfecho: "aguarde" },
    });
    expect(chave).toBe("chave-em-voo");
  });

  it("mudou o ciclo depois de 'aguarde': chave NOVA, mesmo com o mesmo plano e método", () => {
    const chave = chaveParaProximaTentativaDeCompra({
      chaveAtual: "chave-em-voo",
      escolhaAtual: { ...ASSINATURA_PRO_MENSAL_CARTAO, ciclo: "yearly" },
      tentativaAnterior: { escolha: ASSINATURA_PRO_MENSAL_CARTAO, desfecho: "aguarde" },
    });
    expect(chave).not.toBe("chave-em-voo");
  });

  it("mudou o método depois de 'aguarde': chave NOVA", () => {
    const chave = chaveParaProximaTentativaDeCompra({
      chaveAtual: "chave-em-voo",
      escolhaAtual: { ...ASSINATURA_PRO_MENSAL_CARTAO, metodo: "PIX" },
      tentativaAnterior: { escolha: ASSINATURA_PRO_MENSAL_CARTAO, desfecho: "aguarde" },
    });
    expect(chave).not.toBe("chave-em-voo");
  });

  it("mudou o plano depois de 'aguarde': chave NOVA", () => {
    const chave = chaveParaProximaTentativaDeCompra({
      chaveAtual: "chave-em-voo",
      escolhaAtual: { ...ASSINATURA_PRO_MENSAL_CARTAO, planCode: "ilimitado" },
      tentativaAnterior: { escolha: ASSINATURA_PRO_MENSAL_CARTAO, desfecho: "aguarde" },
    });
    expect(chave).not.toBe("chave-em-voo");
  });

  it("mesma escolha, mas desfecho anterior TERMINAL (validação, falhou, cancelado): chave NOVA", () => {
    for (const mensagem of [
      "Este pedido já foi pago.",
      "Este pedido já falhou. Não há nada para cancelar.",
      "O CPF ou CNPJ informado é inválido.",
    ]) {
      const desfecho = classificarDesfechoDaTentativa({ tipo: "erro", mensagem });
      const chave = chaveParaProximaTentativaDeCompra({
        chaveAtual: "chave-anterior",
        escolhaAtual: ASSINATURA_PRO_MENSAL_CARTAO,
        tentativaAnterior: { escolha: ASSINATURA_PRO_MENSAL_CARTAO, desfecho },
      });
      expect(chave).not.toBe("chave-anterior");
    }
  });

  it("pacote de tokens: mesma escolha (pacote + método) depois de 'aguarde' repete a chave; mudar o pacote não", () => {
    const escolhaPacote: EscolhaDeCompra = { tipo: "pacote_tokens", pacote: "mil-tokens", metodo: "PIX" };

    const repetida = chaveParaProximaTentativaDeCompra({
      chaveAtual: "chave-pacote",
      escolhaAtual: escolhaPacote,
      tentativaAnterior: { escolha: escolhaPacote, desfecho: "aguarde" },
    });
    expect(repetida).toBe("chave-pacote");

    const nova = chaveParaProximaTentativaDeCompra({
      chaveAtual: "chave-pacote",
      escolhaAtual: { ...escolhaPacote, pacote: "dez-mil-tokens" },
      tentativaAnterior: { escolha: escolhaPacote, desfecho: "aguarde" },
    });
    expect(nova).not.toBe("chave-pacote");
  });

  it("trocar de assinatura para pacote (ou vice-versa) nunca reaproveita a chave, mesmo com 'aguarde'", () => {
    const escolhaPacote: EscolhaDeCompra = { tipo: "pacote_tokens", pacote: "mil-tokens", metodo: "PIX" };
    const chave = chaveParaProximaTentativaDeCompra({
      chaveAtual: "chave-anterior",
      escolhaAtual: escolhaPacote,
      tentativaAnterior: { escolha: ASSINATURA_PRO_MENSAL_CARTAO, desfecho: "aguarde" },
    });
    expect(chave).not.toBe("chave-anterior");
  });
});
