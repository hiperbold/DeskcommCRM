import "server-only";

/**
 * Leitura de corpo HTTP com teto de tamanho, em FLUXO (não confia no
 * `Content-Length` declarado: o cabeçalho pode mentir, seja por engano do
 * remetente ou de propósito). Usado pelo webhook do Asaas (fase F5, Tarefa
 * 12, decisão 19), que tem teto de 64 KB independente do que o cabeçalho diz.
 *
 * Quem chama ainda deve conferir `Content-Length` ANTES de chamar esta
 * função, para recusar sem gastar leitura nenhuma quando o cabeçalho já
 * declara um valor acima do teto - esta função cobre o caso em que o
 * cabeçalho declara pouco (ou nada) e o corpo real excede o teto mesmo assim.
 *
 * Concatena os pedaços com `Buffer.concat` (nunca `texto += chunk`): um chunk
 * pode cortar no meio de um caractere UTF-8 multibyte, e concatenar strings
 * nesse ponto corrompe o acento (ver nota de memória "Node: nunca
 * `d += chunk` em resposta HTTP").
 */
export interface ResultadoCorpoComLimite {
  /** `false` quando o corpo (em bytes) passou do teto; `texto` fica vazio. */
  ok: boolean;
  texto: string;
}

export async function lerCorpoComLimite(
  corpo: ReadableStream<Uint8Array> | null,
  limiteBytes: number,
): Promise<ResultadoCorpoComLimite> {
  if (!corpo) {
    return { ok: true, texto: "" };
  }

  const reader = corpo.getReader();
  const pedacos: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    total += value.byteLength;
    if (total > limiteBytes) {
      // Corta assim que o fluxo real passa do teto, sem esperar o resto
      // chegar: o remetente pode estar mandando megabytes atrás de um
      // Content-Length pequeno.
      try {
        await reader.cancel();
      } catch {
        // Cancelar um fluxo já finalizado/abortado nunca é motivo de falha
        // aqui: o que importa é que já decidimos recusar por tamanho.
      }
      return { ok: false, texto: "" };
    }
    pedacos.push(value);
  }

  const bytes = Buffer.concat(pedacos.map((p) => Buffer.from(p)));
  return { ok: true, texto: bytes.toString("utf8") };
}
