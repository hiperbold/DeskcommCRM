import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O CONFERIDOR DIÁRIO DA CARTEIRA DE TOKENS DE IA (fase F2-B, Tarefa 8).
 *
 * O que se prova:
 *   - sem o segredo do cron: 403, e o conferidor nem é chamado;
 *   - com o segredo: chama `conferirCarteiraDeTokens` e devolve o resumo;
 *   - resumo com organização que falhou ou teto passado sai no log como
 *     `warn`; um resumo sem pendência nenhuma sai como `info`, sem `warn`;
 *   - erro do conferidor: a resposta HTTP traz uma frase fixa, o texto de
 *     dentro do erro do banco NUNCA aparece no corpo, só no `log.error`.
 *
 * Molde de `tests/unit/cron-conferir-contadores-de-plano.test.ts`.
 */

const SEGREDO = "segredo-da-carteira";

const conferir = vi.fn();
const info = vi.fn();
const warn = vi.fn();
const error = vi.fn();

// `vi.mock` é içado acima das constantes: o segredo vai literal aqui e em
// `SEGREDO` (mesmo aviso de `cron-conferir-contadores-de-plano.test.ts`).
vi.mock("@/lib/env", () => ({
  env: { INTERNAL_CRON_SECRET: "segredo-da-carteira", INTERNAL_SECRET: "" },
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
// (chamar as RPCs e interpretar o resultado) é o que este teste dubla, no
// mesmo espírito de `cron-conferir-contadores-de-plano.test.ts`: dublar o
// módulo que fala com o banco, não o `SupabaseClient` inteiro.
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ marcador: "admin-client-fake" }),
}));

vi.mock("@/lib/billing/tokens/conferir-carteira", () => ({
  conferidorDeCarteiraSobre: (admin: unknown) => ({ admin, marcador: "db-fake" }),
  conferirCarteiraDeTokens: (...a: unknown[]) => conferir(...a),
}));

import { GET } from "@/app/api/v1/cron/conferir-carteira-de-tokens/route";

const RESUMO_LIMPO = {
  organizacoesVistas: 12,
  debitosRecuperados: 0,
  carteirasCorrigidas: 0,
  organizacoesQueFalharam: 0,
  tetoDaInstalacaoPassou: false,
};

function chamar(segredo = SEGREDO): Promise<Response> {
  return GET(
    new NextRequest("http://local/api/v1/cron/conferir-carteira-de-tokens", {
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

describe("GET /api/v1/cron/conferir-carteira-de-tokens", () => {
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

  it("teto da instalação passou: sai no log como warn, mesmo sem organização falhando", async () => {
    const resumo = { ...RESUMO_LIMPO, tetoDaInstalacaoPassou: true };
    conferir.mockResolvedValue(resumo);
    const res = await chamar();
    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toMatchObject({ tetoDaInstalacaoPassou: true });
  });

  it("erro do conferidor: resposta com frase fixa, texto do banco só no log", async () => {
    conferir.mockRejectedValue(
      new Error("fn_billing_conferir_carteira: column billing_token_wallets.fantasma não existe"),
    );
    const res = await chamar();
    expect(res.status).toBe(500);
    const corpo = (await res.json()) as { error: { code: string; message: string } };
    expect(corpo.error.message).toBe("Falha ao conferir a carteira de tokens de IA.");
    expect(corpo.error.message).not.toMatch(/billing_token_wallets/);
    expect(warn).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[1]).toMatchObject({
      error: expect.stringContaining("billing_token_wallets"),
    });
  });
});
