/**
 * D-188: o limite de Conexões do plano (todos os canais somados) e a frase de recusa. Dublê só do cliente
 * Supabase (a fronteira com o banco); a regra de bloqueio em si é provada no Postgres real por
 * `tests/invariants/limite-de-conexoes-bloqueia-sempre.test.ts`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  bloqueioDoBotaoDeConexoes,
  fraseDoLimiteDeConexoes,
  mensagemDaRecusaDoPlano,
  mensagemDoLimiteDeConexoes,
} from "@/lib/billing/planos/limite-de-conexoes";
import { recusaDoPlano } from "@/lib/billing/planos/recusa-do-plano";

const ORG = "22222222-2222-4222-8222-222222222222";

const LIMITES = (conexoes: number | null) => ({
  funis: 5,
  etapas_por_funil: 10,
  leads: 5000,
  membros: 3,
  conexoes,
  integracoes_webhook: 3,
  tokens_ia_mes: 3_000_000,
});

function adminFalso(opts: {
  pode?: boolean;
  motivo?: "ok" | "teto_atingido" | "sem_limite";
  atual?: number | null;
  teto?: number | null;
  limites?: unknown;
  planoNome?: string;
  podeCriarErro?: boolean;
  planoErro?: boolean;
}) {
  const chamadas: string[] = [];
  return {
    chamadas,
    cliente: {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () =>
              opts.planoErro
                ? { data: null, error: { message: "caiu" } }
                : {
                    data: {
                      status: "ativa",
                      cycle: "monthly",
                      billing_plans: { code: "pro", name: opts.planoNome ?? "Pro", version: 1 },
                    },
                    error: null,
                  },
          }),
        }),
      }),
      rpc: async (nome: string) => {
        chamadas.push(nome);
        if (nome === "fn_billing_pode_criar") {
          if (opts.podeCriarErro) return { data: null, error: { message: "caiu" } };
          return {
            data: {
              pode: opts.pode ?? true,
              motivo: opts.motivo ?? "ok",
              atual: opts.atual ?? 1,
              teto: opts.teto ?? 3,
            },
            error: null,
          };
        }
        if (nome === "fn_billing_limites_efetivos") return { data: opts.limites ?? LIMITES(3), error: null };
        throw new Error(`rpc inesperada: ${nome}`);
      },
    } as unknown as SupabaseClient,
  };
}

describe("fraseDoLimiteDeConexoes", () => {
  it("diz o limite e o plano", () => {
    expect(fraseDoLimiteDeConexoes(3, "Pro")).toBe(
      "Sua conta atingiu o limite de 3 conexões do plano Pro. Remova uma conexão ou mude de plano.",
    );
  });

  it("sem o limite ou sem o plano cai na frase sem número, nunca 'undefined' nem '0'", () => {
    const sem = "Sua conta atingiu o limite de conexões do plano. Remova uma conexão ou mude de plano.";
    expect(fraseDoLimiteDeConexoes(null, "Pro")).toBe(sem);
    expect(fraseDoLimiteDeConexoes(3, null)).toBe(sem);
  });

  it("traduz para espanhol com o número e o plano no lugar, e o catálogo chinês tem os marcadores", () => {
    expect(fraseDoLimiteDeConexoes(10, "Max", "es")).toBe(
      "Tu cuenta alcanzó el límite de 10 conexiones del plan Max. Elimina una conexión o cambia de plan.",
    );
    // Chinês ainda não é servido (idioma em construção), mas o catálogo já tem as frases com os mesmos marcadores.
    const zh = JSON.parse(readFileSync(join(process.cwd(), "lib/i18n/traducoes/zh-CN.json"), "utf8")) as Record<string, string>;
    const traducao = zh["Sua conta atingiu o limite de {n} conexões do plano {plano}. Remova uma conexão ou mude de plano."];
    expect(traducao).toContain("{n}");
    expect(traducao).toContain("{plano}");
  });
});

describe("bloqueioDoBotaoDeConexoes", () => {
  it("limite cheio: desabilita com a frase do plano, sem olhar o modo (nenhuma leitura de billing_settings)", async () => {
    const { cliente, chamadas } = adminFalso({ pode: false, motivo: "teto_atingido", atual: 3, teto: 3, planoNome: "Pro" });
    const r = await bloqueioDoBotaoDeConexoes(cliente, ORG);
    expect(r).toEqual({
      desabilitado: true,
      motivo: "Sua conta atingiu o limite de 3 conexões do plano Pro. Remova uma conexão ou mude de plano.",
      suspensa: false,
    });
    expect(chamadas).not.toContain("fn_billing_uso");
  });

  it("cabe mais uma: não desabilita", async () => {
    const { cliente } = adminFalso({ pode: true, motivo: "ok", atual: 2, teto: 3 });
    expect(await bloqueioDoBotaoDeConexoes(cliente, ORG)).toEqual({ desabilitado: false, motivo: null, suspensa: false });
  });

  it("plano sem limite: não desabilita", async () => {
    const { cliente } = adminFalso({ pode: true, motivo: "sem_limite", atual: null, teto: null });
    expect((await bloqueioDoBotaoDeConexoes(cliente, ORG)).desabilitado).toBe(false);
  });

  it("leitura que falha LIBERA (nunca desabilita por acidente)", async () => {
    const { cliente } = adminFalso({ podeCriarErro: true });
    expect((await bloqueioDoBotaoDeConexoes(cliente, ORG)).desabilitado).toBe(false);
  });

  it("em espanhol a frase sai traduzida", async () => {
    const { cliente } = adminFalso({ pode: false, motivo: "teto_atingido", atual: 3, teto: 3 });
    const r = await bloqueioDoBotaoDeConexoes(cliente, ORG, "es");
    expect(r.motivo).toContain("Tu cuenta alcanzó el límite de 3 conexiones del plan Pro");
  });
});

describe("mensagemDoLimiteDeConexoes e mensagemDaRecusaDoPlano", () => {
  it("lê o limite e o nome do plano reais", async () => {
    const { cliente } = adminFalso({ limites: LIMITES(10), planoNome: "Max" });
    expect(await mensagemDoLimiteDeConexoes(cliente, ORG)).toBe(
      "Sua conta atingiu o limite de 10 conexões do plano Max. Remova uma conexão ou mude de plano.",
    );
  });

  it("leitura do plano falhou: frase sem número", async () => {
    const { cliente } = adminFalso({ planoErro: true });
    expect(await mensagemDoLimiteDeConexoes(cliente, ORG)).toBe(
      "Sua conta atingiu o limite de conexões do plano. Remova uma conexão ou mude de plano.",
    );
  });

  it("PT402 de conexoes vira a frase rica; PT402 de outro item mantém a frase fixa dele", async () => {
    const { cliente } = adminFalso({ limites: LIMITES(3) });
    const deConexoes = recusaDoPlano({ code: "PT402", details: "conexoes" });
    const deFunis = recusaDoPlano({ code: "PT402", details: "funis" });
    expect(deConexoes).not.toBeNull();
    expect(deFunis).not.toBeNull();
    expect(await mensagemDaRecusaDoPlano(deConexoes!, cliente, ORG)).toContain("limite de 3 conexões do plano Pro");
    expect(await mensagemDaRecusaDoPlano(deFunis!, cliente, ORG)).toBe(deFunis!.mensagem);
  });
});
