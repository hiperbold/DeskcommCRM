import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Hiperbold: o serviço do canal por QR só derruba o health se alguma conexão
 * ativa o usa.
 *
 * A instalação da Hiperbold não usa esse canal (decisão de 16/09/2026) e o
 * serviço foi retirado. Sem a regra, `/api/v1/health` responderia 503 para
 * sempre por uma dependência que nada precisa, e um sinal sempre vermelho é um
 * sinal que ninguém lê.
 *
 * As duas metades: sem a segunda, "pular sempre" também deixaria o primeiro caso
 * verde, e uma queda de verdade (com conexões em uso) passaria calada.
 */

let sessoesAtivas: number | null = 0;

function montar() {
  vi.doMock("@/lib/env", () => ({
    env: {
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:9",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
      UPSTASH_REDIS_REST_URL: "http://127.0.0.1:9",
      UPSTASH_REDIS_REST_TOKEN: "token-de-teste",
      // Porta 9 (discard): recusa na hora, é a queda sem espera.
      WAHA_API_BASE_URL: "http://127.0.0.1:9",
      WAHA_API_KEY: "chave",
      INTERNAL_CRON_SECRET: "",
      INTERNAL_SECRET: "",
    },
  }));
  vi.doMock("@/lib/supabase/admin", () => ({
    createAdminClient: () => {
      const q = {
        select: () => q,
        eq: () => q,
        is: async () =>
          sessoesAtivas === null
            ? { count: null, error: { message: "falhou" } }
            : { count: sessoesAtivas, error: null },
      };
      return { from: () => q };
    },
  }));
}

async function checarWaha() {
  const { GET } = await import("@/app/api/v1/health/route");
  const { data } = await (await GET(new NextRequest("https://crm.exemplo.com.br/api/v1/health"))).json();
  return data.checks.waha as { status: string; reason?: string };
}

describe("health: serviço do canal por QR caído", () => {
  beforeEach(() => {
    vi.resetModules();
    montar();
  });

  it("sem nenhuma conexão ativa que o use, não conta como queda", async () => {
    sessoesAtivas = 0;
    expect(await checarWaha()).toMatchObject({ status: "ok", reason: "sem_conexao_ativa" });
  });

  it("com conexão ativa que o usa, a queda continua sendo queda", async () => {
    sessoesAtivas = 2;
    expect((await checarWaha()).status).toBe("down");
  });

  it("se não der para saber (consulta falhou), a queda vale", async () => {
    sessoesAtivas = null;
    expect((await checarWaha()).status).toBe("down");
  });
});
