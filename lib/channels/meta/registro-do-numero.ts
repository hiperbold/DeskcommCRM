/**
 * O REGISTRO DO NÚMERO NA API OFICIAL DA META (D-174).
 *
 * Um número recém-verificado fica `status: PENDING` até um `POST /{phone_number_id}/register` com
 * `messaging_product: whatsapp` e um PIN de seis dígitos (a verificação em duas etapas do número). Sem
 * isso a Meta não deixa enviar. A conexão manual só validava o par e apontava o webhook; este módulo
 * lê o estado do número e faz o registro.
 *
 * Mora em `lib/channels/meta/` pela mesma razão de `validate-credentials.ts`: a catraca
 * (`scripts/lint-channels.ts`) proíbe a Graph API fora da fronteira do canal.
 *
 * ─── O PIN ───────────────────────────────────────────────────────────────────
 * Nunca é gravado, logado nem devolvido por GET. Quem chama decide de onde ele vem (o admin informa o
 * que já usa, ou o CRM gera um com `gerarPinDeRegistro`) e é responsável por mostrá-lo UMA vez. Aqui ele
 * só viaja no corpo do POST, e é arrancado de qualquer texto que a Meta devolva antes de virar motivo.
 *
 * ─── Erros ───────────────────────────────────────────────────────────────────
 * A mensagem crua da Meta vem em inglês e muda entre versões; o operador lê uma frase em português por
 * código conhecido. O que não é conhecido mostra o código da Meta, que é o que o suporte pede.
 */
import { randomInt } from "node:crypto";

import { graphBaseUrl } from "./graph-base";

/** Tempo máximo de cada chamada ao Graph: a rota não pode ficar pendurada na Meta. */
const PRAZO_DA_CHAMADA_MS = 15_000;

export function gerarPinDeRegistro(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export function pinDeRegistroValido(pin: string): boolean {
  return /^[0-9]{6}$/.test(pin);
}

export type EstadoDoNumero =
  | {
      ok: true;
      /** `CONNECTED`, `PENDING`, `UNVERIFIED`, `FLAGGED`, `RESTRICTED`, `MIGRATED`... como a Meta devolve. */
      status: string | null;
      codeVerificationStatus: string | null;
      displayPhoneNumber: string | null;
      verifiedName: string | null;
      qualityRating: string | null;
      /** O CRM oferece o registro só neste estado. */
      precisaRegistrar: boolean;
    }
  | { ok: false; motivo: string };

export type CodigoDeFalhaDoRegistro =
  | "pin_invalido"
  | "pin_incorreto"
  | "numero_nao_verificado"
  | "limite_de_tentativas"
  | "token_invalido"
  | "sem_permissao"
  | "rede"
  | "recusado_pela_meta";

export type ResultadoDoRegistro =
  | { ok: true }
  | { ok: false; codigo: CodigoDeFalhaDoRegistro; motivo: string };

interface ErroDaGraph {
  error?: { code?: number; error_subcode?: number; message?: string; error_data?: { details?: string } };
}

/** Texto da Meta sem o PIN: a Meta pode repetir o valor recebido na mensagem de erro. */
function semOPin(texto: string, pin: string | null): string {
  return pin ? texto.split(pin).join("******") : texto;
}

/** Frase em português por código da Meta. `null` = código que não conhecemos. */
function fraseDoErro(
  http: number,
  corpo: ErroDaGraph,
): { codigo: CodigoDeFalhaDoRegistro; motivo: string } | null {
  const codigo = corpo.error?.code;
  const subcodigo = corpo.error?.error_subcode;
  if (codigo === 190 || http === 401) {
    return {
      codigo: "token_invalido",
      motivo: "O token da conexão venceu ou foi revogado. Gere outro no painel da Meta e reconecte o canal.",
    };
  }
  if (codigo === 10 || (codigo !== undefined && codigo >= 200 && codigo <= 299) || http === 403) {
    return {
      codigo: "sem_permissao",
      motivo:
        "O token não tem permissão para registrar este número. Confira whatsapp_business_management e whatsapp_business_messaging no painel da Meta.",
    };
  }
  if (codigo === 133005 || subcodigo === 133005) {
    return {
      codigo: "pin_incorreto",
      motivo:
        "O PIN não confere com o que já está cadastrado neste número. Informe o PIN de seis dígitos que você definiu antes (ou redefina-o no WhatsApp Manager).",
    };
  }
  if (codigo === 133006 || subcodigo === 133006) {
    return {
      codigo: "numero_nao_verificado",
      motivo: "O número ainda não foi verificado por código (SMS ou ligação). Verifique-o no WhatsApp Manager e tente de novo.",
    };
  }
  if (codigo === 133008 || codigo === 133009 || codigo === 133015 || codigo === 133016 || codigo === 80007 || codigo === 4 || codigo === 17) {
    return {
      codigo: "limite_de_tentativas",
      motivo: "A Meta limitou as tentativas de registro deste número. Aguarde alguns minutos antes de tentar de novo.",
    };
  }
  return null;
}

function motivoDeErroConhecidoOuGenerico(
  http: number,
  corpo: ErroDaGraph,
  pin: string | null,
): { codigo: CodigoDeFalhaDoRegistro; motivo: string } {
  const conhecido = fraseDoErro(http, corpo);
  if (conhecido) return conhecido;
  const detalhe = corpo.error?.error_data?.details ?? corpo.error?.message ?? null;
  const codigo = corpo.error?.code;
  const rotulo = codigo !== undefined ? `código ${codigo}` : `http_${http}`;
  return {
    codigo: "recusado_pela_meta",
    motivo: `A Meta recusou o pedido (${rotulo})${detalhe ? `: ${semOPin(detalhe, pin)}` : "."}`,
  };
}

async function chamarGraph(
  url: string,
  token: string,
  init: { method: "GET" } | { method: "POST"; corpo: unknown },
): Promise<{ http: number; corpo: unknown } | { rede: string }> {
  try {
    const res = await fetch(url, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.method === "POST" ? { "Content-Type": "application/json" } : {}),
      },
      ...(init.method === "POST" ? { body: JSON.stringify(init.corpo) } : {}),
      signal: AbortSignal.timeout(PRAZO_DA_CHAMADA_MS),
    });
    const corpo = await res.json().catch(() => ({}));
    return { http: res.status, corpo };
  } catch (err) {
    // O motivo da rede NÃO repete a mensagem do erro: ela pode carregar a URL ou o corpo enviado.
    return { rede: err instanceof Error && err.name === "TimeoutError" ? "a Meta não respondeu a tempo" : "falha de conexão" };
  }
}

/** Lê o estado do número na Meta (`status`, `code_verification_status`...). */
export async function lerEstadoDoNumero(input: {
  phoneNumberId: string;
  token: string;
}): Promise<EstadoDoNumero> {
  const campos = "status,code_verification_status,display_phone_number,verified_name,quality_rating";
  const r = await chamarGraph(`${graphBaseUrl()}/${encodeURIComponent(input.phoneNumberId)}?fields=${campos}`, input.token, {
    method: "GET",
  });
  if ("rede" in r) return { ok: false, motivo: `rede indisponível: ${r.rede}` };

  const corpo = r.corpo as ErroDaGraph & {
    status?: string;
    code_verification_status?: string;
    display_phone_number?: string;
    verified_name?: string;
    quality_rating?: string;
  };
  if (r.http < 200 || r.http >= 300 || corpo.error) {
    return { ok: false, motivo: motivoDeErroConhecidoOuGenerico(r.http, corpo, null).motivo };
  }
  const status = corpo.status ?? null;
  return {
    ok: true,
    status,
    codeVerificationStatus: corpo.code_verification_status ?? null,
    displayPhoneNumber: corpo.display_phone_number ?? null,
    verifiedName: corpo.verified_name ?? null,
    qualityRating: corpo.quality_rating ?? null,
    precisaRegistrar: status === "PENDING",
  };
}

/** `POST /{phone_number_id}/register`. O PIN só viaja no corpo da chamada. */
export async function registrarNumero(input: {
  phoneNumberId: string;
  token: string;
  pin: string;
}): Promise<ResultadoDoRegistro> {
  if (!pinDeRegistroValido(input.pin)) {
    return { ok: false, codigo: "pin_invalido", motivo: "O PIN precisa ter exatamente seis dígitos." };
  }
  const r = await chamarGraph(`${graphBaseUrl()}/${encodeURIComponent(input.phoneNumberId)}/register`, input.token, {
    method: "POST",
    corpo: { messaging_product: "whatsapp", pin: input.pin },
  });
  if ("rede" in r) return { ok: false, codigo: "rede", motivo: `rede indisponível: ${r.rede}` };

  const corpo = r.corpo as ErroDaGraph;
  if (r.http < 200 || r.http >= 300 || corpo.error) {
    return { ok: false, ...motivoDeErroConhecidoOuGenerico(r.http, corpo, input.pin) };
  }
  return { ok: true };
}
