import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O PROCESSADOR DE EVENTOS DO ASAAS (fase F5, Tarefa 13).
 *
 * O que se prova:
 *   - sem o segredo do cron: 403, e o processador nem é chamado;
 *   - com o segredo: monta as dependências, chama `processarEventosAsaas` e
 *     devolve o resumo;
 *   - resumo com falhas sai no log como `warn`; rodada limpa sai como `info`;
 *   - `configDoAsaas()` lançando (ASAAS_ENABLED com base/chave incoerentes):
 *     a resposta HTTP traz uma frase fixa, o texto do erro nunca aparece no
 *     corpo, só no `log.error`.
 *
 * Molde de `tests/unit/cron-conferir-vencimentos.test.ts`.
 */

// `vi.mock` é içado acima das constantes: o segredo vai literal aqui e em
// `SEGREDO` (mesmo aviso de `tests/unit/cron-conferir-vencimentos.test.ts`).
const SEGREDO = "segredo-do-processador-asaas";

const processar = vi.fn();
const info = vi.fn();
const warn = vi.fn();
const error = vi.fn();

vi.mock("@/lib/env", () => ({
  env: { INTERNAL_CRON_SECRET: "segredo-do-processador-asaas", INTERNAL_SECRET: "" },
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    info: (...a: unknown[]) => info(...a),
    warn: (...a: unknown[]) => warn(...a),
    error: (...a: unknown[]) => error(...a),
    debug: vi.fn(),
  },
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ marcador: "admin-client-fake" }),
}));

const CONFIG_FAKE = {
  habilitado: true,
  baseUrl: "https://api-sandbox.asaas.com/v3",
  apiKey: "$aact_hmlg_fake",
  webhookToken: "token-fake",
  webhookId: "",
  ambiente: "sandbox" as const,
};

let configDeveLancar = false;

vi.mock("@/lib/billing/asaas/config", () => ({
  configDoAsaas: () => {
    if (configDeveLancar) {
      throw new Error("ASAAS_API_KEY e ASAAS_BASE_URL apontam para ambientes diferentes");
    }
    return CONFIG_FAKE;
  },
}));

vi.mock("@/lib/billing/asaas/cliente", () => ({
  criarClienteAsaas: (args: unknown) => ({ marcador: "asaas-client-fake", args }),
}));

vi.mock("@/lib/billing/asaas/processar-eventos", () => ({
  criarDbEventosAsaasSobre: (admin: unknown) => ({ admin, marcador: "db-fake" }),
  processarEventosAsaas: (...a: unknown[]) => processar(...a),
}));

import { GET } from "@/app/api/v1/cron/processar-eventos-asaas/route";

const RESUMO_LIMPO = {
  habilitado: true,
  reservados: 0,
  processados: 0,
  aplicados: 0,
  jaAplicados: 0,
  ignorados: 0,
  outroApp: 0,
  semVinculo: 0,
  divergentes: 0,
  aguardando: 0,
  falhas: 0,
  removidosCobranca: 0,
  cortadoPeloOrcamento: false,
};

function chamar(segredo = SEGREDO): Promise<Response> {
  return GET(
    new NextRequest("http://local/api/v1/cron/processar-eventos-asaas", {
      headers: segredo ? { authorization: `Bearer ${segredo}` } : {},
    }),
  );
}

beforeEach(() => {
  processar.mockReset();
  info.mockReset();
  warn.mockReset();
  error.mockReset();
  configDeveLancar = false;
});

describe("GET /api/v1/cron/processar-eventos-asaas", () => {
  it("sem o segredo: 403, e o processador nem é chamado", async () => {
    const res = await chamar("");
    expect(res.status).toBe(403);
    expect(processar).not.toHaveBeenCalled();
  });

  it("com o segredo, rodada limpa: 200, devolve o resumo, sai como info, sem warn", async () => {
    processar.mockResolvedValue(RESUMO_LIMPO);
    const res = await chamar();
    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: typeof RESUMO_LIMPO };
    expect(corpo.data).toEqual(RESUMO_LIMPO);
    expect(processar).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("rodada com falhas: devolve o resumo, sai como warn", async () => {
    const resumo = { ...RESUMO_LIMPO, falhas: 2 };
    processar.mockResolvedValue(resumo);
    const res = await chamar();
    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: typeof resumo };
    expect(corpo.data).toEqual(resumo);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toMatchObject({ falhas: 2 });
    expect(info).not.toHaveBeenCalled();
  });

  it("configDoAsaas() lança (base/chave incoerentes): resposta com frase fixa, texto do erro só no log", async () => {
    configDeveLancar = true;
    const res = await chamar();
    expect(res.status).toBe(500);
    const corpo = (await res.json()) as { error: { code: string; message: string } };
    expect(corpo.error.message).toBe("Falha ao processar os eventos do Asaas.");
    expect(corpo.error.message).not.toMatch(/ASAAS_API_KEY/);
    expect(processar).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[1]).toMatchObject({
      error: expect.stringContaining("ASAAS_API_KEY"),
    });
  });

  it("erro do processador: resposta com frase fixa, texto do erro só no log", async () => {
    processar.mockRejectedValue(new Error("fn_billing_asaas_reservar_eventos: relation fantasma não existe"));
    const res = await chamar();
    expect(res.status).toBe(500);
    const corpo = (await res.json()) as { error: { code: string; message: string } };
    expect(corpo.error.message).toBe("Falha ao processar os eventos do Asaas.");
    expect(corpo.error.message).not.toMatch(/relation fantasma/);
    expect(error).toHaveBeenCalledTimes(1);
  });
});
