import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import {
  CAMINHO_DA_ASSINATURA,
  caminhoLivreSemPlano,
  contratoSemPlano,
  destinoDaGuardaSemPlano,
  organizacaoSemPlano,
} from "@/lib/billing/assinatura/sem-plano";

/**
 * D-094 revisto: a organização que nunca assinou (contrato suspenso, sem período e sem ciclo) só
 * alcança a tela de assinatura e as configurações básicas. Aqui, a decisão da guarda de página.
 * O bloqueio de uso em si (IA, automação, campanha, importação) é o modo leitura do banco, provado
 * em `tests/invariants/lote14-banco.test.ts`.
 */

type Linha = { status: string; cycle: string | null; current_period_end: string | null; bloqueio_a_partir_de: string | null };

const ONTEM = new Date(Date.now() - 86_400_000).toISOString();
const AMANHA = new Date(Date.now() + 86_400_000).toISOString();
const SEM_PLANO: Linha = { status: "suspensa", cycle: null, current_period_end: null, bloqueio_a_partir_de: ONTEM };

/** Cliente de serviço com um modo de billing e um contrato; conta quantas leituras de cada tabela houve. */
function cliente(modo: string | null, contrato: Linha | null, falhaNoContrato = false) {
  const leituras = { billing_settings: 0, billing_contracts: 0 };
  const admin = {
    from(tabela: "billing_settings" | "billing_contracts") {
      leituras[tabela]++;
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () =>
              tabela === "billing_settings"
                ? { data: { modo }, error: null }
                : falhaNoContrato
                  ? { data: null, error: { message: "boom" } }
                  : { data: contrato, error: null },
          }),
        }),
      };
    },
  } as unknown as SupabaseClient;
  return { admin, leituras };
}

describe("contratoSemPlano", () => {
  it("só a suspensa que nunca teve período nem ciclo", () => {
    expect(contratoSemPlano({ status: "suspensa", currentPeriodEnd: null, cycle: null })).toBe(true);
    // Suspensa por falta de pagamento sempre tem período: não é "sem plano".
    expect(contratoSemPlano({ status: "suspensa", currentPeriodEnd: "2026-09-01T03:00:00Z", cycle: "monthly" })).toBe(false);
    expect(contratoSemPlano({ status: "suspensa", currentPeriodEnd: null, cycle: "monthly" })).toBe(false);
    for (const status of ["ativa", "avaliacao", "atrasada", "cancelada"]) {
      expect(contratoSemPlano({ status, currentPeriodEnd: null, cycle: null }), status).toBe(false);
    }
    expect(contratoSemPlano(null)).toBe(false);
  });
});

describe("caminhoLivreSemPlano", () => {
  it("a assinatura, o pedido e as configurações básicas passam; o resto do produto não", () => {
    for (const livre of [
      "/app/settings/plano",
      "/app/settings/plano/assinar",
      "/app/settings/plano/pedido/abc",
      "/app/settings/plano/",
      "/app/settings",
      "/app/settings/tenant",
      "/app/settings/profile",
      "/app/settings/security",
      "/app/settings/notifications",
    ]) {
      expect(caminhoLivreSemPlano(livre), livre).toBe(true);
    }
    for (const barrado of [
      "/app",
      "/app/inbox",
      "/app/kanban",
      "/app/settings/tenant/pipelines",
      "/app/settings/api-tokens",
      "/app/settings/plano-x",
      "/app/settings/profile-x",
      "/app/campaigns",
    ]) {
      expect(caminhoLivreSemPlano(barrado), barrado).toBe(false);
    }
  });
});

describe("organizacaoSemPlano", () => {
  it("modo bloquear + contrato suspenso sem período e sem ciclo + bloqueio vencido: sem plano", async () => {
    expect(await organizacaoSemPlano(cliente("bloquear", SEM_PLANO).admin, "org-1")).toBe(true);
  });

  it("nos modos avisar e desligado a instalação não cobra: não é sem plano e o contrato nem é lido", async () => {
    for (const modo of ["avisar", "desligado", null]) {
      const { admin, leituras } = cliente(modo, SEM_PLANO);
      expect(await organizacaoSemPlano(admin, "org-1"), String(modo)).toBe(false);
      expect(leituras.billing_contracts).toBe(0);
    }
  });

  it("CONTROLE: contrato em dia, suspensa por pagamento, bloqueio no futuro e sem contrato não são sem plano", async () => {
    const casos: Array<Linha | null> = [
      { ...SEM_PLANO, status: "ativa" },
      { ...SEM_PLANO, cycle: "monthly", current_period_end: ONTEM },
      { ...SEM_PLANO, bloqueio_a_partir_de: AMANHA },
      { ...SEM_PLANO, bloqueio_a_partir_de: null },
      null,
    ];
    for (const contrato of casos) {
      expect(await organizacaoSemPlano(cliente("bloquear", contrato).admin, "org-1"), JSON.stringify(contrato)).toBe(false);
    }
  });

  it("leitura que falha não prende o usuário fora do produto (fail-open)", async () => {
    const saidas = [vi.spyOn(console, "error"), vi.spyOn(console, "log"), vi.spyOn(console, "warn")].map((espiao) =>
      espiao.mockImplementation(() => {}),
    );
    try {
      expect(await organizacaoSemPlano(cliente("bloquear", SEM_PLANO, true).admin, "org-1")).toBe(false);
    } finally {
      for (const saida of saidas) saida.mockRestore();
    }
  });
});

describe("destinoDaGuardaSemPlano", () => {
  it("quem está sem plano e abre qualquer tela do produto vai para a assinatura", async () => {
    for (const caminho of ["/app", "/app/inbox", "/app/kanban", "/app/settings/api-tokens"]) {
      expect(await destinoDaGuardaSemPlano(cliente("bloquear", SEM_PLANO).admin, "org-1", caminho), caminho).toBe(
        CAMINHO_DA_ASSINATURA,
      );
    }
  });

  it("SEM LAÇO: o destino é um caminho livre, e caminho livre sai sem consultar nada", async () => {
    expect(caminhoLivreSemPlano(CAMINHO_DA_ASSINATURA)).toBe(true);
    const { admin, leituras } = cliente("bloquear", SEM_PLANO);
    expect(await destinoDaGuardaSemPlano(admin, "org-1", CAMINHO_DA_ASSINATURA)).toBeNull();
    expect(await destinoDaGuardaSemPlano(admin, "org-1", "/app/settings/plano")).toBeNull();
    expect(leituras.billing_settings + leituras.billing_contracts).toBe(0);
  });

  it("organização com plano segue para onde pediu; cabeçalho sem caminho não decide nada", async () => {
    expect(await destinoDaGuardaSemPlano(cliente("bloquear", { ...SEM_PLANO, status: "ativa" }).admin, "org-1", "/app/inbox")).toBeNull();
    expect(await destinoDaGuardaSemPlano(cliente("bloquear", SEM_PLANO).admin, "org-1", "")).toBeNull();
  });
});
