/**
 * Revisão da F3 (achado médio 2): `avisarLimiteDeLeadsAtingido`
 * (`lib/leads/aviso-limite-de-leads.ts`) fazia `select ... .maybeSingle()` e
 * inseria sempre que a leitura desse erro (inclusive o próprio erro de
 * `.maybeSingle()` recebendo mais de uma linha). Duas rajadas do mesmo dia
 * podiam gravar dois avisos iguais, e a partir daí toda recusa seguinte
 * inseria mais um. Correção: `.limit(1)` sem `.maybeSingle()`, e leitura que
 * falha NÃO insere (loga e segue).
 */
import { describe, expect, it, vi } from "vitest";

import { avisarLimiteDeLeadsAtingido } from "@/lib/leads/aviso-limite-de-leads";

const ORG = "22222222-2222-4222-8222-222222222222";
const AGORA = new Date("2026-09-24T15:00:00.000Z");

function adminFalso(opts: { linhas?: { id: string }[]; erroLeitura?: string; erroInsert?: string }) {
  const inserts: Record<string, unknown>[] = [];
  const admin = {
    from: (tabela: string) => {
      if (tabela !== "agent_inbox_items") throw new Error(`tabela inesperada: ${tabela}`);
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  limit: async () =>
                    opts.erroLeitura
                      ? { data: null, error: { message: opts.erroLeitura } }
                      : { data: opts.linhas ?? [], error: null },
                }),
              }),
            }),
          }),
        }),
        insert: async (linha: Record<string, unknown>) => {
          inserts.push(linha);
          return opts.erroInsert ? { error: { message: opts.erroInsert } } : { error: null };
        },
      };
    },
  };
  return { admin, inserts };
}

describe("avisarLimiteDeLeadsAtingido: dedup por .limit(1), leitura que falha nunca insere às cegas", () => {
  it("já existe UM aviso hoje: não insere de novo", async () => {
    const { admin, inserts } = adminFalso({ linhas: [{ id: "aviso-1" }] });
    await avisarLimiteDeLeadsAtingido(admin as never, ORG, AGORA);
    expect(inserts).toHaveLength(0);
  });

  it("a leitura devolve DUAS linhas (rajada anterior duplicou): não insere mais um, e não lança", async () => {
    const { admin, inserts } = adminFalso({ linhas: [{ id: "aviso-1" }, { id: "aviso-2" }] });
    await expect(avisarLimiteDeLeadsAtingido(admin as never, ORG, AGORA)).resolves.toBeUndefined();
    expect(inserts).toHaveLength(0);
  });

  it("nenhum aviso hoje: insere UM, com o título do dia", async () => {
    const { admin, inserts } = adminFalso({ linhas: [] });
    await avisarLimiteDeLeadsAtingido(admin as never, ORG, AGORA);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({ organization_id: ORG, ref_kind: "billing_limite" });
    expect(inserts[0]!.title).toContain("24/09/2026");
  });

  it("a LEITURA falha: NÃO insere às cegas (evita duplicar), só loga e segue", async () => {
    const { admin, inserts } = adminFalso({ erroLeitura: "conexão recusada" });
    await expect(avisarLimiteDeLeadsAtingido(admin as never, ORG, AGORA)).resolves.toBeUndefined();
    expect(inserts).toHaveLength(0);
  });

  it("a leitura passa mas o INSERT falha: não lança (o caminho automático já gravou a mensagem)", async () => {
    const { admin } = adminFalso({ linhas: [], erroInsert: "banco fora" });
    await expect(avisarLimiteDeLeadsAtingido(admin as never, ORG, AGORA)).resolves.toBeUndefined();
  });
});
