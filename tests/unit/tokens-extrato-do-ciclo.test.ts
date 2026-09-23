/**
 * Tarefa 5 da fase F2-B (hiperbold/planos/fase-F2-B-tarefas.md): leitura de
 * `extratoDoCiclo` e `primeiroDiaDoCicloAtual`. Desde a revisão de 23/09/2026
 * (item 1a/item 9), o agregado por dia e por agente vem de
 * `fn_billing_extrato_do_ciclo` (RPC): o dublê mistura um `admin.rpc` falso
 * (a RPC) com o builder thenable de `ai_agents` (nomes), no molde de
 * `tests/unit/mcp-externo-conexoes.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { extratoDoCiclo, primeiroDiaDoCicloAtual } from "@/lib/billing/tokens/extrato-do-ciclo";

const ORG = "22222222-2222-4222-8222-222222222222";
const AGENTE_ATIVO = "33333333-3333-4333-8333-333333333333";
const AGENTE_APAGADO = "44444444-4444-4444-8444-444444444444";

interface ChamadaRpc {
  nome: string;
  args: unknown;
}

interface ChamadaFrom {
  tabela: string;
  filtros: Record<string, unknown>;
}

interface OpcoesDoAdminFalso {
  extratoData?: unknown;
  extratoErro?: string;
  extratoLanca?: boolean;
  agentesData?: unknown[];
  agentesErro?: string;
}

const EXTRATO_VAZIO = { por_dia: [], por_agente: [] };

/** Um dublê com `rpc` (a RPC do extrato) e `from` (só `ai_agents`, thenable). */
function criarAdminFalso(opts: OpcoesDoAdminFalso) {
  const chamadasRpc: ChamadaRpc[] = [];
  const chamadasFrom: ChamadaFrom[] = [];

  async function rpc(nome: string, args: unknown) {
    chamadasRpc.push({ nome, args });
    if (opts.extratoLanca) throw new Error("conexão com o banco caiu");
    if (opts.extratoErro) return { data: null, error: { message: opts.extratoErro } };
    return { data: opts.extratoData ?? EXTRATO_VAZIO, error: null };
  }

  function builder(tabela: string) {
    const filtros: Record<string, unknown> = {};
    const api = {
      select(_cols: string) {
        return api;
      },
      eq(col: string, val: unknown) {
        filtros[`eq_${col}`] = val;
        return api;
      },
      in(col: string, vals: unknown) {
        filtros[`in_${col}`] = vals;
        return api;
      },
      then(resolve: (v: unknown) => void, reject: (e: unknown) => void) {
        chamadasFrom.push({ tabela, filtros: { ...filtros } });
        try {
          if (tabela === "ai_agents") {
            if (opts.agentesErro) {
              resolve({ data: null, error: { message: opts.agentesErro } });
              return;
            }
            resolve({ data: opts.agentesData ?? [], error: null });
            return;
          }
          throw new Error(`tabela desconhecida no dublê: ${tabela}`);
        } catch (err) {
          reject(err);
        }
      },
    };
    return api;
  }

  const admin = { rpc, from: (tabela: string) => builder(tabela) } as unknown as SupabaseClient;
  return { admin, chamadasRpc, chamadasFrom };
}

function logFalso() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const EXTRATO_PADRAO = {
  por_dia: [
    { dia: "2026-09-01", tokens_ponderados: 1050, chamadas: 3 },
    { dia: "2026-09-02", tokens_ponderados: 3200, chamadas: 6 },
  ],
  por_agente: [
    { agent_id: AGENTE_ATIVO, tokens_ponderados: 4000, chamadas: 7 },
    { agent_id: AGENTE_APAGADO, tokens_ponderados: 200, chamadas: 1 },
    { agent_id: null, tokens_ponderados: 50, chamadas: 1 },
  ],
};

describe("extratoDoCiclo", () => {
  it("repassa por_dia já agregado pela RPC", async () => {
    const { admin } = criarAdminFalso({
      extratoData: EXTRATO_PADRAO,
      agentesData: [{ id: AGENTE_ATIVO, name: "Agente Vendas" }],
    });

    const r = await extratoDoCiclo(admin, ORG, "2026-09-01");

    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.extrato.porDia).toEqual([
      { dia: "2026-09-01", tokensPonderados: 1050, chamadas: 3 },
      { dia: "2026-09-02", tokensPonderados: 3200, chamadas: 6 },
    ]);
  });

  it("por agente: nome resolvido, agente apagado e sem agente (ordem já vem da RPC)", async () => {
    const { admin } = criarAdminFalso({
      extratoData: EXTRATO_PADRAO,
      agentesData: [{ id: AGENTE_ATIVO, name: "Agente Vendas" }],
    });

    const r = await extratoDoCiclo(admin, ORG, "2026-09-01");

    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.extrato.porAgente).toEqual([
      { agentId: AGENTE_ATIVO, tipo: "agente", nome: "Agente Vendas", tokensPonderados: 4000, chamadas: 7 },
      { agentId: AGENTE_APAGADO, tipo: "agente_removido", nome: null, tokensPonderados: 200, chamadas: 1 },
      { agentId: null, tipo: "sem_agente", nome: null, tokensPonderados: 50, chamadas: 1 },
    ]);
  });

  it("chama a RPC com a organização e o ciclo certos", async () => {
    const { admin, chamadasRpc } = criarAdminFalso({ extratoData: EXTRATO_VAZIO });

    await extratoDoCiclo(admin, ORG, "2026-09-01");

    expect(chamadasRpc).toEqual([
      { nome: "fn_billing_extrato_do_ciclo", args: { p_org: ORG, p_ciclo: "2026-09-01" } },
    ]);
  });

  it("isolamento: a consulta de nomes filtra pela organização, só os agent_id que aparecem", async () => {
    const { admin, chamadasFrom } = criarAdminFalso({
      extratoData: EXTRATO_PADRAO,
      agentesData: [{ id: AGENTE_ATIVO, name: "Agente Vendas" }],
    });

    await extratoDoCiclo(admin, ORG, "2026-09-01");

    const agentes = chamadasFrom.find((c) => c.tabela === "ai_agents");
    expect(agentes?.filtros.eq_organization_id).toBe(ORG);
    expect((agentes?.filtros.in_id as string[]).sort()).toEqual([AGENTE_APAGADO, AGENTE_ATIVO].sort());
  });

  it("sem nenhum agent_id no extrato: não consulta ai_agents", async () => {
    const { admin, chamadasFrom } = criarAdminFalso({
      extratoData: { por_dia: [], por_agente: [EXTRATO_PADRAO.por_agente[2]] },
    });

    await extratoDoCiclo(admin, ORG, "2026-09-01");

    expect(chamadasFrom.some((c) => c.tabela === "ai_agents")).toBe(false);
  });

  it("sem nenhuma linha no ciclo: devolve os dois extratos vazios", async () => {
    const { admin } = criarAdminFalso({ extratoData: EXTRATO_VAZIO });

    const r = await extratoDoCiclo(admin, ORG, "2026-09-01");

    expect(r).toEqual({ status: "ok", extrato: { ciclo: "2026-09-01", porDia: [], porAgente: [] } });
  });

  it("a RPC devolve error: nunca lança, vira leitura_falhou e alarma", async () => {
    const { admin } = criarAdminFalso({ extratoErro: "permission denied for function fn_billing_extrato_do_ciclo" });
    const log = logFalso();

    const r = await extratoDoCiclo(admin, ORG, "2026-09-01", log);

    expect(r).toEqual({ status: "leitura_falhou" });
    expect(log.error).toHaveBeenCalledWith("alarme_planos_leitura", expect.objectContaining({ organization_id: ORG }));
  });

  it("a RPC lança: nunca propaga, vira leitura_falhou", async () => {
    const { admin } = criarAdminFalso({ extratoLanca: true });

    const r = await extratoDoCiclo(admin, ORG, "2026-09-01");

    expect(r).toEqual({ status: "leitura_falhou" });
  });

  it("a consulta dos agentes devolve error: vira leitura_falhou (não finge nome)", async () => {
    const { admin } = criarAdminFalso({
      extratoData: { por_dia: [], por_agente: [EXTRATO_PADRAO.por_agente[0]] },
      agentesErro: "permission denied for table ai_agents",
    });

    const r = await extratoDoCiclo(admin, ORG, "2026-09-01");

    expect(r).toEqual({ status: "leitura_falhou" });
  });

  it("jsonb fora do esquema (tokens_ponderados não numérico): leitura_falhou", async () => {
    const { admin } = criarAdminFalso({
      extratoData: { por_dia: [{ dia: "2026-09-01", tokens_ponderados: "muitos", chamadas: 1 }], por_agente: [] },
    });

    const r = await extratoDoCiclo(admin, ORG, "2026-09-01");

    expect(r).toEqual({ status: "leitura_falhou" });
  });

  it("sem ciclo informado, calcula o primeiro dia do mês corrente e passa para a RPC", async () => {
    const { admin, chamadasRpc } = criarAdminFalso({ extratoData: EXTRATO_VAZIO });

    const ciclo = primeiroDiaDoCicloAtual();
    const r = await extratoDoCiclo(admin, ORG);

    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(r.extrato.ciclo).toBe(ciclo);
    expect((chamadasRpc[0]?.args as { p_ciclo: string }).p_ciclo).toBe(ciclo);
  });
});

describe("primeiroDiaDoCicloAtual", () => {
  it("devolve o primeiro dia do mês, no fuso America/Sao_Paulo", () => {
    // 2026-09-23T02:30:00Z é 22/09 23:30 em São Paulo (UTC-3): ainda setembro.
    expect(primeiroDiaDoCicloAtual(new Date("2026-09-23T02:30:00Z"))).toBe("2026-09-01");
  });

  it("na virada do mês em UTC, mas ainda no mês anterior em São Paulo, não adianta o ciclo", () => {
    // 2026-10-01T02:30:00Z é 30/09 23:30 em São Paulo: o ciclo de setembro
    // continua vigente até a meia-noite LOCAL, não a de UTC.
    expect(primeiroDiaDoCicloAtual(new Date("2026-10-01T02:30:00Z"))).toBe("2026-09-01");
  });

  it("depois da meia-noite local, já é o mês novo", () => {
    // 2026-10-01T03:30:00Z é 01/10 00:30 em São Paulo.
    expect(primeiroDiaDoCicloAtual(new Date("2026-10-01T03:30:00Z"))).toBe("2026-10-01");
  });
});
