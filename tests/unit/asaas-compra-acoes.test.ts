/**
 * `app/actions/settings/compraDoPlano.ts` (fase F5, Tarefa 15).
 *
 * `iniciarCompra`/`cancelarAssinaturaDoCliente` (`lib/billing/asaas/
 * compra.ts`) já têm a suíte própria (`asaas-compra.test.ts`, Tarefa 14):
 * aqui os dois são DUBLÊS, porque o que este arquivo prova é a CAMADA DA
 * AÇÃO: sessão, papel, as duas chaves da decisão 18, IDOR e auditoria,
 * nunca a lógica de compra em si. Nenhuma chamada real ao Asaas: nem a ação
 * nem os dublês tocam rede (o `fetch` nunca é usado quando `iniciarCompra`/
 * `cancelarAssinaturaDoCliente` estão mockados).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "22222222-2222-4222-8222-222222222222";
const OUTRA_ORG = "33333333-3333-4333-8333-333333333333";
const USER = "11111111-1111-4111-8111-111111111111";
const CHAVE = "44444444-4444-4444-8444-444444444444";

let papel = "admin";
let ehPlatformAdmin = false;
let supportBloqueado = false;
let habilitado = true;
let configValida = true;
let compraLigadaValor = true;

const auditadas: Array<Record<string, unknown>> = [];
const chamadasIniciar: Array<Record<string, unknown>> = [];
const chamadasCancelar: Array<{ org: string; actor: string }> = [];

let resultadoIniciar: unknown = { tipo: "redirecionar", url: "https://sandbox.asaas.com/i/fake" };
let resultadoCancelar: unknown = { tipo: "ok", cancelAtPeriodEnd: true };

vi.mock("next/headers", () => ({
  headers: async () => new Map<string, string>([["x-request-id", "req-teste"]]),
}));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async (e: Record<string, unknown>) => {
    auditadas.push(e);
  }),
}));
vi.mock("@/lib/impersonate/support", () => ({
  supportWriteError: vi.fn(() => (supportBloqueado ? "bloqueado" : null)),
}));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(async () => ({ id: USER, is_platform_admin: ehPlatformAdmin, support: null })),
  resolveActiveOrg: vi.fn(async () => ({ orgId: ORG, name: "Org Teste", role: papel })),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ marca: "admin-falso" }) }));
vi.mock("@/lib/billing/asaas/db-compra-supabase", () => ({ dbCompraSupabase: vi.fn(() => ({ marca: "db-falso" })) }));
vi.mock("@/lib/billing/asaas/cliente", () => ({ criarClienteAsaas: vi.fn(() => ({ marca: "asaas-falso" })) }));
vi.mock("@/lib/billing/asaas/config", () => ({
  configDoAsaas: vi.fn(() => {
    if (!configValida) throw new Error("ASAAS_API_KEY e ASAAS_BASE_URL apontam para ambientes diferentes");
    return {
      habilitado,
      baseUrl: "https://api-sandbox.asaas.com/v3",
      apiKey: "$aact_hmlg_x",
      webhookToken: "t",
      webhookId: "",
      ambiente: "sandbox" as const,
    };
  }),
  compraLigada: vi.fn(async () => compraLigadaValor),
}));
vi.mock("@/lib/billing/asaas/compra", () => ({
  iniciarCompra: vi.fn(async (_deps: unknown, entrada: Record<string, unknown>) => {
    chamadasIniciar.push(entrada);
    return resultadoIniciar;
  }),
  cancelarAssinaturaDoCliente: vi.fn(async (_deps: unknown, org: string, actor: string) => {
    chamadasCancelar.push({ org, actor });
    return resultadoCancelar;
  }),
}));

import { cancelarAssinatura, comprarPacote, iniciarAssinatura } from "@/app/actions/settings/compraDoPlano";

const ENTRADA_ASSINATURA = {
  planCode: "pro",
  ciclo: "monthly" as const,
  metodo: "CREDIT_CARD" as const,
  chave: CHAVE,
};

const ENTRADA_PACOTE = {
  pacote: "mil_tokens",
  metodo: "PIX" as const,
  chave: CHAVE,
};

const PAGADOR = {
  nome: "Fulano de Tal",
  documento: "111.444.777-35",
  email: "fulano@example.com",
  celular: "11999998888",
};

beforeEach(() => {
  papel = "admin";
  ehPlatformAdmin = false;
  supportBloqueado = false;
  habilitado = true;
  configValida = true;
  compraLigadaValor = true;
  auditadas.length = 0;
  chamadasIniciar.length = 0;
  chamadasCancelar.length = 0;
  resultadoIniciar = { tipo: "redirecionar", url: "https://sandbox.asaas.com/i/fake" };
  resultadoCancelar = { tipo: "ok", cancelAtPeriodEnd: true };
});

describe("compraDoPlano: só o papel admin da organização compra e cancela (N41)", () => {
  for (const papelSemPoder of ["viewer", "agent", "manager"]) {
    it(`${papelSemPoder} recebe erro e não chama iniciarCompra`, async () => {
      papel = papelSemPoder;
      const r = await iniciarAssinatura(ENTRADA_ASSINATURA);
      expect(r.tipo).toBe("erro");
      expect(chamadasIniciar).toEqual([]);
      expect(auditadas).toEqual([]);
    });

    it(`${papelSemPoder} recebe erro e não chama cancelarAssinaturaDoCliente`, async () => {
      papel = papelSemPoder;
      const r = await cancelarAssinatura();
      expect(r.tipo).toBe("erro");
      expect(chamadasCancelar).toEqual([]);
    });
  }

  it("platform admin passa mesmo sem papel de admin no tenant", async () => {
    papel = "viewer";
    ehPlatformAdmin = true;
    const r = await iniciarAssinatura(ENTRADA_ASSINATURA);
    expect(r.tipo).not.toBe("erro");
    expect(chamadasIniciar.length).toBe(1);
  });

  it("sessão de suporte em modo só-leitura/encerrada não compra nem cancela", async () => {
    supportBloqueado = true;
    const r1 = await iniciarAssinatura(ENTRADA_ASSINATURA);
    const r2 = await cancelarAssinatura();
    expect(r1.tipo).toBe("erro");
    expect(r2.tipo).toBe("erro");
    expect(chamadasIniciar).toEqual([]);
    expect(chamadasCancelar).toEqual([]);
  });
});

describe("compraDoPlano: organização SEMPRE da sessão (IDOR)", () => {
  it("um organizationId injetado na entrada é ignorado: a chamada usa o org da SESSÃO", async () => {
    const entradaComOutraOrg = { ...ENTRADA_ASSINATURA, organizationId: OUTRA_ORG };
    const r = await iniciarAssinatura(entradaComOutraOrg as never);
    expect(r.tipo).not.toBe("erro");
    expect(chamadasIniciar.length).toBe(1);
    expect(chamadasIniciar[0]!.organizationId).toBe(ORG);
    expect(chamadasIniciar[0]!.organizationId).not.toBe(OUTRA_ORG);
  });

  it("o mesmo vale para comprarPacote", async () => {
    const entradaComOutraOrg = { ...ENTRADA_PACOTE, organizationId: OUTRA_ORG };
    await comprarPacote(entradaComOutraOrg as never);
    expect(chamadasIniciar[0]!.organizationId).toBe(ORG);
  });

  it("e para cancelarAssinatura (org e actor vêm da sessão, não de parâmetro)", async () => {
    await cancelarAssinatura();
    expect(chamadasCancelar).toEqual([{ org: ORG, actor: USER }]);
  });
});

describe("compraDoPlano: as duas chaves da decisão 18 para comprar", () => {
  it("ASAAS_ENABLED desligado: recusa, nunca chama iniciarCompra", async () => {
    habilitado = false;
    const r = await iniciarAssinatura(ENTRADA_ASSINATURA);
    expect(r).toEqual({ tipo: "erro", mensagem: expect.stringContaining("suporte") });
    expect(chamadasIniciar).toEqual([]);
  });

  it("compra_pelo_cliente desligado (ASAAS_ENABLED ligado): recusa, nunca chama iniciarCompra", async () => {
    compraLigadaValor = false;
    const r = await comprarPacote(ENTRADA_PACOTE);
    expect(r.tipo).toBe("erro");
    expect(chamadasIniciar).toEqual([]);
  });

  it("as duas ligadas: chama iniciarCompra normalmente", async () => {
    const r = await iniciarAssinatura(ENTRADA_ASSINATURA);
    expect(r.tipo).not.toBe("erro");
    expect(chamadasIniciar.length).toBe(1);
  });

  it("ASAAS_ENABLED=true mas configuração incoerente: erro genérico, nunca a mensagem crua da exceção", async () => {
    configValida = false;
    const r = await iniciarAssinatura(ENTRADA_ASSINATURA);
    expect(r.tipo).toBe("erro");
    if (r.tipo === "erro") {
      expect(r.mensagem).not.toContain("ASAAS_API_KEY");
      expect(r.mensagem).not.toContain("ambientes diferentes");
    }
    expect(chamadasIniciar).toEqual([]);
  });
});

describe("compraDoPlano: cancelar exige só ASAAS_ENABLED (decisão 18)", () => {
  it("compra_pelo_cliente desligado NÃO bloqueia o cancelamento", async () => {
    compraLigadaValor = false;
    const r = await cancelarAssinatura();
    expect(r.tipo).toBe("ok");
    expect(chamadasCancelar.length).toBe(1);
  });

  it("ASAAS_ENABLED desligado bloqueia o cancelamento", async () => {
    habilitado = false;
    const r = await cancelarAssinatura();
    expect(r.tipo).toBe("erro");
    expect(chamadasCancelar).toEqual([]);
  });
});

describe("compraDoPlano: entrada validada por zod", () => {
  it("planCode fora do formato: erro, sem chamar iniciarCompra", async () => {
    const r = await iniciarAssinatura({ ...ENTRADA_ASSINATURA, planCode: "PLANO INVÁLIDO!" });
    expect(r.tipo).toBe("erro");
    expect(chamadasIniciar).toEqual([]);
  });

  it("ciclo fora do enum: erro", async () => {
    const r = await iniciarAssinatura({ ...ENTRADA_ASSINATURA, ciclo: "semanal" as never });
    expect(r.tipo).toBe("erro");
    expect(chamadasIniciar).toEqual([]);
  });

  it("chave que não é uuid: erro", async () => {
    const r = await iniciarAssinatura({ ...ENTRADA_ASSINATURA, chave: "não-é-uuid" });
    expect(r.tipo).toBe("erro");
    expect(chamadasIniciar).toEqual([]);
  });

  it("código de pacote fora do formato: erro", async () => {
    const r = await comprarPacote({ ...ENTRADA_PACOTE, pacote: "Pacote Grande" });
    expect(r.tipo).toBe("erro");
    expect(chamadasIniciar).toEqual([]);
  });
});

describe("compraDoPlano: frase fixa, nunca erro cru", () => {
  it("erro devolvido por iniciarCompra é repassado sem alteração", async () => {
    resultadoIniciar = { tipo: "erro", mensagem: "O preço desta oferta ainda não foi definido." };
    const r = await iniciarAssinatura(ENTRADA_ASSINATURA);
    expect(r).toEqual(resultadoIniciar);
  });

  it("dados inválidos nunca expõem o erro do zod, só a frase fixa", async () => {
    const r = await iniciarAssinatura({ ...ENTRADA_ASSINATURA, chave: "" });
    expect(r.tipo).toBe("erro");
    if (r.tipo === "erro") {
      expect(r.mensagem).not.toContain("ZodError");
      expect(r.mensagem).not.toContain("invalid_string");
    }
  });
});

describe("compraDoPlano: auditoria sem dado sensível", () => {
  it("iniciarAssinatura com pagador audita billing.order_created sem CPF/e-mail/telefone/valor", async () => {
    const r = await iniciarAssinatura({ ...ENTRADA_ASSINATURA, pagador: PAGADOR });
    expect(r.tipo).not.toBe("erro");
    expect(auditadas.length).toBe(1);
    expect(auditadas[0]!.action).toBe("billing.order_created");
    expect(auditadas[0]!.organizationId).toBe(ORG);
    expect(auditadas[0]!.actorUserId).toBe(USER);

    const metadata = JSON.stringify(auditadas[0]!.metadata);
    expect(metadata).not.toContain(PAGADOR.documento);
    expect(metadata).not.toContain(PAGADOR.email);
    expect(metadata).not.toContain(PAGADOR.celular);
    expect(metadata).not.toContain(PAGADOR.nome);
    expect(metadata).not.toContain("amountCents");
    expect(metadata).not.toContain("amount_cents");
  });

  it("comprarPacote audita billing.order_created com o código do pacote, sem dado do pagador", async () => {
    await comprarPacote({ ...ENTRADA_PACOTE, pagador: PAGADOR });
    expect(auditadas.length).toBe(1);
    expect(auditadas[0]!.action).toBe("billing.order_created");
    const metadata = auditadas[0]!.metadata as Record<string, unknown>;
    expect(metadata.pacote).toBe(ENTRADA_PACOTE.pacote);
    expect(JSON.stringify(metadata)).not.toContain(PAGADOR.documento);
  });

  it("cancelarAssinatura audita billing.subscription_cancel_requested com só o cancel_at_period_end", async () => {
    await cancelarAssinatura();
    expect(auditadas.length).toBe(1);
    expect(auditadas[0]!.action).toBe("billing.subscription_cancel_requested");
    expect(auditadas[0]!.metadata).toEqual({ cancel_at_period_end: true });
  });

  it("nenhuma auditoria quando o resultado é erro (tentativa recusada não vira 'pedido criado')", async () => {
    resultadoIniciar = { tipo: "erro", mensagem: "Este plano não está disponível para compra no momento." };
    await iniciarAssinatura(ENTRADA_ASSINATURA);
    expect(auditadas).toEqual([]);

    resultadoCancelar = { tipo: "erro", mensagem: "Esta organização não tem uma assinatura Asaas ativa para cancelar." };
    await cancelarAssinatura();
    expect(auditadas).toEqual([]);
  });
});
