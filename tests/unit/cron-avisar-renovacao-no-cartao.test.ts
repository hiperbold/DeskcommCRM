import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A rota do aviso de renovação no cartão (COB-04): mesmo contrato dos crons irmãos.
 * Sem segredo, 403 e nada roda; com segredo, devolve o resumo; falha sai como warn; erro devolve
 * frase fixa, com o texto do banco só no log.
 */
const SEGREDO = "segredo-do-cartao";

const avisar = vi.fn();
const info = vi.fn();
const warn = vi.fn();
const error = vi.fn();

vi.mock("@/lib/env", () => ({
  env: { INTERNAL_CRON_SECRET: "segredo-do-cartao", INTERNAL_SECRET: "" },
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
vi.mock("@/lib/email/conta-e-cobranca/renovacao-no-cartao", () => ({
  avisarRenovacoesNoCartao: (...a: unknown[]) => avisar(...a),
}));

import { GET, POST } from "@/app/api/v1/cron/avisar-renovacao-no-cartao/route";

const LIMPO = {
  avaliados: 4,
  foraDaJanela: 1,
  pulados: 0,
  enfileirados: 3,
  jaAvisados: 0,
  falhas: 0,
  restantes: 0,
};

const chamar = (segredo = SEGREDO, metodo: typeof GET = GET) =>
  metodo(
    new NextRequest("http://local/api/v1/cron/avisar-renovacao-no-cartao", {
      headers: segredo ? { authorization: `Bearer ${segredo}` } : {},
    }),
  );

beforeEach(() => {
  avisar.mockReset();
  info.mockReset();
  warn.mockReset();
  error.mockReset();
});

describe("GET/POST /api/v1/cron/avisar-renovacao-no-cartao", () => {
  it("sem o segredo: 403 e o aviso nem roda", async () => {
    expect((await chamar("")).status).toBe(403);
    expect(avisar).not.toHaveBeenCalled();
  });

  it("segredo errado: 403", async () => {
    expect((await chamar("outro")).status).toBe(403);
    expect(avisar).not.toHaveBeenCalled();
  });

  it("rodada limpa: 200 com o resumo, log info e sem warn (GET e POST)", async () => {
    avisar.mockResolvedValue(LIMPO);
    for (const metodo of [GET, POST]) {
      const res = await chamar(SEGREDO, metodo);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { data: typeof LIMPO }).data).toEqual(LIMPO);
    }
    expect(info).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalled();
  });

  it("enfileiramento ou contrato que falhou: sai como warn, com o resumo", async () => {
    avisar.mockResolvedValue({ ...LIMPO, falhas: 2 });
    const res = await chamar();
    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toMatchObject({ falhas: 2 });
  });

  it("orçamento de tempo estourado (contratos que ficaram para a próxima rodada): sai como warn", async () => {
    avisar.mockResolvedValue({ ...LIMPO, restantes: 7 });
    const res = await chamar();
    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toMatchObject({ restantes: 7 });
  });

  it("erro: frase fixa na resposta, texto do banco só no log", async () => {
    avisar.mockRejectedValue(new Error("relation billing_contracts does not exist"));
    const res = await chamar();
    expect(res.status).toBe(500);
    const corpo = JSON.stringify(await res.json());
    expect(corpo).not.toContain("billing_contracts");
    expect(corpo).toContain("Falha ao avisar a renovação no cartão.");
    expect(error.mock.calls[0]?.[1]).toMatchObject({ error: expect.stringContaining("billing_contracts") });
  });
});
