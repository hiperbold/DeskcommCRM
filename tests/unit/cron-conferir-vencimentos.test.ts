import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O CONFERIDOR DIÁRIO DO VENCIMENTO DA ASSINATURA (fase F4, Tarefa 5).
 *
 * O que se prova:
 *   - sem o segredo do cron: 403, e o conferidor nem é chamado;
 *   - com o segredo: chama `conferirVencimentos` e devolve o resumo;
 *   - resumo com organização que falhou sai no log como `warn`; um resumo
 *     sem pendência nenhuma sai como `info`, sem `warn`;
 *   - erro do conferidor: a resposta HTTP traz uma frase fixa, o texto de
 *     dentro do erro do banco NUNCA aparece no corpo, só no `log.error`.
 *
 * Molde de `tests/unit/cron-conferir-carteira-de-tokens.test.ts` e
 * `tests/unit/cron-conferir-contadores-de-plano.test.ts`.
 */

const SEGREDO = "segredo-do-vencimento";

const conferir = vi.fn();
const info = vi.fn();
const warn = vi.fn();
const error = vi.fn();

// `vi.mock` é içado acima das constantes: o segredo vai literal aqui e em
// `SEGREDO` (mesmo aviso dos testes irmãos).
vi.mock("@/lib/env", () => ({
  env: { INTERNAL_CRON_SECRET: "segredo-do-vencimento", INTERNAL_SECRET: "" },
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
// mesmo espírito dos irmãos: dublar o módulo que fala com o banco, não o
// `SupabaseClient` inteiro.
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ marcador: "admin-client-fake" }),
}));

vi.mock("@/lib/billing/assinatura/conferir-vencimentos", () => ({
  conferidorDeVencimentosSobre: (admin: unknown) => ({ admin, marcador: "db-fake" }),
  conferirVencimentos: (...a: unknown[]) => conferir(...a),
}));

import { GET } from "@/app/api/v1/cron/conferir-vencimentos/route";

const RESUMO_LIMPO = {
  organizacoesVistas: 12,
  mudaramParaAtrasada: 0,
  mudaramParaSuspensa: 0,
  mudaramParaCancelada: 0,
  organizacoesQueFalharam: 0,
};

function chamar(segredo = SEGREDO): Promise<Response> {
  return GET(
    new NextRequest("http://local/api/v1/cron/conferir-vencimentos", {
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

describe("GET /api/v1/cron/conferir-vencimentos", () => {
  it("sem o segredo: 403, e o conferidor nem é chamado", async () => {
    const res = await chamar("");
    expect(res.status).toBe(403);
    expect(conferir).not.toHaveBeenCalled();
  });

  it("com o segredo, rodada limpa: 200, devolve o resumo, sai como info, sem warn", async () => {
    conferir.mockResolvedValue(RESUMO_LIMPO);
    const res = await chamar();
    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: typeof RESUMO_LIMPO };
    expect(corpo.data).toEqual(RESUMO_LIMPO);
    expect(conferir).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("rodada que moveu organizações: devolve as contagens por estado, sai como info (não é falha)", async () => {
    const resumo = { ...RESUMO_LIMPO, mudaramParaAtrasada: 3, mudaramParaSuspensa: 1, mudaramParaCancelada: 2 };
    conferir.mockResolvedValue(resumo);
    const res = await chamar();
    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: typeof resumo };
    expect(corpo.data).toEqual(resumo);
    expect(info).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("organização que falhou: sai no log como warn, com o resumo completo", async () => {
    const resumo = { ...RESUMO_LIMPO, organizacoesQueFalharam: 2 };
    conferir.mockResolvedValue(resumo);
    const res = await chamar();
    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: typeof resumo };
    expect(corpo.data).toEqual(resumo);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toMatchObject({ organizacoesQueFalharam: 2 });
  });

  it("erro do conferidor: resposta com frase fixa, texto do banco só no log", async () => {
    conferir.mockRejectedValue(
      new Error("fn_billing_conferir_vencimento: column billing_contracts.fantasma não existe"),
    );
    const res = await chamar();
    expect(res.status).toBe(500);
    const corpo = (await res.json()) as { error: { code: string; message: string } };
    expect(corpo.error.message).toBe("Falha ao conferir o vencimento das assinaturas.");
    expect(corpo.error.message).not.toMatch(/billing_contracts/);
    expect(warn).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[1]).toMatchObject({
      error: expect.stringContaining("billing_contracts"),
    });
  });
});
