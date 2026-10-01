/**
 * Assinatura do webhook do Datafy — módulo PURO (recorte do #1130, @vgamkt).
 *
 * O Datafy entrega o payload idêntico ao da Meta, mas assina diferente: o
 * header é `x-datafy-signature-256` (`sha256=<hex>`) e o HMAC-SHA256 é do texto
 * `"{timestamp}.{corpo}"`, com o timestamp em `x-datafy-timestamp` (a Meta
 * assina só o corpo). O segredo (`whsec_…`) nasce no painel do Datafy, por
 * número, quando a assinatura é ativada lá.
 *
 * Do NOSSO lado a assinatura não é opcional: sem o `whsec_` gravado, a entrada
 * recusa tudo. Uma URL secreta sozinha deixaria qualquer um que a visse
 * (log de proxy, print de tela) injetar mensagem forjada na caixa de entrada —
 * a exceção que o canal por QR já pagou.
 *
 * O corpo tem de chegar CRU: o HMAC é sobre os bytes originais, e
 * parsear/reserializar o JSON muda os bytes e a assinatura nunca bate.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** O prefixo que o painel do provedor dá ao segredo de assinatura. */
export const PREFIXO_DO_SEGREDO = "whsec_";

export const HEADER_ASSINATURA = "x-datafy-signature-256";
export const HEADER_TIMESTAMP = "x-datafy-timestamp";

/**
 * Quanto o carimbo assinado pode estar longe do relógio daqui. Sem janela, o corpo
 * assinado de uma entrega valia para sempre: quem o capturasse (log de proxy, print)
 * o reenviava depois (D-130). Cinco minutos cobrem reentrega e deriva de relógio.
 */
export const JANELA_DO_CARIMBO_MS = 5 * 60 * 1000;

/** A assinatura confere? `false` para qualquer peça ausente ou malformada. */
export function verifyGraphPartnerSignature(
  rawBody: string,
  signatureHeader: string | null,
  timestampHeader: string | null,
  secret: string | null,
  agoraMs: number = Date.now(),
): boolean {
  if (!signatureHeader || !timestampHeader || !secret?.startsWith(PREFIXO_DO_SEGREDO)) return false;

  // O carimbo é época em segundos (aceita milissegundos). Não numérico ou fora da
  // janela recusa antes de gastar o HMAC.
  const carimbo = Number(timestampHeader);
  if (!Number.isFinite(carimbo) || carimbo <= 0) return false;
  const carimboMs = carimbo > 1e12 ? carimbo : carimbo * 1000;
  if (Math.abs(agoraMs - carimboMs) > JANELA_DO_CARIMBO_MS) return false;

  const [algo, hex] = signatureHeader.split("=");
  if (algo !== "sha256" || !hex) return false;

  const esperada = createHmac("sha256", secret)
    .update(`${timestampHeader}.${rawBody}`, "utf8")
    .digest("hex");
  const a = Buffer.from(hex, "utf8");
  const b = Buffer.from(esperada, "utf8");
  // Tamanhos diferentes fariam `timingSafeEqual` LANÇAR; comparar antes evita
  // que uma assinatura malformada vire 500 em vez de 401.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
