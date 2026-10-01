// @vitest-environment node
/**
 * D-105: o corpo multipart é lido com teto de bytes ANTES de entrar na memória.
 * O envio em pedaços (sem Content-Length) era o furo: o teto declarado vinha como
 * zero e `req.formData()` carregava tudo.
 *
 * Duas camadas: o leitor (`lerMultipartComTeto`) com fluxos reais, e a ROTA de
 * importação de skill de verdade (autenticação falsa) recebendo um corpo em
 * pedaços acima do teto.
 */
import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(async () => ({
    ok: true,
    user: { id: "u1", idioma: "pt-BR" },
    org: { orgId: "11111111-1111-4111-8111-111111111111", role: "manager" },
  })),
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));

import { FOLGA_MULTIPART_BYTES, lerMultipartComTeto } from "@/lib/api/multipart-com-teto";

const MB = 1024 * 1024;

/** Corpo em pedaços de 1 MB, sem Content-Length, que conta quantos pedaços foram puxados. */
function corpoEmPedacos(totalMb: number, contador: { puxados: number }, contentType = "multipart/form-data; boundary=x") {
  let enviados = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (enviados >= totalMb) {
        controller.close();
        return;
      }
      enviados += 1;
      contador.puxados += 1;
      controller.enqueue(new Uint8Array(MB));
    },
  });
  return new Request("http://localhost/x", {
    method: "POST",
    body: stream,
    headers: { "content-type": contentType },
    duplex: "half",
  } as RequestInit);
}

describe("lerMultipartComTeto", () => {
  it("⭐ corpo em pedaços (sem Content-Length) acima do teto é recusado e a leitura para cedo", async () => {
    const contador = { puxados: 0 };
    const r = await lerMultipartComTeto(corpoEmPedacos(500, contador), 5 * MB);
    expect(r).toEqual({ ok: false, motivo: "grande" });
    // Teto 5 MB + folga: para logo depois, não lê as centenas de MB.
    expect(contador.puxados).toBeLessThanOrEqual(5 + FOLGA_MULTIPART_BYTES / MB + 2);
  });

  it("Content-Length declarado acima do teto é recusado sem ler o corpo", async () => {
    const contador = { puxados: 0 };
    const req = corpoEmPedacos(1, contador);
    const comTamanho = new Request(req.url, {
      method: "POST",
      body: req.body,
      headers: { "content-type": "multipart/form-data; boundary=x", "content-length": String(900 * MB) },
      duplex: "half",
    } as RequestInit);
    expect(await lerMultipartComTeto(comTamanho, 5 * MB)).toEqual({ ok: false, motivo: "grande" });
    // O fluxo pode ser pré-puxado uma vez pela própria construção do Request.
    expect(contador.puxados).toBeLessThanOrEqual(1);
  });

  it("CONTROLE POSITIVO: multipart dentro do teto chega inteiro ao parser", async () => {
    const form = new FormData();
    form.append("file", new File([new Uint8Array(1000).fill(65)], "a.csv", { type: "text/csv" }));
    form.append("name", "material");
    const req = new Request("http://localhost/x", { method: "POST", body: form });
    const r = await lerMultipartComTeto(req, 5 * MB);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const arquivo = r.form.get("file") as File;
      expect(arquivo.size).toBe(1000);
      expect(r.form.get("name")).toBe("material");
    }
  });

  it("corpo que não é multipart devolve invalido, não estoura", async () => {
    const req = new Request("http://localhost/x", {
      method: "POST",
      body: "isto não é multipart",
      headers: { "content-type": "text/plain" },
    });
    expect(await lerMultipartComTeto(req, 5 * MB)).toEqual({ ok: false, motivo: "invalido" });
  });
});

describe("rota de importação de skill: corpo em pedaços acima do teto", () => {
  it("⭐ responde 413 sem materializar o corpo (antes passava como Content-Length zero)", async () => {
    const { POST } = await import("@/app/api/v1/ai/skills/import/route");
    const contador = { puxados: 0 };
    const stream = corpoEmPedacos(300, contador).body!;
    const req = new NextRequest("http://localhost/api/v1/ai/skills/import", {
      method: "POST",
      body: stream,
      headers: { "content-type": "multipart/form-data; boundary=x" },
      duplex: "half",
    } as never);
    const res = await POST(req);
    expect(res.status).toBe(413);
    expect(contador.puxados).toBeLessThan(20);
  });
});
