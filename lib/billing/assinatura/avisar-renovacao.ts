/**
 * A régua de aviso de renovação (D-177, parte 2, migration 0946): o contrato que NÃO renova sozinho (pago
 * parcelado ou no Pix, sem assinatura viva no Asaas) recebe um aviso 30, 15, 7 e 1 dia antes do último dia
 * de acesso e no próprio último dia. Esta é a borda do job diário `app/api/v1/cron/avisar-renovacao`.
 *
 * ── Onde mora cada regra ────────────────────────────────────────────────────
 *
 * As regras que dependem de data e de estado do contrato (quem entra na régua, qual marco vale hoje, o que
 * revalidar antes de reservar, quando uma reserva é repetida) moram no BANCO (`fn_billing_renovacao_*`),
 * em datas de America/Sao_Paulo, para o job e qualquer outro leitor enxergarem a mesma coisa. Aqui só
 * ficam a ordem das chamadas, o envio e o resultado de cada canal.
 *
 * ── Os dois canais, e por que a reserva vem antes ──────────────────────────
 *
 * 1. `fn_billing_renovacao_reservar` grava a linha do marco (unique por organização, fim do período e
 *    marco) e diz quais canais esta rodada cumpre. Duas rodadas ao mesmo tempo não cumprem o mesmo canal.
 * 2. E-mail ao dono e aos admins ativos, FORA de qualquer transação de banco. O resultado entra na linha
 *    logo depois do envio. Se a gravação falhar, a linha fica em `pendente` e o e-mail NÃO é reenviado
 *    (e-mail em dobro é pior que e-mail perdido; o aviso na Central cobre). Só `falhou` (nada saiu) repete.
 * 3. Aviso na Central (`fn_billing_renovacao_criar_aviso`, atômico com a marca de cumprido), mais o push
 *    pelo mecanismo existente dos avisos da Central.
 *
 * Marco atrasado: o banco só devolve o marco VIGENTE (o menor já vencido), então um job que perdeu dias
 * manda um aviso, nunca uma pilha. Período que mudou (renovou) deixa de listar e de reservar: a régua do
 * período anterior morre sozinha, e `fn_billing_renovacao_encerrar_avisos` resolve o aviso velho na Central.
 *
 * Nunca lança por uma organização: toda falha de uma vira log e a rodada segue. Só o erro de LISTAR sobe
 * (sem a lista não há rodada), como no conferidor de vencimentos.
 */
import { logger } from "@/lib/logger";

import {
  corpoDaRenovacao,
  idiomaDoDestinatario,
  severidadeDoMarco,
  tituloDaRenovacao,
  type MarcoDaRenovacao,
} from "./renovacao-textos";

/** Quantos contratos uma rodada examina. Acima disso o resto fica para a rodada seguinte. */
const TAMANHO_DO_LOTE = 500;

/** Para a rodada antes de o `curl -m` do scheduler cortá-la: o resto fica para a rodada seguinte. */
const ORCAMENTO_DA_RODADA_MS = 150_000;

interface ErroRpc {
  message: string;
}

/** Uma linha de `fn_billing_renovacao_pendentes`. */
export interface PendenteDeRenovacao {
  organizationId: string;
  contractId: string;
  fimDoPeriodo: string;
  /** `YYYY-MM-DD`, o último dia de acesso (data civil de São Paulo). */
  ultimoDia: string;
  diasRestantes: number;
  marco: MarcoDaRenovacao;
  planoNome: string;
  ciclo: string | null;
  orgNome: string;
  orgLocale: string | null;
}

export interface ReservaDeRenovacao {
  reservaId: string;
  enviarEmail: boolean;
  criarAviso: boolean;
}

export type ResultadoDoEmail = "enviado" | "parcial" | "sem_destinatario" | "nao_configurado" | "falhou";

export interface DestinatarioDeRenovacao {
  email: string;
  /** `user_metadata.locale` da pessoa, quando ela escolheu um. */
  locale: string | null;
}

/** O banco, como a rodada o enxerga. Tem uma versão real (`avisadorDeRenovacaoSobre`) e a do teste. */
export interface AvisadorDeRenovacaoDb {
  /** `fn_billing_renovacao_encerrar_avisos`: quantos avisos velhos foram resolvidos. */
  encerrarAvisosDeQuemRenovou(agora: Date): Promise<{ data: number | null; error: ErroRpc | null }>;
  /** `fn_billing_renovacao_pendentes`. */
  listarPendentes(agora: Date, limite: number): Promise<{ data: PendenteDeRenovacao[] | null; error: ErroRpc | null }>;
  /** `fn_billing_renovacao_reservar`: `data` nulo = nada a fazer (mudou, ou outra rodada cumpre). */
  reservar(p: PendenteDeRenovacao, agora: Date): Promise<{ data: ReservaDeRenovacao | null; error: ErroRpc | null }>;
  /** Grava o resultado do e-mail na linha reservada (só enquanto estiver `pendente`). */
  gravarEmail(
    reservaId: string,
    resultado: ResultadoDoEmail,
    enviados: number,
    falhas: number,
    agora: Date,
  ): Promise<{ error: ErroRpc | null }>;
  /** `fn_billing_renovacao_criar_aviso`: o id do item criado, ou nulo (já criado). */
  criarAviso(
    reservaId: string,
    titulo: string,
    corpo: string,
    severidade: "info" | "warn",
  ): Promise<{ data: string | null; error: ErroRpc | null }>;
  /** Marca o aviso como `falhou` (só enquanto estiver `pendente`), para a próxima rodada repetir. */
  marcarAvisoFalhou(reservaId: string, agora: Date): Promise<{ error: ErroRpc | null }>;
}

/** O que sai do processo: e-mail e quem recebe. Versão real em `avisar-renovacao-servicos.ts`. */
export interface AvisadorDeRenovacaoServicos {
  /** Existe algum caminho capaz de entregar e-mail agora? */
  emailConfigurado(): Promise<boolean>;
  /** Dono e admins ativos da organização, com e-mail. */
  destinatarios(organizationId: string): Promise<DestinatarioDeRenovacao[]>;
  /** Manda UM e-mail. `ok: false` é falha de entrega (não lança). */
  enviarEmail(p: PendenteDeRenovacao, para: DestinatarioDeRenovacao): Promise<{ ok: boolean }>;
}

export interface ResumoDaReguaDeRenovacao {
  /** Contratos que o banco listou como pendentes nesta rodada. */
  avaliados: number;
  /** A reserva foi recusada (o contrato mudou entre a listagem e a reserva) ou outra rodada cumpre. */
  ignorados: number;
  /** Contratos com ao menos um canal cumprido, por marco. */
  avisadosPorMarco: Record<"d30" | "d15" | "d7" | "d1" | "d0", number>;
  emailsEnviados: number;
  emailsSemDestinatario: number;
  emailsNaoConfigurados: number;
  emailsQueFalharam: number;
  avisosCriados: number;
  avisosQueFalharam: number;
  /** Quantos avisos antigos na Central foram resolvidos (renovou, cancelou, ganhou assinatura viva). */
  avisosEncerrados: number;
  /** Contratos em que uma exceção interrompeu o cumprimento (a rodada seguiu para os demais). */
  organizacoesQueFalharam: number;
  /** Pendentes que sobraram para a rodada seguinte por falta de tempo. */
  restantes: number;
}

export interface OpcoesDaReguaDeRenovacao {
  db: AvisadorDeRenovacaoDb;
  servicos: AvisadorDeRenovacaoServicos;
  /** Injeção do relógio, para o teste. */
  agora?: () => Date;
  orcamentoMs?: number;
}

function chaveDoMarco(marco: MarcoDaRenovacao): keyof ResumoDaReguaDeRenovacao["avisadosPorMarco"] {
  return `d${marco}` as keyof ResumoDaReguaDeRenovacao["avisadosPorMarco"];
}

function resumoVazio(): ResumoDaReguaDeRenovacao {
  return {
    avaliados: 0,
    ignorados: 0,
    avisadosPorMarco: { d30: 0, d15: 0, d7: 0, d1: 0, d0: 0 },
    emailsEnviados: 0,
    emailsSemDestinatario: 0,
    emailsNaoConfigurados: 0,
    emailsQueFalharam: 0,
    avisosCriados: 0,
    avisosQueFalharam: 0,
    avisosEncerrados: 0,
    organizacoesQueFalharam: 0,
    restantes: 0,
  };
}

/** Cumpre o canal de e-mail. Devolve se algum e-mail saiu. Nunca lança. */
async function cumprirEmail(
  opcoes: OpcoesDaReguaDeRenovacao,
  p: PendenteDeRenovacao,
  reservaId: string,
  agora: () => Date,
  resumo: ResumoDaReguaDeRenovacao,
): Promise<boolean> {
  const { db, servicos } = opcoes;
  let resultado: ResultadoDoEmail = "falhou";
  let enviados = 0;
  let falhas = 0;

  try {
    if (!(await servicos.emailConfigurado())) {
      resultado = "nao_configurado";
    } else {
      const para = await servicos.destinatarios(p.organizationId);
      if (para.length === 0) {
        resultado = "sem_destinatario";
      } else {
        for (const destinatario of para) {
          try {
            const r = await servicos.enviarEmail(p, destinatario);
            if (r.ok) enviados++;
            else falhas++;
          } catch (err) {
            falhas++;
            logger.warn("[avisar-renovacao] e-mail falhou", {
              organization_id: p.organizationId,
              causa: err instanceof Error ? err.message : String(err),
            });
          }
        }
        resultado = enviados === 0 ? "falhou" : falhas > 0 ? "parcial" : "enviado";
      }
    }
  } catch (err) {
    // Falha antes de qualquer envio (ler destinatário, resolver marca): nada saiu, então vale repetir.
    resultado = "falhou";
    logger.warn("[avisar-renovacao] canal de e-mail falhou", {
      organization_id: p.organizationId,
      causa: err instanceof Error ? err.message : String(err),
    });
  }

  if (resultado === "enviado" || resultado === "parcial") resumo.emailsEnviados++;
  else if (resultado === "sem_destinatario") resumo.emailsSemDestinatario++;
  else if (resultado === "nao_configurado") resumo.emailsNaoConfigurados++;
  else resumo.emailsQueFalharam++;

  const { error } = await db.gravarEmail(reservaId, resultado, enviados, falhas, agora()).catch((err: unknown) => ({
    error: { message: err instanceof Error ? err.message : String(err) },
  }));
  if (error) {
    // O e-mail já saiu (ou não); a linha fica em `pendente` e NÃO será reenviada.
    logger.warn("[avisar-renovacao] resultado do e-mail não gravado", {
      organization_id: p.organizationId,
      causa: error.message,
    });
  }
  return enviados > 0;
}

/** Cumpre o canal da Central. Devolve se o aviso foi criado. Nunca lança. */
async function cumprirAviso(
  opcoes: OpcoesDaReguaDeRenovacao,
  p: PendenteDeRenovacao,
  reservaId: string,
  agora: () => Date,
  resumo: ResumoDaReguaDeRenovacao,
): Promise<boolean> {
  const { db } = opcoes;
  try {
    // O aviso da Central sai no idioma da ORGANIZAÇÃO (ninguém está logado, como o push dos avisos).
    const idioma = idiomaDoDestinatario(null, p.orgLocale);
    const dados = { planoNome: p.planoNome, ultimoDia: p.ultimoDia, diasRestantes: p.diasRestantes, idioma };
    const { data, error } = await db.criarAviso(
      reservaId,
      tituloDaRenovacao(dados),
      corpoDaRenovacao(dados),
      severidadeDoMarco(p.marco),
    );
    if (error) throw new Error(error.message);
    if (data === null) return false;
    resumo.avisosCriados++;
    return true;
  } catch (err) {
    resumo.avisosQueFalharam++;
    logger.warn("[avisar-renovacao] aviso na Central falhou", {
      organization_id: p.organizationId,
      causa: err instanceof Error ? err.message : String(err),
    });
    await db.marcarAvisoFalhou(reservaId, agora()).catch(() => undefined);
    return false;
  }
}

export async function avisarRenovacoes(opcoes: OpcoesDaReguaDeRenovacao): Promise<ResumoDaReguaDeRenovacao> {
  const { db } = opcoes;
  const agora = opcoes.agora ?? (() => new Date());
  const orcamentoMs = opcoes.orcamentoMs ?? ORCAMENTO_DA_RODADA_MS;
  const inicio = agora().getTime();
  const resumo = resumoVazio();

  // Primeiro a régua do período velho morre: o aviso de quem renovou ou cancelou sai da Central. Falha
  // aqui não impede os avisos novos.
  try {
    const { data, error } = await db.encerrarAvisosDeQuemRenovou(agora());
    if (error) throw new Error(error.message);
    resumo.avisosEncerrados = data ?? 0;
  } catch (err) {
    logger.warn("[avisar-renovacao] não foi possível encerrar avisos antigos", {
      causa: err instanceof Error ? err.message : String(err),
    });
  }

  const { data: pendentes, error } = await db.listarPendentes(agora(), TAMANHO_DO_LOTE);
  if (error) {
    // A mensagem do Postgres fica só no log; quem chama devolve frase fixa.
    throw new Error(`fn_billing_renovacao_pendentes: ${error.message}`);
  }

  const lista = pendentes ?? [];
  resumo.avaliados = lista.length;
  if (lista.length >= TAMANHO_DO_LOTE) {
    logger.warn("[avisar-renovacao] lote cheio, o resto fica para a próxima rodada", { limite: TAMANHO_DO_LOTE });
  }

  for (let i = 0; i < lista.length; i++) {
    const p = lista[i]!;
    if (agora().getTime() - inicio > orcamentoMs) {
      resumo.restantes = lista.length - i;
      logger.warn("[avisar-renovacao] tempo da rodada esgotado, o resto fica para a próxima", {
        restantes: resumo.restantes,
      });
      break;
    }

    try {
      const { data: reserva, error: erroReserva } = await db.reservar(p, agora());
      if (erroReserva) throw new Error(erroReserva.message);
      if (reserva === null) {
        resumo.ignorados++;
        continue;
      }

      let cumpriu = false;
      if (reserva.enviarEmail) {
        if (await cumprirEmail(opcoes, p, reserva.reservaId, agora, resumo)) cumpriu = true;
      }
      if (reserva.criarAviso) {
        if (await cumprirAviso(opcoes, p, reserva.reservaId, agora, resumo)) cumpriu = true;
      }
      if (cumpriu) resumo.avisadosPorMarco[chaveDoMarco(p.marco)]++;
    } catch (err) {
      resumo.organizacoesQueFalharam++;
      logger.warn("[avisar-renovacao] organização falhou, rodada segue", {
        organization_id: p.organizationId,
        causa: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return resumo;
}
