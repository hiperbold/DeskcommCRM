import { describe, expect, it, vi } from "vitest";

import { conferirVencimentos, type ConferidorDeVencimentosDb } from "@/lib/billing/assinatura/conferir-vencimentos";
import type { MarcaDeSaida } from "@/lib/branding/saida";
import type { EmailParaEnfileirar } from "@/lib/email/conta-e-cobranca/fila";
import {
  criarAvisoDeCancelamentoSobre,
  criarAvisoDeSuspensaoSobre,
} from "@/lib/email/conta-e-cobranca/gatilhos-de-conta";
import { montarEmailDeConta, type ContextoDoEmail } from "@/lib/email/conta-e-cobranca/montar";

import { clienteFalso, criarBancoFalso, type BancoFalso } from "./helpers/banco-de-emails-falso";

/**
 * Os gatilhos de conta que nascem de uma ação ou do relógio: COB-07 (cancelamento confirmado) e COB-06 (conta
 * suspensa). O enfileiramento real é trocado por um espião (a borda); o conteúdo é conferido montando a mensagem
 * a partir dos `dados` enfileirados com a mesma `montarEmailDeConta` que o envio usa. O último bloco prova a
 * ligação com o conferidor de vencimentos: só a organização que a RPC levou a `suspensa` é avisada, logo depois
 * da própria RPC, e falha do aviso não interrompe a rodada.
 */

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const ORG = "0952c000-0000-4000-8000-00000000000a";
const OUTRA = "0952c000-0000-4000-8000-00000000000b";
const MARCA: MarcaDeSaida = {
  nome: "HiperCRM",
  logoUrl: null,
  accent: "#0139B0",
  accentFg: "#ffffff",
  origens: { nome: "padrao", cor: "padrao" },
};
/** 00h de São Paulo de 01/11/2026: o último dia de acesso pago é 31/10. */
const FIM_DO_PERIODO = "2026-11-01T03:00:00+00:00";

function mundo(contrato: Record<string, unknown> = {}): BancoFalso {
  return criarBancoFalso({
    tabelas: {
      billing_plans: [{ id: "plano-pro", name: "Pro" }],
      billing_contracts: [
        { id: "c-1", organization_id: ORG, plan_id: "plano-pro", status: "ativa", current_period_end: FIM_DO_PERIODO, ...contrato },
      ],
    },
  });
}

function ctx(idioma: "pt-BR" | "es" = "pt-BR"): ContextoDoEmail {
  return {
    organizationId: ORG,
    empresa: "Empresa A",
    idioma,
    marca: MARCA,
    appUrl: "https://crm.exemplo.com.br",
    nome: "Diego",
    base: (url) => ({ marca: MARCA, idioma, empresa: "Empresa A", url }),
  };
}

function espiao() {
  const enviadas: EmailParaEnfileirar[] = [];
  return {
    enviadas,
    enfileirar: async (e: EmailParaEnfileirar) => {
      enviadas.push(e);
      return "enfileirado" as const;
    },
  };
}

const montar = (e: EmailParaEnfileirar, idioma: "pt-BR" | "es" = "pt-BR") =>
  montarEmailDeConta(e.emailId, e.dados, ctx(idioma));

describe("COB-07 cancelamento confirmado", () => {
  it("manda aos admins, com cópia ao operador, chave pela organização e pelo fim do período, acesso até o último dia pago e botão de assinar", async () => {
    const s = espiao();
    await criarAvisoDeCancelamentoSobre(clienteFalso(mundo()), { enfileirar: s.enfileirar })({
      organizationId: ORG,
      asaasSubscriptionId: "sub_123",
    });

    expect(s.enviadas).toHaveLength(1);
    const e = s.enviadas[0]!;
    expect([e.organizationId, e.emailId, e.chave, e.destino, e.copiaParaOperador]).toEqual([
      ORG,
      "COB-07",
      `cancelamento:${ORG}:${FIM_DO_PERIODO}`,
      "admins",
      true,
    ]);
    const m = montar(e);
    expect(m.subject).toBe("Cancelamento confirmado");
    expect(m.text).toContain("O plano Pro foi cancelado");
    expect(m.text).toContain("acesso até 31/10/2026");
    expect(m.text).toContain("https://crm.exemplo.com.br/app/settings/plano/assinar");
    expect(montar(e, "es").subject).not.toBe("Cancelamento confirmado");
  });

  it("um aviso por organização por período: a mesma assinatura, outra assinatura ou várias no mesmo período geram a MESMA chave", async () => {
    const s = espiao();
    const aviso = criarAvisoDeCancelamentoSobre(clienteFalso(mundo()), { enfileirar: s.enfileirar });
    await aviso({ organizationId: ORG, asaasSubscriptionId: "sub_123" });
    await aviso({ organizationId: ORG, asaasSubscriptionId: "sub_123" });
    await aviso({ organizationId: ORG, asaasSubscriptionId: "sub_456" });
    await aviso({ organizationId: ORG, asaasSubscriptionId: "sub_789" });
    expect(new Set(s.enviadas.map((e) => e.chave))).toEqual(new Set([`cancelamento:${ORG}:${FIM_DO_PERIODO}`]));
  });

  it("período novo gera chave nova; outra organização tem a sua", async () => {
    const s = espiao();
    const banco = mundo();
    banco.tabelas.billing_contracts!.push({
      id: "c-2",
      organization_id: OUTRA,
      plan_id: "plano-pro",
      status: "ativa",
      current_period_end: FIM_DO_PERIODO,
    });
    const aviso = criarAvisoDeCancelamentoSobre(clienteFalso(banco), { enfileirar: s.enfileirar });
    await aviso({ organizationId: ORG, asaasSubscriptionId: "sub_1" });
    banco.tabelas.billing_contracts![0]!.current_period_end = "2026-12-01T03:00:00+00:00";
    await aviso({ organizationId: ORG, asaasSubscriptionId: "sub_2" });
    await aviso({ organizationId: OUTRA, asaasSubscriptionId: "sub_3" });
    expect(s.enviadas.map((e) => e.chave)).toEqual([
      `cancelamento:${ORG}:${FIM_DO_PERIODO}`,
      `cancelamento:${ORG}:2026-12-01T03:00:00+00:00`,
      `cancelamento:${OUTRA}:${FIM_DO_PERIODO}`,
    ]);
  });

  it("sem fim de período no contrato não há data de acesso para dizer: não manda", async () => {
    const s = espiao();
    await criarAvisoDeCancelamentoSobre(clienteFalso(mundo({ current_period_end: null })), { enfileirar: s.enfileirar })({
      organizationId: ORG,
      asaasSubscriptionId: "sub_123",
    });
    expect(s.enviadas).toEqual([]);
  });

  it("organização sem contrato: não manda", async () => {
    const s = espiao();
    await criarAvisoDeCancelamentoSobre(clienteFalso(mundo()), { enfileirar: s.enfileirar })({
      organizationId: OUTRA,
      asaasSubscriptionId: "sub_123",
    });
    expect(s.enviadas).toEqual([]);
  });

  it("banco fora do ar ou envio que lança: o aviso engole a falha e nunca lança", async () => {
    const banco = mundo();
    banco.falhar.billing_contracts = { code: "08006", message: "conexão perdida" };
    await expect(
      criarAvisoDeCancelamentoSobre(clienteFalso(banco), { enfileirar: async () => "enfileirado" })({
        organizationId: ORG,
        asaasSubscriptionId: "sub_123",
      }),
    ).resolves.toBeUndefined();

    await expect(
      criarAvisoDeCancelamentoSobre(clienteFalso(mundo()), {
        enfileirar: async () => {
          throw new Error("banco caiu");
        },
      })({ organizationId: ORG, asaasSubscriptionId: "sub_123" }),
    ).resolves.toBeUndefined();
  });
});

describe("COB-06 conta suspensa", () => {
  it("manda aos admins, com cópia ao operador, chave pelo contrato e pelo fim do período, botão para o plano", async () => {
    const s = espiao();
    await criarAvisoDeSuspensaoSobre(clienteFalso(mundo()), { enfileirar: s.enfileirar })(ORG);

    expect(s.enviadas).toHaveLength(1);
    const e = s.enviadas[0]!;
    expect([e.emailId, e.chave, e.destino, e.copiaParaOperador]).toEqual([
      "COB-06",
      `suspensao:c-1:${FIM_DO_PERIODO}`,
      "admins",
      true,
    ]);
    const m = montar(e);
    expect(m.subject).toBe("Sua conta está suspensa");
    expect(m.text).toContain("A conta da Empresa A foi suspensa por falta de pagamento");
    expect(m.text).toContain("https://crm.exemplo.com.br/app/settings/plano");
  });

  it("um período novo (regularizou, renovou e suspendeu de novo) gera chave nova", async () => {
    const s = espiao();
    const banco = mundo();
    const aviso = criarAvisoDeSuspensaoSobre(clienteFalso(banco), { enfileirar: s.enfileirar });
    await aviso(ORG);
    banco.tabelas.billing_contracts![0]!.current_period_end = "2026-12-01T03:00:00+00:00";
    await aviso(ORG);
    expect(new Set(s.enviadas.map((e) => e.chave)).size).toBe(2);
  });

  it("sem contrato ou sem fim de período: não manda; banco fora do ar não lança", async () => {
    const s = espiao();
    await criarAvisoDeSuspensaoSobre(clienteFalso(mundo()), { enfileirar: s.enfileirar })(OUTRA);
    await criarAvisoDeSuspensaoSobre(clienteFalso(mundo({ current_period_end: null })), { enfileirar: s.enfileirar })(ORG);
    expect(s.enviadas).toEqual([]);

    const banco = mundo();
    banco.falhar.billing_contracts = { code: "08006", message: "conexão perdida" };
    await expect(criarAvisoDeSuspensaoSobre(clienteFalso(banco), { enfileirar: s.enfileirar })(ORG)).resolves.toBeUndefined();
  });
});

describe("ligação com o conferidor de vencimentos", () => {
  function dbDoConferidor(estados: Record<string, string | null>): ConferidorDeVencimentosDb {
    return {
      listarOrganizacoes: async () => ({ data: Object.keys(estados).map((id) => ({ id })), error: null }),
      conferirVencimento: async (org) => ({ data: estados[org] ?? null, error: null }),
    };
  }

  it("só quem a RPC levou a suspensa é avisado; atrasada, cancelada e sem mudança não", async () => {
    const aviso = vi.fn(async (_org: string) => {});
    const resumo = await conferirVencimentos(
      dbDoConferidor({ a: "suspensa", b: "atrasada", c: "cancelada", d: null, e: "suspensa" }),
      { aoSuspender: aviso },
    );
    expect(aviso.mock.calls.map((c) => c[0])).toEqual(["a", "e"]);
    expect(resumo.mudaramParaSuspensa).toBe(2);
    expect(resumo.mudaramParaAtrasada).toBe(1);
  });

  it("organização cuja RPC falhou não é avisada, e a rodada segue", async () => {
    const aviso = vi.fn(async (_org: string) => {});
    const db: ConferidorDeVencimentosDb = {
      listarOrganizacoes: async () => ({ data: [{ id: "a" }, { id: "b" }], error: null }),
      conferirVencimento: async (org) =>
        org === "a" ? { data: null, error: { message: "timeout" } } : { data: "suspensa", error: null },
    };
    const resumo = await conferirVencimentos(db, { aoSuspender: aviso });
    expect(aviso.mock.calls.map((c) => c[0])).toEqual(["b"]);
    expect(resumo.organizacoesQueFalharam).toBe(1);
  });

  it("aviso que lança não muda o resumo nem interrompe a rodada", async () => {
    const aviso = vi.fn(async (org: string) => {
      if (org === "a") throw new Error("smtp caiu");
    });
    const resumo = await conferirVencimentos(dbDoConferidor({ a: "suspensa", b: "suspensa" }), { aoSuspender: aviso });
    expect(aviso).toHaveBeenCalledTimes(2);
    expect(resumo.mudaramParaSuspensa).toBe(2);
    expect(resumo.organizacoesQueFalharam).toBe(0);
  });

  it("o aviso sai logo depois da RPC da própria organização, antes da seguinte (o estado é o do momento)", async () => {
    const ordem: string[] = [];
    const db: ConferidorDeVencimentosDb = {
      listarOrganizacoes: async () => ({ data: [{ id: "a" }, { id: "b" }, { id: "c" }], error: null }),
      conferirVencimento: async (org) => {
        ordem.push(`rpc:${org}`);
        return { data: org === "c" ? null : "suspensa", error: null };
      },
    };
    await conferirVencimentos(db, {
      aoSuspender: async (org) => {
        ordem.push(`aviso:${org}`);
      },
    });
    expect(ordem).toEqual(["rpc:a", "aviso:a", "rpc:b", "aviso:b", "rpc:c"]);
  });

  it("falha ao listar uma página depois de suspender alguém: quem já foi suspenso ainda é avisado", async () => {
    const aviso = vi.fn(async (_org: string) => {});
    let chamada = 0;
    const db: ConferidorDeVencimentosDb = {
      listarOrganizacoes: async () => {
        chamada++;
        if (chamada === 1) {
          return { data: Array.from({ length: 500 }, (_, i) => ({ id: i === 0 ? "a" : `x${i}` })), error: null };
        }
        return { data: null, error: { message: "banco caiu" } };
      },
      conferirVencimento: async (org) => ({ data: org === "a" ? "suspensa" : null, error: null }),
    };
    await expect(conferirVencimentos(db, { aoSuspender: aviso })).rejects.toThrow("organizations: banco caiu");
    expect(aviso.mock.calls.map((c) => c[0])).toEqual(["a"]);
  });

  it("sem avisos injetados a rodada é a de sempre", async () => {
    const resumo = await conferirVencimentos(dbDoConferidor({ a: "suspensa" }));
    expect(resumo.mudaramParaSuspensa).toBe(1);
  });
});
