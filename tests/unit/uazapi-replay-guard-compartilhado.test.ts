/**
 * D-042 (fecha a concessão de "só por processo"): a marca de "evento já visto"
 * da UAZAPI agora também vai para o Redis compartilhado (o mesmo Upstash REST de
 * `rate-limit.ts`/`debounce.ts`), para o reenvio dirigido a OUTRA réplica do
 * container ser pego.
 *
 * "Réplica" aqui = módulo recarregado (`vi.resetModules`) com a memória do
 * processo zerada (`globalThis.__uazapiEventosVistos`), falando com o MESMO
 * armazenamento fake. O que é dublê é só o cliente HTTP do Redis (externo); o
 * `replay-guard.ts` e o `handleInboundWebhook` são os de verdade.
 *
 * Semânticas medidas: marca só depois do sucesso, janela de 5 min (TTL enviado
 * ao Redis), e falha do armazenamento (erro, pendurado, malformado) cai para o
 * comportamento por processo, sem lançar e sem perder evento.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ModoRedis = "ok" | "erro" | "pendurado";

const redis = vi.hoisted(() => ({
  modo: "ok" as "ok" | "erro" | "pendurado",
  /** chave -> o que o SET recebeu */
  armazenamento: new Map<string, { valor: string; ex: number | undefined }>(),
  gets: 0,
  sets: 0,
  env: {
    UPSTASH_REDIS_REST_URL: "https://redis-de-teste.example",
    UPSTASH_REDIS_REST_TOKEN: "token-de-teste",
  },
}));

vi.mock("@upstash/redis", () => ({
  Redis: class {
    async get(chave: string) {
      redis.gets += 1;
      if (redis.modo === "erro") throw new Error("fetch failed");
      if (redis.modo === "pendurado") return new Promise(() => {});
      return redis.armazenamento.get(chave)?.valor ?? null;
    }
    async set(chave: string, valor: string, opts?: { ex?: number }) {
      redis.sets += 1;
      if (redis.modo === "erro") throw new Error("fetch failed");
      if (redis.modo === "pendurado") return new Promise(() => {});
      redis.armazenamento.set(chave, { valor, ex: opts?.ex });
      return "OK";
    }
  },
}));

vi.mock("@/lib/env", () => ({ env: redis.env }));

/** Sobe uma "réplica": módulo novo, memória do processo vazia. */
async function subirReplica() {
  vi.resetModules();
  globalThis.__uazapiEventosVistos = undefined;
  return import("@/lib/channels/uazapi/replay-guard");
}

function definirModo(modo: ModoRedis) {
  redis.modo = modo;
}

beforeEach(() => {
  redis.armazenamento.clear();
  redis.gets = 0;
  redis.sets = 0;
  redis.modo = "ok";
  redis.env.UPSTASH_REDIS_REST_URL = "https://redis-de-teste.example";
  redis.env.UPSTASH_REDIS_REST_TOKEN = "token-de-teste";
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("D-042: marca compartilhada entre réplicas", () => {
  it("evento processado na réplica A é recusado como repetido na réplica B", async () => {
    const a = await subirReplica();
    const chave = a.chaveDoEventoUazapi("sess-1", "connection", "corpo-a");

    expect(await a.eventoUazapiRepetido(chave)).toBe(false);
    await a.marcarEventoUazapiVisto(chave);

    const b = await subirReplica(); // outra réplica: memória vazia, mesmo Redis
    expect(await b.eventoUazapiRepetido(chave)).toBe(true);
  });

  it("controle: sem a marca de A, a réplica B trata o evento como novo", async () => {
    const a = await subirReplica();
    const chave = a.chaveDoEventoUazapi("sess-1", "connection", "corpo-a");
    expect(await a.eventoUazapiRepetido(chave)).toBe(false);

    const b = await subirReplica();
    expect(await b.eventoUazapiRepetido(chave)).toBe(false);
  });

  it("consultar não grava nada no Redis: a marca só nasce em marcarEventoUazapiVisto", async () => {
    const a = await subirReplica();
    const chave = a.chaveDoEventoUazapi("sess-1", "connection", "corpo-a");

    await a.eventoUazapiRepetido(chave);
    expect(redis.sets).toBe(0);
    expect(redis.armazenamento.size).toBe(0);
  });

  it("a janela de 5 min vai para o Redis como TTL (é ele quem expira a chave)", async () => {
    const a = await subirReplica();
    const chave = a.chaveDoEventoUazapi("sess-1", "connection", "corpo-a");
    await a.marcarEventoUazapiVisto(chave);

    const gravado = [...redis.armazenamento.values()];
    expect(gravado).toHaveLength(1);
    expect(gravado[0]?.ex).toBe(300);
    expect(a.JANELA_DE_REPLAY_MS).toBe(300_000);
  });

  it("sessão diferente não colide no Redis (a chave carrega a sessão)", async () => {
    const a = await subirReplica();
    const chave1 = a.chaveDoEventoUazapi("sess-1", "connection", "corpo-a");
    const chave2 = a.chaveDoEventoUazapi("sess-2", "connection", "corpo-a");
    await a.marcarEventoUazapiVisto(chave1);

    const b = await subirReplica();
    expect(await b.eventoUazapiRepetido(chave1)).toBe(true);
    expect(await b.eventoUazapiRepetido(chave2)).toBe(false);
  });

  it("achado na memória local não gasta ida ao Redis", async () => {
    const a = await subirReplica();
    const chave = a.chaveDoEventoUazapi("sess-1", "connection", "corpo-a");
    await a.marcarEventoUazapiVisto(chave);
    redis.gets = 0;

    expect(await a.eventoUazapiRepetido(chave)).toBe(true);
    expect(redis.gets).toBe(0);
  });
});

describe("D-042: falha do armazenamento cai para o comportamento por processo", () => {
  it("Redis com erro na consulta: evento novo NÃO é dado como repetido (nunca perde evento)", async () => {
    const a = await subirReplica();
    const chave = a.chaveDoEventoUazapi("sess-1", "connection", "corpo-a");
    definirModo("erro");

    await expect(a.eventoUazapiRepetido(chave)).resolves.toBe(false);
    expect(redis.gets, "guarda de vacuidade: o Redis precisa ter sido tentado").toBe(1);
  });

  it("Redis com erro na marcação: não lança e a memória do processo ainda barra o repetido", async () => {
    const a = await subirReplica();
    const chave = a.chaveDoEventoUazapi("sess-1", "connection", "corpo-a");
    definirModo("erro");

    await expect(a.marcarEventoUazapiVisto(chave)).resolves.toBeUndefined();
    expect(redis.sets, "guarda de vacuidade: o Redis precisa ter sido tentado").toBe(1);
    expect(await a.eventoUazapiRepetido(chave)).toBe(true);

    // Sem Redis, outra réplica não sabe: é a degradação por processo de antes.
    const b = await subirReplica();
    expect(await b.eventoUazapiRepetido(chave)).toBe(false);
  });

  it("Redis pendurado: estoura o teto e segue (consulta = novo, marcação = não trava)", async () => {
    vi.useFakeTimers();
    const a = await subirReplica();
    const chave = a.chaveDoEventoUazapi("sess-1", "connection", "corpo-a");
    definirModo("pendurado");

    const consulta = a.eventoUazapiRepetido(chave);
    await vi.advanceTimersByTimeAsync(a.TIMEOUT_REDIS_MS + 1);
    await expect(consulta).resolves.toBe(false);

    const marcacao = a.marcarEventoUazapiVisto(chave);
    await vi.advanceTimersByTimeAsync(a.TIMEOUT_REDIS_MS + 1);
    await expect(marcacao).resolves.toBeUndefined();

    // A memória local recebeu a marca mesmo com o Redis pendurado.
    expect(await a.eventoUazapiRepetido(chave)).toBe(true);
  });

  it("Redis não configurado: funciona só por processo, sem tocar o cliente", async () => {
    redis.env.UPSTASH_REDIS_REST_URL = "";
    redis.env.UPSTASH_REDIS_REST_TOKEN = "";
    const a = await subirReplica();
    const chave = a.chaveDoEventoUazapi("sess-1", "connection", "corpo-a");

    expect(await a.eventoUazapiRepetido(chave)).toBe(false);
    await a.marcarEventoUazapiVisto(chave);
    expect(await a.eventoUazapiRepetido(chave)).toBe(true);
    expect(redis.gets + redis.sets).toBe(0);
  });

  it("Redis malformado (aspas sobrando na URL): não vai ao cliente, cai para a memória", async () => {
    redis.env.UPSTASH_REDIS_REST_URL = '"https://redis-de-teste.example"';
    const a = await subirReplica();
    const chave = a.chaveDoEventoUazapi("sess-1", "connection", "corpo-a");

    await a.marcarEventoUazapiVisto(chave);
    expect(await a.eventoUazapiRepetido(chave)).toBe(true);
    expect(redis.gets + redis.sets).toBe(0);
  });
});

describe("D-042 na integração: duas réplicas do webhook compartilhando o Redis", () => {
  const TOKEN = "0a1b2c3d-aa11-4b2c-bbbb-a123b4c5d6e7";
  const corpo = JSON.stringify({
    EventType: "connection",
    BaseUrl: "https://empresa.uazapi.com",
    instanceName: "comercial",
    owner: "553599990000",
    instance: { status: "connected" },
  });

  /** Dublê mínimo do admin para `sincronizarSaudeDaConexao` (sem episódio aberto). */
  function adminDeSaude() {
    const chain: Record<string, unknown> = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "maybeSingle" || prop === "single") return async () => ({ data: null, error: null });
          if (prop === "then") return (ok: (v: unknown) => unknown) => ok({ data: [], error: null });
          return () => chain;
        },
      },
    );
    return { from: () => chain } as never;
  }

  async function subirReplicaDoWebhook() {
    await subirReplica();
    const { handleInboundWebhook } = await import("@/lib/channels/inbound");
    const { CHANNEL_PROVIDER_UAZAPI } = await import("@/lib/channels/capabilities");
    return {
      processar: () =>
        handleInboundWebhook(adminDeSaude(), {
          session: {
            id: "sess-1",
            organization_id: "org-1",
            provider: CHANNEL_PROVIDER_UAZAPI,
            display_name: "Comercial",
            phone_number: "+553599990000",
            session_ref: "3f9a1c2e4b7d",
          },
          rawBody: corpo,
          headers: new Headers(),
          secret: TOKEN,
        }),
    };
  }

  it("mesmo corpo processado na réplica A é ignorado como repetido na réplica B", async () => {
    const a = await subirReplicaDoWebhook();
    expect(await a.processar()).toMatchObject({ ok: true, body: { status: "saude" } });

    const b = await subirReplicaDoWebhook();
    expect(await b.processar()).toEqual({ ok: true, body: { status: "ignored", reason: "evento_repetido" } });
  });

  it("Redis fora do ar: a réplica B processa o evento (nunca perde), sem virar erro", async () => {
    definirModo("erro");
    const a = await subirReplicaDoWebhook();
    expect(await a.processar()).toMatchObject({ ok: true, body: { status: "saude" } });

    const b = await subirReplicaDoWebhook();
    expect(await b.processar()).toMatchObject({ ok: true, body: { status: "saude" } });
  });
});
