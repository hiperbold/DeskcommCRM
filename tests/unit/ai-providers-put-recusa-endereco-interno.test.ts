/**
 * PUT /api/v1/ai/providers: o endereço do binding não alcança a rede interna.
 *
 * `base_url` do binding é escolha do admin de UMA organização, e quem chama esse
 * endereço é o servidor, com a chave dela no cabeçalho. A rota só conferia a
 * FORMA (`z.string().url()`), então `http://169.254.169.254/` ou um serviço do
 * compose ficavam gravados e o servidor fazia o POST para lá. Agora a gravação
 * passa pela MESMA régua do provedor personalizado (`motivoDaRecusaDeDestino`,
 * decisão 22-d) e recusa com 422 (como as outras recusas da rota) antes de tocar no banco.
 *
 * A asserção que importa é a ausência do `upsert`: recusa que gravasse mesmo
 * assim seria só mensagem bonita.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";

// O DNS é controlado aqui: a régua resolve o nome antes de aceitar, e o teste
// não pode depender da rede de quem roda. Nome fora do mapa resolve para IP
// público; `db` imita um serviço do compose e `virou-interno.exemplo` um nome
// público que passou a apontar para dentro.
const dns = vi.hoisted(() => ({
  mapa: { db: "172.18.0.5", "virou-interno.exemplo": "10.0.0.7" } as Record<string, string>,
}));
vi.mock("node:dns/promises", () => {
  const lookup = vi.fn(async (nome: string) => [{ address: dns.mapa[nome] ?? "93.184.216.34", family: 4 }]);
  return { lookup, default: { lookup } };
});

const CREDENCIAL_DA_ORG = "33333333-3333-4333-8333-333333333333";

const banco = vi.hoisted(() => ({
  upserts: [] as Array<Record<string, unknown>>,
  /** As credenciais que a organização tem, por id (provedor). */
  credenciais: {} as Record<string, string>,
}));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (tabela: string) => {
      let credencialPedida: string | null = null;
      const chain: Record<string, unknown> = {
        // Modelo fora do catálogo passa com aviso (validarBinding); é o que
        // este arquivo precisa, porque o assunto aqui é o endereço. A tabela de
        // credenciais responde só pelas que a organização tem.
        maybeSingle: async () => {
          if (tabela !== "ai_provider_credentials") return { data: null, error: null };
          const provedor = credencialPedida ? banco.credenciais[credencialPedida] : undefined;
          return { data: provedor ? { id: credencialPedida, provider: provedor } : null, error: null };
        },
        upsert: (linha: Record<string, unknown>) => {
          banco.upserts.push(linha);
          return {
            select: () => ({
              maybeSingle: async () => ({ data: { id: "22222222-2222-4222-8222-222222222222", ...linha }, error: null }),
            }),
          };
        },
      };
      chain.eq = (coluna: string, valor: string) => {
        if (coluna === "id") credencialPedida = valor;
        return chain;
      };
      for (const m of ["select", "is"]) chain[m] = () => chain;
      return chain;
    },
  }),
}));

import { PUT } from "@/app/api/v1/ai/providers/route";

function put(corpo: Record<string, unknown>) {
  return PUT(
    new Request("http://localhost/api/v1/ai/providers", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        purpose: "sentiment_classify",
        provider: "openrouter",
        model_id: "modelo-x",
        ...corpo,
      }),
    }) as never,
  );
}

beforeEach(() => {
  banco.upserts = [];
  banco.credenciais = { [CREDENCIAL_DA_ORG]: "openrouter" };
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "actor", idioma: "pt-BR" },
    org: { orgId: "11111111-1111-4111-8111-111111111111", role: "admin" },
  } as unknown as Awaited<ReturnType<typeof requireRole>>);
});

describe("PUT /api/v1/ai/providers, base_url", () => {
  // Em https de propósito: http é recusado antes de qualquer julgamento de
  // destino (caso próprio abaixo), e aqui se mede a recusa do destino interno.
  it.each([
    ["metadados de nuvem", "https://169.254.169.254/latest/meta-data"],
    ["localhost", "https://localhost:3000/v1"],
    ["loopback", "https://127.0.0.1:4000/v1"],
    ["rede privada 10.x", "https://10.0.0.5/v1"],
    ["serviço do compose (nome que resolve para IP privado)", "https://db:5432"],
    ["nome público que passou a apontar para dentro", "https://virou-interno.exemplo/v1"],
  ])("recusa %s com 422, mensagem em português, e NÃO grava", async (_rotulo, endereco) => {
    const res = await put({ base_url: endereco });

    expect(res.status).toBe(422);
    const corpo = (await res.json()) as { error: { code: string; message: string } };
    expect(corpo.error.code).toBe("base_url_recusada");
    expect(corpo.error.message).toMatch(/endereço/i);
    expect(corpo.error.message).toMatch(/rede interna/);
    expect(banco.upserts, "o endereço interno foi gravado").toHaveLength(0);
  });

  it("recusa http mesmo para host público, sem NODE_ENV=production, e NÃO grava", async () => {
    expect(process.env.NODE_ENV).not.toBe("production");
    const res = await put({ base_url: "http://gateway.exemplo/v1", credential_id: CREDENCIAL_DA_ORG });

    expect(res.status).toBe(422);
    const corpo = (await res.json()) as { error: { code: string; message: string } };
    expect(corpo.error.code).toBe("base_url_recusada");
    expect(corpo.error.message).toMatch(/https/);
    expect(banco.upserts).toHaveLength(0);
  });

  it("aceita https público COM a chave da própria empresa e grava o endereço", async () => {
    // Controle positivo: sem ele, uma rota que recusasse tudo passaria acima.
    const res = await put({ base_url: "https://gateway.exemplo/v1", credential_id: CREDENCIAL_DA_ORG });

    expect(res.status).toBe(200);
    expect(banco.upserts).toHaveLength(1);
    expect(banco.upserts[0]).toMatchObject({
      base_url: "https://gateway.exemplo/v1",
      credential_id: CREDENCIAL_DA_ORG,
    });
  });

  it("recusa base_url SEM credential_id com 422 e mensagem clara, e NÃO grava", async () => {
    // Sem chave própria o uso cairia na chave do .env (a que paga todas as
    // empresas) e ela sairia para o endereço que a empresa escolheu.
    for (const semChave of [{}, { credential_id: null }]) {
      const res = await put({ base_url: "https://gateway.exemplo/v1", ...semChave });

      expect(res.status).toBe(422);
      const corpo = (await res.json()) as { error: { code: string; message: string } };
      expect(corpo.error.code).toBe("base_url_exige_chave_da_empresa");
      expect(corpo.error.message).toMatch(/chave da própria empresa/);
    }
    expect(banco.upserts, "gravou endereço próprio sem chave da empresa").toHaveLength(0);
  });

  it("base_url com credential_id de OUTRA organização continua recusada e não grava", async () => {
    const res = await put({
      base_url: "https://gateway.exemplo/v1",
      credential_id: "44444444-4444-4444-8444-444444444444",
    });

    expect(res.status).toBe(422);
    const corpo = (await res.json()) as { error: { code: string } };
    expect(corpo.error.code).toBe("credencial_invalida");
    expect(banco.upserts).toHaveLength(0);
  });

  it("sem base_url continua gravando (a régua só julga endereço de empresa)", async () => {
    const res = await put({});

    expect(res.status).toBe(200);
    expect(banco.upserts).toHaveLength(1);
    expect(banco.upserts[0]).toMatchObject({ base_url: null });
  });
});
