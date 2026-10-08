import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A rota do recifrador das credenciais de IA (D-168, parte 2): mesmo contrato dos crons irmãos. Sem segredo,
 * 403 e nada roda; com segredo, devolve o resumo e o estado do interruptor; `?lote=` é limitado; pendência
 * sai como warn; erro devolve frase fixa, com o texto do banco só no log. A regra do recifrador é provada em
 * `recifrar-credenciais-de-ia-legadas.test.ts`, com cripto real.
 */
const SEGREDO = "segredo-do-recifrador";

const recifrar = vi.fn();
const info = vi.fn();
const warn = vi.fn();
const error = vi.fn();

vi.mock("@/lib/env", () => ({
  env: { INTERNAL_CRON_SECRET: "segredo-do-recifrador", INTERNAL_SECRET: "", AI_CRED_AES_KEY: "" },
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
vi.mock("@/lib/ai/credenciais/recifrar", () => ({
  LOTE_PADRAO_DO_RECIFRADOR: 25,
  repositorioDeRecifraSobre: () => ({ marcador: "repo-fake" }),
  recifrarCredenciaisLegadas: (...a: unknown[]) => recifrar(...a),
}));

import { GET, POST } from "@/app/api/v1/cron/recifrar-credenciais-de-ia/route";

const LIMPO = { varridas: 3, jaNoFormatoNovo: 1, recifradas: 2, mudaramNoMeio: 0, falhas: 0, restantes: 0 };

const chamar = (segredo = SEGREDO, metodo: typeof GET = GET, consulta = "") =>
  metodo(
    new NextRequest(`http://local/api/v1/cron/recifrar-credenciais-de-ia${consulta}`, {
      headers: segredo ? { authorization: `Bearer ${segredo}` } : {},
    }),
  );

beforeEach(() => {
  recifrar.mockReset();
  info.mockReset();
  warn.mockReset();
  error.mockReset();
  delete process.env.AI_CRED_RECUSAR_LEGADO;
});

describe("GET/POST /api/v1/cron/recifrar-credenciais-de-ia", () => {
  it("sem o segredo: 403 e o recifrador nem roda", async () => {
    expect((await chamar("")).status).toBe(403);
    expect(recifrar).not.toHaveBeenCalled();
  });

  it("segredo errado: 403", async () => {
    expect((await chamar("outro")).status).toBe(403);
    expect(recifrar).not.toHaveBeenCalled();
  });

  it("rodada limpa: 200 com o resumo e o interruptor desligado (GET e POST), log info, sem warn", async () => {
    recifrar.mockResolvedValue(LIMPO);
    for (const metodo of [GET, POST]) {
      const res = await chamar(SEGREDO, metodo);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { data: unknown }).data).toEqual({ ...LIMPO, recusaDoLegadoLigada: false });
    }
    expect(info).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalled();
  });

  it("a resposta diz quando o interruptor está ligado neste ambiente", async () => {
    process.env.AI_CRED_RECUSAR_LEGADO = "1";
    recifrar.mockResolvedValue(LIMPO);
    const corpo = (await (await chamar()).json()) as { data: { recusaDoLegadoLigada: boolean } };
    expect(corpo.data.recusaDoLegadoLigada).toBe(true);
  });

  it.each([
    ["sobrou linha no formato antigo", { restantes: 4 }],
    ["linha que não abriu", { falhas: 1 }],
  ])("%s: 200 com o resumo, mas sai como warn", async (_nome, extra) => {
    recifrar.mockResolvedValue({ ...LIMPO, ...extra });
    expect((await chamar()).status).toBe(200);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(info).not.toHaveBeenCalled();
  });

  it.each([
    ["", 25],
    ["?lote=10", 10],
    ["?lote=500", 100],
    ["?lote=0", 25],
    ["?lote=abc", 25],
    ["?lote=2.5", 25],
  ])("lote %s vira %s", async (consulta, esperado) => {
    recifrar.mockResolvedValue(LIMPO);
    await chamar(SEGREDO, GET, consulta);
    expect(recifrar).toHaveBeenCalledWith(expect.objectContaining({ lote: esperado }));
  });

  it("falha ao listar: 500 com frase fixa, e o texto do banco só no log", async () => {
    recifrar.mockRejectedValue(new Error("relation ai_provider_credentials: senha do banco xyz"));
    const res = await chamar();
    expect(res.status).toBe(500);
    const texto = await res.text();
    expect(texto).not.toContain("senha do banco");
    expect(texto).toContain("Falha ao recifrar as credenciais de IA.");
    expect(error).toHaveBeenCalledTimes(1);
  });
});
