/**
 * D-084 (M3): o código cru da régua de destino não chega a quem é da organização.
 *
 * `unsafe_url:dns_failed` ("o nome não resolve") e `unsafe_url:private_ip` ("o
 * nome resolve para IP interno") diferem por exatamente uma informação: o nome
 * existe na rede interna do compose ou não. Quem administra uma empresa
 * sondava, por tentativa, quais nomes de serviço existem. Os quatro pontos por
 * onde o código chegava (credenciais de IA, resultado de webhook de automação,
 * aviso da Central) gravam e devolvem UM código só.
 *
 * O que se mede é o valor que sai (coluna gravada, resposta, corpo do
 * `actions_result`), com a régua de destino de verdade e só o DNS simulado.
 * O controle de cada caso é o código que NÃO denuncia a rede, que segue cru, e
 * a origem instalação, que segue distinguindo.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const DNS: Record<string, string[]> = {
  "publico.exemplo": ["93.184.216.34"],
  "redis-interno.exemplo": ["10.0.0.5"],
  "vazio.exemplo": [],
};
vi.mock("node:dns/promises", () => {
  const lookup = async (host: string) => {
    const enderecos = DNS[host];
    if (!enderecos) throw new Error("ENOTFOUND");
    return enderecos.map((address) => ({ address, family: 4 }));
  };
  // O default é obrigatório: sem ele o vitest recusa o mock na coleta.
  return { lookup, default: { lookup } };
});

const avisos = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: avisos }));
vi.mock("@/lib/env", () => ({ env: { IA_DESTINOS_INTERNOS_PERMITIDOS: "" } }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/ai/provider-validators", () => ({ validateProviderKey: vi.fn() }));
vi.mock("@/lib/crypto/aes_gcm", () => ({
  byteaToBuffer: () => Buffer.from(""),
  decryptKey: () => "sk-decifrada",
  bufToBytea: () => "\\x00",
  encryptKey: () => ({
    ciphertext: Buffer.from("c"),
    iv: Buffer.from("i"),
    tag: Buffer.from("t"),
    last4: "ABCD",
  }),
}));
vi.mock("@/lib/webhooks/secrets", () => ({ decryptWebhookSecret: async () => null }));

import { POST as revalidar } from "@/app/api/v1/ai/credentials/[id]/revalidate/route";
import { GET as listar } from "@/app/api/v1/ai/credentials/route";
import { descreverErroDeValidacao } from "@/lib/ai/credenciais/erro-de-validacao";
import { guardarCredencial } from "@/lib/ai/credenciais/guardar";
import { validateProviderKey } from "@/lib/ai/provider-validators";
import { executeCallWebhook } from "@/lib/automation/actions/call-webhook";
import {
  codigoNuloParaOrganizacao,
  codigoParaOrganizacao,
  DESTINO_RECUSADO,
} from "@/lib/automation/destino-recusado";
import { motivoDaRecusaDeDestino } from "@/lib/automation/destinos-internos-autorizados";
import type { ActionCtx } from "@/lib/automation/types";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

const ORG = "11111111-1111-4111-8111-111111111111";
const ID = "22222222-2222-4222-8222-222222222222";

/** Os três códigos que separam "não resolve" de "rede interna", como a régua os produz. */
const OS_TRES = ["unsafe_url:dns_failed", "unsafe_url:dns_empty", "unsafe_url:private_ip"] as const;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    org: { orgId: ORG, role: "admin", name: "Org" },
    user: { id: "actor", idioma: "pt-BR" },
  } as Awaited<ReturnType<typeof requireRole>>);
});

describe("o ponto único: codigoParaOrganizacao", () => {
  it("os três códigos que denunciam a rede viram UM código", () => {
    const vistos = OS_TRES.map(codigoParaOrganizacao);
    expect(new Set(vistos)).toEqual(new Set([DESTINO_RECUSADO]));
    expect(DESTINO_RECUSADO).toBe("unsafe_url:destino_recusado");
  });

  it("controle: os outros códigos seguem crus (https, redirect, literal privado, erro do provedor)", () => {
    for (const cru of [
      "unsafe_url:https_required",
      "unsafe_url:redirect_not_followed",
      "unsafe_url:private_host",
      "auth_failed_401",
      "provider_status_503",
    ]) {
      expect(codigoParaOrganizacao(cru)).toBe(cru);
    }
    expect(codigoNuloParaOrganizacao(null)).toBeNull();
    expect(codigoNuloParaOrganizacao(undefined)).toBeNull();
    expect(codigoNuloParaOrganizacao("unsafe_url:private_ip")).toBe(DESTINO_RECUSADO);
  });

  it("a régua de verdade produz os três, e o ponto único os junta", async () => {
    const produzidos = await Promise.all(
      ["https://naoexiste.exemplo/x", "https://vazio.exemplo/x", "https://redis-interno.exemplo/x"].map((u) =>
        motivoDaRecusaDeDestino(u, "organizacao"),
      ),
    );
    // Controle de vacuidade: a régua AINDA distingue (o log do servidor precisa disso).
    expect(produzidos).toEqual([...OS_TRES]);
    expect(new Set(produzidos.map((c) => codigoParaOrganizacao(c as string))).size).toBe(1);
  });
});

describe("a tela: o código novo mostra a frase certa", () => {
  it("nas duas origens, o código único vira a frase única de endereço não aceito", () => {
    const daOrganizacao = descreverErroDeValidacao(DESTINO_RECUSADO, "custom", "organizacao");
    const daInstalacao = descreverErroDeValidacao(DESTINO_RECUSADO, "custom", "instalacao");
    const padrao = descreverErroDeValidacao(DESTINO_RECUSADO, "custom");
    expect(daOrganizacao.frase).toMatch(/rede interna/);
    expect(daOrganizacao.generico).toBe(false);
    expect(daOrganizacao.chaveErrada).toBe(false);
    expect(daInstalacao.frase).toBe(daOrganizacao.frase);
    expect(padrao.frase).toBe(daOrganizacao.frase);
  });

  it("é a MESMA frase que os três códigos crus (linha antiga do banco) dão à organização", () => {
    const nova = descreverErroDeValidacao(DESTINO_RECUSADO, "custom", "organizacao").frase;
    for (const cru of OS_TRES) {
      expect(descreverErroDeValidacao(cru, "custom", "organizacao").frase).toBe(nova);
    }
  });

  it("origem INSTALAÇÃO com os códigos crus: continua distinguindo, como antes", () => {
    const frases = OS_TRES.map((c) => descreverErroDeValidacao(c, undefined, "instalacao").frase);
    expect(new Set(frases).size).toBe(2);
  });
});

function ctxDeAutomacao(): ActionCtx {
  return {
    admin: {} as ActionCtx["admin"],
    organizationId: "org-1",
    ruleId: "rule-1",
    ruleName: "Automação de teste",
    requestId: "req-1",
    event: {
      id: "evt-1",
      organization_id: "org-1",
      event_type: "lead.created",
      entity_kind: "crm_lead",
      entity_id: "lead-1",
      payload: {},
      metadata: {},
      consumed_by: [],
      attempts: 0,
    },
    context: { lead: { id: "lead-1", title: "Fulano" } },
  };
}

describe("call_webhook: o `error` que vai para actions_result", () => {
  it.each([
    ["nome que não resolve", "https://naoexiste.exemplo/hook"],
    ["nome sem endereço", "https://vazio.exemplo/hook"],
    ["nome que resolve para IP interno", "https://redis-interno.exemplo/hook"],
  ])("%s: o mesmo código único", async (_nome, url) => {
    const r = await executeCallWebhook(ctxDeAutomacao(), { url });
    expect(r.status).toBe("failed");
    expect(r.error).toBe(DESTINO_RECUSADO);
  });

  it("o motivo real fica no log do servidor", async () => {
    await executeCallWebhook(ctxDeAutomacao(), { url: "https://redis-interno.exemplo/hook" });
    expect(avisos.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ motivo: "unsafe_url:private_ip" }),
    );
  });

  it("controle: recusa que não denuncia a rede segue crua (http, literal privado)", async () => {
    const http = await executeCallWebhook(ctxDeAutomacao(), { url: "http://publico.exemplo/hook" });
    expect(http.error).toBe("unsafe_url:https_required");
    const literal = await executeCallWebhook(ctxDeAutomacao(), { url: "https://127.0.0.1/hook" });
    expect(literal.error).toBe("unsafe_url:private_host");
    expect(avisos.warn).not.toHaveBeenCalled();
  });
});

/** Admin de mentira que grava os UPDATEs e responde a linha bruta/segura. */
function fakeAdmin(respostas: Record<string, { data?: unknown; error?: unknown }>) {
  const updates: Record<string, unknown>[] = [];
  const admin = {
    updates,
    from(tabela: string) {
      let op = "select";
      const responder = () => respostas[`${tabela}:${op}`] ?? respostas[tabela] ?? { data: null, error: null };
      const chain: Record<string, unknown> = {
        select: () => chain,
        insert: () => {
          op = "insert";
          return chain;
        },
        eq: () => chain,
        update: (patch: Record<string, unknown>) => {
          op = "update";
          updates.push(patch);
          return chain;
        },
        maybeSingle: async () => responder(),
        single: async () => responder(),
        then: (resolve: (v: unknown) => unknown) => Promise.resolve(responder()).then(resolve),
      };
      return chain;
    },
  };
  vi.mocked(createAdminClient).mockReturnValue(admin as unknown as ReturnType<typeof createAdminClient>);
  return admin;
}

const linhaBruta = {
  id: ID,
  organization_id: ORG,
  provider: "custom",
  label: "Gateway",
  api_key_encrypted: "\\x00",
  api_key_iv: "\\x00",
  api_key_tag: "\\x00",
  is_active: true,
  base_url: "https://redis-interno.exemplo/v1",
};

function invocarRevalidar() {
  return revalidar(
    new NextRequest(`http://localhost/api/v1/ai/credentials/${ID}/revalidate`, { method: "POST" }),
    { params: Promise.resolve({ id: ID }) },
  );
}

describe("credenciais de IA: revalidar", () => {
  it.each(OS_TRES)("%s: coluna gravada e auditoria levam o código único; o log guarda o real", async (cru) => {
    vi.mocked(validateProviderKey).mockResolvedValue({ ok: false, error: cru } as Awaited<
      ReturnType<typeof validateProviderKey>
    >);
    const admin = fakeAdmin({
      "ai_provider_credentials:select": { data: linhaBruta, error: null },
      "ai_provider_credentials:update": {
        data: { id: ID, validation_error: DESTINO_RECUSADO },
        error: null,
      },
    });

    const res = await invocarRevalidar();
    expect(res.status).toBe(200);

    expect(admin.updates[0]).toMatchObject({ validated_at: null, validation_error: DESTINO_RECUSADO });
    expect(JSON.stringify(admin.updates)).not.toContain(cru);
    const meta = vi.mocked(audit).mock.calls[0]?.[0]?.metadata as { error: string | null };
    expect(meta.error).toBe(DESTINO_RECUSADO);
    expect(avisos.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ motivo: cru }),
    );
  });

  it("controle: erro que não denuncia a rede é gravado como veio", async () => {
    for (const erro of ["auth_failed_401", "unsafe_url:redirect_not_followed", "unsafe_url:https_required"]) {
      vi.mocked(validateProviderKey).mockResolvedValue({ ok: false, error: erro } as Awaited<
        ReturnType<typeof validateProviderKey>
      >);
      const admin = fakeAdmin({
        "ai_provider_credentials:select": { data: linhaBruta, error: null },
        "ai_provider_credentials:update": { data: { id: ID }, error: null },
      });
      await invocarRevalidar();
      expect(admin.updates[0]).toMatchObject({ validation_error: erro });
    }
  });
});

describe("credenciais de IA: validação em segundo plano do cadastro", () => {
  it.each(OS_TRES)("%s: a coluna leva o código único", async (cru) => {
    vi.mocked(validateProviderKey).mockResolvedValue({ ok: false, error: cru } as Awaited<
      ReturnType<typeof validateProviderKey>
    >);
    const admin = fakeAdmin({
      "ai_provider_credentials:insert": { data: { id: ID }, error: null },
      "ai_provider_credentials:select": { data: { base_url: "https://redis-interno.exemplo/v1" }, error: null },
    });

    const r = await guardarCredencial({
      admin: admin as unknown as ReturnType<typeof createAdminClient>,
      orgId: ORG,
      userId: "actor",
      provider: "custom",
      label: "Gateway",
      apiKey: "sk-uma-chave-de-teste",
      baseUrl: "https://redis-interno.exemplo/v1",
    });
    expect(r.ok).toBe(true);
    // A validação é fire-and-forget: espera os microtasks do UPDATE.
    await vi.waitFor(() => expect(admin.updates.length).toBe(1));

    expect(admin.updates[0]).toMatchObject({ validated_at: null, validation_error: DESTINO_RECUSADO });
    expect(JSON.stringify(admin.updates)).not.toContain(cru);
  });
});

describe("credenciais de IA: a listagem", () => {
  it("linha antiga com código cru sai com o código único; o resto da linha fica igual", async () => {
    const linhas = [
      { id: "a", provider: "custom", validation_error: "unsafe_url:dns_failed", label: "A" },
      { id: "b", provider: "custom", validation_error: "unsafe_url:private_ip", label: "B" },
      { id: "c", provider: "anthropic", validation_error: "auth_failed_401", label: "C" },
      { id: "d", provider: "anthropic", validation_error: null, label: "D" },
    ];
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      order: async () => ({ data: linhas, error: null }),
    };
    vi.mocked(createClient).mockResolvedValue({ from: () => chain } as unknown as Awaited<
      ReturnType<typeof createClient>
    >);

    const res = await listar();
    const corpo = (await res.json()) as { data: typeof linhas };
    expect(corpo.data.map((l) => l.validation_error)).toEqual([
      DESTINO_RECUSADO,
      DESTINO_RECUSADO,
      "auth_failed_401",
      null,
    ]);
    expect(corpo.data.map((l) => l.label)).toEqual(["A", "B", "C", "D"]);
  });
});
