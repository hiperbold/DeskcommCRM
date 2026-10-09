/**
 * Pareamento por QR Code DENTRO do CRM: o CRM cria a instância no servidor da
 * instalação e o cliente lê o QR na tela de Conexões.
 *
 * Quem mora aqui é o que fala com o servidor (token de ADMINISTRADOR da
 * instalação para criar, token DA INSTÂNCIA para tudo o resto) e o que grava a
 * linha de `channel_sessions`. A rota e a tela falam pela face neutra
 * `lib/channels/pareamento-qr.ts`: nome de provider fora de `lib/channels` o
 * `lint:channels` reprova.
 *
 * ─── Endpoints do servidor usados (conferidos em docs.uazapi.com/openapi-bundled.json)
 *
 *   POST   /instance/create   header `admintoken`, corpo { name }  -> { token, instance }
 *   GET    /instance/all      header `admintoken` (só para achar uma instância órfã pelo nome)
 *   POST   /instance/connect  header `token`, corpo {} (QR) ou { phone } (código de pareamento)
 *   GET    /instance/status   header `token`  -> instance.status, qrcode, paircode, owner
 *   DELETE /instance          header `token`  (200, ou 202 quando a exclusão é assíncrona)
 *   POST   /webhook           header `token`, action "add" (por `registrarWebhookUazapi`)
 *
 * ─── A ordem, e por que a linha nasce PRIMEIRO ──────────────────────────────
 *
 * A linha de `channel_sessions` é gravada antes de a instância existir: o
 * gatilho do plano (PT402) recusa o excedente, e recusar DEPOIS de criar a
 * instância deixaria um WhatsApp pago no servidor sem dono. Como o banco exige
 * `uazapi_instance_id` preenchido para o provider, a linha nasce com um
 * identificador provisório (`pendente-<id>`) trocado pelo real logo depois.
 * Ela nasce `STARTING` e marcada como pareamento pendente, o que a tira da lista
 * de Conexões e do vigia de saúde (um QR ainda não lido não é número caído).
 *
 * ─── O estado vive em COLUNAS, nunca no `metadata` (migration 0953) ─────────
 *
 * "Pendente", "criada pelo CRM" e "iniciado em" moram em colunas de
 * `channel_sessions` que um gatilho só deixa o servidor gravar. O `metadata` é
 * editável pelo admin da organização pelo PostgREST, então qualquer decisão
 * tomada a partir dele (vencer um pendente, apagar uma instância, usar o token de
 * administrador) seria decisão do usuário. A linha nasce por uma função do banco
 * (`fn_channel_pareamento_qr_reservar`) que confere, sob trava por organização,
 * o limite de pendentes e o teto de instâncias antes de inserir.
 *
 * O token de ADMINISTRADOR só é anexado a uma chamada quando o endereço gravado
 * na linha é exatamente o servidor configurado na instalação. Trocar o servidor da
 * instalação, ou uma linha que aponte para outro, nunca leva o token a um host
 * que não é o configurado.
 *
 * ─── O que nunca acontece ───────────────────────────────────────────────────
 *
 * - Instância órfã: qualquer falha depois de criar apaga a instância no servidor
 *   e arquiva a linha. Quando a criação deu resposta incerta (queda de rede), a
 *   instância é procurada pelo nome estável e apagada.
 * - Vazamento: o token de administrador e o da instância nunca vão para log,
 *   resposta ou tela; o QR nunca vai para log. Erros saem com frase fixa.
 * - Outra organização: toda leitura e escrita de sessão filtra `organization_id`
 *   da sessão autenticada.
 *
 * ─── O webhook só liga quando o número conecta ──────────────────────────────
 *
 * Diferente da conexão por servidor e token, a volta das mensagens é registrada
 * ao CONECTAR, não ao criar: durante o pareamento o servidor emite eventos de
 * "conectando", e o vigia leria cada um como queda do número (aviso crítico e
 * e-mail por QR que o próprio cliente está lendo).
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { metadataInicialDoCanal } from "@/lib/ai/elegibilidade/pre-go-live";
import { fetchParaDestinoDaOrganizacao } from "@/lib/automation/destinos-internos-autorizados";
import { mensagemDaRecusaDoPlano, mensagemDoLimiteDeConexoes } from "@/lib/billing/planos/limite-de-conexoes";
import { recusaDoPlano, STATUS_RECUSA_DO_PLANO } from "@/lib/billing/planos/recusa-do-plano";
import type { Idioma } from "@/lib/i18n/idiomas";
import { valorDaInstalacao } from "@/lib/instalacao/config";
import { logger } from "@/lib/logger";
import { decryptWebhookSecret, encryptWebhookSecret } from "@/lib/webhooks/secrets";

import { CHANNEL_PROVIDER_UAZAPI } from "../capabilities";
import {
  UAZAPI_METADATA_WEBHOOK_ID,
  enderecoNaoAlcancavel,
  gravarWebhookDaConexao,
  registrarWebhookUazapi,
} from "./conexao";
import { normalizarServidorUazapi } from "./credentials";

/**
 * No máximo este tanto de pareamentos em andamento por organização. O número que
 * vale é o da função do banco (`fn_channel_pareamento_qr_reservar`, que decide sob
 * trava); este só dá a frase e o teste que o confere contra o SQL.
 */
export const LIMITE_DE_PAREAMENTOS_PENDENTES = 2;
/** Pendente há mais que isto é limpo (instância apagada, linha arquivada). */
export const VALIDADE_DO_PAREAMENTO_MS = 30 * 60 * 1000;
/** Rodadas de limpeza que podem falhar numa linha antes de ela sair do lote (e ser arquivada). */
export const LIMITE_DE_FALHAS_DA_LIMPEZA = 5;
/** Um código de pareamento por telefone a cada tanto, por pareamento. */
export const INTERVALO_ENTRE_CODIGOS_MS = 30_000;
/** No máximo este tanto de códigos de pareamento por telefone, por pareamento. */
export const LIMITE_DE_CODIGOS_POR_PAREAMENTO = 5;
/** Logo depois de pedir o QR o servidor ainda pode dizer "desconectado". */
const CARENCIA_DO_PRIMEIRO_ESTADO_MS = 20_000;
/** Teto de pendências tratadas por rodada de limpeza. */
const LOTE_DA_LIMPEZA = 25;
const PRAZO_MS = 20_000;

/**
 * O que SOBRA no `metadata`: só texto de tela e o instante do último pedido de QR,
 * que decide apenas se a tela diz "aguardando" ou "expirou" logo depois do pedido.
 * Nada que autorize chamada ao servidor ou que apague instância mora aqui.
 */
const META_TENTATIVA_EM = "pareamento_qr_tentativa_em";
const META_AVISO = "pareamento_qr_aviso";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const QR_DATA_URL = /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/;
const CODIGO_DE_PAREAMENTO = /^[A-Za-z0-9-]{4,24}$/;

type Json = Record<string, unknown> | null;
const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim().length > 0 ? v.trim() : null;

// ---------------------------------------------------------------------------
// Configuração da instalação
// ---------------------------------------------------------------------------

export interface ConfiguracaoDoPareamento {
  /** https, sem caminho. */
  servidor: string;
  /** Token de ADMINISTRADOR. Nunca sai deste módulo. */
  adminToken: string;
}

/**
 * As duas chaves da instalação, ou `null` quando falta alguma (ou o endereço não
 * é https). `null` = o recurso não existe nesta instalação.
 */
export async function configuracaoDoPareamento(): Promise<ConfiguracaoDoPareamento | null> {
  const [servidorBruto, tokenBruto] = await Promise.all([
    valorDaInstalacao("UAZAPI_SERVIDOR_URL"),
    valorDaInstalacao("UAZAPI_ADMIN_TOKEN"),
  ]);
  const servidor = servidorBruto.valor ? normalizarServidorUazapi(servidorBruto.valor) : null;
  const adminToken = str(tokenBruto.valor);
  if (!servidor || !adminToken || !servidor.startsWith("https://")) return null;
  // Endereço e token de administrador têm de vir da MESMA origem (os dois gravados pela tela, ou os dois do
  // arquivo de instalação). Misturar mandaria o token de um para o endereço do outro: o endereço gravado
  // pela tela (sob aal2) receberia o token do arquivo de instalação, e o endereço do arquivo receberia um
  // token que foi digitado para outro servidor. Origens diferentes = o recurso não está configurado.
  if (servidorBruto.fonte !== tokenBruto.fonte) return null;
  return { servidor, adminToken };
}

export async function pareamentoDisponivel(): Promise<boolean> {
  return (await configuracaoDoPareamento()) !== null;
}

// ---------------------------------------------------------------------------
// Servidor
// ---------------------------------------------------------------------------

async function chamarServidor(
  baseUrl: string,
  cabecalhos: Record<string, string>,
  metodo: "GET" | "POST" | "DELETE",
  caminho: string,
  corpo?: Record<string, unknown>,
): Promise<{ res: Response; json: unknown }> {
  // A mesma régua de destino das outras saídas para o servidor: o endereço da
  // instalação também não pode apontar para a rede interna nem seguir redirect
  // com o token no cabeçalho.
  const res = await fetchParaDestinoDaOrganizacao()(`${baseUrl}${caminho}`, {
    method: metodo,
    headers: {
      accept: "application/json",
      ...(corpo ? { "content-type": "application/json" } : {}),
      ...cabecalhos,
    },
    ...(corpo ? { body: JSON.stringify(corpo) } : {}),
    signal: AbortSignal.timeout(PRAZO_MS),
  });
  return { res, json: await res.json().catch(() => null) };
}

type CriacaoNoServidor =
  | { ok: true; token: string; instanceId: string }
  | { ok: false; motivo: "token_recusado" | "limite_do_servidor" | "recusada" | "incerta" };

async function criarInstanciaNoServidor(
  cfg: ConfiguracaoDoPareamento,
  nome: string,
): Promise<CriacaoNoServidor> {
  let resposta: { res: Response; json: unknown };
  try {
    resposta = await chamarServidor(
      cfg.servidor,
      { admintoken: cfg.adminToken },
      "POST",
      "/instance/create",
      { name: nome },
    );
  } catch {
    // Pode ter chegado e criado: quem chama procura pelo nome antes de desistir.
    return { ok: false, motivo: "incerta" };
  }
  const { res, json } = resposta;
  if (res.status === 401 || res.status === 403) return { ok: false, motivo: "token_recusado" };
  if (res.status === 429) return { ok: false, motivo: "limite_do_servidor" };
  if (res.status >= 500) return { ok: false, motivo: "incerta" };
  if (!res.ok) return { ok: false, motivo: "recusada" };

  const corpo = json as Json;
  const instancia = (corpo?.instance ?? null) as Json;
  const token = str(corpo?.token) ?? str(instancia?.token);
  const instanceId = str(instancia?.id);
  // Respondeu 2xx mas sem o que precisamos: a instância existe e não temos o token.
  if (!token || !instanceId) return { ok: false, motivo: "incerta" };
  return { ok: true, token, instanceId };
}

/** `true` quando a instância deixou de existir (200, 202 agendado ou 404). */
export async function apagarInstanciaNoServidor(input: {
  baseUrl: string;
  token: string;
}): Promise<boolean> {
  try {
    const { res } = await chamarServidor(
      input.baseUrl,
      { token: input.token },
      "DELETE",
      "/instance",
    );
    return res.ok || res.status === 404;
  } catch {
    return false;
  }
}

/**
 * Procura a instância pelo NOME estável e a apaga. Só para a criação que deu
 * resposta incerta (ou a linha sem token): lista todas as instâncias do servidor,
 * então é caminho raro.
 *
 * O nome leva só 8 caracteres de cada identificador, então duas instâncias podem
 * dividir o nome. Por isso:
 *  - mais de uma instância com o MESMO nome: recusa (`false`), porque apagar uma
 *    delas poderia apagar a de outra organização;
 *  - com o `instanceId` conhecido, a instância de mesmo nome tem de ter também
 *    esse id; se for outro, ela é de outro dono e nada é apagado (`true`: a nossa
 *    não está lá).
 */
async function apagarInstanciaPeloNome(
  cfg: ConfiguracaoDoPareamento,
  nome: string,
  instanceId: string | null = null,
): Promise<boolean> {
  try {
    const { res, json } = await chamarServidor(
      cfg.servidor,
      { admintoken: cfg.adminToken },
      "GET",
      "/instance/all",
    );
    if (!res.ok || !Array.isArray(json)) return false;
    const mesmoNome = (json as Json[]).filter((i) => str(i?.name) === nome);
    if (mesmoNome.length > 1) {
      logger.warn("[pareamento-qr] mais de uma instância com o mesmo nome; nada foi apagado", {
        instancia: nome,
        quantas: mesmoNome.length,
      });
      return false;
    }
    const achada = mesmoNome[0];
    if (!achada) return true; // não existe: nada a apagar
    if (instanceId && str(achada.id) !== instanceId) return true; // a de mesmo nome é de outro dono
    const token = str(achada.token);
    if (!token) return false;
    return await apagarInstanciaNoServidor({ baseUrl: cfg.servidor, token });
  } catch {
    return false;
  }
}

function normalizarQr(bruto: unknown): string | null {
  const texto = str(bruto);
  if (!texto) return null;
  const url = texto.startsWith("data:") ? texto : `data:image/png;base64,${texto}`;
  // Vai para `<img src>`: só imagem em base64 e com teto, nunca o que o servidor mandar.
  return url.length <= 200_000 && QR_DATA_URL.test(url) ? url : null;
}

function normalizarCodigo(bruto: unknown): string | null {
  const texto = str(bruto);
  return texto && CODIGO_DE_PAREAMENTO.test(texto) ? texto : null;
}

type Conexao = { ok: true; qr: string | null; codigo: string | null } | { ok: false };

async function pedirConexao(
  baseUrl: string,
  token: string,
  telefone: string | null,
): Promise<Conexao> {
  try {
    const { res, json } = await chamarServidor(
      baseUrl,
      { token },
      "POST",
      "/instance/connect",
      telefone ? { phone: telefone } : {},
    );
    // 409: já existe um fluxo de conexão em andamento. O QR vigente sai do /status.
    if (res.status === 409) return { ok: true, qr: null, codigo: null };
    if (!res.ok) return { ok: false };
    const instancia = ((json as Json)?.instance ?? null) as Json;
    return {
      ok: true,
      qr: normalizarQr(instancia?.qrcode),
      codigo: normalizarCodigo(instancia?.paircode),
    };
  } catch {
    return { ok: false };
  }
}

interface InstanciaLida {
  estado: string;
  qr: string | null;
  codigo: string | null;
  instanceId: string | null;
  /** E.164 com `+`, quando pareada. */
  telefone: string | null;
  perfil: string | null;
}

async function lerInstancia(baseUrl: string, token: string): Promise<InstanciaLida | null> {
  try {
    const { res, json } = await chamarServidor(baseUrl, { token }, "GET", "/instance/status");
    if (!res.ok) return null;
    const instancia = ((json as Json)?.instance ?? null) as Json;
    if (!instancia) return null;
    const dono = str(instancia.owner)?.replace(/\D/g, "") ?? "";
    return {
      estado: (str(instancia.status) ?? "").toLowerCase(),
      qr: normalizarQr(instancia.qrcode),
      codigo: normalizarCodigo(instancia.paircode),
      instanceId: str(instancia.id),
      telefone: dono.length >= 8 ? `+${dono}` : null,
      perfil: str(instancia.profileName),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Linha de channel_sessions
// ---------------------------------------------------------------------------

interface LinhaDoPareamento {
  id: string;
  organization_id: string;
  status: string | null;
  display_name: string | null;
  phone_number: string | null;
  uazapi_base_url: string | null;
  uazapi_instance_id: string | null;
  uazapi_token_encrypted: unknown;
  webhook_path_token: string | null;
  metadata: Record<string, unknown> | null;
  /** Colunas só do servidor (migration 0953): é por elas que se decide, nunca pelo `metadata`. */
  pareamento_qr_estado: string | null;
  pareamento_qr_iniciado_em: string | null;
  criada_pelo_crm: boolean | null;
  pareamento_qr_falhas: number | null;
  pareamento_qr_codigos: number | null;
  pareamento_qr_codigo_em: string | null;
}

const COLUNAS =
  "id, organization_id, status, display_name, phone_number, uazapi_base_url, uazapi_instance_id, uazapi_token_encrypted, webhook_path_token, metadata, pareamento_qr_estado, pareamento_qr_iniciado_em, criada_pelo_crm, pareamento_qr_falhas, pareamento_qr_codigos, pareamento_qr_codigo_em";

const curto = (uuid: string): string => uuid.replace(/-/g, "").slice(0, 8);

/** Nome estável da instância no servidor: `hc-<org curto>-<sessão curto>`. */
export function nomeDaInstancia(organizationId: string, sessaoId: string): string {
  return `hc-${curto(organizationId)}-${curto(sessaoId)}`;
}

/** Só a linha que nasceu de um pareamento (pendente ou concluído); conexão comum não é daqui. */
async function acharSessao(
  admin: SupabaseClient,
  organizationId: string,
  id: string,
): Promise<LinhaDoPareamento | null> {
  if (!UUID.test(id) || !UUID.test(organizationId)) return null;
  const { data, error } = await admin
    .from("channel_sessions")
    .select(COLUNAS)
    .eq("organization_id", organizationId)
    .eq("id", id)
    .eq("provider", CHANNEL_PROVIDER_UAZAPI)
    .is("archived_at", null)
    .maybeSingle();
  if (error) throw new Error(`pareamento_achar_sessao_falhou: ${error.code ?? ""}`.trim());
  const linha = (data as LinhaDoPareamento | null) ?? null;
  return linha?.pareamento_qr_estado ? linha : null;
}

/**
 * Atualiza colunas e, quando há o que gravar nele, MESCLA o `metadata` (a linha
 * guarda também o acesso da IA e os números de teste). Devolve o código do erro do
 * banco, ou `null`.
 */
async function atualizarSessao(
  admin: SupabaseClient,
  organizationId: string,
  id: string,
  colunas: Record<string, unknown>,
  metadata: Record<string, unknown> = {},
): Promise<string | null> {
  const patch: Record<string, unknown> = { ...colunas };
  if (Object.keys(metadata).length > 0) {
    const { data } = await admin
      .from("channel_sessions")
      .select("metadata")
      .eq("organization_id", organizationId)
      .eq("id", id)
      .maybeSingle();
    const atual = ((data as { metadata: Record<string, unknown> | null } | null)?.metadata ??
      {}) as Record<string, unknown>;
    patch.metadata = { ...atual, ...metadata };
  }
  const { error } = await admin
    .from("channel_sessions")
    .update(patch)
    .eq("organization_id", organizationId)
    .eq("id", id);
  return error?.code ?? error?.message ?? null;
}

/** Arquiva a linha e tira o estado de pareamento: ela deixa de ser pendente e de contar vaga. */
async function arquivarSessao(
  admin: SupabaseClient,
  organizationId: string,
  id: string,
): Promise<void> {
  await atualizarSessao(admin, organizationId, id, {
    archived_at: new Date().toISOString(),
    status: "STOPPED",
    pareamento_qr_estado: null,
  });
}

async function tokenDaSessao(
  admin: SupabaseClient,
  linha: LinhaDoPareamento,
): Promise<string | null> {
  if (typeof linha.uazapi_token_encrypted !== "string" || !linha.uazapi_token_encrypted)
    return null;
  return decryptWebhookSecret(admin, linha.uazapi_token_encrypted);
}

/**
 * O servidor e o token de ADMINISTRADOR que esta linha pode usar, ou `null`.
 *
 * Só quando o endereço gravado na linha é exatamente o servidor configurado agora
 * na instalação (os dois normalizados). Linha de outro servidor, ou de um servidor
 * que a instalação já trocou, nunca recebe o token: ele só viaja para o host em
 * que foi configurado.
 */
function credencialDeAdministrador(
  linha: LinhaDoPareamento,
  cfg: ConfiguracaoDoPareamento | null,
): { servidor: string; adminToken: string } | null {
  if (!cfg) return null;
  const base = linha.uazapi_base_url ? normalizarServidorUazapi(linha.uazapi_base_url) : null;
  if (base !== cfg.servidor) {
    logger.warn(
      "[pareamento-qr] o servidor da linha não é o configurado na instalação; o token de administrador não foi usado",
      { sessao: linha.id },
    );
    return null;
  }
  return { servidor: cfg.servidor, adminToken: cfg.adminToken };
}

/** O id que o servidor deu à instância, ou `null` enquanto a linha ainda tem o provisório. */
const instanceIdConhecido = (linha: LinhaDoPareamento): string | null =>
  linha.uazapi_instance_id && !linha.uazapi_instance_id.startsWith("pendente-")
    ? linha.uazapi_instance_id
    : null;

interface Desfeito {
  /** A instância deixou de existir no servidor (ou nunca existiu). */
  apagada: boolean;
  /** A linha foi arquivada. */
  arquivada: boolean;
}

/**
 * Desfaz um pareamento que não vai adiante: apaga a instância no servidor (pelo
 * token, ou pelo nome quando o token não existe) e arquiva a linha. Nunca lança.
 *
 * `arquivarSempre: false` (a limpeza) deixa a linha viva quando a instância não
 * foi confirmada apagada, para a rodada seguinte tentar de novo, a não ser que
 * não haja caminho nenhum para apagá-la (sem token e sem credencial de
 * administrador): aí tentar de novo não adianta e a linha é arquivada.
 */
async function desfazer(
  admin: SupabaseClient,
  alvo: {
    organizationId: string;
    sessaoId: string;
    baseUrl: string;
    token: string | null;
    credencial: { servidor: string; adminToken: string } | null;
    instanceId: string | null;
  },
  opcoes: { arquivarSempre: boolean } = { arquivarSempre: true },
): Promise<Desfeito> {
  let apagada = false;
  try {
    if (alvo.token)
      apagada = await apagarInstanciaNoServidor({ baseUrl: alvo.baseUrl, token: alvo.token });
    if (!apagada && alvo.credencial) {
      apagada = await apagarInstanciaPeloNome(
        alvo.credencial,
        nomeDaInstancia(alvo.organizationId, alvo.sessaoId),
        alvo.instanceId,
      );
    }
  } catch {
    apagada = false;
  }
  const haComoTentarDeNovo = !!alvo.token || !!alvo.credencial;
  let arquivada = false;
  if (apagada || opcoes.arquivarSempre || !haComoTentarDeNovo) {
    try {
      await arquivarSessao(admin, alvo.organizationId, alvo.sessaoId);
      arquivada = true;
    } catch (erro) {
      logger.error("[pareamento-qr] a sessão não foi arquivada", {
        detail: erro instanceof Error ? erro.message : "erro",
      });
    }
  }
  if (!apagada && arquivada) {
    // Sem token nem nome achado: a instância pode ter ficado no servidor. O id é o
    // nome estável, que quem cuida do servidor encontra; nunca o token.
    logger.warn("[pareamento-qr] instância possivelmente órfã no servidor", {
      instancia: nomeDaInstancia(alvo.organizationId, alvo.sessaoId),
    });
  }
  return { apagada, arquivada };
}

/** `desfazer` a partir da linha lida do banco. */
async function desfazerDaLinha(
  admin: SupabaseClient,
  linha: LinhaDoPareamento,
  cfg: ConfiguracaoDoPareamento | null,
  opcoes: { arquivarSempre: boolean } = { arquivarSempre: true },
): Promise<Desfeito> {
  const token = await tokenDaSessao(admin, linha).catch(() => null);
  const baseUrl = linha.uazapi_base_url ?? "";
  // Sem endereço gravado não há onde apagar; só arquiva.
  if (!baseUrl) {
    await arquivarSessao(admin, linha.organization_id, linha.id);
    return { apagada: false, arquivada: true };
  }
  return desfazer(
    admin,
    {
      organizationId: linha.organization_id,
      sessaoId: linha.id,
      baseUrl,
      token,
      credencial: credencialDeAdministrador(linha, cfg),
      instanceId: instanceIdConhecido(linha),
    },
    opcoes,
  );
}

// ---------------------------------------------------------------------------
// Resultados (neutros: a rota só conhece estes tipos)
// ---------------------------------------------------------------------------

export type CodigoDeFalha =
  | "plano_limite_atingido"
  | "not_found"
  | "state_conflict"
  | "invalid_request"
  | "rate_limited"
  | "internal_error"
  | "upstream_unavailable";

export interface FalhaDoPareamento {
  ok: false;
  status: 402 | 404 | 409 | 422 | 429 | 500 | 502 | 503;
  codigo: CodigoDeFalha;
  /** Frase fixa em português; nunca resposta do servidor. */
  reason: string;
}

const falha = (
  status: FalhaDoPareamento["status"],
  codigo: CodigoDeFalha,
  reason: string,
): FalhaDoPareamento => ({ ok: false, status, codigo, reason });

const FRASE_SERVIDOR_FORA =
  "Não foi possível falar com o servidor de WhatsApp. Tente de novo em instantes.";

export interface PareamentoEmAndamento {
  id: string;
  estado: "aguardando" | "expirado";
  /** Data URL da imagem do QR, ou `null` enquanto o servidor ainda não a gerou. */
  qr: string | null;
  /** Código de pareamento (quando o cliente informou o número). */
  codigo: string | null;
  expira_em: string;
}

export interface PareamentoConcluido {
  id: string;
  estado: "conectado";
  conexao: { id: string; displayName: string; phoneNumber: string | null; status: string };
  webhook: { registrado: boolean; aviso: string | null };
  /** `true` só na chamada que de fato concluiu (a que deve gerar o audit). */
  concluiuAgora: boolean;
}

export type EstadoDoPareamento = PareamentoEmAndamento | PareamentoConcluido;

const expiraEm = (iniciadoEm: string | null): string => {
  const base = iniciadoEm ? Date.parse(iniciadoEm) : NaN;
  return new Date(
    (Number.isFinite(base) ? base : Date.now()) + VALIDADE_DO_PAREAMENTO_MS,
  ).toISOString();
};

/**
 * Reserva o direito de pedir um código de pareamento por telefone neste
 * pareamento: um a cada 30 segundos e no máximo 5. A contagem mora em colunas só do
 * servidor e a escrita é condicional ao valor lido (duas abas pedindo ao mesmo
 * tempo: só uma passa). Devolve a falha, ou `null` quando pode seguir.
 */
async function reservarPedidoDeCodigo(
  admin: SupabaseClient,
  linha: LinhaDoPareamento,
): Promise<FalhaDoPareamento | null> {
  const feitos = linha.pareamento_qr_codigos ?? 0;
  const ultimo = linha.pareamento_qr_codigo_em;
  if (feitos >= LIMITE_DE_CODIGOS_POR_PAREAMENTO) {
    return falha(
      429,
      "rate_limited",
      "Já foram pedidos códigos demais neste pareamento. Leia o QR Code ou comece de novo.",
    );
  }
  const esperar = falha(429, "rate_limited", "Aguarde 30 segundos para pedir outro código.");
  if (ultimo && Date.now() - Date.parse(ultimo) < INTERVALO_ENTRE_CODIGOS_MS) return esperar;

  let consulta = admin
    .from("channel_sessions")
    .update({ pareamento_qr_codigos: feitos + 1, pareamento_qr_codigo_em: new Date().toISOString() })
    .eq("organization_id", linha.organization_id)
    .eq("id", linha.id)
    .eq("pareamento_qr_codigos", feitos);
  consulta = ultimo
    ? consulta.eq("pareamento_qr_codigo_em", ultimo)
    : consulta.is("pareamento_qr_codigo_em", null);
  const { data, error } = await consulta.select("id");
  if (error) {
    logger.error("[pareamento-qr] o pedido de código não foi registrado", {
      code: error.code ?? "sem_codigo",
    });
    return falha(500, "internal_error", "Não foi possível gerar o código agora. Tente de novo.");
  }
  return Array.isArray(data) && data.length > 0 ? null : esperar;
}

// ---------------------------------------------------------------------------
// Iniciar
// ---------------------------------------------------------------------------

export async function iniciarPareamento(
  admin: SupabaseClient,
  input: {
    organizationId: string;
    telefone?: string | null;
    /** Para concluir, na limpeza, um pendente que conectou depois de a aba fechar. */
    urlDoWebhook?: ((pathToken: string) => string) | null;
    /** Idioma de quem pediu, só para a frase de recusa do plano. */
    idioma?: Idioma;
  },
): Promise<({ ok: true } & PareamentoEmAndamento) | FalhaDoPareamento> {
  const cfg = await configuracaoDoPareamento();
  if (!cfg) return falha(404, "not_found", "Recurso indisponível nesta instalação.");

  const orgId = input.organizationId;
  const telefone = input.telefone?.replace(/\D/g, "") || null;
  if (telefone && !/^\d{10,15}$/.test(telefone)) {
    return falha(422, "invalid_request", "Informe o número com DDI e DDD, só dígitos.");
  }

  // Pendente vencido libera a vaga antes de reservar.
  await limparPareamentosVencidos(admin, {
    organizationId: orgId,
    urlDoWebhook: input.urlDoWebhook ?? null,
  }).catch(() => undefined);

  const sessaoId = randomUUID();
  const nome = nomeDaInstancia(orgId, sessaoId);
  const agora = new Date().toISOString();

  // 1) A linha, primeiro, por reserva atômica no banco: sob trava da organização ela
  // confere os dois pendentes e o teto de instâncias, e o gatilho do plano (PT402)
  // recusa o excedente antes de existir qualquer instância.
  const { data: reserva, error: erroDaLinha } = await admin.rpc("fn_channel_pareamento_qr_reservar", {
    p_organization_id: orgId,
    p_session_id: sessaoId,
    p_base_url: cfg.servidor,
    p_webhook_path_token: randomBytes(24).toString("hex"),
    p_metadata: metadataInicialDoCanal(),
  });
  if (erroDaLinha) {
    const recusa = recusaDoPlano(erroDaLinha);
    if (recusa) {
      const mensagem = await mensagemDaRecusaDoPlano(recusa, admin, orgId, input.idioma);
      return falha(STATUS_RECUSA_DO_PLANO, "plano_limite_atingido", mensagem);
    }
    logger.error("[pareamento-qr] a sessão não foi criada", {
      code: erroDaLinha.code ?? "sem_codigo",
    });
    return falha(500, "internal_error", "Não foi possível iniciar a conexão agora. Tente de novo.");
  }
  const resultadoDaReserva = (reserva ?? null) as { ok?: boolean; codigo?: string; do_plano?: boolean } | null;
  if (!resultadoDaReserva?.ok) {
    if (resultadoDaReserva?.codigo === "pendentes_demais") {
      return falha(
        429,
        "rate_limited",
        "Já há dois pareamentos em andamento. Conclua ou cancele um deles antes de começar outro.",
      );
    }
    if (resultadoDaReserva?.codigo === "taxa_de_criacao") {
      // O freio do banco (10 criações por hora, arquivadas inclusive): vale mesmo quando o contador da
      // borda, que cada processo do app tem o seu, deixou passar.
      return falha(
        429,
        "rate_limited",
        "Muitas tentativas de conectar. Aguarde um pouco antes de gerar outro QR Code.",
      );
    }
    if (resultadoDaReserva?.codigo === "teto_de_instancias" && resultadoDaReserva.do_plano) {
      // D-188: o teto é o limite de Conexões do plano (todos os canais somados); 402 com a frase do plano.
      return falha(
        STATUS_RECUSA_DO_PLANO,
        "plano_limite_atingido",
        await mensagemDoLimiteDeConexoes(admin, orgId, input.idioma),
      );
    }
    if (resultadoDaReserva?.codigo === "teto_de_instancias") {
      return falha(
        409,
        "state_conflict",
        "Esta empresa chegou ao limite de números que o CRM conecta por QR Code. Remova uma conexão antes de criar outra.",
      );
    }
    return falha(500, "internal_error", "Não foi possível iniciar a conexão agora. Tente de novo.");
  }

  const credencial = { servidor: cfg.servidor, adminToken: cfg.adminToken };
  const desistir = async (token: string | null, instanceId: string | null) =>
    desfazer(admin, {
      organizationId: orgId,
      sessaoId,
      baseUrl: cfg.servidor,
      token,
      credencial,
      instanceId,
    });

  // 2) A instância no servidor.
  const criada = await criarInstanciaNoServidor(cfg, nome);
  if (!criada.ok) {
    if (criada.motivo === "incerta") await desistir(null, null);
    else await arquivarSessao(admin, orgId, sessaoId);
    if (criada.motivo === "token_recusado") {
      return falha(
        502,
        "upstream_unavailable",
        "O servidor de WhatsApp recusou o token de administrador. Avise quem cuida da instalação.",
      );
    }
    if (criada.motivo === "limite_do_servidor") {
      return falha(
        503,
        "upstream_unavailable",
        "O servidor de WhatsApp chegou ao limite de números. Avise quem cuida da instalação.",
      );
    }
    if (criada.motivo === "recusada") {
      return falha(
        502,
        "upstream_unavailable",
        "O servidor de WhatsApp recusou criar a conexão. Avise quem cuida da instalação.",
      );
    }
    return falha(502, "upstream_unavailable", FRASE_SERVIDOR_FORA);
  }

  // 3) Guardar o token cifrado ANTES de qualquer outra coisa: sem ele a instância é órfã.
  const tokenCifrado = await encryptWebhookSecret(admin, criada.token);
  if (!tokenCifrado) {
    await desistir(criada.token, criada.instanceId);
    return falha(
      422,
      "invalid_request",
      "A cifra desta instalação não está disponível, então nada foi conectado.",
    );
  }
  // A escrita é CONDICIONAL: só vale para a linha que ainda é pendente e não foi arquivada. Se o cliente
  // cancelou (ou a limpeza arquivou) enquanto a instância era criada, nenhuma linha muda e a instância
  // recém-criada não tem mais dono: é apagada aqui, pelo token que acabou de chegar.
  const { data: gravadas, error: erroDoToken } = await admin
    .from("channel_sessions")
    .update({
      uazapi_instance_id: criada.instanceId,
      uazapi_token_encrypted: tokenCifrado,
      // Mesmo token nas duas colunas, escritas juntas (ver `salvarConexaoUazapi`).
      webhook_secret_encrypted: tokenCifrado,
    })
    .eq("organization_id", orgId)
    .eq("id", sessaoId)
    .is("archived_at", null)
    .eq("pareamento_qr_estado", "pendente")
    .select("id");
  if (erroDoToken) {
    await desistir(criada.token, criada.instanceId);
    return falha(500, "internal_error", "Não foi possível iniciar a conexão agora. Tente de novo.");
  }
  if (!Array.isArray(gravadas) || gravadas.length === 0) {
    // Não usa `desistir`: a linha já foi arquivada por quem cancelou, e arquivar de novo mudaria a data.
    let apagada = await apagarInstanciaNoServidor({ baseUrl: cfg.servidor, token: criada.token });
    if (!apagada) apagada = await apagarInstanciaPeloNome(credencial, nome, criada.instanceId);
    if (!apagada) {
      logger.warn("[pareamento-qr] instância possivelmente órfã no servidor", { instancia: nome });
    }
    return falha(
      409,
      "state_conflict",
      "O pareamento foi cancelado antes de terminar. Gere um novo QR Code.",
    );
  }

  // 4) Pedir o QR (ou o código de pareamento, com o número).
  const conexao = await pedirConexao(cfg.servidor, criada.token, telefone);
  if (!conexao.ok) {
    await desistir(criada.token, criada.instanceId);
    return falha(502, "upstream_unavailable", FRASE_SERVIDOR_FORA);
  }
  await atualizarSessao(
    admin,
    orgId,
    sessaoId,
    // O primeiro código pedido já conta para o limite do pareamento.
    telefone ? { pareamento_qr_codigos: 1, pareamento_qr_codigo_em: new Date().toISOString() } : {},
    { [META_TENTATIVA_EM]: new Date().toISOString() },
  );

  return {
    ok: true,
    id: sessaoId,
    estado: "aguardando",
    qr: conexao.qr,
    codigo: conexao.codigo,
    expira_em: expiraEm(agora),
  };
}

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------

/**
 * Pergunta ao servidor como está o pareamento e, se o número conectou, CONCLUI a
 * conexão (grava, liga a volta das mensagens); se passou do prazo sem conectar,
 * desfaz. Tem efeito colateral: a rota que a chama é POST.
 */
export async function estadoDoPareamento(
  admin: SupabaseClient,
  input: {
    organizationId: string;
    id: string;
    /** Monta a URL pública de entrega a partir do token de caminho; `null` quando o CRM não tem endereço público. */
    urlDoWebhook: ((pathToken: string) => string) | null;
  },
): Promise<EstadoDoPareamento | FalhaDoPareamento> {
  const linha = await acharSessao(admin, input.organizationId, input.id);
  if (!linha) return falha(404, "not_found", "Conexão não encontrada.");

  // Já concluído (outra aba, ou a limpeza): devolve o resultado, sem falar com o servidor.
  if (!pareamentoEstaPendente(linha)) return jaConcluido(linha);

  const iniciadoEm = linha.pareamento_qr_iniciado_em;
  const token = await tokenDaSessao(admin, linha);
  if (!token || !linha.uazapi_base_url) {
    return falha(502, "upstream_unavailable", FRASE_SERVIDOR_FORA);
  }
  const lida = await lerInstancia(linha.uazapi_base_url, token);
  if (!lida) return falha(502, "upstream_unavailable", FRASE_SERVIDOR_FORA);

  // Conectou: vale mesmo passado o prazo (o cliente leu o QR no último minuto).
  if (lida.estado === "connected") {
    return concluir(admin, linha, token, lida, input.urlDoWebhook, await configuracaoDoPareamento());
  }

  if (vencido(iniciadoEm)) {
    await desfazerDaLinha(admin, linha, await configuracaoDoPareamento());
    return falha(404, "not_found", "Este pareamento expirou. Comece de novo.");
  }

  const tentativaEm = str((linha.metadata ?? {})[META_TENTATIVA_EM]);
  const recemPedido =
    tentativaEm !== null && Date.now() - Date.parse(tentativaEm) < CARENCIA_DO_PRIMEIRO_ESTADO_MS;
  const parado = (lida.estado === "disconnected" || lida.estado === "hibernated") && !recemPedido;
  return {
    id: linha.id,
    estado: parado ? "expirado" : "aguardando",
    qr: parado ? null : lida.qr,
    codigo: parado ? null : lida.codigo,
    expira_em: expiraEm(iniciadoEm),
  };
}

/** O resultado de um pareamento que OUTRA chamada já concluiu: nada a refazer, nada a auditar. */
function jaConcluido(linha: LinhaDoPareamento): PareamentoConcluido {
  return {
    id: linha.id,
    estado: "conectado",
    conexao: {
      id: linha.id,
      displayName: linha.display_name ?? "WhatsApp",
      phoneNumber: linha.phone_number,
      status: linha.status ?? "WORKING",
    },
    webhook: {
      registrado: !!str((linha.metadata ?? {})[UAZAPI_METADATA_WEBHOOK_ID]),
      aviso: str((linha.metadata ?? {})[META_AVISO]),
    },
    concluiuAgora: false,
  };
}

/** Gerar outro QR (ou código): pede a conexão de novo na MESMA instância. */
export async function renovarPareamento(
  admin: SupabaseClient,
  input: { organizationId: string; id: string; telefone?: string | null },
): Promise<PareamentoEmAndamento | FalhaDoPareamento> {
  const linha = await acharSessao(admin, input.organizationId, input.id);
  if (!linha) return falha(404, "not_found", "Conexão não encontrada.");
  if (!pareamentoEstaPendente(linha))
    return falha(409, "state_conflict", "Esta conexão já foi concluída.");

  const iniciadoEm = linha.pareamento_qr_iniciado_em;
  if (vencido(iniciadoEm)) {
    await desfazerDaLinha(admin, linha, await configuracaoDoPareamento());
    return falha(404, "not_found", "Este pareamento expirou. Comece de novo.");
  }

  const telefone = input.telefone?.replace(/\D/g, "") || null;
  if (telefone && !/^\d{10,15}$/.test(telefone)) {
    return falha(422, "invalid_request", "Informe o número com DDI e DDD, só dígitos.");
  }
  const token = await tokenDaSessao(admin, linha);
  if (!token || !linha.uazapi_base_url)
    return falha(502, "upstream_unavailable", FRASE_SERVIDOR_FORA);

  // Código por telefone: um a cada 30 s e no máximo 5 por pareamento.
  if (telefone) {
    const limite = await reservarPedidoDeCodigo(admin, linha);
    if (limite) return limite;
  }

  const conexao = await pedirConexao(linha.uazapi_base_url, token, telefone);
  if (!conexao.ok) return falha(502, "upstream_unavailable", FRASE_SERVIDOR_FORA);
  await atualizarSessao(admin, input.organizationId, linha.id, {}, {
    [META_TENTATIVA_EM]: new Date().toISOString(),
  });

  return {
    id: linha.id,
    estado: "aguardando",
    qr: conexao.qr,
    codigo: conexao.codigo,
    expira_em: expiraEm(iniciadoEm),
  };
}

// ---------------------------------------------------------------------------
// Cancelar
// ---------------------------------------------------------------------------

export async function cancelarPareamento(
  admin: SupabaseClient,
  input: { organizationId: string; id: string },
): Promise<{ ok: true; instanciaApagada: boolean } | FalhaDoPareamento> {
  const linha = await acharSessao(admin, input.organizationId, input.id);
  if (!linha) return falha(404, "not_found", "Conexão não encontrada.");
  // Conectada: apagar é "Remover conexão", que pede confirmação e é outro fluxo.
  if (!pareamentoEstaPendente(linha)) {
    return falha(
      409,
      "state_conflict",
      "Esta conexão já foi concluída. Para desligá-la, use Remover conexão.",
    );
  }
  // A instância ainda está sendo criada no servidor (o id é o provisório): arquivar agora deixaria a
  // instância órfã, porque o token só chega depois. Só o cancelamento do usuário espera; a limpeza dos
  // vencidos (`limparPareamentosVencidos`) não passa por aqui e consegue limpar um pendente velho.
  if (linha.uazapi_instance_id?.startsWith("pendente-")) {
    return falha(
      409,
      "state_conflict",
      "A conexão ainda está sendo criada. Aguarde alguns segundos e tente de novo.",
    );
  }
  const desfeito = await desfazerDaLinha(admin, linha, await configuracaoDoPareamento());
  return { ok: true, instanciaApagada: desfeito.apagada };
}

/**
 * O pareamento pendente mais recente e ainda dentro do prazo da organização, para
 * a tela retomar após recarregar. SÓ LÊ: quem limpa o vencido é o cron e o
 * `iniciar`, nunca uma consulta.
 */
export async function pareamentoPendenteDaOrganizacao(
  admin: SupabaseClient,
  organizationId: string,
): Promise<{ id: string; expira_em: string } | null> {
  const corte = new Date(Date.now() - VALIDADE_DO_PAREAMENTO_MS).toISOString();
  const { data, error } = await admin
    .from("channel_sessions")
    .select("id, pareamento_qr_iniciado_em")
    .eq("organization_id", organizationId)
    .eq("provider", CHANNEL_PROVIDER_UAZAPI)
    .is("archived_at", null)
    .eq("pareamento_qr_estado", "pendente")
    .gte("pareamento_qr_iniciado_em", corte)
    .order("pareamento_qr_iniciado_em", { ascending: false })
    .limit(1);
  if (error) throw new Error(`pareamento_listar_pendentes_falhou: ${error.code ?? ""}`.trim());
  const ultimo = (data ?? [])[0] as { id: string; pareamento_qr_iniciado_em: string | null } | undefined;
  return ultimo ? { id: ultimo.id, expira_em: expiraEm(ultimo.pareamento_qr_iniciado_em) } : null;
}

// ---------------------------------------------------------------------------
// Pendentes e limpeza
// ---------------------------------------------------------------------------

function pareamentoEstaPendente(linha: LinhaDoPareamento): boolean {
  return linha.pareamento_qr_estado === "pendente";
}

function vencido(iniciadoEm: string | null): boolean {
  const inicio = iniciadoEm ? Date.parse(iniciadoEm) : NaN;
  // Sem data legível não há como saber a idade: trata como vencido, para não prender a vaga.
  return !Number.isFinite(inicio) || Date.now() - inicio > VALIDADE_DO_PAREAMENTO_MS;
}

/**
 * Limpa os pareamentos pendentes há mais de 30 minutos: se o número conectou no
 * meio tempo (a aba fechou depois de ler o QR), a conexão é concluída; senão a
 * instância é apagada e a linha arquivada. Sem `organizationId`, varre todas
 * (cron). Cada pendência é tratada isoladamente: uma falha não para as outras.
 *
 * O vencimento é filtrado NA CONSULTA, pela coluna `pareamento_qr_iniciado_em`
 * (só o servidor a grava), e a linha que já falhou `LIMITE_DE_FALHAS_DA_LIMPEZA`
 * rodadas sai do lote. `falhas` conta toda pendência que não terminou bem: a
 * instância que não se confirmou apagada, a conclusão que não gravou (o número já
 * estava conectado na empresa), a exceção no meio.
 */
export async function limparPareamentosVencidos(
  admin: SupabaseClient,
  input: { organizationId?: string; urlDoWebhook: ((pathToken: string) => string) | null },
): Promise<{ limpos: number; concluidos: number; falhas: number }> {
  const corte = new Date(Date.now() - VALIDADE_DO_PAREAMENTO_MS).toISOString();
  let consulta = admin
    .from("channel_sessions")
    .select(COLUNAS)
    .eq("provider", CHANNEL_PROVIDER_UAZAPI)
    .is("archived_at", null)
    .eq("pareamento_qr_estado", "pendente")
    .lt("pareamento_qr_iniciado_em", corte)
    .lt("pareamento_qr_falhas", LIMITE_DE_FALHAS_DA_LIMPEZA);
  if (input.organizationId) consulta = consulta.eq("organization_id", input.organizationId);
  const { data, error } = await consulta
    .order("pareamento_qr_iniciado_em", { ascending: true })
    .limit(LOTE_DA_LIMPEZA);
  if (error) throw new Error(`pareamento_limpeza_falhou: ${error.code ?? ""}`.trim());

  const cfg = await configuracaoDoPareamento();
  let limpos = 0;
  let concluidos = 0;
  let falhas = 0;
  for (const linha of (data ?? []) as unknown as LinhaDoPareamento[]) {
    const ultimaTentativa = (linha.pareamento_qr_falhas ?? 0) + 1 >= LIMITE_DE_FALHAS_DA_LIMPEZA;
    try {
      const token = await tokenDaSessao(admin, linha);
      const lida =
        token && linha.uazapi_base_url ? await lerInstancia(linha.uazapi_base_url, token) : null;
      if (token && lida?.estado === "connected") {
        const r = await concluir(admin, linha, token, lida, input.urlDoWebhook, cfg);
        if ("ok" in r) falhas++;
        else concluidos++;
        continue;
      }
      const desfeito = await desfazerDaLinha(admin, linha, cfg, { arquivarSempre: ultimaTentativa });
      if (desfeito.apagada) {
        limpos++;
        continue;
      }
      falhas++;
      if (!desfeito.arquivada) await registrarFalhaDaLimpeza(admin, linha);
    } catch (erro) {
      falhas++;
      logger.error("[pareamento-qr] falha ao limpar um pendente", {
        detail: erro instanceof Error ? erro.message : "erro",
      });
      // Última chance: arquiva para a vaga não ficar presa para sempre.
      if (ultimaTentativa) await arquivarSessao(admin, linha.organization_id, linha.id).catch(() => undefined);
      else await registrarFalhaDaLimpeza(admin, linha).catch(() => undefined);
    }
  }
  return { limpos, concluidos, falhas };
}

/** Conta mais uma rodada de limpeza que falhou nesta linha (coluna só do servidor). */
async function registrarFalhaDaLimpeza(
  admin: SupabaseClient,
  linha: LinhaDoPareamento,
): Promise<void> {
  await atualizarSessao(admin, linha.organization_id, linha.id, {
    pareamento_qr_falhas: (linha.pareamento_qr_falhas ?? 0) + 1,
  });
}

// ---------------------------------------------------------------------------
// Concluir (o número conectou)
// ---------------------------------------------------------------------------

async function concluir(
  admin: SupabaseClient,
  linha: LinhaDoPareamento,
  token: string,
  lida: InstanciaLida,
  urlDoWebhook: ((pathToken: string) => string) | null,
  cfg: ConfiguracaoDoPareamento | null,
): Promise<PareamentoConcluido | FalhaDoPareamento> {
  const nome = lida.perfil ?? linha.display_name ?? "WhatsApp";
  // Atualização CONDICIONAL: só muda a linha que ainda é pendente e não foi arquivada, e devolve o que
  // mudou. Duas chamadas ao mesmo tempo (duas abas, ou a aba e a limpeza) leem a mesma linha pendente;
  // só a que de fato a muda liga a volta (webhook) e vai para a auditoria. A outra recebe o resultado.
  const { data: mudadas, error: erroDoBanco } = await admin
    .from("channel_sessions")
    .update({
      status: "WORKING",
      phone_number: lida.telefone,
      display_name: nome,
      pareamento_qr_estado: "concluido",
    })
    .eq("organization_id", linha.organization_id)
    .eq("id", linha.id)
    .eq("pareamento_qr_estado", "pendente")
    .is("archived_at", null)
    .select("id");
  const erro = erroDoBanco ? (erroDoBanco.code ?? erroDoBanco.message ?? "erro") : null;
  if (!erro && (!Array.isArray(mudadas) || mudadas.length === 0)) {
    // Outra chamada concluiu (ou o pareamento foi cancelado ou arquivado no meio tempo): não é desta.
    const atual = await acharSessao(admin, linha.organization_id, linha.id).catch(() => null);
    if (atual && !pareamentoEstaPendente(atual)) return jaConcluido(atual);
    return falha(409, "state_conflict", "Este pareamento já foi encerrado. Comece de novo.");
  }
  if (erro) {
    // Não gravou (ex.: 23505 no índice de número único por empresa, porque este número
    // já está ativo aqui): a instância criada não tem dono. Apaga no servidor e arquiva
    // a linha, em vez de deixar um WhatsApp pago sem registro.
    await desfazerDaLinha(admin, linha, cfg);
    if (erro === "23505") {
      return falha(
        409,
        "state_conflict",
        "Este número já está conectado nesta empresa. A conexão que acabou de ser lida foi desfeita.",
      );
    }
    return falha(
      500,
      "internal_error",
      "Conectou, mas não foi possível gravar a conexão. A leitura foi desfeita; gere um novo QR Code.",
    );
  }

  let registrado = false;
  let aviso: string | null = null;
  const url =
    urlDoWebhook && linha.webhook_path_token ? urlDoWebhook(linha.webhook_path_token) : null;
  if (!url || enderecoNaoAlcancavel(url)) {
    aviso =
      "O endereço público do CRM não está configurado. A conexão foi gravada e envia, mas as mensagens não vão chegar até o endereço ser público.";
  } else if (linha.uazapi_base_url) {
    const reg = await registrarWebhookUazapi({ baseUrl: linha.uazapi_base_url, token, url });
    if (reg.ok) {
      registrado = !!reg.webhookId;
      await gravarWebhookDaConexao(admin, linha.organization_id, linha.id, reg.webhookId);
    } else {
      aviso = reg.reason;
    }
  }
  if (aviso)
    await atualizarSessao(admin, linha.organization_id, linha.id, {}, { [META_AVISO]: aviso });

  return {
    id: linha.id,
    estado: "conectado",
    conexao: { id: linha.id, displayName: nome, phoneNumber: lida.telefone, status: "WORKING" },
    webhook: { registrado, aviso },
    concluiuAgora: true,
  };
}
