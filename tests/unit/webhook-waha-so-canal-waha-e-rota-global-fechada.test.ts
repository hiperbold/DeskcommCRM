/**
 * Webhooks do WAHA: só canal WAHA (D-144) e rota global fechada (D-108).
 *
 * D-144: `POST /api/v1/webhooks/waha/[token]` achava a sessão só por
 * `webhook_path_token`. O token de um canal UAZAPI, Zernio ou Datafy passava a
 * injetar mensagem pelo formato WAHA, sem a assinatura que a rota do próprio canal
 * exige. Agora só sessão `provider = waha` responde.
 *
 * D-108: `POST /api/v1/webhooks/waha` (sem token, sessão pelo nome no corpo) só era
 * protegida pelo Caddyfile do kit, que não existe atrás de outro proxy, e a resposta
 * `session_not_registered` servia de oráculo. Agora responde 410 enquanto
 * `WAHA_GLOBAL_WEBHOOK_ENABLED` não for "true".
 *
 * O banco é em memória com a semântica real de filtro: o 404 só aparece se a consulta
 * de fato filtra por `provider`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { criarBancoEmMemoria, type BancoEmMemoria } from "../helpers/banco-em-memoria";

const { envMock, despachados } = vi.hoisted(() => ({
  envMock: { WAHA_GLOBAL_WEBHOOK_ENABLED: "false" as string },
  despachados: [] as string[],
}));

let banco: BancoEmMemoria;

vi.mock("@/lib/env", () => ({ env: envMock }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => banco }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/instalacao/comportamento-servidor", () => ({
  carregarComportamentoDaInstalacao: vi.fn(async () => undefined),
}));
vi.mock("@/lib/channels/archived", () => ({
  ARCHIVED_AT: "archived_at",
  queryTolerantToMissingArchived: async (primeira: () => unknown) => primeira(),
}));
vi.mock("@/lib/waha/webhook-auth", () => ({
  authenticateWahaWebhook: () => ({ ok: true, signatureVerified: false }),
}));
vi.mock("@/lib/waha/desfecho-do-webhook", () => ({
  REENTREGA_EM_SEGUNDOS: 5,
  processarEventoWaha: vi.fn(async (_a: unknown, sessao: { id: string }) => {
    despachados.push(sessao.id);
    return "ok";
  }),
}));

import { POST as postGlobal } from "@/app/api/v1/webhooks/waha/route";
import { POST as postPorToken } from "@/app/api/v1/webhooks/waha/[token]/route";

const CORPO = { event: "message", session: "default", payload: { id: "wamid.X", from: "5511999990000@c.us", body: "oi" } };

function pedido() {
  return {
    text: async () => JSON.stringify(CORPO),
    headers: new Headers(),
  } as never;
}

beforeEach(() => {
  envMock.WAHA_GLOBAL_WEBHOOK_ENABLED = "false";
  despachados.length = 0;
  const sessao = (id: string, provider: string, token: string, nome: string) => ({
    id,
    organization_id: "org-1",
    waha_session_name: nome,
    webhook_path_token: token,
    webhook_secret_encrypted: "\\x00",
    status: "WORKING",
    is_warmup_complete: true,
    warmup_started_at: null,
    archived_at: null,
    provider,
  });
  banco = criarBancoEmMemoria(
    {
      channel_sessions: [
        sessao("s-waha", "waha", "token-do-canal-waha", "default"),
        sessao("s-uazapi", "uazapi", "token-do-canal-uazapi", "uazapi-sessao"),
      ],
      webhook_events_log: [],
    },
    { rpc: { fn_decrypt_oauth: () => ({ data: "segredo-decifrado-bem-longo" }) } },
  );
});

describe("D-144: rota por token só atende canal WAHA", () => {
  it("o token de um canal UAZAPI é 404 e nada é ingerido nem arquivado", async () => {
    const r = await postPorToken(pedido(), { params: Promise.resolve({ token: "token-do-canal-uazapi" }) });

    expect(r.status).toBe(404);
    expect(despachados).toHaveLength(0);
    expect(banco.tabelas["webhook_events_log"]).toHaveLength(0);
  });

  it("o token de um canal WAHA continua ingerindo (par positivo)", async () => {
    const r = await postPorToken(pedido(), { params: Promise.resolve({ token: "token-do-canal-waha" }) });

    expect(r.status).toBe(200);
    expect(despachados).toEqual(["s-waha"]);
  });
});

describe("D-108: rota global fechada por padrão", () => {
  it("sem a chave ligada responde 410, sem consultar sessão nem ingerir", async () => {
    const r = await postGlobal(pedido());

    expect(r.status).toBe(410);
    expect(despachados).toHaveLength(0);
    expect(banco.tabelas["webhook_events_log"]).toHaveLength(0);
  });

  it("o nome de sessão registrado e o inexistente não se distinguem (sem oráculo)", async () => {
    const registrada = await postGlobal(pedido());
    const corpoOutro = { ...CORPO, session: "nao-existe" };
    const inexistente = await postGlobal({
      text: async () => JSON.stringify(corpoOutro),
      headers: new Headers(),
    } as never);

    expect(registrada.status).toBe(inexistente.status);
    expect(await registrada.json()).toEqual(await inexistente.json());
  });

  it("ligada, a rota global ingere só sessão WAHA pelo nome (um canal UAZAPI não casa)", async () => {
    envMock.WAHA_GLOBAL_WEBHOOK_ENABLED = "true";

    const waha = await postGlobal(pedido());
    const uazapi = await postGlobal({
      text: async () => JSON.stringify({ ...CORPO, session: "uazapi-sessao" }),
      headers: new Headers(),
    } as never);

    expect(waha.status).toBe(200);
    expect(despachados).toEqual(["s-waha"]);
    expect(await uazapi.json()).toMatchObject({ data: { accepted: false, reason: "session_not_registered" } });
  });
});
