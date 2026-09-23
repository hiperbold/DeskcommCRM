import { describe, expect, it, vi } from "vitest";

import {
  conferirCarteiraDeTokens,
  type ConferidorDeCarteiraDb,
} from "@/lib/billing/tokens/conferir-carteira";

vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

/**
 * Tarefa 8 da fase F2-B (hiperbold/planos/fase-F2-B-tarefas.md): o
 * conferidor diário da carteira de tokens de IA. Dublê de
 * `ConferidorDeCarteiraDb` EM MEMÓRIA, mesmo desenho de
 * `tests/unit/planos-conferir-contadores.test.ts`: `de`/`ate` de
 * `listarOrganizacoes` são índices INCLUSIVOS (mesma semântica de
 * `SupabaseClient.range`). O tamanho de página (500) não é injetável.
 *
 * `pendentesPorOrg` guarda os ids AINDA pendentes de cada organização, como
 * o próprio anti-join da RPC real faria: `debitarChamada` remove o id da
 * lista (simula a linha de consumo passando a existir) e `debitosPendentes`
 * só devolve o que sobrou, fatiado por `p_limite`.
 */
function bancoDeCarteira(
  ids: string[],
  opts: {
    pendentesPorOrg?: Record<string, string[]>;
    orgsQueFalhamDebitosPendentes?: Set<string>;
    orgsQueFalhamDebitarChamada?: Set<string>;
    orgsQueFalhamConferirCarteira?: Set<string>;
    divergemPorOrg?: Record<string, number>;
    erroNaPaginaDeOrgs?: number;
    teto?: number | null;
    erroTeto?: string;
    consumoDoDia?: number;
    erroConsumo?: string;
  } = {},
): {
  db: ConferidorDeCarteiraDb;
  chamadasDebitosPendentes: string[];
  chamadasDebitarChamada: string[];
  chamadasConferirCarteira: string[];
  diasConsultados: string[];
} {
  const pendentesPorOrg: Record<string, string[]> = {};
  for (const [org, pendentes] of Object.entries(opts.pendentesPorOrg ?? {})) {
    pendentesPorOrg[org] = [...pendentes];
  }
  const orgsQueFalhamDebitosPendentes = opts.orgsQueFalhamDebitosPendentes ?? new Set<string>();
  const orgsQueFalhamDebitarChamada = opts.orgsQueFalhamDebitarChamada ?? new Set<string>();
  const orgsQueFalhamConferirCarteira = opts.orgsQueFalhamConferirCarteira ?? new Set<string>();
  const divergemPorOrg = opts.divergemPorOrg ?? {};

  const chamadasDebitosPendentes: string[] = [];
  const chamadasDebitarChamada: string[] = [];
  const chamadasConferirCarteira: string[] = [];
  const diasConsultados: string[] = [];

  const db: ConferidorDeCarteiraDb = {
    async listarOrganizacoes(de, ate) {
      const pagina = Math.floor(de / 500);
      if (opts.erroNaPaginaDeOrgs !== undefined && pagina === opts.erroNaPaginaDeOrgs) {
        return { data: null, error: { message: "permission denied for table organizations" } };
      }
      const fatia = ids.slice(de, ate + 1).map((id) => ({ id }));
      return { data: fatia, error: null };
    },
    async debitosPendentes(pOrg, pLimite) {
      chamadasDebitosPendentes.push(pOrg);
      if (orgsQueFalhamDebitosPendentes.has(pOrg)) {
        return { data: null, error: { message: `débitos pendentes falhou para ${pOrg}` } };
      }
      const pendentes = pendentesPorOrg[pOrg] ?? [];
      return { data: pendentes.slice(0, pLimite), error: null };
    },
    async debitarChamada(pLlmCallId) {
      chamadasDebitarChamada.push(pLlmCallId);
      // Descobre a organização dona do id pela lista de pendentes (o dublê
      // não precisa de um índice à parte: os ids são únicos no teste).
      const org = Object.keys(pendentesPorOrg).find((o) => pendentesPorOrg[o]?.includes(pLlmCallId));
      if (org && orgsQueFalhamDebitarChamada.has(org)) {
        return { data: null, error: { message: `debitar chamada ${pLlmCallId} falhou` } };
      }
      if (org) {
        pendentesPorOrg[org] = (pendentesPorOrg[org] ?? []).filter((id) => id !== pLlmCallId);
      }
      return { data: true, error: null };
    },
    async conferirCarteira(pOrg) {
      chamadasConferirCarteira.push(pOrg);
      if (orgsQueFalhamConferirCarteira.has(pOrg)) {
        return { data: null, error: { message: `conferir carteira falhou para ${pOrg}` } };
      }
      return { data: divergemPorOrg[pOrg] ?? 0, error: null };
    },
    async tetoDaInstalacao() {
      if (opts.erroTeto) return { data: null, error: { message: opts.erroTeto } };
      return { data: opts.teto ?? null, error: null };
    },
    async consumoDaInstalacaoNoDia(dia) {
      diasConsultados.push(dia);
      if (opts.erroConsumo) return { data: null, error: { message: opts.erroConsumo } };
      return { data: opts.consumoDoDia ?? 0, error: null };
    },
  };

  return { db, chamadasDebitosPendentes, chamadasDebitarChamada, chamadasConferirCarteira, diasConsultados };
}

describe("conferirCarteiraDeTokens, o conferidor diário da carteira de tokens", () => {
  it("percorre mais de uma página de organizações (500 + N) e vê todas", async () => {
    const ids = Array.from({ length: 507 }, (_, i) => `org-${String(i).padStart(4, "0")}`);
    const { db } = bancoDeCarteira(ids);

    const resumo = await conferirCarteiraDeTokens(db);

    expect(resumo.organizacoesVistas).toBe(507);
    expect(resumo.organizacoesQueFalharam).toBe(0);
  });

  it("débitos pendentes em mais de uma volta: página cheia repete até esvaziar", async () => {
    const ORG = "org-a";
    // 3 ids a mais que o limite de 500 por volta: força uma 2ª chamada a
    // debitosPendentes para a mesma organização.
    const pendentes = Array.from({ length: 503 }, (_, i) => `chamada-${i}`);
    const { db, chamadasDebitosPendentes } = bancoDeCarteira([ORG], {
      pendentesPorOrg: { [ORG]: pendentes },
    });

    const resumo = await conferirCarteiraDeTokens(db);

    expect(resumo.debitosRecuperados).toBe(503);
    // 1ª volta devolve 500 (página cheia, repete), 2ª volta devolve 3 (não
    // cheia, para): duas chamadas a debitosPendentes para a mesma org.
    expect(chamadasDebitosPendentes.filter((o) => o === ORG)).toHaveLength(2);
  });

  it("limite de voltas: organização com pendência sem fim para, registra e não trava a rodada", async () => {
    const ORG = "org-defeituosa";
    const OUTRA = "org-normal";
    // Sempre 500 pendentes: nunca esvazia (o dublê não remove nada além do
    // que debitarChamada tira, mas aqui cada id é sempre novo e não existe
    // de fato na lista, simula uma organização cujo total de pendência
    // nunca cai abaixo do limite de página).
    const pendentesInfinitos = Array.from({ length: 20_000 }, (_, i) => `${ORG}-${i}`);
    const { db, chamadasDebitosPendentes } = bancoDeCarteira([ORG, OUTRA], {
      pendentesPorOrg: { [ORG]: pendentesInfinitos },
    });

    const resumo = await conferirCarteiraDeTokens(db);

    // 20 voltas × 500 = 10.000, mesmo teto documentado em conferir-carteira.ts.
    expect(chamadasDebitosPendentes.filter((o) => o === ORG)).toHaveLength(20);
    expect(resumo.debitosRecuperados).toBe(10_000);
    expect(resumo.organizacoesQueFalharam).toBe(0); // bater no teto não é falha.
    expect(resumo.organizacoesVistas).toBe(2); // a rodada seguiu para a outra organização.
  });

  it("organização que falha nos débitos pendentes não derruba a rodada, as demais seguem", async () => {
    const { db, chamadasConferirCarteira } = bancoDeCarteira(["org-a", "org-b", "org-c"], {
      orgsQueFalhamDebitosPendentes: new Set(["org-b"]),
    });

    const resumo = await conferirCarteiraDeTokens(db);

    expect(resumo.organizacoesVistas).toBe(3);
    expect(resumo.organizacoesQueFalharam).toBe(1);
    // org-b falhou ANTES de chegar em conferirCarteira: não é chamada para ela.
    expect(chamadasConferirCarteira).toEqual(["org-a", "org-c"]);
  });

  it("organização que falha ao debitar uma chamada específica não derruba a rodada", async () => {
    const ORG = "org-com-chamada-ruim";
    const { db, chamadasConferirCarteira } = bancoDeCarteira([ORG, "org-ok"], {
      pendentesPorOrg: { [ORG]: ["chamada-1"] },
      orgsQueFalhamDebitarChamada: new Set([ORG]),
    });

    const resumo = await conferirCarteiraDeTokens(db);

    expect(resumo.organizacoesQueFalharam).toBe(1);
    expect(chamadasConferirCarteira).toEqual(["org-ok"]);
  });

  it("organização que falha em conferirCarteira não derruba a rodada", async () => {
    const { db } = bancoDeCarteira(["org-a", "org-b"], {
      orgsQueFalhamConferirCarteira: new Set(["org-a"]),
      divergemPorOrg: { "org-b": 2 },
    });

    const resumo = await conferirCarteiraDeTokens(db);

    expect(resumo.organizacoesVistas).toBe(2);
    expect(resumo.organizacoesQueFalharam).toBe(1);
    expect(resumo.carteirasCorrigidas).toBe(1);
  });

  it("conta carteirasCorrigidas por ORGANIZAÇÃO (>0 linhas divergentes conta 1)", async () => {
    const { db } = bancoDeCarteira(["org-a", "org-b", "org-c"], {
      divergemPorOrg: { "org-a": 1, "org-b": 0, "org-c": 3 },
    });

    const resumo = await conferirCarteiraDeTokens(db);

    expect(resumo.carteirasCorrigidas).toBe(2);
  });

  it("erro ao LISTAR organizações lança, sem a lista não há o que conferir", async () => {
    const { db } = bancoDeCarteira(["org-a", "org-b"], { erroNaPaginaDeOrgs: 0 });

    await expect(conferirCarteiraDeTokens(db)).rejects.toThrow(
      /permission denied for table organizations/,
    );
  });

  it("teto da instalação desligado (nulo): nunca confere consumo, tetoDaInstalacaoPassou fica false", async () => {
    const { db } = bancoDeCarteira(["org-a"], { teto: null, consumoDoDia: 999_999_999 });

    const resumo = await conferirCarteiraDeTokens(db);

    expect(resumo.tetoDaInstalacaoPassou).toBe(false);
  });

  it("teto da instalação ligado e consumo ABAIXO: tetoDaInstalacaoPassou false", async () => {
    const { db } = bancoDeCarteira(["org-a"], { teto: 1_000_000, consumoDoDia: 500_000 });

    const resumo = await conferirCarteiraDeTokens(db);

    expect(resumo.tetoDaInstalacaoPassou).toBe(false);
  });

  it("teto da instalação ligado e consumo ACIMA: tetoDaInstalacaoPassou true, alarme no log", async () => {
    const { logger } = await import("@/lib/logger");
    const { db } = bancoDeCarteira(["org-a"], { teto: 1_000_000, consumoDoDia: 1_000_001 });

    const resumo = await conferirCarteiraDeTokens(db);

    expect(resumo.tetoDaInstalacaoPassou).toBe(true);
    expect(logger.error).toHaveBeenCalledWith(
      "alarme_planos_teto_instalacao",
      expect.objectContaining({ teto_instalacao_tokens_dia: 1_000_000, consumo_do_dia: 1_000_001 }),
    );
  });

  /**
   * Item 12 da revisão (23/09/2026): o scheduler roda em UTC
   * (`docker-compose.prod.yml`, `TZ: UTC`) e o cron dispara `25 5 * * *`,
   * 05:25 UTC = 02:25 em América/São_Paulo, ainda dentro do MESMO dia civil
   * paulista, só com 2h25 dele decorridas. O teto é DIÁRIO: o dia que já
   * fechou é o ANTERIOR, não "hoje". `2026-09-10T05:25:00Z` cai às 02:25 de
   * 10/09 em São Paulo; o dia anterior completo é 09/09.
   */
  it("teto da instalação: às 02h25 de SP do dia 10, confere o consumo do dia 9 (anterior), não do 10", async () => {
    const { db, diasConsultados } = bancoDeCarteira(["org-a"], { teto: 1_000_000, consumoDoDia: 500_000 });
    const agora = new Date("2026-09-10T05:25:00Z"); // UTC, 02:25 em São Paulo (UTC-3), ainda dia 10 lá.

    await conferirCarteiraDeTokens(db, agora);

    expect(diasConsultados).toEqual(["2026-09-09"]);
  });

  it("teto da instalação: perto da virada, meia-noite de SP ainda é o dia anterior de verdade", async () => {
    const { db, diasConsultados } = bancoDeCarteira(["org-a"], { teto: 1_000_000, consumoDoDia: 500_000 });
    // 03:00 UTC de 01/01 = 00:00 em São Paulo, já 01/01 lá; o dia anterior
    // completo é 31/12 do ano anterior, vira o ano também, não só o dia.
    const agora = new Date("2026-01-01T03:00:00Z");

    await conferirCarteiraDeTokens(db, agora);

    expect(diasConsultados).toEqual(["2025-12-31"]);
  });

  it("leitura do teto falha: não lança, não passa a rodada, vira alarme_planos_leitura", async () => {
    const { logger } = await import("@/lib/logger");
    const { db } = bancoDeCarteira(["org-a"], { erroTeto: "coluna sumiu" });

    const resumo = await conferirCarteiraDeTokens(db);

    expect(resumo.tetoDaInstalacaoPassou).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(
      "alarme_planos_leitura",
      expect.objectContaining({ contexto: "teto_instalacao" }),
    );
  });

  it("resumo nunca vaza texto de erro do Postgres (só o log recebe)", async () => {
    const { db } = bancoDeCarteira(["org-a"], {
      orgsQueFalhamConferirCarteira: new Set(["org-a"]),
    });

    const resumo = await conferirCarteiraDeTokens(db);

    expect(JSON.stringify(resumo)).not.toMatch(/falhou para/);
  });
});
