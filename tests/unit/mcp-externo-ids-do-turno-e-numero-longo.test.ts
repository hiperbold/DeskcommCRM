import { describe, expect, it } from "vitest";

import { MARCA_DE_REMOCAO, limparArgumentosExternos } from "@/lib/ai/mcp-externo/sem-dado-de-cliente";

/**
 * D-134: a trava de argumentos do MCP externo passa a conhecer os ids do
 * contato e da conversa do turno, trata número de 10+ dígitos como sequência
 * longa e aceita o nono dígito solto no telefone.
 */

const ORG = "3f2a1b4c-5d6e-4f70-8a91-b2c3d4e5f607";
const CONTATO = "2c7e1f3a-5b9d-4e8a-9c21-7d4f6a0b3e15";
const CONVERSA = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";

describe("ids do cliente do turno", () => {
  it("o contact_id copiado para um campo livre é retirado", () => {
    const r = limparArgumentosExternos({ observacao: `cliente ${CONTATO} procura um sedã` }, [ORG, CONTATO, CONVERSA]);
    expect(r.limpos.observacao).toBe(`cliente ${MARCA_DE_REMOCAO} procura um sedã`);
    expect(r.recusados).toContain("observacao:id_da_instalacao");
    expect(JSON.stringify(r.recusados)).not.toContain(CONTATO);
  });

  it("o id da conversa também", () => {
    const r = limparArgumentosExternos({ ref: CONVERSA.toUpperCase() }, [ORG, CONTATO, CONVERSA]);
    expect(r.limpos.ref).toBe(MARCA_DE_REMOCAO);
  });

  it("sem os ids do turno o uuid passa (o ida e volta com o servidor externo continua valendo)", () => {
    expect(limparArgumentosExternos({ ref: CONTATO }, [ORG]).limpos.ref).toBe(CONTATO);
  });

  it("uuid de outro sistema passa mesmo com os ids do turno conhecidos", () => {
    const deles = "5e8f0a1b-3c4d-4a6e-b7f2-9a1c3e5d7b02";
    expect(limparArgumentosExternos({ id: deles }, [ORG, CONTATO, CONVERSA]).limpos.id).toBe(deles);
  });
});

describe("telefone como número ou com o nono dígito solto", () => {
  it("número inteiro de 10 a 14 dígitos fora de campo de código vira null", () => {
    for (const n of [3591485627, 35991485627, 5535991485627]) {
      const r = limparArgumentosExternos({ procura: n });
      expect(r.limpos.procura, String(n)).toBeNull();
      expect(r.recusados).toContain("procura:sequencia_longa");
    }
  });

  it("número em campo de código (EAN, SKU) continua passando", () => {
    const r = limparArgumentosExternos({ ean: 7891234567895, sku: 1234567890123 });
    expect(r.limpos).toEqual({ ean: 7891234567895, sku: 1234567890123 });
  });

  it("número comum (preço, ano, quantidade, CEP) continua passando", () => {
    const r = limparArgumentosExternos({ preco_max: 85000, ano: 2021, limite: 20, cep: 37800000 });
    expect(r.limpos).toEqual({ preco_max: 85000, ano: 2021, limite: 20, cep: 37800000 });
  });

  it("número aninhado também é pego", () => {
    const r = limparArgumentosExternos({ filtro: { contato: { valor: 35991485627 } } });
    expect(JSON.stringify(r.limpos)).not.toContain("35991485627");
  });

  it("telefone com o nono dígito separado: '35 9 9148 5627'", () => {
    const r = limparArgumentosExternos({ busca: "ligar para 35 9 9148 5627 amanhã" });
    expect(r.limpos.busca).toBe(`ligar para ${MARCA_DE_REMOCAO} amanhã`);
  });

  it("e as formas de sempre seguem recusadas", () => {
    for (const t of ["+55 35 99148-5627", "(35) 99148-5627", "35991485627", "(35) 9148-5627"]) {
      expect(limparArgumentosExternos({ busca: t }).limpos.busca, t).toBe(MARCA_DE_REMOCAO);
    }
  });

  it("não confunde preço e ano com telefone", () => {
    const r = limparArgumentosExternos({ busca: "civic 2021 por até 85.000 com 45 mil km" });
    expect(r.limpos.busca).toBe("civic 2021 por até 85.000 com 45 mil km");
  });
});
