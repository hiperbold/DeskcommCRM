/**
 * A sugestão de funil do onboarding é guardada, não regerada a cada render (D-118).
 *
 * `dadosDoPasso` roda no render da página: recarregar N vezes chamava o modelo N
 * vezes (até 900 tokens cada), na chave da instalação, sem telemetria. A sugestão
 * que a IA devolveu fica no estado do onboarding, presa à chave do que a gerou
 * (negócio, o que faz e o modelo): mudou qualquer um, é outra pergunta e gera de
 * novo.
 *
 * Quando a IA FALHOU e o quadro veio de um pacote pronto, a falha também fica
 * guardada, mas só por um tempo: uma instabilidade passageira merece outra
 * tentativa, não uma por recarga.
 */
import { createHash } from "node:crypto";

import { PACOTES } from "@/lib/onboarding/pacotes-de-funil";
import { normalizarProposta, validarProposta } from "@/lib/onboarding/proposta-de-funil";
import type { ContextoDoNegocio, Sugestao } from "@/lib/onboarding/sugerir-funil";
import type { OnboardingState } from "@/lib/schemas/onboarding";

/** Depois disto uma sugestão que caiu no pacote por falha da IA pode ser tentada de novo. */
export const REPETIR_FALHA_APOS_MS = 15 * 60_000;

export type SugestaoGuardada = NonNullable<OnboardingState["funil_sugestao"]>;

export function chaveDaSugestao(ctx: ContextoDoNegocio, provider: string, model: string): string {
  return createHash("sha256")
    .update(JSON.stringify([ctx.nome.trim(), ctx.oQueFaz.trim(), provider, model]))
    .digest("hex")
    .slice(0, 24);
}

/** A sugestão guardada que ainda vale para esta chave, ou null (gerar de novo). */
export function sugestaoDoCache(
  guardada: SugestaoGuardada | undefined,
  chave: string,
  agora: Date = new Date(),
): Sugestao | null {
  if (!guardada || guardada.chave !== chave) return null;

  if (guardada.origem === "ia") {
    const proposta = normalizarProposta((guardada.proposta ?? {}) as { nome?: unknown; etapas?: unknown });
    // O que veio do estado é entrada como qualquer outra: só serve se ainda valida.
    return validarProposta(proposta).ok ? { origem: "ia", proposta } : null;
  }

  const idade = agora.getTime() - Date.parse(guardada.gerada_em);
  if (!Number.isFinite(idade) || idade >= REPETIR_FALHA_APOS_MS) return null;
  const pacote = PACOTES.find((p) => p.id === guardada.pacote_id);
  if (!pacote) return null;
  return { origem: "pacote", pacote, porque: guardada.porque ?? "" };
}

export function sugestaoParaGuardar(sugestao: Sugestao, chave: string, agora: Date = new Date()): SugestaoGuardada {
  const gerada_em = agora.toISOString();
  if (sugestao.origem === "ia") return { chave, gerada_em, origem: "ia", proposta: sugestao.proposta };
  return { chave, gerada_em, origem: "pacote", pacote_id: sugestao.pacote.id, porque: sugestao.porque };
}
