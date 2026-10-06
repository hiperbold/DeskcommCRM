import { describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/types";
import { CHANNEL_CAPABILITIES } from "@/lib/channels/capabilities";
import type { ResultadoDaReserva } from "@/lib/agent-engine/pacing/ledger-supabase";

import {
  concluirEnvioPorToken,
  ESPERA_MAXIMA_MS,
  reservarEnvioPorToken,
  type DepsDoRitmo,
} from "./ritmo-do-envio-por-token";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONVERSA = "22222222-2222-4222-8222-222222222222";
const SESSAO = "33333333-3333-4333-8333-333333333333";
const VAGA = "44444444-4444-4444-8444-444444444444";
// Pergunta a CAPACIDADE, não o nome: um canal com e um sem risco de ban.
function providerCom(risco: boolean): string {
  return Object.entries(CHANNEL_CAPABILITIES).find(([, c]) => c.banRisk === risco)![0];
}
const COM_RISCO = providerCom(true);
const SEM_RISCO = providerCom(false);
const AGORA = new Date("2026-09-22T15:00:00.000Z");

function deps(
  canal: { channelSessionId: string; provider: string | null } | null,
  reserva: ResultadoDaReserva | Error,
): DepsDoRitmo & { reserva: ReturnType<typeof vi.fn>; libera: ReturnType<typeof vi.fn>; sleep: ReturnType<typeof vi.fn> } {
  const r = vi.fn(async () => {
    if (reserva instanceof Error) throw reserva;
    return reserva;
  });
  const libera = vi.fn(async () => {});
  const sleep = vi.fn(async () => {});
  return {
    lerCanalDaConversa: vi.fn(async () => canal),
    lerCanalDaSessao: vi.fn(async () => canal),
    pacing: { reserva: r, libera },
    sleep,
    agora: () => AGORA,
    reserva: r,
    libera,
  };
}

const LIBERADO: ResultadoDaReserva = { liberado: true, vagaId: VAGA, liberaEm: AGORA };
const entrada = { organizationId: ORG, conversationId: CONVERSA, requestId: "req-1" };

describe("reservarEnvioPorToken", () => {
  it("reserva a vaga na hora quando o número está folgado e devolve a vaga", async () => {
    const d = deps({ channelSessionId: SESSAO, provider: COM_RISCO }, LIBERADO);
    await expect(reservarEnvioPorToken(d, entrada)).resolves.toEqual({ channelSessionId: SESSAO, vagaId: VAGA });
    expect(d.reserva).toHaveBeenCalledWith(ORG, SESSAO, AGORA, ESPERA_MAXIMA_MS);
    expect(d.sleep).not.toHaveBeenCalled();
  });

  it("aceita channelSessionId direto antes de a conversa existir", async () => {
    const d = deps({ channelSessionId: SESSAO, provider: COM_RISCO }, LIBERADO);
    await expect(
      reservarEnvioPorToken(d, { organizationId: ORG, channelSessionId: SESSAO, requestId: "req-1" }),
    ).resolves.toEqual({ channelSessionId: SESSAO, vagaId: VAGA });
    expect(d.lerCanalDaSessao).toHaveBeenCalledWith(ORG, SESSAO);
    expect(d.lerCanalDaConversa).not.toHaveBeenCalled();
  });

  it("espera até o instante da vaga reservada (espaçamento curto) em vez de recusar", async () => {
    const liberaEm = new Date(AGORA.getTime() + 1_500);
    const d = deps({ channelSessionId: SESSAO, provider: COM_RISCO }, { liberado: true, vagaId: VAGA, liberaEm });
    await expect(reservarEnvioPorToken(d, entrada)).resolves.toEqual({ channelSessionId: SESSAO, vagaId: VAGA });
    expect(d.sleep).toHaveBeenCalledWith(1_500);
  });

  it("recusa com 429 quando o banco não reservou por espaçamento longo", async () => {
    const liberaEm = new Date(AGORA.getTime() + ESPERA_MAXIMA_MS + 1);
    const d = deps({ channelSessionId: SESSAO, provider: COM_RISCO }, { liberado: false, motivo: "espacamento", liberaEm });
    const erro = await reservarEnvioPorToken(d, entrada).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(ApiError);
    expect((erro as ApiError).status).toBe(429);
    expect(d.sleep).not.toHaveBeenCalled();
    // O MCP só repassa a mensagem: os segundos têm de estar no texto.
    expect((erro as ApiError).message).toContain(`${Math.ceil((ESPERA_MAXIMA_MS + 1) / 1000)}s`);
  });

  it("recusa com 429 e diz quando volta quando o teto diário do número estourou", async () => {
    const liberaEm = new Date("2026-09-23T03:00:00.000Z");
    const d = deps({ channelSessionId: SESSAO, provider: COM_RISCO }, { liberado: false, motivo: "teto_diario", liberaEm });
    const erro = (await reservarEnvioPorToken(d, entrada).catch((e: unknown) => e)) as ApiError;
    expect(erro).toBeInstanceOf(ApiError);
    expect(erro.status).toBe(429);
    expect(erro.code).toBe("rate_limited");
    expect(erro.details).toMatchObject({
      motivo: "teto_diario",
      libera_em: liberaEm.toISOString(),
      retry_after_seconds: 43_200,
    });
    expect(erro.message).toContain(liberaEm.toISOString());
    expect(erro.message).toContain("43200s");
  });

  it("falha ao reservar (banco, trava) é recusa 503, nunca envio sem freio", async () => {
    const d = deps({ channelSessionId: SESSAO, provider: COM_RISCO }, new Error("lock_timeout"));
    await expect(reservarEnvioPorToken(d, entrada)).rejects.toMatchObject({ status: 503 });
  });

  it("não freia canal sem risco de banimento", async () => {
    const d = deps({ channelSessionId: SESSAO, provider: SEM_RISCO }, { liberado: false, motivo: "teto_diario", liberaEm: AGORA });
    await expect(reservarEnvioPorToken(d, entrada)).resolves.toBeNull();
    expect(d.reserva).not.toHaveBeenCalled();
  });

  it("trata provider ausente ou desconhecido como canal com risco (falha fechada)", async () => {
    for (const provider of [null, "provider-que-nao-existe"]) {
      const d = deps({ channelSessionId: SESSAO, provider }, { liberado: false, motivo: "teto_diario", liberaEm: AGORA });
      const erro = await reservarEnvioPorToken(d, entrada).catch((e: unknown) => e);
      expect(erro).toBeInstanceOf(ApiError);
    }
  });

  it("deixa o handler decidir quando a conversa não é desta organização", async () => {
    const d = deps(null, LIBERADO);
    await expect(reservarEnvioPorToken(d, entrada)).resolves.toBeNull();
    expect(d.reserva).not.toHaveBeenCalled();
  });
});

describe("concluirEnvioPorToken", () => {
  const segurado = { channelSessionId: SESSAO, vagaId: VAGA };

  it("envio que saiu mantém a vaga (já está no ledger): nada a fazer", async () => {
    const d = deps(null, LIBERADO);
    await concluirEnvioPorToken(d, ORG, segurado, "sent");
    expect(d.libera).not.toHaveBeenCalled();
  });

  it("envio que falhou devolve a vaga reservada", async () => {
    const d = deps(null, LIBERADO);
    await concluirEnvioPorToken(d, ORG, segurado, "failed");
    expect(d.libera).toHaveBeenCalledWith(ORG, SESSAO, VAGA);
  });

  it("envio que não passou pelo freio não devolve nada, e erro ao devolver nunca lança", async () => {
    const d = deps(null, LIBERADO);
    await concluirEnvioPorToken(d, ORG, null, "failed");
    expect(d.libera).not.toHaveBeenCalled();
    d.libera.mockRejectedValueOnce(new Error("rede"));
    await expect(concluirEnvioPorToken(d, ORG, segurado, "failed")).resolves.toBeUndefined();
  });
});
