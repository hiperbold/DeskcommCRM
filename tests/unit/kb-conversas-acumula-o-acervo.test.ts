/**
 * D-159: a versão nova da base "Conversas anteriores" herda os trechos da versão
 * ativa antes de ser ativada, senão `activateVersion` apaga o acervo a cada dia.
 * O banco é um dublê em memória que aplica os filtros de verdade.
 */
import { describe, expect, it } from "vitest";

import { herdarChunksDaVersaoAtiva } from "@/lib/ai/rag/herdar-chunks";

type Linha = Record<string, unknown>;

function banco(tabelas: Record<string, Linha[]>, opts: { falharInsert?: boolean } = {}) {
  return {
    from(nome: string) {
      const linhas = tabelas[nome]!;
      const filtros: Array<(l: Linha) => boolean> = [];
      let ordem: { col: string; asc: boolean } | null = null;
      let faixa: [number, number] | null = null;
      let teto = Infinity;
      let inserir: Linha[] | null = null;
      const q = {
        select: () => q,
        insert: (rows: Linha[]) => {
          inserir = rows;
          return q;
        },
        eq: (c: string, v: unknown) => (filtros.push((l) => l[c] === v), q),
        neq: (c: string, v: unknown) => (filtros.push((l) => l[c] !== v), q),
        order: (c: string, o: { ascending: boolean }) => ((ordem = { col: c, asc: o.ascending }), q),
        range: (a: number, b: number) => ((faixa = [a, b]), q),
        limit: (n: number) => ((teto = n), q),
        then: (res: (v: unknown) => unknown) => {
          if (inserir) {
            if (opts.falharInsert) return res({ data: null, error: { message: "negado" } });
            linhas.push(...inserir);
            return res({ data: null, error: null });
          }
          let r = linhas.filter((l) => filtros.every((f) => f(l)));
          if (ordem) {
            const { col, asc } = ordem;
            r = [...r].sort((a, b) => (asc ? 1 : -1) * ((a[col] as number) - (b[col] as number)));
          }
          if (faixa) r = r.slice(faixa[0], faixa[1] + 1);
          return res({ data: r.slice(0, teto), error: null });
        },
      };
      return q;
    },
  } as never;
}

const ORG = "org-1";
const FONTE = "fonte-1";

function acervo(n: number, versao: string): Linha[] {
  return Array.from({ length: n }, (_, i) => ({
    organization_id: ORG,
    knowledge_source_id: FONTE,
    kb_version_id: versao,
    position: i,
    content: `${versao}-trecho-${i}`,
    content_hash: `h-${versao}-${i}`,
    token_count: 10,
    embedding: "[0.1]",
    metadata: {},
  }));
}

describe("herdarChunksDaVersaoAtiva", () => {
  it("copia TODO o acervo da versão ativa (mais de uma página) para a nova, sem colidir posições", async () => {
    const chunks = [...acervo(450, "v1"), ...acervo(3, "v2")];
    const admin = banco({
      ai_knowledge_versions: [
        { id: "v1", organization_id: ORG, knowledge_source_id: FONTE, is_active: true },
        { id: "v2", organization_id: ORG, knowledge_source_id: FONTE, is_active: false },
      ],
      ai_chunks: chunks,
    });

    const copiados = await herdarChunksDaVersaoAtiva(admin, {
      organizationId: ORG,
      knowledgeSourceId: FONTE,
      versaoNovaId: "v2",
    });

    expect(copiados).toBe(450);
    const novos = chunks.filter((c) => c.kb_version_id === "v2");
    expect(novos).toHaveLength(453);
    const posicoes = novos.map((c) => c.position as number);
    expect(new Set(posicoes).size).toBe(453);
    expect(Math.min(...posicoes)).toBe(0);
    // O acervo de ontem continua intacto.
    expect(chunks.filter((c) => c.kb_version_id === "v1")).toHaveLength(450);
  });

  it("sem versão ativa anterior (primeira rodada): não copia nada", async () => {
    const admin = banco({ ai_knowledge_versions: [{ id: "v1", organization_id: ORG, knowledge_source_id: FONTE, is_active: false }], ai_chunks: acervo(2, "v1") });
    expect(await herdarChunksDaVersaoAtiva(admin, { organizationId: ORG, knowledgeSourceId: FONTE, versaoNovaId: "v1" })).toBe(0);
  });

  it("não herda trechos de outra organização", async () => {
    const outra = acervo(5, "vx").map((c) => ({ ...c, organization_id: "org-2" }));
    const admin = banco({
      ai_knowledge_versions: [{ id: "vx", organization_id: "org-2", knowledge_source_id: FONTE, is_active: true }],
      ai_chunks: outra,
    });
    expect(await herdarChunksDaVersaoAtiva(admin, { organizationId: ORG, knowledgeSourceId: FONTE, versaoNovaId: "v2" })).toBe(0);
  });

  it("falha ao gravar LANÇA, para quem chama não ativar a versão e apagar o acervo", async () => {
    const admin = banco(
      {
        ai_knowledge_versions: [{ id: "v1", organization_id: ORG, knowledge_source_id: FONTE, is_active: true }],
        ai_chunks: acervo(3, "v1"),
      },
      { falharInsert: true },
    );
    await expect(
      herdarChunksDaVersaoAtiva(admin, { organizationId: ORG, knowledgeSourceId: FONTE, versaoNovaId: "v2" }),
    ).rejects.toThrow(/herdarChunks/);
  });
});
