import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A rota da régua de aviso de renovação (D-177, parte 2): mesmo contrato dos crons irmãos.
 * Sem segredo, 403 e nada roda; com segredo, devolve o resumo; pendência sai como warn; erro devolve
 * frase fixa, com o texto do banco só no log.
 */
const SEGREDO = "segredo-da-renovacao";

const avisar = vi.fn();
const info = vi.fn();
const warn = vi.fn();
const error = vi.fn();

vi.mock("@/lib/env", () => ({
  env: { INTERNAL_CRON_SECRET: "segredo-da-renovacao", INTERNAL_SECRET: "" },
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
vi.mock("@/lib/billing/assinatura/avisar-renovacao-real", () => ({
  avisadorDeRenovacaoSobre: () => ({ marcador: "db-fake" }),
  servicosDeRenovacaoSobre: () => ({ marcador: "servicos-fake" }),
}));
vi.mock("@/lib/billing/assinatura/avisar-renovacao", () => ({
  avisarRenovacoes: (...a: unknown[]) => avisar(...a),
}));

import { GET, POST } from "@/app/api/v1/cron/avisar-renovacao/route";

const LIMPO = {
  avaliados: 4,
  ignorados: 0,
  avisadosPorMarco: { d30: 2, d15: 1, d7: 1, d1: 0, d0: 0 },
  emailsEnviados: 4,
  emailsSemDestinatario: 0,
  emailsNaoConfigurados: 0,
  emailsQueFalharam: 0,
  avisosCriados: 4,
  avisosQueFalharam: 0,
  avisosEncerrados: 1,
  organizacoesQueFalharam: 0,
  restantes: 0,
};

const chamar = (segredo = SEGREDO, metodo: typeof GET = GET) =>
  metodo(
    new NextRequest("http://local/api/v1/cron/avisar-renovacao", {
      headers: segredo ? { authorization: `Bearer ${segredo}` } : {},
    }),
  );

beforeEach(() => {
  avisar.mockReset();
  info.mockReset();
  warn.mockReset();
  error.mockReset();
});

describe("GET/POST /api/v1/cron/avisar-renovacao", () => {
  it("sem o segredo: 403 e a régua nem roda", async () => {
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

  it.each([
    ["organização que falhou", { organizacoesQueFalharam: 1 }],
    ["e-mail que falhou", { emailsQueFalharam: 1 }],
    ["aviso na Central que falhou", { avisosQueFalharam: 1 }],
    ["rodada que ficou sem tempo", { restantes: 3 }],
  ])("%s: sai como warn, com o resumo", async (_nome, parte) => {
    avisar.mockResolvedValue({ ...LIMPO, ...parte });
    const res = await chamar();
    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toMatchObject(parte);
  });

  it("erro: frase fixa na resposta, texto do banco só no log", async () => {
    avisar.mockRejectedValue(new Error("relation billing_avisos_de_renovacao does not exist"));
    const res = await chamar();
    expect(res.status).toBe(500);
    const corpo = JSON.stringify(await res.json());
    expect(corpo).not.toContain("billing_avisos_de_renovacao");
    expect(corpo).toContain("Falha ao avisar a renovação dos planos.");
    expect(error.mock.calls[0]?.[1]).toMatchObject({ error: expect.stringContaining("billing_avisos_de_renovacao") });
  });
});
