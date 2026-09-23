/**
 * Tarefa 6 da fase F2 (hiperbold/planos/fase-F2-tarefas.md): leitura no
 * servidor de `usoDaOrganizacao` e `podeCriar`. Dublê do cliente Supabase,
 * sem banco de verdade, no estilo de `tests/unit/planos-limites.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { usoDaOrganizacao, type Uso } from "@/lib/billing/planos/uso-da-organizacao";
import { podeCriar } from "@/lib/billing/planos/pode-criar";

const ORG = "22222222-2222-4222-8222-222222222222";

const USO_PADRAO = {
  funis: 2,
  etapas_por_funil: 6,
  leads: 40,
  membros: 3,
  conexoes: 1,
  integracoes_webhook: 0,
};

const USO_ZERADO: Uso = {
  funis: 0,
  etapas_por_funil: 0,
  leads: 0,
  membros: 0,
  conexoes: 0,
  integracoes_webhook: 0,
  tokens_ia_mes: null,
};

const PODE_CRIAR_OK = { pode: true, motivo: "ok", atual: 2, teto: 5 };
const PODE_CRIAR_TETO = { pode: false, motivo: "teto_atingido", atual: 5, teto: 5 };
const PODE_CRIAR_SEM_LIMITE = { pode: true, motivo: "sem_limite", atual: null, teto: null };

const TEXTO_CRU_DO_BANCO = "coluna organization_id_fantasma não existe na tabela crm_pipelines";

interface OpcoesDoAdminFalso {
  usoData?: unknown;
  usoErro?: string;
  usoLanca?: boolean;
  podeCriarData?: unknown;
  podeCriarErro?: string;
  podeCriarLanca?: boolean;
}

function criarAdminFalso(opts: OpcoesDoAdminFalso) {
  const chamadasRpc: Array<{ nome: string; args: unknown }> = [];

  async function rpc(nome: string, args: unknown) {
    chamadasRpc.push({ nome, args });

    if (nome === "fn_billing_uso") {
      if (opts.usoLanca) throw new Error("conexão com o banco caiu");
      if (opts.usoErro) return { data: null, error: { message: opts.usoErro } };
      return { data: opts.usoData ?? USO_PADRAO, error: null };
    }

    if (nome === "fn_billing_pode_criar") {
      if (opts.podeCriarLanca) throw new Error("conexão com o banco caiu");
      if (opts.podeCriarErro) return { data: null, error: { message: opts.podeCriarErro } };
      return { data: opts.podeCriarData ?? PODE_CRIAR_OK, error: null };
    }

    throw new Error(`rpc desconhecida no dublê: ${nome}`);
  }

  const admin = { rpc } as unknown as SupabaseClient;
  return { admin, chamadasRpc };
}

function logFalso() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe("usoDaOrganizacao", () => {
  it("resposta boa: devolve as seis chaves e tokens_ia_mes null", async () => {
    const { admin, chamadasRpc } = criarAdminFalso({ usoData: USO_PADRAO });
    const log = logFalso();

    const r = await usoDaOrganizacao(admin, ORG, log);

    expect(r).toEqual({ uso: { ...USO_PADRAO, tokens_ia_mes: null }, leituraFalhou: false });
    expect(chamadasRpc).toEqual([{ nome: "fn_billing_uso", args: { p_org: ORG } }]);
    expect(log.error).not.toHaveBeenCalled();
  });

  it("a RPC devolve error: nunca lança, zera o uso e alarma", async () => {
    const { admin } = criarAdminFalso({ usoErro: TEXTO_CRU_DO_BANCO });
    const log = logFalso();

    const r = await usoDaOrganizacao(admin, ORG, log);

    expect(r).toEqual({ uso: USO_ZERADO, leituraFalhou: true });
    expect(log.error).toHaveBeenCalledWith(
      "alarme_planos_leitura",
      expect.objectContaining({ organization_id: ORG }),
    );
  });

  it("a RPC lança: nunca propaga, zera o uso e alarma", async () => {
    const { admin } = criarAdminFalso({ usoLanca: true });
    const log = logFalso();

    const r = await usoDaOrganizacao(admin, ORG, log);

    expect(r).toEqual({ uso: USO_ZERADO, leituraFalhou: true });
    expect(log.error).toHaveBeenCalledWith("alarme_planos_leitura", expect.anything());
  });

  it("resposta fora do esquema (chave faltando): erro de leitura", async () => {
    const { funis: _funis, ...semFunis } = USO_PADRAO;
    const { admin } = criarAdminFalso({ usoData: semFunis });
    const log = logFalso();

    const r = await usoDaOrganizacao(admin, ORG, log);

    expect(r).toEqual({ uso: USO_ZERADO, leituraFalhou: true });
    expect(log.error).toHaveBeenCalledWith("alarme_planos_leitura", expect.anything());
  });

  it("resposta fora do esquema (tipo errado): erro de leitura", async () => {
    const { admin } = criarAdminFalso({ usoData: { ...USO_PADRAO, leads: "quarenta" } });
    const log = logFalso();

    const r = await usoDaOrganizacao(admin, ORG, log);

    expect(r.leituraFalhou).toBe(true);
    expect(r.uso).toEqual(USO_ZERADO);
  });

  it("funciona sem `log` (parâmetro opcional)", async () => {
    const { admin } = criarAdminFalso({ usoErro: TEXTO_CRU_DO_BANCO });
    await expect(usoDaOrganizacao(admin, ORG)).resolves.toMatchObject({ leituraFalhou: true });
  });
});

describe("podeCriar", () => {
  it("resposta ok: repassa pode, motivo, atual e teto, e envia p_pipeline null por padrão", async () => {
    const { admin, chamadasRpc } = criarAdminFalso({ podeCriarData: PODE_CRIAR_OK });
    const log = logFalso();

    const r = await podeCriar(admin, ORG, "funis", undefined, log);

    expect(r).toEqual({ pode: true, motivo: "ok", atual: 2, teto: 5, leituraFalhou: false });
    expect(chamadasRpc).toEqual([
      { nome: "fn_billing_pode_criar", args: { p_org: ORG, p_item: "funis", p_pipeline: null } },
    ]);
  });

  it("repassa pipelineId quando informado", async () => {
    const { admin, chamadasRpc } = criarAdminFalso({ podeCriarData: PODE_CRIAR_OK });
    const pipelineId = "33333333-3333-4333-8333-333333333333";

    await podeCriar(admin, ORG, "etapas_por_funil", pipelineId);

    expect(chamadasRpc).toEqual([
      {
        nome: "fn_billing_pode_criar",
        args: { p_org: ORG, p_item: "etapas_por_funil", p_pipeline: pipelineId },
      },
    ]);
  });

  it("teto atingido: pode false e motivo teto_atingido", async () => {
    const { admin } = criarAdminFalso({ podeCriarData: PODE_CRIAR_TETO });

    const r = await podeCriar(admin, ORG, "funis");

    expect(r).toEqual({ pode: false, motivo: "teto_atingido", atual: 5, teto: 5, leituraFalhou: false });
  });

  it("sem limite: pode true, atual e teto null", async () => {
    const { admin } = criarAdminFalso({ podeCriarData: PODE_CRIAR_SEM_LIMITE });

    const r = await podeCriar(admin, ORG, "leads");

    expect(r).toEqual({ pode: true, motivo: "sem_limite", atual: null, teto: null, leituraFalhou: false });
  });

  it("a RPC devolve error: libera (pode true), marca leituraFalhou, alarma e não vaza o texto cru do banco na resposta", async () => {
    const { admin } = criarAdminFalso({ podeCriarErro: TEXTO_CRU_DO_BANCO });
    const log = logFalso();

    const r = await podeCriar(admin, ORG, "membros", undefined, log);

    expect(r).toEqual({
      pode: true,
      motivo: "leitura_falhou",
      atual: null,
      teto: null,
      leituraFalhou: true,
    });
    expect(JSON.stringify(r)).not.toContain(TEXTO_CRU_DO_BANCO);
    expect(log.error).toHaveBeenCalledWith(
      "alarme_planos_leitura",
      expect.objectContaining({
        organization_id: ORG,
        item: "membros",
        error: expect.stringContaining(TEXTO_CRU_DO_BANCO),
      }),
    );
  });

  it("a RPC lança: libera, marca leituraFalhou e alarma", async () => {
    const { admin } = criarAdminFalso({ podeCriarLanca: true });
    const log = logFalso();

    const r = await podeCriar(admin, ORG, "conexoes", undefined, log);

    expect(r).toEqual({
      pode: true,
      motivo: "leitura_falhou",
      atual: null,
      teto: null,
      leituraFalhou: true,
    });
    expect(log.error).toHaveBeenCalledWith("alarme_planos_leitura", expect.anything());
  });

  it("resposta fora do esquema (motivo desconhecido): erro de leitura, libera e alarma", async () => {
    const { admin } = criarAdminFalso({
      podeCriarData: { pode: true, motivo: "motivo_novo_desconhecido", atual: 1, teto: 5 },
    });
    const log = logFalso();

    const r = await podeCriar(admin, ORG, "integracoes_webhook", undefined, log);

    expect(r.leituraFalhou).toBe(true);
    expect(r.pode).toBe(true);
    expect(log.error).toHaveBeenCalledWith("alarme_planos_leitura", expect.anything());
  });

  it("funciona sem `log` (parâmetro opcional)", async () => {
    const { admin } = criarAdminFalso({ podeCriarErro: TEXTO_CRU_DO_BANCO });
    await expect(podeCriar(admin, ORG, "funis")).resolves.toMatchObject({ leituraFalhou: true });
  });
});
