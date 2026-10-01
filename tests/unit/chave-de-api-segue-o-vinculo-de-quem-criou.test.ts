/**
 * D-101: a chave `dsk_` continuava valendo depois que quem a criou foi removido
 * ou rebaixado, e os escopos eram texto livre.
 *
 * Prova:
 *  1. o autenticador recusa a chave cujo criador perdeu o vínculo, ou tem papel
 *     abaixo do `role:` que a chave declara; mantém a chave de criador em dia e
 *     a de admin de plataforma ativo; falha de leitura é `lookup_failed`;
 *  2. o schema de criação só aceita escopos da lista fechada: `actor:ai_agent`
 *     e `agent_run:<uuid>` (autoria de agente) não saem de um formulário.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { createAdminClient } from "@/lib/supabase/admin";
import { resolveApiToken } from "@/lib/mcp/auth";
import { createApiTokenSchema } from "@/lib/schemas/team";

const ORG = "bbbbbbbb-2222-4222-8222-222222222222";
const CRIADOR = "cccccccc-3333-4333-8333-333333333333";
const PLAINTEXT = "dsk_abcd_segredo";

interface Cenario {
  escopos: string[];
  vinculo: { role: string } | null;
  erroDoVinculo?: string;
  plataforma?: boolean;
}

function armar({ escopos, vinculo, erroDoVinculo, plataforma = false }: Cenario) {
  const consultadas: string[] = [];
  vi.mocked(createAdminClient).mockReturnValue({
    from: (tabela: string) => {
      consultadas.push(tabela);
      const c: Record<string, unknown> = {};
      for (const m of ["select", "eq", "is"]) c[m] = () => c;
      c.update = () => ({ eq: () => ({ then: (r: (v: unknown) => unknown) => r({ error: null }) }) });
      c.maybeSingle = async () => {
        if (tabela === "api_tokens") {
          return {
            data: {
              id: "tok-1",
              organization_id: ORG,
              scopes: escopos,
              revoked_at: null,
              expires_at: null,
              created_by: CRIADOR,
              organizations: { status: "active" },
            },
            error: null,
          };
        }
        if (tabela === "user_organizations") {
          return erroDoVinculo
            ? { data: null, error: { message: erroDoVinculo } }
            : { data: vinculo, error: null };
        }
        if (tabela === "platform_admins") {
          return { data: plataforma ? { user_id: CRIADOR } : null, error: null };
        }
        throw new Error(`tabela inesperada: ${tabela}`);
      };
      return c;
    },
  } as never);
  return consultadas;
}

const reason = (p: Promise<unknown>) =>
  p.then(
    () => "aceito",
    (e: { reason?: string }) => e.reason ?? "erro",
  );

beforeEach(() => vi.clearAllMocks());

describe("D-101 chave de API e vínculo do criador", () => {
  it("criador admin ativo: a chave role:admin vale", async () => {
    armar({ escopos: ["mcp:read", "role:admin"], vinculo: { role: "admin" } });
    expect(await reason(resolveApiToken(PLAINTEXT))).toBe("aceito");
  });

  it("criador removido (sem vínculo ativo): a chave deixa de valer", async () => {
    armar({ escopos: ["mcp:read", "mcp:write", "role:admin"], vinculo: null });
    expect(await reason(resolveApiToken(PLAINTEXT))).toBe("creator_inactive");
  });

  it("criador rebaixado abaixo do papel da chave: deixa de valer", async () => {
    armar({ escopos: ["mcp:read", "role:admin"], vinculo: { role: "agent" } });
    expect(await reason(resolveApiToken(PLAINTEXT))).toBe("creator_inactive");
  });

  it("criador rebaixado, mas ainda no papel da chave: segue valendo", async () => {
    armar({ escopos: ["mcp:read", "role:agent"], vinculo: { role: "manager" } });
    expect(await reason(resolveApiToken(PLAINTEXT))).toBe("aceito");
  });

  it("chave sem `role:` vale como agent: viewer não a sustenta", async () => {
    armar({ escopos: ["mcp:read"], vinculo: { role: "viewer" } });
    expect(await reason(resolveApiToken(PLAINTEXT))).toBe("creator_inactive");
  });

  it("criador sem vínculo mas admin de plataforma ativo: segue valendo", async () => {
    armar({ escopos: ["mcp:read", "role:admin"], vinculo: null, plataforma: true });
    expect(await reason(resolveApiToken(PLAINTEXT))).toBe("aceito");
  });

  it("falha ao ler o vínculo não vira chave aceita: lookup_failed", async () => {
    armar({ escopos: ["mcp:read"], vinculo: null, erroDoVinculo: "connection reset" });
    expect(await reason(resolveApiToken(PLAINTEXT))).toBe("lookup_failed");
  });
});

describe("D-101 escopos: lista fechada", () => {
  const criar = (scopes: string[]) =>
    createApiTokenSchema.safeParse({ name: "Integração", scopes }).success;

  it("aceita o catálogo da tela e os papéis humanos", () => {
    expect(criar(["mcp:read", "mcp:write", "role:manager", "messages:on_behalf"])).toBe(true);
  });

  it("recusa a autoria de agente forjada", () => {
    expect(criar(["mcp:read", "actor:ai_agent"])).toBe(false);
    expect(criar(["mcp:write", "agent_run:11111111-1111-4111-8111-111111111111"])).toBe(false);
  });

  it("recusa escopo desconhecido e papel inexistente ou reservado ao runtime", () => {
    expect(criar(["qualquer:coisa"])).toBe(false);
    expect(criar(["role:superuser"])).toBe(false);
    expect(criar(["role:ai_operator"])).toBe(false);
  });
});
