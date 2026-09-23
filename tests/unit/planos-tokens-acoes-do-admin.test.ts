import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * AS QUATRO ESCRITAS DO ADMIN DA PLATAFORMA SOBRE A CARTEIRA DE TOKENS DE IA
 * (fase F2-B, tarefa 4), no molde de `tests/unit/planos-acoes-do-admin.test.ts`
 * (fase F1, tarefa 4).
 *
 * ─── O que cada caso prende ─────────────────────────────────────────────────
 *
 * Escopo `support_readonly` e MFA em dívida recusam ANTES de qualquer RPC,
 * mesma régua de `app/api/v1/admin/tenants/route.ts:166`. Entrada fora do
 * formato (uuid inválido, tokens não positivos, fonte desconhecida, ajuste
 * sem nota) também não chega à RPC. A organização é conferida no banco ANTES
 * da RPC (nenhuma das quatro funções SQL levanta `organizacao_nao_encontrada`
 * sozinha, ao contrário de `fn_billing_trocar_plano`): inexistente devolve a
 * frase fixa sem nunca chamar a função de escrita. Cada errcode do Postgres
 * vira a frase certa; qualquer outro nunca aparece na resposta. Sucesso
 * audita SEM A NOTA, e só quando a RPC diz que ESTA chamada escreveu de fato
 * (reenvio com a mesma chave não audita de novo).
 */

const USUARIO = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";
const CHAVE = "33333333-3333-4333-8333-333333333333";
const ADICIONAL = "44444444-4444-4444-8444-444444444444";

const h = vi.hoisted(() => ({
  guard: vi.fn(),
  rpc: vi.fn(),
  from: vi.fn(),
  audit: vi.fn(),
  revalidatePath: vi.fn(),
  mfaEmDivida: vi.fn(),
}));

vi.mock("@/lib/auth/requirePlatformAdmin", () => ({ requirePlatformAdmin: h.guard }));
vi.mock("@/lib/auth/server", () => ({ mfaEmDivida: h.mfaEmDivida }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc: h.rpc, from: h.from }) }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

const ADMIN_FULL = { user: { id: USUARIO }, platformAdmin: { scope: "full" } };
const ADMIN_SUPORTE = { user: { id: USUARIO }, platformAdmin: { scope: "support_readonly" } };

/** `.from("organizations").select("id").eq("id", ...).maybeSingle()`. */
function organizacaoBuilder(existe: boolean) {
  return {
    select: () => ({
      eq: () => ({
        maybeSingle: async () => (existe ? { data: { id: ORG }, error: null } : { data: null, error: null }),
      }),
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.guard.mockResolvedValue(ADMIN_FULL);
  h.mfaEmDivida.mockResolvedValue(false);
  h.from.mockReturnValue(organizacaoBuilder(true));
});

async function acoes() {
  return import("@/app/actions/admin/carteiraDeTokens");
}

describe("creditarTokens", () => {
  beforeEach(() => {
    h.rpc.mockResolvedValue({ data: { creditado: true, saldo_avulso: 5000 }, error: null });
  });

  it("⭐ admin com escopo support_readonly é recusado e nenhuma RPC é chamada", async () => {
    h.guard.mockResolvedValueOnce(ADMIN_SUPORTE);
    const { creditarTokens } = await acoes();

    const r = await creditarTokens({ organizationId: ORG, tokens: 1000, chave: CHAVE });

    expect(r.ok).toBe(false);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("⭐ com MFA em dívida, nenhuma RPC é chamada", async () => {
    h.mfaEmDivida.mockResolvedValueOnce(true);
    const { creditarTokens } = await acoes();

    const r = await creditarTokens({ organizationId: ORG, tokens: 1000, chave: CHAVE });

    expect(r.ok).toBe(false);
    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("chave que não é uuid é recusada sem RPC", async () => {
    const { creditarTokens } = await acoes();

    const r = await creditarTokens({ organizationId: ORG, tokens: 1000, chave: "não-é-um-uuid" });

    expect(r.ok).toBe(false);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("tokens zero ou negativo é recusado sem RPC", async () => {
    const { creditarTokens } = await acoes();

    const r = await creditarTokens({ organizationId: ORG, tokens: 0, chave: CHAVE });

    expect(r.ok).toBe(false);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("organização inexistente devolve a frase fixa sem chamar a RPC", async () => {
    h.from.mockReturnValue(organizacaoBuilder(false));
    const { creditarTokens } = await acoes();

    const r = await creditarTokens({ organizationId: ORG, tokens: 1000, chave: CHAVE });

    expect(r).toEqual({ ok: false, error: "Organização não encontrada." });
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("🔒 erro qualquer do banco NÃO aparece na resposta", async () => {
    const MENSAGEM_MARCADA = 'relation "segredo_interno" does not exist';
    h.rpc.mockResolvedValueOnce({ data: null, error: { code: "42P01", message: MENSAGEM_MARCADA } });
    const { creditarTokens } = await acoes();

    const r = await creditarTokens({ organizationId: ORG, tokens: 1000, chave: CHAVE });

    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(MENSAGEM_MARCADA);
  });

  it("sucesso audita tokens e chave, SEM a nota, e revalida a aba", async () => {
    const { creditarTokens } = await acoes();

    const r = await creditarTokens({
      organizationId: ORG,
      tokens: 1000,
      chave: CHAVE,
      valorCents: 5000,
      nota: "combinado por telefone, contém dado do cliente",
    });

    expect(r).toEqual({ ok: true, jaRegistrado: false, dados: { creditado: true, saldo_avulso: 5000 } });
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "billing.tokens_credited",
        resourceId: ORG,
        metadata: { tokens: 1000, chave: CHAVE, valor_cents: 5000 },
      }),
    );
    const metadataEnviado = h.audit.mock.calls[0]![0].metadata;
    expect(JSON.stringify(metadataEnviado)).not.toContain("telefone");
    expect(h.revalidatePath).toHaveBeenCalledWith(`/admin/tenants/${ORG}/plano`);
  });

  it("reenvio com a mesma chave (creditado: false) não audita de novo", async () => {
    h.rpc.mockResolvedValueOnce({ data: { creditado: false, saldo_avulso: 5000 }, error: null });
    const { creditarTokens } = await acoes();

    const r = await creditarTokens({ organizationId: ORG, tokens: 1000, chave: CHAVE });

    expect(r).toEqual({ ok: true, jaRegistrado: true, dados: { creditado: false, saldo_avulso: 5000 } });
    expect(h.audit).not.toHaveBeenCalled();
  });
});

describe("contratarAdicional", () => {
  beforeEach(() => {
    h.rpc.mockResolvedValue({ data: { id: CHAVE, criado: true }, error: null });
  });

  it("⭐ admin com escopo support_readonly é recusado e nenhuma RPC é chamada", async () => {
    h.guard.mockResolvedValueOnce(ADMIN_SUPORTE);
    const { contratarAdicional } = await acoes();

    const r = await contratarAdicional({ organizationId: ORG, tokensPorCiclo: 100000, chave: CHAVE });

    expect(r.ok).toBe(false);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("organização inexistente devolve a frase fixa sem chamar a RPC", async () => {
    h.from.mockReturnValue(organizacaoBuilder(false));
    const { contratarAdicional } = await acoes();

    const r = await contratarAdicional({ organizationId: ORG, tokensPorCiclo: 100000, chave: CHAVE });

    expect(r).toEqual({ ok: false, error: "Organização não encontrada." });
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("sucesso audita SEM a nota, com acao: contratado, e revalida a aba", async () => {
    const { contratarAdicional } = await acoes();

    const r = await contratarAdicional({
      organizationId: ORG,
      tokensPorCiclo: 100000,
      chave: CHAVE,
      nota: "dado sensível do cliente",
    });

    expect(r).toEqual({ ok: true, jaRegistrado: false, dados: { id: CHAVE, criado: true } });
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "billing.addon_changed",
        metadata: { acao: "contratado", adicional_id: CHAVE, tokens_por_ciclo: 100000, chave: CHAVE, valor_cents: null },
      }),
    );
    expect(h.revalidatePath).toHaveBeenCalledWith(`/admin/tenants/${ORG}/plano`);
  });

  it("reenvio com a mesma chave (criado: false) não audita de novo", async () => {
    h.rpc.mockResolvedValueOnce({ data: { id: CHAVE, criado: false }, error: null });
    const { contratarAdicional } = await acoes();

    const r = await contratarAdicional({ organizationId: ORG, tokensPorCiclo: 100000, chave: CHAVE });

    expect(r).toEqual({ ok: true, jaRegistrado: true, dados: { id: CHAVE, criado: false } });
    expect(h.audit).not.toHaveBeenCalled();
  });
});

describe("cancelarAdicional", () => {
  it("⭐ admin com escopo support_readonly é recusado e nenhuma RPC é chamada", async () => {
    h.guard.mockResolvedValueOnce(ADMIN_SUPORTE);
    const { cancelarAdicional } = await acoes();

    const r = await cancelarAdicional({ organizationId: ORG, adicionalId: ADICIONAL });

    expect(r.ok).toBe(false);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("adicional inexistente (P0002) devolve a frase fixa", async () => {
    h.rpc.mockResolvedValueOnce({ data: null, error: { code: "P0002", message: "adicional_nao_encontrado" } });
    const { cancelarAdicional } = await acoes();

    const r = await cancelarAdicional({ organizationId: ORG, adicionalId: ADICIONAL });

    expect(r).toEqual({ ok: false, error: "Adicional não encontrado." });
  });

  it("adicional de outra organização (42501) devolve a MESMA frase de 'não encontrado', sem revelar nada", async () => {
    h.rpc.mockResolvedValueOnce({ data: null, error: { code: "42501", message: "adicional_de_outra_organizacao" } });
    const { cancelarAdicional } = await acoes();

    const r = await cancelarAdicional({ organizationId: ORG, adicionalId: ADICIONAL });

    expect(r).toEqual({ ok: false, error: "Adicional não encontrado." });
  });

  it("sucesso (cancelado_agora: true) audita acao: cancelado", async () => {
    h.rpc.mockResolvedValueOnce({ data: { id: ADICIONAL, cancelado: true, cancelado_agora: true }, error: null });
    const { cancelarAdicional } = await acoes();

    const r = await cancelarAdicional({ organizationId: ORG, adicionalId: ADICIONAL });

    expect(r).toEqual({
      ok: true,
      jaRegistrado: false,
      dados: { id: ADICIONAL, cancelado: true, cancelado_agora: true },
    });
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "billing.addon_changed",
        metadata: { acao: "cancelado", adicional_id: ADICIONAL },
      }),
    );
  });

  it("reenvio (cancelado_agora: false, já estava cancelado) não audita de novo", async () => {
    h.rpc.mockResolvedValueOnce({ data: { id: ADICIONAL, cancelado: true, cancelado_agora: false }, error: null });
    const { cancelarAdicional } = await acoes();

    const r = await cancelarAdicional({ organizationId: ORG, adicionalId: ADICIONAL });

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.jaRegistrado).toBe(true);
    expect(h.audit).not.toHaveBeenCalled();
  });
});

describe("ajustarTokens", () => {
  beforeEach(() => {
    h.rpc.mockResolvedValue({ data: { ajustado: true, saldo: 900000 }, error: null });
  });

  it("⭐ admin com escopo support_readonly é recusado e nenhuma RPC é chamada", async () => {
    h.guard.mockResolvedValueOnce(ADMIN_SUPORTE);
    const { ajustarTokens } = await acoes();

    const r = await ajustarTokens({
      organizationId: ORG,
      fonte: "plano",
      tokens: -1000,
      chave: CHAVE,
      nota: "estorno de débito errado",
    });

    expect(r.ok).toBe(false);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("tokens zero é recusado sem RPC (a nota sozinha não bastaria: o banco também recusa)", async () => {
    const { ajustarTokens } = await acoes();

    const r = await ajustarTokens({ organizationId: ORG, fonte: "plano", tokens: 0, chave: CHAVE, nota: "x" });

    expect(r.ok).toBe(false);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("fonte fora do vocabulário é recusada sem RPC", async () => {
    const { ajustarTokens } = await acoes();

    const r = await ajustarTokens({
      organizationId: ORG,
      fonte: "fonte_que_nao_existe" as never,
      tokens: -100,
      chave: CHAVE,
      nota: "x",
    });

    expect(r.ok).toBe(false);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("nota vazia é recusada sem RPC (obrigatória no ajuste)", async () => {
    const { ajustarTokens } = await acoes();

    const r = await ajustarTokens({ organizationId: ORG, fonte: "plano", tokens: -100, chave: CHAVE, nota: "  " });

    expect(r.ok).toBe(false);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("compensaId que não é uuid é recusado sem RPC", async () => {
    const { ajustarTokens } = await acoes();

    const r = await ajustarTokens({
      organizationId: ORG,
      fonte: "plano",
      tokens: -100,
      chave: CHAVE,
      compensaId: "não-é-um-uuid",
      nota: "estorno",
    });

    expect(r.ok).toBe(false);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("linha de compensação inválida (42501 ajuste_compensa_linha_invalida) devolve a frase certa", async () => {
    h.rpc.mockResolvedValueOnce({ data: null, error: { code: "42501", message: "ajuste_compensa_linha_invalida" } });
    const { ajustarTokens } = await acoes();

    const r = await ajustarTokens({
      organizationId: ORG,
      fonte: "plano",
      tokens: -100,
      chave: CHAVE,
      compensaId: ADICIONAL,
      nota: "estorno",
    });

    expect(r).toEqual({ ok: false, error: "A linha informada para compensar não foi encontrada." });
  });

  it("sucesso audita fonte, tokens (com sinal), chave e compensa_id, SEM a nota", async () => {
    const { ajustarTokens } = await acoes();

    const r = await ajustarTokens({
      organizationId: ORG,
      fonte: "avulso",
      tokens: -5000,
      chave: CHAVE,
      compensaId: ADICIONAL,
      nota: "estorno de débito lançado errado, contém detalhe do caso do cliente",
    });

    expect(r).toEqual({ ok: true, jaRegistrado: false, dados: { ajustado: true, saldo: 900000 } });
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "billing.tokens_adjusted",
        metadata: { fonte: "avulso", tokens: -5000, chave: CHAVE, compensa_id: ADICIONAL },
      }),
    );
    const metadataEnviado = h.audit.mock.calls[0]![0].metadata;
    expect(JSON.stringify(metadataEnviado)).not.toContain("cliente");
  });

  it("reenvio com a mesma chave (ajustado: false) não audita de novo", async () => {
    h.rpc.mockResolvedValueOnce({ data: { ajustado: false, saldo: 900000 }, error: null });
    const { ajustarTokens } = await acoes();

    const r = await ajustarTokens({
      organizationId: ORG,
      fonte: "plano",
      tokens: -100,
      chave: CHAVE,
      nota: "estorno",
    });

    expect(r).toEqual({ ok: true, jaRegistrado: true, dados: { ajustado: false, saldo: 900000 } });
    expect(h.audit).not.toHaveBeenCalled();
  });
});
