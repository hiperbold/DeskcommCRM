import { beforeEach, describe, expect, it, vi } from "vitest";

import { criarBancoEmMemoria, type BancoEmMemoria, type Linha } from "../helpers/banco-em-memoria";

/**
 * Pareamento por QR Code dentro do CRM (D-187), com o estado em COLUNAS do servidor (migration 0953).
 *
 * O servidor de instâncias é um dublê de `fetch` que responde pela rota e pelo
 * cabeçalho; o banco é o de memória com a semântica de filtro do PostgREST. O
 * que se prova é o COMPORTAMENTO: a ordem (linha antes da instância), o que cada
 * cabeçalho carrega (admintoken só para criar, e só para o servidor configurado), que falha no
 * meio não deixa instância órfã, que uma organização não enxerga o pareamento de outra e que
 * NADA que o usuário escreve no `metadata` decide pendente, criada pelo CRM ou vencido.
 *
 * A função do banco que reserva a vaga (`fn_channel_pareamento_qr_reservar`) tem um dublê aqui só
 * para provar o que o CÓDIGO faz com cada resposta dela; o que ela faz de verdade (trava por
 * organização, teto, gatilho) é provado no Postgres real em
 * `tests/invariants/pareamento-qr-estado-no-banco.test.ts`.
 */

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

vi.mock("@/lib/automation/outbound-url", () => ({ assertSafeOutboundUrl: () => undefined }));
vi.mock("@/lib/automation/outbound-ip", () => ({ assertDestinoResolvidoSeguro: async () => undefined }));
vi.mock("@/lib/env", () => ({ env: { IA_DESTINOS_INTERNOS_PERMITIDOS: "" } }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/ai/elegibilidade/pre-go-live", () => ({ metadataInicialDoCanal: () => ({ ai_gate: "allowlist" }) }));

const config: Record<string, string | null> = {};
/** De onde cada chave vem ("banco" = gravada pela tela, "ambiente" = arquivo de instalação). */
const fontes: Record<string, string> = {};
vi.mock("@/lib/instalacao/config", () => ({
  valorDaInstalacao: async (chave: string) => ({ valor: config[chave] ?? null, fonte: fontes[chave] ?? "banco" }),
}));

let cifraDisponivel = true;
vi.mock("@/lib/webhooks/secrets", () => ({
  encryptWebhookSecret: async (_a: unknown, texto: string) => (cifraDisponivel ? `\\xenc(${texto})` : null),
  decryptWebhookSecret: async (_a: unknown, cifrado: string) => {
    if (cifrado === "\\xenc(BOOM)") throw new Error("a chamada de decifrar caiu");
    const m = /^\\xenc\((.*)\)$/.exec(cifrado);
    return m ? m[1]! : null;
  },
}));

import {
  LIMITE_DE_CODIGOS_POR_PAREAMENTO,
  LIMITE_DE_FALHAS_DA_LIMPEZA,
  cancelarPareamento,
  configuracaoDoPareamento,
  estadoDoPareamento,
  iniciarPareamento,
  limparPareamentosVencidos,
  nomeDaInstancia,
  pareamentoDisponivel,
  pareamentoPendenteDaOrganizacao,
  renovarPareamento,
} from "@/lib/channels/uazapi/pareamento";
import { listarConexoesUazapi } from "@/lib/channels/uazapi/conexao";
import { removerConexaoPorInstancia } from "@/lib/channels/instancia";
import { CATALOGO_DA_INSTALACAO } from "@/lib/instalacao/catalogo";
import { logger } from "@/lib/logger";

const SERVIDOR = "https://qr.exemplo.com";
const FALSO = "https://falso.exemplo.com";
const NOVO = "https://novo.exemplo.com";
const ADMIN_TOKEN = "admin-secreto-123";
const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const TOKEN_DA_INSTANCIA = "tok-instancia-abc";
const QR = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
const URL_DO_WEBHOOK = (p: string) => `https://crm.exemplo.com/api/v1/webhooks/channel/${p}`;
const ID_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const ID_2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";

type Chamada = { url: string; metodo: string; cabecalhos: Record<string, string>; corpo: Record<string, unknown> | null };
const chamadas = (): Chamada[] =>
  fetchMock.mock.calls.map(([url, init]) => {
    const i = init as { method?: string; headers?: Record<string, string>; body?: string };
    return {
      url: String(url).replace(SERVIDOR, ""),
      metodo: i.method ?? "GET",
      cabecalhos: i.headers ?? {},
      corpo: i.body ? JSON.parse(i.body) : null,
    };
  });
const so = (metodo: string, url: string) => chamadas().filter((c) => c.metodo === metodo && c.url === url);
/** Alguma chamada, para QUALQUER servidor, levou o token de administrador? */
const algumaLevouOAdmin = () => chamadas().some((c) => c.cabecalhos.admintoken !== undefined);
const chamadasPara = (host: string) => fetchMock.mock.calls.filter(([url]) => String(url).startsWith(host));

function resposta(status: number, json: unknown = {}) {
  return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
}

/** O servidor dublê. `estado` é o que `GET /instance/status` responde. */
const servidor = {
  criar: (): Response => resposta(200, { token: TOKEN_DA_INSTANCIA, instance: { id: "inst-1", token: TOKEN_DA_INSTANCIA, status: "disconnected" } }),
  conectar: (): Response => resposta(200, { instance: { status: "connecting", qrcode: QR } }),
  estado: { status: "connecting", qrcode: QR as string | null, owner: "", profileName: "" },
  todas: [] as unknown[],
  apagar: (): Response => resposta(200, { response: "Instance Deleted" }),
};
/** Ordem em que o banco e o servidor foram chamados. */
let ordem: string[] = [];

function instalarServidor() {
  fetchMock.mockImplementation(async (input: string | URL, init?: RequestInit) => {
    const completa = String(input);
    const metodo = init?.method ?? "GET";
    // Outros hosts (um que a linha aponta, o que a instalação passou a usar): aceita tudo; o teste olha as chamadas.
    if (completa.startsWith(FALSO) || completa.startsWith(NOVO)) {
      ordem.push(`fetch:${completa}`);
      if (metodo === "GET" && completa.endsWith("/instance/status")) {
        return resposta(200, { instance: { id: "inst-1", ...servidor.estado } });
      }
      return resposta(200, {});
    }
    const url = completa.replace(SERVIDOR, "");
    ordem.push(`fetch:${url}`);
    if (metodo === "POST" && url === "/instance/create") return servidor.criar();
    if (metodo === "POST" && url === "/instance/connect") return servidor.conectar();
    if (metodo === "GET" && url === "/instance/status") {
      return resposta(200, { instance: { id: "inst-1", ...servidor.estado } });
    }
    if (metodo === "GET" && url === "/instance/all") return resposta(200, servidor.todas);
    if (metodo === "DELETE" && url === "/instance") return servidor.apagar();
    if (url === "/webhook" && metodo === "GET") return resposta(200, []);
    if (url === "/webhook" && metodo === "POST") return resposta(200, [{ id: "wh-1", url: (JSON.parse(String(init?.body)) as { url: string }).url }]);
    throw new Error(`rota não prevista: ${metodo} ${url}`);
  });
}

let banco: BancoEmMemoria;
/** Faz a função de reserva responder com o erro do banco (ex.: o gatilho do plano). */
let recusarReserva: { message: string; code: string; details?: string } | null;
/** Limite `conexoes` do plano vigente da organização (`null` = sem plano). */
let limiteDoPlano: number | null;
/** O erro que a escrita seguinte de uma coluna da linha devolve (ex.: 23505 do índice de número único). */
let falharAoEscrever: ((patch: Linha) => { message: string; code?: string } | null) | null;

/** Dublê da função do banco: as mesmas três decisões do SQL (2 pendentes, teto, insert), só para exercitar o código. */
function reservarNoDubleDoBanco(args: Record<string, unknown>) {
  ordem.push("reserva");
  if (recusarReserva) return { error: recusarReserva as unknown as { message: string } };
  const tabela = banco.tabelas.channel_sessions!;
  // D-188: o teto conta TODAS as conexões não arquivadas da organização, de qualquer canal.
  const ativas = tabela.filter((l) => l.organization_id === args.p_organization_id && (l.archived_at ?? null) === null);
  if (ativas.filter((l) => l.pareamento_qr_estado === "pendente").length >= 2) {
    return { data: { ok: false, codigo: "pendentes_demais" } };
  }
  const teto = limiteDoPlano ?? 50;
  if (ativas.length >= teto) {
    return { data: { ok: false, codigo: "teto_de_instancias", teto, do_plano: limiteDoPlano !== null } };
  }
  tabela.push({
    id: args.p_session_id,
    organization_id: args.p_organization_id,
    provider: "uazapi",
    uazapi_instance_id: `pendente-${String(args.p_session_id)}`,
    uazapi_base_url: args.p_base_url,
    uazapi_token_encrypted: null,
    webhook_path_token: args.p_webhook_path_token,
    display_name: "WhatsApp",
    phone_number: null,
    status: "STARTING",
    archived_at: null,
    metadata: args.p_metadata,
    pareamento_qr_estado: "pendente",
    pareamento_qr_iniciado_em: new Date().toISOString(),
    criada_pelo_crm: true,
    pareamento_qr_falhas: 0,
    pareamento_qr_codigos: 0,
    pareamento_qr_codigo_em: null,
  });
  return { data: { ok: true, id: args.p_session_id } };
}

function novoBanco(linhas: Linha[] = []) {
  recusarReserva = null;
  falharAoEscrever = null;
  banco = criarBancoEmMemoria(
    {
      channel_sessions: linhas,
      billing_contracts: [
        { organization_id: ORG_A, status: "ativa", cycle: "monthly", billing_plans: { code: "pro", name: "Pro", version: 1 } },
      ],
    },
    {
      rpc: {
        fn_channel_pareamento_qr_reservar: (args) => reservarNoDubleDoBanco(args),
        fn_billing_limites_efetivos: () => ({
          data: {
            funis: 5, etapas_por_funil: 10, leads: 5000, membros: 3, conexoes: limiteDoPlano,
            integracoes_webhook: 3, tokens_ia_mes: 3_000_000,
          },
        }),
      },
      aoEscrever: { channel_sessions: (modo, _linhas, patch) => (modo === "update" && patch && falharAoEscrever ? falharAoEscrever(patch) : null) },
    },
  );
  return banco;
}
const admin = () => banco as unknown as Parameters<typeof iniciarPareamento>[0];
const sessoes = () => banco.tabelas.channel_sessions!;

const ha_31_minutos = () => new Date(Date.now() - 31 * 60 * 1000).toISOString();

/** Uma linha de pareamento pendente. `extra` sobrescreve COLUNAS; `meta` sobrescreve o `metadata`. */
function linhaPendente(extra: Linha = {}, meta: Record<string, unknown> = {}): Linha {
  const id = (extra.id as string) ?? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  return {
    id,
    organization_id: ORG_A,
    provider: "uazapi",
    status: "STARTING",
    display_name: "WhatsApp",
    phone_number: null,
    uazapi_base_url: SERVIDOR,
    uazapi_instance_id: "inst-1",
    uazapi_token_encrypted: `\\xenc(${TOKEN_DA_INSTANCIA})`,
    webhook_path_token: "tokendecaminho",
    archived_at: null,
    pareamento_qr_estado: "pendente",
    pareamento_qr_iniciado_em: new Date().toISOString(),
    criada_pelo_crm: true,
    pareamento_qr_falhas: 0,
    pareamento_qr_codigos: 0,
    pareamento_qr_codigo_em: null,
    metadata: {
      pareamento_qr_tentativa_em: new Date(Date.now() - 60_000).toISOString(),
      ...meta,
    },
    ...extra,
  };
}

/** Uma conexão comum, conectada pelo cliente com servidor e token dele: não é pareamento. */
function conexaoComum(extra: Linha = {}, meta: Record<string, unknown> = {}): Linha {
  return linhaPendente(
    {
      status: "WORKING",
      pareamento_qr_estado: null,
      pareamento_qr_iniciado_em: null,
      criada_pelo_crm: false,
      ...extra,
    },
    meta,
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.mocked(logger.warn).mockClear();
  ordem = [];
  limiteDoPlano = null;
  config.UAZAPI_SERVIDOR_URL = SERVIDOR;
  config.UAZAPI_ADMIN_TOKEN = ADMIN_TOKEN;
  delete fontes.UAZAPI_SERVIDOR_URL;
  delete fontes.UAZAPI_ADMIN_TOKEN;
  cifraDisponivel = true;
  servidor.criar = () => resposta(200, { token: TOKEN_DA_INSTANCIA, instance: { id: "inst-1", token: TOKEN_DA_INSTANCIA, status: "disconnected" } });
  servidor.conectar = () => resposta(200, { instance: { status: "connecting", qrcode: QR } });
  servidor.estado = { status: "connecting", qrcode: QR, owner: "", profileName: "" };
  servidor.todas = [];
  servidor.apagar = () => resposta(200, { response: "Instance Deleted" });
  instalarServidor();
  novoBanco();
});

describe("sem configuração o recurso some", () => {
  it.each([
    ["sem o endereço", { UAZAPI_SERVIDOR_URL: null }],
    ["sem o token de administrador", { UAZAPI_ADMIN_TOKEN: null }],
    ["endereço em http", { UAZAPI_SERVIDOR_URL: "http://qr.exemplo.com" }],
  ])("%s: indisponível, e iniciar nem toca o servidor nem o banco", async (_nome, troca) => {
    Object.assign(config, troca);
    expect(await configuracaoDoPareamento()).toBeNull();
    expect(await pareamentoDisponivel()).toBe(false);

    const r = await iniciarPareamento(admin(), { organizationId: ORG_A });
    expect(r).toMatchObject({ ok: false, status: 404, codigo: "not_found" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(banco.chamadasRpc).toHaveLength(0);
    expect(sessoes()).toHaveLength(0);
  });

  it("com as duas chaves e https, fica disponível", async () => {
    expect(await pareamentoDisponivel()).toBe(true);
  });
});

describe("endereço e token de administrador só valem da MESMA origem", () => {
  it.each([
    ["endereço gravado pela tela + token só no arquivo de instalação", "banco", "ambiente"],
    ["endereço do arquivo de instalação + token gravado pela tela", "ambiente", "banco"],
  ])("%s: indisponível, e iniciar nem toca o servidor nem o banco (o token nunca vai para o outro endereço)", async (_nome, doEndereco, doToken) => {
    fontes.UAZAPI_SERVIDOR_URL = doEndereco;
    fontes.UAZAPI_ADMIN_TOKEN = doToken;

    expect(await configuracaoDoPareamento()).toBeNull();
    expect(await pareamentoDisponivel()).toBe(false);

    const r = await iniciarPareamento(admin(), { organizationId: ORG_A });
    expect(r).toMatchObject({ ok: false, status: 404, codigo: "not_found" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(algumaLevouOAdmin()).toBe(false);
    expect(banco.chamadasRpc).toHaveLength(0);
  });

  it.each(["banco", "ambiente"])("os dois de %s: disponível", async (origem) => {
    fontes.UAZAPI_SERVIDOR_URL = origem;
    fontes.UAZAPI_ADMIN_TOKEN = origem;
    expect(await configuracaoDoPareamento()).toEqual({ servidor: SERVIDOR, adminToken: ADMIN_TOKEN });
  });
});

describe("iniciar", () => {
  it("reserva a linha ANTES de criar a instância, com o token de administrador só para criar, e devolve o QR", async () => {
    const r = await iniciarPareamento(admin(), { organizationId: ORG_A });

    expect(r).toMatchObject({ ok: true, estado: "aguardando", qr: QR, codigo: null });
    if (!r.ok) throw new Error("esperava sucesso");

    // A reserva é uma chamada da função do banco, com a organização da sessão e o servidor configurado.
    expect(banco.chamadasRpc).toHaveLength(1);
    expect(banco.chamadasRpc[0]!.nome).toBe("fn_channel_pareamento_qr_reservar");
    expect(banco.chamadasRpc[0]!.args).toMatchObject({
      p_organization_id: ORG_A,
      p_session_id: r.id,
      p_base_url: SERVIDOR,
    });
    // Antes de qualquer chamada ao servidor.
    expect(ordem[0]).toBe("reserva");
    expect(ordem[1]).toBe("fetch:/instance/create");

    const [criar] = so("POST", "/instance/create");
    expect(criar!.cabecalhos.admintoken).toBe(ADMIN_TOKEN);
    expect(criar!.cabecalhos.token).toBeUndefined();
    expect(criar!.corpo).toEqual({ name: nomeDaInstancia(ORG_A, r.id) });
    expect(nomeDaInstancia(ORG_A, r.id)).toMatch(/^hc-11111111-[0-9a-f]{8}$/);

    // O resto fala com o token DA INSTÂNCIA, nunca com o de administrador.
    const [conectar] = so("POST", "/instance/connect");
    expect(conectar!.cabecalhos.token).toBe(TOKEN_DA_INSTANCIA);
    expect(conectar!.cabecalhos.admintoken).toBeUndefined();
    expect(conectar!.corpo).toEqual({});

    const linha = sessoes()[0]!;
    expect(linha).toMatchObject({
      id: r.id,
      organization_id: ORG_A,
      provider: "uazapi",
      status: "STARTING",
      uazapi_base_url: SERVIDOR,
      uazapi_instance_id: "inst-1",
      uazapi_token_encrypted: `\\xenc(${TOKEN_DA_INSTANCIA})`,
      webhook_secret_encrypted: `\\xenc(${TOKEN_DA_INSTANCIA})`,
      // O estado vive nas colunas do servidor...
      pareamento_qr_estado: "pendente",
      criada_pelo_crm: true,
    });
    expect(linha.pareamento_qr_iniciado_em).toEqual(expect.any(String));
    // ...e o metadata NÃO carrega nenhuma das marcas que decidem alguma coisa.
    expect(linha.metadata).toEqual(expect.objectContaining({ ai_gate: "allowlist" }));
    for (const marca of ["pareamento_qr_pendente", "criada_pelo_crm", "pareamento_qr_iniciado_em"]) {
      expect(Object.keys(linha.metadata as Record<string, unknown>)).not.toContain(marca);
    }

    // Nem o token de administrador nem o da instância ficam em claro em lugar nenhum.
    expect(JSON.stringify(sessoes())).not.toContain(ADMIN_TOKEN);
    expect(JSON.stringify(r)).not.toContain(ADMIN_TOKEN);
    expect(JSON.stringify(r)).not.toContain(TOKEN_DA_INSTANCIA);
    expect(JSON.stringify(sessoes())).not.toMatch(/"uazapi_token_encrypted":"tok-/);

    // A volta das mensagens só liga quando o número conectar (eventos de "conectando" abririam aviso de queda).
    expect(chamadas().some((c) => c.url === "/webhook")).toBe(false);
  });

  it("com o número, pede o código de pareamento e já o conta no limite do pareamento", async () => {
    servidor.conectar = () => resposta(200, { instance: { status: "connecting", paircode: "ABCD-1234" } });
    const r = await iniciarPareamento(admin(), { organizationId: ORG_A, telefone: "+55 (11) 99999-9999" });
    expect(r).toMatchObject({ ok: true, qr: null, codigo: "ABCD-1234" });
    expect(so("POST", "/instance/connect")[0]!.corpo).toEqual({ phone: "5511999999999" });
    expect(sessoes()[0]).toMatchObject({ pareamento_qr_codigos: 1 });
    expect(sessoes()[0]!.pareamento_qr_codigo_em).toEqual(expect.any(String));
  });

  it("sem o número, não gasta nada do limite de códigos", async () => {
    await iniciarPareamento(admin(), { organizationId: ORG_A });
    expect(sessoes()[0]).toMatchObject({ pareamento_qr_codigos: 0, pareamento_qr_codigo_em: null });
  });

  it("número fora do formato é recusado antes de qualquer coisa", async () => {
    const r = await iniciarPareamento(admin(), { organizationId: ORG_A, telefone: "123" });
    expect(r).toMatchObject({ ok: false, status: 422 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(banco.chamadasRpc).toHaveLength(0);
    expect(sessoes()).toHaveLength(0);
  });

  it("limite do plano (PT402): vira plano_limite_atingido e NENHUMA instância é criada", async () => {
    recusarReserva = { message: "Limite do plano atingido", code: "PT402", details: "conexoes" };
    const r = await iniciarPareamento(admin(), { organizationId: ORG_A });

    expect(r).toMatchObject({ ok: false, status: 402, codigo: "plano_limite_atingido" });
    expect(r.ok === false && r.reason).toMatch(/limite de conexões/);
    expect(so("POST", "/instance/create")).toHaveLength(0);
    expect(sessoes()).toHaveLength(0);
  });

  it("a reserva diz pendentes_demais: 429, sem tocar o servidor; outra organização não conta", async () => {
    novoBanco([linhaPendente({ id: ID_1 }), linhaPendente({ id: ID_2 })]);
    const barrada = await iniciarPareamento(admin(), { organizationId: ORG_A });
    expect(barrada).toMatchObject({ ok: false, status: 429, codigo: "rate_limited" });
    expect(so("POST", "/instance/create")).toHaveLength(0);

    const outraOrg = await iniciarPareamento(admin(), { organizationId: ORG_B });
    expect(outraOrg.ok).toBe(true);
  });

  it("a reserva diz taxa_de_criacao (o freio do banco, 10 por hora): 429 com a frase da taxa, sem tocar o servidor", async () => {
    novoBanco();
    banco.rpc = async (nome, args) => {
      banco.chamadasRpc.push({ nome, args });
      return { data: { ok: false, codigo: "taxa_de_criacao" }, error: null };
    };
    const r = await iniciarPareamento(admin(), { organizationId: ORG_A });
    expect(r).toMatchObject({ ok: false, status: 429, codigo: "rate_limited" });
    expect(r.ok === false && r.reason).toMatch(/Muitas tentativas de conectar/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sessoes()).toHaveLength(0);
  });

  it("o plano permite duas conexões e já há duas (de qualquer canal): 402 com a frase do plano, sem criar instância", async () => {
    // D-188: a conta soma TODAS as conexões não arquivadas, não só as criadas pelo CRM. Uma delas aqui nem é do CRM.
    limiteDoPlano = 2;
    novoBanco([
      conexaoComum({ id: ID_1, criada_pelo_crm: true, pareamento_qr_estado: "concluido" }),
      conexaoComum({ id: ID_2 }),
    ]);
    const r = await iniciarPareamento(admin(), { organizationId: ORG_A });
    expect(r).toMatchObject({ ok: false, status: 402, codigo: "plano_limite_atingido" });
    expect(r.ok === false && r.reason).toBe(
      "Sua conta atingiu o limite de 2 conexões do plano Pro. Remova uma conexão ou mude de plano.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sessoes()).toHaveLength(2);
  });

  it("plano sem limite: o teto de segurança é 50 e a 51ª recebe 409 com a frase própria", async () => {
    limiteDoPlano = null;
    novoBanco(
      Array.from({ length: 50 }, (_, i) =>
        conexaoComum({ id: `bbbbbbbb-bbbb-4bbb-8bbb-${String(i).padStart(12, "0")}` }),
      ),
    );
    const r = await iniciarPareamento(admin(), { organizationId: ORG_A });
    expect(r).toMatchObject({ ok: false, status: 409, codigo: "state_conflict" });
    expect(r.ok === false && r.reason).toMatch(/limite de números/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resposta inesperada da reserva (sem ok): erro interno, sem instância", async () => {
    banco = criarBancoEmMemoria({ channel_sessions: [] }, { rpc: { fn_channel_pareamento_qr_reservar: () => ({ data: null }) } });
    const r = await iniciarPareamento(admin(), { organizationId: ORG_A });
    expect(r).toMatchObject({ ok: false, status: 500, codigo: "internal_error" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falha no pedido do QR depois de criar: apaga a instância no servidor e arquiva a linha", async () => {
    servidor.conectar = () => resposta(500, {});
    const r = await iniciarPareamento(admin(), { organizationId: ORG_A });

    expect(r).toMatchObject({ ok: false, codigo: "upstream_unavailable" });
    const [apagar] = so("DELETE", "/instance");
    expect(apagar!.cabecalhos.token).toBe(TOKEN_DA_INSTANCIA);
    expect(sessoes()[0]).toMatchObject({ status: "STOPPED", pareamento_qr_estado: null });
    expect(sessoes()[0]!.archived_at).toEqual(expect.any(String));
  });

  it("cifra indisponível depois de criar: apaga a instância e não grava token em claro", async () => {
    cifraDisponivel = false;
    const r = await iniciarPareamento(admin(), { organizationId: ORG_A });

    expect(r).toMatchObject({ ok: false, status: 422 });
    expect(so("DELETE", "/instance")).toHaveLength(1);
    expect(sessoes()[0]!.archived_at).toEqual(expect.any(String));
    expect(JSON.stringify(sessoes())).not.toContain(TOKEN_DA_INSTANCIA);
  });

  it("cancelado enquanto a instância era criada: o token não é gravado, a instância recém-criada é apagada e a resposta é 409", async () => {
    // O cliente cancela (a linha é arquivada) depois da reserva e antes de a gravação do token.
    servidor.criar = () => {
      Object.assign(sessoes()[0]!, { archived_at: new Date().toISOString(), status: "STOPPED", pareamento_qr_estado: null });
      return resposta(200, { token: TOKEN_DA_INSTANCIA, instance: { id: "inst-1", token: TOKEN_DA_INSTANCIA, status: "disconnected" } });
    };
    const r = await iniciarPareamento(admin(), { organizationId: ORG_A });

    expect(r).toMatchObject({
      ok: false,
      status: 409,
      codigo: "state_conflict",
      reason: "O pareamento foi cancelado antes de terminar. Gere um novo QR Code.",
    });
    // A instância órfã foi apagada, pelo token que acabou de chegar; o QR nem foi pedido.
    const apagar = so("DELETE", "/instance");
    expect(apagar).toHaveLength(1);
    expect(apagar[0]!.cabecalhos.token).toBe(TOKEN_DA_INSTANCIA);
    expect(so("POST", "/instance/connect")).toHaveLength(0);
    // A linha arquivada não ganhou instância nem token (continua com o id provisório).
    expect(sessoes()[0]!.uazapi_instance_id).toMatch(/^pendente-/);
    expect(sessoes()[0]!.uazapi_token_encrypted).toBeNull();
    expect(JSON.stringify(sessoes())).not.toContain(TOKEN_DA_INSTANCIA);
  });

  it("cancelado enquanto a instância era criada e o DELETE pelo token falha: procura pelo nome e apaga", async () => {
    servidor.criar = () => {
      const linha = sessoes()[0]!;
      Object.assign(linha, { archived_at: new Date().toISOString(), status: "STOPPED", pareamento_qr_estado: null });
      servidor.todas = [{ name: nomeDaInstancia(ORG_A, linha.id as string), token: "tok-por-nome", id: "inst-1" }];
      return resposta(200, { token: TOKEN_DA_INSTANCIA, instance: { id: "inst-1", token: TOKEN_DA_INSTANCIA, status: "disconnected" } });
    };
    let tentativas = 0;
    servidor.apagar = () => (++tentativas === 1 ? resposta(500, {}) : resposta(200, {}));
    const r = await iniciarPareamento(admin(), { organizationId: ORG_A });

    expect(r).toMatchObject({ ok: false, status: 409, codigo: "state_conflict" });
    const apagar = so("DELETE", "/instance");
    expect(apagar.map((c) => c.cabecalhos.token)).toEqual([TOKEN_DA_INSTANCIA, "tok-por-nome"]);
  });

  it("gravar o token só vale para a linha ainda pendente: no caminho feliz a linha segue pendente e ganha o token", async () => {
    const r = await iniciarPareamento(admin(), { organizationId: ORG_A });
    expect(r.ok).toBe(true);
    expect(sessoes()[0]).toMatchObject({
      pareamento_qr_estado: "pendente",
      uazapi_instance_id: "inst-1",
      uazapi_token_encrypted: `\\xenc(${TOKEN_DA_INSTANCIA})`,
    });
    expect(so("DELETE", "/instance")).toHaveLength(0);
  });

  it("criação com resposta incerta (rede caiu): procura pelo nome e apaga a órfã", async () => {
    let id = "";
    fetchMock.mockImplementation(async (input: string | URL, init?: RequestInit) => {
      const url = String(input).replace(SERVIDOR, "");
      const metodo = init?.method ?? "GET";
      if (metodo === "POST" && url === "/instance/create") {
        id = (JSON.parse(String(init?.body)) as { name: string }).name;
        throw new Error("ECONNRESET");
      }
      if (metodo === "GET" && url === "/instance/all") return resposta(200, [{ name: id, token: "tok-orfa" }, { name: "outra", token: "x" }]);
      if (metodo === "DELETE" && url === "/instance") return resposta(202, { response: "Instance deletion scheduled" });
      throw new Error(`rota não prevista: ${metodo} ${url}`);
    });

    const r = await iniciarPareamento(admin(), { organizationId: ORG_A });

    expect(r).toMatchObject({ ok: false, codigo: "upstream_unavailable" });
    expect(so("GET", "/instance/all")[0]!.cabecalhos.admintoken).toBe(ADMIN_TOKEN);
    const [apagar] = so("DELETE", "/instance");
    expect(apagar!.cabecalhos.token).toBe("tok-orfa");
    expect(sessoes()[0]!.archived_at).toEqual(expect.any(String));
  });

  it("servidor recusa o token de administrador: frase fixa, sem eco da resposta, linha arquivada", async () => {
    servidor.criar = () => resposta(401, { error: `token ${ADMIN_TOKEN} inválido` });
    const r = await iniciarPareamento(admin(), { organizationId: ORG_A });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(ADMIN_TOKEN);
    expect(r.ok === false && r.reason).toMatch(/recusou o token de administrador/);
    expect(sessoes()[0]!.archived_at).toEqual(expect.any(String));
  });
});

describe("estado", () => {
  it("aguardando: devolve o QR atualizado, só se a imagem for um data URL de imagem", async () => {
    novoBanco([linhaPendente()]);
    const r = await estadoDoPareamento(admin(), { organizationId: ORG_A, id: sessoes()[0]!.id as string, urlDoWebhook: URL_DO_WEBHOOK });
    expect(r).toMatchObject({ estado: "aguardando", qr: QR });
    expect(so("GET", "/instance/status")[0]!.cabecalhos.token).toBe(TOKEN_DA_INSTANCIA);

    servidor.estado.qrcode = "data:text/html;base64,PHNjcmlwdD4=";
    const hostil = await estadoDoPareamento(admin(), { organizationId: ORG_A, id: sessoes()[0]!.id as string, urlDoWebhook: URL_DO_WEBHOOK });
    expect(hostil).toMatchObject({ estado: "aguardando", qr: null });
  });

  it("QR em base64 puro vira data URL", async () => {
    novoBanco([linhaPendente()]);
    servidor.estado.qrcode = "iVBORw0KGgoAAAANSUhEUg==";
    const r = await estadoDoPareamento(admin(), { organizationId: ORG_A, id: sessoes()[0]!.id as string, urlDoWebhook: URL_DO_WEBHOOK });
    expect(r).toMatchObject({ qr: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==" });
  });

  it("conectou: grava status, número e nome, marca como concluído e liga a volta com action add", async () => {
    novoBanco([linhaPendente()]);
    servidor.estado = { status: "connected", qrcode: null, owner: "5511988887777", profileName: "Loja do Zé" };

    const r = await estadoDoPareamento(admin(), { organizationId: ORG_A, id: sessoes()[0]!.id as string, urlDoWebhook: URL_DO_WEBHOOK });

    expect(r).toMatchObject({
      estado: "conectado",
      concluiuAgora: true,
      conexao: { displayName: "Loja do Zé", phoneNumber: "+5511988887777", status: "WORKING" },
      webhook: { registrado: true, aviso: null },
    });
    expect(sessoes()[0]).toMatchObject({
      status: "WORKING",
      phone_number: "+5511988887777",
      display_name: "Loja do Zé",
      pareamento_qr_estado: "concluido",
      criada_pelo_crm: true,
    });
    expect(sessoes()[0]!.metadata).toMatchObject({ uazapi_webhook_id: "wh-1" });

    const [add] = so("POST", "/webhook");
    expect(add!.corpo).toMatchObject({ action: "add", url: URL_DO_WEBHOOK("tokendecaminho") });

    // Chamada seguinte (outra aba): devolve o resultado sem refazer nada e sem repetir o audit.
    fetchMock.mockClear();
    const de_novo = await estadoDoPareamento(admin(), { organizationId: ORG_A, id: sessoes()[0]!.id as string, urlDoWebhook: URL_DO_WEBHOOK });
    expect(de_novo).toMatchObject({ estado: "conectado", concluiuAgora: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("duas chamadas ao mesmo tempo (duas abas): só uma conclui, liga a volta UMA vez, e a outra recebe o resultado", async () => {
    novoBanco([linhaPendente()]);
    servidor.estado = { status: "connected", qrcode: null, owner: "5511988887777", profileName: "Loja do Zé" };
    const entrada = { organizationId: ORG_A, id: sessoes()[0]!.id as string, urlDoWebhook: URL_DO_WEBHOOK };

    const [a, b] = await Promise.all([estadoDoPareamento(admin(), entrada), estadoDoPareamento(admin(), entrada)]);

    const agora = [a, b].filter((r) => "concluiuAgora" in r && r.concluiuAgora);
    const depois = [a, b].filter((r) => "concluiuAgora" in r && !r.concluiuAgora);
    expect(agora).toHaveLength(1);
    expect(depois).toHaveLength(1);
    // Um registro de webhook só: a segunda chamada não repete o efeito.
    expect(so("POST", "/webhook")).toHaveLength(1);
    expect(sessoes()[0]).toMatchObject({ pareamento_qr_estado: "concluido", status: "WORKING" });
  });

  it("cancelado ou arquivado enquanto conclui: não conclui, não liga a volta e não ressuscita a linha", async () => {
    novoBanco([linhaPendente()]);
    servidor.estado = { status: "connected", qrcode: null, owner: "5511988887777", profileName: "" };
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input: string | URL, init?: RequestInit) => {
      const r = await original(input, init);
      // O cancelamento chega entre a leitura do servidor e a gravação da conclusão.
      if (String(input).endsWith("/instance/status")) sessoes()[0]!.archived_at = new Date().toISOString();
      return r;
    });

    const r = await estadoDoPareamento(admin(), { organizationId: ORG_A, id: sessoes()[0]!.id as string, urlDoWebhook: URL_DO_WEBHOOK });

    expect(r).toMatchObject({ ok: false, status: 409, codigo: "state_conflict" });
    expect(so("POST", "/webhook")).toHaveLength(0);
    expect(sessoes()[0]).toMatchObject({ pareamento_qr_estado: "pendente", status: "STARTING" });
  });

  it("conectou mas o CRM não tem endereço público: conecta e avisa que a volta não foi ligada", async () => {
    novoBanco([linhaPendente()]);
    servidor.estado = { status: "connected", qrcode: null, owner: "5511988887777", profileName: "" };
    const r = await estadoDoPareamento(admin(), { organizationId: ORG_A, id: sessoes()[0]!.id as string, urlDoWebhook: null });
    expect(r).toMatchObject({ estado: "conectado", webhook: { registrado: false } });
    expect("webhook" in r && r.webhook.aviso).toMatch(/endereço público/);
    expect(so("POST", "/webhook")).toHaveLength(0);
  });

  it("organização diferente da sessão: 404 e o servidor nem é consultado", async () => {
    novoBanco([linhaPendente()]);
    const r = await estadoDoPareamento(admin(), { organizationId: ORG_B, id: sessoes()[0]!.id as string, urlDoWebhook: URL_DO_WEBHOOK });
    expect(r).toMatchObject({ ok: false, status: 404, codigo: "not_found" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("id que não é uuid: 404 sem consulta", async () => {
    const r = await estadoDoPareamento(admin(), { organizationId: ORG_A, id: "../../x", urlDoWebhook: null });
    expect(r).toMatchObject({ ok: false, status: 404 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("servidor diz desconectado: expirado, mas só depois da carência do primeiro pedido", async () => {
    novoBanco([linhaPendente()]);
    servidor.estado = { status: "disconnected", qrcode: null, owner: "", profileName: "" };
    const expirado = await estadoDoPareamento(admin(), { organizationId: ORG_A, id: sessoes()[0]!.id as string, urlDoWebhook: null });
    expect(expirado).toMatchObject({ estado: "expirado", qr: null });

    novoBanco([linhaPendente({}, { pareamento_qr_tentativa_em: new Date().toISOString() })]);
    const recem = await estadoDoPareamento(admin(), { organizationId: ORG_A, id: sessoes()[0]!.id as string, urlDoWebhook: null });
    expect(recem).toMatchObject({ estado: "aguardando" });
  });

  it("passou do prazo sem conectar (pela coluna): apaga a instância, arquiva e responde que expirou", async () => {
    novoBanco([linhaPendente({ pareamento_qr_iniciado_em: ha_31_minutos() })]);
    const r = await estadoDoPareamento(admin(), { organizationId: ORG_A, id: sessoes()[0]!.id as string, urlDoWebhook: URL_DO_WEBHOOK });
    expect(r).toMatchObject({ ok: false, status: 404 });
    expect(so("DELETE", "/instance")).toHaveLength(1);
    expect(sessoes()[0]).toMatchObject({ pareamento_qr_estado: null });
    expect(sessoes()[0]!.archived_at).toEqual(expect.any(String));
  });

  it("gerar outro QR pede a conexão de novo na mesma instância", async () => {
    novoBanco([linhaPendente()]);
    const r = await renovarPareamento(admin(), { organizationId: ORG_A, id: sessoes()[0]!.id as string });
    expect(r).toMatchObject({ estado: "aguardando", qr: QR });
    expect(so("POST", "/instance/connect")).toHaveLength(1);
    expect(so("POST", "/instance/create")).toHaveLength(0);
  });
});

describe("a tela retoma o pendente só lendo", () => {
  it("devolve o pendente mais recente ainda dentro do prazo, sem apagar, arquivar nem falar com o servidor", async () => {
    novoBanco([
      linhaPendente({ id: ID_1, pareamento_qr_iniciado_em: ha_31_minutos() }),
      linhaPendente({ id: ID_2 }),
    ]);
    const r = await pareamentoPendenteDaOrganizacao(admin(), ORG_A);
    expect(r).toMatchObject({ id: ID_2 });
    // Consulta não tem efeito: o vencido continua lá para o cron/iniciar limparem.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sessoes().every((l) => l.archived_at === null && l.pareamento_qr_estado === "pendente")).toBe(true);
  });

  it("só o vencido: nada a retomar, e ainda assim nada é limpo na consulta", async () => {
    novoBanco([linhaPendente({ pareamento_qr_iniciado_em: ha_31_minutos() })]);
    expect(await pareamentoPendenteDaOrganizacao(admin(), ORG_A)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sessoes()[0]!.archived_at).toBeNull();
  });

  it("de outra organização não aparece", async () => {
    novoBanco([linhaPendente()]);
    expect(await pareamentoPendenteDaOrganizacao(admin(), ORG_B)).toBeNull();
  });
});

describe("cancelar", () => {
  it("apaga a instância no servidor e arquiva a sessão", async () => {
    novoBanco([linhaPendente()]);
    const r = await cancelarPareamento(admin(), { organizationId: ORG_A, id: sessoes()[0]!.id as string });
    expect(r).toEqual({ ok: true, instanciaApagada: true });
    expect(so("DELETE", "/instance")[0]!.cabecalhos.token).toBe(TOKEN_DA_INSTANCIA);
    expect(sessoes()[0]).toMatchObject({ status: "STOPPED", pareamento_qr_estado: null });
    expect(sessoes()[0]!.archived_at).toEqual(expect.any(String));
  });

  it("com a instância ainda em criação (id provisório): 409, nada apagado e a linha segue pendente", async () => {
    novoBanco([linhaPendente({ uazapi_instance_id: "pendente-aaaaaaaa", uazapi_token_encrypted: null })]);
    const r = await cancelarPareamento(admin(), { organizationId: ORG_A, id: sessoes()[0]!.id as string });
    expect(r).toMatchObject({
      ok: false,
      status: 409,
      codigo: "state_conflict",
      reason: "A conexão ainda está sendo criada. Aguarde alguns segundos e tente de novo.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sessoes()[0]).toMatchObject({ archived_at: null, pareamento_qr_estado: "pendente" });
  });

  it("a limpeza dos vencidos NÃO ganha a trava: um pendente velho com id provisório é limpo", async () => {
    novoBanco([
      linhaPendente({
        id: ID_1,
        uazapi_instance_id: "pendente-aaaaaaaa",
        uazapi_token_encrypted: null,
        pareamento_qr_iniciado_em: ha_31_minutos(),
      }),
    ]);
    const r = await limparPareamentosVencidos(admin(), { urlDoWebhook: URL_DO_WEBHOOK });
    expect(r.limpos + r.falhas).toBe(1);
    expect(sessoes()[0]!.archived_at).toEqual(expect.any(String));
  });

  it("de outra organização: 404, nada apagado", async () => {
    novoBanco([linhaPendente()]);
    const r = await cancelarPareamento(admin(), { organizationId: ORG_B, id: sessoes()[0]!.id as string });
    expect(r).toMatchObject({ ok: false, status: 404 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sessoes()[0]!.archived_at).toBeNull();
  });

  it("depois de conectar não cancela: é Remover conexão", async () => {
    novoBanco([linhaPendente({ status: "WORKING", pareamento_qr_estado: "concluido" })]);
    const r = await cancelarPareamento(admin(), { organizationId: ORG_A, id: sessoes()[0]!.id as string });
    expect(r).toMatchObject({ ok: false, status: 409, codigo: "state_conflict" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("conexão comum (não nasceu de pareamento) não é achada por aqui: 404, nada apagado", async () => {
    novoBanco([conexaoComum()]);
    const id = sessoes()[0]!.id as string;
    expect(await cancelarPareamento(admin(), { organizationId: ORG_A, id })).toMatchObject({ ok: false, status: 404 });
    expect(await estadoDoPareamento(admin(), { organizationId: ORG_A, id, urlDoWebhook: null })).toMatchObject({ ok: false, status: 404 });
    expect(await renovarPareamento(admin(), { organizationId: ORG_A, id })).toMatchObject({ ok: false, status: 404 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sessoes()[0]!.archived_at).toBeNull();
  });
});

describe("limpeza dos pendentes vencidos (30 min)", () => {
  it("o que não conectou é apagado no servidor e arquivado; o recente fica", async () => {
    novoBanco([
      linhaPendente({ id: ID_1, pareamento_qr_iniciado_em: ha_31_minutos() }),
      linhaPendente({ id: ID_2 }),
    ]);
    servidor.estado.status = "disconnected";
    const r = await limparPareamentosVencidos(admin(), { urlDoWebhook: URL_DO_WEBHOOK });

    expect(r).toEqual({ limpos: 1, concluidos: 0, falhas: 0 });
    expect(so("DELETE", "/instance")).toHaveLength(1);
    expect(sessoes()[0]!.archived_at).toEqual(expect.any(String));
    expect(sessoes()[1]!.archived_at).toBeNull();
  });

  it("o que conectou no meio tempo (aba fechada) é concluído, não apagado", async () => {
    novoBanco([linhaPendente({ pareamento_qr_iniciado_em: ha_31_minutos() })]);
    servidor.estado = { status: "connected", qrcode: null, owner: "5511988887777", profileName: "Loja" };
    const r = await limparPareamentosVencidos(admin(), { urlDoWebhook: URL_DO_WEBHOOK });

    expect(r).toEqual({ limpos: 0, concluidos: 1, falhas: 0 });
    expect(so("DELETE", "/instance")).toHaveLength(0);
    expect(sessoes()[0]).toMatchObject({ status: "WORKING", archived_at: null, pareamento_qr_estado: "concluido" });
  });

  it("iniciar libera a vaga de um vencido antes de reservar", async () => {
    novoBanco([
      linhaPendente({ id: ID_1, pareamento_qr_iniciado_em: ha_31_minutos() }),
      linhaPendente({ id: ID_2, pareamento_qr_iniciado_em: ha_31_minutos() }),
    ]);
    servidor.estado.status = "disconnected";
    const r = await iniciarPareamento(admin(), { organizationId: ORG_A });
    expect(r.ok).toBe(true);
  });

  it("o vencimento é a COLUNA: o metadata dizendo 'iniciado há 31 minutos' não vence ninguém, e o que a coluna vence é limpo mesmo com o metadata novo", async () => {
    novoBanco([
      // Coluna recente, metadata adulterado para parecer velho: fica.
      linhaPendente({ id: ID_1 }, { pareamento_qr_iniciado_em: ha_31_minutos() }),
      // Coluna velha, metadata adulterado para parecer novo: sai.
      linhaPendente({ id: ID_2, pareamento_qr_iniciado_em: ha_31_minutos() }, { pareamento_qr_iniciado_em: new Date().toISOString() }),
    ]);
    servidor.estado.status = "disconnected";
    const r = await limparPareamentosVencidos(admin(), { urlDoWebhook: URL_DO_WEBHOOK });

    expect(r).toEqual({ limpos: 1, concluidos: 0, falhas: 0 });
    expect(sessoes().find((l) => l.id === ID_1)!.archived_at).toBeNull();
    expect(sessoes().find((l) => l.id === ID_2)!.archived_at).toEqual(expect.any(String));
  });

  it("instância que não se confirmou apagada: a linha fica para a próxima rodada, conta falha, e na quinta sai do lote arquivada", async () => {
    servidor.apagar = () => resposta(500, {});
    novoBanco([linhaPendente({ pareamento_qr_iniciado_em: ha_31_minutos() })]);
    servidor.estado.status = "disconnected";
    // O servidor segue listando a instância (apagar falha, e a busca pelo nome a encontra): não está apagada.
    servidor.todas = [{ name: nomeDaInstancia(ORG_A, sessoes()[0]!.id as string), id: "inst-1", token: TOKEN_DA_INSTANCIA }];

    for (let rodada = 1; rodada < LIMITE_DE_FALHAS_DA_LIMPEZA; rodada++) {
      const r = await limparPareamentosVencidos(admin(), { urlDoWebhook: URL_DO_WEBHOOK });
      expect(r).toEqual({ limpos: 0, concluidos: 0, falhas: 1 });
      expect(sessoes()[0]).toMatchObject({ archived_at: null, pareamento_qr_estado: "pendente", pareamento_qr_falhas: rodada });
    }
    // A última tentativa: continua sem apagar, então arquiva e avisa que a instância pode ter ficado.
    const ultima = await limparPareamentosVencidos(admin(), { urlDoWebhook: URL_DO_WEBHOOK });
    expect(ultima).toEqual({ limpos: 0, concluidos: 0, falhas: 1 });
    expect(sessoes()[0]!.archived_at).toEqual(expect.any(String));
    expect(sessoes()[0]).toMatchObject({ pareamento_qr_estado: null });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("órfã"), expect.anything());

    // Fora do lote: a rodada seguinte nem fala com o servidor.
    fetchMock.mockClear();
    expect(await limparPareamentosVencidos(admin(), { urlDoWebhook: URL_DO_WEBHOOK })).toEqual({ limpos: 0, concluidos: 0, falhas: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("linha que já falhou o limite de vezes não entra no lote", async () => {
    novoBanco([
      linhaPendente({ pareamento_qr_iniciado_em: ha_31_minutos(), pareamento_qr_falhas: LIMITE_DE_FALHAS_DA_LIMPEZA }),
    ]);
    expect(await limparPareamentosVencidos(admin(), { urlDoWebhook: URL_DO_WEBHOOK })).toEqual({ limpos: 0, concluidos: 0, falhas: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("exceção no meio de uma linha não para as outras: conta a falha e segue", async () => {
    novoBanco([
      linhaPendente({ id: ID_1, pareamento_qr_iniciado_em: ha_31_minutos(), uazapi_token_encrypted: "\\xenc(BOOM)" }),
      linhaPendente({ id: ID_2, pareamento_qr_iniciado_em: ha_31_minutos() }),
    ]);
    servidor.estado.status = "disconnected";
    // Decifrar o token da primeira lança; a segunda é limpa normalmente.
    const r = await limparPareamentosVencidos(admin(), { urlDoWebhook: URL_DO_WEBHOOK });
    expect(r).toEqual({ limpos: 1, concluidos: 0, falhas: 1 });
    expect(sessoes().find((l) => l.id === ID_2)!.archived_at).toEqual(expect.any(String));
    // A que lançou fica para a próxima rodada, com a falha contada.
    expect(sessoes().find((l) => l.id === ID_1)).toMatchObject({ archived_at: null, pareamento_qr_falhas: 1 });
  });
});

describe("C1/A2: o token de administrador só vai para o servidor configurado", () => {
  it("linha de pareamento que aponta para OUTRO servidor, sem token: nenhuma chamada leva o admin, nada é listado, e a linha só é arquivada com aviso", async () => {
    novoBanco([
      linhaPendente({
        pareamento_qr_iniciado_em: ha_31_minutos(),
        uazapi_base_url: FALSO,
        uazapi_token_encrypted: null,
      }),
    ]);
    const r = await limparPareamentosVencidos(admin(), { urlDoWebhook: URL_DO_WEBHOOK });

    expect(algumaLevouOAdmin()).toBe(false);
    expect(so("GET", "/instance/all")).toHaveLength(0);
    expect(chamadasPara(FALSO)).toHaveLength(0);
    expect(r.limpos).toBe(0);
    expect(sessoes()[0]!.archived_at).toEqual(expect.any(String));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("não é o configurado"), expect.anything());
  });

  it("linha de outro servidor, com o token da própria instância: apaga com esse token, nunca com o do admin", async () => {
    novoBanco([linhaPendente({ pareamento_qr_iniciado_em: ha_31_minutos(), uazapi_base_url: FALSO })]);
    servidor.estado.status = "disconnected";
    const r = await limparPareamentosVencidos(admin(), { urlDoWebhook: URL_DO_WEBHOOK });

    expect(r).toEqual({ limpos: 1, concluidos: 0, falhas: 0 });
    expect(algumaLevouOAdmin()).toBe(false);
    const paraOFalso = chamadasPara(FALSO).map(([url, init]) => ({
      url: String(url),
      cabecalhos: (init as { headers: Record<string, string> }).headers,
    }));
    expect(paraOFalso.length).toBeGreaterThan(0);
    expect(paraOFalso.every((c) => c.cabecalhos.token === TOKEN_DA_INSTANCIA)).toBe(true);
  });

  it("cancelar e vencer pelo estado também não levam o admin a um servidor que não é o configurado", async () => {
    novoBanco([linhaPendente({ id: ID_1, uazapi_base_url: FALSO, uazapi_token_encrypted: null })]);
    await cancelarPareamento(admin(), { organizationId: ORG_A, id: ID_1 });
    expect(algumaLevouOAdmin()).toBe(false);
    expect(chamadasPara(FALSO)).toHaveLength(0);
  });

  it("a instalação trocou de servidor: a linha antiga não manda o token novo ao host antigo, nem o antigo ao novo", async () => {
    config.UAZAPI_SERVIDOR_URL = NOVO;
    config.UAZAPI_ADMIN_TOKEN = "admin-do-servidor-novo";
    novoBanco([
      // Sem token: o único caminho seria listar com o admin, e ele pertence ao servidor novo.
      linhaPendente({ id: ID_1, pareamento_qr_iniciado_em: ha_31_minutos(), uazapi_token_encrypted: null }),
      // Com token: apaga com o token da instância, no servidor antigo onde ela vive.
      linhaPendente({ id: ID_2, pareamento_qr_iniciado_em: ha_31_minutos() }),
    ]);
    servidor.estado.status = "disconnected";
    await limparPareamentosVencidos(admin(), { urlDoWebhook: URL_DO_WEBHOOK });

    expect(algumaLevouOAdmin()).toBe(false);
    expect(chamadasPara(NOVO)).toHaveLength(0);
    expect(so("GET", "/instance/all")).toHaveLength(0);
    expect(so("DELETE", "/instance")).toHaveLength(1);
    expect(so("DELETE", "/instance")[0]!.cabecalhos.token).toBe(TOKEN_DA_INSTANCIA);
  });

  it("o mesmo servidor escrito com maiúsculas e barra no fim é o servidor configurado (comparação normalizada)", async () => {
    novoBanco([
      linhaPendente({
        pareamento_qr_iniciado_em: ha_31_minutos(),
        uazapi_base_url: "https://QR.exemplo.com/",
        uazapi_token_encrypted: null,
        uazapi_instance_id: "pendente-x",
      }),
    ]);
    const id = sessoes()[0]!.id as string;
    servidor.todas = [{ name: nomeDaInstancia(ORG_A, id), token: "tok-orfa", id: "inst-9" }];
    await limparPareamentosVencidos(admin(), { urlDoWebhook: URL_DO_WEBHOOK });
    expect(so("GET", "/instance/all")[0]!.cabecalhos.admintoken).toBe(ADMIN_TOKEN);
    expect(so("DELETE", "/instance")[0]!.cabecalhos.token).toBe("tok-orfa");
  });

  it("estado forjado no metadata de uma conexão comum não a torna pendente nem criada pelo CRM: nada é chamado, nada é apagado", async () => {
    // O que o admin da empresa consegue fazer pelo PostgREST: conectar com servidor dele e escrever o metadata.
    novoBanco([
      conexaoComum(
        { id: ID_1, uazapi_base_url: FALSO },
        {
          pareamento_qr_pendente: true,
          criada_pelo_crm: true,
          pareamento_qr_iniciado_em: ha_31_minutos(),
        },
      ),
    ]);

    // A limpeza não vê a linha.
    expect(await limparPareamentosVencidos(admin(), { urlDoWebhook: URL_DO_WEBHOOK })).toEqual({ limpos: 0, concluidos: 0, falhas: 0 });
    // A tela de pareamento tampouco: não retoma, não conclui, não cancela.
    expect(await pareamentoPendenteDaOrganizacao(admin(), ORG_A)).toBeNull();
    expect(await cancelarPareamento(admin(), { organizationId: ORG_A, id: ID_1 })).toMatchObject({ ok: false, status: 404 });
    expect(await estadoDoPareamento(admin(), { organizationId: ORG_A, id: ID_1, urlDoWebhook: null })).toMatchObject({ ok: false, status: 404 });
    // Ela segue na lista de Conexões (o metadata não a esconde).
    expect((await listarConexoesUazapi(admin(), ORG_A)).map((c) => c.id)).toEqual([ID_1]);
    // Remover a conexão só tira o webhook: a instância é do cliente, o metadata não a faz "do CRM".
    const removida = await removerConexaoPorInstancia(admin(), ORG_A, ID_1);
    expect(removida).toMatchObject({ ok: true, instanciaApagada: false, instanciaRestou: false });
    expect(so("DELETE", "/instance")).toHaveLength(0);
    expect(algumaLevouOAdmin()).toBe(false);
  });
});

describe("M2: a conclusão que não grava desfaz tudo", () => {
  const conflitoDeNumero = (patch: Linha) =>
    patch.pareamento_qr_estado === "concluido"
      ? { message: 'duplicate key value violates unique constraint "channel_sessions_phone_per_org_unique"', code: "23505" }
      : null;

  it("número já ativo na empresa (23505): apaga a instância, arquiva a linha e diz isso ao cliente", async () => {
    novoBanco([linhaPendente()]);
    servidor.estado = { status: "connected", qrcode: null, owner: "5511988887777", profileName: "Loja" };
    falharAoEscrever = conflitoDeNumero;

    const r = await estadoDoPareamento(admin(), { organizationId: ORG_A, id: sessoes()[0]!.id as string, urlDoWebhook: URL_DO_WEBHOOK });

    expect(r).toMatchObject({ ok: false, status: 409, codigo: "state_conflict" });
    expect(r).toMatchObject({ reason: expect.stringMatching(/já está conectado nesta empresa/) });
    // Nada de webhook registrado para uma conexão que não existe.
    expect(so("POST", "/webhook")).toHaveLength(0);
    expect(so("DELETE", "/instance")).toHaveLength(1);
    expect(so("DELETE", "/instance")[0]!.cabecalhos.token).toBe(TOKEN_DA_INSTANCIA);
  });

  it("outra falha ao gravar também desfaz, com frase própria", async () => {
    novoBanco([linhaPendente()]);
    servidor.estado = { status: "connected", qrcode: null, owner: "5511988887777", profileName: "Loja" };
    falharAoEscrever = (patch) => (patch.pareamento_qr_estado === "concluido" ? { message: "conexão caiu", code: "08006" } : null);

    const r = await estadoDoPareamento(admin(), { organizationId: ORG_A, id: sessoes()[0]!.id as string, urlDoWebhook: URL_DO_WEBHOOK });
    expect(r).toMatchObject({ ok: false, status: 500, codigo: "internal_error" });
    expect(so("DELETE", "/instance")).toHaveLength(1);
  });

  it("na limpeza, a conclusão que não gravou conta como FALHA, não como concluída", async () => {
    novoBanco([linhaPendente({ pareamento_qr_iniciado_em: ha_31_minutos() })]);
    servidor.estado = { status: "connected", qrcode: null, owner: "5511988887777", profileName: "Loja" };
    falharAoEscrever = conflitoDeNumero;

    const r = await limparPareamentosVencidos(admin(), { urlDoWebhook: URL_DO_WEBHOOK });

    expect(r).toEqual({ limpos: 0, concluidos: 0, falhas: 1 });
    expect(so("DELETE", "/instance")).toHaveLength(1);
    expect(sessoes()[0]!.archived_at).toEqual(expect.any(String));
  });
});

describe("M3: código de pareamento por telefone tem limite", () => {
  const renovar = (telefone: string | null = "5511999999999") =>
    renovarPareamento(admin(), { organizationId: ORG_A, id: ID_1, telefone });
  const recuar = (segundos: number) => {
    const l = sessoes()[0]!;
    l.pareamento_qr_codigo_em = new Date(Date.now() - segundos * 1000).toISOString();
  };

  it("um pedido a cada 30 segundos: o segundo logo em seguida é recusado sem falar com o servidor", async () => {
    novoBanco([linhaPendente({ id: ID_1 })]);
    servidor.conectar = () => resposta(200, { instance: { status: "connecting", paircode: "ABCD-1234" } });

    expect(await renovar()).toMatchObject({ estado: "aguardando", codigo: "ABCD-1234" });
    expect(sessoes()[0]).toMatchObject({ pareamento_qr_codigos: 1 });

    const logo = await renovar();
    expect(logo).toMatchObject({ ok: false, status: 429, codigo: "rate_limited" });
    expect("reason" in logo && logo.reason).toMatch(/30 segundos/);
    expect(so("POST", "/instance/connect")).toHaveLength(1);
    expect(sessoes()[0]).toMatchObject({ pareamento_qr_codigos: 1 });

    // Passados os 30 s, o pedido volta a valer.
    recuar(31);
    expect(await renovar()).toMatchObject({ estado: "aguardando" });
    expect(sessoes()[0]).toMatchObject({ pareamento_qr_codigos: 2 });
  });

  it("no máximo 5 por pareamento, mesmo esperando o intervalo", async () => {
    novoBanco([linhaPendente({ id: ID_1 })]);
    servidor.conectar = () => resposta(200, { instance: { status: "connecting", paircode: "ABCD-1234" } });

    for (let i = 0; i < LIMITE_DE_CODIGOS_POR_PAREAMENTO; i++) {
      expect(await renovar()).toMatchObject({ estado: "aguardando" });
      recuar(31);
    }
    const sexto = await renovar();
    expect(sexto).toMatchObject({ ok: false, status: 429, codigo: "rate_limited" });
    expect("reason" in sexto && sexto.reason).toMatch(/códigos demais/);
    expect(so("POST", "/instance/connect")).toHaveLength(LIMITE_DE_CODIGOS_POR_PAREAMENTO);
  });

  it("o QR (sem número) não gasta o limite de códigos nem é segurado por ele", async () => {
    novoBanco([linhaPendente({ id: ID_1, pareamento_qr_codigos: LIMITE_DE_CODIGOS_POR_PAREAMENTO, pareamento_qr_codigo_em: new Date().toISOString() })]);
    expect(await renovar(null)).toMatchObject({ estado: "aguardando", qr: QR });
  });

  it("duas abas pedindo ao mesmo tempo: só uma passa", async () => {
    novoBanco([linhaPendente({ id: ID_1 })]);
    servidor.conectar = () => resposta(200, { instance: { status: "connecting", paircode: "ABCD-1234" } });
    const [a, b] = await Promise.all([renovar(), renovar()]);
    const passaram = [a, b].filter((r) => !("ok" in r));
    expect(passaram).toHaveLength(1);
    expect(sessoes()[0]).toMatchObject({ pareamento_qr_codigos: 1 });
    expect(so("POST", "/instance/connect")).toHaveLength(1);
  });
});

describe("B5: apagar pelo nome não apaga a instância de outro dono", () => {
  function criacaoIncerta(lista: unknown[]) {
    let nome = "";
    fetchMock.mockImplementation(async (input: string | URL, init?: RequestInit) => {
      const url = String(input).replace(SERVIDOR, "");
      const metodo = init?.method ?? "GET";
      if (metodo === "POST" && url === "/instance/create") {
        nome = (JSON.parse(String(init?.body)) as { name: string }).name;
        throw new Error("ECONNRESET");
      }
      if (metodo === "GET" && url === "/instance/all") return resposta(200, lista.map((i) => ({ ...(i as object), name: nome })));
      if (metodo === "DELETE" && url === "/instance") return resposta(200, {});
      throw new Error(`rota não prevista: ${metodo} ${url}`);
    });
  }

  it("duas instâncias com o mesmo nome: recusa apagar qualquer uma, avisa, e a linha é arquivada", async () => {
    criacaoIncerta([{ token: "tok-a", id: "inst-a" }, { token: "tok-b", id: "inst-b" }]);
    const r = await iniciarPareamento(admin(), { organizationId: ORG_A });

    expect(r).toMatchObject({ ok: false, codigo: "upstream_unavailable" });
    expect(so("DELETE", "/instance")).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("mais de uma instância com o mesmo nome"), expect.anything());
    expect(sessoes()[0]!.archived_at).toEqual(expect.any(String));
  });

  it("uma só com o nome e o id ainda desconhecido: apaga (é a órfã da criação incerta)", async () => {
    criacaoIncerta([{ token: "tok-orfa", id: "inst-orfa" }]);
    await iniciarPareamento(admin(), { organizationId: ORG_A });
    expect(so("DELETE", "/instance")[0]!.cabecalhos.token).toBe("tok-orfa");
  });

  it("com o id conhecido, a de mesmo nome mas de outro id é de outro dono: nada é apagado", async () => {
    novoBanco([
      linhaPendente({ pareamento_qr_iniciado_em: ha_31_minutos(), uazapi_token_encrypted: null, uazapi_instance_id: "inst-nossa" }),
    ]);
    const id = sessoes()[0]!.id as string;
    servidor.todas = [{ name: nomeDaInstancia(ORG_A, id), token: "tok-de-outro-dono", id: "inst-de-outro-dono" }];

    const r = await limparPareamentosVencidos(admin(), { urlDoWebhook: URL_DO_WEBHOOK });

    expect(so("GET", "/instance/all")).toHaveLength(1);
    expect(so("DELETE", "/instance")).toHaveLength(0);
    expect(r.limpos).toBe(1);
    expect(sessoes()[0]!.archived_at).toEqual(expect.any(String));
  });

  it("com o id conhecido e batendo com o do servidor, apaga com o token dessa instância", async () => {
    novoBanco([
      linhaPendente({ pareamento_qr_iniciado_em: ha_31_minutos(), uazapi_token_encrypted: null, uazapi_instance_id: "inst-nossa" }),
    ]);
    const id = sessoes()[0]!.id as string;
    servidor.todas = [{ name: nomeDaInstancia(ORG_A, id), token: "tok-nossa", id: "inst-nossa" }];

    await limparPareamentosVencidos(admin(), { urlDoWebhook: URL_DO_WEBHOOK });
    expect(so("DELETE", "/instance")[0]!.cabecalhos.token).toBe("tok-nossa");
  });
});

describe("remover uma conexão", () => {
  it("criada pelo CRM: apaga a instância no servidor", async () => {
    novoBanco([linhaPendente({ status: "WORKING", pareamento_qr_estado: "concluido" }, { uazapi_webhook_id: "wh-1" })]);
    const r = await removerConexaoPorInstancia(admin(), ORG_A, sessoes()[0]!.id as string);
    expect(r).toMatchObject({ ok: true, instanciaApagada: true, instanciaRestou: false });
    expect(so("DELETE", "/instance")[0]!.cabecalhos.token).toBe(TOKEN_DA_INSTANCIA);
    expect(sessoes()[0]!.archived_at).toEqual(expect.any(String));
  });

  it("criada pelo CRM mas o servidor não confirmou: arquiva e avisa que a instância restou", async () => {
    servidor.apagar = () => resposta(500, {});
    novoBanco([linhaPendente({ status: "WORKING", pareamento_qr_estado: "concluido" })]);
    const r = await removerConexaoPorInstancia(admin(), ORG_A, sessoes()[0]!.id as string);
    expect(r).toMatchObject({ ok: true, instanciaApagada: false, instanciaRestou: true });
    expect(sessoes()[0]!.archived_at).toEqual(expect.any(String));
  });

  it("conectada pelo cliente (sem a marca na coluna): só tira o nosso webhook, a instância é dele", async () => {
    novoBanco([conexaoComum({}, { uazapi_webhook_id: "wh-1" })]);
    const r = await removerConexaoPorInstancia(admin(), ORG_A, sessoes()[0]!.id as string);

    expect(r).toMatchObject({ ok: true, webhookRemovido: true, instanciaApagada: false, instanciaRestou: false });
    expect(so("DELETE", "/instance")).toHaveLength(0);
    expect(so("POST", "/webhook")[0]!.corpo).toEqual({ action: "delete", id: "wh-1" });
  });
});

describe("pendente não é conexão", () => {
  it("a lista de Conexões não mostra o pareamento ainda não lido", async () => {
    novoBanco([
      linhaPendente({ id: ID_1 }),
      linhaPendente({ id: ID_2, status: "WORKING", pareamento_qr_estado: "concluido" }),
    ]);
    const lista = await listarConexoesUazapi(admin(), ORG_A);
    expect(lista.map((c) => c.id)).toEqual([ID_2]);
  });
});

describe("chaves da instalação", () => {
  const dessas = ["UAZAPI_SERVIDOR_URL", "UAZAPI_ADMIN_TOKEN"];

  it("o catálogo as oferece como editáveis; o token é segredo cifrado e o endereço é texto", () => {
    const achadas = CATALOGO_DA_INSTALACAO.filter((c) => dessas.includes(c.chave));
    expect(achadas.map((c) => [c.chave, c.natureza, c.controle])).toEqual([
      ["UAZAPI_SERVIDOR_URL", "texto", "edita"],
      ["UAZAPI_ADMIN_TOKEN", "segredo", "edita"],
    ]);
  });

  it("o endereço só é aceito em https", async () => {
    const validar = CATALOGO_DA_INSTALACAO.find((c) => c.chave === "UAZAPI_SERVIDOR_URL")!.validar!;
    expect(await validar("https://qr.exemplo.com")).toBeNull();
    expect(await validar("http://qr.exemplo.com")).toMatch(/https/);
    expect(await validar("qr.exemplo.com")).not.toBeNull();
    expect(await validar("https://localhost")).not.toBeNull();
  });
});
