/**
 * D-065 (`hiperbold/DEBITO.md`): `workers/voice-agent/index.ts` rodava
 * `main()` no IMPORT (abre ARI e a porta real do AudioSocket), então o portão
 * "organização em modo leitura não abre sessão de IA" (mesmo caminho de "sem
 * agente ativo") nunca tinha teste automatizado. `main()` agora só roda atrás
 * de `require.main === module`; `handleAudioSocketConnection` é exportada
 * para este arquivo exercitar o portão sem abrir ARI nem porta nenhuma.
 *
 * Usa a implementação REAL de `contaEmModoLeitura` (não mockada): o dublê do
 * client admin cobre as duas tabelas que ela e o worker leem
 * (`billing_settings`/`rpc fn_billing_modo_leitura` e `voice_calls`), para o
 * caminho de falha (fail-open) ser medido de ponta a ponta, não só suposto.
 *
 * Molde de `tests/unit/automation-resend-modo-leitura.test.ts` (dublê do
 * client admin só com o que `contaEmModoLeitura` lê) e de
 * `tests/unit/prospecting-tick-modo-leitura.test.ts` (isolamento das
 * dependências de envio/sessão via `vi.mock`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Socket } from "node:net";

const mocks = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
  connectAriEvents: vi.fn(),
  hangupChannel: vi.fn(),
  setChannelVariable: vi.fn(),
  continueDialplan: vi.fn(),
  resolveOrCreateCallerContact: vi.fn(),
  garantirLeadDaConversa: vi.fn(),
  getActiveVoiceAgent: vi.fn(),
  buscarConhecimento: vi.fn(),
  resolverAcervoDoAgente: vi.fn(),
  bridgeCtor: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mocks.createAdminClient }));
vi.mock("@/lib/voip/ariClient", () => ({
  connectAriEvents: mocks.connectAriEvents,
  hangupChannel: mocks.hangupChannel,
  setChannelVariable: mocks.setChannelVariable,
  continueDialplan: mocks.continueDialplan,
}));
vi.mock("@/lib/voip/resolve-caller", () => ({
  resolveOrCreateCallerContact: mocks.resolveOrCreateCallerContact,
}));
vi.mock("@/lib/leads/nascimento-do-lead", () => ({
  garantirLeadDaConversa: mocks.garantirLeadDaConversa,
}));
vi.mock("@/lib/ai/agents", () => ({ getActiveVoiceAgent: mocks.getActiveVoiceAgent }));
vi.mock("@/lib/ai/knowledge/busca", () => ({
  buscarConhecimento: mocks.buscarConhecimento,
  resolverAcervoDoAgente: mocks.resolverAcervoDoAgente,
}));
// Caminho relativo em index.ts ("./audioSocketBridge") resolve para o mesmo
// arquivo que este alias: vi.mock casa pelo módulo resolvido, não pela grafia.
vi.mock("@/workers/voice-agent/audioSocketBridge", () => ({
  AudioSocketCallBridge: mocks.bridgeCtor,
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: mocks.loggerError, debug: vi.fn() },
}));

const ORG_ID = "10000000-0000-4000-8000-000000000001";
const UUID = "20000000-0000-4000-8000-000000000002";
const CALL_ROW = { id: "call-row-1", organization_id: ORG_ID, asterisk_channel_id: UUID };

/**
 * Dublê do client admin: só as duas tabelas/rpc que `contaEmModoLeitura`
 * (`lib/billing/assinatura/modo-leitura.ts`, via `modoDeBillingCacheado`) e
 * `handleAudioSocketConnection` leem de verdade.
 */
function adminStub(opts: {
  modo: string | null;
  modoErro?: string;
  modoLeituraRpc?: boolean;
  rpcErro?: string;
}) {
  return {
    from: (tabela: string) => {
      if (tabela === "billing_settings") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () =>
                opts.modoErro
                  ? { data: null, error: { message: opts.modoErro } }
                  : { data: { modo: opts.modo }, error: null },
            }),
          }),
        };
      }
      if (tabela === "voice_calls") {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({ data: CALL_ROW, error: null }),
            }),
          }),
          update: () => ({
            eq: async () => ({ data: null, error: null }),
          }),
        };
      }
      throw new Error(`tabela inesperada no dublê admin: ${tabela}`);
    },
    rpc: async (nome: string) => {
      if (nome === "fn_billing_modo_leitura") {
        return opts.rpcErro
          ? { data: null, error: { message: opts.rpcErro } }
          : { data: opts.modoLeituraRpc ?? false, error: null };
      }
      throw new Error(`rpc inesperada no dublê admin: ${nome}`);
    },
  };
}

function fakeSocket() {
  return { end: vi.fn(), emit: vi.fn() } as unknown as Socket;
}

/** Recarrega o worker do zero: `supabaseAdmin` é singleton de módulo, e o
 * cache de 60s de `modoDeBillingCacheado` é uma WeakMap por client; sem
 * `resetModules`, o segundo teste leria o `modo` cacheado do primeiro. */
async function importWorker(admin: ReturnType<typeof adminStub>) {
  vi.resetModules();
  mocks.createAdminClient.mockReturnValue(admin);
  return import("@/workers/voice-agent/index");
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getActiveVoiceAgent.mockResolvedValue({
    id: "agent-1",
    systemPrompt: "prompt de teste",
    voice: "alloy",
    voiceSpeed: 1,
    voiceModel: "gpt-realtime",
    apiKey: "sk-test-nunca-real",
    ragTopK: 3,
    ragSimilarityThreshold: 0.5,
  });
  mocks.resolverAcervoDoAgente.mockResolvedValue([]);
  mocks.bridgeCtor.mockImplementation(function FakeBridge() {
    return {};
  });
});

describe("workers/voice-agent: portão de conta suspensa (D-065)", () => {
  it("modo leitura ativo: encerra o socket sem abrir a sessão de IA", async () => {
    const { handleAudioSocketConnection } = await importWorker(
      adminStub({ modo: "bloquear", modoLeituraRpc: true }),
    );
    const socket = fakeSocket();

    await handleAudioSocketConnection(socket, UUID, Buffer.alloc(0));

    expect(socket.end).toHaveBeenCalledTimes(1);
    expect(mocks.getActiveVoiceAgent).not.toHaveBeenCalled();
    expect(mocks.bridgeCtor).not.toHaveBeenCalled();
  });

  it("modo avisar (fora do bloqueio): segue e abre a sessão de IA", async () => {
    const { handleAudioSocketConnection } = await importWorker(adminStub({ modo: "avisar" }));
    const socket = fakeSocket();

    await handleAudioSocketConnection(socket, UUID, Buffer.alloc(0));

    expect(socket.end).not.toHaveBeenCalled();
    expect(mocks.getActiveVoiceAgent).toHaveBeenCalledWith(ORG_ID);
    expect(mocks.bridgeCtor).toHaveBeenCalledTimes(1);
  });

  it("falha ao ler o modo (RPC do banco erra): segue como se não estivesse bloqueada (fail-open)", async () => {
    const { handleAudioSocketConnection } = await importWorker(
      adminStub({ modo: "bloquear", rpcErro: "tempo esgotado" }),
    );
    const socket = fakeSocket();

    await handleAudioSocketConnection(socket, UUID, Buffer.alloc(0));

    expect(socket.end).not.toHaveBeenCalled();
    expect(mocks.getActiveVoiceAgent).toHaveBeenCalledWith(ORG_ID);
    expect(mocks.bridgeCtor).toHaveBeenCalledTimes(1);
    // contaEmModoLeitura grita o alarme (doutrina de fail-open): a falha não
    // pode passar despercebida, mesmo a ligação seguindo normalmente.
    expect(mocks.loggerError).toHaveBeenCalledWith(
      "alarme_planos_leitura",
      expect.objectContaining({ organization_id: ORG_ID }),
    );
  });
});
