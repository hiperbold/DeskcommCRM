/**
 * Repositório das conexões MCP externas (`ai_mcp_connections`).
 *
 * ─── A ordem: validar, testar, SÓ ENTÃO gravar ──────────────────────────────
 *
 * Mesma regra das outras conexões do repo (`lib/channels/instancia.ts`):
 * gravar antes de testar faz a tela mostrar "conectado" para um servidor que
 * nunca respondeu, e o operador só descobre na primeira ferramenta que falha.
 * Por isso `criarConexao` abre a sessão MCP de verdade ANTES do insert, e
 * fecha essa sessão de teste em todo caminho (`finally`) — o SDK não fecha
 * sozinho o transporte quando `connect()` falha (ver `cliente.ts`), e uma
 * sessão SSE esquecida reconecta pra sempre.
 *
 * ─── Por que o cabeçalho é checado aqui e não só dentro de `abrirSessao` ────
 *
 * `abrirSessao` valida `cabecalhoPermitido`/`valorDeCabecalhoValido` antes de
 * conectar, o que já cobre `criarConexao` (que sempre conecta). Mas
 * `editarConexao` pode trocar o cabeçalho SEM reconectar (só "Atualizar
 * ferramentas" reconecta) — sem a mesma checagem aqui, um nome de cabeçalho
 * proibido ou um valor com quebra de linha gravaria direto, e só apareceria
 * na próxima vez que o turno tentasse usar a ferramenta.
 *
 * ─── `motivoLegivel` em toda mensagem que sai daqui ─────────────────────────
 *
 * `last_error`, o motivo devolvido pela API e o que a tela mostra nunca são
 * `err.message` cru: o texto de erro pode ecoar o que o servidor de terceiro
 * respondeu (URL, cabeçalho, corpo). Só a frase fixa de `motivoLegivel` sai
 * daqui.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  abrirSessao,
  cabecalhoPermitido,
  listarFerramentas,
  motivoLegivel,
  valorDeCabecalhoValido,
  type Sessao,
} from "./cliente";
import { apelidoValido } from "./ids";
import type { ConexaoPublica, FerramentaEmCache } from "./tipos";
import { decryptWebhookSecret, encryptWebhookSecret } from "@/lib/webhooks/secrets";

export const MAXIMO_DE_CONEXOES = 10;

const MOTIVO_APELIDO_INVALIDO = "O apelido usa só letras minúsculas e números, de 2 a 12";
const MOTIVO_APELIDO_REPETIDO = "Já existe uma conexão com este apelido";
const MOTIVO_NOME_TAMANHO = "O nome precisa ter de 2 a 80 caracteres";
const MOTIVO_LIMITE = "Limite de 10 conexões por organização";
const MOTIVO_CIFRA_INDISPONIVEL = "cifra indisponível nesta instalação, o cabeçalho não foi gravado";
const MOTIVO_CABECALHO_PROIBIDO = "Este nome de cabeçalho não é permitido (use Authorization ou X-*).";
const MOTIVO_CABECALHO_INVALIDO =
  "A chave de acesso tem caracteres inválidos (quebra de linha ou espaço no início). Cole de novo.";
const MOTIVO_URL_COM_CREDENCIAL = "Não coloque usuário e senha no endereço. Use o campo de cabeçalho.";
const MOTIVO_CHAVE_ILEGIVEL = "A chave de acesso salva não pôde ser lida. Cadastre a chave de novo.";
const MOTIVO_NAO_ENCONTRADA = "Conexão não encontrada";
const MOTIVO_CONFLITO_DE_ESCRITA = "A conexão foi alterada por outra pessoa enquanto atualizava. Tente de novo.";
/** Código Postgres de violação de unicidade (`ai_mcp_connections_org_slug_key`). */
const CODIGO_UNIQUE_VIOLATION = "23505";
/** Código PostgREST quando `.single()` não encontra nenhuma linha (0 casaram). */
const CODIGO_SEM_LINHAS = "PGRST116";

const COLUNAS =
  "id, slug, name, url, auth_header_name, auth_header_value_encrypted, is_active, tools_cache, tools_refreshed_at, last_error, updated_at";

/** Forma da linha lida de `ai_mcp_connections` pelas colunas de `COLUNAS`. */
interface LinhaDaConexao {
  id: string;
  slug: string;
  name: string;
  url: string;
  auth_header_name: string | null;
  auth_header_value_encrypted: string | null;
  is_active: boolean;
  tools_cache: FerramentaEmCache[];
  tools_refreshed_at: string | null;
  last_error: string | null;
  /** Trava otimista de `atualizarFerramentas`: ver o cabeçalho da função. */
  updated_at: string;
}

type Cabecalho = { nome: string; valor: string } | null;

export type ResultadoDaConexao =
  | { ok: true; conexao: ConexaoPublica }
  | { ok: false; status: 409 | 422; motivo: string };

export type ResultadoDaEdicao =
  | { ok: true; conexao: ConexaoPublica }
  | { ok: false; status: 404 | 422; motivo: string };

/**
 * `atualizarFerramentas` grava `tools_cache` sob trava otimista (M1): o 409 é
 * a corrida perdida, não um erro do chamador, então é um status a mais no
 * mesmo formato de `ResultadoDaEdicao`, não um tipo à parte.
 */
export type ResultadoDaAtualizacao =
  | { ok: true; conexao: ConexaoPublica }
  | { ok: false; status: 404 | 409 | 422; motivo: string };

export type ResultadoDaRemocao = { ok: true } | { ok: false; status: 404; motivo: string };

/**
 * A origem (esquema + host + porta), mais "/…" se houver caminho além de "/"
 * ou busca. `paraPublica` usa para nunca devolver a URL inteira: caminho e
 * query podem carregar um token de acesso que a URL não cifra (só o
 * cabeçalho passa por `fn_encrypt_oauth`).
 */
export function mascararUrl(url: string): string {
  try {
    const alvo = new URL(url);
    const temMais = (alvo.pathname !== "" && alvo.pathname !== "/") || alvo.search !== "";
    return temMais ? `${alvo.origin}/…` : alvo.origin;
  } catch {
    // Não deveria acontecer (a URL já foi validada antes de gravar), mas
    // devolver o texto cru aqui seria pior que uma máscara incompleta.
    return url;
  }
}

/** Linha → o que a API pode devolver. Nunca o valor do cabeçalho, nem a URL inteira. */
export function paraPublica(linha: LinhaDaConexao): ConexaoPublica {
  return {
    id: linha.id,
    apelido: linha.slug,
    nome: linha.name,
    url: mascararUrl(linha.url),
    tem_cabecalho: linha.auth_header_name !== null,
    cabecalho_nome: linha.auth_header_name,
    ativa: linha.is_active,
    ferramentas: linha.tools_cache,
    ferramentas_atualizadas_em: linha.tools_refreshed_at,
    ultimo_erro: linha.last_error,
  };
}

export async function listarConexoes(admin: SupabaseClient, organizationId: string): Promise<ConexaoPublica[]> {
  const { data, error } = await admin
    .from("ai_mcp_connections")
    .select(COLUNAS)
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`ai_mcp_connections_listar_falhou: ${error.message}`);
  return ((data ?? []) as unknown as LinhaDaConexao[]).map(paraPublica);
}

async function buscarLinha(
  admin: SupabaseClient,
  organizationId: string,
  id: string,
): Promise<LinhaDaConexao | null> {
  const { data, error } = await admin
    .from("ai_mcp_connections")
    .select(COLUNAS)
    .eq("id", id)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) throw new Error(`ai_mcp_connections_buscar_falhou: ${error.message}`);
  return (data as unknown as LinhaDaConexao | null) ?? null;
}

/**
 * Checa nome e valor do cabeçalho ANTES de qualquer gravação ou conexão. Ver
 * o cabeçalho do arquivo: `abrirSessao` checa de novo por dentro, mas nem
 * todo caminho (edição sem reconectar) passa por `abrirSessao`.
 */
function erroDoCabecalho(cabecalho: Cabecalho): string | null {
  if (!cabecalho) return null;
  if (!cabecalhoPermitido(cabecalho.nome)) return MOTIVO_CABECALHO_PROIBIDO;
  if (!valorDeCabecalhoValido(cabecalho.valor)) return MOTIVO_CABECALHO_INVALIDO;
  return null;
}

/** 2 a 80 caracteres (mesma faixa da checagem `ai_mcp_connections_nome_tamanho` da migration), já sem espaço nas pontas. */
function nomeValido(nome: string): boolean {
  const tamanho = nome.trim().length;
  return tamanho >= 2 && tamanho <= 80;
}

/**
 * `https://usuario:senha@host/...` — alguém colou uma credencial dentro do
 * endereço em vez de usar o campo de cabeçalho. Isso vai para `url`, que
 * NÃO é cifrada (só o cabeçalho passa por `fn_encrypt_oauth`), e reaparece
 * inteira em log de acesso e no `last_error` de qualquer falha de rede.
 */
function urlTemCredencial(url: string): boolean {
  try {
    const alvo = new URL(url);
    return alvo.username !== "" || alvo.password !== "";
  } catch {
    return false;
  }
}

/**
 * As ferramentas recém-lidas, com `somente_leitura_confirmado` herdado da
 * confirmação anterior quando nome, descrição E esquema não mudaram — e
 * `null` (sem decisão) para ferramenta nova ou que mudou. `anteriores: []`
 * (conexão nova) já cai no caso "mudou" para todas, então serve tanto para
 * `criarConexao` quanto para `atualizarFerramentas`.
 */
function combinarComConfirmacaoAnterior(
  anteriores: readonly FerramentaEmCache[],
  novas: readonly FerramentaEmCache[],
): FerramentaEmCache[] {
  const porNome = new Map(anteriores.map((f) => [f.nome, f] as const));
  return novas.map((f) => {
    const antiga = porNome.get(f.nome);
    const mudou =
      !antiga ||
      antiga.descricao !== f.descricao ||
      JSON.stringify(antiga.input_schema) !== JSON.stringify(f.input_schema);
    return { ...f, somente_leitura_confirmado: mudou ? null : (antiga.somente_leitura_confirmado ?? null) };
  });
}

/** Abre, lista as ferramentas e SEMPRE fecha a sessão de teste, mesmo em erro. */
async function testarConexao(
  abrir: typeof abrirSessao,
  destino: { url: string; cabecalho: Cabecalho },
  apelido: string,
): Promise<FerramentaEmCache[]> {
  let sessao: Sessao | null = null;
  try {
    sessao = await abrir({ destino: { url: destino.url, cabecalho: destino.cabecalho } });
    return await listarFerramentas(sessao, apelido);
  } finally {
    // B4: fechar é limpeza, não o resultado da chamada. Um servidor que
    // aceita `tools/list` mas quebra no `close()` (ou um SSE que já morreu
    // por baixo) não pode transformar uma listagem que FUNCIONOU num erro
    // pra quem chamou — e como é `finally`, uma rejeição aqui sobrescreveria
    // silenciosamente o retorno ou o erro reais do `try`.
    if (sessao) await sessao.fechar().catch(() => {});
  }
}

/**
 * Valida, cifra o cabeçalho, conecta, lista as ferramentas e SÓ ENTÃO grava.
 * Servidor que não responde ou token errado = recusa com o motivo, nada
 * gravado.
 */
export async function criarConexao(
  admin: SupabaseClient,
  organizationId: string,
  userId: string | null,
  entrada: { apelido: string; nome: string; url: string; cabecalho: Cabecalho },
  deps: { abrir?: typeof abrirSessao } = {},
): Promise<ResultadoDaConexao> {
  const apelido = entrada.apelido.trim();
  if (!apelidoValido(apelido)) return { ok: false, status: 422, motivo: MOTIVO_APELIDO_INVALIDO };

  if (!nomeValido(entrada.nome)) return { ok: false, status: 422, motivo: MOTIVO_NOME_TAMANHO };
  const nome = entrada.nome.trim();

  const erroCabecalho = erroDoCabecalho(entrada.cabecalho);
  if (erroCabecalho) return { ok: false, status: 422, motivo: erroCabecalho };

  if (urlTemCredencial(entrada.url)) return { ok: false, status: 422, motivo: MOTIVO_URL_COM_CREDENCIAL };

  const { count, error: erroContagem } = await admin
    .from("ai_mcp_connections")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId);
  if (erroContagem) throw new Error(`ai_mcp_connections_contar_falhou: ${erroContagem.message}`);
  if ((count ?? 0) >= MAXIMO_DE_CONEXOES) return { ok: false, status: 422, motivo: MOTIVO_LIMITE };

  const { data: existente, error: erroExistente } = await admin
    .from("ai_mcp_connections")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("slug", apelido)
    .maybeSingle();
  if (erroExistente) throw new Error(`ai_mcp_connections_checar_apelido_falhou: ${erroExistente.message}`);
  if (existente) return { ok: false, status: 409, motivo: MOTIVO_APELIDO_REPETIDO };

  let cabecalhoCifrado: string | null = null;
  if (entrada.cabecalho) {
    cabecalhoCifrado = await encryptWebhookSecret(admin, entrada.cabecalho.valor);
    if (!cabecalhoCifrado) return { ok: false, status: 422, motivo: MOTIVO_CIFRA_INDISPONIVEL };
  }

  const abrir = deps.abrir ?? abrirSessao;
  let ferramentas: FerramentaEmCache[];
  try {
    ferramentas = await testarConexao(abrir, { url: entrada.url, cabecalho: entrada.cabecalho }, apelido);
  } catch (err) {
    return { ok: false, status: 422, motivo: motivoLegivel(err) };
  }

  const { data: inserida, error: erroInsercao } = await admin
    .from("ai_mcp_connections")
    .insert({
      organization_id: organizationId,
      slug: apelido,
      name: nome,
      url: entrada.url,
      auth_header_name: entrada.cabecalho?.nome ?? null,
      auth_header_value_encrypted: cabecalhoCifrado,
      tools_cache: combinarComConfirmacaoAnterior([], ferramentas),
      tools_refreshed_at: new Date().toISOString(),
      created_by: userId,
    })
    .select(COLUNAS)
    .single();
  if (erroInsercao) {
    // B2: a checagem de duplicidade acima não fecha a corrida (dois cliques
    // simultâneos passam pelo SELECT antes de qualquer um gravar); quem
    // resolve de verdade é a constraint `ai_mcp_connections_org_slug_key` no
    // banco, e o 23505 dela é o MESMO desfecho da checagem: 409 de apelido
    // repetido, nunca um 500 genérico pra uma corrida rara.
    if ((erroInsercao as { code?: string }).code === CODIGO_UNIQUE_VIOLATION) {
      return { ok: false, status: 409, motivo: MOTIVO_APELIDO_REPETIDO };
    }
    throw new Error(`ai_mcp_connections_inserir_falhou: ${erroInsercao.message}`);
  }
  if (!inserida) throw new Error("ai_mcp_connections_inserir_falhou: sem linha devolvida");
  return { ok: true, conexao: paraPublica(inserida as unknown as LinhaDaConexao) };
}

/**
 * Grava `{ last_error: motivo }` sem tocar em `tools_cache` (não precisa da
 * trava otimista: nenhuma decisão do admin se perde aqui) e devolve o motivo
 * como 422. Usado nos dois jeitos de `atualizarFerramentas` falhar ANTES de
 * conseguir uma lista nova de ferramentas.
 */
async function recusarComErroGravado(
  admin: SupabaseClient,
  organizationId: string,
  id: string,
  motivo: string,
): Promise<{ ok: false; status: 422; motivo: string }> {
  const { error } = await admin
    .from("ai_mcp_connections")
    .update({ last_error: motivo })
    .eq("id", id)
    .eq("organization_id", organizationId);
  if (error) throw new Error(`ai_mcp_connections_gravar_erro_falhou: ${error.message}`);
  return { ok: false, status: 422, motivo };
}

/**
 * Reconecta com o cabeçalho decifrado e regrava `tools_cache` +
 * `tools_refreshed_at`, ou grava `last_error` e mantém o cache anterior — a
 * lista de ferramentas em uso pelo agente não pode desaparecer só porque o
 * servidor está fora do ar no momento do clique.
 *
 * ─── M1: trava otimista na escrita de `tools_cache` ─────────────────────────
 *
 * Entre o `buscarLinha` (lê o cache velho) e o `update` abaixo (grava o cache
 * novo por CIMA dele) passa uma chamada de rede inteira — é tempo de sobra
 * para o admin confirmar "só consulta" numa ferramenta pela tela (Tarefa 11).
 * Sem o `.eq("updated_at", linha.updated_at)`, essa confirmação seria lida,
 * ignorada e sobrescrita pelo cache que este código já tinha em mãos antes
 * dela existir: um update perdido clássico. Com a trava, a escrita só
 * acontece se NINGUÉM tocou a linha nesse meio-tempo; senão, zero linhas
 * casam, o PostgREST devolve `PGRST116`, e a resposta é 409 (peça pro admin
 * tentar de novo) em vez de apagar silenciosamente o que a outra pessoa fez.
 */
export async function atualizarFerramentas(
  admin: SupabaseClient,
  organizationId: string,
  id: string,
  deps: { abrir?: typeof abrirSessao } = {},
): Promise<ResultadoDaAtualizacao> {
  const linha = await buscarLinha(admin, organizationId, id);
  if (!linha) return { ok: false, status: 404, motivo: MOTIVO_NAO_ENCONTRADA };

  let cabecalho: Cabecalho = null;
  if (linha.auth_header_name && linha.auth_header_value_encrypted) {
    const valor = await decryptWebhookSecret(admin, linha.auth_header_value_encrypted);
    // B1: chave que não decifra (chave mestra trocada, linha corrompida) NÃO
    // pode virar "conecta sem credencial" em silêncio — o servidor recusaria
    // (ou pior, aceitaria com outra identidade). Recusa aqui, sem tentar a rede.
    if (!valor) return recusarComErroGravado(admin, organizationId, id, MOTIVO_CHAVE_ILEGIVEL);
    cabecalho = { nome: linha.auth_header_name, valor };
  }

  const abrir = deps.abrir ?? abrirSessao;
  let ferramentas: FerramentaEmCache[];
  try {
    ferramentas = await testarConexao(abrir, { url: linha.url, cabecalho }, linha.slug);
  } catch (err) {
    return recusarComErroGravado(admin, organizationId, id, motivoLegivel(err));
  }

  const { data: atualizada, error: erroAtualizacao } = await admin
    .from("ai_mcp_connections")
    .update({
      tools_cache: combinarComConfirmacaoAnterior(linha.tools_cache, ferramentas),
      tools_refreshed_at: new Date().toISOString(),
      last_error: null,
    })
    .eq("id", id)
    .eq("organization_id", organizationId)
    .eq("updated_at", linha.updated_at)
    .select(COLUNAS)
    .single();
  if (erroAtualizacao) {
    if ((erroAtualizacao as { code?: string }).code === CODIGO_SEM_LINHAS) {
      return { ok: false, status: 409, motivo: MOTIVO_CONFLITO_DE_ESCRITA };
    }
    throw new Error(`ai_mcp_connections_atualizar_falhou: ${erroAtualizacao.message}`);
  }
  if (!atualizada) throw new Error("ai_mcp_connections_atualizar_falhou: sem linha devolvida");
  return { ok: true, conexao: paraPublica(atualizada as unknown as LinhaDaConexao) };
}

export async function editarConexao(
  admin: SupabaseClient,
  organizationId: string,
  id: string,
  patch: { nome?: string; ativa?: boolean; cabecalho?: Cabecalho },
): Promise<ResultadoDaEdicao> {
  const linha = await buscarLinha(admin, organizationId, id);
  if (!linha) return { ok: false, status: 404, motivo: MOTIVO_NAO_ENCONTRADA };

  const campos: Record<string, unknown> = {};
  if (patch.nome !== undefined) {
    if (!nomeValido(patch.nome)) return { ok: false, status: 422, motivo: MOTIVO_NOME_TAMANHO };
    campos.name = patch.nome.trim();
  }
  if (patch.ativa !== undefined) campos.is_active = patch.ativa;

  if (patch.cabecalho !== undefined) {
    if (patch.cabecalho === null) {
      campos.auth_header_name = null;
      campos.auth_header_value_encrypted = null;
    } else {
      const erroCabecalho = erroDoCabecalho(patch.cabecalho);
      if (erroCabecalho) return { ok: false, status: 422, motivo: erroCabecalho };
      const cifrado = await encryptWebhookSecret(admin, patch.cabecalho.valor);
      if (!cifrado) return { ok: false, status: 422, motivo: MOTIVO_CIFRA_INDISPONIVEL };
      campos.auth_header_name = patch.cabecalho.nome;
      campos.auth_header_value_encrypted = cifrado;
    }
  }

  const { data: atualizada, error } = await admin
    .from("ai_mcp_connections")
    .update(campos)
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select(COLUNAS)
    .single();
  if (error || !atualizada) throw new Error(`ai_mcp_connections_editar_falhou: ${error?.message ?? "sem linha devolvida"}`);
  return { ok: true, conexao: paraPublica(atualizada as unknown as LinhaDaConexao) };
}

export async function removerConexao(
  admin: SupabaseClient,
  organizationId: string,
  id: string,
): Promise<ResultadoDaRemocao> {
  const linha = await buscarLinha(admin, organizationId, id);
  if (!linha) return { ok: false, status: 404, motivo: MOTIVO_NAO_ENCONTRADA };

  const { error } = await admin
    .from("ai_mcp_connections")
    .delete()
    .eq("id", id)
    .eq("organization_id", organizationId);
  if (error) throw new Error(`ai_mcp_connections_remover_falhou: ${error.message}`);
  return { ok: true };
}

/**
 * Para o turno: as conexões ATIVAS dos apelidos pedidos, com o cabeçalho
 * decifrado.
 *
 * B1: conexão com cabeçalho que NÃO decifra fica de fora da lista (não entra
 * com `cabecalho: null`). É a diferença entre "esta ferramenta não precisa
 * de credencial" (legítimo, `auth_header_name` nunca existiu) e "a
 * credencial existe e está ilegível" (chave mestra trocada, linha
 * corrompida): incluir a segunda mandaria o turno chamar o servidor sem a
 * autenticação que ele exige, e um 401 no meio do turno é pior do que a
 * ferramenta simplesmente não aparecer.
 */
export async function carregarParaOTurno(
  admin: SupabaseClient,
  organizationId: string,
  apelidos: readonly string[],
): Promise<Array<{ apelido: string; url: string; cabecalho: Cabecalho; ferramentas: FerramentaEmCache[] }>> {
  if (apelidos.length === 0) return [];

  const { data, error } = await admin
    .from("ai_mcp_connections")
    .select("slug, url, auth_header_name, auth_header_value_encrypted, tools_cache")
    .eq("organization_id", organizationId)
    .eq("is_active", true)
    .in("slug", apelidos as string[]);
  if (error) throw new Error(`ai_mcp_connections_carregar_falhou: ${error.message}`);

  const linhas = (data ?? []) as unknown as Array<{
    slug: string;
    url: string;
    auth_header_name: string | null;
    auth_header_value_encrypted: string | null;
    tools_cache: FerramentaEmCache[];
  }>;

  const resultado: Array<{ apelido: string; url: string; cabecalho: Cabecalho; ferramentas: FerramentaEmCache[] }> = [];
  for (const linha of linhas) {
    let cabecalho: Cabecalho = null;
    if (linha.auth_header_name && linha.auth_header_value_encrypted) {
      const valor = await decryptWebhookSecret(admin, linha.auth_header_value_encrypted);
      if (!valor) continue; // B1: chave ilegível, a conexão inteira fica de fora do turno.
      cabecalho = { nome: linha.auth_header_name, valor };
    }
    resultado.push({ apelido: linha.slug, url: linha.url, cabecalho, ferramentas: linha.tools_cache });
  }
  return resultado;
}
