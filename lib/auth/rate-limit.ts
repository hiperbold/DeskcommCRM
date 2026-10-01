/**
 * Rate limit da superfície de autenticação (issue #64).
 *
 * O `checkRateLimit` já existia e era usado em dois pontos (webhook de captação
 * e dispatcher de IA); login, signup, recuperação de senha e aceite de convite
 * ficaram sem nenhum limite — força bruta de senha e enumeração de token saíam
 * de graça. Aqui só se aplica o que já existe.
 *
 * Duas contagens por tentativa, quando há identificador:
 *  - por IP: barra o atacante que varre muitas contas de um lugar só;
 *  - por identificador (hash do e-mail, token): barra o ataque distribuído
 *    contra UMA conta, que a contagem por IP não vê.
 *
 * O identificador entra SEMPRE hasheado — chave de Redis é lugar de dado
 * opaco, não de e-mail de cliente.
 *
 * Janela FIXA (é o que `checkRateLimit` implementa: `INCR` + `EXPIRE`), então
 * uma rajada na virada da janela passa em dobro. É limite de abuso, não de
 * precisão — e sem Upstash configurado o contador cai para memória do processo,
 * o que degrada em instalação de nó único mas não deixa a porta escancarada.
 */
import { createHash } from "node:crypto";
import { headers } from "next/headers";

import { checkRateLimit, peekRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { ipDoCliente } from "@/lib/http/ip-do-cliente";

export interface AuthRateLimits {
  /** Tentativas por IP na janela. */
  ip: number;
  /** Tentativas por identificador na janela (omita para não contar por ele). */
  id?: number;
  windowSec: number;
  /**
   * Teto de falhas da CONTA somando todas as origens, na janela `contaWindowSec`
   * (só o login usa). Existe porque o teto `id` do login passou a ser por conta
   * E origem (D-102): sem um teto da conta inteira, quem distribui as tentativas
   * por muitos IPs voltaria a ter um orçamento ilimitado contra uma conta só.
   */
  conta?: number;
  contaWindowSec?: number;
}

/**
 * IP do cliente, ou `null` quando não dá para saber.
 *
 * Delega a `ipDoCliente` (D-036): este módulo tinha a própria cópia da leitura,
 * pegando o PRIMEIRO salto do `x-forwarded-for`, o item que o cliente HTTP
 * escreve, não o que o proxy confiável acrescenta. Uma cópia a mais é um lugar
 * a mais para esquecer quando a leitura correta muda; ver `lib/http/ip-do-cliente.ts`
 * para o porquê do salto certo ser o de trás, e `TRUSTED_PROXY_COUNT` para
 * quem tem mais de um proxy na frente.
 *
 * `null` em vez de uma string sentinela: "não sei de onde veio" precisa ser
 * inexprimível como se fosse uma origem, senão vira balde compartilhado.
 */
async function clientIp(): Promise<string | null> {
  const hdrs = await headers();
  return ipDoCliente(hdrs);
}

function opaque(value: string): string {
  return createHash("sha256").update(value.trim().toLowerCase()).digest("hex").slice(0, 32);
}

/**
 * `true` = barre a tentativa.
 *
 * @param action rótulo do bucket (`login`, `signup`, `reset`, `invite_accept`)
 * @param identifier e-mail ou token da tentativa; hasheado antes de virar chave
 */
export async function authRateLimited(
  action: string,
  identifier: string | null,
  limits: AuthRateLimits,
): Promise<boolean> {
  const ip = await clientIp();

  // SEM IP identificável, o limite por IP não entra — e isto é decisão de
  // segurança, não relaxamento.
  //
  // O teto por IP existe para ISOLAR uma origem: barrar quem varre muitas contas
  // de um lugar só. Quando o header não chega, não há origem para isolar, e a
  // versão anterior jogava todo mundo num ÚNICO balde global (`opaque("sem-ip")`).
  // O efeito é o oposto do pretendido: o atacante não fica isolado (ele divide o
  // balde com as vítimas) e 60 requisições anônimas trancam o login da instalação
  // INTEIRA. Vira um DoS de custo zero contra a própria empresa.
  //
  // E o caso não é hipotético: o kit self-host expõe o app direto, sem proxy
  // (`docker-compose.prod.yml`), então `x-forwarded-for` não existe em nenhuma
  // instalação padrão — ou seja, o balde global era o caminho NORMAL, não a exceção.
  //
  // O que barra força bruta de senha continua valendo integralmente: o contador por
  // CONTA (`contaBloqueadaPorFalhas`), que não depende de IP nenhum e é justamente o
  // desenhado para o ataque distribuído.
  if (ip !== null) {
    const byIp = await checkRateLimit(`auth:${action}:ip:${opaque(ip)}`, limits.ip, limits.windowSec);
    if (!byIp.allowed) return true;
  }

  if (identifier && limits.id !== undefined) {
    const byId = await checkRateLimit(
      `auth:${action}:id:${opaque(identifier)}`,
      limits.id,
      limits.windowSec,
    );
    if (!byId.allowed) return true;
  }

  return false;
}

/**
 * Limites por superfície. Números escolhidos para não estorvar uso humano
 * normal e ainda assim tirar o custo-zero do ataque:
 *  - login: quem erra a senha 5 vezes na mesma conta em 5 min quase sempre é
 *    script; o teto por IP é mais folgado por causa de NAT corporativo.
 *  - signup e convite: fluxos raros por pessoa, teto baixo.
 */
/** Teto de produção por IP no login. Congelado por teste — ver `LOGIN_IP_DEFAULT` abaixo. */
const LOGIN_IP_DEFAULT = 60;

/**
 * O teto por IP do login é o ÚNICO limite configurável, e existe por um defeito
 * de ambiente, não de produto: no CI todo teste sai do mesmo IP por construção
 * (um runner), então 28 specs × vários logins estouram 60/5min e o e2e reprova
 * com "Muitas tentativas" — foi o que derrubou `risk-radar` (13ª de 15 na parte 1).
 *
 * Por que afrouxar ISTO é seguro, e afrouxar o resto não seria: o limite que
 * barra brute force é `id` (5 falhas na MESMA conta em 5 min), e ele NÃO é
 * configurável — continua valendo inclusive para quem distribui as tentativas
 * por muitos IPs. O teto por IP é anti-flood genérico, já folgado de propósito
 * por causa de NAT corporativo; no CI o "NAT" é o runner inteiro.
 *
 * Valor inválido ou ausente cai no default de produção: a falha é fechada.
 */
function loginIpLimit(): number {
  const bruto = process.env.AUTH_RATE_LIMIT_LOGIN_IP;
  if (bruto === undefined) return LOGIN_IP_DEFAULT;
  const n = Number.parseInt(bruto, 10);
  return Number.isFinite(n) && n > 0 ? n : LOGIN_IP_DEFAULT;
}

export const AUTH_LIMITS = {
  // `id` = falhas na MESMA conta vindas da MESMA origem; `conta` = falhas da conta
  // inteira, de qualquer origem. Dois números porque um lockout só por conta deixa
  // qualquer pessoa trancar a conta de outra errando a senha de propósito (D-102).
  login: { ip: loginIpLimit(), id: 5, windowSec: 300, conta: 30, contaWindowSec: 900 },
  signup: { ip: 20, windowSec: 3600 },
  reset: { ip: 30, id: 3, windowSec: 3600 },
  invite_accept: { ip: 60, windowSec: 3600 },
  // Recuperação do primeiro acesso: o teto mais apertado da lista, e de
  // propósito. Cada acerto CRIA uma organização, e o caminho legítimo é
  // usado UMA vez na vida de uma conta — 3 por hora por identidade já é
  // folga para quem errou o nome duas vezes.
  org_recovery: { ip: 5, id: 3, windowSec: 3600 },
} satisfies Record<string, AuthRateLimits>;

export const __LOGIN_IP_DEFAULT_PARA_TESTE = LOGIN_IP_DEFAULT;

/**
 * Bloqueio por FALHA, para o login.
 *
 * `authRateLimited` conta toda tentativa: certo para IP, errado para conta:
 * quem digita a senha certa não pode gastar o próprio orçamento de bloqueio.
 * Aqui a consulta vem antes do provedor (só assim o ataque é barrado *antes*
 * de acontecer) e o incremento vem depois, apenas quando a senha errou.
 *
 * ⚠️ DOIS contadores, e o primeiro NÃO é só por conta (D-102):
 *
 *  - CONTA + ORIGEM (`limits.id` falhas em `windowSec`): trava só a origem que
 *    errou. Era por conta apenas, e isso deixava qualquer pessoa trancar a conta
 *    de outra errando a senha 5 vezes a cada 5 minutos, de qualquer lugar: DoS de
 *    custo zero contra o dono. Agora quem erra tranca a si mesmo; o dono, em outra
 *    origem, entra normalmente.
 *  - CONTA INTEIRA (`limits.conta` falhas em `contaWindowSec`): o teto de quem
 *    distribui as tentativas por muitas origens, que o contador acima não vê. É
 *    bem mais alto de propósito (30 contra 5): trancar a conta por ele custa
 *    trinta falhas a cada 15 minutos, e o aviso sai na tela e no audit.
 *
 * Sem IP identificável a origem vira um único balde POR CONTA (nunca global, ver
 * `authRateLimited`): nessas instalações (sem proxy na frente) o comportamento é o
 * de antes, por conta.
 */
export type MotivoDoBloqueioDeLogin = "origem" | "conta";

function origemKey(ip: string | null): string {
  return ip === null ? "sem-ip" : opaque(ip);
}

export async function motivoDoBloqueioDeLogin(
  email: string,
  limits: AuthRateLimits,
): Promise<MotivoDoBloqueioDeLogin | null> {
  if (limits.id === undefined) return null;
  const ip = await clientIp();
  const daOrigem = await peekRateLimit(
    `auth:login_fail:id:${opaque(email)}:ip:${origemKey(ip)}`,
    limits.windowSec,
  );
  if (daOrigem >= limits.id) return "origem";
  if (limits.conta !== undefined && limits.contaWindowSec !== undefined) {
    const daConta = await peekRateLimit(`auth:login_fail:conta:${opaque(email)}`, limits.contaWindowSec);
    if (daConta >= limits.conta) return "conta";
  }
  return null;
}

export async function contaBloqueadaPorFalhas(email: string, limits: AuthRateLimits): Promise<boolean> {
  return (await motivoDoBloqueioDeLogin(email, limits)) !== null;
}

/** Registra uma senha errada nos dois contadores. */
export async function registrarFalhaDeLogin(email: string, limits: AuthRateLimits): Promise<void> {
  if (limits.id === undefined) return;
  const ip = await clientIp();
  await checkRateLimit(
    `auth:login_fail:id:${opaque(email)}:ip:${origemKey(ip)}`,
    limits.id,
    limits.windowSec,
  );
  if (limits.conta !== undefined && limits.contaWindowSec !== undefined) {
    await checkRateLimit(`auth:login_fail:conta:${opaque(email)}`, limits.conta, limits.contaWindowSec);
  }
}

/**
 * Bloqueio por falha de CÓDIGO TOTP, por `user_id` (D-102).
 *
 * O contador morava num cookie do navegador: apagar o cookie zerava o limite, e
 * sobrava só o do GoTrue. Agora é do servidor, no mesmo limitador do resto. Quem
 * chega aqui já tem a senha (sessão aal1), então a chave é o usuário, não a
 * origem: trancar o usuário só atrapalha quem já passou da senha.
 *
 * 5 falhas em 15 minutos: o espaço de um código é 10^6 e cada falha também gasta
 * o limite do GoTrue; 480 chutes por dia por conta não chegam perto.
 */
export const MFA_FAILURE_LIMITS = { max: 5, windowSec: 900 } as const;

function mfaKey(userId: string): string {
  return `auth:mfa_fail:user:${opaque(userId)}`;
}

/** Segundos até a janela fixa atual virar (é quando o contador zera). */
export function segundosAteFimDaJanela(windowSec: number, agora: number = Date.now()): number {
  return windowSec - (Math.floor(agora / 1000) % windowSec);
}

export async function mfaBloqueadoPorFalhas(userId: string): Promise<boolean> {
  const atual = await peekRateLimit(mfaKey(userId), MFA_FAILURE_LIMITS.windowSec);
  return atual >= MFA_FAILURE_LIMITS.max;
}

/** Registra um código errado e devolve quantos já foram na janela. */
export async function registrarFalhaDeMfa(userId: string): Promise<number> {
  const r = await checkRateLimit(mfaKey(userId), MFA_FAILURE_LIMITS.max, MFA_FAILURE_LIMITS.windowSec);
  return r.count;
}

/**
 * Bloqueio por falha de TOKEN DE API (`dsk_...`) — o MCP não tinha nenhum
 * (issue #1447).
 *
 * O login já contava falhas; o token de máquina, não. `validateBearerToken`
 * recusava e seguia, e cada recusa custava um lookup em `api_tokens` — então a
 * mesma origem podia varrer tokens para sempre a custo zero. Dois baldes,
 * porque são dois ataques diferentes:
 *
 *   - por ORIGEM (`api_token_fail:ip`): quem ADIVINHA — cabeçalho ausente ou
 *     torto, `dsk_` malformado, hash desconhecido. É o freio de quem varre de
 *     um lugar só.
 *   - pelo VALOR APRESENTADO (`api_token_fail:token`, hash SHA256 do que veio
 *     no header): quem REPETE o mesmo chute, ou o mesmo token já morto
 *     (revogado, expirado), trocando de IP a cada tentativa — o espelho do
 *     caso acima, que o balde por IP vê como "1 falha por IP" e não barra.
 *
 * `revoked`/`expired` NÃO debitam o balde por origem: quem apresenta um token
 * que existiu não está adivinhando, e transformar cliente desatualizado em
 * bloqueio por IP puniria NAT corporativo — exatamente o que `authRateLimited`
 * evita. Eles debitam só o balde do valor apresentado, que não afeta mais
 * ninguém.
 *
 * `lookup_failed` não conta em balde nenhum: a falha é nossa (banco fora), e
 * indisponibilidade de infraestrutura não pode virar bloqueio de cliente.
 *
 * Sem Redis de pé a contagem cai para a memória do processo — vira teto por
 * instância, o mesmo aviso que o resto deste módulo já carrega. As funções
 * aqui falham ABERTO: erro ao consultar o teto não pode virar 500 no meio da
 * autenticação — o que ele protege é custo, não acesso.
 */
export interface TokenFailureLimits {
  /** Teto por origem, por janela. */
  ip: number;
  /** Teto por valor apresentado, por janela. */
  token: number;
  windowSec: number;
}

export const TOKEN_FAILURE_LIMITS: TokenFailureLimits = { ip: 30, token: 5, windowSec: 300 };

export interface FalhaDeTokenOpcoes {
  /** `true` (default) = também debita o balde por origem: quem ADIVINHOU. */
  contaNoIp?: boolean;
}

function tokenFailureIpKey(ip: string): string {
  return `api_token_fail:ip:${opaque(ip)}`;
}

function tokenFailureValueKey(plaintext: string): string {
  return `api_token_fail:token:${opaque(plaintext)}`;
}

/**
 * `true` = teto estourado, barre ANTES de resolver o token.
 *
 * Consulta sem incrementar: quem incrementa é `registrarFalhaDeToken`, e só
 * quando a tentativa realmente falhou. Acerto não paga imposto.
 */
export async function tokenFailureLimited(
  plaintext: string | null,
  limits: TokenFailureLimits = TOKEN_FAILURE_LIMITS,
): Promise<boolean> {
  try {
    const ip = await clientIp();
    if (ip !== null && (await peekRateLimit(tokenFailureIpKey(ip), limits.windowSec)) >= limits.ip) {
      return true;
    }
    if (
      plaintext !== null &&
      (await peekRateLimit(tokenFailureValueKey(plaintext), limits.windowSec)) >= limits.token
    ) {
      return true;
    }
    return false;
  } catch (err) {
    console.error(
      "[auth.rate-limit] teto de token indisponível (falha aberta)",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

/**
 * Registra a tentativa que FALHOU.
 *
 * @param plaintext valor apresentado; `null` quando não veio token nenhum
 *   (cabeçalho ausente/malformado) — aí só o balde por origem existe.
 */
export async function registrarFalhaDeToken(
  plaintext: string | null,
  opcoes: FalhaDeTokenOpcoes = {},
  limits: TokenFailureLimits = TOKEN_FAILURE_LIMITS,
): Promise<void> {
  const contaNoIp = opcoes.contaNoIp ?? true;
  try {
    if (contaNoIp) {
      const ip = await clientIp();
      if (ip !== null) {
        await checkRateLimit(tokenFailureIpKey(ip), limits.ip, limits.windowSec);
      }
    }
    if (plaintext !== null) {
      await checkRateLimit(tokenFailureValueKey(plaintext), limits.token, limits.windowSec);
    }
  } catch (err) {
    console.error(
      "[auth.rate-limit] falha ao registrar tentativa de token (falha aberta)",
      err instanceof Error ? err.message : err,
    );
  }
}
