import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Fase F4, tarefa 8: `creditarPacote` (`app/actions/admin/carteiraDeTokens.ts`)
 * e o cadastro do catálogo, `criarPacote`/`desativarPacote`
 * (`app/actions/admin/pacotesDeTokens.ts`). No molde de
 * `tests/unit/planos-tokens-acoes-do-admin.test.ts`: escopo `support_readonly`
 * e MFA em dívida recusam ANTES de qualquer escrita, entrada fora do formato
 * não chega ao banco, cada errcode vira a frase certa, sucesso audita SEM a
 * nota e só quando a escrita aconteceu de fato, e reenvio com a mesma chave
 * não audita de novo.
 */

const USUARIO = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";
const CHAVE = "33333333-3333-4333-8333-333333333333";
const PACOTE = "44444444-4444-4444-8444-444444444444";

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

beforeEach(() => {
  vi.clearAllMocks();
  h.guard.mockResolvedValue(ADMIN_FULL);
  h.mfaEmDivida.mockResolvedValue(false);
});

// ───────────────────────────────────────────────────────────────────────
// creditarPacote (app/actions/admin/carteiraDeTokens.ts)
// ───────────────────────────────────────────────────────────────────────

async function acoesDaCarteira() {
  return import("@/app/actions/admin/carteiraDeTokens");
}

describe("creditarPacote", () => {
  beforeEach(() => {
    h.rpc.mockResolvedValue({
      data: { creditado: true, saldo_avulso: 5000, pacote_id: PACOTE, tokens: 100000, valor_cents: 9900 },
      error: null,
    });
  });

  it("⭐ admin com escopo support_readonly é recusado e nenhuma RPC é chamada", async () => {
    h.guard.mockResolvedValueOnce(ADMIN_SUPORTE);
    const { creditarPacote } = await acoesDaCarteira();

    const r = await creditarPacote({ organizationId: ORG, pacoteId: PACOTE, chave: CHAVE });

    expect(r.ok).toBe(false);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("⭐ com MFA em dívida, nenhuma RPC é chamada", async () => {
    h.mfaEmDivida.mockResolvedValueOnce(true);
    const { creditarPacote } = await acoesDaCarteira();

    const r = await creditarPacote({ organizationId: ORG, pacoteId: PACOTE, chave: CHAVE });

    expect(r.ok).toBe(false);
    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("pacoteId que não é uuid é recusado sem RPC", async () => {
    const { creditarPacote } = await acoesDaCarteira();

    const r = await creditarPacote({ organizationId: ORG, pacoteId: "não-é-um-uuid", chave: CHAVE });

    expect(r.ok).toBe(false);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("pacote inexistente (P0002) devolve a frase fixa", async () => {
    h.rpc.mockResolvedValueOnce({ data: null, error: { code: "P0002", message: "billing_pacote_nao_encontrado" } });
    const { creditarPacote } = await acoesDaCarteira();

    const r = await creditarPacote({ organizationId: ORG, pacoteId: PACOTE, chave: CHAVE });

    expect(r).toEqual({ ok: false, error: "Pacote não encontrado." });
  });

  it("pacote inativo (22023) devolve a frase fixa", async () => {
    h.rpc.mockResolvedValueOnce({ data: null, error: { code: "22023", message: "billing_pacote_inativo" } });
    const { creditarPacote } = await acoesDaCarteira();

    const r = await creditarPacote({ organizationId: ORG, pacoteId: PACOTE, chave: CHAVE });

    expect(r).toEqual({ ok: false, error: "Este pacote não está mais à venda." });
  });

  it("sem preço no catálogo e sem valor informado (22023) devolve a frase fixa", async () => {
    h.rpc.mockResolvedValueOnce({ data: null, error: { code: "22023", message: "billing_valor_obrigatorio" } });
    const { creditarPacote } = await acoesDaCarteira();

    const r = await creditarPacote({ organizationId: ORG, pacoteId: PACOTE, chave: CHAVE });

    expect(r).toEqual({ ok: false, error: "Este pacote não tem preço no catálogo: informe o valor recebido." });
  });

  it("🔒 erro qualquer do banco NÃO aparece na resposta", async () => {
    const MENSAGEM_MARCADA = 'relation "segredo_interno" does not exist';
    h.rpc.mockResolvedValueOnce({ data: null, error: { code: "42P01", message: MENSAGEM_MARCADA } });
    const { creditarPacote } = await acoesDaCarteira();

    const r = await creditarPacote({ organizationId: ORG, pacoteId: PACOTE, chave: CHAVE });

    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(MENSAGEM_MARCADA);
  });

  it("sucesso audita pacote, tokens e valor, SEM a nota, e revalida a aba", async () => {
    const { creditarPacote } = await acoesDaCarteira();

    const r = await creditarPacote({
      organizationId: ORG,
      pacoteId: PACOTE,
      chave: CHAVE,
      nota: "combinado por telefone, contém dado do cliente",
    });

    expect(r.ok).toBe(true);
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "billing.token_pack_credited",
        resourceId: ORG,
        metadata: { pacote_id: PACOTE, tokens: 100000, valor_cents: 9900, chave: CHAVE },
      }),
    );
    const metadataEnviado = h.audit.mock.calls[0]![0].metadata;
    expect(JSON.stringify(metadataEnviado)).not.toContain("telefone");
    expect(h.revalidatePath).toHaveBeenCalledWith(`/admin/tenants/${ORG}/plano`);
  });

  it("reenvio com a mesma chave (creditado: false) não audita de novo", async () => {
    h.rpc.mockResolvedValueOnce({
      data: { creditado: false, saldo_avulso: 5000, pacote_id: PACOTE, tokens: 100000, valor_cents: 9900 },
      error: null,
    });
    const { creditarPacote } = await acoesDaCarteira();

    const r = await creditarPacote({ organizationId: ORG, pacoteId: PACOTE, chave: CHAVE });

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.jaRegistrado).toBe(true);
    expect(h.audit).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────
// criarPacote / desativarPacote (app/actions/admin/pacotesDeTokens.ts)
// ───────────────────────────────────────────────────────────────────────

async function acoesDoCatalogo() {
  return import("@/app/actions/admin/pacotesDeTokens");
}

/** `.from("billing_token_pacotes").insert(...).select("id").single()`. */
function insertBuilder(resultado: { data: unknown; error: unknown }) {
  return {
    insert: () => ({
      select: () => ({
        single: async () => resultado,
      }),
    }),
  };
}

/** `.from("billing_token_pacotes").update(...).eq("id", ...)`. */
function updateBuilder(resultado: { error: unknown }) {
  return {
    update: () => ({
      eq: async () => resultado,
    }),
  };
}

describe("criarPacote", () => {
  beforeEach(() => {
    h.from.mockReturnValue(insertBuilder({ data: { id: PACOTE }, error: null }));
  });

  it("⭐ admin com escopo support_readonly é recusado e nenhuma escrita é feita", async () => {
    h.guard.mockResolvedValueOnce(ADMIN_SUPORTE);
    const { criarPacote } = await acoesDoCatalogo();

    const r = await criarPacote({ codigo: "pacote_100k", nome: "100 mil tokens", tokens: 100000 });

    expect(r.ok).toBe(false);
    expect(h.from).not.toHaveBeenCalled();
  });

  it("⭐ com MFA em dívida, nenhuma escrita é feita", async () => {
    h.mfaEmDivida.mockResolvedValueOnce(true);
    const { criarPacote } = await acoesDoCatalogo();

    const r = await criarPacote({ codigo: "pacote_100k", nome: "100 mil tokens", tokens: 100000 });

    expect(r.ok).toBe(false);
    expect(h.from).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("código fora do formato (maiúscula, espaço) é recusado sem escrita", async () => {
    const { criarPacote } = await acoesDoCatalogo();

    const r = await criarPacote({ codigo: "Pacote Errado", nome: "x", tokens: 1000 });

    expect(r.ok).toBe(false);
    expect(h.from).not.toHaveBeenCalled();
  });

  it("tokens zero ou negativo é recusado sem escrita", async () => {
    const { criarPacote } = await acoesDoCatalogo();

    const r = await criarPacote({ codigo: "pacote_x", nome: "x", tokens: 0 });

    expect(r.ok).toBe(false);
    expect(h.from).not.toHaveBeenCalled();
  });

  it("código duplicado (23505) devolve a frase fixa", async () => {
    h.from.mockReturnValue(insertBuilder({ data: null, error: { code: "23505", message: "duplicate key" } }));
    const { criarPacote } = await acoesDoCatalogo();

    const r = await criarPacote({ codigo: "pacote_100k", nome: "100 mil tokens", tokens: 100000 });

    expect(r).toEqual({ ok: false, error: "Já existe um pacote com este código." });
  });

  it("sem preço (N9): grava preco_cents nulo, nunca inventa um valor", async () => {
    let payloadEnviado: Record<string, unknown> | null = null;
    h.from.mockReturnValue({
      insert: (payload: Record<string, unknown>) => {
        payloadEnviado = payload;
        return { select: () => ({ single: async () => ({ data: { id: PACOTE }, error: null }) }) };
      },
    });
    const { criarPacote } = await acoesDoCatalogo();

    const r = await criarPacote({ codigo: "pacote_100k", nome: "100 mil tokens", tokens: 100000 });

    expect(r.ok).toBe(true);
    expect(payloadEnviado).toMatchObject({ preco_cents: null });
  });

  it("sucesso audita billing.token_pack_created e revalida a tela da instalação", async () => {
    const { criarPacote } = await acoesDoCatalogo();

    const r = await criarPacote({
      codigo: "pacote_100k",
      nome: "100 mil tokens",
      tokens: 100000,
      precoCents: 9900,
    });

    expect(r).toEqual({ ok: true, pacoteId: PACOTE });
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "billing.token_pack_created",
        metadata: expect.objectContaining({ codigo: "pacote_100k", tokens: 100000, preco_cents: 9900 }),
      }),
    );
    expect(h.revalidatePath).toHaveBeenCalledWith("/admin/sistema");
  });
});

describe("desativarPacote", () => {
  beforeEach(() => {
    h.from.mockReturnValue(updateBuilder({ error: null }));
  });

  it("⭐ admin com escopo support_readonly é recusado e nenhuma escrita é feita", async () => {
    h.guard.mockResolvedValueOnce(ADMIN_SUPORTE);
    const { desativarPacote } = await acoesDoCatalogo();

    const r = await desativarPacote({ pacoteId: PACOTE });

    expect(r.ok).toBe(false);
    expect(h.from).not.toHaveBeenCalled();
  });

  it("pacoteId que não é uuid é recusado sem escrita", async () => {
    const { desativarPacote } = await acoesDoCatalogo();

    const r = await desativarPacote({ pacoteId: "não-é-um-uuid" });

    expect(r.ok).toBe(false);
    expect(h.from).not.toHaveBeenCalled();
  });

  it("sucesso audita billing.token_pack_deactivated e revalida a tela da instalação", async () => {
    const { desativarPacote } = await acoesDoCatalogo();

    const r = await desativarPacote({ pacoteId: PACOTE });

    expect(r).toEqual({ ok: true, pacoteId: PACOTE });
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "billing.token_pack_deactivated",
        metadata: { pacote_id: PACOTE },
      }),
    );
    expect(h.revalidatePath).toHaveBeenCalledWith("/admin/sistema");
  });

  it("🔒 erro qualquer do banco NÃO aparece na resposta", async () => {
    const MENSAGEM_MARCADA = 'relation "segredo_interno" does not exist';
    h.from.mockReturnValue(updateBuilder({ error: { code: "42P01", message: MENSAGEM_MARCADA } }));
    const { desativarPacote } = await acoesDoCatalogo();

    const r = await desativarPacote({ pacoteId: PACOTE });

    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(MENSAGEM_MARCADA);
  });
});
