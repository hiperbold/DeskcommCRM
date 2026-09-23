import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * AS DUAS ESCRITAS DO ADMIN DA PLATAFORMA SOBRE O PLANO DE UMA ORGANIZAÇÃO
 * (fase F1, tarefa 4).
 *
 * ─── O que cada caso prende ─────────────────────────────────────────────────
 *
 * Quem não é admin da plataforma, ou é admin mas só com escopo
 * `support_readonly`, tem de ser recusado ANTES de a RPC ser chamada, seguindo a
 * mesma régua de `app/api/v1/admin/tenants/route.ts:166`. Entrada fora do
 * formato (organizationId que não é uuid, planCode fora do padrão, ajuste com
 * chave desconhecida ou número acima do teto) também não pode chegar à RPC.
 * O erro de negócio da função SQL (`organizacao_nao_encontrada`) vira frase
 * fixa; qualquer outro erro do banco nunca aparece na resposta, só no log. O
 * sucesso audita exatamente o `antes`/`depois` que a função devolveu, nunca
 * uma releitura, e revalida a aba.
 *
 * ─── MFA e a auditoria de remoção (correções de revisão e auditoria) ────────
 *
 * As duas actions também conferem `mfaEmDivida()` logo depois do escopo:
 * sessão com o segundo fator em dívida é recusada antes de qualquer RPC. E
 * `ajustarLimitesDaOrganizacao` distingue três casos pelo `antes`/`depois` que
 * a RPC devolveu: nada mudou (não audita), `depois: null` com `antes` que
 * existia (remoção, `billing.adjustment_removed`), e qualquer outra mudança
 * (concessão, `billing.adjustment_granted`, com a nota enviada no metadata).
 */

const USUARIO = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";

const h = vi.hoisted(() => ({
  guard: vi.fn(),
  rpc: vi.fn(),
  audit: vi.fn(),
  revalidatePath: vi.fn(),
  mfaEmDivida: vi.fn(),
}));

vi.mock("@/lib/auth/requirePlatformAdmin", () => ({ requirePlatformAdmin: h.guard }));
vi.mock("@/lib/auth/server", () => ({ mfaEmDivida: h.mfaEmDivida }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc: h.rpc }) }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

const ADMIN_FULL = { user: { id: USUARIO }, platformAdmin: { scope: "full" } };
const ADMIN_SUPORTE = { user: { id: USUARIO }, platformAdmin: { scope: "support_readonly" } };

beforeEach(() => {
  vi.clearAllMocks();
  h.guard.mockResolvedValue(ADMIN_FULL);
  h.mfaEmDivida.mockResolvedValue(false);
  h.rpc.mockResolvedValue({
    data: { antes: { plan_code: "pro", version: 1 }, depois: { plan_code: "max", version: 1 } },
    error: null,
  });
});

async function acoes() {
  return import("@/app/actions/admin/planoDaOrganizacao");
}

describe("trocarPlanoDaOrganizacao", () => {
  it("⭐ quem não é admin da plataforma é recusado e nenhuma RPC é chamada", async () => {
    h.guard.mockRejectedValueOnce(new Error("não é admin da plataforma"));
    const { trocarPlanoDaOrganizacao } = await acoes();

    await expect(trocarPlanoDaOrganizacao({ organizationId: ORG, planCode: "max" })).rejects.toThrow();
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("⭐ admin com escopo support_readonly é recusado e nenhuma RPC é chamada", async () => {
    h.guard.mockResolvedValueOnce(ADMIN_SUPORTE);
    const { trocarPlanoDaOrganizacao } = await acoes();

    const r = await trocarPlanoDaOrganizacao({ organizationId: ORG, planCode: "max" });

    expect(r.ok).toBe(false);
    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("⭐ com MFA em dívida, nenhuma RPC é chamada", async () => {
    h.mfaEmDivida.mockResolvedValueOnce(true);
    const { trocarPlanoDaOrganizacao } = await acoes();

    const r = await trocarPlanoDaOrganizacao({ organizationId: ORG, planCode: "max" });

    expect(r.ok).toBe(false);
    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("organizationId que não é uuid é recusado sem RPC", async () => {
    const { trocarPlanoDaOrganizacao } = await acoes();

    const r = await trocarPlanoDaOrganizacao({ organizationId: "não-é-um-uuid", planCode: "max" });

    expect(r.ok).toBe(false);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("planCode fora do formato é recusado sem RPC", async () => {
    const { trocarPlanoDaOrganizacao } = await acoes();

    const r = await trocarPlanoDaOrganizacao({ organizationId: ORG, planCode: "PLANO INVÁLIDO!" });

    expect(r.ok).toBe(false);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("organização inexistente (P0002 organizacao_nao_encontrada) devolve a frase fixa", async () => {
    h.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: "P0002", message: "organizacao_nao_encontrada" },
    });
    const { trocarPlanoDaOrganizacao } = await acoes();

    const r = await trocarPlanoDaOrganizacao({ organizationId: ORG, planCode: "max" });

    expect(r).toEqual({ ok: false, error: "Organização não encontrada." });
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("plano inexistente ou inativo (P0002 plano_nao_encontrado_ou_inativo) devolve a frase fixa", async () => {
    h.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: "P0002", message: "plano_nao_encontrado_ou_inativo" },
    });
    const { trocarPlanoDaOrganizacao } = await acoes();

    const r = await trocarPlanoDaOrganizacao({ organizationId: ORG, planCode: "inexistente" });

    expect(r).toEqual({ ok: false, error: "Plano não encontrado." });
  });

  it("🔒 erro qualquer do banco NÃO aparece na resposta", async () => {
    const MENSAGEM_MARCADA = 'relation "segredo_interno" does not exist';
    h.rpc.mockResolvedValueOnce({ data: null, error: { code: "42P01", message: MENSAGEM_MARCADA } });
    const { trocarPlanoDaOrganizacao } = await acoes();

    const r = await trocarPlanoDaOrganizacao({ organizationId: ORG, planCode: "max" });

    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(MENSAGEM_MARCADA);
    expect(JSON.stringify(r)).not.toContain("segredo_interno");
  });

  it("sucesso audita o antes/depois exatamente como a RPC devolveu, e revalida a aba", async () => {
    const { trocarPlanoDaOrganizacao } = await acoes();

    const r = await trocarPlanoDaOrganizacao({ organizationId: ORG, planCode: "max" });

    expect(r).toEqual({
      ok: true,
      antes: { plan_code: "pro", version: 1 },
      depois: { plan_code: "max", version: 1 },
    });
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "billing.plan_changed",
        resourceType: "organization",
        resourceId: ORG,
        metadata: {
          antes: { plan_code: "pro", version: 1 },
          depois: { plan_code: "max", version: 1 },
        },
      }),
    );
    expect(h.revalidatePath).toHaveBeenCalledWith(`/admin/tenants/${ORG}/plano`);
  });
});

describe("ajustarLimitesDaOrganizacao", () => {
  beforeEach(() => {
    h.rpc.mockResolvedValue({
      data: { antes: null, depois: { leads: 10000 } },
      error: null,
    });
  });

  it("⭐ quem não é admin da plataforma é recusado e nenhuma RPC é chamada", async () => {
    h.guard.mockRejectedValueOnce(new Error("não é admin da plataforma"));
    const { ajustarLimitesDaOrganizacao } = await acoes();

    await expect(
      ajustarLimitesDaOrganizacao({ organizationId: ORG, limites: { leads: 10000 } }),
    ).rejects.toThrow();
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("⭐ admin com escopo support_readonly é recusado e nenhuma RPC é chamada", async () => {
    h.guard.mockResolvedValueOnce(ADMIN_SUPORTE);
    const { ajustarLimitesDaOrganizacao } = await acoes();

    const r = await ajustarLimitesDaOrganizacao({ organizationId: ORG, limites: { leads: 10000 } });

    expect(r.ok).toBe(false);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("⭐ com MFA em dívida, nenhuma RPC é chamada", async () => {
    h.mfaEmDivida.mockResolvedValueOnce(true);
    const { ajustarLimitesDaOrganizacao } = await acoes();

    const r = await ajustarLimitesDaOrganizacao({ organizationId: ORG, limites: { leads: 10000 } });

    expect(r.ok).toBe(false);
    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("organizationId que não é uuid é recusado sem RPC", async () => {
    const { ajustarLimitesDaOrganizacao } = await acoes();

    const r = await ajustarLimitesDaOrganizacao({ organizationId: "não-é-um-uuid", limites: {} });

    expect(r.ok).toBe(false);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("ajuste com chave desconhecida é recusado sem RPC", async () => {
    const { ajustarLimitesDaOrganizacao } = await acoes();

    const r = await ajustarLimitesDaOrganizacao({
      organizationId: ORG,
      limites: { chave_que_nao_existe: 10 } as never,
    });

    expect(r.ok).toBe(false);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("ajuste com número acima do teto é recusado sem RPC", async () => {
    const { ajustarLimitesDaOrganizacao } = await acoes();

    const r = await ajustarLimitesDaOrganizacao({
      organizationId: ORG,
      limites: { leads: 2147483648 },
    });

    expect(r.ok).toBe(false);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("organização inexistente (P0002) devolve a frase fixa", async () => {
    h.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: "P0002", message: "organizacao_nao_encontrada" },
    });
    const { ajustarLimitesDaOrganizacao } = await acoes();

    const r = await ajustarLimitesDaOrganizacao({ organizationId: ORG, limites: { leads: 10000 } });

    expect(r).toEqual({ ok: false, error: "Organização não encontrada." });
  });

  it("🔒 erro qualquer do banco NÃO aparece na resposta", async () => {
    const MENSAGEM_MARCADA = 'relation "segredo_interno" does not exist';
    h.rpc.mockResolvedValueOnce({ data: null, error: { code: "42P01", message: MENSAGEM_MARCADA } });
    const { ajustarLimitesDaOrganizacao } = await acoes();

    const r = await ajustarLimitesDaOrganizacao({ organizationId: ORG, limites: { leads: 10000 } });

    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(MENSAGEM_MARCADA);
  });

  it("sucesso audita o antes/depois exatamente como a RPC devolveu, com a nota no metadata, e revalida a aba", async () => {
    const { ajustarLimitesDaOrganizacao } = await acoes();

    const r = await ajustarLimitesDaOrganizacao({
      organizationId: ORG,
      limites: { leads: 10000 },
      nota: "exceção combinada por telefone",
    });

    expect(r).toEqual({ ok: true, antes: null, depois: { leads: 10000 } });
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "billing.adjustment_granted",
        resourceType: "organization",
        resourceId: ORG,
        metadata: {
          antes: null,
          depois: { leads: 10000 },
          nota: "exceção combinada por telefone",
        },
      }),
    );
    expect(h.revalidatePath).toHaveBeenCalledWith(`/admin/tenants/${ORG}/plano`);
  });

  it("concessão sem nota grava `nota: null` no metadata", async () => {
    const { ajustarLimitesDaOrganizacao } = await acoes();

    await ajustarLimitesDaOrganizacao({ organizationId: ORG, limites: { leads: 10000 } });

    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "billing.adjustment_granted",
        metadata: { antes: null, depois: { leads: 10000 }, nota: null },
      }),
    );
  });

  it("remover um ajuste existente audita billing.adjustment_removed, sem nota no metadata", async () => {
    h.rpc.mockResolvedValueOnce({
      data: { antes: { leads: 10000 }, depois: null },
      error: null,
    });
    const { ajustarLimitesDaOrganizacao } = await acoes();

    const r = await ajustarLimitesDaOrganizacao({ organizationId: ORG, limites: {} });

    expect(r).toEqual({ ok: true, antes: { leads: 10000 }, depois: null });
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "billing.adjustment_removed",
        resourceType: "organization",
        resourceId: ORG,
        metadata: { antes: { leads: 10000 }, depois: null },
      }),
    );
  });

  it("remover um ajuste que já não existia (antes e depois null) não audita nada, e devolve ok:true", async () => {
    h.rpc.mockResolvedValueOnce({
      data: { antes: null, depois: null },
      error: null,
    });
    const { ajustarLimitesDaOrganizacao } = await acoes();

    const r = await ajustarLimitesDaOrganizacao({ organizationId: ORG, limites: {} });

    expect(r).toEqual({ ok: true, antes: null, depois: null });
    expect(h.audit).not.toHaveBeenCalled();
    expect(h.revalidatePath).toHaveBeenCalledWith(`/admin/tenants/${ORG}/plano`);
  });

  it("gravar exatamente o mesmo ajuste que já existia não audita nada", async () => {
    h.rpc.mockResolvedValueOnce({
      data: { antes: { leads: 10000 }, depois: { leads: 10000 } },
      error: null,
    });
    const { ajustarLimitesDaOrganizacao } = await acoes();

    const r = await ajustarLimitesDaOrganizacao({ organizationId: ORG, limites: { leads: 10000 } });

    expect(r).toEqual({ ok: true, antes: { leads: 10000 }, depois: { leads: 10000 } });
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("ajuste vazio chama a RPC com {}, que é assim que se remove o ajuste", async () => {
    const { ajustarLimitesDaOrganizacao } = await acoes();

    await ajustarLimitesDaOrganizacao({ organizationId: ORG, limites: {} });

    expect(h.rpc).toHaveBeenCalledWith(
      "fn_billing_ajustar_limites",
      expect.objectContaining({ p_org: ORG, p_limits: {} }),
    );
  });
});
