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
const MOTIVO_FERRAMENTA_NAO_ENCONTRADA = "Ferramenta não encontrada nesta conexão";
const MOTIVO_FERRAMENTA_RECUSADA = "Esta ferramenta foi recusada e não pode ser aprovada";
const MOTIVO_FERRAMENTA_DUPLICADA = "O servidor lista duas ferramentas com o mesmo nome; corrija no servidor MCP.";
const MOTIVO_VERSAO_DESATUALIZADA =
  "A lista de ferramentas mudou desde que você abriu a tela. Recarregue e aprove de novo.";
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
    atualizada_em: linha.updated_at,
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
 *
 * Também mantém `mudou_desde_aprovacao` (auditoria, Tarefa 11): fica `true`
 * quando a ferramenta TINHA uma decisão real (`true`/`false`, não `null`) e a
 * perdeu porque descrição ou esquema mudaram aqui — é o único lugar em que dá
 * pra saber isso, porque depois deste map o cache só guarda o valor NOVO de
 * `somente_leitura_confirmado`, que já é `null` tanto pra "nunca decidida"
 * quanto pra "decidida e mudou por baixo".
 */
function combinarComConfirmacaoAnterior(
  anteriores: readonly FerramentaEmCache[],
  novas: readonly FerramentaEmCache[],
): FerramentaEmCache[] {
  const porNome = new Map(anteriores.map((f) => [f.nome, f] as const));
  return novas.map((f) => {
    const antiga = porNome.get(f.nome);

    // Ferramenta nova (sem `antiga`): nunca foi decidida, então nunca "mudou
    // desde a última aprovação" — não existe aprovação anterior pra perder.
    if (!antiga) return { ...f, somente_leitura_confirmado: null, mudou_desde_aprovacao: false };

    const conteudoMudou =
      antiga.descricao !== f.descricao || JSON.stringify(antiga.input_schema) !== JSON.stringify(f.input_schema);

    // Conteúdo igual: nada aconteceu aqui, mantém decisão E bandeira como
    // estavam — não é este `f` que decide se a bandeira liga ou desliga.
    if (!conteudoMudou) {
      return {
        ...f,
        somente_leitura_confirmado: antiga.somente_leitura_confirmado ?? null,
        mudou_desde_aprovacao: antiga.mudou_desde_aprovacao ?? false,
      };
    }

    // Conteúdo mudou: a confirmação anterior não vale mais. A bandeira só
    // liga se havia uma decisão REAL pra perder — uma ferramenta que já
    // estava "aguardando aprovação" não tinha nada que o admin viu e mudou.
    const tinhaDecisaoReal = antiga.somente_leitura_confirmado === true || antiga.somente_leitura_confirmado === false;
    return {
      ...f,
      somente_leitura_confirmado: null,
      mudou_desde_aprovacao: tinhaDecisaoReal ? true : (antiga.mudou_desde_aprovacao ?? false),
    };
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

export type ResultadoDaAprovacao =
  | { ok: true; conexao: ConexaoPublica }
  | { ok: false; status: 404 | 409 | 422; motivo: string };

/**
 * Grava a decisão do admin sobre o risco de UMA ferramenta (Tarefa 11):
 * `true` ("Só consulta", roda no turno real e no Testar), `false` ("Altera
 * dados", só no turno real) ou `null` (volta a "Aguardando aprovação" — não
 * roda em lugar nenhum; serve pra desfazer uma aprovação sem reconectar no
 * servidor).
 *
 * Ferramenta inexistente no cache ou `recusada` (esquema grande ou inválido,
 * ou nome que não vira id) recusa com 422: a primeira porque não há o que
 * aprovar, a segunda porque `recusada` já é a palavra final sobre ela — uma
 * ferramenta que o servidor nem consegue expor como capacidade não tem risco
 * pra decidir. Mais de uma linha do cache com o MESMO `nome` (o servidor de
 * terceiro declarou a ferramenta duas vezes) também recusa com 422: não há
 * como saber qual das duas o admin está decidindo.
 *
 * ─── `versao`: a aprovação é sobre o que o admin VIU, não o que está agora ──
 *
 * `versao` é o `atualizada_em` (`updated_at`) que a TELA tinha quando o admin
 * clicou — acompanha o `tools_cache` que ele leu e decidiu em cima. Se a
 * linha já mudou (outra aprovação, um "Atualizar ferramentas", uma edição)
 * entre a tela carregar e este clique, `versao` não bate com `linha.updated_at`
 * e a chamada recusa com 409 ANTES de tocar em qualquer ferramenta — aprovar
 * "às cegas" sobre um cache que o admin nunca viu seria pior que não aprovar.
 *
 * Isso é INDEPENDENTE da trava otimista abaixo (M1, como em
 * `atualizarFerramentas`): aquela pega a corrida entre ESTA leitura e ESTA
 * escrita (a janela é pequena, mas existe); esta aqui pega a corrida entre a
 * tela ter carregado e o clique, que pode ser minutos. As duas checam o
 * MESMO `updated_at`, mas em momentos diferentes, e as duas ficam.
 */
export async function aprovarFerramenta(
  admin: SupabaseClient,
  organizationId: string,
  id: string,
  nomeDaFerramenta: string,
  somenteLeituraConfirmado: boolean | null,
  versao: string,
): Promise<ResultadoDaAprovacao> {
  const linha = await buscarLinha(admin, organizationId, id);
  if (!linha) return { ok: false, status: 404, motivo: MOTIVO_NAO_ENCONTRADA };
  if (versao !== linha.updated_at) return { ok: false, status: 409, motivo: MOTIVO_VERSAO_DESATUALIZADA };

  const candidatas = linha.tools_cache.filter((f) => f.nome === nomeDaFerramenta);
  if (candidatas.length === 0) return { ok: false, status: 422, motivo: MOTIVO_FERRAMENTA_NAO_ENCONTRADA };
  // Servidor que lista o mesmo `name` duas vezes: `listarFerramentas` deixa a
  // primeira ocorrência ativa e marca as outras como recusadas, então aqui
  // sobra UMA ativa e a aprovação segue. A recusa por duplicidade continua
  // valendo para cache gravado ANTES dessa trava, onde as duas estão ativas:
  // nesse caso ninguém sabe qual das duas o admin está aprovando, e aprovar a
  // errada libera uma ferramenta que ele não leu.
  const ativas = candidatas.filter((f) => !f.recusada);
  if (ativas.length > 1) return { ok: false, status: 422, motivo: MOTIVO_FERRAMENTA_DUPLICADA };
  const ferramenta = ativas[0] ?? candidatas[0]!;
  if (ferramenta.recusada) return { ok: false, status: 422, motivo: MOTIVO_FERRAMENTA_RECUSADA };

  // Compara por identidade, não por nome: por nome, a decisão cairia também na
  // duplicata recusada, e uma ferramenta recusada não pode nascer aprovada.
  const novoCache = linha.tools_cache.map((f) =>
    f === ferramenta
      ? {
          ...f,
          somente_leitura_confirmado: somenteLeituraConfirmado,
          // Uma decisão REAL (não o "desfazer" `null`) apaga o aviso de
          // "mudou desde a última aprovação": o admin acabou de ver o texto
          // atual e decidir sobre ele, então não há mais nada pendente.
          ...(somenteLeituraConfirmado !== null ? { mudou_desde_aprovacao: false } : {}),
        }
      : f,
  );

  const { data: atualizada, error } = await admin
    .from("ai_mcp_connections")
    .update({ tools_cache: novoCache })
    .eq("id", id)
    .eq("organization_id", organizationId)
    .eq("updated_at", linha.updated_at)
    .select(COLUNAS)
    .single();
  if (error) {
    if ((error as { code?: string }).code === CODIGO_SEM_LINHAS) {
      return { ok: false, status: 409, motivo: MOTIVO_CONFLITO_DE_ESCRITA };
    }
    throw new Error(`ai_mcp_connections_aprovar_falhou: ${error.message}`);
  }
  if (!atualizada) throw new Error("ai_mcp_connections_aprovar_falhou: sem linha devolvida");
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
