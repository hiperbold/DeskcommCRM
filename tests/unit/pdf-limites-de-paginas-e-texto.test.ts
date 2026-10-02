// @vitest-environment node
//
// D-157: um PDF não pode derrubar o app de todas as organizações. A extração
// dentro do processo do Next tem teto de páginas, de texto e de tempo; o filho
// do worker recebe os mesmos tetos.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  extractPdfText,
  MAX_CARACTERES_DO_PDF,
  MAX_PAGINAS_DO_PDF,
  PdfExtractError,
} from "@/lib/ai/rag/extractors/pdf";

const multipagina = () => readFileSync(join(process.cwd(), "tests/fixtures/sample-multipagina.pdf"));
const ESTRATEGIAS = ["em-processo", "processo-a-parte"] as const;

describe("tetos da extração de PDF", () => {
  it("os tetos padrão existem e são finitos", () => {
    expect(MAX_PAGINAS_DO_PDF).toBeGreaterThan(0);
    expect(MAX_PAGINAS_DO_PDF).toBeLessThan(10_000);
    expect(MAX_CARACTERES_DO_PDF).toBeLessThan(50_000_000);
  });

  it.each(ESTRATEGIAS)("[%s] PDF com mais páginas que o teto é recusado, sem ler o texto", async (estrategia) => {
    const erro = await extractPdfText(multipagina(), { estrategia, maxPaginas: 1 }).catch((e) => e);
    expect(erro).toBeInstanceOf(PdfExtractError);
    // No filho o erro chega embrulhado pela frase genérica do pai; a causa fica no log.
    if (estrategia === "em-processo") expect(String((erro as Error).message)).toContain("limite");
  });

  it.each(ESTRATEGIAS)("[%s] teto de caracteres: a leitura para e o texto sai truncado", async (estrategia) => {
    const texto = await extractPdfText(multipagina(), { estrategia, maxCaracteres: 10 });
    expect(texto.length).toBeLessThanOrEqual(10);
    expect(texto.length).toBeGreaterThan(0);
  });

  it.each(ESTRATEGIAS)("[%s] dentro dos tetos o texto sai inteiro, como antes", async (estrategia) => {
    expect(await extractPdfText(multipagina(), { estrategia })).toBe(
      "Pagina um linha um\nPagina um linha dois\n\nPagina dois linha um\nPagina dois linha dois",
    );
  });
});
