/**
 * "Seu WhatsApp caiu" — o aviso que chega com o navegador fechado.
 *
 * ─── Por que existe, se a faixa vermelha já avisa ───────────────────────────
 *
 * A faixa (`components/app/ConexaoCaidaBanner.tsx`) resolve o caso de quem está
 * COM o CRM aberto. O caso que sobra é o pior deles: a conexão cai às 19h, o
 * time fechou o navegador, e ninguém sabe de nada até o primeiro cliente
 * reclamar no dia seguinte — com as mensagens da noite inteira paradas do outro
 * lado. É a mesma falha que originou a faixa, só que fora do horário em que
 * alguém está olhando a tela.
 *
 * O comentário da faixa dizia que e-mail não servia porque `RESEND_API_KEY` é
 * opcional e está vazia numa instalação recém-feita. Continua verdade — e é por
 * isso que este aviso é um ACRÉSCIMO e não um substituto: quem não configurou
 * e-mail não perde nada, porque a faixa e a Central seguem iguais. Quem
 * configurou ganha o aviso que chega longe da tela.
 *
 * Sem asset externo e com estilo inline, como os outros e-mails do repo: o
 * cliente de e-mail não carrega CSS de fora.
 */
import { NEUTROS_DE_SAIDA, type MarcaDeSaida } from "@/lib/branding/saida";

export interface ConexaoCaidaEmailOptions {
  /** Como o operador chama esta conexão na tela. */
  apelido: string;
  /** O nome da organização dona do número. */
  orgName: string;
  /** O título do aviso, o MESMO que a Central mostra. */
  titulo: string;
  /** O corpo do aviso, quando o episódio tem um. */
  corpo: string | null;
  /** Para onde o botão leva: a tela de Conexões da instalação. */
  conexoesUrl: string;
  marca: MarcaDeSaida;
}

export function buildConexaoCaidaEmail(opts: ConexaoCaidaEmailOptions): {
  subject: string;
  html: string;
  text: string;
} {
  const marca = opts.marca.nome;
  const subject = `WhatsApp "${opts.apelido}" está desconectado — ${opts.orgName}`;

  const logo = opts.marca.logoUrl
    ? `<p style="margin:0 0 24px"><img src="${escapeHtml(opts.marca.logoUrl)}" alt="${escapeHtml(marca)}" height="40" style="height:40px;width:auto;max-width:200px;border:0;display:block"></p>`
    : "";

  const corpo = opts.corpo
    ? `<p style="margin:0 0 16px;font-size:14px;line-height:1.5;color:${NEUTROS_DE_SAIDA.suave}">${escapeHtml(opts.corpo)}</p>`
    : "";

  const html = `<!doctype html>
<html lang="pt-BR">
<body style="margin:0;padding:0;background:${NEUTROS_DE_SAIDA.fundo};font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:${NEUTROS_DE_SAIDA.texto}">
  <div style="max-width:560px;margin:0 auto;padding:32px 24px">
    ${logo}
    <h1 style="font-size:22px;line-height:1.3;margin:0 0 16px;color:${NEUTROS_DE_SAIDA.texto}">
      ${escapeHtml(opts.titulo)}
    </h1>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.5">
      Enquanto esta conexão estiver fora do ar, <strong>nenhuma mensagem entra nem sai
      por ela</strong> — quem escrever para a ${escapeHtml(opts.orgName)} por este número
      não será atendido, e nada fica guardado no ${escapeHtml(marca)} para ser lido depois.
    </p>
    ${corpo}
    <p style="margin:24px 0">
      <a href="${opts.conexoesUrl}" style="display:inline-block;padding:12px 24px;background:${opts.marca.accent};color:${opts.marca.accentFg};border-radius:6px;text-decoration:none;font-weight:600">
        Abrir Conexões
      </a>
    </p>
    <p style="margin:0 0 8px;font-size:13px;color:${NEUTROS_DE_SAIDA.suave}">
      Ou copie e cole este link no navegador:<br>
      <span style="word-break:break-all;color:${opts.marca.accent}">${opts.conexoesUrl}</span>
    </p>
    <p style="margin:24px 0 0;font-size:13px;color:${NEUTROS_DE_SAIDA.suave}">
      Este aviso sai UMA vez por queda, não de tempos em tempos: receber o mesmo
      alarme a cada cinco minutos é o caminho mais curto para parar de lê-lo.
      Quando o número voltar, você recebe um aviso de volta.
    </p>
  </div>
</body>
</html>`;

  const text = [
    opts.titulo,
    "",
    `Enquanto esta conexão estiver fora do ar, nenhuma mensagem entra nem sai por ela na ${opts.orgName}.`,
    ...(opts.corpo ? ["", opts.corpo] : []),
    "",
    `Abrir Conexões: ${opts.conexoesUrl}`,
  ].join("\n");

  return { subject, html, text };
}

/** O contrário do de cima: o número voltou, e quem foi avisado precisa saber. */
export function buildConexaoVoltouEmail(opts: {
  apelido: string;
  orgName: string;
  conexoesUrl: string;
  marca: MarcaDeSaida;
}): { subject: string; html: string; text: string } {
  const marca = opts.marca.nome;
  const subject = `WhatsApp "${opts.apelido}" voltou — ${opts.orgName}`;

  const html = `<!doctype html>
<html lang="pt-BR">
<body style="margin:0;padding:0;background:${NEUTROS_DE_SAIDA.fundo};font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:${NEUTROS_DE_SAIDA.texto}">
  <div style="max-width:560px;margin:0 auto;padding:32px 24px">
    <h1 style="font-size:22px;line-height:1.3;margin:0 0 16px;color:${NEUTROS_DE_SAIDA.texto}">
      O WhatsApp "${escapeHtml(opts.apelido)}" voltou
    </h1>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.5">
      A conexão está no ar de novo e as mensagens voltaram a entrar e sair
      normalmente no ${escapeHtml(marca)}.
    </p>
    <p style="margin:0 0 16px;font-size:14px;line-height:1.5;color:${NEUTROS_DE_SAIDA.suave}">
      Vale olhar as conversas do período em que ela esteve fora: o que o cliente
      mandou enquanto o número estava desconectado não chega depois.
    </p>
    <p style="margin:24px 0">
      <a href="${opts.conexoesUrl}" style="display:inline-block;padding:12px 24px;background:${opts.marca.accent};color:${opts.marca.accentFg};border-radius:6px;text-decoration:none;font-weight:600">
        Abrir Conexões
      </a>
    </p>
  </div>
</body>
</html>`;

  const text = [
    `O WhatsApp "${opts.apelido}" voltou: a conexão está no ar de novo.`,
    "",
    "Vale olhar as conversas do período em que ela esteve fora — o que o cliente mandou enquanto o número estava desconectado não chega depois.",
    "",
    `Abrir Conexões: ${opts.conexoesUrl}`,
  ].join("\n");

  return { subject, html, text };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
