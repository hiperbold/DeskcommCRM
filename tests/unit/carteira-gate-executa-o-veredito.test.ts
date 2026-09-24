/**
 * O GATE DA CARTEIRA DE TOKENS, decisões 6 e 7 da fase F3
 * (`hiperbold/planos/fase-F3-tarefas.md`).
 *
 * Mesmo molde de `tests/unit/orcamento-gate-executa-o-veredito.test.ts`: um pool
 * falso casado por pedaço de SQL, o seam exercitado de ponta a ponta via
 * `runModelCall`, e o controle positivo é "o provedor foi alcançado" (a SENTINELA)
 *, prova que o gate deixou passar quando devia.
 *
 * O orçamento em dólar (`ai_budgets`) é sempre deixado em `modo: 'off'` neste
 * arquivo: ele roda ANTES da carteira no seam, e se ficasse no padrão
 * `bloquear` (como no teste irmão) toda chamada pararia ali, antes de a carteira
 * sequer ser consultada, o que está sob teste aqui é o SEGUNDO gate.
 */
import { describe, expect, it, vi } from "vitest";

import {
  runModelCall,
  LlmBudgetExceededError,
  LlmCarteiraEsgotadaError,
  normalizarErro,
} from "@/lib/agent-engine/edge/llm/run-model-call";
import { deveConsultarCarteira } from "@/lib/agent-engine/edge/llm/carteira";

const ORG = "44444444-4444-4444-8444-444444444444";

/** O erro que prova que a chamada CHEGOU ao provedor, isto é, que o gate deixou passar. */
const SENTINELA = new Error("o provedor foi alcançado");

interface Estado {
  /** `billing_settings.modo`, 'erro' simula a query falhando. */
  modoDeBilling?: "desligado" | "avisar" | "bloquear" | "erro";
  /** O jsonb que `fn_billing_ia_pode_responder` devolveria, ou 'erro'. */
  veredito?: Record<string, unknown> | "erro";
}

function poolFalso(estado: Estado) {
  const sqls: string[] = [];
  const inboxInserts: unknown[][] = [];
  const llmCallInserts: unknown[][] = [];

  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    sqls.push(sql);
    // Orçamento em dólar: SEMPRE 'off' (atalho de custo, nem consulta), ver o
    // cabeçalho do arquivo sobre por que este gate precisa ficar fora do caminho.
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
    if (sql.includes("fn_billing_ia_pode_responder")) {
      if (estado.veredito === "erro") throw new Error("banco fora");
      const v = estado.veredito ?? { acao: "bloquear", motivo: "saldo de tokens esgotado", saldo: 0, ciclo: "2026-09-01" };
      return { rows: [{ veredito: v }] };
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

describe("o gate da carteira de tokens lê billing_settings e executa o veredito", () => {
  describe("controle positivo, bloquear lança, grava e avisa", () => {
    it("recusa antes de tocar no provedor, com o erro tipado (subclasse do orçamento)", async () => {
      const r = await chamar({});
      expect(r.lancou).toBeInstanceOf(LlmCarteiraEsgotadaError);
      expect(r.lancou).toBeInstanceOf(LlmBudgetExceededError);
      expect(r.invocacoes).toEqual([]);
    });

    it("abre UM aviso com ref_kind PRÓPRIO, deduplicado, não se mistura com budget_exceeded", async () => {
      const r = await chamar({});
      expect(r.inboxInserts).toHaveLength(1);
      const sqlDoInsert = r.sqls.find(
        (s) => s.includes("insert into agent_inbox_items") && !s.includes("fn_billing_ia_pode_responder"),
      );
      expect(sqlDoInsert).toMatch(/ref_kind/);
      expect(sqlDoInsert).toMatch(/'billing_carteira'/);
      expect(sqlDoInsert).toMatch(/not exists/i);
      const [, titulo, corpo] = r.inboxInserts[0] as [string, string, string];
      expect(titulo).toBe("Os tokens de IA do mês acabaram");
      expect(corpo).toMatch(/Plano e uso/);
      expect(corpo).not.toMatch(/Uso de IA › Orçamento/);
    });

    it("a recusa vira linha de ERRO em llm_calls, com error_code PRÓPRIO", async () => {
      const r = await chamar({});
      expect(r.llmCallInserts).toHaveLength(1);
      expect(r.llmCallInserts[0]).toContain("carteira_de_tokens_esgotada");
    });

    it("o erro é classificado com código próprio, e não o do orçamento em dólar", () => {
      expect(normalizarErro(new LlmCarteiraEsgotadaError(0)).error_code).toBe("carteira_de_tokens_esgotada");
      expect(normalizarErro(new LlmBudgetExceededError()).error_code).toBe("orcamento_esgotado");
    });

    it("é terminal, herdado, a fila cancela em vez de repetir", () => {
      expect(new LlmCarteiraEsgotadaError(0).terminal).toBe(true);
    });
  });

  describe("avisar_e_seguir segue, sem duplicar o aviso da própria carteira", () => {
    it("saldo baixo (10%) SEGUE, e não abre um segundo aviso, a carteira já tem o dela", async () => {
      const r = await chamar({
        veredito: { acao: "avisar_e_seguir", motivo: "saldo de tokens abaixo de 10 por cento do mes", saldo: 50, ciclo: "2026-09-01" },
      });
      expect(r.lancou).toBe(SENTINELA);
      expect(r.inboxInserts).toHaveLength(0);
    });
  });

  describe("zero consulta a mais, os quatro atalhos de custo", () => {
    it("modo 'avisar' no banco NUNCA consulta a RPC de saldo", async () => {
      const r = await chamar({ modoDeBilling: "avisar" });
      expect(r.lancou).toBe(SENTINELA);
      expect(r.sqls.some((s) => s.includes("fn_billing_ia_pode_responder"))).toBe(false);
    });

    it("PLANOS_BLOQUEIO=off nem lê billing_settings.modo", async () => {
      const r = await chamar({}, { bloqueioDePlanos: "off" });
      expect(r.lancou).toBe(SENTINELA);
      expect(r.sqls.some((s) => s.includes("billing_settings"))).toBe(false);
      expect(r.sqls.some((s) => s.includes("fn_billing_ia_pode_responder"))).toBe(false);
    });

    it("chave da ORGANIZAÇÃO (BYOK) nunca é bloqueada pela carteira da instalação", () => {
      // Só a chave da INSTALAÇÃO debita a carteira (0906): a organização com
      // credencial própria paga a conta dela, não a carteira do plano.
      expect(
        deveConsultarCarteira({
          chave: "on",
          modoDoBanco: "bloquear",
          origemDaChave: "credencial_da_organizacao",
          purpose: "agent_turn",
        }),
      ).toBe(false);
    });

    it("propósito isento (jailbreak_detect) nunca consulta a carteira", async () => {
      const r = await chamar({}, {}, { purpose: "jailbreak_detect" });
      expect(r.lancou).toBe(SENTINELA);
      expect(r.sqls.some((s) => s.includes("fn_billing_ia_pode_responder"))).toBe(false);
    });
  });

  describe("a chave de emergência PLANOS_BLOQUEIO só sabe afrouxar", () => {
    it("'avisar' rebaixa um bloqueio do banco para avisar_e_seguir, nunca lança", async () => {
      const r = await chamar({}, { bloqueioDePlanos: "avisar" });
      expect(r.lancou).toBe(SENTINELA);
    });
  });

  describe("leitura do modo em cache, 60s por pool", () => {
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

  describe("falha ABERTA, soluço de leitura nunca bloqueia", () => {
    it("billing_settings inacessível SEGUE, e avisa no log", async () => {
      const r = await chamar({ modoDeBilling: "erro" });
      expect(r.lancou).toBe(SENTINELA);
      expect(r.linhas.some((l) => l.nivel === "warn")).toBe(true);
    });

    it("fn_billing_ia_pode_responder falhando SEGUE, e avisa no log", async () => {
      const r = await chamar({ veredito: "erro" });
      expect(r.lancou).toBe(SENTINELA);
      expect(r.linhas.some((l) => l.nivel === "warn")).toBe(true);
    });
  });
});
