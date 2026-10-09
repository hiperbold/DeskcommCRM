/**
 * O endereço de volta que o CRM registra no servidor da conexão.
 *
 * Vem SÓ de `env.NEXT_PUBLIC_APP_URL`, lido em runtime (a imagem genérica nasce com
 * um placeholder de build). Nunca do cabeçalho `Origin` nem do host da requisição:
 * os dois são escolhidos por quem faz a chamada, e o endereço registrado é para onde
 * o servidor de WhatsApp passa a ENTREGAR as mensagens do cliente. Sem o endereço
 * configurado devolve `null`, e quem conclui a conexão avisa que a volta não foi ligada.
 */
import { env } from "@/lib/env";

function baseConfigurada(): string | null {
  const configurada = env.NEXT_PUBLIC_APP_URL;
  return configurada && !configurada.includes("placeholder.invalid")
    ? configurada.replace(/\/+$/, "")
    : null;
}

/** Monta a URL de entrega a partir do token de caminho da conexão. */
export function urlDoWebhookDeCanal(): ((pathToken: string) => string) | null {
  const base = baseConfigurada();
  return base ? (pathToken) => `${base}/api/v1/webhooks/channel/${pathToken}` : null;
}
