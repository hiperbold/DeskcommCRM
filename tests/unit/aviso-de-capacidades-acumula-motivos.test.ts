/**
 * O AVISO DE CAPACIDADES AUSENTES NÃO PODE FICAR PRESO AO PRIMEIRO MOTIVO
 * (D-039).
 *
 * `avisarCapacidadesAusentes` só INSERIA um item `capabilities_missing` se
 * não houvesse um aberto na organização. Enquanto o primeiro seguisse aberto,
 * um motivo novo (uma segunda conexão MCP caindo depois da primeira, por
 * exemplo) não gerava aviso nenhum nem atualizava o texto do item — o admin
 * nunca ficava sabendo do segundo problema.
 *
 * Dublê de `pg.Pool` que registra o SQL e os parâmetros (mesmo padrão de
 * `tests/unit/despacho-da-ia-que-morre-avisa-a-central.test.ts`): o dedupe de
 * verdade contra a tabela real (o `where not exists` do INSERT) já é medido
 * com Postgres em `tests/invariants/capacidades-ausentes.test.ts` — aqui o
 * que se prova é a DECISÃO (criar vs. calar vs. atualizar), não a corrida.
 *
 *     npx vitest run tests/unit/aviso-de-capacidades-acumula-motivos.test.ts
 */
import { describe, expect, it, vi } from "vitest";
import type pg from "pg";

import { avisarCapacidadesAusentes } from "@/lib/agent-engine/agent/inbound-turn";

const ORG = "abcd0000-0000-4000-8000-000000000001";
const CONVERSA = "11111111-1111-4111-8111-111111111111";

interface Chamada {
  sql: string;
  params: unknown[];
}

/**
 * `linhaAberta` simula o que o SELECT devolveria: `undefined` quando não há
 * item `capabilities_missing` aberto na organização (primeira chamada, ou
 * depois de um resolvido), ou `{ id, body }` do item já aberto.
 */
function poolComItemAberto(linhaAberta?: { id: string; body: string }) {
  const chamadas: Chamada[] = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    chamadas.push({ sql, params });
    if (sql.includes("select id, body from agent_inbox_items")) {
      return { rows: linhaAberta ? [linhaAberta] : [] };
    }
    return { rows: [] };
  });
  return { pool: { query } as unknown as pg.Pool, chamadas };
}

function log() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe("avisarCapacidadesAusentes — acumula motivo em vez de calar", () => {
  it("primeiro motivo: sem item aberto, faz o INSERT com o motivo no corpo", async () => {
    const { pool, chamadas } = poolComItemAberto(undefined);

    await avisarCapacidadesAusentes(pool, ORG, CONVERSA, "conexão MCP indisponível: mcp_n8n__buscar", log() as never);

    const insert = chamadas.find((c) => c.sql.includes("insert into agent_inbox_items"));
    expect(insert, "sem item aberto, tinha que ter criado um").toBeDefined();
    const [organizacao, , corpo] = insert!.params as string[];
    expect(organizacao).toBe(ORG);
    expect(corpo).toContain("conexão MCP indisponível: mcp_n8n__buscar");
    expect(chamadas.some((c) => c.sql.includes("update agent_inbox_items"))).toBe(false);
  });

  it("motivo repetido: item aberto já traz o motivo no corpo — não escreve nada", async () => {
    const { pool, chamadas } = poolComItemAberto({
      id: "item-1",
      body: "As ferramentas configuradas na tela do agente não puderam ser carregadas neste atendimento, e ele respondeu ao cliente sem elas. A conversa não foi interrompida. Motivos técnicos: conexão MCP indisponível: mcp_n8n__buscar",
    });

    await avisarCapacidadesAusentes(pool, ORG, CONVERSA, "conexão MCP indisponível: mcp_n8n__buscar", log() as never);

    expect(chamadas.some((c) => c.sql.includes("insert into agent_inbox_items"))).toBe(false);
    expect(chamadas.some((c) => c.sql.includes("update agent_inbox_items"))).toBe(false);
  });

  it("motivo novo: item aberto SEM esse motivo — atualiza o corpo acumulando os dois, sem duplicar item", async () => {
    const { pool, chamadas } = poolComItemAberto({
      id: "item-1",
      body: "As ferramentas configuradas na tela do agente não puderam ser carregadas neste atendimento, e ele respondeu ao cliente sem elas. A conversa não foi interrompida. Motivos técnicos: conexão MCP indisponível: mcp_n8n__buscar",
    });

    await avisarCapacidadesAusentes(
      pool,
      ORG,
      CONVERSA,
      "Há ferramentas de conexão MCP marcadas no agente aguardando aprovação do admin em IA › Conexões MCP. Elas não rodam até serem aprovadas.",
      log() as never,
    );

    expect(chamadas.some((c) => c.sql.includes("insert into agent_inbox_items")), "não pode duplicar o item").toBe(
      false,
    );
    const update = chamadas.find((c) => c.sql.includes("update agent_inbox_items"));
    expect(update, "motivo novo com item aberto tinha que atualizar o corpo").toBeDefined();
    const [id, corpo] = update!.params as [string, string];
    expect(id).toBe("item-1");
    // Acumula: o motivo antigo continua legível junto do novo.
    expect(corpo).toContain("conexão MCP indisponível: mcp_n8n__buscar");
    expect(corpo).toContain("Conexões MCP");
  });

  /**
   * Corpo cheio para de acumular em vez de gravar texto cortado. Cortar no meio
   * faria a conferência de "motivo já registrado" nunca mais casar, e o motivo
   * seguinte viraria um UPDATE por turno, para sempre.
   */
  it("teto de tamanho: corpo cheio não vira escrita a cada turno", async () => {
    const { pool, chamadas } = poolComItemAberto({
      id: "item-1",
      body: "prefixo. Motivos técnicos: " + "x".repeat(3980),
    });

    await avisarCapacidadesAusentes(pool, ORG, CONVERSA, "motivo novo bem específico", log() as never);

    expect(chamadas.find((c) => c.sql.includes("update agent_inbox_items"))).toBeUndefined();
    expect(chamadas.find((c) => c.sql.includes("insert into agent_inbox_items"))).toBeUndefined();
  });

  it("falha ao consultar não derruba o turno — best-effort", async () => {
    const query = vi.fn(async () => {
      throw new Error("Connection terminated unexpectedly");
    });
    const pool = { query } as unknown as pg.Pool;
    const l = log();

    await expect(avisarCapacidadesAusentes(pool, ORG, CONVERSA, "motivo qualquer", l as never)).resolves.toBeUndefined();
    expect(l.warn).toHaveBeenCalledWith(
      "aviso de capacidades ausentes não foi gravado",
      expect.objectContaining({ error: expect.any(String) }),
    );
  });
});
