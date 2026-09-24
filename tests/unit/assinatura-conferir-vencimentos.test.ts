import { describe, expect, it, vi } from "vitest";

import {
  conferirVencimentos,
  type ConferidorDeVencimentosDb,
} from "@/lib/billing/assinatura/conferir-vencimentos";

vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

/**
 * Tarefa 5 da fase F4 (hiperbold/planos/fase-F4-tarefas.md): o conferidor
 * diário do vencimento da assinatura. Dublê de `ConferidorDeVencimentosDb`
 * EM MEMÓRIA, mesmo desenho de `tests/unit/planos-conferir-contadores.test.ts`
 * (o irmão mais simples: uma RPC por organização, texto de estado ou `null`,
 * sem passos extras como o débito pendente da carteira de tokens):
 * `de`/`ate` de `listarOrganizacoes` são índices INCLUSIVOS (mesma semântica
 * de `SupabaseClient.range`). O tamanho de página (500) não é injetável.
 */
function bancoDeVencimentos(
  ids: string[],
  opts: {
    estadoPorOrg?: Record<string, string>;
    orgsQueFalham?: Set<string>;
    erroNaPaginaDeOrgs?: number;
  } = {},
): { db: ConferidorDeVencimentosDb; chamadas: string[] } {
  const estadoPorOrg = opts.estadoPorOrg ?? {};
  const orgsQueFalham = opts.orgsQueFalham ?? new Set<string>();
  const chamadas: string[] = [];

  const db: ConferidorDeVencimentosDb = {
    async listarOrganizacoes(de, ate) {
      const pagina = Math.floor(de / 500);
      if (opts.erroNaPaginaDeOrgs !== undefined && pagina === opts.erroNaPaginaDeOrgs) {
        return { data: null, error: { message: "permission denied for table organizations" } };
      }
      const fatia = ids.slice(de, ate + 1).map((id) => ({ id }));
      return { data: fatia, error: null };
    },
    async conferirVencimento(pOrg) {
      chamadas.push(pOrg);
      if (orgsQueFalham.has(pOrg)) {
        return { data: null, error: { message: `conferir vencimento falhou para ${pOrg}` } };
      }
      return { data: estadoPorOrg[pOrg] ?? null, error: null };
    },
  };

  return { db, chamadas };
}

describe("conferirVencimentos, o conferidor diário do vencimento da assinatura", () => {
  it("percorre mais de uma página de organizações (500 + N) e vê todas", async () => {
    const ids = Array.from({ length: 507 }, (_, i) => `org-${String(i).padStart(4, "0")}`);
    const { db } = bancoDeVencimentos(ids);

    const resumo = await conferirVencimentos(db);

    expect(resumo.organizacoesVistas).toBe(507);
    expect(resumo.organizacoesQueFalharam).toBe(0);
  });

  it("organização sem mudança (null) não entra em nenhuma contagem", async () => {
    const { db } = bancoDeVencimentos(["org-a", "org-b"], { estadoPorOrg: {} });

    const resumo = await conferirVencimentos(db);

    expect(resumo.mudaramParaAtrasada).toBe(0);
    expect(resumo.mudaramParaSuspensa).toBe(0);
    expect(resumo.mudaramParaCancelada).toBe(0);
  });

  it("conta cada organização no balde do estado que a RPC devolveu", async () => {
    const { db } = bancoDeVencimentos(["org-a", "org-b", "org-c", "org-d", "org-e"], {
      estadoPorOrg: {
        "org-a": "atrasada",
        "org-b": "atrasada",
        "org-c": "suspensa",
        "org-d": "cancelada",
        // org-e: sem mudança
      },
    });

    const resumo = await conferirVencimentos(db);

    expect(resumo.mudaramParaAtrasada).toBe(2);
    expect(resumo.mudaramParaSuspensa).toBe(1);
    expect(resumo.mudaramParaCancelada).toBe(1);
    expect(resumo.organizacoesVistas).toBe(5);
  });

  it("organização que falha (erro de transporte da RPC) não derruba a rodada, as demais seguem", async () => {
    const { db, chamadas } = bancoDeVencimentos(["org-a", "org-b", "org-c"], {
      orgsQueFalham: new Set(["org-b"]),
      estadoPorOrg: { "org-c": "suspensa" },
    });

    const resumo = await conferirVencimentos(db);

    expect(resumo.organizacoesVistas).toBe(3);
    expect(resumo.organizacoesQueFalharam).toBe(1);
    expect(resumo.mudaramParaSuspensa).toBe(1);
    expect(chamadas).toEqual(["org-a", "org-b", "org-c"]);
  });

  it("erro ao LISTAR organizações lança, sem a lista não há o que conferir", async () => {
    const { db } = bancoDeVencimentos(["org-a", "org-b"], { erroNaPaginaDeOrgs: 0 });

    await expect(conferirVencimentos(db)).rejects.toThrow(/permission denied for table organizations/);
  });

  it("resumo nunca vaza texto de erro do Postgres (só o log recebe)", async () => {
    const { db } = bancoDeVencimentos(["org-a"], { orgsQueFalham: new Set(["org-a"]) });

    const resumo = await conferirVencimentos(db);

    expect(JSON.stringify(resumo)).not.toMatch(/falhou para/);
  });

  it("organização sem contrato/período (a RPC devolve null) conta como vista, sem mudar nada", async () => {
    const { db } = bancoDeVencimentos(["org-sem-periodo"]);

    const resumo = await conferirVencimentos(db);

    expect(resumo.organizacoesVistas).toBe(1);
    expect(resumo.organizacoesQueFalharam).toBe(0);
    expect(resumo.mudaramParaAtrasada + resumo.mudaramParaSuspensa + resumo.mudaramParaCancelada).toBe(0);
  });
});
