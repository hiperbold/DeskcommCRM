/**
 * Captação pública `POST /api/v1/webhooks/in/[token]` (D-109).
 *
 * O token está no HTML da landing, então é público:
 *  1. só havia balde por token (60/min): quem o conhece criava até 86 mil leads por
 *     dia sozinho. Agora há também balde por IP, que não toca nos outros visitantes;
 *  2. `req.text()` lia o corpo inteiro. Agora há teto de 64 KB, pelo Content-Length e
 *     pelo fluxo real;
 *  3. a forma Respondi (pública, qualquer um a imita) liberava o contato para a IA
 *     sem assinatura. Agora só autoriza a fonte que prova a origem (segredo + HMAC
 *     conferido); o lead e o contato entram do mesmo jeito.
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { criarBancoEmMemoria, type BancoEmMemoria } from "../helpers/banco-em-memoria";

const ORG = "22222222-2222-4222-8222-222222222222";
const TOKEN = "token-publico-da-landing";
const SEGREDO = "segredo-da-fonte-com-mais-de-16";

let banco: BancoEmMemoria;
let segredoDaFonte: string | null;
const baldes = new Map<string, number>();
const autorizacoes: unknown[] = [];

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => banco }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
// Balde de janela fixa com a mesma semântica: conta por chave e recusa acima do limite.
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({
  checkRateLimit: vi.fn(async (chave: string, limite: number) => {
    const n = (baldes.get(chave) ?? 0) + 1;
    baldes.set(chave, n);
    return { allowed: n <= limite };
  }),
}));
vi.mock("@/lib/webhooks/secrets", () => ({ decryptWebhookSecret: vi.fn(async () => segredoDaFonte) }));
vi.mock("@/lib/webhooks/captacao", () => ({
  origemDaPagina: () => null,
  registrarCaptacao: vi.fn(async () => undefined),
}));
vi.mock("@/lib/channels/contato-por-telefone", () => ({
  encontrarContatoPorTelefoneComNome: vi.fn(async () => ({ id: "contato-1", name: "Maria" })),
}));
vi.mock("@/app/api/v1/leads/_handler", () => ({
  createLeadHandler: vi.fn(async () => ({ id: "lead-1" })),
}));
vi.mock("@/lib/leads/activity-emitter", () => ({ emitLeadActivity: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/leads/aviso-limite-de-leads", () => ({ avisarLimiteDeLeadsAtingido: vi.fn(async () => undefined) }));
vi.mock("@/lib/dev/kick-local-pipeline", () => ({ kickLocalPipeline: vi.fn(async () => undefined) }));
vi.mock("@/lib/ai/elegibilidade/autorizacao", () => ({
  autorizarContatoParaIA: vi.fn(async (_a: unknown, args: unknown) => {
    autorizacoes.push(args);
  }),
}));

import { POST } from "@/app/api/v1/webhooks/in/[token]/route";

const RESPONDI = readFileSync("tests/fixtures/webhooks/respondi-imobiliario.json", "utf8");

function chamar(opts: { corpo?: string; ip?: string; assinar?: boolean; token?: string; extra?: Record<string, string> } = {}) {
  const corpo = opts.corpo ?? RESPONDI;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-forwarded-for": opts.ip ?? "203.0.113.7",
    ...(opts.extra ?? {}),
  };
  if (opts.assinar) {
    headers["x-deskcomm-signature"] = createHmac("sha256", SEGREDO).update(corpo).digest("hex");
  }
  const req = new NextRequest(`http://localhost/api/v1/webhooks/in/${opts.token ?? TOKEN}`, {
    method: "POST",
    headers,
    body: corpo,
  });
  return POST(req, { params: Promise.resolve({ token: opts.token ?? TOKEN }) });
}

beforeEach(() => {
  baldes.clear();
  autorizacoes.length = 0;
  segredoDaFonte = null;
  banco = criarBancoEmMemoria({
    webhook_sources: [
      {
        id: "fonte-1",
        name: "Landing",
        organization_id: ORG,
        path_token: TOKEN,
        secret_encrypted: null,
        default_pipeline_id: "p1",
        default_stage_id: "e1",
        field_map: {},
        redirect_to: null,
        is_active: true,
      },
    ],
    webhook_events_log: [],
    crm_leads: [],
    contacts: [{ id: "contato-1", organization_id: ORG, name: "Maria" }],
  });
});

describe("D-109: limite por IP", () => {
  it("o 11º envio do mesmo IP no minuto é 429; outro IP segue passando", async () => {
    // Token inexistente: a rota recusa depois do portão de limite, sem precisar de lead.
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await chamar({ token: "token-que-nao-existe", ip: "198.51.100.1" })).status);
    const outroIp = await chamar({ token: "token-que-nao-existe", ip: "198.51.100.2" });

    expect(statuses.slice(0, 10).every((s) => s === 404)).toBe(true);
    expect(statuses[10]).toBe(429);
    expect(outroIp.status).toBe(404);
  });

  it("o teto por hora também vale (60 por IP)", async () => {
    const statuses: number[] = [];
    // Troca a chave por minuto a cada envio para isolar o balde da hora.
    for (let i = 0; i < 61; i++) {
      for (const k of [...baldes.keys()]) if (k.startsWith("webhook_in_ip:")) baldes.delete(k);
      statuses.push((await chamar({ token: "token-que-nao-existe", ip: "198.51.100.9" })).status);
    }
    expect(statuses.slice(0, 60).every((s) => s === 404)).toBe(true);
    expect(statuses[60]).toBe(429);
  });
});

describe("D-109: teto de corpo de 64 KB", () => {
  it("Content-Length acima do teto é 413 sem ler o corpo nem gravar nada", async () => {
    const r = await chamar({ corpo: "{}", extra: { "content-length": String(70 * 1024) } });

    expect(r.status).toBe(413);
    expect(banco.tabelas["webhook_events_log"]).toHaveLength(0);
  });

  it("corpo real acima do teto sem Content-Length também é 413", async () => {
    const grande = JSON.stringify({ nome: "Ana", telefone: "11999990000", lixo: "x".repeat(70 * 1024) });

    const r = await chamar({ corpo: grande });

    expect(r.status).toBe(413);
    expect(banco.tabelas["webhook_events_log"]).toHaveLength(0);
  });

  it("corpo normal passa (par positivo)", async () => {
    const r = await chamar({ corpo: JSON.stringify({ nome: "Ana", telefone: "11999990000" }) });

    expect(r.status).toBe(200);
    expect(banco.tabelas["webhook_events_log"]).toHaveLength(1);
  });
});

describe("D-109: a forma Respondi só autoriza a IA com a origem provada", () => {
  it("fonte SEM segredo: o lead entra, o contato NÃO é liberado para a IA", async () => {
    const r = await chamar();

    expect(r.status).toBe(200);
    expect(autorizacoes).toHaveLength(0);
  });

  it("fonte com segredo e assinatura conferida: libera (par positivo)", async () => {
    segredoDaFonte = SEGREDO;
    banco.tabelas["webhook_sources"]![0]!["secret_encrypted"] = "cifrado";

    const r = await chamar({ assinar: true });

    expect(r.status).toBe(200);
    expect(autorizacoes).toHaveLength(1);
    expect(autorizacoes[0]).toMatchObject({ organizationId: ORG, contactId: "contato-1" });
  });

  it("fonte com segredo e assinatura errada: 401, nada entra", async () => {
    segredoDaFonte = SEGREDO;
    banco.tabelas["webhook_sources"]![0]!["secret_encrypted"] = "cifrado";

    const r = await chamar({ extra: { "x-deskcomm-signature": "00".repeat(32) } });

    expect(r.status).toBe(401);
    expect(autorizacoes).toHaveLength(0);
  });
});
