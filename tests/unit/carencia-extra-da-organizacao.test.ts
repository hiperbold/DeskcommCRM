import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A CARÊNCIA EXTRA DE UMA ORGANIZAÇÃO, dada pelo admin da plataforma na aba
 * Plano (fase F3, tarefa 10, decisão 11).
 *
 * ─── O que cada caso prende ──────────────────────────────────────────────────
 *
 * Mesma régua das duas escritas de `planoDaOrganizacao.ts` (fase F1, tarefa
 * 4): escopo `support_readonly` e MFA em dívida são recusados ANTES de
 * qualquer RPC. `novaData` fora do formato, no passado, ou a mais de 90 dias
 * de hoje é recusada sem tocar o banco. O erro de negócio da função SQL vira
 * frase fixa; qualquer outro erro do banco nunca aparece na resposta. O
 * sucesso audita o antes/depois exatos e revalida a aba.
 *
 * ─── Correção D-069 (fase F7, lote 1b) ───────────────────────────────────────
 *
 * A ação parou de ler e escrever `billing_contracts` direto com o cliente de
 * serviço (achado da auditoria da F5): agora chama
 * `fn_billing_estender_carencia` (security definer), que faz a leitura e a
 * escrita dentro da MESMA transação. A validação de calendário (31/02),
 * fuso e teto de 90 dias continua em TypeScript, ANTES da RPC (mesmo
 * comportamento de antes, achado médio 3-b/3-c da revisão da F3); "sem
 * contrato", "sem bloqueio programado" e "data não é posterior" viram erro
 * de negócio da FUNÇÃO agora, traduzido por `mensagemDoErroDeEscrita`.
 */

const USUARIO = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";

const h = vi.hoisted(() => ({
  guard: vi.fn(),
  mfaEmDivida: vi.fn(),
  rpc: vi.fn(),
  audit: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/auth/requirePlatformAdmin", () => ({ requirePlatformAdmin: h.guard }));
vi.mock("@/lib/auth/server", () => ({ mfaEmDivida: h.mfaEmDivida }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc: h.rpc }) }));

const ADMIN_FULL = { user: { id: USUARIO }, platformAdmin: { scope: "full" } };
const ADMIN_SUPORTE = { user: { id: USUARIO }, platformAdmin: { scope: "support_readonly" } };

const AGORA = new Date("2026-09-24T12:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(AGORA);
  h.guard.mockResolvedValue(ADMIN_FULL);
  h.mfaEmDivida.mockResolvedValue(false);
  // "antes" que a função devolve: o bloqueio_a_partir_de ANTERIOR ao update.
  h.rpc.mockResolvedValue({ data: "2026-09-25T00:00:00.000Z", error: null });
});

afterEach(() => {
  vi.useRealTimers();
});

async function acoes() {
  return import("@/app/actions/admin/planoDaOrganizacao");
}

describe("darCarenciaExtra", () => {
  it("⭐ quem não é admin da plataforma é recusado e nenhuma RPC é chamada", async () => {
    h.guard.mockRejectedValueOnce(new Error("não é admin da plataforma"));
    const { darCarenciaExtra } = await acoes();

    await expect(darCarenciaExtra({ organizationId: ORG, novaData: "2026-10-01" })).rejects.toThrow();
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("⭐ admin com escopo support_readonly é recusado e nenhuma RPC é chamada", async () => {
    h.guard.mockResolvedValueOnce(ADMIN_SUPORTE);
    const { darCarenciaExtra } = await acoes();

    const r = await darCarenciaExtra({ organizationId: ORG, novaData: "2026-10-01" });

    expect(r.ok).toBe(false);
    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("⭐ com MFA em dívida, nenhuma RPC é chamada", async () => {
    h.mfaEmDivida.mockResolvedValueOnce(true);
    const { darCarenciaExtra } = await acoes();

    const r = await darCarenciaExtra({ organizationId: ORG, novaData: "2026-10-01" });

    expect(r.ok).toBe(false);
    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("organizationId que não é uuid é recusado sem RPC", async () => {
    const { darCarenciaExtra } = await acoes();

    const r = await darCarenciaExtra({ organizationId: "não-é-um-uuid", novaData: "2026-10-01" });

    expect(r.ok).toBe(false);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("data fora do formato AAAA-MM-DD é recusada", async () => {
    const { darCarenciaExtra } = await acoes();

    const r = await darCarenciaExtra({ organizationId: ORG, novaData: "01/10/2026" });

    expect(r.ok).toBe(false);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("data no passado é recusada", async () => {
    const { darCarenciaExtra } = await acoes();

    const r = await darCarenciaExtra({ organizationId: ORG, novaData: "2026-09-01" });

    expect(r.ok).toBe(false);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("data a mais de 90 dias de hoje é recusada", async () => {
    const { darCarenciaExtra } = await acoes();

    const r = await darCarenciaExtra({ organizationId: ORG, novaData: "2027-01-01" });

    expect(r.ok).toBe(false);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("31/02 (dia que fevereiro não tem) é recusado, não normalizado em silêncio para março", async () => {
    const { darCarenciaExtra } = await acoes();

    const r = await darCarenciaExtra({ organizationId: ORG, novaData: "2026-02-31" });

    expect(r).toEqual({ ok: false, error: "Data inválida." });
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("chama a RPC com organizationId, p_ate no fim do dia em America/Sao_Paulo e p_actor", async () => {
    const { darCarenciaExtra } = await acoes();

    await darCarenciaExtra({ organizationId: ORG, novaData: "2026-10-01" });

    expect(h.rpc).toHaveBeenCalledWith("fn_billing_estender_carencia", {
      p_org: ORG,
      p_ate: "2026-10-02T02:59:59.000Z",
      p_actor: USUARIO,
    });
  });

  it("organização sem contrato é recusada com frase fixa", async () => {
    h.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: "P0002", message: "billing_carencia_organizacao_sem_contrato" },
    });
    const { darCarenciaExtra } = await acoes();

    const r = await darCarenciaExtra({ organizationId: ORG, novaData: "2026-10-01" });

    expect(r).toEqual({ ok: false, error: "Organização não encontrada." });
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("organização sem bloqueio programado é recusada com frase fixa", async () => {
    h.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: "P0002", message: "billing_carencia_sem_bloqueio_programado" },
    });
    const { darCarenciaExtra } = await acoes();

    const r = await darCarenciaExtra({ organizationId: ORG, novaData: "2026-10-01" });

    expect(r).toEqual({
      ok: false,
      error: "Esta organização não tem bloqueio programado; não há carência para estender.",
    });
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("data que não é posterior à carência atual é recusada com frase fixa (só adia, nunca antecipa)", async () => {
    h.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: "22023", message: "billing_carencia_data_nao_posterior" },
    });
    const { darCarenciaExtra } = await acoes();

    const r = await darCarenciaExtra({ organizationId: ORG, novaData: "2026-10-01" });

    expect(r).toEqual({ ok: false, error: "A nova data precisa ser depois da carência atual." });
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("🔒 erro do banco na RPC não aparece na resposta", async () => {
    const MENSAGEM_MARCADA = 'relation "segredo_interno" does not exist';
    h.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: "42P01", message: MENSAGEM_MARCADA },
    });
    const { darCarenciaExtra } = await acoes();

    const r = await darCarenciaExtra({ organizationId: ORG, novaData: "2026-10-01" });

    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(MENSAGEM_MARCADA);
    expect(h.audit).not.toHaveBeenCalled();
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
