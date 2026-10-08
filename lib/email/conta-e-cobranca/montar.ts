/**
 * Monta cada e-mail de conta e de cobrança a partir do que o gatilho guardou em `billing_emails_enviados.dados`.
 *
 * O gatilho captura os dados NA HORA do evento (valores, plano, ciclo, datas, link da fatura, modo) e só
 * enfileira; quem envia (`enviar.ts`, chamado pelo cron `enviar-emails-de-conta`) monta o e-mail daqui, no
 * idioma e com a marca de cada destinatário. Por isso `dados` só leva o que é do FATO, nunca o endereço de
 * ninguém, e tudo o que muda por destinatário (idioma, marca, nome, link do app) entra pelo contexto.
 *
 * O schema de cada código de e-mail é a fonte única do formato: o enfileiramento valida contra ele (dado
 * errado vira log na hora do evento, não e-mail quebrado depois) e a montagem valida de novo (linha antiga ou
 * mexida à mão não vira e-mail com `undefined`).
 */
import { z } from "zod";

import type { MarcaDeSaida } from "@/lib/branding/saida";
import { buildBoasVindasEmail } from "@/lib/email/templates/boas-vindas";
import { buildCancelamentoConfirmadoEmail } from "@/lib/email/templates/cancelamento-confirmado";
import { buildContaSuspensaEmail } from "@/lib/email/templates/conta-suspensa";
import { buildEstornoFeitoEmail } from "@/lib/email/templates/estorno-feito";
import { buildPacoteDeTokensLiberadoEmail } from "@/lib/email/templates/pacote-de-tokens-liberado";
import { buildPagamentoNaoAprovadoEmail } from "@/lib/email/templates/pagamento-nao-aprovado";
import { buildPlanoConfirmadoEmail } from "@/lib/email/templates/plano-confirmado";
import { buildReciboDePagamentoEmail } from "@/lib/email/templates/recibo-de-pagamento";
import { buildRenovacaoNoCartaoChegandoEmail } from "@/lib/email/templates/renovacao-no-cartao-chegando";
import { buildTokensDeIaAcabandoEmail } from "@/lib/email/templates/tokens-de-ia-acabando";
import type { OpcoesBaseDoEmail } from "@/lib/email/templates/_layout-transacional";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";

/** O endereço da fatura que o Asaas devolve (https, domínio do Asaas). Qualquer outro endereço não vira botão. */
export const FATURA_DO_ASAAS = /^https:\/\/(www\.|sandbox\.)?asaas\.com\//;

const ROTA_DO_PLANO = "/app/settings/plano";
const ROTA_DE_ASSINAR = "/app/settings/plano/assinar";

/** O que o `montar` de cada e-mail recebe, já no idioma de quem vai ler. */
export interface ContextoDoEmail {
  organizationId: string;
  /** Nome da empresa (organização) do fato. */
  empresa: string;
  idioma: Idioma;
  marca: MarcaDeSaida;
  /** URL do app sem barra final: `https://crm.exemplo.com.br`. */
  appUrl: string;
  /** Primeiro nome de quem recebe, ou `null`. */
  nome: string | null;
  /** Preenchido só na cópia para o operador. */
  faixaDoOperador?: string;
  /** As opções comuns dos templates, com o botão levando a `url`. */
  base(url: string): OpcoesBaseDoEmail;
}

export interface MensagemMontada {
  subject: string;
  html: string;
  text: string;
}

const texto = z.string().trim().min(1).max(200);
const data = z.string().min(1).max(40);
const centavos = z.number().int().nonnegative();
const ciclo = z.enum(["monthly", "semiannual", "yearly"]);
const forma = z.discriminatedUnion("tipo", [
  z.object({ tipo: z.literal("cartao") }),
  z.object({ tipo: z.literal("pix") }),
  z.object({ tipo: z.literal("cartao_parcelado"), parcelas: z.number().int().min(2).max(24) }),
]);

/** O formato de `dados` de cada código de e-mail. */
export const DADOS_DO_EMAIL = {
  "CONTA-06": z.object({}),
  "COB-02": z.object({ plano: texto, ciclo, forma, acessoAte: data }),
  "COB-03": z.object({
    valor: centavos,
    pagoEm: data,
    plano: texto,
    periodoInicio: data,
    periodoFim: data,
    forma,
  }),
  "COB-04": z.object({ plano: texto, valor: centavos, cobrancaEm: data, dias: z.number().int().min(1).max(30) }),
  "COB-05": z.object({
    plano: texto,
    valor: centavos,
    acessoAte: data,
    /** O link da fatura do Asaas, ou `null` para o botão levar à tela do plano. */
    faturaUrl: z.string().max(500).nullable(),
  }),
  "COB-06": z.object({}),
  "COB-07": z.object({ plano: texto, acessoAte: data }),
  "COB-08": z.object({
    valor: centavos,
    /** O nome do plano, ou `null` quando o estorno é de um pacote de tokens. */
    plano: texto.nullable(),
    estornadoEm: data,
  }),
  "COB-09": z.object({ tokens: z.number().int().positive(), valorPago: centavos }),
  "IA-02": z.object({
    nivel: z.union([z.literal(80), z.literal(100)]),
    modo: z.enum(["avisar", "bloquear"]),
    usados: z.number().nonnegative(),
    total: z.number().nonnegative(),
    renovaEm: data,
  }),
} as const;

export type CodigoDeEmail = keyof typeof DADOS_DO_EMAIL;
export type DadosDoEmail<K extends CodigoDeEmail> = z.input<(typeof DADOS_DO_EMAIL)[K]>;

export function codigoConhecido(emailId: string): emailId is CodigoDeEmail {
  return Object.hasOwn(DADOS_DO_EMAIL, emailId);
}

/** O e-mail não pôde ser montado: código desconhecido ou `dados` fora do formato. Não adianta tentar de novo. */
export class EmailNaoMontavel extends Error {
  constructor(motivo: string) {
    super(motivo);
    this.name = "EmailNaoMontavel";
  }
}

/** Valida `dados` contra o formato do código; lança `EmailNaoMontavel` quando não serve. */
export function validarDados<K extends CodigoDeEmail>(emailId: K, dados: unknown): z.output<(typeof DADOS_DO_EMAIL)[K]> {
  const r = DADOS_DO_EMAIL[emailId].safeParse(dados);
  if (!r.success) throw new EmailNaoMontavel(`dados_invalidos:${emailId}`);
  return r.data as z.output<(typeof DADOS_DO_EMAIL)[K]>;
}

/** Monta o e-mail do código `emailId` com os `dados` guardados na fila, para o destinatário do `ctx`. */
export function montarEmailDeConta(emailId: string, dados: unknown, ctx: ContextoDoEmail): MensagemMontada {
  if (!codigoConhecido(emailId)) throw new EmailNaoMontavel(`codigo_desconhecido:${emailId}`);
  const plano = `${ctx.appUrl}${ROTA_DO_PLANO}`;

  switch (emailId) {
    case "CONTA-06": {
      validarDados(emailId, dados);
      // O cadastro por e-mail não pede o nome da pessoa (só o da empresa): sem nome, vale o da empresa.
      return buildBoasVindasEmail({ ...ctx.base(`${ctx.appUrl}/app`), nome: ctx.nome ?? ctx.empresa });
    }
    case "COB-02": {
      const d = validarDados(emailId, dados);
      return buildPlanoConfirmadoEmail({
        ...ctx.base(plano),
        plano: d.plano,
        ciclo: d.ciclo,
        formaDePagamento: d.forma,
        acessoAte: d.acessoAte,
      });
    }
    case "COB-03": {
      const d = validarDados(emailId, dados);
      return buildReciboDePagamentoEmail({
        ...ctx.base(plano),
        valor: d.valor,
        pagoEm: d.pagoEm,
        plano: d.plano,
        periodoInicio: d.periodoInicio,
        periodoFim: d.periodoFim,
        formaDePagamento: d.forma,
      });
    }
    case "COB-04": {
      const d = validarDados(emailId, dados);
      return buildRenovacaoNoCartaoChegandoEmail({
        ...ctx.base(plano),
        plano: d.plano,
        valor: d.valor,
        cobrancaEm: d.cobrancaEm,
        dias: d.dias,
      });
    }
    case "COB-05": {
      const d = validarDados(emailId, dados);
      return buildPagamentoNaoAprovadoEmail({
        ...ctx.base(d.faturaUrl && FATURA_DO_ASAAS.test(d.faturaUrl) ? d.faturaUrl : plano),
        plano: d.plano,
        valor: d.valor,
        acessoAte: d.acessoAte,
      });
    }
    case "COB-06": {
      validarDados(emailId, dados);
      return buildContaSuspensaEmail(ctx.base(plano));
    }
    case "COB-07": {
      const d = validarDados(emailId, dados);
      return buildCancelamentoConfirmadoEmail({
        ...ctx.base(`${ctx.appUrl}${ROTA_DE_ASSINAR}`),
        plano: d.plano,
        acessoAte: d.acessoAte,
      });
    }
    case "COB-08": {
      const d = validarDados(emailId, dados);
      return buildEstornoFeitoEmail({
        ...ctx.base(plano),
        valor: d.valor,
        plano: d.plano ?? traduzir("Pacote de tokens", ctx.idioma),
        estornadoEm: d.estornadoEm,
      });
    }
    case "COB-09": {
      const d = validarDados(emailId, dados);
      return buildPacoteDeTokensLiberadoEmail({ ...ctx.base(plano), tokens: d.tokens, valorPago: d.valorPago });
    }
    case "IA-02": {
      const d = validarDados(emailId, dados);
      return buildTokensDeIaAcabandoEmail({
        ...ctx.base(plano),
        nivel: d.nivel,
        modo: d.modo,
        usados: d.usados,
        total: d.total,
        renovaEm: d.renovaEm,
      });
    }
  }
}
