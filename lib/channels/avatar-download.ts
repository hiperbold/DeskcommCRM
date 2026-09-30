/**
 * Baixar a foto de perfil de um contato: a URL vem do servidor do canal, e o
 * servidor do canal pode ser da ORGANIZAÇÃO (UAZAPI: cada conexão aponta para um
 * servidor que o admin escolheu).
 *
 * ─── Por que este arquivo existe (D-083, achado 1) ──────────────────────────
 *
 * O cron de fotos fazia `fetch(url)` puro na URL que o servidor da organização
 * devolvia, seguindo redirect, e gravava os bytes no bucket `whatsapp-media`,
 * legível pela própria organização. Um servidor falso apontava `image` para
 * `http://169.254.169.254/...` (ou para um 302 que terminasse lá) e lia a
 * resposta interna como se fosse uma foto.
 *
 * Duas travas, e nenhuma dispensa a outra:
 *
 *   1. DESTINO: a régua de organização (`fetchParaDestinoDaOrganizacao`) julga o
 *      endereço a cada requisição, não segue redirect e trata 3xx como recusa.
 *   2. CONTEÚDO: só grava o que tem assinatura de imagem (JPEG, PNG, WebP, GIF)
 *      e cabe no teto. Resposta interna que passasse pela primeira trava (um
 *      serviço público que devolve JSON) não vira arquivo no bucket.
 *
 * O teto é aplicado LENDO o corpo em pedaços: um servidor que devolve um fluxo
 * sem fim não pode encher a memória do processo antes de a conferência rodar.
 */
import { fetchParaDestinoDaOrganizacao } from "@/lib/automation/destinos-internos-autorizados";
import { lerComTeto } from "@/lib/messaging/media/ler-com-teto";

/** Foto de perfil do WhatsApp é pequena; acima disto é resposta errada. */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

/** Teto de espera: servidor que pendura não pode pendurar o cron junto. */
const PRAZO_MS = 20_000;

export type TipoDeImagem = "image/jpeg" | "image/png" | "image/webp" | "image/gif";

const inicia = (buf: Uint8Array, bytes: readonly number[], deslocamento = 0): boolean =>
  buf.length >= deslocamento + bytes.length && bytes.every((b, i) => buf[deslocamento + i] === b);

/**
 * O tipo da imagem pela ASSINATURA do arquivo, ou `null` quando não é uma das
 * quatro aceitas. O `content-type` que o servidor declara não vale nada aqui:
 * quem controla o servidor controla o cabeçalho.
 */
export function tipoDeImagemPelaAssinatura(buf: Uint8Array): TipoDeImagem | null {
  if (inicia(buf, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (inicia(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  // "GIF87a" e "GIF89a".
  if (inicia(buf, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || inicia(buf, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) {
    return "image/gif";
  }
  // "RIFF" + 4 bytes de tamanho + "WEBP".
  if (inicia(buf, [0x52, 0x49, 0x46, 0x46]) && inicia(buf, [0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  return null;
}

export type ResultadoDoAvatar =
  | { ok: true; buf: Buffer; contentType: TipoDeImagem }
  | { ok: false; motivo: "http" | "vazio" | "grande" | "nao_imagem" };

/**
 * Baixa a foto pela régua de organização e confere que é imagem de verdade.
 *
 * LANÇA quando o destino é recusado (endereço interno, DNS que não resolve,
 * redirect): quem chama trata como falha do contato. Devolve `ok: false` quando
 * o destino era permitido mas o que veio não serve, e nesse caso nada deve ser
 * gravado.
 */
export async function baixarAvatar(url: string): Promise<ResultadoDoAvatar> {
  const res = await fetchParaDestinoDaOrganizacao()(url, { signal: AbortSignal.timeout(PRAZO_MS) });
  if (!res.ok) return { ok: false, motivo: "http" };

  const buf = await lerComTeto(res, AVATAR_MAX_BYTES);
  if (!buf) return { ok: false, motivo: "grande" };
  if (buf.byteLength === 0) return { ok: false, motivo: "vazio" };

  const contentType = tipoDeImagemPelaAssinatura(buf);
  if (!contentType) return { ok: false, motivo: "nao_imagem" };
  return { ok: true, buf, contentType };
}
