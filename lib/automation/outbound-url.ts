/**
 * Validação anti-SSRF de URL outbound.
 * ponytail: dois tetos conhecidos —
 *  1) literais IPv6 são bloqueados por INTEIRO (unsafe_url:ipv6_literal), não
 *     só `[::1]`: formas como `[::ffff:127.0.0.1]` (IPv4-mapped) ou `[fc00::1]`
 *     (ULA) contornariam uma regex parcial. Alvo real de webhook (Zapier/n8n/
 *     self-host) usa hostname ou IPv4 público — allowlist de faixas IPv6
 *     públicas só se aparecer demanda real.
 *  2) DNS-rebinding: este guard é TEXTUAL e não resolve nome. Quem faz a
 *     resolução é `assertDestinoResolvidoSeguro` (lib/automation/outbound-ip.ts),
 *     chamado logo depois deste em call-webhook.ts. Os dois juntos: este recusa
 *     o que dá para recusar de graça (esquema, http em produção, literal), o
 *     outro paga o custo do DNS e julga o IP de verdade.
 */
const PRIVATE_HOST_RX =
  /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/i;

export type OpcoesDaUrlSegura = {
  /**
   * Exige https qualquer que seja o `NODE_ENV`. Vale para todo destino
   * escolhido por uma ORGANIZAÇÃO: a imagem do worker não define `NODE_ENV`, e
   * "só em produção" deixava http passar lá, o que torna prática a janela de
   * DNS rebinding (o nome vira IP interno entre a conferência e a conexão) e
   * manda a chamada, e o que ela carrega, em claro. Endereço da INSTALAÇÃO
   * continua como sempre: quem paga a máquina escolhe o destino.
   */
  httpsSempre?: boolean;
};

export function assertSafeOutboundUrl(url: string, opcoes: OpcoesDaUrlSegura = {}): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("unsafe_url:invalid");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("unsafe_url:scheme");
  }
  if (parsed.protocol === "http:" && (opcoes.httpsSempre || process.env.NODE_ENV === "production")) {
    throw new Error("unsafe_url:https_required");
  }
  if (parsed.hostname.startsWith("[")) {
    throw new Error("unsafe_url:ipv6_literal");
  }
  if (PRIVATE_HOST_RX.test(parsed.hostname)) {
    throw new Error("unsafe_url:private_host");
  }
}
