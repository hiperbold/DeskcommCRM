/**
 * Lê um corpo multipart com teto de bytes ANTES de materializá-lo (D-105).
 *
 * `req.formData()` carrega o corpo inteiro na memória do processo e só depois a
 * rota confere o tamanho do arquivo. O app atende todas as organizações num só
 * processo: um atendente autenticado mandando algumas centenas de MB derrubaria o
 * container de todo mundo. A conferência pelo `Content-Length` sozinha não basta,
 * porque o envio em pedaços (`Transfer-Encoding: chunked`) não traz o cabeçalho e
 * passava como zero.
 *
 * Aqui o teto vale por dois lados: o cabeçalho declarado acima do teto é recusado
 * sem ler nada, e o corpo é lido pelo fluxo com um contador, abortando no primeiro
 * byte que passa. O que sobra (já dentro do teto) é entregue ao parser normal.
 *
 * O teto é o do arquivo mais a folga do envelope multipart (`FOLGA_MULTIPART_BYTES`):
 * a conferência exata do arquivo continua na rota, depois do parse.
 */

/** Cabeçalhos de parte, delimitadores e campos de texto do envelope multipart. */
export const FOLGA_MULTIPART_BYTES = 1_048_576;

export type LeituraDoMultipart =
  | { ok: true; form: FormData }
  | { ok: false; motivo: "grande" | "invalido" };

export async function lerMultipartComTeto(
  req: Request,
  tetoDoArquivoBytes: number,
): Promise<LeituraDoMultipart> {
  const teto = tetoDoArquivoBytes + FOLGA_MULTIPART_BYTES;

  const declarado = req.headers.get("content-length");
  if (declarado !== null && declarado.trim() !== "") {
    const n = Number(declarado);
    if (Number.isFinite(n) && n > teto) return { ok: false, motivo: "grande" };
  }

  // Sem corpo para ler pelo fluxo (requisição montada sem `body`): deixa o parser
  // da própria requisição decidir, que é o que o código fazia antes.
  if (!req.body) {
    try {
      return { ok: true, form: await req.formData() };
    } catch {
      return { ok: false, motivo: "invalido" };
    }
  }

  const leitor = req.body.getReader();
  const pedacos: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await leitor.read();
      if (done) break;
      total += value.byteLength;
      if (total > teto) {
        await leitor.cancel().catch(() => undefined);
        return { ok: false, motivo: "grande" };
      }
      pedacos.push(value);
    }
  } catch {
    return { ok: false, motivo: "invalido" };
  }

  try {
    const corpo = new Uint8Array(total);
    let posicao = 0;
    for (const p of pedacos) {
      corpo.set(p, posicao);
      posicao += p.byteLength;
    }
    const form = await new Response(corpo, {
      headers: { "content-type": req.headers.get("content-type") ?? "" },
    }).formData();
    return { ok: true, form };
  } catch {
    return { ok: false, motivo: "invalido" };
  }
}
