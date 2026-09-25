import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * AS SEIS ESCRITAS DO ADMIN DA PLATAFORMA SOBRE A ASSINATURA (fase F4,
 * tarefa 5), no molde de `tests/unit/planos-tokens-acoes-do-admin.test.ts`
 * (fase F2-B, tarefa 4).
 *
 * ─── O que cada caso prende ─────────────────────────────────────────────────
 *
 * Escopo `support_readonly` e MFA em dívida recusam ANTES de qualquer RPC,
 * mesma régua de `app/api/v1/admin/tenants/route.ts:166`. Entrada fora do
 * formato (uuid inválido, data que não existe no calendário, valor não
 * positivo, estado fora do vocabulário, motivo obrigatório vazio) também não
 * chega à RPC. Cada errcode do Postgres vira a frase certa; qualquer outro
 * nunca aparece na resposta. Sucesso audita SEM A NOTA (mas COM o motivo,
 * quando a função pede), e só quando a RPC diz que ESTA chamada escreveu de
 * fato (reenvio com a mesma chave não audita de novo).
 */

const USUARIO = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";
const CHAVE = "33333333-3333-4333-8333-333333333333";
const PAGAMENTO = "44444444-4444-4444-8444-444444444444";

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
});

async function acoes() {
  return import("@/app/actions/admin/assinaturaDaOrganizacao");
}

describe("registrarPagamento", () => {
  const RESULTADO_ESCRITA = {
    ja_registrado: false,
    payment_id: PAGAMENTO,
    current_period_start: "2026-09-24T00:00:00Z",
    current_period_end: "2026-10-24T03:00:00Z",
    status_contrato: "ativa",
  };

  beforeEach(() => {
    h.rpc.mockResolvedValue({ data: RESULTADO_ESCRITA, error: null });
  });

  it("⭐ admin com escopo support_readonly é recusado e nenhuma RPC é chamada", async () => {
    h.guard.mockResolvedValueOnce(ADMIN_SUPORTE);
    const { registrarPagamento } = await acoes();

    const r = await registrarPagamento({ organizationId: ORG, fim: "2026-10-24", valorCents: 5000, chave: CHAVE });

    expect(r.ok).toBe(false);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("⭐ com MFA em dívida, nenhuma RPC é chamada", async () => {
    h.mfaEmDivida.mockResolvedValueOnce(true);
    const { registrarPagamento } = await acoes();

    const r = await registrarPagamento({ organizationId: ORG, fim: "2026-10-24", valorCents: 5000, chave: CHAVE });

    expect(r.ok).toBe(false);
    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("data de calendário inválida (31/02) é recusada sem RPC", async () => {
    const { registrarPagamento } = await acoes();

    const r = await registrarPagamento({ organizationId: ORG, fim: "2026-02-31", valorCents: 5000, chave: CHAVE });

    expect(r.ok).toBe(false);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("valor zero ou negativo é recusado sem RPC", async () => {
    const { registrarPagamento } = await acoes();

    const r = await registrarPagamento({ organizationId: ORG, fim: "2026-10-24", valorCents: 0, chave: CHAVE });

    expect(r.ok).toBe(false);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("chave que não é uuid é recusada sem RPC", async () => {
    const { registrarPagamento } = await acoes();

    const r = await registrarPagamento({
      organizationId: ORG,
      fim: "2026-10-24",
      valorCents: 5000,
      chave: "não-é-um-uuid",
    });

    expect(r.ok).toBe(false);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("🔒 erro qualquer do banco NÃO aparece na resposta", async () => {
    const MENSAGEM_MARCADA = 'relation "segredo_interno" does not exist';
    h.rpc.mockResolvedValueOnce({ data: null, error: { code: "42P01", message: MENSAGEM_MARCADA } });
    const { registrarPagamento } = await acoes();

    const r = await registrarPagamento({ organizationId: ORG, fim: "2026-10-24", valorCents: 5000, chave: CHAVE });

    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(MENSAGEM_MARCADA);
  });

  it("billing_contrato_nao_encontrado (P0002) devolve 'Organização não encontrada.'", async () => {
    h.rpc.mockResolvedValueOnce({ data: null, error: { code: "P0002", message: "billing_contrato_nao_encontrado" } });
    const { registrarPagamento } = await acoes();

    const r = await registrarPagamento({ organizationId: ORG, fim: "2026-10-24", valorCents: 5000, chave: CHAVE });

    expect(r).toEqual({ ok: false, error: "Organização não encontrada." });
  });

  it("billing_fim_anterior_ao_periodo_atual (22023) devolve a frase certa", async () => {
    h.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: "22023", message: "billing_fim_anterior_ao_periodo_atual" },
    });
    const { registrarPagamento } = await acoes();

    const r = await registrarPagamento({ organizationId: ORG, fim: "2026-10-24", valorCents: 5000, chave: CHAVE });

    expect(r).toEqual({ ok: false, error: "A data de fim precisa ser posterior ao período atual." });
  });

  it("sucesso audita fim, valor e chave, SEM a nota, e revalida a aba", async () => {
    const { registrarPagamento } = await acoes();

    const r = await registrarPagamento({
      organizationId: ORG,
      fim: "2026-10-24",
      valorCents: 5000,
      chave: CHAVE,
      nota: "combinado por telefone, contém dado do cliente",
    });

    expect(r).toEqual({ ok: true, jaRegistrado: false, dados: RESULTADO_ESCRITA });
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "billing.payment_registered",
        resourceId: ORG,
        metadata: expect.objectContaining({ fim: "2026-10-24", valor_cents: 5000, chave: CHAVE }),
      }),
    );
    const metadataEnviado = h.audit.mock.calls[0]![0].metadata;
    expect(JSON.stringify(metadataEnviado)).not.toContain("telefone");
    expect(h.revalidatePath).toHaveBeenCalledWith(`/admin/tenants/${ORG}/plano`);
  });

  it("reenvio com a mesma chave (ja_registrado: true) não audita de novo", async () => {
    h.rpc.mockResolvedValueOnce({ data: { ...RESULTADO_ESCRITA, ja_registrado: true }, error: null });
    const { registrarPagamento } = await acoes();

    const r = await registrarPagamento({ organizationId: ORG, fim: "2026-10-24", valorCents: 5000, chave: CHAVE });

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.jaRegistrado).toBe(true);
    expect(h.audit).not.toHaveBeenCalled();
  });
});

describe("estornarPagamento", () => {
  beforeEach(() => {
    h.rpc.mockResolvedValue({ data: { ja_registrado: false, estorno_id: PAGAMENTO }, error: null });
  });

  it("⭐ admin com escopo support_readonly é recusado e nenhuma RPC é chamada", async () => {
    h.guard.mockResolvedValueOnce(ADMIN_SUPORTE);
    const { estornarPagamento } = await acoes();

    const r = await estornarPagamento({ organizationId: ORG, pagamentoId: PAGAMENTO, chave: CHAVE });

    expect(r.ok).toBe(false);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("pagamento de outra organização (42501) devolve a MESMA frase de 'não encontrado'", async () => {
    h.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: "42501", message: "billing_pagamento_de_outra_organizacao" },
    });
    const { estornarPagamento } = await acoes();

    const r = await estornarPagamento({ organizationId: ORG, pagamentoId: PAGAMENTO, chave: CHAVE });

    expect(r).toEqual({ ok: false, error: "Pagamento não encontrado." });
  });

  it("pagamento já estornado (22023) devolve a frase certa", async () => {
    h.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: "22023", message: "billing_pagamento_nao_pode_ser_estornado" },
    });
    const { estornarPagamento } = await acoes();

    const r = await estornarPagamento({ organizationId: ORG, pagamentoId: PAGAMENTO, chave: CHAVE });

    expect(r).toEqual({ ok: false, error: "Este pagamento já foi estornado e não pode ser estornado de novo." });
  });

  it("segundo estorno do mesmo pagamento por OUTRA chave (billing_pagamento_ja_estornado, 22023) devolve a frase certa", async () => {
    h.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: "22023", message: "billing_pagamento_ja_estornado" },
    });
    const { estornarPagamento } = await acoes();

    const r = await estornarPagamento({ organizationId: ORG, pagamentoId: PAGAMENTO, chave: CHAVE });

    expect(r).toEqual({ ok: false, error: "Este pagamento já foi estornado." });
  });

  it("sucesso audita pagamento_id e chave, SEM a nota", async () => {
    const { estornarPagamento } = await acoes();

    const r = await estornarPagamento({
      organizationId: ORG,
      pagamentoId: PAGAMENTO,
      chave: CHAVE,
      nota: "dado sensível do cliente",
    });

    expect(r).toEqual({ ok: true, jaRegistrado: false, dados: { ja_registrado: false, estorno_id: PAGAMENTO } });
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "billing.payment_refunded",
        metadata: { pagamento_id: PAGAMENTO, chave: CHAVE, estorno_id: PAGAMENTO },
      }),
    );
  });

  it("reenvio com a mesma chave (ja_registrado: true) não audita de novo", async () => {
    h.rpc.mockResolvedValueOnce({ data: { ja_registrado: true, estorno_id: PAGAMENTO }, error: null });
    const { estornarPagamento } = await acoes();

    const r = await estornarPagamento({ organizationId: ORG, pagamentoId: PAGAMENTO, chave: CHAVE });

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.jaRegistrado).toBe(true);
    expect(h.audit).not.toHaveBeenCalled();
  });
});

describe("corrigirPeriodo", () => {
  beforeEach(() => {
    h.rpc.mockResolvedValue({
      data: { current_period_end_anterior: "2026-09-24T03:00:00Z", current_period_end_novo: "2026-10-24T03:00:00Z" },
      error: null,
    });
  });

  it("⭐ admin com escopo support_readonly é recusado e nenhuma RPC é chamada", async () => {
    h.guard.mockResolvedValueOnce(ADMIN_SUPORTE);
    const { corrigirPeriodo } = await acoes();

    const r = await corrigirPeriodo({ organizationId: ORG, fim: "2026-10-24", motivo: "erro de digitação" });

    expect(r.ok).toBe(false);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("motivo vazio é recusado sem RPC (a própria função também exige)", async () => {
    const { corrigirPeriodo } = await acoes();

    const r = await corrigirPeriodo({ organizationId: ORG, fim: "2026-10-24", motivo: "  " });

    expect(r.ok).toBe(false);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("billing_motivo_obrigatorio (22023) devolve a frase certa", async () => {
    h.rpc.mockResolvedValueOnce({ data: null, error: { code: "22023", message: "billing_motivo_obrigatorio" } });
    const { corrigirPeriodo } = await acoes();

    // O regex do zod ainda deixa passar um motivo com um único espaço não
    // trimado incorretamente; para exercitar o errcode do BANCO (e não só a
    // validação local), a entrada aqui já passa pelo zod.
    const r = await corrigirPeriodo({ organizationId: ORG, fim: "2026-10-24", motivo: "x" });

    expect(r).toEqual({ ok: false, error: "O motivo é obrigatório." });
  });

  it("sucesso audita fim e MOTIVO (não é a nota da carteira, é a justificativa exigida)", async () => {
    const { corrigirPeriodo } = await acoes();

    const r = await corrigirPeriodo({ organizationId: ORG, fim: "2026-10-24", motivo: "corrigindo erro de digitação" });

    expect(r.ok).toBe(true);
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "billing.period_corrected",
        metadata: expect.objectContaining({ fim: "2026-10-24", motivo: "corrigindo erro de digitação" }),
      }),
    );
  });

  it("sem chave idempotente: toda chamada bem sucedida audita (não há reenvio silencioso)", async () => {
    const { corrigirPeriodo } = await acoes();

    await corrigirPeriodo({ organizationId: ORG, fim: "2026-10-24", motivo: "1ª correção" });
    await corrigirPeriodo({ organizationId: ORG, fim: "2026-10-25", motivo: "2ª correção" });

    expect(h.audit).toHaveBeenCalledTimes(2);
  });
});

describe("mudarEstadoDaAssinatura", () => {
  beforeEach(() => {
    h.rpc.mockResolvedValue({ data: { estado_anterior: "ativa", estado_novo: "suspensa" }, error: null });
  });

  it("⭐ admin com escopo support_readonly é recusado e nenhuma RPC é chamada", async () => {
    h.guard.mockResolvedValueOnce(ADMIN_SUPORTE);
    const { mudarEstadoDaAssinatura } = await acoes();

    const r = await mudarEstadoDaAssinatura({ organizationId: ORG, estado: "suspensa" });

    expect(r.ok).toBe(false);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("estado fora do vocabulário é recusado sem RPC", async () => {
    const { mudarEstadoDaAssinatura } = await acoes();

    const r = await mudarEstadoDaAssinatura({ organizationId: ORG, estado: "pausada" as never });

    expect(r.ok).toBe(false);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("billing_estado_sem_periodo_vigente (22023) devolve a frase certa", async () => {
    h.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: "22023", message: "billing_estado_sem_periodo_vigente" },
    });
    const { mudarEstadoDaAssinatura } = await acoes();

    const r = await mudarEstadoDaAssinatura({ organizationId: ORG, estado: "ativa" });

    expect(r).toEqual({ ok: false, error: "Não há período vigente para voltar a ativa. Registre um pagamento antes." });
  });

  it("billing_transicao_nao_permitida (22023) devolve a frase certa", async () => {
    h.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: "22023", message: "billing_transicao_nao_permitida" },
    });
    const { mudarEstadoDaAssinatura } = await acoes();

    const r = await mudarEstadoDaAssinatura({ organizationId: ORG, estado: "avaliacao" });

    expect(r).toEqual({ ok: false, error: "Essa transição de estado não é permitida." });
  });

  it("billing_avaliacao_sem_data_futura (22023) devolve a frase certa", async () => {
    h.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: "22023", message: "billing_avaliacao_sem_data_futura" },
    });
    const { mudarEstadoDaAssinatura } = await acoes();

    const r = await mudarEstadoDaAssinatura({ organizationId: ORG, estado: "avaliacao" });

    expect(r).toEqual({
      ok: false,
      error: "Para pôr em avaliação, o período precisa terminar numa data futura. Corrija o período antes.",
    });
  });

  it("billing_cancele_no_asaas_antes (22023, fase F5/decisão 22) devolve a frase certa", async () => {
    h.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: "22023", message: "billing_cancele_no_asaas_antes" },
    });
    const { mudarEstadoDaAssinatura } = await acoes();

    const r = await mudarEstadoDaAssinatura({ organizationId: ORG, estado: "cancelada" });

    expect(r).toEqual({
      ok: false,
      error:
        "Esta organização tem assinatura ativa no Asaas. Cancele a assinatura no Asaas antes de mudar o estado para cancelada.",
    });
  });

  it("sucesso audita estado, motivo (quando informado) e a transição", async () => {
    const { mudarEstadoDaAssinatura } = await acoes();

    const r = await mudarEstadoDaAssinatura({ organizationId: ORG, estado: "suspensa", motivo: "inadimplência" });

    expect(r.ok).toBe(true);
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "billing.subscription_state_changed",
        metadata: {
          estado: "suspensa",
          motivo: "inadimplência",
          estado_anterior: "ativa",
          estado_novo: "suspensa",
        },
      }),
    );
  });

  it("motivo é opcional (a função SQL não o exige, só corrigirPeriodo exige)", async () => {
    const { mudarEstadoDaAssinatura } = await acoes();

    const r = await mudarEstadoDaAssinatura({ organizationId: ORG, estado: "suspensa" });

    expect(r.ok).toBe(true);
    expect(h.rpc).toHaveBeenCalledWith(
      "fn_billing_mudar_estado",
      expect.objectContaining({ p_motivo: null }),
    );
  });
});

describe("porEmAvaliacao", () => {
  it("⭐ admin com escopo support_readonly é recusado e nenhuma RPC é chamada", async () => {
    h.guard.mockResolvedValueOnce(ADMIN_SUPORTE);
    const { porEmAvaliacao } = await acoes();

    const r = await porEmAvaliacao({ organizationId: ORG, fim: "2026-11-01", motivo: "avaliação de 30 dias" });

    expect(r.ok).toBe(false);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("motivo vazio é recusado sem RPC", async () => {
    const { porEmAvaliacao } = await acoes();

    const r = await porEmAvaliacao({ organizationId: ORG, fim: "2026-11-01", motivo: "   " });

    expect(r.ok).toBe(false);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("chama as DUAS RPCs, na ordem certa (período primeiro, depois o estado)", async () => {
    h.rpc
      .mockResolvedValueOnce({
        data: { current_period_end_anterior: null, current_period_end_novo: "2026-11-01T03:00:00Z" },
        error: null,
      })
      .mockResolvedValueOnce({ data: { estado_anterior: "ativa", estado_novo: "avaliacao" }, error: null });
    const { porEmAvaliacao } = await acoes();

    const r = await porEmAvaliacao({ organizationId: ORG, fim: "2026-11-01", motivo: "avaliação de 30 dias" });

    expect(r.ok).toBe(true);
    expect(h.rpc).toHaveBeenNthCalledWith(1, "fn_billing_corrigir_periodo", expect.objectContaining({ p_org: ORG }));
    expect(h.rpc).toHaveBeenNthCalledWith(
      2,
      "fn_billing_mudar_estado",
      expect.objectContaining({ p_org: ORG, p_estado: "avaliacao" }),
    );
    expect(h.audit).toHaveBeenCalledTimes(2);
    expect(h.audit).toHaveBeenNthCalledWith(1, expect.objectContaining({ action: "billing.period_corrected" }));
    expect(h.audit).toHaveBeenNthCalledWith(2, expect.objectContaining({ action: "billing.subscription_state_changed" }));
  });

  it("se o PRIMEIRO passo falhar, o segundo nunca é chamado e nada é auditado", async () => {
    h.rpc.mockResolvedValueOnce({ data: null, error: { code: "22023", message: "billing_motivo_obrigatorio" } });
    const { porEmAvaliacao } = await acoes();

    const r = await porEmAvaliacao({ organizationId: ORG, fim: "2026-11-01", motivo: "avaliação" });

    expect(r.ok).toBe(false);
    expect(h.rpc).toHaveBeenCalledTimes(1);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("se o SEGUNDO passo falhar, o período já auditado no primeiro continua auditado (não é atômico)", async () => {
    h.rpc
      .mockResolvedValueOnce({
        data: { current_period_end_anterior: null, current_period_end_novo: "2026-11-01T03:00:00Z" },
        error: null,
      })
      .mockResolvedValueOnce({
        data: null,
        error: { code: "22023", message: "billing_transicao_nao_permitida" },
      });
    const { porEmAvaliacao } = await acoes();

    const r = await porEmAvaliacao({ organizationId: ORG, fim: "2026-11-01", motivo: "avaliação" });

    expect(r).toEqual({ ok: false, error: "Essa transição de estado não é permitida." });
    // O primeiro passo ESCREVEU de verdade: a auditoria dele não desaparece
    // só porque o segundo passo falhou.
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "billing.period_corrected" }));
  });
});

describe("cancelarNoFimDoPeriodo", () => {
  beforeEach(() => {
    h.rpc.mockResolvedValue({ data: { cancel_at_period_end: true }, error: null });
  });

  it("⭐ admin com escopo support_readonly é recusado e nenhuma RPC é chamada", async () => {
    h.guard.mockResolvedValueOnce(ADMIN_SUPORTE);
    const { cancelarNoFimDoPeriodo } = await acoes();

    const r = await cancelarNoFimDoPeriodo({ organizationId: ORG, sim: true });

    expect(r.ok).toBe(false);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("⭐ com MFA em dívida, nenhuma RPC é chamada", async () => {
    h.mfaEmDivida.mockResolvedValueOnce(true);
    const { cancelarNoFimDoPeriodo } = await acoes();

    const r = await cancelarNoFimDoPeriodo({ organizationId: ORG, sim: true });

    expect(r.ok).toBe(false);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("sim que não é booleano é recusado sem RPC", async () => {
    const { cancelarNoFimDoPeriodo } = await acoes();

    const r = await cancelarNoFimDoPeriodo({ organizationId: ORG, sim: "sim" as never });

    expect(r.ok).toBe(false);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("sucesso audita cancel_at_period_end e revalida a aba", async () => {
    const { cancelarNoFimDoPeriodo } = await acoes();

    const r = await cancelarNoFimDoPeriodo({ organizationId: ORG, sim: true });

    expect(r).toEqual({ ok: true, jaRegistrado: false, dados: { cancel_at_period_end: true } });
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "billing.cancel_at_period_end_changed",
        metadata: { cancel_at_period_end: true },
      }),
    );
    expect(h.revalidatePath).toHaveBeenCalledWith(`/admin/tenants/${ORG}/plano`);
  });
});
