/**
 * `lib/billing/asaas/documento.ts`: validação de CPF/CNPJ por dígito
 * verificador (fase F5, Tarefa 10, decisão 16).
 */
import { describe, expect, it } from "vitest";

import { cnpjValido, cpfValido, documentoValido } from "@/lib/billing/asaas/documento";

describe("cpfValido", () => {
  it("aceita um CPF válido conhecido, com e sem máscara", () => {
    expect(cpfValido("111.444.777-35")).toBe(true);
    expect(cpfValido("11144477735")).toBe(true);
  });

  it("recusa o mesmo número com o último dígito trocado", () => {
    expect(cpfValido("111.444.777-36")).toBe(false);
  });

  it("recusa sequência de dígitos repetidos (000.000.000-00, 111.111.111-11)", () => {
    expect(cpfValido("000.000.000-00")).toBe(false);
    expect(cpfValido("111.111.111-11")).toBe(false);
  });

  it("recusa comprimento errado", () => {
    expect(cpfValido("123")).toBe(false);
    expect(cpfValido("111.444.777-355")).toBe(false);
  });
});

describe("cnpjValido", () => {
  it("aceita um CNPJ válido conhecido, com e sem máscara", () => {
    expect(cnpjValido("11.222.333/0001-81")).toBe(true);
    expect(cnpjValido("11222333000181")).toBe(true);
  });

  it("recusa o mesmo número com o último dígito trocado", () => {
    expect(cnpjValido("11.222.333/0001-82")).toBe(false);
  });

  it("recusa sequência de dígitos repetidos", () => {
    expect(cnpjValido("00.000.000/0000-00")).toBe(false);
  });

  it("recusa comprimento errado", () => {
    expect(cnpjValido("123")).toBe(false);
  });
});

describe("documentoValido", () => {
  it("roteia CPF (11 dígitos) e CNPJ (14 dígitos) para o validador certo", () => {
    expect(documentoValido("111.444.777-35")).toBe(true);
    expect(documentoValido("11.222.333/0001-81")).toBe(true);
  });

  it("recusa quantidade de dígitos que não é nem CPF nem CNPJ", () => {
    expect(documentoValido("123456")).toBe(false);
    expect(documentoValido("")).toBe(false);
  });
});
