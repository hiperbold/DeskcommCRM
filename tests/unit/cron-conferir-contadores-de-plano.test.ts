import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O CONFERIDOR DIÁRIO DE CONTADORES DE PLANO (fase F2, Tarefa 5).
 *
 * O que se prova:
 *   - sem o segredo do cron: 403, e a função do banco nem é chamada;
 *   - com o segredo: chama `fn_billing_conferir_contadores()` (via
 *     `conferirContadoresDePlano`) e devolve o número de divergências;
 *   - divergência maior que zero sai no log como `warn`, com o número;
 *   - sem divergência, não há `warn`;
 *   - erro da função de banco: a resposta HTTP traz uma frase fixa, o texto
 *     de dentro do erro do banco NUNCA aparece no corpo, só no `log.error`.
 */

const SEGREDO = "segredo-do-conferidor";

const conferir = vi.fn();
const info = vi.fn();
const warn = vi.fn();
const error = vi.fn();

// `vi.mock` é içado acima das constantes: o segredo vai literal aqui e em
// `SEGREDO` (mesmo aviso de `cron-handoff-devolucao.test.ts`).
vi.mock("@/lib/env", () => ({
  env: { INTERNAL_CRON_SECRET: "segredo-do-conferidor", INTERNAL_SECRET: "" },
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    info: (...a: unknown[]) => info(...a),
    warn: (...a: unknown[]) => warn(...a),
    error: (...a: unknown[]) => error(...a),
    debug: vi.fn(),
  },
}));

// A rota não usa nada do cliente admin além de repassá-lo à borda; a REGRA
// (chamar a RPC e interpretar o resultado) é o que este teste dubla, no
// mesmo espírito de `cron-handoff-devolucao.test.ts`: dublar o módulo que
// fala com o banco, não o `SupabaseClient` inteiro.
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ marcador: "admin-client-fake" }),
}));

vi.mock("@/lib/billing/planos/conferir-contadores", () => ({
  conferidorDeContadoresSobre: (admin: unknown) => ({ admin, marcador: "db-fake" }),
  conferirContadoresDePlano: (...a: unknown[]) => conferir(...a),
}));

import { GET } from "@/app/api/v1/cron/conferir-contadores-de-plano/route";

function chamar(segredo = SEGREDO): Promise<Response> {
  return GET(
    new NextRequest("http://local/api/v1/cron/conferir-contadores-de-plano", {
      headers: segredo ? { authorization: `Bearer ${segredo}` } : {},
    }),
  );
}

beforeEach(() => {
  conferir.mockReset();
  info.mockReset();
  warn.mockReset();
  error.mockReset();
});

describe("GET /api/v1/cron/conferir-contadores-de-plano", () => {
  it("sem o segredo: 403, e a função do banco nem é chamada", async () => {
    const res = await chamar("");
    expect(res.status).toBe(403);
    expect(conferir).not.toHaveBeenCalled();
  });

  it("com o segredo, sem divergência: 200, devolve 0 e não vira warn", async () => {
    conferir.mockResolvedValue(0);
    const res = await chamar();
    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: { divergiam: number } };
    expect(corpo.data).toEqual({ divergiam: 0 });
    expect(conferir).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("divergência maior que zero sai no log como warn, com o número", async () => {
    conferir.mockResolvedValue(3);
    const res = await chamar();
    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: { divergiam: number } };
    expect(corpo.data).toEqual({ divergiam: 3 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toMatchObject({ divergiam: 3 });
  });

  it("erro da função de banco: resposta com frase fixa, texto do banco só no log", async () => {
    conferir.mockRejectedValue(
      new Error("fn_billing_conferir_contadores: column billing_usage_counters.item não existe"),
    );
    const res = await chamar();
    expect(res.status).toBe(500);
    const corpo = (await res.json()) as { error: { code: string; message: string } };
    expect(corpo.error.message).toBe("Falha ao conferir os contadores de uso.");
    expect(corpo.error.message).not.toMatch(/billing_usage_counters/);
    expect(warn).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[1]).toMatchObject({
      error: expect.stringContaining("billing_usage_counters"),
    });
  });
});
