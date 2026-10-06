/**
 * D-133: a versão dos Termos de Uso acompanha o texto. O aceite gravado no pedido e no onboarding
 * só diz alguma coisa se a versão muda quando o texto muda; este teste trava a impressão digital do
 * arquivo da página junto com a versão. Se ele falhou porque você editou os Termos: troque
 * `VERSAO_DOS_TERMOS` (`lib/legal/versao-dos-termos.ts`) para a data de hoje e atualize os dois
 * valores do registro abaixo.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { VERSAO_DOS_TERMOS } from "@/lib/legal/versao-dos-termos";

const REGISTRO = {
  versao: "2026-09-23",
  impressaoDaPagina: "5f0afbf045871a387e521ed3f8b61918a7bf75ca81cb87ce87334024b080f6ff",
};

describe("versão dos Termos de Uso", () => {
  it("é uma data AAAA-MM-DD", () => {
    expect(VERSAO_DOS_TERMOS).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("o texto da página dos Termos é o que a versão vigente descreve", () => {
    const pagina = readFileSync(join(process.cwd(), "app/legal/terms/page.tsx"), "utf8").replace(/\r\n/g, "\n");
    const impressao = createHash("sha256").update(pagina).digest("hex");
    expect(
      impressao,
      "o texto dos Termos mudou: atualize VERSAO_DOS_TERMOS e o registro deste teste",
    ).toBe(REGISTRO.impressaoDaPagina);
    expect(VERSAO_DOS_TERMOS).toBe(REGISTRO.versao);
  });
});
