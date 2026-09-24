import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

import { runAutomationForEvent } from "@/lib/automation/engine";
import type { EventRow } from "@/lib/event-log/dispatcher";

/**
 * Tarefa 7, fase F4: `runAutomationForEvent` não dispara nenhuma ação quando
 * a organização está em modo leitura, e não consulta nada a mais quando o
 * modo (cacheado) não é 'bloquear': o requisito "no modo avisar nada muda e
 * nenhuma consulta a mais acontece" da fase.
 *
 * Supabase falso mínimo: só as tabelas que `runAutomationForEvent` toca antes
 * do gate (automation_rules) e no próprio gate (billing_settings, RPC
 * fn_billing_modo_leitura, automation_rule_runs).
 */
function fakeAdmin(opts: { modo: string | null; modoLeitura: boolean; regras: Array<{ id: string }> }) {
  const chamadas: string[] = [];
  const runsInseridas: Array<Record<string, unknown>> = [];
  let chamadasRpc = 0;

  const admin = {
    from: (tabela: string) => {
      chamadas.push(tabela);
      if (tabela === "automation_rules") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  order: async () => ({ data: opts.regras, error: null }),
                }),
              }),
            }),
          }),
        };
      }
      if (tabela === "billing_settings") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: { modo: opts.modo }, error: null }),
            }),
          }),
        };
      }
      if (tabela === "automation_rule_runs") {
        return {
          insert: (row: Record<string, unknown>) => {
            runsInseridas.push(row);
            return {
              select: () => ({
                maybeSingle: async () => ({ data: { id: "run-1" }, error: null }),
              }),
            };
          },
        };
      }
      throw new Error(`tabela não esperada no teste: ${tabela}`);
    },
    rpc: async (nome: string) => {
      if (nome === "fn_billing_modo_leitura") {
        chamadasRpc += 1;
        return { data: opts.modoLeitura, error: null };
      }
      throw new Error(`rpc não esperada no teste: ${nome}`);
    },
  };

  return { admin: admin as never, chamadas, runsInseridas, contarRpc: () => chamadasRpc };
}

const EVENTO: EventRow = {
  id: "event-1",
  organization_id: "org-1",
  event_type: "custom.event_sem_gatilho_mapeado",
  entity_kind: "outro",
  entity_id: "entity-1",
  payload: {},
  metadata: {},
} as unknown as EventRow;

describe("automação × modo leitura (Tarefa 7)", () => {
  it("modo bloquear + RPC true: não dispara ação nenhuma, grava failed/assinatura_suspensa e consome o evento", async () => {
    const { admin, runsInseridas, contarRpc } = fakeAdmin({
      modo: "bloquear",
      modoLeitura: true,
      regras: [{ id: "rule-1" }],
    });

    const resultado = await runAutomationForEvent(admin, EVENTO);

    expect(resultado.status).toBe("ok");
    expect(resultado.detail).toBe("assinatura_suspensa");
    expect(runsInseridas).toHaveLength(1);
    expect(runsInseridas[0]).toMatchObject({
      rule_id: "rule-1",
      status: "failed",
      actions_result: [{ type: "assinatura_suspensa", status: "failed", detail: { reason: "assinatura_suspensa" } }],
    });
    expect(contarRpc()).toBe(1);
  });

  // As duas próximas regras trazem uma condição que nunca bate (campo ausente
  // do contexto): depois do gate de modo leitura, a automação cai em
  // "no_match" sem tocar automation_rule_runs de novo, o que estas duas
  // querem provar é só o comportamento do gate (RPC chamada ou não, evento
  // marcado failed ou não), não o caminho inteiro de execução de ações.
  const REGRA_SEM_MATCH = [{ id: "rule-1", conditions: [{ field: "nao.existe", op: "eq", value: "x" }] }];

  it("modo avisar: NENHUMA consulta a mais, a RPC de modo leitura nunca é chamada", async () => {
    const { admin, runsInseridas, contarRpc } = fakeAdmin({
      modo: "avisar",
      modoLeitura: true, // se a RPC fosse chamada, isto pararia a automação: prova que não foi
      regras: REGRA_SEM_MATCH,
    });

    const resultado = await runAutomationForEvent(admin, EVENTO);

    expect(resultado.detail).not.toBe("assinatura_suspensa");
    expect(runsInseridas).not.toContainEqual(expect.objectContaining({ status: "failed" }));
    expect(contarRpc()).toBe(0);
  });

  it("modo bloquear + RPC false (carência não vencida, ou status ativo): automação segue normalmente", async () => {
    const { admin, runsInseridas } = fakeAdmin({
      modo: "bloquear",
      modoLeitura: false,
      regras: REGRA_SEM_MATCH,
    });

    const resultado = await runAutomationForEvent(admin, EVENTO);

    expect(resultado.detail).not.toBe("assinatura_suspensa");
    expect(runsInseridas).not.toContainEqual(expect.objectContaining({ status: "failed" }));
  });

  it("falha na leitura do modo leitura NÃO para a automação (fail-open)", async () => {
    const admin = {
      from: (tabela: string) => {
        if (tabela === "automation_rules") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  eq: () => ({
                    // Condição que nunca bate (campo ausente do contexto): garante
                    // "no_match" logo depois do gate, sem tocar automation_rule_runs
                    // de novo, o que este teste quer provar é só o fail-open do
                    // gate, não o caminho inteiro de execução.
                    order: async () => ({
                      data: [{ id: "rule-1", conditions: [{ field: "nao.existe", op: "eq", value: "x" }] }],
                      error: null,
                    }),
                  }),
                }),
              }),
            }),
          };
        }
        if (tabela === "billing_settings") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: null, error: { message: "conexão recusada" } }),
              }),
            }),
          };
        }
        throw new Error(`tabela não esperada: ${tabela}`);
      },
      rpc: async () => {
        throw new Error("RPC não deveria ser chamada quando a leitura do modo já falhou");
      },
    };

    const resultado = await runAutomationForEvent(admin as never, EVENTO);
    // Sem regra que bata condição (objeto vazio), a automação segue até "no_match",
    // o que prova que o gate de modo leitura NÃO interrompeu o fluxo por causa
    // da falha de leitura (fail-open: devolve falso, não pára o produtor).
    expect(resultado.detail).not.toBe("assinatura_suspensa");
  });
});
