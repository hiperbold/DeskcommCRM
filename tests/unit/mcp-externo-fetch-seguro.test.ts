import { describe, expect, it, vi } from "vitest";
import { TETO_DE_BYTES, criarFetchSeguro } from "@/lib/ai/mcp-externo/fetch-seguro";

const resposta = (status: number) => new Response("{}", { status });

describe("fetch do cliente MCP", () => {
  it("recusa http em QUALQUER ambiente, não só em produção", async () => {
    // `assertSafeOutboundUrl` só recusa http com NODE_ENV=production (o vitest
    // e o dev não são). Para credencial de terceiro, http nunca vale.
    const buscar = vi.fn();
    const f = criarFetchSeguro({ validarHost: vi.fn(), fetch: buscar });
    await expect(f("http://exemplo.com/mcp")).rejects.toThrow(/https_required/);
    expect(buscar).not.toHaveBeenCalled();
  });

  it("recusa host que resolve para IP interno", async () => {
    const f = criarFetchSeguro({
      validarHost: vi.fn(async () => { throw new Error("unsafe_url:private_ip"); }),
      fetch: vi.fn(),
    });
    await expect(f("https://interno.exemplo.com/mcp")).rejects.toThrow(/private_ip/);
  });

  it("não segue redirecionamento", async () => {
    // Tipado como `typeof fetch` (padrão do repo para mock de fetch): sem
    // parâmetro, `vi.fn` infere `calls` como tupla vazia e `[1]` não compila.
    const fetchFalso = vi.fn<typeof fetch>(async () => resposta(302));
    const f = criarFetchSeguro({ validarHost: vi.fn(async () => {}), fetch: fetchFalso });
    await expect(f("https://exemplo.com/mcp")).rejects.toThrow(/mcp_redirecionamento_recusado/);
    expect(fetchFalso.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
  });

  it("valida o host em TODA requisição, não só na primeira", async () => {
    const validarHost = vi.fn(async () => {});
    const f = criarFetchSeguro({ validarHost, fetch: vi.fn(async () => resposta(200)) });
    await f("https://exemplo.com/mcp");
    await f("https://exemplo.com/mcp");
    expect(validarHost).toHaveBeenCalledTimes(2);
  });

  it.each([301, 307, 308])("recusa redirecionamento %i, não só 302", async (status) => {
    const fetchFalso = vi.fn<typeof fetch>(async () => resposta(status));
    const f = criarFetchSeguro({ validarHost: vi.fn(async () => {}), fetch: fetchFalso });
    await expect(f("https://exemplo.com/mcp")).rejects.toThrow(/mcp_redirecionamento_recusado/);
  });

  it("recusa 127.0.0.1 e 10.0.0.1 com a validação PADRÃO (sem host injetado), sem chegar a chamar fetch", async () => {
    // Sem `validarHost` injetado: passa pela cadeia real (`assertSafeOutboundUrl`
    // textual recusa antes mesmo de chegar a `assertDestinoResolvidoSeguro`, que
    // resolveria por DNS; para IP literal o guard textual já basta e é
    // determinístico, sem rede no teste). O motivo pode ser `private_host`
    // (textual) ou `private_ip` (DNS): ambos são `unsafe_url:*`.
    const buscar = vi.fn();
    const f = criarFetchSeguro({ fetch: buscar });
    await expect(f("https://127.0.0.1/mcp")).rejects.toThrow(/unsafe_url:private_(host|ip)/);
    await expect(f("https://10.0.0.1/mcp")).rejects.toThrow(/unsafe_url:private_(host|ip)/);
    expect(buscar).not.toHaveBeenCalled();
  });

  it("recusa resposta com content-length maior que o teto, sem ler o corpo", async () => {
    const corpo = new Response("{}", { status: 200 });
    corpo.headers.set("content-length", String(TETO_DE_BYTES + 1));
    const f = criarFetchSeguro({ validarHost: vi.fn(async () => {}), fetch: vi.fn(async () => corpo) });
    await expect(f("https://exemplo.com/mcp")).rejects.toThrow(/mcp_resposta_grande_demais/);
  });

  it("corta corpo SEM content-length que ultrapassa o teto durante a leitura (não trava SSE)", async () => {
    const pedaco = new Uint8Array(1024 * 1024); // 1 MiB
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(pedaco);
        controller.enqueue(pedaco);
        controller.enqueue(pedaco); // 3 MiB no total, sem content-length declarado
        controller.close();
      },
    });
    const respostaEmStream = new Response(stream, { status: 200 });
    expect(respostaEmStream.headers.get("content-length")).toBeNull();
    const f = criarFetchSeguro({ validarHost: vi.fn(async () => {}), fetch: vi.fn(async () => respostaEmStream) });
    const res = await f("https://exemplo.com/mcp");
    const leitor = res.body!.getReader();
    await expect(
      (async () => {
        let lido = 0;
        while (lido < 4 * 1024 * 1024) {
          const { done, value } = await leitor.read();
          if (done) break;
          lido += value?.byteLength ?? 0;
        }
      })(),
    ).rejects.toThrow(/mcp_resposta_grande_demais/);
  });

  it("cancela o corpo antes de recusar por content-length grande demais (não deixa o socket pendurado)", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
    const cancelarEspiao = vi.spyOn(stream, "cancel");
    const corpo = new Response(stream, { status: 200 });
    corpo.headers.set("content-length", String(TETO_DE_BYTES + 1));
    const f = criarFetchSeguro({ validarHost: vi.fn(async () => {}), fetch: vi.fn(async () => corpo) });
    await expect(f("https://exemplo.com/mcp")).rejects.toThrow(/mcp_resposta_grande_demais/);
    expect(cancelarEspiao).toHaveBeenCalled();
  });

  it("cancela o corpo antes de recusar redirecionamento (não deixa o socket pendurado)", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
    const cancelarEspiao = vi.spyOn(stream, "cancel");
    const corpo = new Response(stream, { status: 302 });
    const f = criarFetchSeguro({ validarHost: vi.fn(async () => {}), fetch: vi.fn(async () => corpo) });
    await expect(f("https://exemplo.com/mcp")).rejects.toThrow(/mcp_redirecionamento_recusado/);
    expect(cancelarEspiao).toHaveBeenCalled();
  });
});
