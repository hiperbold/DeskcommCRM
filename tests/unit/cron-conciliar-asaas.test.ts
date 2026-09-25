import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A CONCILIAÇÃO DIÁRIA DO ASAAS (fase F5, Tarefa 16).
 *
 * O que se prova:
 *   - sem o segredo do cron: 403, e a conciliação nem é chamada;
 *   - com o segredo: monta as dependências, chama `conciliarAsaas` e devolve
 *     o resumo;
 *   - resumo com falhas ou webhook interrompido sai no log como `warn`;
 *     rodada limpa sai como `info`;
 *   - `configDoAsaas()` lançando (ASAAS_ENABLED com base/chave incoerentes):
 *     a resposta HTTP traz uma frase fixa, o texto do erro nunca aparece no
 *     corpo, só no `log.error`;
 *   - o cron sem segredo dá 403 (mesmo contrato dos demais).
 *
 * Molde de `tests/unit/cron-processar-eventos-asaas.test.ts`.
 */

const SEGREDO = "segredo-da-conciliacao-asaas";

const conciliar = vi.fn();
const info = vi.fn();
const warn = vi.fn();
const error = vi.fn();

vi.mock("@/lib/env", () => ({
  env: { INTERNAL_CRON_SECRET: "segredo-da-conciliacao-asaas", INTERNAL_SECRET: "" },
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

vi.mock("@/lib/billing/asaas/conciliar", () => ({
  criarDbConciliarAsaasSobre: (admin: unknown) => ({ admin, marcador: "db-fake" }),
  conciliarAsaas: (...a: unknown[]) => conciliar(...a),
}));

import { GET } from "@/app/api/v1/cron/conciliar-asaas/route";

const RESUMO_LIMPO = {
  habilitado: true,
  pedidosAnalisados: 0,
  assinaturasAnalisadas: 0,
  eventosSinteticos: 0,
  pedidosMarcadosInconclusivo: 0,
  semCobrancaEncontrada: 0,
  cobrancasRemovidas: 0,
  falhas: 0,
  podados: 0,
  webhookInterrompido: false,
  cortadoPeloTetoDeGets: false,
  contadores: {
    pendenteHaMaisDeUmaHora: 0,
    erroUltimas24h: 0,
    divergenteUltimas24h: 0,
    semVinculoUltimas24h: 0,
    semEventoHa3DiasComAssinaturaAtiva: 0,
  },
};

function chamar(segredo = SEGREDO): Promise<Response> {
  return GET(
    new NextRequest("http://local/api/v1/cron/conciliar-asaas", {
      headers: segredo ? { authorization: `Bearer ${segredo}` } : {},
    }),
  );
}

beforeEach(() => {
  conciliar.mockReset();
  info.mockReset();
  warn.mockReset();
  error.mockReset();
  configDeveLancar = false;
});

describe("GET /api/v1/cron/conciliar-asaas", () => {
  it("sem o segredo: 403, e a conciliação nem é chamada", async () => {
    const res = await chamar("");
    expect(res.status).toBe(403);
    expect(conciliar).not.toHaveBeenCalled();
  });

  it("com o segredo, rodada limpa: 200, devolve o resumo, sai como info, sem warn", async () => {
    conciliar.mockResolvedValue(RESUMO_LIMPO);
    const res = await chamar();
    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: typeof RESUMO_LIMPO };
    expect(corpo.data).toEqual(RESUMO_LIMPO);
    expect(conciliar).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("rodada com falhas: devolve o resumo, sai como warn", async () => {
    const resumo = { ...RESUMO_LIMPO, falhas: 2 };
    conciliar.mockResolvedValue(resumo);
    const res = await chamar();
    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: typeof resumo };
    expect(corpo.data).toEqual(resumo);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toMatchObject({ falhas: 2 });
    expect(info).not.toHaveBeenCalled();
  });

  it("webhook interrompido: rodada sem falhas ainda sai como warn", async () => {
    const resumo = { ...RESUMO_LIMPO, webhookInterrompido: true };
    conciliar.mockResolvedValue(resumo);
    const res = await chamar();
    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toMatchObject({ webhookInterrompido: true });
    expect(info).not.toHaveBeenCalled();
  });

  it("configDoAsaas() lança (base/chave incoerentes): resposta com frase fixa, texto do erro só no log", async () => {
    configDeveLancar = true;
    const res = await chamar();
    expect(res.status).toBe(500);
    const corpo = (await res.json()) as { error: { code: string; message: string } };
    expect(corpo.error.message).toBe("Falha ao conciliar as cobranças do Asaas.");
    expect(corpo.error.message).not.toMatch(/ASAAS_API_KEY/);
    expect(conciliar).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[1]).toMatchObject({
      error: expect.stringContaining("ASAAS_API_KEY"),
    });
  });

  it("erro da conciliação: resposta com frase fixa, texto do erro só no log", async () => {
    conciliar.mockRejectedValue(new Error("fn_billing_asaas_podar_eventos: relation fantasma não existe"));
    const res = await chamar();
    expect(res.status).toBe(500);
    const corpo = (await res.json()) as { error: { code: string; message: string } };
    expect(corpo.error.message).toBe("Falha ao conciliar as cobranças do Asaas.");
    expect(corpo.error.message).not.toMatch(/relation fantasma/);
    expect(error).toHaveBeenCalledTimes(1);
  });
});
