/**
 * D-148: "só os meus" (`visibility_mode = own`) valia só para sessão de pessoa.
 * O caminho do token (REST dual e MCP) usa o cliente admin, passa por cima da
 * RLS, e uma chave `role:agent` lia e escrevia o que era de outro atendente.
 *
 * Prova:
 *  1. `exigirVisibilidadeDoToken`: modo own + papel abaixo de gerente = 403;
 *     gerente passa sem nem consultar; os modos mais soltos passam; falha de
 *     leitura recusa;
 *  2. cerca: toda ferramenta do catálogo está classificada (com dono OU sem dono).
 * O encaixe nas rotas REST e no servidor MCP é provado em
 * tests/unit/token-em-modo-own-recusado-no-rest-e-no-mcp.test.ts.
 */
import { describe, expect, it } from "vitest";

import { allTools } from "@/lib/mcp/tools";
import {
  FERRAMENTAS_COM_DONO,
  FERRAMENTAS_SEM_DONO,
  exigirVisibilidadeDoToken,
} from "@/lib/mcp/visibilidade-do-token";

function banco(modo: string | undefined, erro = false) {
  const consultas: string[] = [];
  const c: Record<string, unknown> = {};
  for (const m of ["select", "eq"]) c[m] = () => c;
  c.maybeSingle = async () =>
    erro
      ? { data: null, error: { message: "boom" } }
      : { data: { settings: modo ? { visibility_mode: modo } : {} }, error: null };
  return {
    consultas,
    client: {
      from: (t: string) => {
        consultas.push(t);
        return c;
      },
    } as never,
  };
}

const status = (p: Promise<unknown>) =>
  p.then(
    () => 200,
    (e: { httpStatus?: number }) => e.httpStatus ?? 0,
  );

describe("D-148 exigirVisibilidadeDoToken", () => {
  it("modo own: token agent leva 403", async () => {
    expect(await status(exigirVisibilidadeDoToken(banco("own").client, "o1", "agent"))).toBe(403);
  });
  it("modo own: token viewer e ai_operator também", async () => {
    expect(await status(exigirVisibilidadeDoToken(banco("own").client, "o1", "viewer"))).toBe(403);
    expect(await status(exigirVisibilidadeDoToken(banco("own").client, "o1", "ai_operator"))).toBe(
      403,
    );
  });
  it("modo own: gerente passa e nem consulta o banco", async () => {
    const b = banco("own");
    expect(await status(exigirVisibilidadeDoToken(b.client, "o1", "manager"))).toBe(200);
    expect(b.consultas).toEqual([]);
  });
  it("modos all, own_and_unassigned e ausente: agent passa (não quebra integração)", async () => {
    for (const modo of ["all", "own_and_unassigned", undefined]) {
      expect(await status(exigirVisibilidadeDoToken(banco(modo).client, "o1", "agent"))).toBe(200);
    }
  });
  it("falha ao ler a configuração recusa (500), não libera", async () => {
    expect(await status(exigirVisibilidadeDoToken(banco("own", true).client, "o1", "agent"))).toBe(
      500,
    );
  });
});

describe("D-148 cerca: toda ferramenta MCP está classificada", () => {
  it("cada tool está em COM_DONO ou SEM_DONO, nunca nas duas", () => {
    const nomes = allTools.map((t) => t.name);
    const naoClassificadas = nomes.filter(
      (n) => !FERRAMENTAS_COM_DONO.has(n) && !FERRAMENTAS_SEM_DONO.has(n),
    );
    expect(naoClassificadas, "classifique em lib/mcp/visibilidade-do-token.ts").toEqual([]);
    const nasDuas = nomes.filter((n) => FERRAMENTAS_COM_DONO.has(n) && FERRAMENTAS_SEM_DONO.has(n));
    expect(nasDuas).toEqual([]);
  });
  it("as listas não citam ferramenta que não existe mais", () => {
    const nomes = new Set(allTools.map((t) => t.name));
    const orfas = [...FERRAMENTAS_COM_DONO, ...FERRAMENTAS_SEM_DONO].filter((n) => !nomes.has(n));
    expect(orfas).toEqual([]);
  });
});
