import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { criarFetchSeguro, lookupFixo } from "@/lib/ai/mcp-externo/fetch-seguro";

/**
 * D-168: o fetch do MCP externo resolve o nome UMA vez, valida, e abre a conexão
 * no endereço validado, com o nome só no SNI. A rede é trocada por uma
 * requisição falsa que expõe as opções com que seria aberta.
 */

type Chamada = { url: URL; opcoes: Record<string, unknown>; corpo: Buffer[] };

function redeFalsa(resposta: { status: number; headers?: Record<string, string>; corpo?: string }) {
  const chamadas: Chamada[] = [];
  const requisitar = vi.fn((url: URL, opcoes: Record<string, unknown>, cb: (res: unknown) => void) => {
    const chamada: Chamada = { url, opcoes, corpo: [] };
    chamadas.push(chamada);
    const req = new EventEmitter() as EventEmitter & { write: (c: Buffer) => void; end: () => void };
    req.write = (c) => chamada.corpo.push(Buffer.from(c));
    req.end = () => {
      const res = new PassThrough() as PassThrough & { statusCode: number; statusMessage: string; headers: Record<string, string> };
      res.statusCode = resposta.status;
      res.statusMessage = "";
      res.headers = resposta.headers ?? {};
      cb(res);
      res.end(resposta.corpo ?? "");
    };
    return req;
  });
  return { requisitar: requisitar as never, chamadas };
}

describe("conexão no IP validado", () => {
  it("resolve o nome uma vez e conecta no endereço validado, com o nome no SNI", async () => {
    const resolverHost = vi.fn(async () => ["93.184.216.34"]);
    const { requisitar, chamadas } = redeFalsa({ status: 200, corpo: '{"ok":true}' });
    const f = criarFetchSeguro({ resolverHost, requisitar });

    const res = await f("https://mcp.exemplo.com/rpc", { method: "POST", body: '{"a":1}', headers: { "content-type": "application/json" } });

    expect(resolverHost).toHaveBeenCalledTimes(1);
    expect(resolverHost).toHaveBeenCalledWith("mcp.exemplo.com");
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]!.opcoes.servername).toBe("mcp.exemplo.com");
    expect(chamadas[0]!.url.hostname).toBe("mcp.exemplo.com");
    expect(Buffer.concat(chamadas[0]!.corpo).toString()).toBe('{"a":1}');
    expect(await res.text()).toBe('{"ok":true}');

    // O lookup entregue ao socket só conhece o endereço validado: um DNS que
    // mude depois não é consultado.
    const lookup = chamadas[0]!.opcoes.lookup as (n: string, o: unknown, cb: (...a: unknown[]) => void) => void;
    const um = vi.fn();
    lookup("mcp.exemplo.com", {}, um);
    expect(um).toHaveBeenCalledWith(null, "93.184.216.34", 4);
    const todos = vi.fn();
    lookup("mcp.exemplo.com", { all: true }, todos);
    expect(todos).toHaveBeenCalledWith(null, [{ address: "93.184.216.34", family: 4 }]);
  });

  it("destino que a guarda recusa nem chega à rede", async () => {
    const resolverHost = vi.fn(async () => {
      throw new Error("unsafe_url:private_ip");
    });
    const { requisitar, chamadas } = redeFalsa({ status: 200 });
    const f = criarFetchSeguro({ resolverHost, requisitar });
    await expect(f("https://interno.exemplo.com/rpc")).rejects.toThrow("unsafe_url:private_ip");
    expect(chamadas).toHaveLength(0);
  });

  it("http continua recusado antes de resolver qualquer coisa", async () => {
    const resolverHost = vi.fn(async () => ["93.184.216.34"]);
    const f = criarFetchSeguro({ resolverHost, requisitar: redeFalsa({ status: 200 }).requisitar });
    await expect(f("http://mcp.exemplo.com/rpc")).rejects.toThrow("unsafe_url:https_required");
    expect(resolverHost).not.toHaveBeenCalled();
  });

  it("redirecionamento segue recusado", async () => {
    const { requisitar } = redeFalsa({ status: 302, headers: { location: "https://outro.exemplo.com" } });
    const f = criarFetchSeguro({ resolverHost: async () => ["93.184.216.34"], requisitar });
    await expect(f("https://mcp.exemplo.com/rpc")).rejects.toThrow("mcp_redirecionamento_recusado");
  });

  it("o teto de bytes da resposta continua valendo", async () => {
    const { requisitar } = redeFalsa({ status: 200, headers: { "content-length": String(3 * 1024 * 1024) } });
    const f = criarFetchSeguro({ resolverHost: async () => ["93.184.216.34"], requisitar });
    await expect(f("https://mcp.exemplo.com/rpc")).rejects.toThrow("mcp_resposta_grande_demais");
  });

  it("não aceita resposta comprimida que burlaria a contagem de bytes (pede identity)", async () => {
    const { requisitar, chamadas } = redeFalsa({ status: 200 });
    const f = criarFetchSeguro({ resolverHost: async () => ["93.184.216.34"], requisitar });
    await f("https://mcp.exemplo.com/rpc");
    expect((chamadas[0]!.opcoes.headers as Record<string, string>)["accept-encoding"]).toBe("identity");
  });
});

describe("lookupFixo", () => {
  it("devolve a família certa para IPv6", () => {
    const cb = vi.fn();
    lookupFixo(["2606:2800:220:1:248:1893:25c8:1946"])("x", {}, cb);
    expect(cb).toHaveBeenCalledWith(null, "2606:2800:220:1:248:1893:25c8:1946", 6);
  });
});
