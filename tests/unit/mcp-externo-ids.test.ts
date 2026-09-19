import { describe, expect, it } from "vitest";
import {
  apelidoValido,
  ehFerramentaExterna,
  lerIdDaFerramenta,
  montarIdDaFerramenta,
  separarFerramentas,
} from "@/lib/ai/mcp-externo/ids";

describe("id da ferramenta externa", () => {
  it("monta mcp_<apelido>__<nome>", () => {
    expect(montarIdDaFerramenta("imoveis", "buscar_imoveis")).toBe("mcp_imoveis__buscar_imoveis");
  });

  it("recusa nome que o modelo não aceita (espaço, ponto, acento)", () => {
    expect(montarIdDaFerramenta("imoveis", "buscar imóveis")).toBeNull();
    expect(montarIdDaFerramenta("imoveis", "buscar.imoveis")).toBeNull();
  });

  it("recusa id acima de 64 caracteres, o teto dos provedores", () => {
    expect(montarIdDaFerramenta("abcdefghijkl", "x".repeat(60))).toBeNull();
  });

  it("apelido: 2 a 12, minúsculas e dígitos", () => {
    expect(apelidoValido("n8n")).toBe(true);
    expect(apelidoValido("N8N")).toBe(false);
    expect(apelidoValido("a")).toBe(false);
    expect(apelidoValido("com-traco")).toBe(false);
  });

  it("lê de volta e reconhece", () => {
    expect(lerIdDaFerramenta("mcp_ctx7__resolve-library-id")).toEqual({
      apelido: "ctx7",
      nome: "resolve-library-id",
    });
    expect(ehFerramentaExterna("crm_move_lead_stage")).toBe(false);
  });

  it("separa catálogo de externas sem perder a ordem", () => {
    expect(separarFerramentas(["crm_list_tags", "mcp_n8n__busca", "crm_update_lead"])).toEqual({
      catalogo: ["crm_list_tags", "crm_update_lead"],
      externas: ["mcp_n8n__busca"],
    });
  });
});
