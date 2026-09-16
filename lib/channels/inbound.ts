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

import { CHANNEL_PROVIDER_UAZAPI, CHANNEL_PROVIDER_ZERNIO } from "./capabilities";
import { sincronizarSaudeDaConexao } from "./health";
import { lerConexaoUazapi, parseUazapiConexao } from "./uazapi/conexao-evento";
import { lerEnvelopeUazapi } from "./uazapi/envelope";
import { ingestUazapiMensagem } from "./uazapi/ingest";
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
  return provider === CHANNEL_PROVIDER_ZERNIO || provider === CHANNEL_PROVIDER_UAZAPI;
}

export async function handleInboundWebhook(
  admin: SupabaseClient,
  input: InboundWebhookInput,
): Promise<InboundWebhookOutcome> {
  const provider = input.session.provider as ChannelProvider;

  switch (provider) {
    case CHANNEL_PROVIDER_ZERNIO:
      return zernioInbound(admin, input);
    case CHANNEL_PROVIDER_UAZAPI:
      return uazapiInbound(admin, input);
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
  // no corpo; o de CONFIRMAÇÃO DE ENTREGA não traz esse campo. Exigir o token do
  // corpo em tudo faria toda confirmação virar 401 — e o servidor reentregaria
  // para sempre uma coisa que estava certa. Então: veio token, tem que bater;
  // não veio, confere-se o número DONO da instância contra o número da conexão.
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

  if (envelope.token) {
    if (!tokenDoEventoConfere(envelope.token, input.secret)) {
      return { ok: false, code: "unauthorized", message: "bad_token" };
    }
  } else {
    // Os últimos 8 dígitos bastam e evitam falso negativo: o número da conexão é
    // guardado em E.164 (`+55…`) e o evento manda só dígitos.
    const finalDoEvento = (envelope.owner ?? "").replace(/\D/g, "").slice(-8);
    const finalDaConexao = (input.session.phone_number ?? "").replace(/\D/g, "").slice(-8);
    if (finalDoEvento && finalDaConexao && finalDoEvento !== finalDaConexao) {
      return { ok: false, code: "unauthorized", message: "dono_divergente" };
    }
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

  // ─── O que a plataforma decide sozinha ───────────────────────────────────
  //
  // Revisão de modelo e mudança de estado do número não são mensagens, mas são
  // o tipo de coisa que só se descobre no disparo que não sai — com a campanha
  // montada e o cliente esperando. Vira aviso na Central, onde o humano já
  // procura o que está errado.
  const aviso = avisoDoEvento(payload);
  if (aviso) {
    // O espelho local também: o aviso empurra para olhar, e a tela de modelos
    // precisa mostrar o estado novo. Ver o estado velho depois de ler o aviso é
    // pior que não ter avisado.
    const espelhado = await atualizarEspelhoDoTemplate(admin, input.session.organization_id, payload);

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
