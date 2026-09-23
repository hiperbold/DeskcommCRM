/**
 * Tarefa 7 da fase F2 (hiperbold/planos/fase-F2-tarefas.md): a função pura que
 * monta as linhas da tela "Plano e uso" a partir do que `usoDaOrganizacao` e
 * `planoDaOrganizacao` já leram. Sem rede, sem banco, é o mesmo estilo de
 * `tests/unit/planos-limites.test.ts`.
 */
import { describe, expect, it } from "vitest";

import { linhasDaTelaDePlano } from "@/lib/billing/planos/linhas-da-tela-de-plano";
import type { ChaveDaTelaDePlano } from "@/lib/billing/planos/linhas-da-tela-de-plano";
import type { Limites } from "@/lib/billing/planos/limites";
import type { Uso } from "@/lib/billing/planos/uso-da-organizacao";

const USO: Uso = {
  funis: 3,
  etapas_por_funil: 8,
  leads: 40,
  membros: 3,
  conexoes: 1,
  integracoes_webhook: 0,
  tokens_ia_mes: null,
};

const LIMITES_PRO: Limites = {
  funis: 5,
  etapas_por_funil: 10,
  leads: 5000,
  membros: 3,
  conexoes: 3,
  integracoes_webhook: 3,
  tokens_ia_mes: 1_000_000,
};

const LIMITES_ILIMITADO: Limites = {
  funis: null,
  etapas_por_funil: null,
  leads: null,
  membros: null,
  conexoes: null,
  integracoes_webhook: null,
  tokens_ia_mes: null,
};

function linha(uso: Uso, limites: Limites, leituraFalhou: boolean, chave: ChaveDaTelaDePlano) {
  const encontrada = linhasDaTelaDePlano(uso, limites, leituraFalhou).find((l) => l.chave === chave);
  if (!encontrada) throw new Error(`chave ausente da tela: ${chave}`);
  return encontrada;
}

describe("linhasDaTelaDePlano", () => {
  it("cobre as seis chaves da tela, sem tokens_ia_mes (linha à parte)", () => {
    const chaves = linhasDaTelaDePlano(USO, LIMITES_PRO, false).map((l) => l.chave);
    expect(chaves).toEqual(["funis", "etapas_por_funil", "membros", "conexoes", "integracoes_webhook", "leads"]);
    expect(chaves).not.toContain("tokens_ia_mes");
  });

  it("item com teto: atual, teto e percentual calculados, sem estourar", () => {
    // membros: 3 de 3 -> no teto, mas não acima dele
    const l = linha(USO, LIMITES_PRO, false, "membros");
    expect(l).toEqual({ chave: "membros", atual: 3, teto: 3, semLimite: false, percentual: 100, estourou: true });

    // funis: 3 de 5 -> abaixo do teto
    const f = linha(USO, LIMITES_PRO, false, "funis");
    expect(f).toEqual({ chave: "funis", atual: 3, teto: 5, semLimite: false, percentual: 60, estourou: false });
  });

  it("item sem limite: teto nulo, sem percentual, nunca estourado", () => {
    const l = linha(USO, LIMITES_ILIMITADO, false, "leads");
    expect(l).toEqual({ chave: "leads", atual: 40, teto: null, semLimite: true, percentual: null, estourou: false });
  });

  it("uso acima do teto: a barra fica cheia (100, limitada) e marcada como estourada", () => {
    const usoAcima: Uso = { ...USO, conexoes: 7 };
    const l = linha(usoAcima, LIMITES_PRO, false, "conexoes");
    expect(l.percentual).toBe(100);
    expect(l.estourou).toBe(true);
    expect(l.atual).toBe(7);
    expect(l.teto).toBe(3);
  });

  it("leitura que falhou: nenhuma linha devolve número, nem 'sem limite'", () => {
    const linhas = linhasDaTelaDePlano(USO, LIMITES_PRO, true);
    expect(linhas).toHaveLength(6);
    for (const l of linhas) {
      expect(l.atual).toBeNull();
      expect(l.teto).toBeNull();
      expect(l.semLimite).toBe(false);
      expect(l.percentual).toBeNull();
      expect(l.estourou).toBe(false);
    }
  });

  it("leitura que falhou ignora os dados recebidos, mesmo que existam", () => {
    // Mesmo com uso e limites válidos, `leituraFalhou = true` não pode
    // aparecer misturado (metade real, metade não), é a regra do
    // comentário do módulo.
    const comEstouro: Uso = { ...USO, funis: 999 };
    const linhas = linhasDaTelaDePlano(comEstouro, LIMITES_PRO, true);
    expect(linhas.every((l) => l.atual === null)).toBe(true);
  });
});
