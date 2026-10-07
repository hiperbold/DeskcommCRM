/**
 * D-135 (sobra): a mensagem crua do Postgres não volta ao cliente.
 *
 * O defeito: cerca de 250 pontos de rota faziam `fail("internal_error", error.message, 500, ...)`. A
 * mensagem do driver traz nome de tabela, de coluna, de constraint e até o VALOR da chave duplicada
 * ("Key (email)=(joana@exemplo.com) already exists"), que ia parar na resposta de quem chamou.
 *
 * Três camadas, e nenhuma é "a função devolve texto":
 *  1. o helper responde com código estável e frase fixa, e o erro de verdade vai só para o log;
 *  2. uma rota REAL, com o banco falhando de verdade, responde sem nada do erro;
 *  3. a varredura do código: nenhum ponto de rota volta a repassar `.message` de erro como mensagem.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { falhaInterna, MENSAGEM_DE_FALHA_INTERNA } from "@/lib/api/wrappers";
import { logger } from "@/lib/logger";

const ERRO_DO_POSTGRES =
  'duplicate key value violates unique constraint "contacts_org_phone_key" Key (organization_id, phone_number)=(22222222-2222-4222-8222-222222222222, +5511900000001) already exists.';

const PROIBIDO_NA_RESPOSTA = ["duplicate key", "contacts_org_phone_key", "phone_number", "+5511900000001", "organization_id"];

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("falhaInterna", () => {
  it("responde 500 com o código pedido e a frase fixa, sem nada do erro", async () => {
    vi.spyOn(logger, "error").mockImplementation(() => undefined);

    const res = falhaInterna("internal_error", { message: ERRO_DO_POSTGRES }, { requestId: "req-1" });
    const corpo = await res.json();

    expect(res.status).toBe(500);
    expect(res.headers.get("X-Request-Id")).toBe("req-1");
    expect(corpo.error.code).toBe("internal_error");
    expect(corpo.error.message).toBe(MENSAGEM_DE_FALHA_INTERNA);
    const serializado = JSON.stringify(corpo);
    for (const trecho of PROIBIDO_NA_RESPOSTA) expect(serializado).not.toContain(trecho);
  });

  it("mantém o código estável de quem já tinha um próprio (read_failed, save_failed, query_failed)", async () => {
    vi.spyOn(logger, "error").mockImplementation(() => undefined);

    for (const codigo of ["read_failed", "save_failed", "query_failed", "internal"]) {
      const corpo = await falhaInterna(codigo, new Error(ERRO_DO_POSTGRES)).json();
      expect(corpo.error.code).toBe(codigo);
      expect(corpo.error.message).toBe(MENSAGEM_DE_FALHA_INTERNA);
    }
  });

  it("o erro de verdade vai para o log interno, com o código e o id da requisição", () => {
    const log = vi.spyOn(logger, "error").mockImplementation(() => undefined);

    falhaInterna("internal_error", { message: ERRO_DO_POSTGRES }, { requestId: "req-2" });

    expect(log).toHaveBeenCalledTimes(1);
    const [, contexto] = log.mock.calls[0]!;
    expect(contexto).toMatchObject({ code: "internal_error", request_id: "req-2", causa: ERRO_DO_POSTGRES });
  });

  it("aceita o erro em qualquer forma que o código tem (Error, objeto do PostgREST, texto, nulo)", () => {
    const log = vi.spyOn(logger, "error").mockImplementation(() => undefined);

    falhaInterna("internal_error", new Error("a"));
    falhaInterna("internal_error", { message: "b", code: "23505" });
    falhaInterna("internal_error", "c");
    falhaInterna("internal_error", null);

    expect(log.mock.calls.map((c) => (c[1] as { causa: string }).causa)).toEqual(["a", "b", "c", "desconhecido"]);
  });
});

describe("uma rota real com o banco falhando", () => {
  it("GET /campaign-suppressions responde sem o texto do Postgres", async () => {
    vi.resetModules();
    // O módulo é recarregado a cada `resetModules`: o espião tem de estar na MESMA instância do logger que a rota usa.
    const { logger: loggerDaRota } = await import("@/lib/logger");
    const log = vi.spyOn(loggerDaRota, "error").mockImplementation(() => undefined);
    vi.doMock("@/lib/auth/require-role", () => ({
      requireRole: vi.fn(async () => ({
        ok: true,
        user: { id: "u1", idioma: "pt-BR" },
        org: { orgId: "22222222-2222-4222-8222-222222222222", role: "manager" },
      })),
    }));
    vi.doMock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
    vi.doMock("@/lib/supabase/server", () => ({
      createClient: vi.fn(async () => {
        const q: Record<string, unknown> = {};
        for (const m of ["select", "eq", "order", "limit", "range", "in", "is"]) q[m] = () => q;
        q.then = (resolve: (v: unknown) => unknown) =>
          resolve({ data: null, error: { message: ERRO_DO_POSTGRES, code: "23505" } });
        return { from: () => q };
      }),
    }));

    const { GET } = await import("@/app/api/v1/campaign-suppressions/route");
    const res = await GET();
    const texto = await res.text();

    expect(res.status).toBe(500);
    expect(JSON.parse(texto).error.message).toBe(MENSAGEM_DE_FALHA_INTERNA);
    for (const trecho of PROIBIDO_NA_RESPOSTA) expect(texto).not.toContain(trecho);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![1]).toMatchObject({ causa: ERRO_DO_POSTGRES });
  });
});

describe("varredura: nenhum ponto de rota repassa o texto do erro ao cliente", () => {
  const arquivos = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "app", "lib"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f));

  // `fail("<código>", <algo>.message ..., 500` e a mesma coisa com a abertura quebrada em linhas.
  const REPASSE = /fail\(\s*"[a-z_]+"\s*,\s*[A-Za-z_][\w.]*\??\.message\b[^)]*?,\s*500\b/;

  it("o padrão proibido existe de verdade no que a régua enxerga (controle da sonda)", () => {
    expect(REPASSE.test('return fail("internal_error", error.message, 500, { requestId });')).toBe(true);
    expect(REPASSE.test('return fail(\n  "read_failed",\n  err?.message,\n  500,\n);')).toBe(true);
    expect(REPASSE.test('return fail("internal_error", "Não foi possível carregar.", 500, { requestId });')).toBe(false);
  });

  it("nenhum arquivo de app/ e lib/ repassa .message de erro numa resposta 500", () => {
    const achados: string[] = [];
    for (const arquivo of arquivos) {
      let texto: string;
      try {
        texto = readFileSync(arquivo, "utf8");
      } catch {
        continue;
      }
      if (REPASSE.test(texto)) achados.push(arquivo);
    }
    expect(achados, "troque por falhaInterna(código, erro, { requestId }) de lib/api/wrappers").toEqual([]);
  });
});
