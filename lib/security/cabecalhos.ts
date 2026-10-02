/**
 * Cabeçalhos de segurança de resposta que o `next.config.ts` aplica (D-124).
 *
 * Mora em módulo próprio, sem dependência do Next, para um teste poder ler a política
 * sem carregar a configuração inteira. Caminho para ativar o que está em modo de
 * observação: docs/runbooks/csp-e-hsts.md.
 */

/**
 * CSP em modo REPORT-ONLY. O navegador avalia a política e só registra a violação no
 * console (sem endpoint de relatório por enquanto); nada é bloqueado, então a
 * aplicação não quebra. Quando o console ficar limpo nas telas principais, o mesmo
 * texto passa para o cabeçalho `Content-Security-Policy` (ver o runbook).
 *
 * É propositalmente a política MÍNIMA que já vale a pena:
 * - `object-src 'none'`, `base-uri 'self'`, `form-action 'self'` e
 *   `frame-ancestors 'none'` fecham as saídas clássicas de um XSS sem tocar em
 *   script nenhum;
 * - `script-src` ainda aceita `'unsafe-inline'` porque o Next injeta scripts em linha
 *   (hidratação, `<PublicEnvScript/>`); o passo seguinte é trocar isso por nonce no
 *   proxy, e é a parte que exige medir antes de bloquear;
 * - `connect-src` aceita `https:` e `wss:` porque o Supabase da instalação (próprio ou
 *   Cloud) e o Sentry do operador têm domínios que variam por instalação.
 */
export const CSP_REPORT_ONLY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' https: wss:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * HSTS. Só `max-age`: sem `includeSubDomains` e sem `preload`, que obrigam TODOS os
 * subdomínios do domínio (inclusive os que não são deste app) a servir HTTPS, e
 * `preload` é praticamente irreversível. Quem sabe que o domínio inteiro é HTTPS liga
 * os dois seguindo o runbook. O navegador ignora o cabeçalho em resposta HTTP, então
 * instalação sem TLS não é afetada.
 */
export const HSTS = "max-age=31536000";

export const CABECALHOS_DE_SEGURANCA_EXTRAS = [
  { key: "Content-Security-Policy-Report-Only", value: CSP_REPORT_ONLY },
  { key: "Strict-Transport-Security", value: HSTS },
] as const;
