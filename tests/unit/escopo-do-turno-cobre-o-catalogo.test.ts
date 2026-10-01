import { describe, expect, it } from "vitest";

import { allTools } from "@/lib/mcp/tools";
import { catalogEntry } from "@/lib/mcp/tools/catalog";
import { CAMPOS_DE_ALVO_DE_PESSOA, ESCOPO_DO_TURNO } from "@/lib/mcp/escopo-do-turno";

/**
 * D-096: a regra de escopo do turno é uma TABELA, e tabela esquece. Esta cerca
 * reprova quando alguém acrescenta ao catálogo uma ferramenta que o agente
 * alcança e que recebe o id de uma pessoa, sem decidir como o escopo vale para
 * ela. Sem isto a próxima ferramenta nasceria fora do gate.
 */

const RANK: Record<string, number> = { viewer: 0, agent: 1, ai_operator: 2, manager: 3, admin: 4 };
const TETO_DO_AGENTE = RANK.ai_operator!;

const alcancaveisPeloAgente = allTools.filter(
  (t) => (RANK[t.requiresRole] ?? 99) <= TETO_DO_AGENTE && !catalogEntry(t.name)?.apenasHumano,
);

describe("ESCOPO_DO_TURNO cobre o catálogo", () => {
  it("toda ferramenta do agente com alvo de pessoa tem regra de escopo", () => {
    const sem = alcancaveisPeloAgente
      .filter((t) => Object.keys(t.inputSchema).some((k) => CAMPOS_DE_ALVO_DE_PESSOA.includes(k)))
      .map((t) => t.name)
      .filter((nome) => !(nome in ESCOPO_DO_TURNO));
    expect(sem, `sem regra de escopo do turno: ${sem.join(", ")}`).toEqual([]);
  });

  it("toda regra aponta para ferramenta que existe e para argumento que ela tem", () => {
    const porNome = new Map(allTools.map((t) => [t.name, t]));
    const problemas: string[] = [];
    for (const [nome, regra] of Object.entries(ESCOPO_DO_TURNO)) {
      const def = porNome.get(nome);
      if (!def) {
        problemas.push(`${nome}: não existe no catálogo`);
        continue;
      }
      const campos = Object.keys(def.inputSchema);
      if (regra.modo === "recursos") {
        for (const r of regra.recursos) {
          if (!campos.includes(r.campo)) problemas.push(`${nome}: sem o argumento ${r.campo}`);
        }
      } else if (regra.modo === "polimorfico") {
        for (const c of [regra.campoDoTipo, regra.campoDoId]) {
          if (!campos.includes(c)) problemas.push(`${nome}: sem o argumento ${c}`);
        }
      }
    }
    expect(problemas).toEqual([]);
  });

  it("a listagem que impõe o contato tem `contact_id` para receber", () => {
    for (const [nome, regra] of Object.entries(ESCOPO_DO_TURNO)) {
      if (regra.modo !== "recursos" || !regra.impoeContato) continue;
      const def = allTools.find((t) => t.name === nome)!;
      expect(Object.keys(def.inputSchema), nome).toContain("contact_id");
    }
  });
});
