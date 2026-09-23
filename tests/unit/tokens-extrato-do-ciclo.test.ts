/**
 * Tarefa 5 da fase F2-B (hiperbold/planos/fase-F2-B-tarefas.md): leitura de
 * `extratoDoCiclo` e `primeiroDiaDoCicloAtual`. Dublê de `SupabaseClient`
 * sobre uma cadeia `.from().select().eq()...`, no molde de
 * `tests/unit/mcp-externo-conexoes.test.ts` (dublê que aplica filtro de
 * verdade, não um estado fixo).
 */
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { extratoDoCiclo, primeiroDiaDoCicloAtual } from "@/lib/billing/tokens/extrato-do-ciclo";

const ORG = "22222222-2222-4222-8222-222222222222";
const AGENTE_ATIVO = "33333333-3333-4333-8333-333333333333";
const AGENTE_APAGADO = "44444444-4444-4444-8444-444444444444";

interface Chamada {
  tabela: string;
  filtros: Record<string, unknown>;
}

interface OpcoesDoAdminFalso {
  consumoData?: unknown[];
  consumoErro?: string;
  consumoLanca?: boolean;
  agentesData?: unknown[];
  agentesErro?: string;
}

/** Um builder mínimo, thenable, que registra tabela + filtros aplicados de verdade. */
function criarAdminFalso(opts: OpcoesDoAdminFalso) {
  const chamadas: Chamada[] = [];

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
      gte(col: string, val: unknown) {
        filtros[`gte_${col}`] = val;
        return api;
      },
      in(col: string, vals: unknown) {
        filtros[`in_${col}`] = vals;
        return api;
      },
      order(_col: string, _opcoes?: unknown) {
        return api;
      },
      then(resolve: (v: unknown) => void, reject: (e: unknown) => void) {
        chamadas.push({ tabela, filtros: { ...filtros } });
        try {
          if (tabela === "billing_token_consumo_diario") {
            if (opts.consumoLanca) throw new Error("conexão com o banco caiu");
            if (opts.consumoErro) {
              resolve({ data: null, error: { message: opts.consumoErro } });
              return;
            }
            resolve({ data: opts.consumoData ?? [], error: null });
            return;
          }
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

  const admin = { from: (tabela: string) => builder(tabela) } as unknown as SupabaseClient;
  return { admin, chamadas };
}

function logFalso() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const LINHAS_PADRAO = [
  { dia: "2026-09-01", agent_id: AGENTE_ATIVO, tokens_ponderados: 1000, chamadas: 2 },
  { dia: "2026-09-01", agent_id: null, tokens_ponderados: 50, chamadas: 1 },
  { dia: "2026-09-02", agent_id: AGENTE_ATIVO, tokens_ponderados: 3000, chamadas: 5 },
  { dia: "2026-09-02", agent_id: AGENTE_APAGADO, tokens_ponderados: 200, chamadas: 1 },
];

describe("extratoDoCiclo", () => {
  it("agrupa por dia, somando através de agente/contato/propósito", async () => {
    const { admin } = criarAdminFalso({
      consumoData: LINHAS_PADRAO,
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

  it("agrupa por agente: nome resolvido, agente apagado e sem agente", async () => {
    const { admin } = criarAdminFalso({
      consumoData: LINHAS_PADRAO,
      agentesData: [{ id: AGENTE_ATIVO, name: "Agente Vendas" }],
    });

    const r = await extratoDoCiclo(admin, ORG, "2026-09-01");

    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    // Ordenado por maior consumo primeiro (o mesmo corte de
    // `linhasDeTokensDeIA`, tarefa 6): agente ativo (4000), agente apagado
    // (200), depois as conferências sem agente (50).
    expect(r.extrato.porAgente).toEqual([
      { agentId: AGENTE_ATIVO, tipo: "agente", nome: "Agente Vendas", tokensPonderados: 4000, chamadas: 7 },
      { agentId: AGENTE_APAGADO, tipo: "agente_removido", nome: null, tokensPonderados: 200, chamadas: 1 },
      { agentId: null, tipo: "sem_agente", nome: null, tokensPonderados: 50, chamadas: 1 },
    ]);
  });

  it("isolamento: as duas tabelas são filtradas pela organização", async () => {
    const { admin, chamadas } = criarAdminFalso({
      consumoData: LINHAS_PADRAO,
      agentesData: [{ id: AGENTE_ATIVO, name: "Agente Vendas" }],
    });

    await extratoDoCiclo(admin, ORG, "2026-09-01");

    const consumo = chamadas.find((c) => c.tabela === "billing_token_consumo_diario");
    const agentes = chamadas.find((c) => c.tabela === "ai_agents");
    expect(consumo?.filtros.eq_organization_id).toBe(ORG);
    expect(consumo?.filtros.gte_dia).toBe("2026-09-01");
    expect(agentes?.filtros.eq_organization_id).toBe(ORG);
    // Só os agent_id que aparecem no extrato, não uma varredura da tabela inteira.
    expect((agentes?.filtros.in_id as string[]).sort()).toEqual([AGENTE_APAGADO, AGENTE_ATIVO].sort());
  });

  it("sem nenhuma linha com agent_id: não consulta ai_agents", async () => {
    const { admin, chamadas } = criarAdminFalso({ consumoData: [LINHAS_PADRAO[1] as unknown] });

    await extratoDoCiclo(admin, ORG, "2026-09-01");

    expect(chamadas.some((c) => c.tabela === "ai_agents")).toBe(false);
  });

  it("sem nenhuma linha no ciclo: devolve os dois extratos vazios", async () => {
    const { admin } = criarAdminFalso({ consumoData: [] });

    const r = await extratoDoCiclo(admin, ORG, "2026-09-01");

    expect(r).toEqual({ status: "ok", extrato: { ciclo: "2026-09-01", porDia: [], porAgente: [] } });
  });

  it("a consulta do consumo devolve error: nunca lança, vira leitura_falhou e alarma", async () => {
    const { admin } = criarAdminFalso({ consumoErro: "permission denied for table billing_token_consumo_diario" });
    const log = logFalso();

    const r = await extratoDoCiclo(admin, ORG, "2026-09-01", log);

    expect(r).toEqual({ status: "leitura_falhou" });
    expect(log.error).toHaveBeenCalledWith("alarme_planos_leitura", expect.objectContaining({ organization_id: ORG }));
  });

  it("a consulta do consumo lança: nunca propaga, vira leitura_falhou", async () => {
    const { admin } = criarAdminFalso({ consumoLanca: true });

    const r = await extratoDoCiclo(admin, ORG, "2026-09-01");

    expect(r).toEqual({ status: "leitura_falhou" });
  });

  it("a consulta dos agentes devolve error: vira leitura_falhou (não finge nome)", async () => {
    const { admin } = criarAdminFalso({
      consumoData: [LINHAS_PADRAO[0] as unknown],
      agentesErro: "permission denied for table ai_agents",
    });

    const r = await extratoDoCiclo(admin, ORG, "2026-09-01");

    expect(r).toEqual({ status: "leitura_falhou" });
  });

  it("linha fora do esquema (tokens_ponderados não numérico): leitura_falhou", async () => {
    const { admin } = criarAdminFalso({
      consumoData: [{ dia: "2026-09-01", agent_id: null, tokens_ponderados: "muitos", chamadas: 1 }],
    });

    const r = await extratoDoCiclo(admin, ORG, "2026-09-01");

    expect(r).toEqual({ status: "leitura_falhou" });
  });

  it("sem ciclo informado, calcula o primeiro dia do mês corrente e filtra por ele", async () => {
    const { admin, chamadas } = criarAdminFalso({ consumoData: [] });

    const ciclo = primeiroDiaDoCicloAtual();
    const r = await extratoDoCiclo(admin, ORG);

    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(r.extrato.ciclo).toBe(ciclo);
    expect(chamadas.find((c) => c.tabela === "billing_token_consumo_diario")?.filtros.gte_dia).toBe(ciclo);
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
