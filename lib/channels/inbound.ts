import { ingestSocialInbound, socialPayloadBelongsToSession } from "./social/ingest";
import { CHANNEL_PROVIDER_SOCIAL } from "./capabilities";
/**
 * Entrada de webhook, do lado de dentro do seam.
 *
 * A rota não pode saber QUAL canal é — o invariante 1 da doutrina proíbe, e o
 * `lint:channels` reprovou a primeira versão desta rota exatamente por isso,
 * que é a catraca funcionando. Então a rota entrega o que sabe (a sessão, o
 * corpo cru, o header de assinatura) e recebe um desfecho; toda a decisão
 * específica de canal mora aqui.
 *
 * Um canal seguinte entra com um `case` neste arquivo e zero linhas na rota.
 *
 * ─── Por que a assinatura é verificada AQUI, e não na rota ──────────────────
 *
 * Porque o esquema é do canal: header, algoritmo e formato mudam por provider
 * (um assina SHA-512 com um nome de header, outro SHA-256 com outro). Uma rota
 * que verificasse teria que perguntar de quem é o payload — o `if (provider ===
 * ...)` que a doutrina existe para impedir.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { CHANNEL_PROVIDER_DATAFY, CHANNEL_PROVIDER_UAZAPI, CHANNEL_PROVIDER_ZERNIO } from "./capabilities";
import { canalGraphParceiroLigado } from "./graph-parceiro/credentials";
import { graphPartnerRefsDaSessao } from "./graph-parceiro/session";
import {
  HEADER_ASSINATURA,
  HEADER_TIMESTAMP,
  verifyGraphPartnerSignature,
} from "./graph-parceiro/webhook";
import { sincronizarSaudeDaConexao } from "./health";
import { lerEnvelopeMeta } from "./meta/envelope";
import { ingestMetaEcho, ingestMetaInbound } from "./meta/ingest";
import { parseMetaWebhook } from "./meta/webhook";
import { samePhone } from "./phone-variants";
import { lerConexaoUazapi, parseUazapiConexao } from "./uazapi/conexao-evento";
import { lerEnvelopeUazapi } from "./uazapi/envelope";
import { ingestUazapiMensagem } from "./uazapi/ingest";
import { chaveDoEventoUazapi, eventoUazapiRepetido, marcarEventoUazapiVisto } from "./uazapi/replay-guard";
import { aplicarStatusUazapi, lerAtualizacaoUazapi, parseUazapiAtualizacao } from "./uazapi/status";
import { parseUazapiMensagem, tokenDoEventoConfere } from "./uazapi/webhook";
import {
  atualizarEspelhoDoTemplate,
  avisoDoEvento,
  registrarAviso,
  saudeDoEvento,
} from "./zernio/avisos";
import { aplicarEdicaoZernio, ingestZernioInbound } from "./zernio/ingest";
import { lerEnvelopeZernio } from "./zernio/envelope";
import { parseZernioEdicao, verifyZernioSignature } from "./zernio/webhook";
import type { ChannelProvider } from "./types";

/** Curto demais para ser segredo — placeholder ou lixo de decrypt. */
const MIN_SECRET_LEN = 16;

export interface InboundWebhookInput {
  session: {
    id: string;
    organization_id: string;
    provider: string;
    /** Como o operador chama esta conexão. Entra no título do aviso: com dois
     *  números ligados, "WhatsApp fora do ar" não diz QUAL. */
    display_name?: string | null;
    phone_number?: string | null;
    /** ACHADO 3: o identificador da sessão NO PROVIDER (`resolveSessionRef`
     *  da rota), genérico entre canais de propósito. Para a UAZAPI é o id da
     *  instância. Sem ele, um evento de OUTRA instância da mesma organização
     *  não tem contra o que ser conferido, e é essa a lacuna que
     *  `inboundPayloadBelongsToSession` fecha. */
    session_ref?: string | null;
  };
  rawBody: string;
  /** Todos os headers da requisição — cada canal lê o SEU. */
  headers: Headers;
  /** Segredo já decifrado pela rota, ou null quando não foi possível. */
  secret: string | null;
}

export type InboundWebhookOutcome =
  | { ok: true; body: Record<string, unknown> }
  | {
      ok: false;
      /**
       * `contrato_violado` é distinto de `invalid_json` de propósito: um diz
       * que o corpo não é JSON, o outro que é JSON com um campo do tipo errado.
       * Quem investiga procura em lugares diferentes, e o segundo significa que
       * o fio mudou — a única causa possível num payload que passou pelo HMAC.
       */
      code: "unauthorized" | "provider_mismatch" | "invalid_json" | "contrato_violado";
      message: string;
    };

/**
 * Este canal sabe receber webhook? Perguntado pela rota ANTES de qualquer
 * trabalho — e respondido sem nomear provider do lado de fora.
 */
export function acceptsInboundWebhook(provider: string): boolean {
  // O canal Datafy é opcional da instalação: desligado, a entrada dele não
  // existe — nem para quem tem o token de uma sessão gravada antes.
  if (provider === CHANNEL_PROVIDER_DATAFY) return canalGraphParceiroLigado();
  return (
    provider === CHANNEL_PROVIDER_ZERNIO ||
    provider === CHANNEL_PROVIDER_SOCIAL ||
    provider === CHANNEL_PROVIDER_UAZAPI
  );
}

/**
 * ACHADO 4: antes, este portão devolvia `true` para a UAZAPI sem olhar o
 * corpo, e a conferência real ficava presa dentro de `uazapiInbound`, que só
 * roda DEPOIS do arquivo e do desvio por "outra conta". Isso deixava o portão
 * decorativo para este canal: qualquer corpo passava, e quem barrava era um
 * degrau mais abaixo na cadeia.
 *
 * A UAZAPI não assina o corpo, mas repete o token da instância no evento de
 * MENSAGEM (medido: ausente em `messages_update`, ver `uazapi/status.ts`).
 * Comparar esse token aqui é o que o portão TEM como prova de posse sem
 * precisar da sessão inteira, já que ele só recebe corpo cru e segredo. Um
 * evento `messages` sem token certo já sai com 401 e nunca alcança o seam.
 *
 * Eventos que comprovadamente não repetem token (`messages_update`,
 * `connection`) passam por aqui: a prova deles é o número DONO, e essa
 * comparação depende do telefone da conexão, dado que este portão não
 * recebe. Fica com a segunda camada, dentro de `uazapiInbound`.
 */
function verificaTokenUazapiNoPortao(raw: string, secret: string | null): boolean {
  const leitura = lerEnvelopeUazapi(raw);
  // Corpo malformado não recusa AQUI: `invalid_json`/`contrato_violado` são
  // desfechos com motivo próprio, montados pelo seam. Recusar cedo trocaria os
  // dois por um `bad_signature` genérico que não ajuda quem investigar.
  if (!leitura.ok) return true;
  if ((leitura.envelope.EventType ?? "") !== "messages") return true;
  return tokenDoEventoConfere(leitura.envelope.token, secret);
}

/**
 * Authenticate before archiving raw payloads. The handler repeats this guard for non-HTTP callers.
 *
 * ─── D-043: "exigir assinatura no webhook" NÃO se aplica à UAZAPI ───────────
 *
 * A opção de `/admin/sistema` (`platform_settings.exigir_assinatura_no_webhook`)
 * decide se o servidor de canal precisa ASSINAR o corpo com um segredo
 * criptográfico. Isso vale para quem assina de fato: WAHA
 * (`lib/waha/webhook-auth.ts`) e Zernio (linha de baixo, incondicional). A
 * UAZAPI não assina o corpo, e nunca assinou: sua proteção estrutural é outra
 *, o token secreto sorteado por conexão (que já filtra quem chega até esta
 * função) mais `verificaTokenUazapiNoPortao`, que compara o TOKEN repetido no
 * corpo do evento `messages`, e a conferência de dono em `uazapiInbound`.
 *
 * Uma versão anterior fazia a opção ligada RECUSAR a UAZAPI inteira, por não
 * ter assinatura para conferir. Na prática isso derrubava o canal de
 * WhatsApp assim que o admin ligasse a opção pensando em endurecer o WAHA ou
 * a Zernio, sem nenhum ganho de segurança, porque a UAZAPI já não confiava
 * em assinatura nenhuma. Decisão: a opção é decorativa para este canal, e a
 * verificação é sempre a mesma, ligada ou desligada.
 */
export function verifyInboundWebhookSignature(provider: string, raw: string, headers: Headers, secret: string | null): boolean {
  if (provider === CHANNEL_PROVIDER_UAZAPI) {
    return verificaTokenUazapiNoPortao(raw, secret);
  }
  if (!acceptsInboundWebhook(provider) || !secret || secret.length < MIN_SECRET_LEN) return false;
  // Cada canal assina do seu jeito; o esquema do Datafy está em `graph-parceiro/webhook`.
  if (provider === CHANNEL_PROVIDER_DATAFY) {
    return verifyGraphPartnerSignature(raw, headers.get(HEADER_ASSINATURA), headers.get(HEADER_TIMESTAMP), secret);
  }
  return verifyZernioSignature(raw, headers.get("x-zernio-signature"), secret);
}

/**
 * ACHADO 3: a UAZAPI deixa o operador colar a MESMA url de webhook em duas
 * instâncias do painel do servidor, engano de configuração, não ataque. Sem
 * conferir, o evento da instância B era gravado na sessão da instância A: um
 * contato de uma conta aparecendo, em silêncio, na conversa da outra.
 *
 * A comparação é pelo `owner` (o número dono da instância) contra o telefone
 * da conexão, na mesma régua de 8 dígitos do resto do arquivo. Só recusa
 * quando o evento TRAZ o campo e ele diverge: `connection` não tem esquema
 * publicado (ver `uazapi/conexao-evento.ts`) e pode chegar sem ele, e "não dá
 * para comparar" não é o mesmo que "é de outra instância".
 *
 * NÃO se compara o `instanceName` do evento contra o `session_ref`. Parece o
 * casamento óbvio e é armadilha: `session_ref` para este canal é o
 * `uazapi_instance_id`, que guarda o `instance.id` do servidor (opaco, ver
 * `lib/channels/session-ref.ts`), enquanto `instanceName` é o NOME que o
 * operador digita no painel (`uazapi/conexao.ts` separa os dois ao ler
 * `/instance/status`). Como os dois quase nunca são iguais, a comparação
 * recusaria TODO evento legítimo, e a rota responde 200 a um evento recusado:
 * a UAZAPI não reentrega, e o canal pararia de receber mensagem em silêncio.
 * Comparar por nome só volta a existir quando houver coluna com o nome da
 * instância; até lá o dono é a prova que temos.
 */
function uazapiPayloadBelongsToSession(input: InboundWebhookInput): boolean {
  const leitura = lerEnvelopeUazapi(input.rawBody);
  if (!leitura.ok) return true;
  const envelope = leitura.envelope;

  const donoDoEvento = (envelope.owner ?? "").replace(/\D/g, "").slice(-8);
  const donoDaSessao = (input.session.phone_number ?? "").replace(/\D/g, "").slice(-8);
  if (donoDoEvento && donoDaSessao && donoDoEvento !== donoDaSessao) {
    return false;
  }

  return true;
}

/**
 * O EVENTO É DESTA CONEXÃO?
 *
 * ─── O defeito, medido numa instalação real (23/09/2026) ─────────────────────
 *
 * Esta guarda existia só para o canal SOCIAL. Para o WhatsApp pelo provedor
 * intermediado ela devolvia `true` sem olhar nada — e o webhook do provedor NÃO
 * é por número: é por ESPAÇO DE TRABALHO. Um webhook recebe os eventos de TODAS
 * as contas daquela chave. Na instalação medida eram dez contas no mesmo espaço
 * (dois WhatsApp, e Facebook/Instagram/Meta Ads de três negócios diferentes).
 *
 * Resultado: a caixa de entrada de um número recebeu 33 mensagens de
 * boas-vindas de OUTRO negócio, enviadas por OUTRO número do mesmo espaço. O
 * dono viu na conversa clientes que não eram dele, e nada na tela explicava.
 *
 * O parser já lia a conta (`ZernioWebhookEvent.accountId`, com o comentário
 * "casa com channel_sessions.zernio_account_id") — só ninguém comparava.
 *
 * ─── Evento SEM conta: depende de quem é o evento ───────────────────────────
 *
 * Nem todo evento do provedor carrega a conta: os de número
 * (`whatsapp.number.*`) trazem só o objeto `number`, e recusá-los por isso
 * cegaria o vigia de canal. Esses passam aqui e são conferidos pelo NÚMERO em
 * `zernioInbound`.
 *
 * Já `message.*` e `whatsapp.template.*` trazem a conta SEMPRE, pela
 * documentação do provedor. Nesses, a ausência é anomalia, e anomalia não
 * entra: sem a conta não há como dizer de qual número o evento é, e ingerir
 * seria escolher por palpite a caixa de entrada.
 *
 * ─── UAZAPI e Datafy ficam de fora desta guarda ────────────────────────────
 *
 * A UAZAPI tem conferência própria (`uazapiPayloadBelongsToSession`, pelo
 * telefone dono da instância) porque o corpo dela não carrega conta nenhuma ,
 * só `owner`. O Datafy confere a conta e o número DENTRO de `datafyInbound`
 * (mesma régua do canal oficial, por evento), porque um webhook único pode
 * trazer VÁRIOS eventos de contas diferentes no mesmo corpo, uma guarda que
 * olhasse só o topo do payload não daria conta de filtrar por evento.
 */
export async function inboundPayloadBelongsToSession(admin: SupabaseClient, input: InboundWebhookInput): Promise<boolean> {
  if (input.session.provider === CHANNEL_PROVIDER_UAZAPI) return uazapiPayloadBelongsToSession(input);
  if (input.session.provider === CHANNEL_PROVIDER_SOCIAL) {
    return socialPayloadBelongsToSession(admin, input.session.organization_id, input.session.id, input.rawBody);
  }
  if (input.session.provider === CHANNEL_PROVIDER_ZERNIO) {
    const { evento, conta: contaDoEvento } = cabecalhoDoEventoZernio(input.rawBody);
    if (contaDoEvento === null) return !EVENTOS_QUE_SEMPRE_TRAZEM_CONTA.some((p) => evento?.startsWith(p));
    // A guarda busca a conta ELA MESMA, como a do canal social: a rota do
    // webhook é genérica, e `lint:channels` recusa nome de coluna de provedor
    // ali. Uma guarda que dependesse de a rota lembrar de trazer a coluna
    // devolveria `true` sem filtrar nada no dia em que ela esquecesse.
    const { data, error } = await admin
      .from("channel_sessions")
      .select("zernio_account_id")
      .eq("organization_id", input.session.organization_id)
      .eq("id", input.session.id)
      .maybeSingle();
    if (error) throw new Error("zernio_session_lookup_failed");
    const contaDaSessao = (data as { zernio_account_id?: string | null } | null)?.zernio_account_id ?? null;
    // Sessão sem conta RECUSA. Hoje este ramo não executa — a constraint
    // `channel_sessions_provider_ref_check` exige `zernio_account_id` nesta
    // sessão —, e é por isso que ele pode ser o fechado: se um dia a constraint
    // afrouxar, "não sei de quem é a sessão" não vira "aceito de qualquer conta".
    return contaDaSessao !== null && contaDoEvento === contaDaSessao;
  }
  return true;
}

/** Prefixos de evento que o provedor documenta como SEMPRE trazendo a conta. */
const EVENTOS_QUE_SEMPRE_TRAZEM_CONTA = ["message.", "whatsapp.template."];

/** A conta que o provedor diz ter originado o evento — os mesmos três lugares que o parser lê. */
export function contaDoEventoZernio(rawBody: string): string | null {
  return cabecalhoDoEventoZernio(rawBody).conta;
}

function cabecalhoDoEventoZernio(rawBody: string): { evento: string | null; conta: string | null } {
  let p: unknown;
  try {
    p = JSON.parse(rawBody);
  } catch {
    return { evento: null, conta: null };
  }
  if (!p || typeof p !== "object") return { evento: null, conta: null };
  const o = p as Record<string, unknown>;
  const conta = o.account && typeof o.account === "object" ? (o.account as Record<string, unknown>) : null;
  const valor = conta?.id ?? conta?.accountId ?? o.accountId;
  return {
    evento: typeof o.event === "string" ? o.event : null,
    conta: typeof valor === "string" && valor.length > 0 ? valor : null,
  };
}

export async function handleInboundWebhook(
  admin: SupabaseClient,
  input: InboundWebhookInput,
): Promise<InboundWebhookOutcome> {
  const provider = input.session.provider as ChannelProvider;

  switch (provider) {
    case CHANNEL_PROVIDER_SOCIAL:
    case CHANNEL_PROVIDER_ZERNIO:
      return zernioInbound(admin, input);
    case CHANNEL_PROVIDER_UAZAPI:
      return uazapiInbound(admin, input);
    case CHANNEL_PROVIDER_DATAFY:
      return datafyInbound(admin, input);
    default:
      // Token de um canal que não entra por aqui. É configuração trocada, não
      // ataque — mas processar seria ler o payload com o parser errado.
      return { ok: false, code: "provider_mismatch", message: "canal não recebe por esta rota" };
  }
}

async function uazapiInbound(
  admin: SupabaseClient,
  input: InboundWebhookInput,
): Promise<InboundWebhookOutcome> {
  // ─── Como esta entrada se autentica ───────────────────────────────────────
  //
  // O servidor NÃO assina o corpo. Quem autentica é o token secreto da URL —
  // sorteado por conexão, e já usado pela rota para achar a sessão: quem não o
  // tem não chega aqui. A conexão guarda o token da instância cifrado no mesmo
  // campo de segredo, e isso dá a segunda prova.
  //
  // MEDIDO nos eventos reais: o evento de MENSAGEM repete o token da instância
  // no corpo; o de CONFIRMAÇÃO DE ENTREGA e o de CONEXÃO não trazem esse campo.
  // Exigir o token do corpo em tudo faria os dois virarem 401, e o servidor
  // reentregaria para sempre uma coisa que estava certa. Então: evento de
  // mensagem, o token tem que bater (achado 2); os outros dois, confere-se o
  // número DONO da instância contra o número da conexão, e a FALTA do dono
  // também recusa agora. Antes só o divergente recusava, e omitir os dois
  // campos passava direto.
  if (!input.secret || input.secret.length < MIN_SECRET_LEN) {
    return { ok: false, code: "unauthorized", message: "webhook_secret_unavailable" };
  }

  // O contrato antes de qualquer leitura. Recusar por JSON inválido não revela
  // nada a quem não tem o token da URL.
  const leitura = lerEnvelopeUazapi(input.rawBody);
  if (!leitura.ok) {
    if (leitura.motivo === "json_invalido") {
      return { ok: false, code: "invalid_json", message: "invalid_json" };
    }
    return {
      ok: false,
      code: "contrato_violado",
      message: `payload fora do contrato do canal: ${leitura.campos.join(", ")}`,
    };
  }
  const envelope = leitura.envelope;

  // ACHADO 2: a versão anterior só recusava quando o CAMPO vinha e divergia.
  // Quem omitia `token` e `owner` passava direto, e era exatamente isso que
  // permitia injetar mensagem forjada sabendo só a URL. O portão
  // (`verifyInboundWebhookSignature`, achado 4) já barrou o evento `messages`
  // sem token certo; esta segunda camada repete a conferência, e é aqui que
  // vive a exigência de `owner`, que depende da sessão e o portão não recebe.
  if ((envelope.EventType ?? "") === "messages") {
    if (!tokenDoEventoConfere(envelope.token, input.secret)) {
      return { ok: false, code: "unauthorized", message: "bad_token" };
    }
  } else {
    // Os últimos 8 dígitos bastam e evitam falso negativo: o número da conexão é
    // guardado em E.164 (`+55…`) e o evento manda só dígitos.
    const finalDoEvento = (envelope.owner ?? "").replace(/\D/g, "").slice(-8);
    if (!finalDoEvento) {
      // A FALTA do dono é o buraco do achado 2: sem token (este evento não traz)
      // E sem `owner`, não sobrava prova NENHUMA de que o evento é desta
      // conexão, e "não dá para verificar" tinha virado "processa assim
      // mesmo". Agora recusa.
      return { ok: false, code: "unauthorized", message: "dono_ausente" };
    }
    const finalDaConexao = (input.session.phone_number ?? "").replace(/\D/g, "").slice(-8);
    // Sem o número DA CONEXÃO (onboarding: o webhook é registrado no servidor
    // antes de o QR ser pareado, ver `instancia.ts`) não há com o que comparar.
    // Recusar aqui bloquearia o próprio evento `connection` que anuncia esse
    // número pela primeira vez.
    if (finalDaConexao && finalDoEvento !== finalDaConexao) {
      return { ok: false, code: "unauthorized", message: "dono_divergente" };
    }
  }

  // ─── D-042: nem `messages_update` nem `connection` repetem o token ────────
  //
  // A prova deles é só o dono, já conferido acima; sem nonce nem carimbo de
  // tempo no corpo, um evento capturado válido pode ser reenviado pela mesma
  // URL quantas vezes quiser. `eventoUazapiRepetido` reduz o ALCANCE disso:
  // mesma sessão + mesmo tipo + corpo byte a byte igual, dentro de uma janela
  // curta, é recusado como repetido, sem mudar o EFEITO em si, que já é
  // idempotente por outra via (`aplicarStatusUazapi` nunca rebaixa; a vigia de
  // conexão não duplica aviso). `messages` fica de fora deste portão: tem
  // token próprio no corpo (achado 4 acima), e quem cobre a reentrega dele é o
  // `external_id` único da mensagem, não este guard.
  //
  // A chave só é MARCADA como vista depois que o processamento do evento
  // termina sem lançar (`marcarEventoUazapiVisto`, mais abaixo em cada ramo).
  // Marcar aqui, antes de processar, descartava a reentrega legítima de um
  // evento cujo processamento anterior tinha falhado (5xx): o corpo idêntico
  // chegava de novo e era recusado como "repetido" sem nunca ter sido
  // aplicado. Ver o porquê em `uazapi/replay-guard.ts`.
  const tipoDoEvento = envelope.EventType ?? "";
  const usaGuardaDeReplay = tipoDoEvento === "messages_update" || tipoDoEvento === "connection";
  const chaveDoEvento = usaGuardaDeReplay
    ? chaveDoEventoUazapi(input.session.id, tipoDoEvento, input.rawBody)
    : null;
  if (chaveDoEvento && eventoUazapiRepetido(chaveDoEvento)) {
    return { ok: true, body: { status: "ignored", reason: "evento_repetido" } };
  }

  // ─── Desfecho de entrega: move o estado, não cria linha ────────────────────
  if ((envelope.EventType ?? "") === "messages_update") {
    const leituraDoStatus = lerAtualizacaoUazapi(input.rawBody);
    if (!leituraDoStatus.ok) {
      return { ok: true, body: { status: "ignored", reason: "atualizacao_fora_do_contrato" } };
    }
    const desfecho = parseUazapiAtualizacao(leituraDoStatus.envelope);
    if (!desfecho.ok) return { ok: true, body: { status: "ignored", reason: desfecho.motivo } };

    const aplicado = await aplicarStatusUazapi(admin, {
      organizationId: input.session.organization_id,
      externalIds: desfecho.atualizacao.externalIds,
      status: desfecho.atualizacao.status,
    });
    // Só chega aqui se `aplicarStatusUazapi` não lançou: processado de
    // verdade, agora sim marca a chave.
    if (chaveDoEvento) marcarEventoUazapiVisto(chaveDoEvento);
    return { ok: true, body: { status: "status", desfecho: desfecho.atualizacao.status, ...aplicado } };
  }

  // ─── A instância caiu (ou voltou): vigia, não log ─────────────────────────
  //
  // Mesmo caminho do canal parceiro, e pelo mesmo motivo: `sincronizarSaude…`
  // é quem grava o episódio E fecha o aviso na volta. Um insert cru aqui
  // deixaria o crítico aberto para sempre e abriria um `info` ao lado dele
  // quando o número voltasse.
  //
  // Estado desconhecido chega aqui como `reachable: false` com o nome dele no
  // detalhe — vira aviso de "não deu para verificar", que é honesto, em vez de
  // silêncio.
  if ((envelope.EventType ?? "") === "connection") {
    const leituraDaConexao = lerConexaoUazapi(input.rawBody);
    if (!leituraDaConexao.ok) {
      return { ok: true, body: { status: "ignored", reason: "conexao_fora_do_contrato" } };
    }
    const conexao = parseUazapiConexao(leituraDaConexao.envelope);
    if (!conexao.ok) return { ok: true, body: { status: "ignored", reason: conexao.motivo } };

    const desfecho = await sincronizarSaudeDaConexao(
      admin,
      { id: input.session.id, organization_id: input.session.organization_id, status: conexao.conexao.saude.status },
      conexao.conexao.saude,
      input.session.display_name ?? input.session.phone_number ?? "sem nome",
      // Empurrão do servidor: ele é a autoridade sobre o estado do NÚMERO, e a
      // varredura não fecha o que ele abriu.
      "empurrao",
    );
    // Só chega aqui se `sincronizarSaudeDaConexao` não lançou.
    if (chaveDoEvento) marcarEventoUazapiVisto(chaveDoEvento);
    return { ok: true, body: { status: "saude", estado: conexao.conexao.estado, desfecho } };
  }

  const lida = parseUazapiMensagem(envelope);
  if (!lida.ok) return { ok: true, body: { status: "ignored", reason: lida.motivo } };

  const r = await ingestUazapiMensagem(admin, {
    organizationId: input.session.organization_id,
    channelSessionId: input.session.id,
    msg: lida.msg,
  });
  return { ok: true, body: { ...r } };
}

async function zernioInbound(
  admin: SupabaseClient,
  input: InboundWebhookInput,
): Promise<InboundWebhookOutcome> {
  // Fail-closed, sem a exceção que virou regra no canal por QR: lá, "não
  // consegui verificar" virava "processa assim mesmo", e isso deixou toda
  // instalação aceitando mensagem forjada de quem soubesse a URL. Este provider
  // assina sempre, então não há dilema a herdar.
  if (!input.secret || input.secret.length < MIN_SECRET_LEN) {
    return { ok: false, code: "unauthorized", message: "webhook_secret_unavailable" };
  }

  const assinatura = input.headers.get("x-zernio-signature");
  if (!verifyZernioSignature(input.rawBody, assinatura, input.secret)) {
    return { ok: false, code: "unauthorized", message: "bad_signature" };
  }

  // ─── O contrato do fio, ANTES de qualquer leitura ─────────────────────────
  //
  // Aqui o payload era `unknown` e cada leitor se defendia sozinho com `str()`,
  // que devolve `null` para o que não é string. Nunca estourava — e era esse o
  // problema: um `conversationId` numérico virava `null`, o parser devolvia
  // `null`, e a rota respondia 200 `evento_sem_interesse`, exatamente como
  // responde a um evento que de fato não interessa. A mensagem do cliente sumia
  // com carimbo de normalidade.
  //
  // A recusa nomeia os CAMPOS e nunca os valores (dado de cliente), e a rota a
  // fecha no arquivo do webhook com `status: "error"` — onde alguém procura.
  const leitura = lerEnvelopeZernio(input.rawBody);
  if (!leitura.ok) {
    if (leitura.motivo === "json_invalido") {
      return { ok: false, code: "invalid_json", message: "invalid_json" };
    }
    return {
      ok: false,
      code: "contrato_violado",
      message: `payload fora do contrato do canal: ${leitura.campos.join(", ")}`,
    };
  }
  const payload = leitura.envelope;
  if (input.session.provider === CHANNEL_PROVIDER_SOCIAL) {
    const result = await ingestSocialInbound(admin, input.session.organization_id, input.session.id, payload);
    return { ok: true, body: { ...result } };
  }

  // ─── O que a plataforma decide sozinha ───────────────────────────────────
  //
  // Revisão de modelo e mudança de estado do número não são mensagens, mas são
  // o tipo de coisa que só se descobre no disparo que não sai — com a campanha
  // montada e o cliente esperando. Vira aviso na Central, onde o humano já
  // procura o que está errado.
  //
  // ─── Evento de NÚMERO: só vale se o número é o desta sessão ──────────────
  //
  // `whatsapp.number.*` não traz conta — a guarda de conta deixa passar —, e o
  // webhook do provedor é por espaço de trabalho, não por número. Sem esta
  // conferência, o status de outro número do mesmo espaço mudaria o estado
  // DESTE canal e abriria aviso crítico aqui. Quem decide é `number.phoneNumber`
  // (campo do schema publicado pelo provedor) contra `channel_sessions.phone_number`.
  //
  // Sem os dois lados não há comparação, e o evento fica só no arquivo do
  // webhook: sem mudar status e sem aviso. É o lado seguro também se a rota um
  // dia deixar de trazer `phone_number` — o efeito é não aplicar, nunca
  // aplicar o de outro número.
  if (payload.event?.startsWith("whatsapp.number.")) {
    const doEvento = payload.number?.phoneNumber;
    const daSessao = input.session.phone_number;
    if (!doEvento || !daSessao) {
      return { ok: true, body: { status: "ignored", reason: "numero_sem_comparacao" } };
    }
    if (!samePhone(doEvento, daSessao)) {
      return { ok: true, body: { status: "ignored", reason: "evento_de_outro_numero" } };
    }
  }

  const aviso = avisoDoEvento(payload);
  if (aviso) {
    // O espelho local também: o aviso empurra para olhar, e a tela de modelos
    // precisa mostrar o estado novo. Ver o estado velho depois de ler o aviso é
    // pior que não ter avisado.
    const espelhado = await atualizarEspelhoDoTemplate(
      admin,
      input.session.organization_id,
      payload,
      input.session.id,
    );

    // ─── Evento de CONEXÃO passa pelo vigia, não por um insert cru ──────────
    //
    // `sincronizarSaudeDaConexao` é quem grava o episódio, carimba
    // `ref_kind`+`ref_id` no ítem e — a metade que faltava — RESOLVE o aviso
    // quando a conta volta. Chamando `registrarAviso` direto, o crítico ficava
    // aberto para sempre e a reconexão abria um `info` novo ao lado dele.
    //
    // Um caminho só: quem entra aqui NÃO passa também pelo insert cru, senão a
    // Central mostraria o mesmo problema duas vezes.
    const saude = saudeDoEvento(payload);
    if (saude) {
      const desfecho = await sincronizarSaudeDaConexao(
        admin,
        // O `status` que vai para `channel_session_health` é o OBSERVADO agora,
        // não o guardado: quem acabou de falar foi o provedor, e a linha do
        // episódio serve justamente para registrar o que ele disse.
        { id: input.session.id, organization_id: input.session.organization_id, status: saude.status },
        saude,
        // O APELIDO da conexão, não o texto do evento. Passar `aviso.title` aqui
        // produzia `WhatsApp "Número SUSPENSO — não é possível enviar." fora do
        // ar (FAILED)`: título quebrado que não identifica a conexão — exatamente
        // o que o apelido existe para resolver. E fica gravado na linha.
        input.session.display_name ?? input.session.phone_number ?? "sem nome",
        // Empurrão do provedor: ele é a autoridade sobre o estado do NÚMERO, e
        // por isso a varredura não fecha o que ele abriu.
        "empurrao",
      );
      return { ok: true, body: { status: "saude", kind: aviso.kind, desfecho, espelhado } };
    }

    const desfecho = await registrarAviso(admin, input.session.organization_id, aviso);
    return { ok: true, body: { status: "aviso", kind: aviso.kind, desfecho, espelhado } };
  }

  // ─── Edição e apagamento ────────────────────────────────────────────────
  //
  // Vêm ANTES da ingestão, como os avisos: são correções de linha que já
  // existe, não mensagens novas. Deixá-los cair no `ingest` faria uma edição
  // criar uma conversa do nada, com um texto sem nada antes dele.
  const edicao = parseZernioEdicao(payload);
  if (edicao) {
    const desfecho = await aplicarEdicaoZernio(admin, input.session.organization_id, edicao);
    return { ok: true, body: { status: "edicao", tipo: edicao.tipo, desfecho } };
  }

  const r = await ingestZernioInbound(admin, {
    organizationId: input.session.organization_id,
    channelSessionId: input.session.id,
    payload,
  });
  return { ok: true, body: { ...r } };
}

/**
 * Entrada do canal Datafy (recorte do #1130, @vgamkt).
 *
 * O payload é IDÊNTICO ao da Meta (o parceiro espelha a Cloud API), então a
 * leitura reusa `lerEnvelopeMeta` + `parseMetaWebhook` + `ingestMetaInbound`; o
 * que é do parceiro é só a assinatura, conferida de novo aqui porque esta
 * função também é chamada fora da rota.
 *
 * Fail-closed: sem o segredo `whsec_` gravado, nada entra. O evento só é aceito
 * se for do número e da conta DESTA sessão — a sessão veio do token do path, e
 * o corpo não escolhe onde gravar.
 */
async function datafyInbound(
  admin: SupabaseClient,
  input: InboundWebhookInput,
): Promise<InboundWebhookOutcome> {
  if (!verifyInboundWebhookSignature(input.session.provider, input.rawBody, input.headers, input.secret)) {
    return { ok: false, code: "unauthorized", message: "bad_signature" };
  }

  const leitura = lerEnvelopeMeta(input.rawBody);
  if (!leitura.ok) {
    if (leitura.motivo === "json_invalido") {
      return { ok: false, code: "invalid_json", message: "invalid_json" };
    }
    return {
      ok: false,
      code: "contrato_violado",
      message: `payload fora do contrato do canal: ${leitura.campos.join(", ")}`,
    };
  }

  const orgId = input.session.organization_id;
  const refs = await graphPartnerRefsDaSessao(admin, orgId, input.session.id);
  const eventos = parseMetaWebhook(leitura.envelope);
  const desfechos: string[] = [];
  const agora = new Date().toISOString();

  for (const e of eventos) {
    // Mesma régua da rota do canal oficial: evento carimbado com outra conta é
    // de outra sessão, e ignorá-lo é o certo (200, para o provedor não repetir).
    if (refs.wabaId && e.wabaId && e.wabaId !== refs.wabaId) {
      desfechos.push("outra_conta");
      continue;
    }
    if (e.kind === "inbound_message") {
      if (e.phoneNumberId !== refs.phoneNumberId) {
        desfechos.push("outro_numero");
        continue;
      }
      const r = await ingestMetaInbound(admin, e, {
        organizationId: orgId,
        channelSessionId: input.session.id,
      });
      desfechos.push(r.status);
      continue;
    }
    if (e.kind === "outbound_echo") {
      // Coexistência pelo parceiro: resposta dada pelo app WhatsApp Business.
      if (e.phoneNumberId !== refs.phoneNumberId) {
        desfechos.push("outro_numero");
        continue;
      }
      const r = await ingestMetaEcho(admin, e, {
        organizationId: orgId,
        channelSessionId: input.session.id,
      });
      desfechos.push(`eco:${r.status}`);
      continue;
    }
    if (e.kind === "message_status") {
      await admin
        .from("messages")
        .update({ status: e.status === "failed" ? "failed" : "sent", updated_at: agora })
        .eq("organization_id", orgId)
        .eq("external_id", e.externalId);
      desfechos.push("status");
      continue;
    }
    if (e.kind === "template_status") {
      // A revisão da plataforma decide depois da criação: sem isto a definição
      // ficava PENDING no espelho até alguém clicar em Sincronizar, e o seletor
      // do inbox não a oferecia. Escopo pela CONEXÃO desta entrega — a coluna
      // `waba_id` do espelho deste canal guarda o número, não a conta.
      const { error } = await admin
        .from("meta_templates")
        .update({ status: e.event, rejected_reason: e.reason, updated_at: agora })
        .eq("organization_id", orgId)
        .eq("channel_session_id", input.session.id)
        .eq("name", e.templateName)
        .eq("language", e.templateLanguage);
      desfechos.push(error ? "modelo_nao_atualizado" : "modelo");
      continue;
    }
    desfechos.push("ignorado");
  }

  return { ok: true, body: { received: eventos.length, outcomes: desfechos } };
}
