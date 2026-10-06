/**
 * Turnstile na captação pública `POST /api/v1/webhooks/in/[token]` (D-173).
 *
 * Esta rota não passa pelo GoTrue: quem confere o token é o servidor, no `siteverify`
 * da Cloudflare. Só o `fetch` para a Cloudflare é simulado; o resto do caminho (rota,
 * verificação, registro da recusa) roda de verdade.
 *
 * Chaves de TESTE oficiais da Cloudflare: a secreta `1x…AA` sempre passa e a `2x…AA`
 * sempre falha; nenhuma chave real entra aqui.
 */
import { createHmac } from "node:crypto";

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { criarBancoEmMemoria, type BancoEmMemoria } from "../helpers/banco-em-memoria";

const ORG = "22222222-2222-4222-8222-222222222222";
const TOKEN = "token-publico-da-landing";
const SEGREDO_HMAC = "segredo-da-fonte-com-mais-de-16";
const SECRETA_QUE_PASSA = "1x0000000000000000000000000000000AA";
const SECRETA_QUE_FALHA = "2x0000000000000000000000000000000AA";

let banco: BancoEmMemoria;
let segredoDaFonte: string | null;
const baldes = new Map<string, number>();
const registros: Array<Record<string, unknown>> = [];
const leadsCriados: unknown[] = [];

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => banco }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({
  checkRateLimit: vi.fn(async (chave: string, limite: number) => {
    const n = (baldes.get(chave) ?? 0) + 1;
    baldes.set(chave, n);
    return { allowed: n <= limite };
  }),
}));
vi.mock("@/lib/webhooks/secrets", () => ({ decryptWebhookSecret: vi.fn(async () => segredoDaFonte) }));
vi.mock("@/lib/webhooks/captacao", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  registrarCaptacao: vi.fn(async (_admin: unknown, captacao: Record<string, unknown>) => {
    registros.push(captacao);
  }),
}));
vi.mock("@/lib/channels/contato-por-telefone", () => ({
  encontrarContatoPorTelefoneComNome: vi.fn(async () => ({ id: "contato-1", name: "Maria" })),
}));
vi.mock("@/app/api/v1/leads/_handler", () => ({
  createLeadHandler: vi.fn(async (_ctx: unknown, input: unknown) => {
    leadsCriados.push(input);
    return { id: "lead-1" };
  }),
}));
vi.mock("@/lib/leads/activity-emitter", () => ({ emitLeadActivity: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/leads/aviso-limite-de-leads", () => ({ avisarLimiteDeLeadsAtingido: vi.fn(async () => undefined) }));
vi.mock("@/lib/dev/kick-local-pipeline", () => ({ kickLocalPipeline: vi.fn(async () => undefined) }));
vi.mock("@/lib/ai/elegibilidade/autorizacao", () => ({ autorizarContatoParaIA: vi.fn(async () => undefined) }));

import { POST } from "@/app/api/v1/webhooks/in/[token]/route";
import { logger } from "@/lib/logger";
import { reiniciarAvisoDoTurnstile } from "@/lib/security/turnstile";

const siteverify = vi.fn();

function resposta(corpo: unknown, status = 200) {
  return new Response(JSON.stringify(corpo), { status, headers: { "content-type": "application/json" } });
}

function chamar(
  opts: {
    campos?: Record<string, string>;
    formulario?: boolean;
    assinar?: boolean;
    headers?: Record<string, string>;
  } = {},
) {
  const campos = { nome: "Ana", telefone: "11999990000", ...(opts.campos ?? {}) };
  const corpo = opts.formulario ? new URLSearchParams(campos).toString() : JSON.stringify(campos);
  const headers: Record<string, string> = {
    "content-type": opts.formulario ? "application/x-www-form-urlencoded" : "application/json",
    "x-forwarded-for": "203.0.113.7",
    ...(opts.headers ?? {}),
  };
  if (opts.assinar) {
    headers["x-deskcomm-signature"] = createHmac("sha256", SEGREDO_HMAC).update(corpo).digest("hex");
  }
  const req = new NextRequest(`http://localhost/api/v1/webhooks/in/${TOKEN}`, {
    method: "POST",
    headers,
    body: corpo,
  });
  return POST(req, { params: Promise.resolve({ token: TOKEN }) });
}

beforeEach(() => {
  baldes.clear();
  registros.length = 0;
  leadsCriados.length = 0;
  segredoDaFonte = null;
  siteverify.mockReset();
  vi.mocked(logger.warn).mockClear();
  reiniciarAvisoDoTurnstile();
  vi.stubGlobal("fetch", siteverify);
  vi.stubEnv("TURNSTILE_SECRET_KEY", SECRETA_QUE_PASSA);
  vi.stubEnv("TURNSTILE_CAPTACAO_EXIGIR", "1");
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

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("captação pública com o Turnstile exigido", () => {
  it("sem token: 400 amigável, a Cloudflare nem é consultada, nenhum lead entra e a recusa fica no histórico", async () => {
    const r = await chamar();
    const corpo = await r.json();

    expect(r.status).toBe(400);
    expect(corpo.error.code).toBe("captcha_failed");
    expect(corpo.error.message).toContain("verificação de segurança");
    expect(siteverify).not.toHaveBeenCalled();
    expect(leadsCriados).toHaveLength(0);
    expect(banco.tabelas["webhook_events_log"]).toHaveLength(0);
    expect(registros).toHaveLength(1);
    expect(registros[0]).toMatchObject({ outcome: "recusado", rejectReason: "verificacao_de_seguranca" });
  });

  it("token válido: o lead entra, o siteverify recebe segredo, token e IP, e o token não vira dado do lead", async () => {
    siteverify.mockResolvedValue(resposta({ success: true }));

    const r = await chamar({ campos: { "cf-turnstile-response": "token-do-widget" } });

    expect(r.status).toBe(200);
    expect(siteverify).toHaveBeenCalledTimes(1);
    const [url, init] = siteverify.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
    const enviado = new URLSearchParams(String(init.body));
    expect(enviado.get("secret")).toBe(SECRETA_QUE_PASSA);
    expect(enviado.get("response")).toBe("token-do-widget");
    expect(enviado.get("remoteip")).toBe("203.0.113.7");

    expect(leadsCriados).toHaveLength(1);
    expect(JSON.stringify(leadsCriados[0])).not.toContain("cf-turnstile-response");
    const log = banco.tabelas["webhook_events_log"]![0] as { payload_parsed: Record<string, unknown> };
    expect(log.payload_parsed).not.toHaveProperty("cf-turnstile-response");
  });

  it("formulário HTML: o campo que o widget injeta é lido do corpo urlencoded", async () => {
    siteverify.mockResolvedValue(resposta({ success: true }));

    const r = await chamar({ formulario: true, campos: { "cf-turnstile-response": "token-do-form" } });

    expect(r.status).toBe(200);
    expect(new URLSearchParams(String((siteverify.mock.calls[0] as [string, RequestInit])[1].body)).get("response")).toBe(
      "token-do-form",
    );
  });

  it("envio por fetch com o token no cabeçalho x-turnstile-token também vale", async () => {
    siteverify.mockResolvedValue(resposta({ success: true }));

    const r = await chamar({ headers: { "x-turnstile-token": "token-do-cabecalho" } });

    expect(r.status).toBe(200);
    expect(new URLSearchParams(String((siteverify.mock.calls[0] as [string, RequestInit])[1].body)).get("response")).toBe(
      "token-do-cabecalho",
    );
  });

  it("token recusado pela Cloudflare: 400 e nenhum lead", async () => {
    siteverify.mockResolvedValue(resposta({ success: false, "error-codes": ["invalid-input-response"] }));

    const r = await chamar({ campos: { "cf-turnstile-response": "token-falso" } });

    expect(r.status).toBe(400);
    expect((await r.json()).error.code).toBe("captcha_failed");
    expect(leadsCriados).toHaveLength(0);
    expect(registros[0]).toMatchObject({ rejectReason: "verificacao_de_seguranca" });
  });

  it("segredo de teste que sempre falha: recusa mesmo com um token qualquer", async () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", SECRETA_QUE_FALHA);
    // Resposta que a Cloudflare dá para a secreta `2x…AA`.
    siteverify.mockImplementation(async (_url: string, init: RequestInit) => {
      const secret = new URLSearchParams(String(init.body)).get("secret");
      return resposta({ success: secret !== SECRETA_QUE_FALHA });
    });

    const r = await chamar({ campos: { "cf-turnstile-response": "qualquer" } });

    expect(r.status).toBe(400);
  });

  it("erro de rede com a Cloudflare: recusa (falha fechado) com 503 e Retry-After, e nenhum lead entra", async () => {
    siteverify.mockRejectedValue(new TypeError("fetch failed"));

    const r = await chamar({ campos: { "cf-turnstile-response": "token-do-widget" } });
    const corpo = await r.json();

    expect(r.status).toBe(503);
    expect(r.headers.get("retry-after")).toBe("30");
    expect(corpo.error.code).toBe("captcha_unavailable");
    expect(leadsCriados).toHaveLength(0);
  });

  it("Cloudflare respondendo 500: também recusa com 503", async () => {
    siteverify.mockResolvedValue(resposta({}, 500));

    const r = await chamar({ campos: { "cf-turnstile-response": "token-do-widget" } });

    expect(r.status).toBe(503);
    expect(leadsCriados).toHaveLength(0);
  });

  it("envio com assinatura HMAC válida é integração de servidor: passa sem token e sem consultar a Cloudflare", async () => {
    segredoDaFonte = SEGREDO_HMAC;
    banco.tabelas["webhook_sources"]![0]!["secret_encrypted"] = "cifrado";

    const r = await chamar({ assinar: true });

    expect(r.status).toBe(200);
    expect(siteverify).not.toHaveBeenCalled();
    expect(leadsCriados).toHaveLength(1);
  });

  it("assinatura errada continua sendo 401, antes de qualquer verificação do Turnstile", async () => {
    segredoDaFonte = SEGREDO_HMAC;
    banco.tabelas["webhook_sources"]![0]!["secret_encrypted"] = "cifrado";

    const r = await chamar({ headers: { "x-deskcomm-signature": "00".repeat(32) } });

    expect(r.status).toBe(401);
    expect(siteverify).not.toHaveBeenCalled();
  });
});

describe("captação pública sem o Turnstile exigido", () => {
  it("com a secreta no ambiente mas sem TURNSTILE_CAPTACAO_EXIGIR: tudo como sempre, sem token e sem consulta", async () => {
    vi.stubEnv("TURNSTILE_CAPTACAO_EXIGIR", "");

    const r = await chamar();

    expect(r.status).toBe(200);
    expect(siteverify).not.toHaveBeenCalled();
    expect(leadsCriados).toHaveLength(1);
  });

  it("o campo do widget sai do payload mesmo sem exigir (não vira campo personalizado)", async () => {
    vi.stubEnv("TURNSTILE_CAPTACAO_EXIGIR", "");

    const r = await chamar({ campos: { "cf-turnstile-response": "token-do-widget" } });

    expect(r.status).toBe(200);
    expect(JSON.stringify(leadsCriados[0])).not.toContain("cf-turnstile-response");
  });

  it("exigir ligado mas SEM a secreta: não verifica, deixa passar e avisa no log uma vez só", async () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "");

    const a = await chamar();
    const b = await chamar();

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(siteverify).not.toHaveBeenCalled();
    const avisos = vi.mocked(logger.warn).mock.calls.filter(([msg]) => String(msg).includes("TURNSTILE_SECRET_KEY"));
    expect(avisos).toHaveLength(1);
  });
});
