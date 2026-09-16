/**
 * O ESTADO da instância — traduzido uma vez só, e lido por dois caminhos.
 *
 * ─── Por que isto não mora dentro do adapter ────────────────────────────────
 *
 * O mesmo vocabulário chega de duas portas: a varredura PERGUNTA
 * (`/instance/status`, no adapter) e o servidor EMPURRA (evento `connection`,
 * no webhook). Com a tradução escrita duas vezes, a primeira divergência
 * aparece do pior jeito possível: a varredura diz "peça o QR" e o empurrão diz
 * "está tudo bem" para o MESMO estado, e o aviso da Central passa a piscar
 * sozinho a cada cinco minutos.
 *
 * ─── O estado que eu NÃO conheço ────────────────────────────────────────────
 *
 * O vocabulário do servidor é aberto e não está no contrato publicado. Estado
 * que não está na lista NÃO vira "tudo bem" nem "caiu": vira `reachable:false`
 * com o nome dele no detalhe, que é o que alguém lê no arquivo do webhook
 * quando quiser descobrir o que apareceu de novo.
 */
import type { ChannelHealth } from "../types";

/**
 * `instance.status` do servidor → o que o vigia de conexão entende.
 *
 * `disconnected` entra como "precisa parear" e não como falha de credencial: o
 * token continua valendo, quem saiu foi o aparelho. Quem lê o aviso precisa
 * escanear o QR, e é isso que `SCAN_QR_CODE` diz.
 */
export function saudeDoEstadoUazapi(estado: string | null | undefined): ChannelHealth {
  switch ((estado ?? "").trim().toLowerCase()) {
    case "connected":
      return { reachable: true, status: "WORKING", detail: null };
    case "connecting":
    case "disconnected":
      return { reachable: true, status: "SCAN_QR_CODE", detail: null };
    case "hibernated":
      return { reachable: true, status: "STOPPED", detail: "instancia_hibernada" };
    default:
      return { reachable: false, status: null, detail: `estado_desconhecido_${(estado ?? "").trim().toLowerCase() || "vazio"}` };
  }
}
