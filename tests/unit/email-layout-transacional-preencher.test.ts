import { describe, expect, it } from "vitest";

import { preencher } from "@/lib/email/templates/_layout-transacional";

/**
 * `preencher` troca `{chave}` por valor em passe ÚNICO: o valor entra como está e nunca é reprocessado. Antes, a
 * troca era chave a chave, e uma empresa chamada `{plano}` virava o nome do plano quando a chave `plano` vinha
 * depois de `empresa`.
 */
describe("preencher", () => {
  it("troca todas as ocorrências de cada chave", () => {
    expect(preencher("{a} e {a} e {b}", { a: "1", b: 2 })).toBe("1 e 1 e 2");
  });

  it("valor que contém um marcador não é reprocessado, qualquer que seja a ordem das chaves", () => {
    const texto = "A {empresa} assinou o plano {plano}.";
    expect(preencher(texto, { empresa: "{plano}", plano: "Pro" })).toBe("A {plano} assinou o plano Pro.");
    expect(preencher(texto, { plano: "Pro", empresa: "{plano}" })).toBe("A {plano} assinou o plano Pro.");
    expect(preencher("{x} {y}", { x: "{y}", y: "{x}" })).toBe("{y} {x}");
  });

  it("marcador sem valor correspondente fica como veio", () => {
    expect(preencher("Olá {nome}, {desconhecido}", { nome: "Ana" })).toBe("Olá Ana, {desconhecido}");
  });

  it("padrões especiais do String.replace no valor não valem ($&, $1, $$)", () => {
    expect(preencher("Empresa {nome}", { nome: "A$&B$1$$C" })).toBe("Empresa A$&B$1$$C");
  });

  it("chave herdada do protótipo não é valor (constructor, toString)", () => {
    expect(preencher("{constructor} {toString}", {})).toBe("{constructor} {toString}");
  });

  it("texto sem marcador passa intacto", () => {
    expect(preencher("sem nada", { a: "1" })).toBe("sem nada");
  });
});
