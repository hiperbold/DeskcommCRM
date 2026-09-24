// @vitest-environment node
//
// `lib/http/corpo-com-limite.ts`: fase F5, Tarefa 12, decisão 19. Testa a
// leitura em FLUXO isolada da rota - o corte precisa valer mesmo quando
// nenhum Content-Length é declarado (o cabeçalho pode mentir).
import { describe, expect, it } from "vitest";

import { lerCorpoComLimite } from "@/lib/http/corpo-com-limite";

function streamDe(...pedacos: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const pedaco of pedacos) controller.enqueue(enc.encode(pedaco));
      controller.close();
    },
  });
}

describe("lerCorpoComLimite", () => {
  it("corpo nulo devolve texto vazio, ok", async () => {
    const resultado = await lerCorpoComLimite(null, 1024);
    expect(resultado).toEqual({ ok: true, texto: "" });
  });

  it("corpo dentro do teto devolve o texto completo", async () => {
    const resultado = await lerCorpoComLimite(streamDe('{"a":1}'), 1024);
    expect(resultado).toEqual({ ok: true, texto: '{"a":1}' });
  });

  it("corpo acima do teto (num chunk só) recusa sem texto", async () => {
    const resultado = await lerCorpoComLimite(streamDe("a".repeat(2000)), 1024);
    expect(resultado.ok).toBe(false);
    expect(resultado.texto).toBe("");
  });

  it("corpo acima do teto espalhado em vários chunks recusa (a soma que importa)", async () => {
    const resultado = await lerCorpoComLimite(streamDe("a".repeat(700), "b".repeat(700)), 1024);
    expect(resultado.ok).toBe(false);
  });

  it("exatamente no teto passa; um byte a mais recusa", async () => {
    const noTeto = await lerCorpoComLimite(streamDe("a".repeat(10)), 10);
    expect(noTeto.ok).toBe(true);
    expect(noTeto.texto).toBe("a".repeat(10));

    const acimaDoTeto = await lerCorpoComLimite(streamDe("a".repeat(11)), 10);
    expect(acimaDoTeto.ok).toBe(false);
  });

  it("preserva acentos UTF-8 multibyte cortados na fronteira do chunk (Buffer.concat, não d += chunk)", async () => {
    // "ç" (U+00E7) em UTF-8 é 2 bytes (0xC3 0xA7). Emitir esses dois bytes em
    // chunks SEPARADOS reproduz a fronteira que quebra `texto += chunk` (nota
    // de memória "Node: nunca d += chunk em resposta HTTP").
    const bytesDeAcentuacao = new TextEncoder().encode("preço");
    const meio = 3; // corta no meio do "ç" (2 bytes UTF-8)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytesDeAcentuacao.slice(0, meio));
        controller.enqueue(bytesDeAcentuacao.slice(meio));
        controller.close();
      },
    });
    const resultado = await lerCorpoComLimite(stream, 1024);
    expect(resultado.ok).toBe(true);
    expect(resultado.texto).toBe("preço");
  });
});
