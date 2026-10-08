/**
 * O layout comum dos e-mails transacionais do CRM (cobrança, conta, IA): cabeçalho com a logo fora do cartão,
 * cartão branco com selo, título, texto, passos, resumo, barra de progresso e botão, e rodapé fora do cartão.
 *
 * É uma função pura: recebe os textos JÁ no idioma de quem lê (cada template traduz o que é seu) e devolve
 * `{ html, text }`. Quem decide assunto, envio e destinatário é o template e o roteador, não este arquivo.
 *
 * HTML de e-mail, não de navegador: tabelas `role="presentation"`, 600px, tudo inline (o Gmail e o Outlook
 * descartam ou reescrevem o resto) e nada de CSS moderno na barra de progresso. O único `<style>` é o ajuste
 * de margem do celular, que é só um enfeite: se o cliente o ignorar, o e-mail continua inteiro.
 *
 * Todo valor que vem de fora (nome da empresa, plano, URL, rótulo) passa por `escapeHtml`. URL só entra se
 * for http ou https; qualquer outra coisa não desenha o botão (nem a linha "copie e cole").
 *
 * Cores: os neutros e a marca vêm de `lib/branding/saida.ts`. As únicas cores fixas daqui são as dos tons de
 * estado (sucesso, alerta, perigo), que significam a mesma coisa em qualquer marca.
 */
import { NEUTROS_DE_SAIDA, type MarcaDeSaida } from "@/lib/branding/saida";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";

export type TomDoEmail = "info" | "sucesso" | "alerta" | "perigo";

const COR_DO_TOM_FIXA = {
  sucesso: "#15803d",
  alerta: "#b45309",
  perigo: "#b91c1c",
} as const;

const FONTE = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

export interface PassoDoEmail {
  titulo: string;
  descricao: string;
}

export interface ResumoDoEmail {
  rotulo: string;
  valor: string;
}

export interface ProgressoDoEmail {
  /** 0 a 100. Fora disso é cortado; fração é arredondada. */
  percentual: number;
  /** O texto acima da barra, à esquerda ("Tokens usados no mês"). */
  rotulo: string;
  /** O texto abaixo da barra ("400.000 de 500.000"). */
  detalhe?: string;
}

/** O que todo e-mail transacional recebe: a marca, o idioma de quem lê, a empresa e o destino do botão. */
export interface OpcoesBaseDoEmail {
  marca: MarcaDeSaida;
  idioma: Idioma;
  empresa: string;
  /** Para onde o botão leva. Só http/https desenha o botão. */
  url: string;
  /**
   * Só na cópia para o operador da instalação: a faixa no topo do cartão ("Cópia para o operador: enviado aos
   * admins da {empresa}"). O envio (`lib/email/conta-e-cobranca/enviar.ts`) a preenche; o e-mail do cliente
   * nunca a leva.
   */
  faixaDoOperador?: string;
}

export interface EmailTransacionalOpts {
  marca: MarcaDeSaida;
  idioma: Idioma;
  /** Nome da empresa (organização) de quem recebe, para o rodapé. */
  empresa: string;
  /** Texto de pré-visualização. Sem ele, vale a primeira frase do primeiro parágrafo. */
  preheader?: string;
  selo?: { texto: string; tom: TomDoEmail };
  titulo: string;
  paragrafos: readonly string[];
  passos?: readonly PassoDoEmail[];
  resumo?: readonly ResumoDoEmail[];
  progresso?: ProgressoDoEmail;
  botao?: { texto: string; url: string };
  /** Substitui a frase padrão do rodapé ("Você recebe este e-mail porque administra..."). Já traduzida. */
  motivoDoRodape?: string;
  /** Faixa no topo do cartão, só na cópia para o operador. Texto já pronto; sai escapado. */
  faixaDoOperador?: string;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Substituição de `{chave}` em passe ÚNICO e com callback: o valor entra como está (um `$&` num nome não vira
 * nada) e nunca é reprocessado, então uma empresa chamada `{plano}` não é trocada pelo plano na chave seguinte.
 * Marcador sem valor correspondente fica como veio.
 */
export function preencher(texto: string, valores: Record<string, string | number>): string {
  return texto.replace(/\{([^{}]+)\}/g, (inteiro, chave: string) =>
    Object.hasOwn(valores, chave) ? String(valores[chave]) : inteiro,
  );
}

/** Texto de uma linha só, para assunto de e-mail: sem quebra de linha (cabeçalho SMTP) e sem espaço sobrando. */
export function paraAssunto(texto: string): string {
  // \p{Zl} e \p{Zp}: os separadores de linha e de parágrafo do Unicode (U+2028 e U+2029).
  return texto
    .replace(/[\r\n]|\p{Zl}|\p{Zp}/gu, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** `http` ou `https`; qualquer outra coisa (javascript:, data:, vazio, texto solto) devolve `null`. */
export function urlSegura(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const alvo = new URL(url.trim());
    return alvo.protocol === "https:" || alvo.protocol === "http:" ? alvo.toString() : null;
  } catch {
    return null;
  }
}

/** Centavos como `R$ 1.049,00` (espaço comum, não o espaço sem quebra do Intl, que atrapalha busca e assunto). */
export function formatarReais(centavos: number): string {
  const valor = Number.isFinite(centavos) ? centavos / 100 : 0;
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" })
    .format(valor)
    .replace(/\p{Zs}/gu, " ");
}

/** Inteiro com ponto de milhar: `500000` vira `500.000`. */
export function formatarInteiro(n: number): string {
  return new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 })
    .format(Number.isFinite(n) ? n : 0)
    .replace(/\p{Zs}/gu, " ");
}

/**
 * ISO como `dd/mm/aaaa`. `2026-11-06` (data civil) sai como está; um instante (`2026-11-07T03:00:00+00:00`)
 * é lido no dia de São Paulo, o fuso do produto, para não cair num dia a menos. Texto que não é data volta
 * como veio.
 */
export function formatarData(iso: string): string {
  const civil = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (civil) return `${civil[3]}/${civil[2]}/${civil[1]}`;
  const instante = new Date(iso);
  if (Number.isNaN(instante.getTime())) return iso;
  // O formato é fixo (dd/mm/aaaa, o mesmo de pt-BR e es); o Intl só lê o dia no fuso de São Paulo, e o
  // locale `en-US` serve apenas para entregar as partes numéricas.
  const partes = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).formatToParts(instante);
  const parte = (tipo: string) => partes.find((p) => p.type === tipo)?.value ?? "";
  return `${parte("day")}/${parte("month")}/${parte("year")}`;
}

export type CicloDoPlano = "monthly" | "semiannual" | "yearly";

const ROTULO_DO_CICLO: Record<CicloDoPlano, string> = {
  monthly: "Mensal",
  semiannual: "Semestral",
  yearly: "Anual",
};

/** "Mensal", "Semestral" ou "Anual" no idioma de quem lê. */
export function rotuloDoCiclo(ciclo: CicloDoPlano, idioma: Idioma): string {
  return traduzir(ROTULO_DO_CICLO[ciclo], idioma);
}

export type FormaDePagamento =
  { tipo: "cartao" } | { tipo: "pix" } | { tipo: "cartao_parcelado"; parcelas: number };

/** "Cartão", "Pix" ou "Cartão em 6x" no idioma de quem lê. */
export function rotuloDaForma(forma: FormaDePagamento, idioma: Idioma): string {
  if (forma.tipo === "pix") return traduzir("Pix", idioma);
  if (forma.tipo === "cartao_parcelado") {
    return preencher(traduzir("Cartão em {n}x", idioma), { n: forma.parcelas });
  }
  return traduzir("Cartão", idioma);
}

/** A primeira frase de um texto (até o primeiro ponto, exclamação, interrogação ou ponto final chinês). */
export function primeiraFrase(texto: string): string {
  const [frase] = texto.split(/(?<=[.!?])\s+|(?<=。)/);
  return (frase ?? texto).trim();
}

function corDoTom(tom: TomDoEmail, marca: MarcaDeSaida): string {
  return tom === "info" ? marca.accent : COR_DO_TOM_FIXA[tom];
}

/** O Gmail não mostra SVG em `<img>`; logo SVG (ou ausente, ou com URL estranha) vira o nome em texto. */
function logoUtilizavel(logoUrl: string | null): string | null {
  const url = urlSegura(logoUrl);
  if (!url) return null;
  try {
    return new URL(url).pathname.toLowerCase().endsWith(".svg") ? null : url;
  } catch {
    return null;
  }
}

export function montarEmailTransacional(opts: EmailTransacionalOpts): {
  html: string;
  text: string;
} {
  const { marca, idioma } = opts;
  const N = NEUTROS_DE_SAIDA;
  const botaoUrl = opts.botao ? urlSegura(opts.botao.url) : null;
  const tom = opts.selo?.tom ?? "info";
  const corTom = corDoTom(tom, marca);
  const preheader = opts.preheader ?? primeiraFrase(opts.paragrafos[0] ?? opts.titulo);
  const motivo =
    opts.motivoDoRodape ??
    preencher(traduzir("Você recebe este e-mail porque administra a {empresa} no {crm}.", idioma), {
      empresa: opts.empresa,
      crm: marca.nome,
    });

  // ─── Cabeçalho ───
  const logo = logoUtilizavel(marca.logoUrl);
  const cabecalho = logo
    ? `<img src="${escapeHtml(logo)}" alt="${escapeHtml(marca.nome)}" height="32" style="display:block;height:32px;width:auto;max-width:220px;border:0;outline:none;text-decoration:none">`
    : `<span style="font-size:20px;line-height:1.2;font-weight:700;color:${marca.accent}">${escapeHtml(marca.nome)}</span>`;

  // ─── Faixa da cópia para o operador ───
  const faixa = opts.faixaDoOperador
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${N.fundo}" style="margin:0 0 20px;background:${N.fundo};border-radius:8px"><tr><td style="padding:10px 14px;font-size:12px;line-height:1.5;font-weight:600;color:${N.suave}">${escapeHtml(opts.faixaDoOperador)}</td></tr></table>`
    : "";

  // ─── Selo ───
  const selo = opts.selo
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 14px"><tr>
              <td valign="middle" style="width:8px;padding:0">
                <table role="presentation" width="8" cellpadding="0" cellspacing="0" border="0"><tr><td width="8" height="8" bgcolor="${corTom}" style="width:8px;height:8px;background:${corTom};border-radius:4px;font-size:0;line-height:0">&nbsp;</td></tr></table>
              </td>
              <td style="padding-left:8px;font-size:12px;line-height:1.2;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:${corTom}">${escapeHtml(opts.selo.texto.toLocaleUpperCase(idioma))}</td>
            </tr></table>`
    : "";

  // ─── Parágrafos ───
  const paragrafos = opts.paragrafos
    .map(
      (p) =>
        `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:${N.texto}">${escapeHtml(p)}</p>`,
    )
    .join("\n            ");

  // ─── Passos ───
  const passos =
    opts.passos && opts.passos.length > 0
      ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px">
${opts.passos
  .map(
    (passo, i) => `              <tr>
                <td width="24" valign="top" style="width:24px;padding:0 14px ${i === opts.passos!.length - 1 ? 0 : 18}px 0">
                  <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
                    <td width="24" height="24" align="center" valign="middle" style="width:24px;height:24px;border:1px solid ${marca.accent};border-radius:12px;font-size:12px;line-height:22px;font-weight:700;color:${marca.accent};text-align:center">${i + 1}</td>
                  </tr></table>
                </td>
                <td valign="top" style="padding:0 0 ${i === opts.passos!.length - 1 ? 0 : 18}px">
                  <div style="font-size:15px;line-height:1.4;font-weight:700;color:${N.texto}">${escapeHtml(passo.titulo)}</div>
                  <div style="margin-top:2px;font-size:14px;line-height:1.5;color:${N.suave}">${escapeHtml(passo.descricao)}</div>
                </td>
              </tr>`,
  )
  .join("\n")}
            </table>`
      : "";

  // ─── Resumo ───
  const resumo =
    opts.resumo && opts.resumo.length > 0
      ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${N.fundo}" style="margin:8px 0 24px;background:${N.fundo};border-radius:8px">
              <tr><td style="padding:4px 20px">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
${opts.resumo
  .map(
    (linha, i) => `                  <tr>
                    <td valign="top" style="padding:12px 12px 12px 0;${i > 0 ? `border-top:1px solid ${N.linha};` : ""}font-size:13px;line-height:1.5;color:${N.suave}">${escapeHtml(linha.rotulo)}</td>
                    <td align="right" valign="top" style="padding:12px 0;${i > 0 ? `border-top:1px solid ${N.linha};` : ""}font-size:14px;line-height:1.5;font-weight:600;color:${N.texto};text-align:right">${escapeHtml(linha.valor)}</td>
                  </tr>`,
  )
  .join("\n")}
                </table>
              </td></tr>
            </table>`
      : "";

  // ─── Barra de progresso ───
  let progresso = "";
  if (opts.progresso) {
    const pct = Math.max(0, Math.min(100, Math.round(opts.progresso.percentual)));
    const preenchimento =
      pct > 0
        ? `<table role="presentation" width="${pct}%" cellpadding="0" cellspacing="0" border="0" style="width:${pct}%"><tr><td height="8" bgcolor="${corTom}" style="height:8px;background:${corTom};border-radius:4px;font-size:0;line-height:0">&nbsp;</td></tr></table>`
        : "";
    progresso = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px">
              <tr>
                <td style="padding:0 0 8px;font-size:13px;line-height:1.4;color:${N.suave}">${escapeHtml(opts.progresso.rotulo)}</td>
                <td align="right" style="padding:0 0 8px;font-size:13px;line-height:1.4;font-weight:700;color:${N.texto};text-align:right">${pct}%</td>
              </tr>
              <tr><td colspan="2" style="padding:0">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${N.linha}" style="background:${N.linha};border-radius:4px"><tr><td height="8" style="height:8px;font-size:0;line-height:0;border-radius:4px">${preenchimento || "&nbsp;"}</td></tr></table>
              </td></tr>${
                opts.progresso.detalhe
                  ? `
              <tr><td colspan="2" style="padding:8px 0 0;font-size:13px;line-height:1.4;color:${N.suave}">${escapeHtml(opts.progresso.detalhe)}</td></tr>`
                  : ""
              }
            </table>`;
  }

  // ─── Botão ───
  const copie = traduzir("Ou copie e cole este link no navegador:", idioma);
  const botao =
    opts.botao && botaoUrl
      ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 20px"><tr>
              <td align="center" bgcolor="${marca.accent}" style="background:${marca.accent};border-radius:8px">
                <a href="${escapeHtml(botaoUrl)}" target="_blank" style="display:inline-block;padding:14px 28px;background:${marca.accent};color:${marca.accentFg};border-radius:8px;font-family:${FONTE};font-size:15px;line-height:1.2;font-weight:600;text-decoration:none">${escapeHtml(opts.botao.texto)}</a>
              </td>
            </tr></table>
            <p style="margin:0;font-size:13px;line-height:1.5;color:${N.suave}">${escapeHtml(copie)}<br><span style="word-break:break-all;color:${marca.accent}">${escapeHtml(botaoUrl)}</span></p>`
      : "";

  const html = `<!doctype html>
<html lang="${escapeHtml(idioma)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(opts.titulo)}</title>
<style>@media only screen and (max-width:620px){.cartao{padding:24px 20px !important}}</style>
</head>
<body style="margin:0;padding:0;background:${N.fundo};font-family:${FONTE};color:${N.texto}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:${N.fundo}">${escapeHtml(preheader)}${"&zwnj;&nbsp;".repeat(30)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${N.fundo}" style="background:${N.fundo}">
  <tr><td align="center" style="padding:0 16px 32px">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px">
      <tr><td align="left" style="padding:28px 0 20px">${cabecalho}</td></tr>
      <tr><td class="cartao" bgcolor="#ffffff" style="background:#ffffff;border:1px solid ${N.linha};border-radius:12px;padding:36px 32px">
            ${faixa}${selo}
            <h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;font-weight:700;color:${N.texto}">${escapeHtml(opts.titulo)}</h1>
            ${paragrafos}
            ${passos}
            ${resumo}
            ${progresso}
            ${botao}
      </td></tr>
      <tr><td align="center" style="padding:20px 8px 0;font-size:12px;line-height:1.6;color:${N.suave};text-align:center">
        ${escapeHtml(motivo)}<br>${escapeHtml(marca.nome)}
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;

  // ─── Versão texto ───
  const blocos: string[] = [
    ...(opts.faixaDoOperador ? [opts.faixaDoOperador] : []),
    opts.titulo,
    ...opts.paragrafos,
  ];
  if (opts.passos && opts.passos.length > 0) {
    blocos.push(opts.passos.map((p, i) => `${i + 1}. ${p.titulo}: ${p.descricao}`).join("\n"));
  }
  if (opts.resumo && opts.resumo.length > 0) {
    blocos.push(opts.resumo.map((l) => `${l.rotulo}: ${l.valor}`).join("\n"));
  }
  if (opts.progresso) {
    const pct = Math.max(0, Math.min(100, Math.round(opts.progresso.percentual)));
    blocos.push(
      [
        `${opts.progresso.rotulo}: ${pct}%`,
        ...(opts.progresso.detalhe ? [opts.progresso.detalhe] : []),
      ].join("\n"),
    );
  }
  if (opts.botao && botaoUrl) blocos.push(`${opts.botao.texto}: ${botaoUrl}`);
  blocos.push(`${motivo}\n${marca.nome}`);

  return { html, text: blocos.join("\n\n") };
}
