/**
 * D-037: dado de cliente não sai nos argumentos de ferramenta MCP externa.
 *
 * Os dois lados importam igual. Deixar passar telefone e e-mail é o vazamento
 * que a trava existe para impedir; recusar código de barras e faixa de preço
 * quebraria a consulta de catálogo, que é o uso real das conexões MCP. Por
 * isso metade deste arquivo é sobre o que TEM que passar.
 */
import { describe, expect, it } from "vitest";

import { MARCA_DE_REMOCAO, limparArgumentosExternos } from "@/lib/ai/mcp-externo/sem-dado-de-cliente";

const ORG = "3f2a1b4c-5d6e-4f70-8a91-b2c3d4e5f607";

describe("o que não sai", () => {
  it("telefone no meio de um texto livre", () => {
    const r = limparArgumentosExternos({ busca: "imóvel para o cliente, contato +55 35 99148-5627" });
    expect(r.limpos.busca).toBe(`imóvel para o cliente, contato ${MARCA_DE_REMOCAO}`);
    expect(r.recusados).toContain("busca:telefone");
  });

  it("telefone cru, sem pontuação", () => {
    const r = limparArgumentosExternos({ q: "5535991485627" });
    expect(r.limpos.q).toBe(MARCA_DE_REMOCAO);
  });

  it("e-mail", () => {
    const r = limparArgumentosExternos({ nota: "mandar para joao.silva@exemplo.test depois" });
    expect(r.limpos.nota).toBe(`mandar para ${MARCA_DE_REMOCAO} depois`);
    expect(r.recusados).toContain("nota:email");
  });

  it("endereço de WhatsApp", () => {
    const r = limparArgumentosExternos({ de: "5535991485627@s.whatsapp.net" });
    expect(r.limpos.de).toBe(MARCA_DE_REMOCAO);
    expect(r.recusados).toContain("de:whatsapp");
  });

  it("CPF e CNPJ com pontuação", () => {
    const r = limparArgumentosExternos({ a: "123.456.789-01", b: "12.345.678/0001-90" });
    expect(r.limpos.a).toBe(MARCA_DE_REMOCAO);
    expect(r.limpos.b).toBe(MARCA_DE_REMOCAO);
  });

  it("campo com nome de dado pessoal, mesmo com valor sem forma nenhuma", () => {
    const r = limparArgumentosExternos({ telefone: "o de sempre", phoneNumber: 5535991485627 });
    expect(r.limpos.telefone).toBe(MARCA_DE_REMOCAO);
    expect(r.limpos.phoneNumber).toBe(MARCA_DE_REMOCAO);
    expect(r.recusados).toEqual(["telefone:nome_do_campo", "phoneNumber:nome_do_campo"]);
  });

  it("id desta instalação, quando o turno conhece o valor", () => {
    const r = limparArgumentosExternos({ ref: `pedido do ${ORG}` }, [ORG, null, undefined]);
    expect(r.limpos.ref).toBe(`pedido do ${MARCA_DE_REMOCAO}`);
    expect(r.recusados).toContain("ref:id_da_instalacao");
  });

  it("dentro de objeto e de lista aninhados, com o caminho no relato", () => {
    const r = limparArgumentosExternos({
      filtro: { contatos: [{ obs: "ligar para (35) 99148-5627" }] },
    });
    expect(r.recusados).toContain("filtro.contatos[0].obs:telefone");
  });
});

describe("o que passa, porque é disso que a consulta vive", () => {
  it("código de barras de 13 dígitos num campo de código", () => {
    const r = limparArgumentosExternos({ ean: "7891234567895", sku: "1234567890123" });
    expect(r.limpos.ean).toBe("7891234567895");
    expect(r.limpos.sku).toBe("1234567890123");
    expect(r.recusados).toEqual([]);
  });

  it("mas e-mail num campo de código continua recusado", () => {
    const r = limparArgumentosExternos({ codigo: "ref joao@exemplo.test" });
    expect(r.limpos.codigo).toBe(`ref ${MARCA_DE_REMOCAO}`);
  });

  it("código curto, CEP, ano e faixa de preço", () => {
    const r = limparArgumentosExternos({
      referencia_do_imovel: "IM-102",
      cep: "37800000",
      ano: 2026,
      preco: "de 100.000 a 1.500.000,00",
      texto: "entrega em 22/09/2026",
    });
    expect(r.recusados).toEqual([]);
    expect(r.limpos.preco).toBe("de 100.000 a 1.500.000,00");
    expect(r.limpos.texto).toBe("entrega em 22/09/2026");
  });

  it("uuid que o próprio servidor externo devolveu", () => {
    const outro = "9a8b7c6d-5e4f-4a3b-9c8d-7e6f5a4b3c2d";
    const r = limparArgumentosExternos({ imovel_id: outro }, [ORG]);
    expect(r.limpos.imovel_id).toBe(outro);
    expect(r.recusados).toEqual([]);
  });

  it("consulta comum de catálogo sai intacta", () => {
    const pedido = { cidade: "Guaxupé", quartos: 3, ate: 450000, tipo: "apartamento" };
    const r = limparArgumentosExternos(pedido);
    expect(r.limpos).toEqual(pedido);
    expect(r.recusados).toEqual([]);
  });
});

describe("nunca derruba o turno", () => {
  it("ciclo no argumento não estoura a pilha", () => {
    const a: Record<string, unknown> = { nome: "x" };
    a.ele = a;
    expect(() => limparArgumentosExternos(a)).not.toThrow();
  });

  it("argumento que não é objeto vira objeto vazio", () => {
    expect(limparArgumentosExternos(null).limpos).toEqual({});
    expect(limparArgumentosExternos("texto").limpos).toEqual({});
    expect(limparArgumentosExternos([1, 2]).limpos).toEqual({});
  });

  it("o relato não carrega o valor recusado", () => {
    const r = limparArgumentosExternos({ obs: "fone 35991485627, mail a@b.test" });
    expect(r.recusados.join(" ")).not.toContain("35991485627");
    expect(r.recusados.join(" ")).not.toContain("a@b.test");
  });
});
