/**
 * Canais restantes (D-130): `failed` é final, carimbo de entrega vale o primeiro, e
 * dois números da mesma organização não engolem a mensagem um do outro.
 *
 *  A) Meta oficial: um `sent`/`delivered` atrasado não devolve `failed` a `sent`, e a
 *     reentrega de `delivered` não reescreve `delivered_at`.
 *  B) Datafy: o mesmo guarda do `failed` e o corpo assinado velho (replay) é recusado.
 *  C) UAZAPI: A manda para B na mesma organização, a chave (organization_id,
 *     external_id) bate no segundo lado, que virava `duplicate` e sumia. Agora o
 *     segundo lado grava, e a reentrega de cada lado segue sendo `duplicate`.
 *
 * O banco é em memória com a semântica real de filtro, inclusive o unique.
 */
import { createHmac } from "node:crypto";

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { criarBancoEmMemoria, type BancoEmMemoria } from "../helpers/banco-em-memoria";

const ORG = "org-1";
const SESSAO_A = "sess-A";
const SESSAO_B = "sess-B";

let banco: BancoEmMemoria;
let seq = 0;

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => banco }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/channels/meta/app", () => ({ appDaMeta: async () => ({ appSecret: "segredo-do-app", verifyToken: "v" }) }));
vi.mock("@/lib/channels/meta/session", () => ({
  metaSessionByWebhookToken: async () => ({ id: SESSAO_A, organizationId: ORG, wabaId: null }),
}));
vi.mock("@/lib/messaging/falha-de-entrega", () => ({
  emitirFalhaDeEntrega: vi.fn(async () => undefined),
  telefoneDoEmbed: () => null,
}));
vi.mock("@/lib/channels/graph-parceiro/session", () => ({
  graphPartnerRefsDaSessao: vi.fn(async () => ({ phoneNumberId: "PN", wabaId: "WABA" })),
}));
vi.mock("@/lib/channels/pos-entrada", () => ({ aplicarEfeitosPosEntrada: vi.fn(async () => undefined) }));
vi.mock("@/lib/escalacao/atendimento-manual", () => ({ pausarIaPorAtendimentoManual: vi.fn(async () => undefined) }));
vi.mock("@/lib/channels/marcar-conversa", () => ({ marcarConversaComMensagem: vi.fn(async () => undefined) }));
vi.mock("@/lib/channels/contato-por-telefone", () => ({ encontrarContatoPorTelefone: async () => null }));

import { POST as postMeta } from "@/app/api/v1/webhooks/meta/[token]/route";
import { CHANNEL_PROVIDER_DATAFY } from "@/lib/channels/capabilities";
import { handleInboundWebhook } from "@/lib/channels/inbound";
import { ingestUazapiMensagem } from "@/lib/channels/uazapi/ingest";
import type { UazapiMensagemLida } from "@/lib/channels/uazapi/webhook";

function novoBanco(mensagens: Array<Record<string, unknown>> = []): BancoEmMemoria {
  const b: BancoEmMemoria = criarBancoEmMemoria(
    { messages: mensagens },
    {
      rpc: {
        fn_upsert_wa_contact: () => ({ data: "contato-1" }),
        fn_upsert_wa_conversation: (args) => ({ data: `conv-${String(args["p_session"])}` }),
      },
      aoEscrever: {
        messages: (modo, linhas) => {
          if (modo !== "insert") return null;
          for (const l of linhas) {
            const repetida = b.tabelas["messages"]!.some(
              (m) => m["organization_id"] === l["organization_id"] && m["external_id"] === l["external_id"],
            );
            if (repetida) return { code: "23505", message: "duplicate key value violates unique constraint" };
            l["id"] = `msg-${++seq}`;
          }
          return null;
        },
      },
    },
  );
  return b;
}

function linha(externalId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: `m-${externalId}`, organization_id: ORG, external_id: externalId, status: "sent", delivered_at: null, read_at: null, ...extra };
}

beforeEach(() => {
  seq = 0;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

// ─── A) Meta oficial ──────────────────────────────────────────────────────

function statusMeta(id: string, status: string): Promise<Response> {
  const corpo = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA",
        changes: [{ field: "messages", value: { metadata: { phone_number_id: "PN" }, statuses: [{ id, status, recipient_id: "5531999998888" }] } }],
      },
    ],
  });
  const assinatura = "sha256=" + createHmac("sha256", "segredo-do-app").update(corpo, "utf8").digest("hex");
  const req = new NextRequest("http://localhost/api/v1/webhooks/meta/token-da-sessao", {
    method: "POST",
    headers: { "x-hub-signature-256": assinatura, "content-type": "application/json" },
    body: corpo,
  });
  return postMeta(req, { params: Promise.resolve({ token: "token-da-sessao" }) }) as Promise<Response>;
}

describe("D-130 A: webhook de status da Meta", () => {
  it("`sent` atrasado não devolve uma mensagem `failed` a `sent`", async () => {
    banco = novoBanco([linha("wamid.F", { status: "failed", error_code: "131047" })]);

    const r = await statusMeta("wamid.F", "sent");

    expect(r.status).toBe(200);
    expect(banco.tabelas["messages"]![0]!["status"]).toBe("failed");
  });

  it("`delivered` atrasado numa mensagem `failed` também não a altera nem carimba entrega", async () => {
    banco = novoBanco([linha("wamid.F", { status: "failed" })]);

    await statusMeta("wamid.F", "delivered");

    expect(banco.tabelas["messages"]![0]).toMatchObject({ status: "failed", delivered_at: null });
  });

  it("par positivo: `delivered` numa mensagem `sent` carimba a entrega", async () => {
    banco = novoBanco([linha("wamid.OK")]);

    await statusMeta("wamid.OK", "delivered");

    const m = banco.tabelas["messages"]![0]!;
    expect(m["status"]).toBe("sent");
    expect(m["delivered_at"]).toEqual(expect.any(String));
  });

  it("a reentrega de `delivered` NÃO reescreve delivered_at (vale o primeiro)", async () => {
    banco = novoBanco([linha("wamid.OK", { delivered_at: "2026-09-30T10:00:00.000Z" })]);

    await statusMeta("wamid.OK", "delivered");
    await statusMeta("wamid.OK", "read");
    const depoisDoRead = { ...banco.tabelas["messages"]![0]! };
    await statusMeta("wamid.OK", "read");

    expect(depoisDoRead["delivered_at"]).toBe("2026-09-30T10:00:00.000Z");
    expect(depoisDoRead["read_at"]).toEqual(expect.any(String));
    // E a segunda leitura também não mexe no carimbo da primeira.
    expect(banco.tabelas["messages"]![0]!["read_at"]).toBe(depoisDoRead["read_at"]);
  });
});

// ─── B) Datafy ────────────────────────────────────────────────────────────

const SEGREDO_DATAFY = "whsec_segredo_do_painel_123";
const TS = "1700000000";
const sessaoDatafy = { id: SESSAO_A, organization_id: ORG, provider: CHANNEL_PROVIDER_DATAFY } as never;

function statusDatafy(id: string, status: string): { corpo: string; headers: Headers } {
  const corpo = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      { id: "WABA", changes: [{ field: "messages", value: { metadata: { phone_number_id: "PN" }, statuses: [{ id, status }] } }] },
    ],
  });
  const sig = createHmac("sha256", SEGREDO_DATAFY).update(`${TS}.${corpo}`, "utf8").digest("hex");
  return { corpo, headers: new Headers({ "x-datafy-signature-256": `sha256=${sig}`, "x-datafy-timestamp": TS }) };
}

describe("D-130 B: canal Datafy", () => {
  beforeEach(() => {
    vi.stubEnv("DATAFY_ENABLED", "true");
  });

  it("`sent` atrasado não devolve `failed` a `sent`", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Number(TS) * 1000));
    banco = novoBanco([linha("wamid.F", { status: "failed" }), linha("wamid.OK", { status: "queued" })]);

    const f = statusDatafy("wamid.F", "sent");
    const ok = await handleInboundWebhook(banco as never, { session: sessaoDatafy, rawBody: f.corpo, headers: f.headers, secret: SEGREDO_DATAFY });
    const g = statusDatafy("wamid.OK", "sent");
    await handleInboundWebhook(banco as never, { session: sessaoDatafy, rawBody: g.corpo, headers: g.headers, secret: SEGREDO_DATAFY });

    expect(ok).toMatchObject({ ok: true });
    const por = Object.fromEntries(banco.tabelas["messages"]!.map((m) => [m["external_id"], m["status"]]));
    expect(por["wamid.F"]).toBe("failed");
    expect(por["wamid.OK"]).toBe("sent");
  });

  it("corpo assinado reenviado fora da janela de 5 minutos é recusado (replay)", async () => {
    // Sem o relógio falso: o carimbo é de 2023.
    banco = novoBanco([linha("wamid.F", { status: "failed" })]);
    const s = statusDatafy("wamid.F", "sent");

    const r = await handleInboundWebhook(banco as never, { session: sessaoDatafy, rawBody: s.corpo, headers: s.headers, secret: SEGREDO_DATAFY });

    expect(r).toMatchObject({ ok: false, code: "unauthorized" });
  });
});

// ─── C) UAZAPI: dois números da mesma organização ─────────────────────────

const mensagem = (direction: "inbound" | "outbound"): UazapiMensagemLida => ({
  direction,
  viaApi: false,
  externalId: "3EB0SAMEORG1",
  chatId: "553591234567@s.whatsapp.net",
  phone: "+553591234567",
  lid: null,
  displayName: "Numero B",
  text: "oi do numero A",
  tipo: "text",
  mime: null,
  sentAt: "2026-09-15T12:00:00.000Z",
  quotedExternalId: null,
});

describe("D-130 C: UAZAPI, A manda para B na mesma organização", () => {
  it("o lado que chega depois grava (não vira `duplicate`) e cada reentrega segue deduplicada", async () => {
    banco = novoBanco();

    const saidaDeA = await ingestUazapiMensagem(banco as never, { organizationId: ORG, channelSessionId: SESSAO_A, msg: mensagem("outbound") });
    const entradaEmB = await ingestUazapiMensagem(banco as never, { organizationId: ORG, channelSessionId: SESSAO_B, msg: mensagem("inbound") });

    expect(saidaDeA.status).toBe("ingested");
    expect(entradaEmB.status).toBe("ingested");
    const linhas = banco.tabelas["messages"]!;
    expect(linhas).toHaveLength(2);
    expect(linhas.map((l) => [l["channel_session_id"], l["direction"]])).toEqual([
      [SESSAO_A, "outbound"],
      [SESSAO_B, "inbound"],
    ]);

    // Reentrega de cada lado: duplicate, sem terceira linha.
    const reA = await ingestUazapiMensagem(banco as never, { organizationId: ORG, channelSessionId: SESSAO_A, msg: mensagem("outbound") });
    const reB = await ingestUazapiMensagem(banco as never, { organizationId: ORG, channelSessionId: SESSAO_B, msg: mensagem("inbound") });
    expect(reA.status).toBe("duplicate");
    expect(reB.status).toBe("duplicate");
    expect(banco.tabelas["messages"]).toHaveLength(2);
  });

  it("a ordem inversa (entrada de B antes da saída de A) também grava os dois lados", async () => {
    banco = novoBanco();

    const entradaEmB = await ingestUazapiMensagem(banco as never, { organizationId: ORG, channelSessionId: SESSAO_B, msg: mensagem("inbound") });
    const saidaDeA = await ingestUazapiMensagem(banco as never, { organizationId: ORG, channelSessionId: SESSAO_A, msg: mensagem("outbound") });

    expect([entradaEmB.status, saidaDeA.status]).toEqual(["ingested", "ingested"]);
    expect(banco.tabelas["messages"]).toHaveLength(2);
  });

  it("reentrega na MESMA conexão continua `duplicate` (o caso de sempre)", async () => {
    banco = novoBanco();

    await ingestUazapiMensagem(banco as never, { organizationId: ORG, channelSessionId: SESSAO_B, msg: mensagem("inbound") });
    const de_novo = await ingestUazapiMensagem(banco as never, { organizationId: ORG, channelSessionId: SESSAO_B, msg: mensagem("inbound") });

    expect(de_novo.status).toBe("duplicate");
    expect(banco.tabelas["messages"]).toHaveLength(1);
  });
});
