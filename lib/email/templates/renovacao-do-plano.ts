/**
 * "Seu plano termina em breve" (D-177, parte 2): o e-mail da régua de aviso de renovação do plano que não
 * renova sozinho (pago parcelado ou no Pix, sem assinatura viva no Asaas). Sai 30, 15, 7 e 1 dia antes do
 * último dia de acesso e no próprio último dia, para quem administra a organização.
 *
 * Curto de propósito: o título, um parágrafo e o botão para a tela de assinar. NÃO diz preço: o valor
 * aparece na tela de assinar, com o catálogo na mão. Os textos (pt-BR, es e, no catálogo, zh-CN) vêm de
 * `lib/billing/assinatura/renovacao-textos.ts`, os mesmos do aviso na Central.
 *
 * Sem asset externo e com estilo inline, como os outros e-mails do repo. Marca resolvida pela organização.
 */
import {
  botaoDaRenovacao,
  corpoDaRenovacao,
  tituloDaRenovacao,
  type DadosDoTextoDeRenovacao,
} from "@/lib/billing/assinatura/renovacao-textos";
import { NEUTROS_DE_SAIDA, type MarcaDeSaida } from "@/lib/branding/saida";
import { traduzir } from "@/lib/i18n/dicionario";

export interface RenovacaoDoPlanoEmailOptions extends DadosDoTextoDeRenovacao {
  /** Para onde o botão leva: a tela de assinar da instalação. */
  assinarUrl: string;
  marca: MarcaDeSaida;
}

export function buildRenovacaoDoPlanoEmail(opts: RenovacaoDoPlanoEmailOptions): {
  subject: string;
  html: string;
  text: string;
} {
  const marca = opts.marca.nome;
  const titulo = tituloDaRenovacao(opts);
  const corpo = corpoDaRenovacao(opts);
  const botao = botaoDaRenovacao(opts.idioma);
  const copie = traduzir("Ou copie e cole este link no navegador:", opts.idioma);

  const logo = opts.marca.logoUrl
    ? `<p style="margin:0 0 24px"><img src="${escapeHtml(opts.marca.logoUrl)}" alt="${escapeHtml(marca)}" height="40" style="height:40px;width:auto;max-width:200px;border:0;display:block"></p>`
    : "";

  const html = `<!doctype html>
<html lang="${opts.idioma}">
<body style="margin:0;padding:0;background:${NEUTROS_DE_SAIDA.fundo};font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:${NEUTROS_DE_SAIDA.texto}">
  <div style="max-width:560px;margin:0 auto;padding:32px 24px">
    ${logo}
    <h1 style="font-size:22px;line-height:1.3;margin:0 0 16px;color:${NEUTROS_DE_SAIDA.texto}">
      ${escapeHtml(titulo)}
    </h1>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.5">
      ${escapeHtml(corpo)}
    </p>
    <p style="margin:24px 0">
      <a href="${escapeHtml(opts.assinarUrl)}" style="display:inline-block;padding:12px 24px;background:${opts.marca.accent};color:${opts.marca.accentFg};border-radius:6px;text-decoration:none;font-weight:600">
        ${escapeHtml(botao)}
      </a>
    </p>
    <p style="margin:0 0 8px;font-size:13px;color:${NEUTROS_DE_SAIDA.suave}">
      ${escapeHtml(copie)}<br>
      <span style="word-break:break-all;color:${opts.marca.accent}">${escapeHtml(opts.assinarUrl)}</span>
    </p>
  </div>
</body>
</html>`;

  const text = [titulo, "", corpo, "", `${botao}: ${opts.assinarUrl}`].join("\n");

  return { subject: titulo, html, text };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
