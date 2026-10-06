/**
 * Cloudflare Turnstile (D-173): a verificação contra robô das telas públicas.
 *
 * Duas chaves, as duas lidas em RUNTIME, nunca no build:
 * - `TURNSTILE_SITE_KEY` é pública (vai para o navegador). Sem prefixo
 *   `NEXT_PUBLIC_` de propósito: a imagem é construída no GitHub Actions e não pode
 *   depender da chave no build. O servidor lê e entrega por prop ao componente cliente.
 * - `TURNSTILE_SECRET_KEY` é secreta e só confere token no servidor, onde a chamada
 *   NÃO passa pelo GoTrue (a captação pública de leads). Nas telas de entrada quem
 *   confere é o próprio Supabase Auth, que recebe o token em `captchaToken`.
 *
 * Sem `TURNSTILE_SITE_KEY` nada muda na tela: é o estado de quem ainda não ligou.
 *
 * Lê `process.env` direto (e não `lib/env.ts`) para valer em runtime e para a suíte de
 * invariantes, que não carrega a validação inteira do ambiente.
 */
import { logger } from "@/lib/logger";

export const TURNSTILE_SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
/** Nome do campo que o widget injeta no formulário HTML. */
export const TURNSTILE_CAMPO_DO_FORMULARIO = "cf-turnstile-response";

/** Tempo máximo esperando a Cloudflare. Estourou: o pedido é recusado (falha fechado). */
const TIMEOUT_DO_SITEVERIFY_MS = 4000;
/** A Cloudflare documenta 2048 caracteres como teto do token. */
const TETO_DO_TOKEN = 2048;

function lerChave(nome: "TURNSTILE_SITE_KEY" | "TURNSTILE_SECRET_KEY"): string | null {
  const valor = process.env[nome]?.trim();
  return valor ? valor : null;
}

/** Chave pública, ou `null` quando a proteção não foi ligada nesta instalação. */
export function turnstileSiteKey(): string | null {
  return lerChave("TURNSTILE_SITE_KEY");
}

export function turnstileSecretKey(): string | null {
  return lerChave("TURNSTILE_SECRET_KEY");
}

/**
 * A captação pública só exige o token quando o operador pede de forma explícita
 * (`TURNSTILE_CAPTACAO_EXIGIR=1`), além de ter a chave secreta. Os formulários que
 * clientes já publicaram em sites próprios não têm o widget: exigir na hora em que a
 * secreta aparece no ambiente derrubaria toda captação existente de uma vez.
 */
export function captacaoExigeTurnstile(): boolean {
  const flag = process.env.TURNSTILE_CAPTACAO_EXIGIR?.trim().toLowerCase();
  return flag === "1" || flag === "true";
}

/**
 * O GoTrue recusou por causa do captcha (token ausente, vencido ou já usado)?
 * Responde `captcha_failed` e, em versões antigas, só traz "captcha" na mensagem.
 */
export function captchaRecusadoPeloGoTrue(
  erro: { code?: string; message?: string } | null | undefined,
): boolean {
  if (!erro) return false;
  return erro.code === "captcha_failed" || /captcha/i.test(erro.message ?? "");
}

export type ResultadoDoTurnstile =
  | { ok: true; verificado: boolean }
  | { ok: false; motivo: "ausente" | "invalido" | "indisponivel" };

let avisouSemSecreta = false;

/** Só para os testes: o aviso de "sem secreta" sai uma vez por processo. */
export function reiniciarAvisoDoTurnstile(): void {
  avisouSemSecreta = false;
}

/**
 * Confere um token no `siteverify` da Cloudflare.
 *
 * - Sem a secreta configurada: não verifica (`verificado: false`) e avisa no log, uma
 *   vez por processo.
 * - Token ausente, vazio ou grande demais: `ausente`/`invalido`, sem falar com a rede.
 * - Cloudflare recusou: `invalido`.
 * - Erro de rede, timeout, resposta que não é JSON ou `internal-error` da Cloudflare:
 *   `indisponivel`. Quem chama recusa (falha fechado) e pede para tentar de novo.
 */
export async function verificarTurnstile(
  token: unknown,
  ipDoVisitante?: string | null,
): Promise<ResultadoDoTurnstile> {
  const secreta = turnstileSecretKey();
  if (!secreta) {
    if (!avisouSemSecreta) {
      avisouSemSecreta = true;
      logger.warn(
        "[turnstile] TURNSTILE_SECRET_KEY ausente: o token não está sendo verificado no servidor",
      );
    }
    return { ok: true, verificado: false };
  }

  if (typeof token !== "string" || token.trim() === "") return { ok: false, motivo: "ausente" };
  if (token.length > TETO_DO_TOKEN) return { ok: false, motivo: "invalido" };

  const corpo = new URLSearchParams({ secret: secreta, response: token });
  if (ipDoVisitante) corpo.set("remoteip", ipDoVisitante);

  try {
    const res = await fetch(TURNSTILE_SITEVERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: corpo,
      signal: AbortSignal.timeout(TIMEOUT_DO_SITEVERIFY_MS),
    });
    if (!res.ok) {
      logger.warn("[turnstile] siteverify respondeu com erro", { status: res.status });
      return { ok: false, motivo: "indisponivel" };
    }
    const resposta = (await res.json()) as { success?: boolean; "error-codes"?: string[] };
    if (resposta.success === true) return { ok: true, verificado: true };
    const codigos = resposta["error-codes"] ?? [];
    if (codigos.includes("internal-error")) {
      logger.warn("[turnstile] a Cloudflare reportou erro interno no siteverify");
      return { ok: false, motivo: "indisponivel" };
    }
    return { ok: false, motivo: "invalido" };
  } catch (e) {
    logger.warn("[turnstile] não foi possível falar com o siteverify", {
      erro: e instanceof Error ? e.name : "desconhecido",
    });
    return { ok: false, motivo: "indisponivel" };
  }
}
