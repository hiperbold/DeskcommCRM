/**
 * Fase F3, tarefa 9 (hiperbold/planos/fase-F3-tarefas.md, decisões 9 e 10):
 * `estadoDoBloqueio` e as duas funções puras que os componentes usam para
 * decidir `disabled` e o motivo. Dublê do cliente Supabase, sem banco de
 * verdade, no estilo de `tests/unit/planos-uso-e-pode-criar.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  bloqueioDoBotao,
  estadoDoBloqueio,
  itemNoTeto,
  motivoDoItemNoTeto,
  type EstadoDoBloqueio,
} from "@/lib/billing/planos/estado-do-bloqueio";

const ORG = "22222222-2222-4222-8222-222222222222";
const FUNIL_A = "33333333-3333-4333-8333-333333333333";
const FUNIL_B = "44444444-4444-4444-8444-444444444444";

const AGORA = Date.parse("2026-09-24T12:00:00.000Z");

const USO_PADRAO = {
  funis: 3,
  etapas_por_funil: 8,
  leads: 40,
  membros: 3,
  conexoes: 3,
  integracoes_webhook: 0,
};

const LIMITES_PRO = {
  funis: 5,
  etapas_por_funil: 10,
  leads: 5000,
  membros: 3,
  conexoes: 3,
  integracoes_webhook: 3,
  tokens_ia_mes: 1_000_000,
};

interface OpcoesDoAdminFalso {
  modo?: string | null;
  settingsErro?: string;
  bloqueioAPartirDe?: string | null;
  contratoErro?: string;
  planoNome?: string;
  usoData?: unknown;
  usoErro?: string;
  limitesData?: unknown;
  limitesErro?: string;
  podeCriarPorFunil?: Record<string, { pode: boolean; motivo: string; atual: number | null; teto: number | null } | "erro">;
}

function criarAdminFalso(opts: OpcoesDoAdminFalso) {
  const chamadas: string[] = [];

  function from(tabela: string) {
    return {
      select: () => ({
        eq: () => ({
          maybeSingle: async () => {
            chamadas.push(`from:${tabela}`);
            if (tabela === "billing_settings") {
              if (opts.settingsErro) return { data: null, error: { message: opts.settingsErro } };
              return { data: { modo: opts.modo ?? "bloquear" }, error: null };
            }
            if (tabela === "billing_contracts") {
              if (opts.contratoErro) return { data: null, error: { message: opts.contratoErro } };
              return {
                data: {
                  bloqueio_a_partir_de: opts.bloqueioAPartirDe ?? null,
                  status: "ativa",
                  cycle: "monthly",
                  billing_plans: { code: "pro", name: opts.planoNome ?? "Pro", version: 1 },
                },
                error: null,
              };
            }
            throw new Error(`from desconhecido no dublê: ${tabela}`);
          },
        }),
      }),
    };
  }

  async function rpc(nome: string, args: unknown) {
    chamadas.push(`rpc:${nome}`);
    if (nome === "fn_billing_uso") {
      if (opts.usoErro) return { data: null, error: { message: opts.usoErro } };
      return { data: opts.usoData ?? USO_PADRAO, error: null };
    }
    if (nome === "fn_billing_limites_efetivos") {
      if (opts.limitesErro) return { data: null, error: { message: opts.limitesErro } };
      return { data: opts.limitesData ?? LIMITES_PRO, error: null };
    }
    if (nome === "fn_billing_pode_criar") {
      const pipelineId = (args as { p_pipeline: string }).p_pipeline;
      const resposta = opts.podeCriarPorFunil?.[pipelineId];
      if (resposta === "erro") return { data: null, error: { message: "conexão caiu" } };
      return {
        data: resposta ?? { pode: true, motivo: "ok", atual: 1, teto: 10 },
        error: null,
      };
    }
    throw new Error(`rpc desconhecida no dublê: ${nome}`);
  }

  const admin = { from, rpc } as unknown as SupabaseClient;
  return { admin, chamadas };
}

function logFalso() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe("estadoDoBloqueio", () => {
  it("modo avisar: não vale, sem itens no teto, e ZERO consulta além de billing_settings", async () => {
    const { admin, chamadas } = criarAdminFalso({ modo: "avisar" });

    const r = await estadoDoBloqueio(admin, ORG);

    expect(r).toEqual({
      vale: false,
      modo: "avisar",
      carenciaAte: null,
      emCarencia: false,
      itensNoTeto: [],
      leituraFalhou: false,
    });
    expect(chamadas).toEqual(["from:billing_settings"]);
  });

  it("revisão da F3 (achado baixo 4): duas chamadas seguidas com o MESMO admin fazem uma leitura só de billing_settings", async () => {
    const { admin, chamadas } = criarAdminFalso({ modo: "avisar" });

    await estadoDoBloqueio(admin, ORG);
    await estadoDoBloqueio(admin, ORG);

    expect(chamadas).toEqual(["from:billing_settings"]);
  });

  it("modo desligado: mesma saída antecipada de avisar", async () => {
    const { admin, chamadas } = criarAdminFalso({ modo: "desligado" });

    const r = await estadoDoBloqueio(admin, ORG);

    expect(r.vale).toBe(false);
    expect(r.modo).toBe("desligado");
    expect(chamadas).toEqual(["from:billing_settings"]);
  });

  it("modo bloquear, carência nula: não vale (organização sem carência programada)", async () => {
    const { admin } = criarAdminFalso({ modo: "bloquear", bloqueioAPartirDe: null });

    const r = await estadoDoBloqueio(admin, ORG);

    expect(r.vale).toBe(false);
    expect(r.emCarencia).toBe(false);
    expect(r.carenciaAte).toBeNull();
    expect(r.itensNoTeto).toEqual([]);
  });

  it("modo bloquear, carência no futuro: não vale, em carência, com a data", async () => {
    vi.useFakeTimers().setSystemTime(AGORA);
    try {
      const futuro = new Date(AGORA + 3 * 86_400_000).toISOString();
      const { admin, chamadas } = criarAdminFalso({ modo: "bloquear", bloqueioAPartirDe: futuro });

      const r = await estadoDoBloqueio(admin, ORG);

      expect(r.vale).toBe(false);
      expect(r.emCarencia).toBe(true);
      expect(r.carenciaAte).toBe(futuro);
      expect(r.itensNoTeto).toEqual([]);
      // Carência ainda correndo não lê uso nem limites: nenhuma RPC chamada.
      expect(chamadas.some((c) => c.startsWith("rpc:"))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("modo bloquear, carência vencida: vale, e os itens no teto entram com o motivo", async () => {
    vi.useFakeTimers().setSystemTime(AGORA);
    try {
      const passado = new Date(AGORA - 3 * 86_400_000).toISOString();
      const { admin } = criarAdminFalso({
        modo: "bloquear",
        bloqueioAPartirDe: passado,
        planoNome: "Pro",
        usoData: USO_PADRAO, // conexoes: 3, membros: 3, ambos no teto do plano Pro (3)
        limitesData: LIMITES_PRO,
      });

      const r = await estadoDoBloqueio(admin, ORG);

      expect(r.vale).toBe(true);
      expect(r.emCarencia).toBe(false);
      expect(r.leituraFalhou).toBe(false);
      expect(r.itensNoTeto).toEqual(
        expect.arrayContaining([
          { chave: "conexoes", pipelineId: null, motivo: "3 de 3 conexões do plano Pro" },
          { chave: "membros", pipelineId: null, motivo: "3 de 3 membros do plano Pro" },
        ]),
      );
      // funis (3 de 5) e leads (40 de 5000) não estouraram.
      expect(r.itensNoTeto.find((i) => i.chave === "funis")).toBeUndefined();
      expect(r.itensNoTeto.find((i) => i.chave === "leads")).toBeUndefined();
      // etapas_por_funil nunca entra pela conta org-wide: só por pipelineIds.
      expect(r.itensNoTeto.find((i) => i.chave === "etapas_por_funil")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("leitura de billing_settings falhando: fail-open total (não vale, sem itens)", async () => {
    const { admin } = criarAdminFalso({ settingsErro: "relation não existe" });
    const log = logFalso();

    const r = await estadoDoBloqueio(admin, ORG, {}, log);

    expect(r).toEqual({
      vale: false,
      modo: "avisar",
      carenciaAte: null,
      emCarencia: false,
      itensNoTeto: [],
      leituraFalhou: true,
    });
    expect(log.error).toHaveBeenCalledWith("alarme_planos_leitura", expect.objectContaining({ organization_id: ORG }));
  });

  it("leitura de billing_contracts falhando: fail-open (não vale)", async () => {
    const { admin } = criarAdminFalso({ modo: "bloquear", contratoErro: "relation não existe" });

    const r = await estadoDoBloqueio(admin, ORG);

    expect(r.vale).toBe(false);
    expect(r.leituraFalhou).toBe(true);
  });

  it("bloqueio vale, mas a leitura de uso falha: NENHUM item aparece no teto (falha nunca desabilita)", async () => {
    vi.useFakeTimers().setSystemTime(AGORA);
    try {
      const passado = new Date(AGORA - 1000).toISOString();
      const { admin } = criarAdminFalso({
        modo: "bloquear",
        bloqueioAPartirDe: passado,
        usoErro: "conexão caiu",
      });

      const r = await estadoDoBloqueio(admin, ORG);

      expect(r.vale).toBe(true);
      expect(r.itensNoTeto).toEqual([]);
      expect(r.leituraFalhou).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("etapas_por_funil: só os pipelineIds pedidos são conferidos, cada um com podeCriar", async () => {
    vi.useFakeTimers().setSystemTime(AGORA);
    try {
      const passado = new Date(AGORA - 1000).toISOString();
      const { admin, chamadas } = criarAdminFalso({
        modo: "bloquear",
        bloqueioAPartirDe: passado,
        planoNome: "Pro",
        podeCriarPorFunil: {
          [FUNIL_A]: { pode: false, motivo: "teto_atingido", atual: 10, teto: 10 },
          [FUNIL_B]: { pode: true, motivo: "ok", atual: 2, teto: 10 },
        },
      });

      const r = await estadoDoBloqueio(admin, ORG, { pipelineIds: [FUNIL_A, FUNIL_B] });

      expect(r.itensNoTeto).toEqual(
        expect.arrayContaining([
          { chave: "etapas_por_funil", pipelineId: FUNIL_A, motivo: "10 de 10 etapas neste funil do plano Pro" },
        ]),
      );
      expect(r.itensNoTeto.filter((i) => i.pipelineId === FUNIL_B)).toEqual([]);
      expect(chamadas.filter((c) => c === "rpc:fn_billing_pode_criar")).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("etapas_por_funil: falha em UM funil não contamina o outro nem lança", async () => {
    vi.useFakeTimers().setSystemTime(AGORA);
    try {
      const passado = new Date(AGORA - 1000).toISOString();
      const { admin } = criarAdminFalso({
        modo: "bloquear",
        bloqueioAPartirDe: passado,
        podeCriarPorFunil: {
          [FUNIL_A]: "erro",
          [FUNIL_B]: { pode: false, motivo: "teto_atingido", atual: 5, teto: 5 },
        },
      });

      const r = await estadoDoBloqueio(admin, ORG, { pipelineIds: [FUNIL_A, FUNIL_B] });

      expect(r.itensNoTeto.find((i) => i.pipelineId === FUNIL_A)).toBeUndefined();
      expect(r.itensNoTeto.find((i) => i.pipelineId === FUNIL_B)).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("sem pipelineIds: nenhuma chamada a fn_billing_pode_criar", async () => {
    vi.useFakeTimers().setSystemTime(AGORA);
    try {
      const passado = new Date(AGORA - 1000).toISOString();
      const { admin, chamadas } = criarAdminFalso({ modo: "bloquear", bloqueioAPartirDe: passado });

      await estadoDoBloqueio(admin, ORG);

      expect(chamadas.some((c) => c === "rpc:fn_billing_pode_criar")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("funciona sem `log` nem `opcoes` (parâmetros opcionais)", async () => {
    const { admin } = criarAdminFalso({ modo: "avisar" });
    await expect(estadoDoBloqueio(admin, ORG)).resolves.toMatchObject({ vale: false });
  });
});

describe("motivoDoItemNoTeto", () => {
  it("com nome do plano: '3 de 3 conexões do plano Pro'", () => {
    expect(motivoDoItemNoTeto("conexoes", 3, 3, "Pro")).toBe("3 de 3 conexões do plano Pro");
  });

  it("sem nome do plano (leitura do plano falhou): omite o 'do plano X'", () => {
    expect(motivoDoItemNoTeto("membros", 5, 5, null)).toBe("5 de 5 membros");
  });

  it("etapas_por_funil usa o rótulo 'etapas neste funil'", () => {
    expect(motivoDoItemNoTeto("etapas_por_funil", 10, 10, "Pro")).toBe(
      "10 de 10 etapas neste funil do plano Pro",
    );
  });
});

describe("itemNoTeto", () => {
  const BASE: Pick<EstadoDoBloqueio, "vale" | "itensNoTeto"> = {
    vale: true,
    itensNoTeto: [
      { chave: "conexoes", pipelineId: null, motivo: "3 de 3 conexões do plano Pro" },
      { chave: "etapas_por_funil", pipelineId: FUNIL_A, motivo: "10 de 10 etapas neste funil do plano Pro" },
    ],
  };

  it("bloqueio não vale: null mesmo com item na lista", () => {
    expect(itemNoTeto({ vale: false, itensNoTeto: BASE.itensNoTeto }, "conexoes")).toBeNull();
  });

  it("item org-wide no teto: devolve o item", () => {
    expect(itemNoTeto(BASE, "conexoes")).toEqual(BASE.itensNoTeto[0]);
  });

  it("item org-wide fora do teto: null", () => {
    expect(itemNoTeto(BASE, "leads")).toBeNull();
  });

  it("etapas_por_funil do funil certo: devolve o item", () => {
    expect(itemNoTeto(BASE, "etapas_por_funil", FUNIL_A)).toEqual(BASE.itensNoTeto[1]);
  });

  it("etapas_por_funil de OUTRO funil: null, mesmo havendo item para outro pipelineId", () => {
    expect(itemNoTeto(BASE, "etapas_por_funil", FUNIL_B)).toBeNull();
  });
});

describe("bloqueioDoBotao", () => {
  const BASE: Pick<EstadoDoBloqueio, "vale" | "itensNoTeto"> = {
    vale: true,
    itensNoTeto: [{ chave: "conexoes", pipelineId: null, motivo: "3 de 3 conexões do plano Pro" }],
  };

  it("item no teto: desabilitado true, com o motivo", () => {
    expect(bloqueioDoBotao(BASE, "conexoes")).toEqual({
      desabilitado: true,
      motivo: "3 de 3 conexões do plano Pro",
    });
  });

  it("item fora do teto: desabilitado false, motivo null", () => {
    expect(bloqueioDoBotao(BASE, "leads")).toEqual({ desabilitado: false, motivo: null });
  });

  it("bloqueio não vale: desabilitado false mesmo com item na lista", () => {
    expect(bloqueioDoBotao({ vale: false, itensNoTeto: BASE.itensNoTeto }, "conexoes")).toEqual({
      desabilitado: false,
      motivo: null,
    });
  });
});
