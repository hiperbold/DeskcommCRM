/**
 * D-117 (agrava o D-080): a chave da voz diz de quem ela é, e a queda da
 * credencial da organização para a chave da instalação deixa rastro no log.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
  decryptKey: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mocks.createAdminClient }));
vi.mock("@/lib/crypto/aes_gcm", () => ({
  byteaToBuffer: (v: unknown) => Buffer.from(String(v)),
  decryptKey: mocks.decryptKey,
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: mocks.warn, error: vi.fn(), debug: vi.fn() },
}));

import { getActiveVoiceAgent } from "@/lib/ai/agents";

function adminComCredencial(credencial: Record<string, unknown> | null, erro = false) {
  return {
    from: (tabela: string) => {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "not", "order", "limit"]) q[m] = () => q;
      if (tabela === "ai_agents") {
        q.maybeSingle = async () => ({
          data: { id: "ag-1", system_prompt: "p", config: {} },
          error: null,
        });
      } else if (tabela === "ai_provider_credentials") {
        q.maybeSingle = async () => {
          if (erro) throw new Error("banco fora");
          return { data: credencial, error: null };
        };
      }
      return q;
    },
  };
}

describe("getActiveVoiceAgent: origem da chave", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPENAI_API_KEY = "sk-da-instalacao";
  });

  it("credencial da organização: a chave é dela", async () => {
    mocks.decryptKey.mockReturnValue("sk-da-org");
    mocks.createAdminClient.mockReturnValue(
      adminComCredencial({ api_key_encrypted: "a", api_key_iv: "b", api_key_tag: "c" }),
    );
    const agente = await getActiveVoiceAgent("org-1");
    expect(agente?.apiKey).toBe("sk-da-org");
    expect(agente?.origemDaChave).toBe("credencial_da_organizacao");
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it("sem credencial cadastrada: chave da instalação", async () => {
    mocks.createAdminClient.mockReturnValue(adminComCredencial(null));
    const agente = await getActiveVoiceAgent("org-1");
    expect(agente?.apiKey).toBe("sk-da-instalacao");
    expect(agente?.origemDaChave).toBe("chave_da_instalacao");
  });

  it("credencial que falha: cai para a instalação e AVISA no log, sem vazar a chave", async () => {
    mocks.createAdminClient.mockReturnValue(adminComCredencial(null, true));
    const agente = await getActiveVoiceAgent("org-1");
    expect(agente?.origemDaChave).toBe("chave_da_instalacao");
    expect(mocks.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain("sk-");
  });
});
