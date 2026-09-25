import { describe, expect, it } from "vitest";

import {
  devePararDePollarPedido,
  montarPagadorDoFormulario,
  pedidoEmEstadoFinal,
  TETO_DE_POLLING_MS,
  urlDeRedirecionamentoEhSegura,
} from "@/app/app/settings/plano/_logica-compra";

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
