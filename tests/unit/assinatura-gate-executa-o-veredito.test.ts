/**
 * O GATE DA ASSINATURA SUSPENSA (MODO LEITURA), decisões 5 e 6 da fase F4
 * (`hiperbold/planos/fase-F4-tarefas.md`, Tarefa 6).
 *
 * Mesmo molde de `tests/unit/carteira-gate-executa-o-veredito.test.ts`: um pool
 * falso casado por pedaço de SQL, o seam exercitado de ponta a ponta via
 * `runModelCall`, e o controle positivo é "o provedor foi alcançado" (a
 * SENTINELA), prova que o gate deixou passar quando devia.
 *
 * O orçamento em dólar e a carteira de tokens são sempre deixados frouxos neste
 * arquivo (`modo: 'off'`/`bloqueioDePlanos: 'off'` implícito via `veredito`
 * sempre 'seguir'): o que está sob teste aqui é o PRIMEIRO gate — a assinatura
 * roda ANTES dos outros dois.
 */
import { describe, expect, it, vi } from "vitest";

import {
  runModelCall,
  LlmAssinaturaSuspensaError,
  LlmBudgetExceededError,
  LlmCarteiraEsgotadaError,
  normalizarErro,
} from "@/lib/agent-engine/edge/llm/run-model-call";
import { deveConsultarAssinatura, TITULO_ASSINATURA_SUSPENSA } from "@/lib/agent-engine/edge/llm/assinatura";

const ORG = "55555555-5555-4555-8555-555555555555";

/** O erro que prova que a chamada CHEGOU ao provedor, isto é, que o gate deixou passar. */
const SENTINELA = new Error("o provedor foi alcançado");

interface Estado {
  /** `billing_settings.modo`, 'erro' simula a query falhando. */
  modoDeBilling?: "desligado" | "avisar" | "bloquear" | "erro";
  /** O que `fn_billing_modo_leitura` devolveria, ou 'erro'. */
  leitura?: boolean | "erro";
}

function poolFalso(estado: Estado) {
  const sqls: string[] = [];
  const inboxInserts: unknown[][] = [];
  const llmCallInserts: unknown[][] = [];

  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    sqls.push(sql);
    // Orçamento em dólar: SEMPRE 'off' (atalho de custo, nem consulta) — o que
    // está sob teste aqui é o gate ANTERIOR (assinatura).
    if (sql.includes("left join ai_budgets")) {
      return {
        rows: [
          {
            llm: { provider: "anthropic", default_model: "claude-padrao", params: {}, enabled_models: [] },
            teto: 1000,
            modo: "off",
            efetivo_em: null,
            limiar_pct: 80,
          },
        ],
      };
    }
    if (sql.includes("settings->'llm'")) {
      return { rows: [{ llm: { provider: "anthropic", default_model: "claude-padrao" } }] };
    }
    if (sql.includes("ai_purpose_bindings")) return { rows: [] };
    if (sql.includes("ai_provider_credentials")) return { rows: [] };
    if (sql.includes("billing_settings")) {
      if (estado.modoDeBilling === "erro") throw new Error("banco fora");
      return { rows: [{ modo: estado.modoDeBilling ?? "bloquear" }] };
    }
    if (sql.includes("fn_billing_modo_leitura")) {
      if (estado.leitura === "erro") throw new Error("banco fora");
      return { rows: [{ leitura: estado.leitura ?? true }] };
    }
    // A carteira, quando alcançada, SEMPRE segue (fora de escopo deste arquivo).
    if (sql.includes("fn_billing_ia_pode_responder")) {
      return { rows: [{ veredito: { acao: "seguir", motivo: "sem teto", saldo: null, ciclo: null } }] };
    }
    if (sql.includes("insert into agent_inbox_items")) {
      inboxInserts.push(params);
      return { rows: [] };
    }
    if (sql.includes("insert into llm_calls")) {
      llmCallInserts.push(params);
      return { rows: [{ id: "call-1" }] };
    }
    return { rows: [] };
  });

  return { pool: { query } as never, query, sqls, inboxInserts, llmCallInserts };
}

function registryQueRegistra() {
  const invocacoes: string[] = [];
  const fabrica = (_chave: string, modelo: string) => {
    invocacoes.push(modelo);
    return {
      specificationVersion: "v3",
      provider: "anthropic",
      modelId: modelo,
      doGenerate: async () => {
        throw SENTINELA;
      },
    } as never;
  };
  return {
    invocacoes,
    registry: { anthropic: fabrica, openai: fabrica, google: fabrica, openrouter: fabrica },
  };
}

function loggerFalso() {
  const linhas: Array<{ nivel: string; msg: string; campos: Record<string, unknown> }> = [];
  const push = (nivel: string) => (msg: string, campos: Record<string, unknown> = {}) =>
    void linhas.push({ nivel, msg, campos });
  return { linhas, log: { info: push("info"), warn: push("warn"), error: push("error") } };
}

async function chamar(
  estado: Estado,
  cfg: { bloqueioDePlanos?: "on" | "avisar" | "off" } = {},
  input: Record<string, unknown> = {},
) {
  const p = poolFalso(estado);
  const r = registryQueRegistra();
  const l = loggerFalso();
  let lancou: unknown = null;
  try {
    await runModelCall(
      p.pool,
      { anthropicApiKey: "sk-ant-x", cacheTtl: "1h", ...cfg },
      { tenantId: ORG, messages: [{ role: "user", content: "oi" }], ...input } as never,
      { registry: r.registry as never, log: l.log },
    );
  } catch (err) {
    lancou = err;
  }
  return { ...p, ...r, ...l, lancou };
}

describe("o gate da assinatura suspensa (modo leitura) lê fn_billing_modo_leitura antes da carteira", () => {
  describe("controle positivo: em modo leitura, lança, grava e avisa", () => {
    it("recusa antes de tocar no provedor, com o erro tipado (subclasse do orçamento, IRMÃ da carteira)", async () => {
      const r = await chamar({});
      expect(r.lancou).toBeInstanceOf(LlmAssinaturaSuspensaError);
      expect(r.lancou).toBeInstanceOf(LlmBudgetExceededError);
      expect(r.lancou).not.toBeInstanceOf(LlmCarteiraEsgotadaError);
      expect(r.invocacoes).toEqual([]);
    });

    it("roda ANTES da carteira: a RPC de saldo nunca é chamada quando a assinatura já bloqueou", async () => {
      const r = await chamar({});
      expect(r.sqls.some((s) => s.includes("fn_billing_ia_pode_responder"))).toBe(false);
    });

    it("abre UM aviso com ref_kind PRÓPRIO, título literal da decisão 6, deduplicado por título aberto", async () => {
      const r = await chamar({});
      expect(r.inboxInserts).toHaveLength(1);
      const sqlDoInsert = r.sqls.find(
        (s) => s.includes("insert into agent_inbox_items") && !s.includes("fn_billing_modo_leitura"),
      );
      expect(sqlDoInsert).toMatch(/ref_kind/);
      expect(sqlDoInsert).toMatch(/'billing_assinatura'/);
      expect(sqlDoInsert).toMatch(/not exists/i);
      expect(sqlDoInsert).toMatch(/status\s*=\s*'open'/);
      const [, titulo, corpo] = r.inboxInserts[0] as [string, string, string];
      expect(titulo).toBe(TITULO_ASSINATURA_SUSPENSA);
      expect(corpo).toMatch(/Plano e uso/);
    });

    it("a recusa vira linha de ERRO em llm_calls, com error_code PRÓPRIO", async () => {
      const r = await chamar({});
      expect(r.llmCallInserts).toHaveLength(1);
      expect(r.llmCallInserts[0]).toContain("assinatura_suspensa");
    });

    it("o erro é classificado com código próprio, e não o da carteira nem do orçamento em dólar", () => {
      expect(normalizarErro(new LlmAssinaturaSuspensaError()).error_code).toBe("assinatura_suspensa");
      expect(normalizarErro(new LlmCarteiraEsgotadaError(0)).error_code).toBe("carteira_de_tokens_esgotada");
      expect(normalizarErro(new LlmBudgetExceededError()).error_code).toBe("orcamento_esgotado");
    });

    it("é terminal, herdado, a fila cancela em vez de repetir", () => {
      expect(new LlmAssinaturaSuspensaError().terminal).toBe(true);
    });
  });

  describe("fora do modo leitura, segue", () => {
    it("fn_billing_modo_leitura devolvendo false SEGUE, sem aviso nenhum", async () => {
      const r = await chamar({ leitura: false });
      expect(r.lancou).toBe(SENTINELA);
      expect(r.inboxInserts).toHaveLength(0);
    });
  });

  describe("zero consulta a mais, os atalhos de custo", () => {
    it("modo 'avisar' no banco NUNCA consulta fn_billing_modo_leitura", async () => {
      const r = await chamar({ modoDeBilling: "avisar" });
      expect(r.lancou).toBe(SENTINELA);
      expect(r.sqls.some((s) => s.includes("fn_billing_modo_leitura"))).toBe(false);
    });

    it("modo 'desligado' no banco NUNCA consulta fn_billing_modo_leitura", async () => {
      const r = await chamar({ modoDeBilling: "desligado" });
      expect(r.lancou).toBe(SENTINELA);
      expect(r.sqls.some((s) => s.includes("fn_billing_modo_leitura"))).toBe(false);
    });

    it("PLANOS_BLOQUEIO=off nem lê billing_settings.modo", async () => {
      const r = await chamar({}, { bloqueioDePlanos: "off" });
      expect(r.lancou).toBe(SENTINELA);
      expect(r.sqls.some((s) => s.includes("billing_settings"))).toBe(false);
      expect(r.sqls.some((s) => s.includes("fn_billing_modo_leitura"))).toBe(false);
    });

    it("propósito de segurança interna (jailbreak_detect) nunca consulta a assinatura", async () => {
      const r = await chamar({}, {}, { purpose: "jailbreak_detect" });
      expect(r.lancou).toBe(SENTINELA);
      expect(r.sqls.some((s) => s.includes("fn_billing_modo_leitura"))).toBe(false);
    });

    it("propósito de segurança interna (promise_semantic) nunca consulta a assinatura", async () => {
      const r = await chamar({}, {}, { purpose: "promise_semantic" });
      expect(r.lancou).toBe(SENTINELA);
      expect(r.sqls.some((s) => s.includes("fn_billing_modo_leitura"))).toBe(false);
    });
  });

  describe("decisão 6: a suspensão vale para QUALQUER chave e propósito que responda ao cliente", () => {
    it("connection_test (isento no orçamento em dólar) NÃO é isento aqui — a assinatura ainda bloqueia", async () => {
      const r = await chamar({}, {}, { purpose: "connection_test" });
      expect(r.lancou).toBeInstanceOf(LlmAssinaturaSuspensaError);
    });

    it("chave da ORGANIZAÇÃO (BYOK) também para — ao contrário da carteira, que só debita a chave da instalação", () => {
      // `deveConsultarAssinatura` não recebe `origemDaChave`: não há atalho
      // nenhum por origem, decisão 6 da fase F4.
      expect(
        deveConsultarAssinatura({ chave: "on", modoDoBanco: "bloquear", purpose: "agent_turn" }),
      ).toBe(true);
    });

    it("agent_turn (propósito que responde ao cliente) consulta e é bloqueado em modo leitura", async () => {
      const r = await chamar({}, {}, { purpose: "agent_turn" });
      expect(r.lancou).toBeInstanceOf(LlmAssinaturaSuspensaError);
    });
  });

  describe("a chave de emergência PLANOS_BLOQUEIO só sabe afrouxar", () => {
    it("'avisar' rebaixa o bloqueio para um log, nunca lança", async () => {
      const r = await chamar({}, { bloqueioDePlanos: "avisar" });
      expect(r.lancou).toBe(SENTINELA);
      expect(r.inboxInserts).toHaveLength(0);
    });
  });

  describe("falha ABERTA, soluço de leitura nunca bloqueia", () => {
    it("billing_settings inacessível SEGUE, e avisa no log", async () => {
      const r = await chamar({ modoDeBilling: "erro" });
      expect(r.lancou).toBe(SENTINELA);
      expect(r.linhas.some((l) => l.nivel === "warn")).toBe(true);
    });

    it("fn_billing_modo_leitura falhando SEGUE, e avisa no log", async () => {
      const r = await chamar({ leitura: "erro" });
      expect(r.lancou).toBe(SENTINELA);
      expect(r.linhas.some((l) => l.nivel === "warn")).toBe(true);
    });
  });

  describe("leitura do modo em cache, 60s por pool, compartilhada com a carteira", () => {
    it("duas chamadas no mesmo pool leem billing_settings.modo UMA vez", async () => {
      const p = poolFalso({ modoDeBilling: "avisar" });
      const r1 = registryQueRegistra();
      const l1 = loggerFalso();
      const cfg = { anthropicApiKey: "sk-ant-x", cacheTtl: "1h" as const };
      const input = { tenantId: ORG, messages: [{ role: "user" as const, content: "oi" }] };
      await expect(
        runModelCall(p.pool, cfg, input as never, { registry: r1.registry as never, log: l1.log }),
      ).rejects.toBe(SENTINELA);
      await expect(
        runModelCall(p.pool, cfg, input as never, { registry: r1.registry as never, log: l1.log }),
      ).rejects.toBe(SENTINELA);
      const leituras = p.sqls.filter((s) => s.includes("billing_settings")).length;
      expect(leituras).toBe(1);
    });
  });
});
