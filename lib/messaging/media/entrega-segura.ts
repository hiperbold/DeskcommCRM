/**
 * Como a rota de mídia entrega os bytes (D-095).
 *
 * O proxy de `GET /api/v1/messages/[id]/media` roda na origem do CRM, com a
 * sessão de quem clicou. Servir ali o `Content-Type` que veio de fora (do
 * atacante, ou de um cliente que mandou um `.html` pelo WhatsApp) faz o script
 * rodar com os poderes dessa sessão. Só o que o navegador não executa vai inline:
 * imagem (menos SVG, que é documento com script), áudio e vídeo. O resto sai como
 * binário para baixar, e o `sandbox` na CSP tira o poder de script mesmo se o
 * navegador decidir abrir.
 */

/** O tipo pode ser exibido inline sem que o navegador execute o conteúdo. */
export function mimeInlineSeguro(mime: string | null | undefined): boolean {
  const base = (mime ?? "").split(";")[0]!.trim().toLowerCase();
  if (base === "image/svg+xml" || base.startsWith("image/svg")) return false;
  return base.startsWith("image/") || base.startsWith("audio/") || base.startsWith("video/");
}

/** Cabeçalhos da resposta que entrega bytes de fora pela origem do CRM. */
export function cabecalhosDeEntregaSegura(mime: string | null | undefined): Record<string, string> {
  const inline = mimeInlineSeguro(mime);
  return {
    "Content-Type": inline ? (mime as string).split(";")[0]!.trim().toLowerCase() : "application/octet-stream",
    ...(inline ? {} : { "Content-Disposition": "attachment" }),
    "Content-Security-Policy": "sandbox",
    "X-Content-Type-Options": "nosniff",
  };
}
