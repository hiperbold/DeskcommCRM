/**
 * Exclusão da loja (`store/redact`) da Nuvemshop: D-140 e D-141.
 *
 * D-140: o pedido de apagar os dados da LOJA virou "apagar a ORGANIZAÇÃO": o
 * worker percorria todo contato, de qualquer origem, e no fim marcava a
 * organização como `redacted`. Um CRM multicanal perdia, de forma irreversível, o
 * que nunca veio da loja. Agora só entra o contato com `source = 'nuvemshop'` e o
 * status da organização nunca muda.
 *
 * D-141: a paginação era por offset sobre uma lista filtrada por
 * `is_anonymized = false`, que o próprio laço altera. Com 250 contatos, o lote 1
 * anonimizava 1 a 100 e o offset ia a 100; a consulta seguinte devolvia 201 a 250
 * e parava, e 101 a 200 ficavam intactos com o pedido "concluído". Agora a
 * paginação é por chave (`id > último`).
 *
 * O banco aqui é em memória com a semântica real de filtro (`tests/helpers/
 * banco-em-memoria.ts`): a cascata dublê muda `is_anonymized` na linha, então o
 * defeito do offset só aparece se o código realmente ler errado.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EventRow } from "@/lib/event-log/dispatcher";
import { criarBancoEmMemoria, type BancoEmMemoria, type Linha } from "../helpers/banco-em-memoria";

const ORG = "22222222-2222-4222-8222-222222222222";
const PEDIDO = "99999999-9999-4999-8999-999999999999";

let banco: BancoEmMemoria;
let falhaEm: Set<string>;
let ordemDeAnonimizacao: string[];

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => banco }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/lgpd/repository", () => ({
  findContactByExternalId: vi.fn(async () => null),
  findLgpdRequest: vi.fn(async (_org: string, id: string) => {
    const linha = banco.tabelas["lgpd_requests"]!.find((l) => l["id"] === id);
    return linha ? { ...linha } : null;
  }),
}));
vi.mock("@/lib/lgpd/redact-cascade", () => ({
  cascadeRedactContact: vi.fn(async (args: { contactId: string }) => {
    if (falhaEm.has(args.contactId)) throw new Error("cascata caiu");
    const contato = banco.tabelas["contacts"]!.find((l) => l["id"] === args.contactId)!;
    contato["is_anonymized"] = true;
    ordemDeAnonimizacao.push(args.contactId);
    return { alreadyAnonymized: false, counts: { contacts: 1 }, mediaPaths: [] };
  }),
}));

import { processLgpdRedact } from "@/workers/lgpd-redact-worker";

function idDoContato(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function contato(n: number, source: string): Linha {
  return { id: idDoContato(n), organization_id: ORG, source, is_anonymized: false };
}

function evento(): EventRow {
  return {
    id: "ev-1",
    organization_id: ORG,
    event_type: "lgpd.redact_received",
    entity_kind: "lgpd_request",
    entity_id: PEDIDO,
    payload: { request_id: PEDIDO, scope: "tenant", emergency: true },
    metadata: {},
    consumed_by: [],
    attempts: 0,
  };
}

function montaBanco(contatos: Linha[], payloadDoPedido: Record<string, unknown> = {}): void {
  banco = criarBancoEmMemoria({
    contacts: contatos,
    organizations: [{ id: ORG, status: "active", redacted_at: null }],
    lgpd_requests: [
      {
        id: PEDIDO,
        organization_id: ORG,
        request_type: "store_redact",
        scope: "tenant",
        status: "received",
        attempts: 0,
        contact_id: null,
        external_customer_id: null,
        request_payload: payloadDoPedido,
      },
    ],
  });
}

beforeEach(() => {
  falhaEm = new Set();
  ordemDeAnonimizacao = [];
});

describe("D-140: apagar a loja não apaga a organização", () => {
  it("só anonimiza contato de origem nuvemshop; WhatsApp, Instagram e manual ficam intactos", async () => {
    montaBanco([
      contato(1, "nuvemshop"),
      contato(2, "whatsapp"),
      contato(3, "instagram"),
      contato(4, "manual"),
      contato(5, "nuvemshop"),
    ]);

    const r = await processLgpdRedact(evento());

    expect(r.status).toBe("ok");
    expect(ordemDeAnonimizacao).toEqual([idDoContato(1), idDoContato(5)]);
    const intactos = banco.tabelas["contacts"]!.filter((c) => c["source"] !== "nuvemshop");
    expect(intactos).toHaveLength(3);
    expect(intactos.every((c) => c["is_anonymized"] === false)).toBe(true);
  });

  it("a organização continua ativa: status e redacted_at não mudam", async () => {
    montaBanco([contato(1, "nuvemshop"), contato(2, "whatsapp")]);

    await processLgpdRedact(evento());

    const org = banco.tabelas["organizations"]![0]!;
    expect(org["status"]).toBe("active");
    expect(org["redacted_at"]).toBeNull();
    const pedido = banco.tabelas["lgpd_requests"]![0]!;
    expect(pedido["status"]).toBe("completed");
    expect((pedido["result"] as Record<string, unknown>)["organization_status"]).toBe("unchanged");
  });
});

describe("D-141: a exclusão da loja alcança todos os contatos, não só metade", () => {
  it("250 contatos da loja: os 250 são anonimizados (o offset antigo pulava 101 a 200)", async () => {
    montaBanco(Array.from({ length: 250 }, (_, i) => contato(i + 1, "nuvemshop")));

    const r = await processLgpdRedact(evento());

    expect(r.status).toBe("ok");
    expect(ordemDeAnonimizacao).toHaveLength(250);
    expect(banco.tabelas["contacts"]!.every((c) => c["is_anonymized"] === true)).toBe(true);
    const pedido = banco.tabelas["lgpd_requests"]![0]!;
    expect(pedido["status"]).toBe("completed");
    expect((pedido["result"] as Record<string, unknown>)["processed"]).toBe(250);
  });

  it("contato que falha vai a failed_contacts, o laço segue e o pedido não fecha como concluído", async () => {
    montaBanco(Array.from({ length: 120 }, (_, i) => contato(i + 1, "nuvemshop")));
    falhaEm = new Set([idDoContato(7), idDoContato(110)]);

    const r = await processLgpdRedact(evento());

    expect(r.status).toBe("error");
    expect(ordemDeAnonimizacao).toHaveLength(118);
    const pedido = banco.tabelas["lgpd_requests"]![0]!;
    expect(pedido["status"]).toBe("pending_review");
    const progresso = (pedido["request_payload"] as Record<string, unknown>)["progress"] as Record<string, unknown>;
    expect(progresso["failed_contacts"]).toEqual([idDoContato(7), idDoContato(110)]);
  });

  it("retomada: o ponto gravado é a chave do último contato, não um offset", async () => {
    // Pedido que caiu depois de anonimizar os 100 primeiros: a retentativa lê o
    // ponto de retomada e termina os 50 restantes sem refazer nenhum.
    const contatos = Array.from({ length: 150 }, (_, i) => contato(i + 1, "nuvemshop"));
    for (const c of contatos.slice(0, 100)) c["is_anonymized"] = true;
    montaBanco(contatos, {
      progress: { processed: 100, last_id: idDoContato(100), failed_contacts: [] },
    });

    await processLgpdRedact(evento());

    expect(ordemDeAnonimizacao).toHaveLength(50);
    expect(ordemDeAnonimizacao[0]).toBe(idDoContato(101));
    expect(banco.tabelas["contacts"]!.every((c) => c["is_anonymized"] === true)).toBe(true);
  });
});
