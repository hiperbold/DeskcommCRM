import { describe, expect, it } from "vitest";

import { CATALOGO_DA_INSTALACAO, definicaoParaATela } from "@/lib/instalacao/catalogo";

/**
 * O catálogo vai do servidor (a página) para componentes de cliente. O React
 * recusa função na fronteira ("Functions cannot be passed directly to Client
 * Components"), e as chaves de servidor de QR Code trazem `validar` e
 * `normalizar`. Foi o que derrubou /admin/configuracao no CI.
 */
describe("definicaoParaATela", () => {
  it("o catálogo tem função (senão o caso abaixo não prova nada)", () => {
    const comFuncao = CATALOGO_DA_INSTALACAO.filter((d) => Object.values(d).some((v) => typeof v === "function"));
    expect(comFuncao.length).toBeGreaterThan(0);
  });

  it("nenhuma definição entregue à tela carrega função, e todas sobrevivem a JSON", () => {
    for (const d of CATALOGO_DA_INSTALACAO) {
      const tela = definicaoParaATela(d);
      const funcoes = Object.entries(tela).filter(([, v]) => typeof v === "function");
      expect(funcoes, d.chave).toEqual([]);
      expect(JSON.parse(JSON.stringify(tela)), d.chave).toEqual(tela);
    }
  });

  it("mantém o que a tela usa", () => {
    for (const d of CATALOGO_DA_INSTALACAO) {
      const tela = definicaoParaATela(d);
      expect(tela.chave).toBe(d.chave);
      expect(tela.rotulo).toBe(d.rotulo);
      expect(tela.explicacao).toBe(d.explicacao);
      expect(tela.natureza).toBe(d.natureza);
      expect(tela.controle).toBe(d.controle);
      expect(tela.grupo).toBe(d.grupo);
      expect(tela.motivo).toBe(d.motivo);
      expect(tela.comoTrocar).toBe(d.comoTrocar);
    }
  });
});
