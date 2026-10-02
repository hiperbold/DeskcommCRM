/**
 * D-117: a voz em tempo real não pode ser um ralo na chave da instalação.
 *
 * Três coisas medidas: a decisão de atender (teto diário, carteira, orçamento),
 * a leitura real dessas fontes por um client dublado, e o timer que derruba a
 * ligação na ponte do AudioSocket.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("ws", () => {
  class FakeWebSocket {
    static OPEN = 1;
    readyState = 0;
    on() {
      return this;
    }
    send() {}
    close() {}
  }
  return { default: FakeWebSocket };
});

import {
  decidirAtendimentoDaVoz,
  MOTIVO_LIMITE_DE_DURACAO,
  registrarUsoDaVoz,
  tetoDaChamadaMs,
  tetoDoDiaMs,
  verificarAtendimentoDaVoz,
} from "@/lib/ai/voz/limites-da-voz";
import { AudioSocketCallBridge } from "@/workers/voice-agent/audioSocketBridge";

const ORG = "org-1";
const MIN = 60_000;

describe("tetos de duração", () => {
  it("têm padrão finito e ignoram valor ausente, zero ou lixo", () => {
    expect(tetoDaChamadaMs({})).toBe(15 * MIN);
    expect(tetoDaChamadaMs({ VOICE_MAX_CALL_SECONDS: "0" })).toBe(15 * MIN);
    expect(tetoDaChamadaMs({ VOICE_MAX_CALL_SECONDS: "abc" })).toBe(15 * MIN);
    expect(tetoDaChamadaMs({ VOICE_MAX_CALL_SECONDS: "300" })).toBe(5 * MIN);
    expect(tetoDoDiaMs({})).toBe(120 * MIN);
    expect(tetoDoDiaMs({ VOICE_MAX_ORG_MINUTES_PER_DAY: "10" })).toBe(10 * MIN);
  });
});

describe("decidirAtendimentoDaVoz", () => {
  const base = {
    origemDaChave: "chave_da_instalacao" as const,
    usadoNoDiaMs: 0,
    tetoDoDiaMs: 120 * MIN,
    tetoDaChamadaMs: 15 * MIN,
    carteira: null,
    orcamento: null,
  };

  it("atende com o teto da chamada quando sobra dia", () => {
    expect(decidirAtendimentoDaVoz(base)).toEqual({ atender: true, maxMs: 15 * MIN });
  });

  it("na chave da instalação, o que resta do dia encurta a chamada", () => {
    expect(decidirAtendimentoDaVoz({ ...base, usadoNoDiaMs: 115 * MIN })).toEqual({ atender: true, maxMs: 5 * MIN });
  });

  it("dia esgotado na chave da instalação: recusa", () => {
    expect(decidirAtendimentoDaVoz({ ...base, usadoNoDiaMs: 120 * MIN })).toEqual({
      atender: false,
      motivo: "teto_diario_de_voz",
    });
  });

  it("chave da própria organização não sofre o teto diário, mas segue com o teto da chamada", () => {
    expect(
      decidirAtendimentoDaVoz({ ...base, origemDaChave: "credencial_da_organizacao", usadoNoDiaMs: 999 * MIN }),
    ).toEqual({ atender: true, maxMs: 15 * MIN });
  });

  it("carteira zerada recusa; avisar e seguir não", () => {
    const carteira = (acao: "bloquear" | "avisar_e_seguir") => ({ acao, motivo: "x", saldo: 0, ciclo: null });
    expect(decidirAtendimentoDaVoz({ ...base, carteira: carteira("bloquear") })).toEqual({
      atender: false,
      motivo: "carteira_de_tokens_zerada",
    });
    expect(decidirAtendimentoDaVoz({ ...base, carteira: carteira("avisar_e_seguir") }).atender).toBe(true);
  });

  it("orçamento atingido recusa", () => {
    expect(decidirAtendimentoDaVoz({ ...base, orcamento: { acao: "bloquear", porque: "teto_atingido" } })).toEqual({
      atender: false,
      motivo: "orcamento_de_ia_atingido",
    });
  });
});

/** Client dublado só com o que `verificarAtendimentoDaVoz` lê. */
function adminDaVoz(opts: {
  ligacoes?: Array<{ duration_ms: number | null }>;
  modo?: string;
  carteira?: unknown;
  orcamento?: Record<string, unknown> | null;
  gasto?: number;
  avisos?: number;
  falharLigacoes?: boolean;
}) {
  return {
    from: (tabela: string) => {
      if (tabela === "voice_calls") {
        const q = {
          select: () => q,
          eq: () => q,
          gte: () => q,
          limit: async () =>
            opts.falharLigacoes
              ? { data: null, error: { message: "banco fora" } }
              : { data: opts.ligacoes ?? [], error: null },
        };
        return q;
      }
      if (tabela === "billing_settings") {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { modo: opts.modo ?? "avisar" }, error: null }) }) }) };
      }
      if (tabela === "ai_budgets") {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: opts.orcamento ?? null, error: null }) }) }) };
      }
      if (tabela === "agent_inbox_items") {
        const q = {
          select: () => q,
          eq: () => q,
          gte: async () => ({ count: opts.avisos ?? 0, error: null }),
        };
        return q;
      }
      throw new Error(`tabela inesperada: ${tabela}`);
    },
    rpc: async (nome: string) => {
      if (nome === "fn_billing_ia_pode_responder") return { data: opts.carteira, error: null };
      if (nome === "fn_gasto_de_ia_do_mes") return { data: opts.gasto ?? 0, error: null };
      throw new Error(`rpc inesperada: ${nome}`);
    },
  } as never;
}

describe("verificarAtendimentoDaVoz", () => {
  beforeEach(() => {
    delete process.env.PLANOS_BLOQUEIO;
    delete process.env.AI_BUDGET_ENFORCEMENT;
  });

  it("minutos de IA nas últimas 24 h esgotados: recusa na chave da instalação", async () => {
    const admin = adminDaVoz({ ligacoes: [{ duration_ms: 100 * MIN }, { duration_ms: 25 * MIN }, { duration_ms: null }] });
    const r = await verificarAtendimentoDaVoz(admin, { organizationId: ORG, origemDaChave: "chave_da_instalacao" });
    expect(r).toEqual({ atender: false, motivo: "teto_diario_de_voz" });
  });

  it("carteira zerada no modo bloquear: recusa antes de atender", async () => {
    const admin = adminDaVoz({
      modo: "bloquear",
      carteira: { acao: "bloquear", motivo: "saldo zerado", saldo: 0, ciclo: "2026-10-01" },
    });
    const r = await verificarAtendimentoDaVoz(admin, { organizationId: ORG, origemDaChave: "chave_da_instalacao" });
    expect(r).toEqual({ atender: false, motivo: "carteira_de_tokens_zerada" });
  });

  it("a carteira só vale para a chave da instalação: chave própria atende mesmo com carteira zerada", async () => {
    const admin = adminDaVoz({
      modo: "bloquear",
      carteira: { acao: "bloquear", motivo: "saldo zerado", saldo: 0, ciclo: "2026-10-01" },
    });
    const r = await verificarAtendimentoDaVoz(admin, { organizationId: ORG, origemDaChave: "credencial_da_organizacao" });
    expect(r.atender).toBe(true);
  });

  it("orçamento em dólar atingido, com aviso já dado e carência vencida: recusa", async () => {
    const admin = adminDaVoz({
      orcamento: {
        monthly_limit_cents: 1000,
        enforcement_mode: "bloquear",
        enforcement_effective_at: "2026-01-01T00:00:00Z",
        alarm_threshold_pct: 80,
      },
      gasto: 1500,
      avisos: 1,
    });
    const r = await verificarAtendimentoDaVoz(admin, { organizationId: ORG, origemDaChave: "credencial_da_organizacao" });
    expect(r).toEqual({ atender: false, motivo: "orcamento_de_ia_atingido" });
  });

  it("leitura que falha SEGUE a ligação, ainda com o teto de duração", async () => {
    const admin = adminDaVoz({ falharLigacoes: true });
    const r = await verificarAtendimentoDaVoz(admin, { organizationId: ORG, origemDaChave: "chave_da_instalacao" });
    expect(r).toEqual({ atender: true, maxMs: 15 * MIN });
  });
});

describe("registrarUsoDaVoz", () => {
  it("grava a duração e a origem da chave em llm_calls, sem inventar custo", async () => {
    const gravadas: Array<Record<string, unknown>> = [];
    const admin = {
      from: (tabela: string) => {
        expect(tabela).toBe("llm_calls");
        return {
          insert: async (linha: Record<string, unknown>) => {
            gravadas.push(linha);
            return { error: null };
          },
        };
      },
    } as never;

    await registrarUsoDaVoz(admin, {
      organizationId: ORG,
      model: "gpt-realtime",
      origemDaChave: "chave_da_instalacao",
      duracaoMs: 93_400,
    });

    expect(gravadas).toHaveLength(1);
    expect(gravadas[0]).toMatchObject({
      organization_id: ORG,
      purpose: "voz_em_tempo_real",
      model: "gpt-realtime",
      origem_da_chave: "chave_da_instalacao",
      latency_ms: 93_400,
      cost_cents: null,
    });
  });

  it("falha na gravação nunca lança", async () => {
    const admin = { from: () => ({ insert: async () => ({ error: { message: "negado" } }) }) } as never;
    await expect(
      registrarUsoDaVoz(admin, { organizationId: ORG, model: "m", origemDaChave: "chave_da_instalacao", duracaoMs: 1 }),
    ).resolves.toBeUndefined();
  });
});

describe("ponte do AudioSocket: timer de duração máxima", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function socketFalso() {
    return { setNoDelay: vi.fn(), on: vi.fn(), end: vi.fn(), write: vi.fn(), destroyed: false } as never;
  }
  const ctxBase = {
    callId: "c1",
    organizationId: ORG,
    agentInstructions: "x",
    voice: "alloy",
    voiceSpeed: 1,
    apiKey: "sk-teste",
    onTranscriptTurn: vi.fn(),
    knowledgeSourceIdsPromise: Promise.resolve([]),
    searchKnowledge: async () => ({ trechos: [] }),
  };

  it("derruba a ligação ao fim do teto, com o motivo certo, e só uma vez", () => {
    const onCallEnded = vi.fn();
    new AudioSocketCallBridge(socketFalso(), { ...ctxBase, onCallEnded, maxDurationMs: 5_000 });

    vi.advanceTimersByTime(4_999);
    expect(onCallEnded).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(onCallEnded).toHaveBeenCalledTimes(1);
    expect(onCallEnded).toHaveBeenCalledWith(MOTIVO_LIMITE_DE_DURACAO);
    vi.advanceTimersByTime(60_000);
    expect(onCallEnded).toHaveBeenCalledTimes(1);
  });

  it("ligação que termina antes cancela o timer", () => {
    const onCallEnded = vi.fn();
    const ponte = new AudioSocketCallBridge(socketFalso(), { ...ctxBase, onCallEnded, maxDurationMs: 5_000 });
    ponte.close();
    vi.advanceTimersByTime(10_000);
    expect(onCallEnded).not.toHaveBeenCalled();
  });
});
