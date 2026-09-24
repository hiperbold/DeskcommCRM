import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O CONTROLE DO BLOQUEIO DE VERDADE PELO ADMIN DA PLATAFORMA
 * (fase F3, tarefa 10, decisão 11 de `hiperbold/planos/fase-F3-tarefas.md`).
 *
 * ─── O que cada caso prende ──────────────────────────────────────────────────
 *
 * Mesma régua de `tests/unit/planos-acoes-do-admin.test.ts` (fase F1, tarefa
 * 4): quem não é admin da plataforma, ou é admin com escopo
 * `support_readonly`, é recusado ANTES de qualquer escrita. Sessão com MFA em
 * dívida também é recusada antes de qualquer escrita. Entrada fora do
 * vocabulário/faixa não chega ao banco. Erro do banco nunca aparece cru na
 * resposta. O sucesso audita exatamente o antes/depois e revalida
 * `/admin/sistema`.
 *
 * `definirModoDeBloqueio` escreve por RPC (`fn_billing_definir_modo`, que já
 * existe desde a migration 0907). `definirDiasDeCarencia` escreve direto na
 * tabela (nenhuma função nova: `billing_settings` já tem `grant all` para
 * `service_role` desde a 0905), por isso o dublê do cliente cobre as duas
 * formas.
 */

const USUARIO = "11111111-1111-4111-8111-111111111111";

const h = vi.hoisted(() => ({
  guard: vi.fn(),
  mfaEmDivida: vi.fn(),
  rpc: vi.fn(),
  selectMaybeSingle: vi.fn(),
  updateEq: vi.fn(),
  audit: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/auth/requirePlatformAdmin", () => ({ requirePlatformAdmin: h.guard }));
vi.mock("@/lib/auth/server", () => ({ mfaEmDivida: h.mfaEmDivida }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: h.rpc,
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: h.selectMaybeSingle }) }),
      update: () => ({ eq: h.updateEq }),
    }),
  }),
}));

const ADMIN_FULL = { user: { id: USUARIO }, platformAdmin: { scope: "full" } };
const ADMIN_SUPORTE = { user: { id: USUARIO }, platformAdmin: { scope: "support_readonly" } };

beforeEach(() => {
  vi.clearAllMocks();
  h.guard.mockResolvedValue(ADMIN_FULL);
  h.mfaEmDivida.mockResolvedValue(false);
  h.rpc.mockResolvedValue({
    data: { modo_anterior: "avisar", modo_novo: "bloquear", organizacoes_com_carencia: 3 },
    error: null,
  });
  h.selectMaybeSingle.mockResolvedValue({ data: { carencia_dias: 7 }, error: null });
  h.updateEq.mockResolvedValue({ error: null });
});

async function acoes() {
  return import("@/app/actions/admin/bloqueioDosPlanos");
}

describe("definirModoDeBloqueio", () => {
  it("⭐ quem não é admin da plataforma é recusado e nenhuma RPC é chamada", async () => {
    h.guard.mockRejectedValueOnce(new Error("não é admin da plataforma"));
    const { definirModoDeBloqueio } = await acoes();

    await expect(definirModoDeBloqueio({ modo: "bloquear" })).rejects.toThrow();
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("⭐ admin com escopo support_readonly é recusado e nenhuma RPC é chamada", async () => {
    h.guard.mockResolvedValueOnce(ADMIN_SUPORTE);
    const { definirModoDeBloqueio } = await acoes();

    const r = await definirModoDeBloqueio({ modo: "bloquear" });

    expect(r.ok).toBe(false);
    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("⭐ com MFA em dívida, nenhuma RPC é chamada", async () => {
    h.mfaEmDivida.mockResolvedValueOnce(true);
    const { definirModoDeBloqueio } = await acoes();

    const r = await definirModoDeBloqueio({ modo: "bloquear" });

    expect(r.ok).toBe(false);
    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("modo fora do vocabulário é recusado sem RPC", async () => {
    const { definirModoDeBloqueio } = await acoes();

    const r = await definirModoDeBloqueio({ modo: "qualquer_coisa" as never });

    expect(r.ok).toBe(false);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("🔒 erro qualquer do banco NÃO aparece na resposta", async () => {
    const MENSAGEM_MARCADA = 'relation "segredo_interno" does not exist';
    h.rpc.mockResolvedValueOnce({ data: null, error: { code: "42P01", message: MENSAGEM_MARCADA } });
    const { definirModoDeBloqueio } = await acoes();

    const r = await definirModoDeBloqueio({ modo: "bloquear" });

    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(MENSAGEM_MARCADA);
    expect(JSON.stringify(r)).not.toContain("segredo_interno");
  });

  it("sucesso audita billing.mode_changed com o antes/depois exatos da RPC, e revalida a tela", async () => {
    const { definirModoDeBloqueio } = await acoes();

    const r = await definirModoDeBloqueio({ modo: "bloquear" });

    expect(r).toEqual({
      ok: true,
      modoAnterior: "avisar",
      modoNovo: "bloquear",
      organizacoesComCarencia: 3,
    });
    expect(h.rpc).toHaveBeenCalledWith("fn_billing_definir_modo", {
      p_modo: "bloquear",
      p_actor: USUARIO,
    });
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "billing.mode_changed",
        resourceType: "billing_settings",
        metadata: {
          modo_anterior: "avisar",
          modo_novo: "bloquear",
          organizacoes_com_carencia: 3,
        },
      }),
    );
    expect(h.revalidatePath).toHaveBeenCalledWith("/admin/sistema");
  });
});

describe("definirDiasDeCarencia", () => {
  it("⭐ quem não é admin da plataforma é recusado e nada é escrito", async () => {
    h.guard.mockRejectedValueOnce(new Error("não é admin da plataforma"));
    const { definirDiasDeCarencia } = await acoes();

    await expect(definirDiasDeCarencia({ dias: 10 })).rejects.toThrow();
    expect(h.updateEq).not.toHaveBeenCalled();
  });

  it("⭐ admin com escopo support_readonly é recusado e nada é escrito", async () => {
    h.guard.mockResolvedValueOnce(ADMIN_SUPORTE);
    const { definirDiasDeCarencia } = await acoes();

    const r = await definirDiasDeCarencia({ dias: 10 });

    expect(r.ok).toBe(false);
    expect(h.updateEq).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("⭐ com MFA em dívida, nada é escrito", async () => {
    h.mfaEmDivida.mockResolvedValueOnce(true);
    const { definirDiasDeCarencia } = await acoes();

    const r = await definirDiasDeCarencia({ dias: 10 });

    expect(r.ok).toBe(false);
    expect(h.updateEq).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it.each([-1, 91, 3.5])("dias fora de 0..90 (%s) é recusado sem escrita", async (dias) => {
    const { definirDiasDeCarencia } = await acoes();

    const r = await definirDiasDeCarencia({ dias });

    expect(r.ok).toBe(false);
    expect(h.updateEq).not.toHaveBeenCalled();
  });

  it("🔒 erro do banco na leitura do valor anterior não aparece na resposta", async () => {
    const MENSAGEM_MARCADA = 'relation "segredo_interno" does not exist';
    h.selectMaybeSingle.mockResolvedValueOnce({
      data: null,
      error: { code: "42P01", message: MENSAGEM_MARCADA },
    });
    const { definirDiasDeCarencia } = await acoes();

    const r = await definirDiasDeCarencia({ dias: 14 });

    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(MENSAGEM_MARCADA);
    expect(h.updateEq).not.toHaveBeenCalled();
  });

  it("🔒 erro do banco na escrita não aparece na resposta", async () => {
    const MENSAGEM_MARCADA = 'relation "segredo_interno" does not exist';
    h.updateEq.mockResolvedValueOnce({ error: { code: "42P01", message: MENSAGEM_MARCADA } });
    const { definirDiasDeCarencia } = await acoes();

    const r = await definirDiasDeCarencia({ dias: 14 });

    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(MENSAGEM_MARCADA);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("sucesso audita billing.grace_days_changed com antes/depois, e revalida a tela", async () => {
    const { definirDiasDeCarencia } = await acoes();

    const r = await definirDiasDeCarencia({ dias: 14 });

    expect(r).toEqual({ ok: true, antes: 7, depois: 14 });
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "billing.grace_days_changed",
        resourceType: "billing_settings",
        metadata: { antes: 7, depois: 14 },
      }),
    );
    expect(h.revalidatePath).toHaveBeenCalledWith("/admin/sistema");
  });
});
