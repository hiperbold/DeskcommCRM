import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A CARÊNCIA EXTRA DE UMA ORGANIZAÇÃO, dada pelo admin da plataforma na aba
 * Plano (fase F3, tarefa 10, decisão 11).
 *
 * ─── O que cada caso prende ──────────────────────────────────────────────────
 *
 * Mesma régua das duas escritas de `planoDaOrganizacao.ts` (fase F1, tarefa
 * 4): escopo `support_readonly` e MFA em dívida são recusados ANTES de
 * qualquer leitura/escrita. `novaData` fora do formato, no passado, ou a mais
 * de 90 dias de hoje é recusada sem tocar o banco. A ação só ADIA: recusa
 * quando a organização não tem contrato, quando não tem `bloqueio_a_partir_de`
 * (nada para estender) e quando a nova data não é depois da atual. Erro do
 * banco nunca aparece cru na resposta. O sucesso audita o antes/depois exatos
 * e revalida a aba.
 *
 * ─── Revisão pós-auditoria da F3 (achado médio 3) ────────────────────────────
 *
 * (a) o UPDATE agora é condicional ao `bloqueio_a_partir_de` LIDO
 *     (`.eq("bloqueio_a_partir_de", antes)`) e confere que afetou uma linha
 *     (`.select("id")`); zero linhas = a carência mudou entre a leitura e a
 *     escrita, e a ação pede para recarregar em vez de sobrescrever no escuro.
 * (b) "AAAA-MM-DD" passa por uma validação de calendário de verdade: 31/02
 *     (dia que o mês não tem) é recusado, não normalizado em silêncio para
 *     março.
 * (c) a data escolhida vale até o FIM do dia no fuso America/Sao_Paulo
 *     (23:59:59 local), não meia-noite UTC.
 */

const USUARIO = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";

const h = vi.hoisted(() => ({
  guard: vi.fn(),
  mfaEmDivida: vi.fn(),
  selectMaybeSingle: vi.fn(),
  updateSelect: vi.fn(),
  updateEqCarencia: vi.fn(),
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
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: h.selectMaybeSingle }) }),
      // .update({...}).eq("id", ...).eq("bloqueio_a_partir_de", antes).select("id")
      update: () => ({
        eq: () => ({
          eq: (...args: unknown[]) => {
            h.updateEqCarencia(...args);
            return { select: h.updateSelect };
          },
        }),
      }),
    }),
  }),
}));

const ADMIN_FULL = { user: { id: USUARIO }, platformAdmin: { scope: "full" } };
const ADMIN_SUPORTE = { user: { id: USUARIO }, platformAdmin: { scope: "support_readonly" } };

const AGORA = new Date("2026-09-24T12:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(AGORA);
  h.guard.mockResolvedValue(ADMIN_FULL);
  h.mfaEmDivida.mockResolvedValue(false);
  h.selectMaybeSingle.mockResolvedValue({
    data: { id: "contrato-1", bloqueio_a_partir_de: "2026-09-25T00:00:00.000Z" },
    error: null,
  });
  h.updateSelect.mockResolvedValue({ data: [{ id: "contrato-1" }], error: null });
});

afterEach(() => {
  vi.useRealTimers();
});

async function acoes() {
  return import("@/app/actions/admin/planoDaOrganizacao");
}

describe("darCarenciaExtra", () => {
  it("⭐ quem não é admin da plataforma é recusado e nada é escrito", async () => {
    h.guard.mockRejectedValueOnce(new Error("não é admin da plataforma"));
    const { darCarenciaExtra } = await acoes();

    await expect(darCarenciaExtra({ organizationId: ORG, novaData: "2026-10-01" })).rejects.toThrow();
    expect(h.updateEqCarencia).not.toHaveBeenCalled();
  });

  it("⭐ admin com escopo support_readonly é recusado e nada é escrito", async () => {
    h.guard.mockResolvedValueOnce(ADMIN_SUPORTE);
    const { darCarenciaExtra } = await acoes();

    const r = await darCarenciaExtra({ organizationId: ORG, novaData: "2026-10-01" });

    expect(r.ok).toBe(false);
    expect(h.updateEqCarencia).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("⭐ com MFA em dívida, nada é escrito", async () => {
    h.mfaEmDivida.mockResolvedValueOnce(true);
    const { darCarenciaExtra } = await acoes();

    const r = await darCarenciaExtra({ organizationId: ORG, novaData: "2026-10-01" });

    expect(r.ok).toBe(false);
    expect(h.updateEqCarencia).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("organizationId que não é uuid é recusado sem tocar o banco", async () => {
    const { darCarenciaExtra } = await acoes();

    const r = await darCarenciaExtra({ organizationId: "não-é-um-uuid", novaData: "2026-10-01" });

    expect(r.ok).toBe(false);
    expect(h.selectMaybeSingle).not.toHaveBeenCalled();
    expect(h.updateEqCarencia).not.toHaveBeenCalled();
  });

  it("data fora do formato AAAA-MM-DD é recusada", async () => {
    const { darCarenciaExtra } = await acoes();

    const r = await darCarenciaExtra({ organizationId: ORG, novaData: "01/10/2026" });

    expect(r.ok).toBe(false);
    expect(h.updateEqCarencia).not.toHaveBeenCalled();
  });

  it("data no passado é recusada", async () => {
    const { darCarenciaExtra } = await acoes();

    const r = await darCarenciaExtra({ organizationId: ORG, novaData: "2026-09-01" });

    expect(r.ok).toBe(false);
    expect(h.updateEqCarencia).not.toHaveBeenCalled();
  });

  it("data a mais de 90 dias de hoje é recusada", async () => {
    const { darCarenciaExtra } = await acoes();

    const r = await darCarenciaExtra({ organizationId: ORG, novaData: "2027-01-01" });

    expect(r.ok).toBe(false);
    expect(h.updateEqCarencia).not.toHaveBeenCalled();
  });

  it("organização sem contrato é recusada com frase fixa", async () => {
    h.selectMaybeSingle.mockResolvedValueOnce({ data: null, error: null });
    const { darCarenciaExtra } = await acoes();

    const r = await darCarenciaExtra({ organizationId: ORG, novaData: "2026-10-01" });

    expect(r).toEqual({ ok: false, error: "Organização não encontrada." });
    expect(h.updateEqCarencia).not.toHaveBeenCalled();
  });

  it("organização sem bloqueio programado (bloqueio_a_partir_de nulo) é recusada", async () => {
    h.selectMaybeSingle.mockResolvedValueOnce({
      data: { id: "contrato-1", bloqueio_a_partir_de: null },
      error: null,
    });
    const { darCarenciaExtra } = await acoes();

    const r = await darCarenciaExtra({ organizationId: ORG, novaData: "2026-10-01" });

    expect(r.ok).toBe(false);
    expect(h.updateEqCarencia).not.toHaveBeenCalled();
  });

  it("data igual ou anterior à carência atual é recusada: só adia, nunca antecipa", async () => {
    h.selectMaybeSingle.mockResolvedValueOnce({
      data: { id: "contrato-1", bloqueio_a_partir_de: "2026-10-05T00:00:00.000Z" },
      error: null,
    });
    const { darCarenciaExtra } = await acoes();

    const r = await darCarenciaExtra({ organizationId: ORG, novaData: "2026-10-01" });

    expect(r.ok).toBe(false);
    expect(h.updateEqCarencia).not.toHaveBeenCalled();
  });

  it("🔒 erro do banco na leitura não aparece na resposta", async () => {
    const MENSAGEM_MARCADA = 'relation "segredo_interno" does not exist';
    h.selectMaybeSingle.mockResolvedValueOnce({
      data: null,
      error: { code: "42P01", message: MENSAGEM_MARCADA },
    });
    const { darCarenciaExtra } = await acoes();

    const r = await darCarenciaExtra({ organizationId: ORG, novaData: "2026-10-01" });

    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(MENSAGEM_MARCADA);
  });

  it("🔒 erro do banco na escrita não aparece na resposta", async () => {
    const MENSAGEM_MARCADA = 'relation "segredo_interno" does not exist';
    h.updateSelect.mockResolvedValueOnce({ data: null, error: { code: "42P01", message: MENSAGEM_MARCADA } });
    const { darCarenciaExtra } = await acoes();

    const r = await darCarenciaExtra({ organizationId: ORG, novaData: "2026-10-01" });

    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(MENSAGEM_MARCADA);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("31/02 (dia que fevereiro não tem) é recusado, não normalizado em silêncio para março", async () => {
    const { darCarenciaExtra } = await acoes();

    const r = await darCarenciaExtra({ organizationId: ORG, novaData: "2026-02-31" });

    expect(r).toEqual({ ok: false, error: "Data inválida." });
    expect(h.updateEqCarencia).not.toHaveBeenCalled();
  });

  it("achado 3-a: a carência mudou entre a leitura e a escrita (zero linhas afetadas), pede para recarregar, sem sobrescrever", async () => {
    h.updateSelect.mockResolvedValueOnce({ data: [], error: null });
    const { darCarenciaExtra } = await acoes();

    const r = await darCarenciaExtra({ organizationId: ORG, novaData: "2026-10-01" });

    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/mudou|recarregue/i);
    expect(h.audit).not.toHaveBeenCalled();
    // O UPDATE foi CONDICIONADO ao valor lido: a segunda condição do .eq()
    // levou o "antes" que esta chamada leu, não um valor qualquer.
    expect(h.updateEqCarencia).toHaveBeenCalledWith("bloqueio_a_partir_de", "2026-09-25T00:00:00.000Z");
  });

  it("achado 3-c: a data escolhida vale até o FIM do dia em America/Sao_Paulo (23:59:59 local = 02:59:59 UTC do dia seguinte), não meia-noite UTC", async () => {
    const { darCarenciaExtra } = await acoes();

    const r = await darCarenciaExtra({ organizationId: ORG, novaData: "2026-10-01" });

    expect(r).toEqual({
      ok: true,
      antes: "2026-09-25T00:00:00.000Z",
      depois: "2026-10-02T02:59:59.000Z",
    });
  });

  it("sucesso audita billing.grace_extended com o antes/depois exatos, e revalida a aba", async () => {
    const { darCarenciaExtra } = await acoes();

    const r = await darCarenciaExtra({ organizationId: ORG, novaData: "2026-10-01" });

    expect(r).toEqual({
      ok: true,
      antes: "2026-09-25T00:00:00.000Z",
      depois: "2026-10-02T02:59:59.000Z",
    });
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "billing.grace_extended",
        resourceType: "organization",
        resourceId: ORG,
        metadata: { antes: "2026-09-25T00:00:00.000Z", depois: "2026-10-02T02:59:59.000Z" },
      }),
    );
    expect(h.revalidatePath).toHaveBeenCalledWith(`/admin/tenants/${ORG}/plano`);
  });
});
