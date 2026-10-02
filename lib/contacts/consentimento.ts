/**
 * Escrita de `contacts.consent` que nunca apaga uma recusa (D-151).
 *
 * `consent` é um mapa por finalidade (`marketing`, `transactional`, `profiling`).
 * A recusa REGISTRADA (`declined_at`) é a única marca que a guarda de automação
 * (`lib/automation/guarda-do-contato.ts`), a de prospecção
 * (`lib/prospecting/guard.ts`) e a elegibilidade de campanha leem para parar o
 * envio. Se uma escrita qualquer a faz sumir, o canal reabre sem ninguém ver:
 * por isso as duas portas de escrita (o merge do handler e a rota de
 * consentimento) passam por aqui.
 */

export const FINALIDADES_DE_CONSENTIMENTO = ["marketing", "transactional", "profiling"] as const;
export type FinalidadeDeConsentimento = (typeof FINALIDADES_DE_CONSENTIMENTO)[number];

type Mapa = Record<string, unknown>;

function comoMapa(valor: unknown): Mapa | null {
  return typeof valor === "object" && valor !== null && !Array.isArray(valor) ? (valor as Mapa) : null;
}

/** A recusa registrada da finalidade, se houver (`declined_at` preenchido). */
export function recusaRegistrada(consent: unknown, finalidade: string): unknown {
  const entrada = comoMapa(comoMapa(consent)?.[finalidade]);
  return entrada?.declined_at ? entrada.declined_at : null;
}

/**
 * Merge por finalidade: a entrada nova SUBSTITUI a anterior (revogar tem de
 * valer), mas a recusa registrada sobrevive a qualquer entrada, inclusive
 * `{}`, `null` ou `{declined_at: null}`.
 */
export function mesclarConsentimento(anterior: unknown, novo: Mapa): Mapa {
  const resultado: Mapa = { ...(comoMapa(anterior) ?? {}) };
  for (const [finalidade, entrada] of Object.entries(novo)) {
    const recusa = recusaRegistrada(anterior, finalidade);
    if (!recusa) {
      resultado[finalidade] = entrada;
      continue;
    }
    const entradaNova = comoMapa(entrada);
    resultado[finalidade] = entradaNova?.declined_at
      ? entrada
      : { ...(entradaNova ?? comoMapa(comoMapa(anterior)?.[finalidade]) ?? {}), declined_at: recusa };
  }
  return resultado;
}

export interface RegistroDeConsentimento {
  finalidade: FinalidadeDeConsentimento;
  acao: "grant" | "decline";
  origem: string;
}

export type ResultadoDoRegistro =
  | { ok: true; consent: Mapa; entrada: Mapa }
  | { ok: false; motivo: "recusa_registrada" };

/**
 * Registra um consentimento ou uma recusa. A recusa nunca é desfeita aqui: dar
 * consentimento a uma finalidade já recusada devolve `recusa_registrada` (quem
 * reabre um canal fechado pelo titular é uma decisão de admin, não um clique de
 * edição). Recusar de novo mantém a data da primeira recusa.
 */
export function registrarConsentimento(
  anterior: unknown,
  registro: RegistroDeConsentimento,
  agoraIso: string,
): ResultadoDoRegistro {
  const recusa = recusaRegistrada(anterior, registro.finalidade);
  if (registro.acao === "grant") {
    if (recusa) return { ok: false, motivo: "recusa_registrada" };
    const entrada: Mapa = { granted_at: agoraIso, source: registro.origem, version: null };
    return { ok: true, consent: mesclarConsentimento(anterior, { [registro.finalidade]: entrada }), entrada };
  }
  const entrada: Mapa = {
    granted_at: null,
    declined_at: recusa ?? agoraIso,
    source: registro.origem,
    version: null,
  };
  return { ok: true, consent: mesclarConsentimento(anterior, { [registro.finalidade]: entrada }), entrada };
}
