/**
 * Teto de pedidos do pareamento por QR Code, por organização.
 *
 * Cada pedido de "iniciar" cria uma instância paga no servidor de WhatsApp, e
 * criar e cancelar em laço, ou pedir outro QR sem parar, é o caminho para esgotar o
 * servidor da instalação ou do cliente. O teto de instâncias e o de pendentes moram
 * no banco (`fn_channel_pareamento_qr_reservar`); este é o freio de TAXA, na borda,
 * com o contador que o resto do repo já usa (`checkRateLimit`, Redis com queda para a
 * memória do processo).
 */
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";

export const LIMITES_DO_PAREAMENTO_QR = {
  /** Instâncias novas: 10 por hora. */
  iniciar: { max: 10, janelaSeg: 3600 },
  /** Outro QR (ou código) na mesma instância: 30 por hora. */
  renovar: { max: 30, janelaSeg: 3600 },
  /** Cancelamentos: 20 por hora. */
  cancelar: { max: 20, janelaSeg: 3600 },
  /**
   * Consultas do estado (`verificar`): 1 por segundo. Cada uma fala com o servidor de WhatsApp e pode
   * concluir ou desfazer o pareamento; a tela consulta a cada 3 s, então 1/s não recusa o uso normal.
   */
  verificar: { max: 1, janelaSeg: 1 },
} as const;

export type AcaoDoPareamentoQr = keyof typeof LIMITES_DO_PAREAMENTO_QR;

/** `true` quando a organização ainda está dentro do teto desta ação (e conta este pedido). */
export async function dentroDoLimiteDoPareamentoQr(
  acao: AcaoDoPareamentoQr,
  organizationId: string,
): Promise<boolean> {
  const { max, janelaSeg } = LIMITES_DO_PAREAMENTO_QR[acao];
  const r = await checkRateLimit(`pareamento-qr:${acao}:${organizationId}`, max, janelaSeg);
  return r.allowed;
}
