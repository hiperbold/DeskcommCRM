/**
 * A correção de revisão da fase F1: "a tela pode escrever?" na aba Plano
 * (`app/admin/(protected)/tenants/[id]/plano/page.tsx`) extraída para
 * `podeEscreverNaAba`, uma função pura, exatamente para não depender de
 * renderizar o Server Component para provar a régua.
 *
 * A régua: escopo `full` E as quatro leituras da aba (o plano efetivo, os
 * limites crus do plano contratado, o ajuste, e a lista de planos ativos)
 * sem erro. Qualquer uma das duas condições falhando tira os controles de
 * escrita, com o mesmo efeito visual.
 */
import { describe, expect, it } from "vitest";

import {
  algumaLeituraFalhou,
  podeEscreverNaAba,
  type LeiturasDaAbaDePlano,
} from "@/lib/billing/planos/pode-escrever-na-aba";

const TUDO_CERTO: LeiturasDaAbaDePlano = {
  leituraDoPlanoFalhou: false,
  leituraDosLimitesDoPlanoFalhou: false,
  leituraDoAjusteFalhou: false,
  leituraDosPlanosAtivosFalhou: false,
};

describe("podeEscreverNaAba", () => {
  it("escopo full com as quatro leituras certas: pode escrever", () => {
    expect(podeEscreverNaAba("full", TUDO_CERTO)).toBe(true);
  });

  it("escopo support_readonly, mesmo com as quatro leituras certas: não pode escrever", () => {
    expect(podeEscreverNaAba("support_readonly", TUDO_CERTO)).toBe(false);
  });

  it("escopo full, mas a leitura do plano (planoDaOrganizacao) falhou: não pode escrever", () => {
    expect(
      podeEscreverNaAba("full", { ...TUDO_CERTO, leituraDoPlanoFalhou: true }),
    ).toBe(false);
  });

  it("escopo full, mas a leitura dos limites crus do plano contratado falhou: não pode escrever", () => {
    expect(
      podeEscreverNaAba("full", { ...TUDO_CERTO, leituraDosLimitesDoPlanoFalhou: true }),
    ).toBe(false);
  });

  it("escopo full, mas a leitura do ajuste falhou: não pode escrever", () => {
    expect(
      podeEscreverNaAba("full", { ...TUDO_CERTO, leituraDoAjusteFalhou: true }),
    ).toBe(false);
  });

  it("escopo full, mas a leitura da lista de planos ativos falhou: não pode escrever", () => {
    expect(
      podeEscreverNaAba("full", { ...TUDO_CERTO, leituraDosPlanosAtivosFalhou: true }),
    ).toBe(false);
  });

  it("escopo desconhecido (nunca 'full'): não pode escrever, mesmo com leituras certas", () => {
    expect(podeEscreverNaAba("qualquer_outra_coisa", TUDO_CERTO)).toBe(false);
  });
});

describe("algumaLeituraFalhou", () => {
  it("as quatro leituras certas: falso", () => {
    expect(algumaLeituraFalhou(TUDO_CERTO)).toBe(false);
  });

  it("qualquer uma das quatro falhando: verdadeiro", () => {
    expect(algumaLeituraFalhou({ ...TUDO_CERTO, leituraDoPlanoFalhou: true })).toBe(true);
    expect(algumaLeituraFalhou({ ...TUDO_CERTO, leituraDosLimitesDoPlanoFalhou: true })).toBe(true);
    expect(algumaLeituraFalhou({ ...TUDO_CERTO, leituraDoAjusteFalhou: true })).toBe(true);
    expect(algumaLeituraFalhou({ ...TUDO_CERTO, leituraDosPlanosAtivosFalhou: true })).toBe(true);
  });

  it("todas as quatro falhando: verdadeiro", () => {
    expect(
      algumaLeituraFalhou({
        leituraDoPlanoFalhou: true,
        leituraDosLimitesDoPlanoFalhou: true,
        leituraDoAjusteFalhou: true,
        leituraDosPlanosAtivosFalhou: true,
      }),
    ).toBe(true);
  });
});
