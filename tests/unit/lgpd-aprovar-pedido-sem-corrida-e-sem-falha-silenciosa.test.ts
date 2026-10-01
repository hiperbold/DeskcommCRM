/**
 * Aprovação manual de pedido LGPD (D-104): corrida e falha silenciosa.
 *
 * A) Dois cliques (ou duas abas) liam `received` e emitiam o evento duas vezes: a
 *    exportação saía duas vezes para o titular. O pedido agora é reivindicado por um
 *    update condicional (`status = received`) ANTES de emitir.
 * B) Se o `emit_event` falhava, o pedido virava `processing` sem evento e ficava
 *    parado até o vigia de prazo. Agora a falha devolve `received` e responde 5xx.
 * C) A mesma Idempotency-Key com outro motivo devolvia a resposta antiga como se
 *    fosse a deste. Agora o hash é comparado e o reuso é 409.
 *
 * O banco é em memória com a semântica real de filtro: a corrida só aparece se o
 * update condicional de fato olha o estado atual da linha.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { criarBancoEmMemoria, type BancoEmMemoria } from "../helpers/banco-em-memoria";

const ORG = "22222222-2222-4222-8222-222222222222";
const PEDIDO = "99999999-9999-4999-8999-999999999999";

let banco: BancoEmMemoria;
let emitFalha: boolean;

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => banco }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(async () => ({
    ok: true,
    user: { id: "u1", idioma: "pt-BR" },
    org: { orgId: ORG },
  })),
}));

import { POST } from "@/app/api/v1/lgpd/requests/[id]/approve/route";

function chamar(id: string, motivo = "pedido do titular conferido", chave = "chave-1") {
  const req = new NextRequest(`http://localhost/api/v1/lgpd/requests/${id}/approve`, {
    method: "POST",
    headers: { "Idempotency-Key": chave, "content-type": "application/json" },
    body: JSON.stringify({ approved_reason: motivo }),
  });
  return POST(req, { params: Promise.resolve({ id }) });
}

function statusDe(id: string): unknown {
  return banco.tabelas["lgpd_requests"]!.find((l) => l["id"] === id)!["status"];
}

function eventosEmitidos(): number {
  return banco.chamadasRpc.filter((c) => c.nome === "emit_event").length;
}

beforeEach(() => {
  emitFalha = false;
  banco = criarBancoEmMemoria(
    {
      lgpd_requests: [
        { id: PEDIDO, organization_id: ORG, request_type: "data_request", status: "received", contact_id: "c1", external_customer_id: null, due_at: "2026-10-30" },
      ],
      idempotency_keys: [],
    },
    { rpc: { emit_event: () => (emitFalha ? { error: { message: "emit caiu" } } : {}) } },
  );
});

describe("D-104: aprovação LGPD", () => {
  it("A) dois cliques ao mesmo tempo: um evento só, o segundo recebe 409", async () => {
    const [a, b] = await Promise.all([chamar(PEDIDO, "pedido do titular conferido", "k1"), chamar(PEDIDO, "pedido do titular conferido", "k2")]);

    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(eventosEmitidos()).toBe(1);
    expect(statusDe(PEDIDO)).toBe("processing");
  });

  it("A) pedido que já saiu de `received` não emite nada", async () => {
    banco.tabelas["lgpd_requests"]![0]!["status"] = "processing";

    const r = await chamar(PEDIDO);

    expect(r.status).toBe(409);
    expect(eventosEmitidos()).toBe(0);
  });

  it("B) emit_event falha: o pedido volta a `received` e a resposta é 5xx", async () => {
    emitFalha = true;

    const r = await chamar(PEDIDO);

    expect(r.status).toBeGreaterThanOrEqual(500);
    expect(statusDe(PEDIDO)).toBe("received");
    expect(banco.tabelas["idempotency_keys"]).toHaveLength(0);

    // E dá para aprovar de novo quando o barramento volta.
    emitFalha = false;
    const de_novo = await chamar(PEDIDO);
    expect(de_novo.status).toBe(200);
    expect(statusDe(PEDIDO)).toBe("processing");
  });

  it("C) a mesma chave com o mesmo pedido devolve a resposta guardada, sem emitir de novo", async () => {
    const primeira = await chamar(PEDIDO, "pedido do titular conferido", "k1");
    const repetida = await chamar(PEDIDO, "pedido do titular conferido", "k1");

    expect(primeira.status).toBe(200);
    expect(repetida.status).toBe(200);
    expect(eventosEmitidos()).toBe(1);
  });

  it("C) a mesma chave com OUTRO motivo é recusada, em vez de devolver a resposta antiga", async () => {
    await chamar(PEDIDO, "pedido do titular conferido", "k1");

    const r = await chamar(PEDIDO, "outro motivo, outra decisao", "k1");

    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("idempotency_key_reused");
    expect(eventosEmitidos()).toBe(1);
  });
});
