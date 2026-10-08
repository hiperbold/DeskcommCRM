/**
 * CONTA-06, boas-vindas: sai quando a empresa é criada, para quem a criou. Diz o que fazer primeiro (conectar o
 * WhatsApp, convidar a equipe, configurar o primeiro agente de IA) e leva ao app pelo botão.
 *
 * Textos aprovados pelo dono; pt-BR, es e (no catálogo) zh-CN. O layout é o de `_layout-transacional.ts`.
 */
import { traduzir } from "@/lib/i18n/dicionario";

import {
  montarEmailTransacional,
  paraAssunto,
  preencher,
  type OpcoesBaseDoEmail,
} from "./_layout-transacional";

export const ID_DO_EMAIL = "CONTA-06";

export interface BoasVindasEmailOptions extends OpcoesBaseDoEmail {
  /** Primeiro nome de quem criou a empresa. */
  nome: string;
}

export function buildBoasVindasEmail(opts: BoasVindasEmailOptions): {
  subject: string;
  html: string;
  text: string;
} {
  const { idioma, marca } = opts;
  const crm = marca.nome;

  const assunto = preencher(traduzir("Bem-vindo ao {crm}, {nome}", idioma), {
    crm,
    nome: opts.nome,
  });
  const titulo = preencher(traduzir("Bem-vindo, {nome}", idioma), { nome: opts.nome });
  const texto = preencher(
    traduzir("Sua empresa {empresa} já está no {crm}. Para começar:", idioma),
    {
      empresa: opts.empresa,
      crm,
    },
  );

  const { html, text } = montarEmailTransacional({
    marca,
    idioma,
    empresa: opts.empresa,
    faixaDoOperador: opts.faixaDoOperador,
    selo: { texto: traduzir("Conta criada", idioma), tom: "info" },
    titulo,
    paragrafos: [texto],
    passos: [
      {
        titulo: traduzir("Conecte seu WhatsApp", idioma),
        descricao: traduzir(
          "Leia o QR Code em Conexões e as conversas passam a cair no CRM.",
          idioma,
        ),
      },
      {
        titulo: traduzir("Convide sua equipe", idioma),
        descricao: traduzir("Cada atendente entra com o próprio login.", idioma),
      },
      {
        titulo: traduzir("Configure seu primeiro agente de IA", idioma),
        descricao: traduzir(
          "Ele responde, qualifica e passa para a equipe quando precisar.",
          idioma,
        ),
      },
    ],
    botao: { texto: traduzir("Começar agora", idioma), url: opts.url },
    motivoDoRodape: preencher(
      traduzir("Você recebe este e-mail porque criou a {empresa} no {crm}.", idioma),
      { empresa: opts.empresa, crm },
    ),
  });

  return { subject: paraAssunto(assunto), html, text };
}
