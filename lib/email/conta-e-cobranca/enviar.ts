/**
 * O ENVIO dos e-mails de conta e de cobrança (CONTA-06, COB-02 a COB-09, IA-02): o lado de quem esvazia a fila.
 *
 * Os gatilhos só enfileiram (`fila.ts`, tabela `billing_emails_enviados`, migration 0952). O cron
 * `enviar-emails-de-conta` chama `enviarFilaDeEmails` a cada minuto: reserva um lote pequeno pela
 * `fn_billing_emails_reservar_lote` (claim atômico, `for update skip locked`: dois crons nunca pegam a mesma
 * linha), e para cada linha resolve os destinatários, monta o e-mail com os `dados` capturados no evento
 * (`montar.ts`) e envia pelo roteador (SMTP ou Resend).
 *
 * ─── O que acontece com cada linha ──────────────────────────────────────────
 *
 *   saiu para pelo menos um destinatário    -> `enviado` (a falha dos outros fica no `resultado`)
 *   ninguém recebe (sem admin, sem criador) -> `sem_destinatario`
 *   nada saiu                               -> volta a `pendente` com espera crescente (1, 5, 15, 60 e 240 min)
 *                                              e, na 6ª tentativa sem sucesso, `falhou`
 *   e-mail que não monta (dados inválidos)  -> `falhou` na hora (tentar de novo não muda nada)
 *   sem SMTP nem Resend configurados        -> o lote nem é reservado; nada queima tentativa
 *
 * Falha total não queima o aviso: a linha continua na fila e o cron seguinte tenta de novo. A tentativa é
 * contada na reserva, então um processo que morre no meio de um envio também gasta uma (a reserva dura 5 min e
 * depois a linha volta ao lote), e uma linha que nunca termina acaba em `falhou` em vez de girar para sempre.
 * O custo conhecido: se o processo morrer DEPOIS de o servidor aceitar o e-mail e ANTES de gravar `enviado`, o
 * e-mail pode sair de novo na tentativa seguinte (envio em dobro, raro, em vez de perdido).
 *
 * ─── Tempo ──────────────────────────────────────────────────────────────────
 *
 * A rodada tem orçamento interno (`ORCAMENTO_DA_RODADA_MS`, 40 s para o teto de 55 s do curl no scheduler): ao
 * estourar, as reservadas que ainda não começaram voltam à fila sem gastar tentativa. O orçamento também é
 * conferido ENTRE os destinatários de uma mesma linha, para que uma linha nunca passe da reserva (5 min) e
 * outra rodada a pegue de novo: se acabar no meio, grava-se o resultado parcial (quem já recebeu fica com
 * `ok` e a marca `ref`) e a linha volta à fila; a próxima tentativa pula quem já recebeu. A gravação do
 * desfecho só vale para a rodada dona da reserva (`tentativas` igual à que o claim devolveu): a gravação
 * atrasada de uma rodada antiga não sobrescreve a da que pegou a linha depois.
 *
 * ─── Cópia para o operador ──────────────────────────────────────────────────
 *
 * Com `copia_para_operador`, o mesmo e-mail vai também a quem opera a instalação, com uma faixa no topo do
 * cartão ("Cópia para o operador: enviado aos admins da {empresa}") e o assunto prefixado com "[Cópia] ".
 * Quem recebe: a configuração da instalação `EMAIL_DE_COPIA_DOS_AVISOS` (lida pelo resolvedor da tela de
 * credenciais) e, vazia ela, os administradores da plataforma (`platform_admins`, escopo full, não revogados).
 * A cópia sai SEMPRE em português, com a marca da INSTALAÇÃO (`marcaDaSaida(null)`: quem recebe é o operador,
 * não a organização cliente) e um envio por endereço: um destinatário nunca vê o endereço do outro, e uma
 * organização nunca recebe nem vê o que é de outra. A cópia só sai quando o e-mail saiu para alguém da
 * organização: assim a nova tentativa de uma falha total não repete a cópia a cada vez.
 * Conta banida (`banned_until` no futuro) ou apagada (`deleted_at`) no GoTrue não recebe nada, inclusive no
 * fallback dos administradores da plataforma.
 *
 * Endereço de e-mail só aparece mascarado (`j***@dominio.com`) em log e em `resultado`; `ultimo_erro` é um
 * código classificado, nunca o texto do servidor.
 *
 * `billing_emails_enviados` não está em `lib/database.types.ts`: mesmo tratamento das tabelas irmãs
 * (`as never`).
 */
import { createHash } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { idiomaDoDestinatario } from "@/lib/billing/assinatura/renovacao-textos";
import { marcaDaSaida, type MarcaDeSaida } from "@/lib/branding/saida";
import { emailConfigurado, sendEmail } from "@/lib/email/roteador";
import { env } from "@/lib/env";
import type { Idioma } from "@/lib/i18n/idiomas";
import { valorDaInstalacao } from "@/lib/instalacao/config";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

import { EmailNaoMontavel, montarEmailDeConta, type ContextoDoEmail, type MensagemMontada } from "./montar";

const TETO_DE_DESTINATARIOS = 10;
const TETO_DE_COPIAS = 5;
const PREFIXO_DA_COPIA = "[Cópia] ";
const EMAIL_VALIDO = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

/** Linhas reservadas por rodada. */
export const TAMANHO_DO_LOTE = 20;
/** Quanto a rodada trabalha antes de devolver o que sobrou (teto do curl no scheduler: 55 s). */
export const ORCAMENTO_DA_RODADA_MS = 40_000;
/** Quanto uma reserva vale antes de outra rodada poder pegar a linha de novo. */
export const RESERVA_EM_SEGUNDOS = 300;
export const MAXIMO_DE_TENTATIVAS = 6;
/** Espera depois da 1ª, 2ª, 3ª... tentativa que falhou, em minutos. A 6ª falha encerra em `falhou`. */
export const ESPERA_ENTRE_TENTATIVAS_EM_MINUTOS = [1, 5, 15, 60, 240] as const;

export interface DestinatarioDoEmail {
  email: string;
  /** `user_metadata.locale` da pessoa, quando ela escolheu. */
  locale: string | null;
  /** Primeiro nome, quando o cadastro tem. */
  nome: string | null;
}

/** A linha da fila que o claim devolve (só o que o envio usa). */
export interface LinhaDaFila {
  id: string;
  organization_id: string;
  email_id: string;
  chave: string;
  destino: "admins" | "criador";
  criador_user_id: string | null;
  copia_para_operador: boolean;
  dados: unknown;
  /** Já contando esta tentativa (o claim soma 1). */
  tentativas: number;
  /** O que uma tentativa anterior gravou (parcial): quem já recebeu não recebe de novo. */
  resultado?: unknown;
}

/** As bordas do módulo, injetáveis nos testes. O padrão é o de produção. */
export interface DepsDoEnvio {
  admin: SupabaseClient;
  sendEmail: typeof sendEmail;
  emailConfigurado: () => Promise<boolean>;
  /** `null` = a marca da INSTALAÇÃO, sem organização (a cópia do operador usa esta). */
  marcaDaSaida: (organizationId: string | null) => Promise<MarcaDeSaida>;
  appUrl: string;
  /** O valor em vigor de `EMAIL_DE_COPIA_DOS_AVISOS` (tela, depois ambiente), ou `null`. */
  configuracaoDaCopia: () => Promise<string | null>;
  agora?: () => Date;
}

export interface OpcoesDaFila {
  limite?: number;
  orcamentoMs?: number;
}

export interface ResumoDaFila {
  /** Linhas que o claim devolveu. */
  reservados: number;
  /** Saíram para pelo menos um destinatário. */
  enviados: number;
  /** Não saiu nada; voltaram à fila para outra tentativa. */
  repetir: number;
  /** Esgotaram as tentativas, ou não montam: `falhou`. */
  falhados: number;
  semDestinatario: number;
  /** Reservadas e devolvidas sem gastar tentativa (orçamento da rodada acabou). */
  devolvidos: number;
  /** Sem SMTP nem Resend: nada foi reservado. */
  naoConfigurado: boolean;
}

function depsReais(): DepsDoEnvio {
  return {
    admin: createAdminClient(),
    sendEmail,
    emailConfigurado,
    marcaDaSaida,
    appUrl: env.NEXT_PUBLIC_APP_URL.replace(/\/$/, ""),
    configuracaoDaCopia: async () => (await valorDaInstalacao("EMAIL_DE_COPIA_DOS_AVISOS")).valor,
  };
}

/** O motivo de uma exceção para o log, sem endereço de e-mail (a mensagem do SMTP costuma citar o destino). */
function motivoSemEmail(erro: unknown): string {
  if (!(erro instanceof Error)) return "erro";
  return erro.message.replace(/[^\s@<>,;"']+@[^\s@<>,;"']+/g, "***").slice(0, 120);
}

/** `joao@empresa.com` vira `j***@empresa.com`: serve para log e para o rastro, nunca para enviar. */
export function mascararEmail(email: string): string {
  const [local = "", dominio = ""] = email.split("@");
  return `${local.slice(0, 1)}***@${dominio}`;
}

function primeiroNome(meta: unknown): string | null {
  const m = (meta ?? {}) as { full_name?: unknown; name?: unknown };
  const bruto = typeof m.full_name === "string" ? m.full_name : typeof m.name === "string" ? m.name : "";
  const nome = bruto.trim().split(/\s+/)[0] ?? "";
  return nome || null;
}

async function destinatarioDoUsuario(
  admin: SupabaseClient,
  userId: string,
): Promise<DestinatarioDoEmail | null> {
  const { data } = await admin.auth.admin.getUserById(userId);
  const email = data?.user?.email?.trim();
  if (!email) return null;
  // Endereço que a pessoa nunca confirmou não recebe e-mail (pode ser de outra pessoa): admins, criador e
  // administradores da plataforma da cópia.
  if (!(data?.user as { email_confirmed_at?: string | null } | undefined)?.email_confirmed_at) return null;
  // Conta banida (`banned_until` no futuro) ou apagada (`deleted_at`) não recebe e-mail: vale para admins da
  // organização, criador do pedido e administradores da plataforma da cópia.
  const conta = data?.user as { banned_until?: string | null; deleted_at?: string | null } | undefined;
  if (conta?.deleted_at) return null;
  if (conta?.banned_until) {
    const ate = Date.parse(conta.banned_until);
    if (Number.isNaN(ate) || ate > Date.now()) return null;
  }
  const meta = data?.user?.user_metadata as { locale?: unknown } | undefined;
  return {
    email,
    locale: typeof meta?.locale === "string" ? meta.locale : null,
    nome: primeiroNome(data?.user?.user_metadata),
  };
}

/**
 * Os administradores ativos da organização, com endereço (até 10). O projeto não tem papel `owner`
 * (`user_organizations.role` é viewer, agent, manager ou admin; quem cria a organização entra como admin) e
 * "ativo" é `revoked_at` nulo, a mesma régua de `fn_user_role_in_org`. O endereço mora no GoTrue, não numa
 * tabela nossa. Lança quando o banco recusa: quem chama decide (o envio trata como falha).
 */
export async function adminsDaOrganizacao(
  organizationId: string,
  admin: SupabaseClient = createAdminClient(),
): Promise<DestinatarioDoEmail[]> {
  const { data, error } = await admin
    .from("user_organizations")
    .select("user_id")
    .eq("organization_id", organizationId)
    .eq("role", "admin")
    .is("revoked_at", null)
    .order("created_at", { ascending: true })
    .limit(TETO_DE_DESTINATARIOS);
  if (error) throw new Error(`user_organizations: ${error.message}`);

  const vistos = new Set<string>();
  const lista: DestinatarioDoEmail[] = [];
  for (const linha of (data as { user_id: string }[] | null) ?? []) {
    const d = await destinatarioDoUsuario(admin, linha.user_id);
    if (!d || vistos.has(d.email.toLowerCase())) continue;
    vistos.add(d.email.toLowerCase());
    lista.push(d);
  }
  return lista;
}

/**
 * Quem recebe a cópia: a configuração `EMAIL_DE_COPIA_DOS_AVISOS` (um ou mais endereços separados por
 * vírgula) e, vazia ou sem nenhum endereço válido, os administradores da plataforma.
 */
export async function destinatariosDaCopiaDoOperador(deps: DepsDoEnvio): Promise<string[]> {
  const configurado = await deps.configuracaoDaCopia();
  const lista = (configurado ?? "")
    .split(/[,;\s]+/)
    .map((e) => e.trim())
    .filter((e) => EMAIL_VALIDO.test(e));
  if (lista.length > 0) return unicos(lista).slice(0, TETO_DE_COPIAS);

  const { data, error } = await deps.admin
    .from("platform_admins")
    .select("user_id")
    .eq("scope", "full")
    .is("revoked_at", null)
    .limit(TETO_DE_COPIAS);
  if (error) throw new Error(`platform_admins: ${error.message}`);
  const emails: string[] = [];
  for (const linha of (data as { user_id: string }[] | null) ?? []) {
    const d = await destinatarioDoUsuario(deps.admin, linha.user_id);
    if (d) emails.push(d.email);
  }
  return unicos(emails);
}

function unicos(emails: string[]): string[] {
  const vistos = new Set<string>();
  const saida: string[] = [];
  for (const e of emails) {
    const k = e.toLowerCase();
    if (vistos.has(k)) continue;
    vistos.add(k);
    saida.push(e);
  }
  return saida;
}

interface LinhaDeEnvio {
  para: string;
  /** Marca estável do endereço nesta linha da fila (hash, nunca o endereço): o `para` mascarado pode colidir. */
  ref: string;
  tipo: "cliente" | "operador";
  ok: boolean;
  via?: string;
  motivo?: string;
}

/** A marca de um endereço nesta linha da fila: serve para reconhecer quem já recebeu, sem guardar o endereço. */
function refDoEndereco(linhaId: string, email: string): string {
  return createHash("sha256").update(`${linhaId}:${email.trim().toLowerCase()}`).digest("hex").slice(0, 16);
}

/** Quem já recebeu numa tentativa anterior desta linha (`resultado.destinatarios` com `ok` e `ref`). */
function envioAnterior(resultado: unknown): LinhaDeEnvio[] {
  const lista = (resultado as { destinatarios?: unknown } | null | undefined)?.destinatarios;
  if (!Array.isArray(lista)) return [];
  return lista.filter(
    (l): l is LinhaDeEnvio =>
      !!l &&
      typeof l === "object" &&
      (l as LinhaDeEnvio).ok === true &&
      typeof (l as LinhaDeEnvio).ref === "string" &&
      ((l as LinhaDeEnvio).tipo === "cliente" || (l as LinhaDeEnvio).tipo === "operador"),
  );
}

/** O código classificado de uma falha, no formato que o banco aceita em `ultimo_erro`. */
function codigoDoErro(motivo: string | undefined): string {
  const limpo = (motivo ?? "").toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 60);
  return limpo || "envio_falhou";
}

async function enviarUm(
  deps: DepsDoEnvio,
  linha: LinhaDaFila,
  marca: MarcaDeSaida,
  mensagem: MensagemMontada,
  para: string,
  tipo: LinhaDeEnvio["tipo"],
): Promise<LinhaDeEnvio> {
  const assunto = tipo === "operador" ? `${PREFIXO_DA_COPIA}${mensagem.subject}` : mensagem.subject;
  try {
    const r = await deps.sendEmail({
      to: para,
      subject: assunto,
      html: mensagem.html,
      text: mensagem.text,
      fromName: marca.nome,
      tags: [
        { name: "tipo", value: linha.email_id },
        ...(tipo === "operador" ? [{ name: "copia", value: "operador" }] : []),
      ],
    });
    if (!r.ok) {
      logger.warn("[email-de-conta] e-mail não saiu", {
        organization_id: linha.organization_id,
        email_id: linha.email_id,
        para: mascararEmail(para),
        tipo,
        motivo: r.error,
        via: r.via,
      });
    }
    return {
      para: mascararEmail(para),
      ref: refDoEndereco(linha.id, para),
      tipo,
      ok: r.ok,
      via: r.via,
      ...(r.ok ? {} : { motivo: r.error ?? "send_failed" }),
    };
  } catch (erro) {
    logger.warn("[email-de-conta] envio lançou", {
      organization_id: linha.organization_id,
      email_id: linha.email_id,
      para: mascararEmail(para),
      tipo,
      motivo: motivoSemEmail(erro),
    });
    return { para: mascararEmail(para), ref: refDoEndereco(linha.id, para), tipo, ok: false, motivo: "excecao" };
  }
}

type DesfechoDaLinha =
  | { tipo: "enviado"; resultado: Record<string, unknown> }
  | { tipo: "sem_destinatario" }
  | { tipo: "nao_configurado" }
  /** O orçamento da rodada acabou no meio da linha: grava quem já recebeu e devolve a linha à fila. */
  | { tipo: "parcial"; resultado: Record<string, unknown>; progresso: boolean }
  /** `definitiva`: tentar de novo não muda nada (o e-mail não monta). */
  | { tipo: "falha"; erro: string; definitiva: boolean; resultado: Record<string, unknown> };

function resultadoDe(linhas: LinhaDeEnvio[]): Record<string, unknown> {
  return {
    enviados: linhas.filter((l) => l.tipo === "cliente" && l.ok).length,
    falhas: linhas.filter((l) => l.tipo === "cliente" && !l.ok).length,
    destinatarios: linhas,
  };
}

interface DadosDaOrganizacao {
  empresa: string;
  locale: string | null;
}

async function dadosDaOrganizacao(
  deps: DepsDoEnvio,
  organizationId: string,
  cache: Map<string, DadosDaOrganizacao | null>,
): Promise<DadosDaOrganizacao | null> {
  if (cache.has(organizationId)) return cache.get(organizationId) ?? null;
  const { data, error } = await deps.admin
    .from("organizations")
    .select("display_name, locale")
    .eq("id", organizationId)
    .maybeSingle();
  if (error) throw new Error(`organizations: ${error.message}`);
  const org = data as { display_name: string | null; locale: string | null } | null;
  const lido = org ? { empresa: (org.display_name ?? "").trim() || "sua empresa", locale: org.locale ?? null } : null;
  cache.set(organizationId, lido);
  return lido;
}

/** O usuário tem vínculo ativo (`revoked_at` nulo) com a organização. Lança quando o banco recusa. */
async function vinculoAtivo(admin: SupabaseClient, userId: string, organizationId: string): Promise<boolean> {
  const { data, error } = await admin
    .from("user_organizations")
    .select("user_id")
    .eq("user_id", userId)
    .eq("organization_id", organizationId)
    .is("revoked_at", null)
    .limit(1);
  if (error) throw new Error(`user_organizations: ${error.message}`);
  return ((data as unknown[] | null) ?? []).length > 0;
}

async function processarLinha(
  deps: DepsDoEnvio,
  linha: LinhaDaFila,
  cache: Map<string, DadosDaOrganizacao | null>,
  /** `true` quando o orçamento da rodada acabou (conferido antes de cada envio, menos o primeiro da linha). */
  orcamentoAcabou: () => boolean,
): Promise<DesfechoDaLinha> {
  // 1. A organização e quem recebe (o endereço é resolvido AGORA, não na hora do fato).
  const org = await dadosDaOrganizacao(deps, linha.organization_id, cache);
  if (!org) {
    logger.warn("[email-de-conta] organização não encontrada", {
      organization_id: linha.organization_id,
      email_id: linha.email_id,
    });
    return { tipo: "falha", erro: "organizacao", definitiva: true, resultado: {} };
  }

  let destinatarios: DestinatarioDoEmail[];
  if (linha.destino === "criador") {
    // O criador só recebe enquanto tiver vínculo ativo com a organização do fato: sem vínculo (nunca teve, ou foi
    // revogado), o e-mail dele não é endereço desta organização.
    const criador = linha.criador_user_id;
    const vinculado = criador ? await vinculoAtivo(deps.admin, criador, linha.organization_id) : false;
    const d = criador && vinculado ? await destinatarioDoUsuario(deps.admin, criador) : null;
    destinatarios = d ? [d] : [];
  } else {
    destinatarios = await adminsDaOrganizacao(linha.organization_id, deps.admin);
  }
  if (destinatarios.length === 0) {
    logger.info("[email-de-conta] sem destinatário", {
      organization_id: linha.organization_id,
      email_id: linha.email_id,
    });
    return { tipo: "sem_destinatario" };
  }

  // 2. Monta e envia, um por destinatário, no idioma dele.
  const marca = await deps.marcaDaSaida(linha.organization_id);
  const contexto = (
    idioma: Idioma,
    nome: string | null,
    faixa?: string,
    marcaDoContexto: MarcaDeSaida = marca,
  ): ContextoDoEmail => ({
    organizationId: linha.organization_id,
    empresa: org.empresa,
    idioma,
    marca: marcaDoContexto,
    appUrl: deps.appUrl,
    nome,
    ...(faixa ? { faixaDoOperador: faixa } : {}),
    base: (url) => ({
      marca: marcaDoContexto,
      idioma,
      empresa: org.empresa,
      url,
      ...(faixa ? { faixaDoOperador: faixa } : {}),
    }),
  });

  // Quem já recebeu numa tentativa anterior (rodada que parou no meio) fica como está e não recebe de novo.
  const anteriores = envioAnterior(linha.resultado);
  const jaRecebeu = new Set(anteriores.map((l) => l.ref));
  const linhas: LinhaDeEnvio[] = [...anteriores];
  let novosOk = 0;
  let tentouAgora = false;
  const parcial = (): DesfechoDaLinha => ({ tipo: "parcial", resultado: resultadoDe(linhas), progresso: novosOk > 0 });

  for (const d of destinatarios) {
    if (jaRecebeu.has(refDoEndereco(linha.id, d.email))) continue;
    if (tentouAgora && orcamentoAcabou()) return parcial();
    tentouAgora = true;
    const idioma = idiomaDoDestinatario(d.locale, org.locale);
    let mensagem: MensagemMontada;
    try {
      mensagem = montarEmailDeConta(linha.email_id, linha.dados, contexto(idioma, d.nome));
    } catch (erro) {
      logger.error("[email-de-conta] o e-mail não montou", {
        organization_id: linha.organization_id,
        email_id: linha.email_id,
        motivo: motivoSemEmail(erro),
      });
      // Código desconhecido ou `dados` fora do formato não mudam com o tempo: sem nova tentativa.
      if (erro instanceof EmailNaoMontavel) {
        return {
          tipo: "falha",
          erro: "montagem",
          definitiva: true,
          resultado: resultadoDe([
            { para: mascararEmail(d.email), ref: refDoEndereco(linha.id, d.email), tipo: "cliente", ok: false, motivo: "montagem" },
          ]),
        };
      }
      linhas.push({ para: mascararEmail(d.email), ref: refDoEndereco(linha.id, d.email), tipo: "cliente", ok: false, motivo: "montagem" });
      continue;
    }
    const enviado = await enviarUm(deps, linha, marca, mensagem, d.email, "cliente");
    if (enviado.ok) novosOk++;
    linhas.push(enviado);
  }

  const doCliente = linhas.filter((l) => l.tipo === "cliente");
  const saiu = doCliente.some((l) => l.ok);
  if (!saiu) {
    // Sem caminho de entrega no meio da rodada (configuração removida): não é falha do e-mail.
    if (doCliente.every((l) => l.motivo === "not_configured")) return { tipo: "nao_configurado" };
    const primeira = doCliente.find((l) => !l.ok);
    return {
      tipo: "falha",
      erro: codigoDoErro(primeira?.motivo),
      definitiva: false,
      resultado: resultadoDe(linhas),
    };
  }

  // 3. A cópia do operador: em português, um envio por endereço, sem repetir quem já recebeu o original.
  if (linha.copia_para_operador) {
    try {
      const doOriginal = new Set(destinatarios.map((d) => d.email.toLowerCase()));
      const copia = (await destinatariosDaCopiaDoOperador(deps)).filter((e) => !doOriginal.has(e.toLowerCase()));
      const faixa = `Cópia para o operador: enviado aos admins da ${org.empresa}`;
      // A cópia sai com a marca da INSTALAÇÃO (quem opera), nunca com a da organização cliente.
      const marcaDoOperador = copia.length > 0 ? await deps.marcaDaSaida(null) : marca;
      for (const para of copia) {
        if (jaRecebeu.has(refDoEndereco(linha.id, para))) continue;
        if (tentouAgora && orcamentoAcabou()) return parcial();
        tentouAgora = true;
        let mensagem: MensagemMontada;
        try {
          mensagem = montarEmailDeConta(
            linha.email_id,
            linha.dados,
            contexto("pt-BR", destinatarios[0]?.nome ?? null, faixa, marcaDoOperador),
          );
        } catch {
          linhas.push({ para: mascararEmail(para), ref: refDoEndereco(linha.id, para), tipo: "operador", ok: false, motivo: "montagem" });
          continue;
        }
        const enviadoAoOperador = await enviarUm(deps, linha, marcaDoOperador, mensagem, para, "operador");
        if (enviadoAoOperador.ok) novosOk++;
        linhas.push(enviadoAoOperador);
      }
    } catch (erro) {
      logger.warn("[email-de-conta] a cópia do operador não saiu", {
        organization_id: linha.organization_id,
        email_id: linha.email_id,
        motivo: motivoSemEmail(erro),
      });
    }
  }

  return { tipo: "enviado", resultado: resultadoDe(linhas) };
}

/**
 * Grava o desfecho da linha reservada, só se ainda for desta rodada: `status = enviando` e `tentativas` igual à
 * que o claim devolveu (cada reserva soma 1, então é a marca de dono). A gravação atrasada de uma rodada
 * antiga, depois de outra ter pegado a linha, não casa com nada e não sobrescreve. Uma nova tentativa se o
 * banco falhar.
 */
async function gravar(deps: DepsDoEnvio, linha: LinhaDaFila, patch: Record<string, unknown>): Promise<boolean> {
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    const { error } = await deps.admin
      .from("billing_emails_enviados" as never)
      .update(patch as never)
      .eq("id", linha.id)
      .eq("status", "enviando")
      .eq("tentativas", linha.tentativas);
    if (!error) return true;
    logger.warn("[email-de-conta] não deu para gravar o desfecho", {
      organization_id: linha.organization_id,
      email_id: linha.email_id,
      codigo: (error as { code?: string }).code,
    });
  }
  return false;
}

/** A espera antes da próxima tentativa, depois de a `tentativa`-ésima (1 a 5) falhar. */
export function esperaEmMinutos(tentativa: number): number {
  const i = Math.min(Math.max(tentativa, 1), ESPERA_ENTRE_TENTATIVAS_EM_MINUTOS.length) - 1;
  return ESPERA_ENTRE_TENTATIVAS_EM_MINUTOS[i] ?? 240;
}

/**
 * Esvazia um lote da fila. Lança só quando o claim falha (banco fora do ar): quem chama (a rota do cron)
 * responde erro com frase fixa. O que acontece com cada linha está no cabeçalho do arquivo.
 */
export async function enviarFilaDeEmails(
  deps: DepsDoEnvio = depsReais(),
  opcoes: OpcoesDaFila = {},
): Promise<ResumoDaFila> {
  const agora = deps.agora ?? (() => new Date());
  const limite = opcoes.limite ?? TAMANHO_DO_LOTE;
  const orcamentoMs = opcoes.orcamentoMs ?? ORCAMENTO_DA_RODADA_MS;
  const resumo: ResumoDaFila = {
    reservados: 0,
    enviados: 0,
    repetir: 0,
    falhados: 0,
    semDestinatario: 0,
    devolvidos: 0,
    naoConfigurado: false,
  };

  // Sem caminho de entrega não há o que fazer: a fila espera, nenhuma tentativa é gasta.
  if (!(await deps.emailConfigurado())) {
    resumo.naoConfigurado = true;
    return resumo;
  }

  const inicio = agora().getTime();
  const { data, error } = await deps.admin.rpc("fn_billing_emails_reservar_lote" as never, {
    p_limite: limite,
    p_reserva_segundos: RESERVA_EM_SEGUNDOS,
    p_max_tentativas: MAXIMO_DE_TENTATIVAS,
  } as never);
  if (error) throw new Error(`fn_billing_emails_reservar_lote: ${(error as { message: string }).message}`);
  const reservadas = (data as LinhaDaFila[] | null) ?? [];
  resumo.reservados = reservadas.length;

  const cache = new Map<string, DadosDaOrganizacao | null>();
  for (const linha of reservadas) {
    // Orçamento esgotado: o que não começou volta à fila sem gastar a tentativa que o claim contou.
    if (agora().getTime() - inicio > orcamentoMs) {
      await gravar(deps, linha, {
        status: "pendente",
        tentativas: Math.max(0, linha.tentativas - 1),
        proxima_tentativa_em: agora().toISOString(),
      });
      resumo.devolvidos++;
      continue;
    }

    let desfecho: DesfechoDaLinha;
    try {
      desfecho = await processarLinha(deps, linha, cache, () => agora().getTime() - inicio > orcamentoMs);
    } catch (erro) {
      logger.warn("[email-de-conta] a linha falhou antes de enviar", {
        organization_id: linha.organization_id,
        email_id: linha.email_id,
        motivo: motivoSemEmail(erro),
      });
      desfecho = { tipo: "falha", erro: "excecao", definitiva: false, resultado: {} };
    }

    const agoraIso = agora().toISOString();
    if (desfecho.tipo === "enviado") {
      await gravar(deps, linha, {
        status: "enviado",
        enviado_em: agoraIso,
        ultimo_erro: null,
        resultado: desfecho.resultado,
      });
      resumo.enviados++;
    } else if (desfecho.tipo === "parcial") {
      // Parou no meio: quem já recebeu fica registrado e a linha volta já para a vez. Se saiu e-mail novo nesta
      // rodada, a tentativa não é gasta (houve progresso); sem progresso ela fica gasta, para não girar sem fim.
      await gravar(deps, linha, {
        status: "pendente",
        tentativas: desfecho.progresso ? Math.max(0, linha.tentativas - 1) : linha.tentativas,
        proxima_tentativa_em: agoraIso,
        resultado: desfecho.resultado,
      });
      resumo.devolvidos++;
    } else if (desfecho.tipo === "sem_destinatario") {
      await gravar(deps, linha, { status: "sem_destinatario", ultimo_erro: null });
      resumo.semDestinatario++;
    } else if (desfecho.tipo === "nao_configurado") {
      await gravar(deps, linha, {
        status: "pendente",
        tentativas: Math.max(0, linha.tentativas - 1),
        proxima_tentativa_em: new Date(agora().getTime() + 60_000).toISOString(),
        ultimo_erro: "nao_configurado",
      });
      resumo.naoConfigurado = true;
      resumo.devolvidos++;
    } else if (desfecho.definitiva || linha.tentativas >= MAXIMO_DE_TENTATIVAS) {
      await gravar(deps, linha, {
        status: "falhou",
        ultimo_erro: desfecho.erro,
        resultado: desfecho.resultado,
      });
      resumo.falhados++;
    } else {
      await gravar(deps, linha, {
        status: "pendente",
        ultimo_erro: desfecho.erro,
        resultado: desfecho.resultado,
        proxima_tentativa_em: new Date(agora().getTime() + esperaEmMinutos(linha.tentativas) * 60_000).toISOString(),
      });
      resumo.repetir++;
    }
  }

  return resumo;
}
