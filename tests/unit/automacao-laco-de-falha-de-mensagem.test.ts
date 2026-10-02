/**
 * D-114: regra `message.failed` → enviar mensagem não pode entrar em laço.
 *
 * A mensagem que a própria regra manda falha (131047, send_timeout), o evento
 * `message.failed` sai SEM `caused_by_rule`, e o motor roda a regra de novo,
 * sem fim (e com IA cada volta é uma chamada paga). Três travas:
 *  1. falha de mensagem da própria automação (`sent_via = 'automation'`) não
 *     dispara regra;
 *  2. teto de falhas por contato por hora: mesmo uma origem que escape da trava 1
 *     para de girar;
 *  3. evento velho (backlog reprocessado dias depois) sai `evento_antigo`.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

import { runAutomationForEvent } from "@/lib/automation/engine";
import {
  idadeMaximaDoEventoMs,
  TETO_FALHAS_POR_CONTATO_POR_HORA,
} from "@/lib/automation/protecao-de-laco";
import type { EventRow } from "@/lib/event-log/dispatcher";

function admin(opts: { falhasDoContatoNaHora?: number } = {}) {
  const tabelas: string[] = [];
  const filtros: Array<[string, unknown]> = [];
  const client = {
    from: (tabela: string) => {
      tabelas.push(tabela);
      if (tabela === "event_log") {
        const q = {
          select: () => q,
          eq: (col: string, val: unknown) => {
            filtros.push([col, val]);
            return q;
          },
          gte: (col: string, val: unknown) => {
            filtros.push([col, val]);
            return q;
          },
          then: (res: (v: unknown) => unknown) =>
            res({ count: opts.falhasDoContatoNaHora ?? 0, error: null }),
        };
        return q;
      }
      if (tabela === "automation_rules") {
        // Sem regra ativa: o teste só quer saber se o motor CHEGOU até aqui.
        const q = {
          select: () => q,
          eq: () => q,
          order: async () => ({ data: [], error: null }),
        };
        return q;
      }
      throw new Error(`tabela não esperada: ${tabela}`);
    },
  };
  return { client: client as never, tabelas, filtros };
}

function evento(parcial: Partial<EventRow> & { payload?: Record<string, unknown> }): EventRow {
  return {
    id: "ev-1",
    organization_id: "org-1",
    event_type: "message.failed",
    entity_kind: "message",
    entity_id: "msg-1",
    payload: { contact_id: "c-1", sent_via: "user" },
    metadata: {},
    consumed_by: [],
    attempts: 0,
    created_at: new Date(Date.now() - 60_000).toISOString(),
    ...parcial,
  } as unknown as EventRow;
}

describe("D-114: laço de message.failed", () => {
  it("falha de mensagem enviada pela própria automação não dispara regra", async () => {
    const { client, tabelas } = admin();
    const r = await runAutomationForEvent(
      client,
      evento({ payload: { contact_id: "c-1", sent_via: "automation" } }),
    );
    expect(r.status).toBe("skipped");
    expect(r.detail).toBe("falha_de_mensagem_da_automacao");
    expect(tabelas).not.toContain("automation_rules");
  });

  it("falha de mensagem humana ou da IA segue para as regras", async () => {
    for (const via of ["user", "ai", "crm"]) {
      const { client, tabelas } = admin();
      const r = await runAutomationForEvent(
        client,
        evento({ payload: { contact_id: "c-1", sent_via: via } }),
      );
      expect(r.detail).toBe("no_rules");
      expect(tabelas).toContain("automation_rules");
    }
  });

  it("passou do teto de falhas do contato na hora: o laço para", async () => {
    const { client, tabelas, filtros } = admin({
      falhasDoContatoNaHora: TETO_FALHAS_POR_CONTATO_POR_HORA + 1,
    });
    const r = await runAutomationForEvent(client, evento({}));
    expect(r.status).toBe("skipped");
    expect(r.detail).toBe("teto_de_falhas_por_contato");
    expect(tabelas).not.toContain("automation_rules");
    // A contagem é do contato e da organização do evento.
    expect(filtros).toContainEqual(["organization_id", "org-1"]);
    expect(filtros).toContainEqual(["payload->>contact_id", "c-1"]);
  });

  it("dentro do teto, segue normalmente", async () => {
    const { client } = admin({ falhasDoContatoNaHora: TETO_FALHAS_POR_CONTATO_POR_HORA });
    const r = await runAutomationForEvent(client, evento({}));
    expect(r.detail).toBe("no_rules");
  });

  it("evento velho reprocessado sai evento_antigo sem consultar regra", async () => {
    const { client, tabelas } = admin();
    const velho = new Date(Date.now() - idadeMaximaDoEventoMs("message.failed") - 60_000).toISOString();
    const r = await runAutomationForEvent(client, evento({ created_at: velho }));
    expect(r.status).toBe("skipped");
    expect(r.detail).toBe("evento_antigo");
    expect(tabelas).toEqual([]);
  });

  it("evento sem created_at falha aberto: não descarta o que não sabe que é velho", async () => {
    const { client } = admin();
    const r = await runAutomationForEvent(client, evento({ created_at: undefined }));
    expect(r.detail).toBe("no_rules");
  });

  it("outros gatilhos também têm teto de idade, maior que o de falha de mensagem", async () => {
    const { client } = admin();
    expect(idadeMaximaDoEventoMs("lead.created")).toBeGreaterThan(idadeMaximaDoEventoMs("message.failed"));
    const velho = new Date(Date.now() - idadeMaximaDoEventoMs("lead.created") - 60_000).toISOString();
    const r = await runAutomationForEvent(
      client,
      evento({ event_type: "lead.created", entity_kind: "crm_lead", created_at: velho }),
    );
    expect(r.detail).toBe("evento_antigo");
  });
});
