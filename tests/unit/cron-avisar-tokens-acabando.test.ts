import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A rota do aviso de tokens de IA acabando (IA-02): mesmo contrato dos crons irmãos.
 * Sem segredo, 403 e nada roda; com segredo, devolve o resumo; rodada com envio sai como info e a vazia fica
 * calada (roda a cada 15 minutos); falha sai como warn; erro devolve frase fixa, com o texto do banco só no log.
 */
const SEGREDO = "segredo-dos-tokens";

const avisar = vi.fn();
const info = vi.fn();
const warn = vi.fn();
const error = vi.fn();

vi.mock("@/lib/env", () => ({
  env: { INTERNAL_CRON_SECRET: "segredo-dos-tokens", INTERNAL_SECRET: "" },
}));
vi.mock("@/lib/logger", () => ({
  logger: {
    info: (...a: unknown[]) => info(...a),
    warn: (...a: unknown[]) => warn(...a),
    error: (...a: unknown[]) => error(...a),
    debug: vi.fn(),
  },
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ marcador: "admin-fake" }) }));
vi.mock("@/lib/email/conta-e-cobranca/tokens-acabando", () => ({
  avisarTokensAcabando: (...a: unknown[]) => avisar(...a),
}));

import { GET, POST } from "@/app/api/v1/cron/avisar-tokens-acabando/route";

const LIMPO = {
  lidos: 2,
  descartados: 0,
  jaAvisados: 0,
  enfileirados: 2,
  semSaldo: 0,
  falhas: 0,
};

const chamar = (segredo = SEGREDO, metodo: typeof GET = GET) =>
  metodo(
    new NextRequest("http://local/api/v1/cron/avisar-tokens-acabando", {
      headers: segredo ? { authorization: `Bearer ${segredo}` } : {},
    }),
  );

beforeEach(() => {
  avisar.mockReset();
  info.mockReset();
  warn.mockReset();
  error.mockReset();
});

describe("GET/POST /api/v1/cron/avisar-tokens-acabando", () => {
  it("sem o segredo: 403 e o aviso nem roda", async () => {
    expect((await chamar("")).status).toBe(403);
    expect(avisar).not.toHaveBeenCalled();
  });

  it("segredo errado: 403", async () => {
    expect((await chamar("outro")).status).toBe(403);
    expect(avisar).not.toHaveBeenCalled();
  });

  it("rodada que enfileirou: 200 com o resumo, log info e sem warn (GET e POST)", async () => {
    avisar.mockResolvedValue(LIMPO);
    for (const metodo of [GET, POST]) {
      const res = await chamar(SEGREDO, metodo);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { data: typeof LIMPO }).data).toEqual(LIMPO);
    }
    expect(info).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalled();
  });

  it("rodada vazia: 200 e nenhum log (a cada 15 minutos, o silêncio é o normal)", async () => {
    avisar.mockResolvedValue({ ...LIMPO, lidos: 0, enfileirados: 0 });
    const res = await chamar();
    expect(res.status).toBe(200);
    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("enfileiramento ou organização que falhou: sai como warn, com o resumo", async () => {
    avisar.mockResolvedValue({ ...LIMPO, falhas: 1 });
    const res = await chamar();
    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toMatchObject({ falhas: 1 });
  });

  it("erro: frase fixa na resposta, texto do banco só no log", async () => {
    avisar.mockRejectedValue(new Error("relation billing_token_avisos_emitidos does not exist"));
    const res = await chamar();
    expect(res.status).toBe(500);
    const corpo = JSON.stringify(await res.json());
    expect(corpo).not.toContain("billing_token_avisos_emitidos");
    expect(corpo).toContain("Falha ao avisar os tokens de IA acabando.");
    expect(error.mock.calls[0]?.[1]).toMatchObject({ error: expect.stringContaining("billing_token_avisos_emitidos") });
  });
});
