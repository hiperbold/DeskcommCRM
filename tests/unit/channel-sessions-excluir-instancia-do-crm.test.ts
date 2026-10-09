import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { criarBancoEmMemoria, type BancoEmMemoria, type Linha } from "../helpers/banco-em-memoria";

/**
 * DELETE genérico de canal (`/api/v1/channel-sessions/[id]`) diante da instância que o CRM CRIOU pelo
 * pareamento por QR Code (coluna `criada_pelo_crm`, migration 0953).
 *
 * O defeito: a rota apagava ou arquivava a linha com o cliente da SESSÃO do usuário e não falava com o
 * servidor de WhatsApp. A instância seguia viva e paga, sem linha que a contasse no teto de instâncias do
 * plano. Agora o gatilho do banco recusa essa escrita ao usuário (provado em
 * `tests/invariants/pareamento-qr-estado-no-banco.test.ts`) e a rota tem de passar pelo servidor: apagar a
 * instância LÁ, depois arquivar com o cliente de serviço.
 *
 * Aqui o cliente do usuário REPRODUZ a recusa do gatilho (toda escrita em linha criada pelo CRM devolve
 * 42501), o servidor de WhatsApp é um dublê de `fetch`, e o banco em memória tem a semântica de filtro do
 * PostgREST. O que se prova é o efeito: a instância foi apagada no servidor, a linha ficou arquivada e
 * NUNCA apagada, e a linha comum segue como antes.
 */

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const h = vi.hoisted(() => ({ role: vi.fn(), load: vi.fn(), org: vi.fn(), audit: vi.fn() }));

vi.mock("@/lib/env", () => ({ env: { IA_DESTINOS_INTERNOS_PERMITIDOS: "" } }));
vi.mock("@/lib/automation/outbound-url", () => ({ assertSafeOutboundUrl: () => undefined }));
vi.mock("@/lib/automation/outbound-ip", () => ({ assertDestinoResolvidoSeguro: async () => undefined }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: h.role }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: h.load,
  resolveActiveOrg: h.org,
  mfaEmDivida: async () => false,
}));
vi.mock("@/lib/waha/client", () => ({ getWahaClient: () => null, wahaFriendlyError: (m: string) => m }));
vi.mock("@/lib/channels/health", () => ({ resolverSaudeDaConexaoRemovida: async () => "sem_mudanca" }));
vi.mock("@/lib/ai/elegibilidade/pre-go-live", () => ({ metadataInicialDoCanal: () => ({}) }));
vi.mock("@/lib/webhooks/secrets", () => ({
  encryptWebhookSecret: async (_a: unknown, texto: string) => `\\xenc(${texto})`,
  decryptWebhookSecret: async (_a: unknown, cifrado: string) => /^\\xenc\((.*)\)$/.exec(cifrado)?.[1] ?? null,
}));

let banco: BancoEmMemoria;
const clientes = vi.hoisted(() => ({ usuario: null as unknown, servico: null as unknown }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => clientes.usuario }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => clientes.servico }));

import { DELETE, GET } from "@/app/api/v1/channel-sessions/[id]/route";

const ORG = "22222222-2222-4222-8222-222222222222";
const USER = "11111111-1111-4111-8111-111111111111";
const CANAL = "44444444-4444-4444-8444-444444444444";
const SERVIDOR = "https://qr.exemplo.com";
const TOKEN = "tok-da-instancia";

const linha = (extra: Linha = {}): Linha => ({
  id: CANAL,
  organization_id: ORG,
  provider: "uazapi",
  waha_session_name: null,
  display_name: "WhatsApp",
  phone_number: "+5511988887777",
  status: "WORKING",
  archived_at: null,
  meta_phone_number_id: null,
  meta_token_encrypted: null,
  uazapi_base_url: SERVIDOR,
  uazapi_instance_id: "inst-1",
  uazapi_token_encrypted: `\\xenc(${TOKEN})`,
  webhook_path_token: "tokendecaminho",
  metadata: { uazapi_webhook_id: "wh-1" },
  pareamento_qr_estado: "concluido",
  criada_pelo_crm: true,
  ...extra,
});

/** Escritas que o cliente do USUÁRIO tentou. */
let escritasDoUsuario: string[] = [];

/**
 * O cliente da sessão do usuário (PostgREST como `authenticated`): lê como o banco em memória, mas a escrita
 * numa linha criada pelo CRM é recusada como o gatilho `trg_channel_sessions_trava_instancia_do_crm` recusa.
 */
function clienteDoUsuario(): unknown {
  /** Consulta que o gatilho recusou: qualquer filtro encadeado termina no erro 42501. */
  const recusada = (): unknown => {
    const r: Record<string, unknown> = {};
    for (const nome of ["eq", "is", "select", "maybeSingle"]) r[nome] = () => r;
    r.then = (ok: (v: unknown) => unknown) =>
      Promise.resolve({
        data: null,
        error: { code: "42501", message: "a instância criada pelo CRM só pode ser removida ou trocada pelo servidor" },
      }).then(ok);
    return r;
  };
  const criadaPeloCrm = (tabela: string) =>
    tabela === "channel_sessions" && (banco.tabelas[tabela] ?? []).some((l) => l.criada_pelo_crm === true);
  return {
    from: (tabela: string) => ({
      select: (...a: unknown[]) => (banco.from(tabela) as unknown as { select: (...x: unknown[]) => unknown }).select(...a),
      update: (patch: Linha) => {
        escritasDoUsuario.push(`update:${tabela}`);
        return criadaPeloCrm(tabela) ? recusada() : banco.from(tabela).update(patch);
      },
      delete: () => {
        escritasDoUsuario.push(`delete:${tabela}`);
        return criadaPeloCrm(tabela) ? recusada() : banco.from(tabela).delete();
      },
    }),
  };
}

function resposta(status: number, json: unknown = {}) {
  return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
}

const chamadasAoServidor = () =>
  fetchMock.mock.calls.map(([url, init]) => ({
    metodo: (init as { method?: string } | undefined)?.method ?? "GET",
    url: String(url).replace(SERVIDOR, ""),
    token: ((init as { headers?: Record<string, string> } | undefined)?.headers ?? {}).token,
  }));

const ctx = { params: Promise.resolve({ id: CANAL }) };
const reqDelete = () => new NextRequest(`http://localhost/api/v1/channel-sessions/${CANAL}`, { method: "DELETE" });
const reqGet = () => new NextRequest(`http://localhost/api/v1/channel-sessions/${CANAL}?impact=1`);

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
    if ((init?.method ?? "GET") === "DELETE") return resposta(200, { response: "Instance Deleted" });
    throw new Error("rota não prevista");
  });
  escritasDoUsuario = [];
  const user = {
    id: USER,
    email: "a@example.com",
    full_name: null,
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR" as const,
    organizations: [{ organization_id: ORG, organization_name: "Org", role: "admin" }],
  };
  h.role.mockResolvedValue({ ok: true, user, org: { orgId: ORG, name: "Org", role: "admin" } });
  h.load.mockResolvedValue(user);
  h.org.mockResolvedValue({ orgId: ORG, name: "Org", role: "admin" });
});

function montar(linhas: Linha[]) {
  banco = criarBancoEmMemoria({ channel_sessions: linhas });
  clientes.usuario = clienteDoUsuario();
  clientes.servico = banco;
}

describe("DELETE de canal: a instância que o CRM criou", () => {
  it("apaga a instância NO SERVIDOR e arquiva a linha pelo servidor; a linha nunca é apagada e o usuário não escreve nada", async () => {
    montar([linha()]);

    const res = await DELETE(reqDelete(), ctx);

    expect(res.status).toBe(200);
    const corpo = (await res.json()).data;
    expect(corpo).toMatchObject({ archived: true, instancia_apagada: true, instancia_restou: false });
    expect(corpo.impact.outcome).toBe("archive");

    // O servidor de WhatsApp recebeu o pedido de exclusão, com o token DA INSTÂNCIA.
    expect(chamadasAoServidor()).toEqual([{ metodo: "DELETE", url: "/instance", token: TOKEN }]);
    // A linha continua lá, arquivada, e o usuário (que o banco barraria) não tentou escrever.
    expect(banco.tabelas.channel_sessions).toHaveLength(1);
    expect(banco.tabelas.channel_sessions![0]!.archived_at).toEqual(expect.any(String));
    expect(banco.tabelas.channel_sessions![0]!.status).toBe("STOPPED");
    expect(escritasDoUsuario).toEqual([]);
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "channel.archived",
        metadata: expect.objectContaining({ instancia_apagada: true, instancia_restou: false }),
      }),
    );
  });

  it("o servidor não confirmou a exclusão: a linha é arquivada e a resposta diz que a instância restou", async () => {
    fetchMock.mockImplementation(async () => resposta(500, {}));
    montar([linha()]);

    const res = await DELETE(reqDelete(), ctx);

    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ archived: true, instancia_apagada: false, instancia_restou: true });
    expect(banco.tabelas.channel_sessions![0]!.archived_at).toEqual(expect.any(String));
  });

  it("canal de outra organização: 404, o servidor de WhatsApp nem é chamado", async () => {
    montar([linha({ organization_id: "33333333-3333-4333-8333-333333333333" })]);
    const res = await DELETE(reqDelete(), ctx);
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(banco.tabelas.channel_sessions![0]!.archived_at).toBeNull();
  });

  it("o diálogo (GET ?impact=1) já diz que vai arquivar, o mesmo desfecho da rota", async () => {
    montar([linha()]);
    const res = await GET(reqGet(), ctx);
    expect(res.status).toBe(200);
    expect((await res.json()).data.deletion_impact.outcome).toBe("archive");
  });
});

describe("DELETE de canal: a conexão que o cliente trouxe (não criada pelo CRM) segue como sempre", () => {
  it("sem nada pendurado: apaga a linha pelo cliente do usuário e não fala com o servidor de WhatsApp", async () => {
    montar([linha({ criada_pelo_crm: false, pareamento_qr_estado: null })]);

    const res = await DELETE(reqDelete(), ctx);

    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ archived: false });
    expect(banco.tabelas.channel_sessions).toHaveLength(0);
    expect(escritasDoUsuario).toEqual(["delete:channel_sessions"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
