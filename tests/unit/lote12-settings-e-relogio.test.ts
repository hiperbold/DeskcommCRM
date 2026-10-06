/**
 * Lote 12: D-132 (a escrita de uma chave de `organizations.settings` é pelo
 * banco) e D-131 (o relógio HTTP lê TODOS os `waiting_reply`, em páginas).
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

import { atualizarSettingDaOrganizacao } from "@/lib/organizations/atualizar-setting";
import {
  lerAguardandoResposta,
  PAGINA_DE_AGUARDANDO_RESPOSTA,
  TETO_DE_AGUARDANDO_RESPOSTA,
} from "@/lib/relogio/executar";

const ORG = "11111111-1111-4111-8111-111111111111";

describe("atualizarSettingDaOrganizacao", () => {
  it("chama a RPC com a organização, o caminho e o valor", async () => {
    const rpc = vi.fn(async () => ({ data: 1, error: null }));
    const r = await atualizarSettingDaOrganizacao({ rpc } as never, ORG, ["security", "mfa_required"], true);
    expect(r).toEqual({ ok: true });
    expect(rpc).toHaveBeenCalledWith("fn_atualizar_setting_da_organizacao", {
      p_org: ORG,
      p_caminho: ["security", "mfa_required"],
      p_valor: true,
    });
  });

  it("valor indefinido vai como nulo (a RPC remove a chave)", async () => {
    const rpc = vi.fn(async () => ({ data: 1, error: null }));
    await atualizarSettingDaOrganizacao({ rpc } as never, ORG, ["x"], undefined);
    expect(rpc).toHaveBeenCalledWith("fn_atualizar_setting_da_organizacao", { p_org: ORG, p_caminho: ["x"], p_valor: null });
  });

  it("0 linhas é organização não encontrada, não sucesso", async () => {
    const rpc = vi.fn(async () => ({ data: 0, error: null }));
    expect(await atualizarSettingDaOrganizacao({ rpc } as never, ORG, ["x"], 1)).toEqual({
      ok: false,
      motivo: "organizacao_nao_encontrada",
    });
  });

  it("erro do banco volta com o detalhe", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { message: "boom" } }));
    expect(await atualizarSettingDaOrganizacao({ rpc } as never, ORG, ["x"], 1)).toEqual({
      ok: false,
      motivo: "banco",
      detalhe: "boom",
    });
  });
});

describe("os escritores de organizations.settings não regravam o objeto inteiro (D-132)", () => {
  const ESCRITORES = [
    "app/actions/auth/politicaDeMfa.ts",
    "app/api/v1/settings/routing/route.ts",
    "app/api/v1/settings/campanhas/route.ts",
    "app/api/v1/settings/sons/route.ts",
    "app/api/v1/metrics/atrito/route.ts",
    "app/api/v1/ai/providers/route.ts",
    "lib/ai/pontos/padrao-da-organizacao.ts",
    "lib/ai/decisao/config.ts",
  ];
  for (const arquivo of ESCRITORES) {
    it(`${arquivo}: usa a RPC e não faz update de settings`, () => {
      const codigo = readFileSync(arquivo, "utf8")
        .split("\n")
        .filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//") && !l.trim().startsWith("/*"))
        .join("\n");
      expect(codigo).toContain("atualizarSettingDaOrganizacao(");
      expect(codigo).not.toMatch(/\.update\(\{\s*settings/);
    });
  }
});

/** Dublê do PostgREST para `followup_enrollments`: guarda as linhas e responde a `.range()`. */
function adminCom(total: number) {
  const faixas: Array<[number, number]> = [];
  const admin = {
    from: () => {
      const chain = {
        select: () => chain,
        in: () => chain,
        order: () => chain,
        range: async (de: number, ate: number) => {
          faixas.push([de, ate]);
          const n = Math.max(0, Math.min(total, ate + 1) - de);
          return { data: Array.from({ length: n }, (_, i) => ({ id: de + i })), error: null };
        },
      };
      return chain;
    },
  };
  return { admin: admin as never, faixas };
}

describe("lerAguardandoResposta (relógio HTTP, D-131)", () => {
  it("lê mais de 40: as 3 páginas de 200, parando na última incompleta", async () => {
    const { admin, faixas } = adminCom(450);
    const linhas = await lerAguardandoResposta(admin);
    expect(linhas).toHaveLength(450);
    expect(faixas).toEqual([
      [0, 199],
      [200, 399],
      [400, 599],
    ]);
  });

  it("poucos: uma consulta só", async () => {
    const { admin, faixas } = adminCom(3);
    expect(await lerAguardandoResposta(admin)).toHaveLength(3);
    expect(faixas).toHaveLength(1);
  });

  it("para no teto por tick, sem laço infinito", async () => {
    const { admin, faixas } = adminCom(TETO_DE_AGUARDANDO_RESPOSTA * 3);
    const linhas = await lerAguardandoResposta(admin);
    expect(linhas).toHaveLength(TETO_DE_AGUARDANDO_RESPOSTA);
    expect(faixas).toHaveLength(TETO_DE_AGUARDANDO_RESPOSTA / PAGINA_DE_AGUARDANDO_RESPOSTA);
  });

  it("erro de leitura sobe (o relógio registra a tarefa como falha)", async () => {
    const admin = {
      from: () => {
        const chain = { select: () => chain, in: () => chain, order: () => chain, range: async () => ({ data: null, error: { message: "x" } }) };
        return chain;
      },
    };
    await expect(lerAguardandoResposta(admin as never)).rejects.toThrow("x");
  });
});
