/**
 * Tarefa 3 da fase F1 (hiperbold/planos/fase-F1-tarefas.md): o módulo de
 * leitura de plano. Dois eixos:
 *
 * 1. Os esquemas zod de `limites.ts` aceitam o que `fn_billing_limites_validos`
 *    aceita e recusam o que ela recusa (mesmo conjunto fechado de chaves,
 *    mesmo teto de 2147483647).
 * 2. `planoDaOrganizacao` degrada nos três casos documentados no comentário
 *    do arquivo, sem nunca lançar, com um dublê do cliente Supabase (sem
 *    banco de verdade, isso é responsabilidade de `tests/invariants/`).
 */
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  esquemaDoAjusteDeLimites,
  esquemaDoPlanoDeLimites,
  TETO_DE_LIMITE,
} from "@/lib/billing/planos/limites";
import { planoDaOrganizacao } from "@/lib/billing/planos/plano-da-organizacao";

const ORG = "11111111-1111-4111-8111-111111111111";

const LIMITES_PRO = {
  funis: 5,
  etapas_por_funil: 10,
  leads: 5000,
  membros: 3,
  conexoes: 3,
  integracoes_webhook: 3,
  tokens_ia_mes: 1_000_000,
};

const LIMITES_ILIMITADO = {
  funis: null,
  etapas_por_funil: null,
  leads: null,
  membros: null,
  conexoes: null,
  integracoes_webhook: null,
  tokens_ia_mes: null,
};

describe("esquemaDoPlanoDeLimites", () => {
  it("aceita o objeto de plano completo, com valores e com null", () => {
    expect(esquemaDoPlanoDeLimites.safeParse(LIMITES_PRO).success).toBe(true);
    expect(esquemaDoPlanoDeLimites.safeParse(LIMITES_ILIMITADO).success).toBe(true);
  });

  it("recusa chave desconhecida (conjunto fechado)", () => {
    const r = esquemaDoPlanoDeLimites.safeParse({ ...LIMITES_PRO, chave_estranha: 1 });
    expect(r.success).toBe(false);
  });

  it("recusa chave faltando no modo completo", () => {
    const { funis: _funis, ...semFunis } = LIMITES_PRO;
    const r = esquemaDoPlanoDeLimites.safeParse(semFunis);
    expect(r.success).toBe(false);
  });

  it("recusa número negativo", () => {
    const r = esquemaDoPlanoDeLimites.safeParse({ ...LIMITES_PRO, funis: -1 });
    expect(r.success).toBe(false);
  });

  it("recusa número quebrado (não inteiro)", () => {
    const r = esquemaDoPlanoDeLimites.safeParse({ ...LIMITES_PRO, funis: 1.5 });
    expect(r.success).toBe(false);
  });

  it("recusa número acima do teto", () => {
    const r = esquemaDoPlanoDeLimites.safeParse({ ...LIMITES_PRO, funis: TETO_DE_LIMITE + 1 });
    expect(r.success).toBe(false);
  });

  it("aceita o teto exato", () => {
    const r = esquemaDoPlanoDeLimites.safeParse({ ...LIMITES_PRO, funis: TETO_DE_LIMITE });
    expect(r.success).toBe(true);
  });

  it("recusa texto no lugar de número", () => {
    const r = esquemaDoPlanoDeLimites.safeParse({ ...LIMITES_PRO, funis: "5" });
    expect(r.success).toBe(false);
  });
});

describe("esquemaDoAjusteDeLimites", () => {
  it("aceita parcial (só algumas chaves)", () => {
    const r = esquemaDoAjusteDeLimites.safeParse({ funis: 8 });
    expect(r.success).toBe(true);
  });

  it("aceita vazio", () => {
    const r = esquemaDoAjusteDeLimites.safeParse({});
    expect(r.success).toBe(true);
  });

  it("aceita null numa chave presente (libera o limite)", () => {
    const r = esquemaDoAjusteDeLimites.safeParse({ funis: null });
    expect(r.success).toBe(true);
  });

  it("recusa chave desconhecida mesmo em modo parcial", () => {
    const r = esquemaDoAjusteDeLimites.safeParse({ chave_estranha: 1 });
    expect(r.success).toBe(false);
  });

  it("recusa número acima do teto", () => {
    const r = esquemaDoAjusteDeLimites.safeParse({ funis: TETO_DE_LIMITE + 1 });
    expect(r.success).toBe(false);
  });
});

/**
 * Dublê do cliente de serviço: só o que `planoDaOrganizacao` chama
 * (`from("billing_contracts").select(...).eq(...).maybeSingle()` e
 * `rpc("fn_billing_limites_efetivos", ...)`), no estilo de
 * `tests/unit/budget-status-medicao.test.ts` (`fazerAdmin`/`instalar`).
 */
interface OpcoesDoAdminFalso {
  linhaContrato?: { status: string; cycle: string | null; billing_plans: { code: string; name: string; version: number } | null } | null;
  erroContrato?: string;
  lancarNoContrato?: boolean;
  limites?: unknown;
  erroLimites?: string;
}

function criarAdminFalso(opts: OpcoesDoAdminFalso) {
  const chamadasRpc: Array<{ nome: string; args: unknown }> = [];

  function from(tabela: string) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: async () => {
        if (opts.lancarNoContrato) throw new Error("conexão com o banco caiu");
        if (opts.erroContrato) return { data: null, error: { message: opts.erroContrato } };
        expect(tabela).toBe("billing_contracts");
        return { data: opts.linhaContrato ?? null, error: null };
      },
    };
    return chain;
  }

  async function rpc(nome: string, args: unknown) {
    chamadasRpc.push({ nome, args });
    if (opts.erroLimites) return { data: null, error: { message: opts.erroLimites } };
    return { data: opts.limites ?? LIMITES_ILIMITADO, error: null };
  }

  const admin = { from, rpc } as unknown as SupabaseClient;
  return { admin, chamadasRpc };
}

function logFalso() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe("planoDaOrganizacao", () => {
  it("caso 1: contrato existe, devolve plano, contrato e limites efetivos", async () => {
    const { admin, chamadasRpc } = criarAdminFalso({
      linhaContrato: { status: "ativa", cycle: "monthly", billing_plans: { code: "pro", name: "Pro", version: 1 } },
      limites: LIMITES_PRO,
    });
    const log = logFalso();

    const r = await planoDaOrganizacao(admin, ORG, log);

    expect(r).toEqual({
      plano: { code: "pro", name: "Pro", version: 1 },
      contrato: { status: "ativa", cycle: "monthly" },
      limites: LIMITES_PRO,
      leituraFalhou: false,
    });
    expect(chamadasRpc).toEqual([{ nome: "fn_billing_limites_efetivos", args: { p_org: ORG } }]);
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it("caso 2: sem contrato, devolve o plano Ilimitado, contrato null e avisa", async () => {
    const { admin } = criarAdminFalso({ linhaContrato: null, limites: LIMITES_ILIMITADO });
    const log = logFalso();

    const r = await planoDaOrganizacao(admin, ORG, log);

    expect(r).toEqual({
      plano: { code: "ilimitado", name: "Ilimitado", version: 1 },
      contrato: null,
      limites: LIMITES_ILIMITADO,
      leituraFalhou: false,
    });
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.error).not.toHaveBeenCalled();
  });

  it("caso 3a: a consulta do contrato devolve error, nunca lança e alarma", async () => {
    const { admin } = criarAdminFalso({ erroContrato: "PostgREST fora do ar" });
    const log = logFalso();

    const r = await planoDaOrganizacao(admin, ORG, log);

    expect(r.leituraFalhou).toBe(true);
    expect(r.contrato).toBeNull();
    expect(r.limites).toEqual(LIMITES_ILIMITADO);
    expect(log.error).toHaveBeenCalledWith(
      "alarme_planos_leitura",
      expect.objectContaining({ organization_id: ORG }),
    );
  });

  it("caso 3b: o rpc de limites efetivos devolve error, nunca lança e alarma", async () => {
    const { admin } = criarAdminFalso({
      linhaContrato: { status: "ativa", cycle: "monthly", billing_plans: { code: "pro", name: "Pro", version: 1 } },
      erroLimites: "function fn_billing_limites_efetivos does not exist",
    });
    const log = logFalso();

    const r = await planoDaOrganizacao(admin, ORG, log);

    expect(r.leituraFalhou).toBe(true);
    expect(r.limites).toEqual(LIMITES_ILIMITADO);
    expect(log.error).toHaveBeenCalledWith("alarme_planos_leitura", expect.anything());
  });

  it("caso 3c: os limites que voltaram do banco não passam no esquema", async () => {
    const { admin } = criarAdminFalso({
      linhaContrato: { status: "ativa", cycle: "monthly", billing_plans: { code: "pro", name: "Pro", version: 1 } },
      limites: { ...LIMITES_PRO, funis: "cinco" },
    });
    const log = logFalso();

    const r = await planoDaOrganizacao(admin, ORG, log);

    expect(r.leituraFalhou).toBe(true);
    expect(r.limites).toEqual(LIMITES_ILIMITADO);
    expect(log.error).toHaveBeenCalledWith("alarme_planos_leitura", expect.anything());
  });

  it("caso 3d: a consulta lança (ex.: rede caiu no meio do await)", async () => {
    const { admin } = criarAdminFalso({ lancarNoContrato: true });
    const log = logFalso();

    const r = await planoDaOrganizacao(admin, ORG, log);

    expect(r.leituraFalhou).toBe(true);
    expect(r.plano).toEqual({ code: "ilimitado", name: "Ilimitado", version: 1 });
    expect(log.error).toHaveBeenCalledWith("alarme_planos_leitura", expect.anything());
  });

  it("funciona sem `log` (parâmetro opcional): não lança quando não há dublê de logger", async () => {
    const { admin } = criarAdminFalso({ erroContrato: "PostgREST fora do ar" });
    await expect(planoDaOrganizacao(admin, ORG)).resolves.toMatchObject({ leituraFalhou: true });
  });
});
