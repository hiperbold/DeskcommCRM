import { describe, expect, it, vi } from "vitest";

import {
  conferirContadoresDePlano,
  type ConferidorDeContadoresDb,
} from "@/lib/billing/planos/conferir-contadores";

vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

/**
 * Dublê de `ConferidorDeContadoresDb` sobre uma lista de organizações EM
 * MEMÓRIA, com a mesma semântica de página de `conferidorDeContadoresSobre`
 * (baseado em `SupabaseClient.range`): `de`/`ate` são índices INCLUSIVOS. O
 * tamanho de página (500) não é injetável pelo módulo, por isso o teste de
 * paginação usa 500 + N organizações reais, para forçar mais de uma chamada
 * a `listarOrganizacoes`.
 */
function bancoComOrganizacoes(
  ids: string[],
  opts: { divergem?: Set<string>; falham?: Set<string>; erroNaPagina?: number } = {},
): { db: ConferidorDeContadoresDb; chamadasListar: number; chamadasRpc: string[] } {
  const divergem = opts.divergem ?? new Set<string>();
  const falham = opts.falham ?? new Set<string>();
  let chamadasListar = 0;
  const chamadasRpc: string[] = [];

  const db: ConferidorDeContadoresDb = {
    async listarOrganizacoes(de, ate) {
      const pagina = Math.floor(de / 500);
      chamadasListar++;
      if (opts.erroNaPagina !== undefined && pagina === opts.erroNaPagina) {
        return { data: null, error: { message: "permission denied for table organizations" } };
      }
      const fatia = ids.slice(de, ate + 1).map((id) => ({ id }));
      return { data: fatia, error: null };
    },
    async rpc(_nome, args) {
      chamadasRpc.push(args.p_org);
      if (falham.has(args.p_org)) {
        return { data: null, error: { message: `falhou a organização ${args.p_org}` } };
      }
      return { data: divergem.has(args.p_org), error: null };
    },
  };

  return { db, chamadasListar, chamadasRpc };
}

describe("conferirContadoresDePlano, o laço de páginas do conferidor diário", () => {
  it("percorre mais de uma página (500 + N organizações) e conta certo em ambas", async () => {
    const ids = Array.from({ length: 507 }, (_, i) => `org-${String(i).padStart(4, "0")}`);
    // Uma divergente em cada página, para provar que a segunda página é
    // realmente lida e realmente contada, não só a primeira.
    const divergem = new Set(["org-0010", "org-0505"]);
    const { db } = bancoComOrganizacoes(ids, { divergem });

    const total = await conferirContadoresDePlano(db);

    expect(total).toBe(2);
  });

  it("conta só as organizações cuja RPC devolve true", async () => {
    const ids = ["org-a", "org-b", "org-c", "org-d"];
    const { db, chamadasRpc } = bancoComOrganizacoes(ids, { divergem: new Set(["org-b", "org-d"]) });

    const total = await conferirContadoresDePlano(db);

    expect(total).toBe(2);
    expect(chamadasRpc).toEqual(ids);
  });

  it("uma organização que falha não derruba a rodada, as demais seguem conferidas", async () => {
    const ids = ["org-a", "org-b", "org-c"];
    const { db, chamadasRpc } = bancoComOrganizacoes(ids, {
      divergem: new Set(["org-c"]),
      falham: new Set(["org-b"]),
    });

    const total = await conferirContadoresDePlano(db);

    // org-b falhou (não conta, não lança) e a rodada continuou até org-c.
    expect(total).toBe(1);
    expect(chamadasRpc).toEqual(ids);
  });

  it("erro ao LISTAR organizações lança, sem a lista não há o que conferir", async () => {
    const ids = ["org-a", "org-b"];
    const { db } = bancoComOrganizacoes(ids, { erroNaPagina: 0 });

    await expect(conferirContadoresDePlano(db)).rejects.toThrow(
      /permission denied for table organizations/,
    );
  });

  it("nenhuma organização diverge devolve zero", async () => {
    const ids = ["org-a", "org-b"];
    const { db } = bancoComOrganizacoes(ids);

    await expect(conferirContadoresDePlano(db)).resolves.toBe(0);
  });
});
