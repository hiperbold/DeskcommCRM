/**
 * Quais endereços de Web Push o servidor aceita chamar (D-097, vizinho).
 *
 * A inscrição guarda a URL que o NAVEGADOR recebeu do serviço de push, e o envio
 * faz um POST para ela a cada mensagem. Aceitar qualquer URL deixava um membro
 * gravar `https://servico-interno/...` ou um endereço dele e fazer o servidor
 * chamar (SSRF cego, repetido a cada mensagem que chega à empresa). Só `https` e só
 * os serviços de push dos navegadores: Chrome, Edge e derivados (FCM e WNS),
 * Firefox (Mozilla autopush) e Safari (APNs web).
 */

const HOSTS_EXATOS: ReadonlySet<string> = new Set([
  "fcm.googleapis.com",
  "web.push.apple.com",
  "updates.push.services.mozilla.com",
]);

const SUFIXOS: readonly string[] = [
  ".notify.windows.com",
  ".push.services.mozilla.com",
  ".push.apple.com",
];

export function endpointDePushPermitido(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username !== "" || url.password !== "") return false;
  if (url.port !== "" && url.port !== "443") return false;
  const host = url.hostname.toLowerCase();
  return HOSTS_EXATOS.has(host) || SUFIXOS.some((sufixo) => host.endsWith(sufixo));
}
