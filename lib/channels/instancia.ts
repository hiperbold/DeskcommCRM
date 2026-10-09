/**
 * Conexão de canal por INSTÂNCIA — a face neutra que rota e tela usam.
 *
 * A rota não pode nomear o provider, nem no caminho de um import (o
 * `lint:channels` lê a linha do `import` como qualquer outra). Então quem está
 * do outro lado desta face — hoje, uma instância UAZAPI — só aparece aqui
 * dentro de `lib/channels`, e a rota fala em conceitos: "o servidor", "o token",
 * "a conexão". Um segundo provider por instância troca esta face, não a rota.
 *
 * ─── A ordem: validar, gravar, ligar a volta ────────────────────────────────
 *
 * Validar ANTES de gravar, como as outras conexões: gravar primeiro faz o
 * operador achar que conectou e só descobrir que não na primeira mensagem que
 * não sai. Gravar ANTES de registrar o webhook: o registro precisa do token da
 * URL, e uma entrega que chegasse antes da linha existir seria recusada.
 */
import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { mensagemDaRecusaDoPlano } from "@/lib/billing/planos/limite-de-conexoes";
import { recusaDoPlano, STATUS_RECUSA_DO_PLANO } from "@/lib/billing/planos/recusa-do-plano";
import type { Idioma } from "@/lib/i18n/idiomas";
import { decryptWebhookSecret, encryptWebhookSecret } from "@/lib/webhooks/secrets";

import {
  UAZAPI_CHANNEL_LABEL,
  UAZAPI_METADATA_WEBHOOK_ID,
  acharConexaoUazapi,
  arquivarConexaoUazapi,
  enderecoNaoAlcancavel,
  gravarWebhookDaConexao,
  listarConexoesUazapi,
  registrarWebhookUazapi,
  removerWebhookUazapi,
  salvarConexaoUazapi,
  validarInstanciaUazapi,
  type ConexaoUazapi,
} from "./uazapi/conexao";
import { apagarInstanciaNoServidor } from "./uazapi/pareamento";

/** Como o canal se chama para o usuário. */
export const INSTANCE_CHANNEL_LABEL = UAZAPI_CHANNEL_LABEL;

export type ConexaoPorInstancia = ConexaoUazapi;

export function listarConexoesPorInstancia(
  admin: SupabaseClient,
  organizationId: string,
): Promise<ConexaoPorInstancia[]> {
  return listarConexoesUazapi(admin, organizationId);
}

export type ResultadoDaConexao =
  | {
      ok: true;
      conexao: { id: string; displayName: string; phoneNumber: string | null; status: string };
      /** A volta: sem ela o canal envia e não recebe. `aviso` diz por que não ligou. */
      webhook: { registrado: boolean; aviso: string | null };
    }
  | { ok: false; status: 402 | 422 | 500; reason: string };

export async function conectarPorInstancia(
  admin: SupabaseClient,
  input: {
    organizationId: string;
    servidor: string;
    token: string;
    /** Apelido escolhido na tela; vazio usa o nome do perfil da instância. */
    nome?: string | null;
    /** Monta a URL pública de entrega a partir do token de caminho da conexão. */
    urlDoWebhook: (pathToken: string) => string;
    /** Idioma de quem pediu, só para a frase de recusa do plano. */
    idioma?: Idioma;
  },
): Promise<ResultadoDaConexao> {
  const token = input.token.trim();
  const v = await validarInstanciaUazapi({ servidor: input.servidor, token });
  if (!v.ok) return { ok: false, status: 422, reason: v.reason };

  const tokenCifrado = await encryptWebhookSecret(admin, token);
  if (!tokenCifrado) {
    // Sem a chave de cifra, gravar o token em claro seria pior que recusar.
    return { ok: false, status: 422, reason: "cifra indisponível nesta instalação — o token não foi gravado" };
  }

  const existente = await acharConexaoUazapi(admin, input.organizationId, {
    baseUrl: v.baseUrl,
    instanceId: v.instanceId,
  });
  // Reconectar preserva o token do caminho: a URL já registrada continua valendo.
  const pathToken = existente?.webhook_path_token ?? randomBytes(24).toString("hex");
  const displayName = input.nome?.trim() || v.profileName || v.instanceName || INSTANCE_CHANNEL_LABEL;

  const salvo = await salvarConexaoUazapi(admin, {
    organizationId: input.organizationId,
    existente: existente ? { id: existente.id, metadata: existente.metadata } : null,
    baseUrl: v.baseUrl,
    instanceId: v.instanceId,
    tokenCifrado,
    webhookPathToken: pathToken,
    phoneNumber: v.phoneNumber,
    displayName,
    status: v.status,
  });
  if (salvo.error || !salvo.id) {
    // Fase F3, decisão 3: PT402 pelo `code`, nunca pelo texto do Postgres.
    const recusa = recusaDoPlano(salvo.errorRaw);
    if (recusa) {
      const reason = await mensagemDaRecusaDoPlano(recusa, admin, input.organizationId, input.idioma);
      return { ok: false, status: STATUS_RECUSA_DO_PLANO, reason };
    }
    return { ok: false, status: 500, reason: salvo.error ?? "a conexão não foi gravada" };
  }

  const conexao = { id: salvo.id, displayName, phoneNumber: v.phoneNumber, status: v.status };
  const url = input.urlDoWebhook(pathToken);

  if (enderecoNaoAlcancavel(url)) {
    return {
      ok: true,
      conexao,
      webhook: {
        registrado: false,
        aviso:
          "O endereço público do CRM não está configurado (aponta para esta máquina). A conexão foi gravada e envia, mas as mensagens não vão chegar até o endereço ser público.",
      },
    };
  }

  const anterior = existente?.metadata?.[UAZAPI_METADATA_WEBHOOK_ID];
  const reg = await registrarWebhookUazapi({ baseUrl: v.baseUrl, token, url });
  if (!reg.ok) return { ok: true, conexao, webhook: { registrado: false, aviso: reg.reason } };

  // A URL pública mudou desde a última conexão: o webhook antigo apontaria para
  // o nada e acumularia erro no servidor. Sai só ele, pelo id que guardamos.
  if (typeof anterior === "string" && anterior && anterior !== reg.webhookId) {
    await removerWebhookUazapi({ baseUrl: v.baseUrl, token, webhookId: anterior });
  }
  await gravarWebhookDaConexao(admin, input.organizationId, salvo.id, reg.webhookId);

  return { ok: true, conexao, webhook: { registrado: !!reg.webhookId, aviso: null } };
}

export type ResultadoDaRemocao =
  | {
      ok: true;
      webhookRemovido: boolean;
      /** A instância foi criada pelo CRM e apagada no servidor. `false` nas conectadas por servidor e token do cliente. */
      instanciaApagada: boolean;
      /** Era do CRM (QR Code) mas o servidor não confirmou a exclusão: a tela avisa. */
      instanciaRestou: boolean;
    }
  | { ok: false; status: 404 | 500; reason: string };

/**
 * Remove a conexão: desliga o NOSSO webhook no servidor e arquiva a linha.
 *
 * Arquivar mesmo quando o servidor não responde: o operador pediu para parar, e
 * uma entrega que ainda chegue cai no filtro de canal arquivado da rota.
 *
 * A instância que o CRM CRIOU (pareamento por QR Code, coluna `criada_pelo_crm`, que só o servidor grava)
 * é apagada também no servidor: ela é do CRM, e deixá-la lá seria um WhatsApp pago
 * sem dono. A conectada por servidor e token do cliente continua só perdendo o
 * nosso webhook: a instância é dele.
 */
export async function removerConexaoPorInstancia(
  admin: SupabaseClient,
  organizationId: string,
  id: string,
): Promise<ResultadoDaRemocao> {
  const linha = await acharConexaoUazapi(admin, organizationId, { id });
  if (!linha) return { ok: false, status: 404, reason: "conexão não encontrada" };

  let webhookRemovido = false;
  let instanciaApagada = false;
  const criadaPeloCrm = linha.criada_pelo_crm === true;
  const webhookId = linha.metadata?.[UAZAPI_METADATA_WEBHOOK_ID];
  if (linha.uazapi_base_url && linha.token_encrypted) {
    const token = await decryptWebhookSecret(admin, linha.token_encrypted as string);
    if (token) {
      if (criadaPeloCrm) {
        // Apagar a instância leva o webhook junto: não há o que tirar antes.
        instanciaApagada = await apagarInstanciaNoServidor({ baseUrl: linha.uazapi_base_url, token });
        webhookRemovido = instanciaApagada;
      } else if (typeof webhookId === "string" && webhookId) {
        webhookRemovido = await removerWebhookUazapi({ baseUrl: linha.uazapi_base_url, token, webhookId });
      }
    }
  }

  const erro = await arquivarConexaoUazapi(admin, organizationId, id);
  if (erro) return { ok: false, status: 500, reason: erro };
  return { ok: true, webhookRemovido, instanciaApagada, instanciaRestou: criadaPeloCrm && !instanciaApagada };
}
