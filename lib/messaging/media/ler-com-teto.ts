/**
 * Ler o corpo de uma resposta HTTP com TETO de bytes.
 *
 * `res.arrayBuffer()` lê tudo antes de qualquer conferência: um servidor que
 * devolve um fluxo de vários GB (ou sem fim) enche a memória do processo, e o
 * worker cai antes de o teto ser olhado. Aqui o corpo é lido em pedaços e a
 * leitura para (e o fluxo é cancelado) no primeiro byte acima do teto.
 *
 * Vale para todo download cujo endereço vem de fora: foto de perfil
 * (`lib/channels/avatar-download.ts`) e mídia recebida (dos canais de mensagens).
 */

/** Lê o corpo até `teto` bytes; `null` quando passa dele (e para de ler). */
export async function lerComTeto(res: Response, teto: number): Promise<Buffer | null> {
  const declarado = Number(res.headers.get("content-length"));
  if (Number.isFinite(declarado) && declarado > teto) {
    try {
      await res.body?.cancel();
    } catch {
      // Cancelar é só para largar a conexão; o teto já decidiu.
    }
    return null;
  }

  if (!res.body) {
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.byteLength > teto ? null : buf;
  }

  const leitor = res.body.getReader();
  const pedacos: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await leitor.read();
    if (done) break;
    total += value.byteLength;
    if (total > teto) {
      await leitor.cancel().catch(() => undefined);
      return null;
    }
    pedacos.push(value);
  }
  return Buffer.concat(pedacos);
}
