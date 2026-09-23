/**
 * Tarefa 7 da fase F2-B: `livroCaixaDoCiclo`, a leitura do livro-caixa COM
 * NOTA E AUTOR para a aba do admin da plataforma (diferente de
 * `extratoDoCiclo`, tarefa 6, que é para a tela do cliente e nunca lê nota
 * nem autor). Desde a revisão de 23/09/2026 (item 1b/item 9), a leitura, o
 * filtro do ciclo, o corte de 500 linhas e o agrupamento do consumo são
 * feitos NO BANCO por `fn_billing_livro_caixa_do_ciclo` (RPC): o dublê é um
 * `admin.rpc` falso, no molde de `tests/unit/tokens-saldo-da-
 * organizacao.test.ts`, com `auth.admin.getUserById` para os autores.
 */
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { livroCaixaDoCiclo } from "@/lib/billing/tokens/livro-caixa-do-ciclo";

const ORG = "22222222-2222-4222-8222-222222222222";
const CICLO = "2026-09-01";
const ADMIN_A = "33333333-3333-4333-8333-333333333333";
const ADMIN_B = "44444444-4444-4444-8444-444444444444";
const LINHA_PLANO = "55555555-5555-4555-8555-555555555555";
const LINHA_ADICIONAL = "66666666-6666-4666-8666-666666666666";
const LINHA_CREDITO = "77777777-7777-4777-8777-777777777777";
const LINHA_AJUSTE = "88888888-8888-4888-8888-888888888888";

interface OpcoesDoAdminFalso {
  data?: unknown;
  erro?: string;
  lanca?: boolean;
  usuarios?: Record<string, { email: string | null; full_name?: string | null }>;
}

const LIVRO_CAIXA_VAZIO = { linhas: [], consumo_por_dia_fonte: [], truncado: false };

function criarAdminFalso(opts: OpcoesDoAdminFalso) {
  const chamadasRpc: Array<{ nome: string; args: unknown }> = [];

  async function rpc(nome: string, args: unknown) {
    chamadasRpc.push({ nome, args });
    if (opts.lanca) throw new Error("conexão com o banco caiu");
    if (opts.erro) return { data: null, error: { message: opts.erro } };
    return { data: opts.data ?? LIVRO_CAIXA_VAZIO, error: null };
  }

  const admin = {
    rpc,
    auth: {
      admin: {
        getUserById: vi.fn(async (id: string) => {
          const usuario = opts.usuarios?.[id];
          if (!usuario) return { data: { user: null }, error: { message: "not found", status: 404 } };
          return {
            data: { user: { id, email: usuario.email, user_metadata: { full_name: usuario.full_name ?? null } } },
            error: null,
          };
        }),
      },
    },
  } as unknown as SupabaseClient;

  return { admin, chamadasRpc };
}

function logFalso() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe("livroCaixaDoCiclo", () => {
  it("classifica os quatro tipos que a RPC resolve: concessão (plano/adicional), crédito, consumo e ajuste", async () => {
    const { admin } = criarAdminFalso({
      data: {
        linhas: [
          { id: LINHA_PLANO, created_at: "2026-09-02T13:00:00Z", fonte: "plano", tipo: "concessao", tokens: 3000000, valor_cents: null, nota: null, criado_por: null, compensa_id: null },
          { id: LINHA_ADICIONAL, created_at: "2026-09-02T13:00:00Z", fonte: "adicional", tipo: "concessao", tokens: 100000, valor_cents: null, nota: null, criado_por: null, compensa_id: null },
          { id: LINHA_CREDITO, created_at: "2026-09-03T13:00:00Z", fonte: "avulso", tipo: "credito", tokens: 50000, valor_cents: 5000, nota: "pacote extra combinado", criado_por: ADMIN_A, compensa_id: null },
          { id: LINHA_AJUSTE, created_at: "2026-09-04T13:00:00Z", fonte: "plano", tipo: "ajuste", tokens: -2000, valor_cents: null, nota: "estorno de débito errado", criado_por: ADMIN_B, compensa_id: null },
        ],
        consumo_por_dia_fonte: [{ dia: "2026-09-03", fonte: "plano", tokens: -1000, chamadas: 1 }],
        truncado: false,
      },
      usuarios: {
        [ADMIN_A]: { email: "a@hiperbold.com.br", full_name: "Admin A" },
        [ADMIN_B]: { email: "b@hiperbold.com.br" },
      },
    });

    const r = await livroCaixaDoCiclo(admin, ORG, CICLO);

    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    const tipos = r.livroCaixa.linhas.map((l) => l.tipo).sort();
    expect(tipos).toEqual(["ajuste", "concessao", "concessao", "consumo", "credito"]);
  });

  it("consumo vem agrupado por dia e fonte, com `id` nulo; concessão, crédito e ajuste trazem o `id` da RPC", async () => {
    const { admin } = criarAdminFalso({
      data: {
        linhas: [
          { id: LINHA_PLANO, created_at: "2026-09-02T13:00:00Z", fonte: "plano", tipo: "concessao", tokens: 3000000, valor_cents: null, nota: null, criado_por: null, compensa_id: null },
        ],
        consumo_por_dia_fonte: [
          { dia: "2026-09-03", fonte: "plano", tokens: -1500, chamadas: 2 },
          { dia: "2026-09-03", fonte: "adicional", tokens: -200, chamadas: 1 },
        ],
        truncado: false,
      },
    });

    const r = await livroCaixaDoCiclo(admin, ORG, CICLO);

    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    const consumoPlano = r.livroCaixa.linhas.find((l) => l.tipo === "consumo" && l.fonte === "plano");
    const consumoAdicional = r.livroCaixa.linhas.find((l) => l.tipo === "consumo" && l.fonte === "adicional");
    const concessao = r.livroCaixa.linhas.find((l) => l.tipo === "concessao");
    expect(consumoPlano).toEqual(
      expect.objectContaining({ id: null, dia: "2026-09-03", tokens: -1500, linhas: 2, nota: null }),
    );
    expect(consumoAdicional).toEqual(
      expect.objectContaining({ id: null, dia: "2026-09-03", tokens: -200, linhas: 1, nota: null }),
    );
    expect(concessao?.id).toBe(LINHA_PLANO);
  });

  it("resolve o autor (nome e e-mail) de crédito e ajuste; concessão e consumo nunca têm autor", async () => {
    const { admin } = criarAdminFalso({
      data: {
        linhas: [
          { id: LINHA_CREDITO, created_at: "2026-09-03T13:00:00Z", fonte: "avulso", tipo: "credito", tokens: 50000, valor_cents: 5000, nota: "pacote", criado_por: ADMIN_A, compensa_id: null },
          { id: LINHA_PLANO, created_at: "2026-09-02T13:00:00Z", fonte: "plano", tipo: "concessao", tokens: 3000000, valor_cents: null, nota: null, criado_por: null, compensa_id: null },
        ],
        consumo_por_dia_fonte: [],
        truncado: false,
      },
      usuarios: { [ADMIN_A]: { email: "a@hiperbold.com.br", full_name: "Admin A" } },
    });

    const r = await livroCaixaDoCiclo(admin, ORG, CICLO);

    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    const credito = r.livroCaixa.linhas.find((l) => l.tipo === "credito");
    const concessao = r.livroCaixa.linhas.find((l) => l.tipo === "concessao");
    expect(credito).toEqual(
      expect.objectContaining({ autorId: ADMIN_A, autorNome: "Admin A", autorEmail: "a@hiperbold.com.br", nota: "pacote", valorCents: 5000 }),
    );
    expect(concessao).toEqual(expect.objectContaining({ autorId: null, autorNome: null, autorEmail: null, nota: null }));
  });

  it("autor que o Auth não resolve (404): a linha continua, sem nome nem e-mail, e a leitura não falha", async () => {
    const { admin } = criarAdminFalso({
      data: {
        linhas: [
          { id: LINHA_CREDITO, created_at: "2026-09-03T13:00:00Z", fonte: "avulso", tipo: "credito", tokens: 50000, valor_cents: 5000, nota: "pacote", criado_por: ADMIN_A, compensa_id: null },
        ],
        consumo_por_dia_fonte: [],
        truncado: false,
      },
      usuarios: {},
    });

    const r = await livroCaixaDoCiclo(admin, ORG, CICLO);

    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.livroCaixa.linhas[0]).toEqual(
      expect.objectContaining({ autorId: ADMIN_A, autorNome: null, autorEmail: null }),
    );
  });

  it("`truncado` é repassado direto da RPC", async () => {
    const { admin } = criarAdminFalso({ data: { linhas: [], consumo_por_dia_fonte: [], truncado: true } });

    const r = await livroCaixaDoCiclo(admin, ORG, CICLO);

    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(r.livroCaixa.truncado).toBe(true);
  });

  it("chama a RPC com a organização e o ciclo certos", async () => {
    const { admin, chamadasRpc } = criarAdminFalso({ data: LIVRO_CAIXA_VAZIO });

    await livroCaixaDoCiclo(admin, ORG, CICLO);

    expect(chamadasRpc).toEqual([
      { nome: "fn_billing_livro_caixa_do_ciclo", args: { p_org: ORG, p_ciclo: CICLO } },
    ]);
  });

  it("a RPC devolve error: nunca lança, vira leitura_falhou e alarma", async () => {
    const { admin } = criarAdminFalso({ erro: "permission denied for function fn_billing_livro_caixa_do_ciclo" });
    const log = logFalso();

    const r = await livroCaixaDoCiclo(admin, ORG, CICLO, log);

    expect(r).toEqual({ status: "leitura_falhou" });
    expect(log.error).toHaveBeenCalledWith("alarme_planos_leitura", expect.objectContaining({ organization_id: ORG }));
  });

  it("a RPC lança: nunca propaga, vira leitura_falhou", async () => {
    const { admin } = criarAdminFalso({ lanca: true });

    const r = await livroCaixaDoCiclo(admin, ORG, CICLO);

    expect(r).toEqual({ status: "leitura_falhou" });
  });

  it("jsonb fora do esquema (tokens não numérico): leitura_falhou", async () => {
    const { admin } = criarAdminFalso({
      data: {
        linhas: [{ id: LINHA_PLANO, created_at: "2026-09-02T13:00:00Z", fonte: "plano", tipo: "concessao", tokens: "muitos", valor_cents: null, nota: null, criado_por: null, compensa_id: null }],
        consumo_por_dia_fonte: [],
        truncado: false,
      },
    });

    const r = await livroCaixaDoCiclo(admin, ORG, CICLO);

    expect(r).toEqual({ status: "leitura_falhou" });
  });

  it("sem nenhuma linha no ciclo: devolve o livro-caixa vazio", async () => {
    const { admin } = criarAdminFalso({ data: LIVRO_CAIXA_VAZIO });

    const r = await livroCaixaDoCiclo(admin, ORG, CICLO);

    expect(r).toEqual({ status: "ok", livroCaixa: { ciclo: CICLO, linhas: [], truncado: false } });
  });
});
