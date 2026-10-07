/**
 * Wrappers canônicos de API (sucesso e erro).
 *
 * Toda rota `/api/v1/*` DEVE usar `ok()` / `fail()` em vez de NextResponse direto.
 * Garante:
 *  - Formato consistente { data, meta? } / { error: { code, message, details? } }
 *  - Header X-Request-Id correlacionando com audit log
 *  - Status codes corretos (200/201/204/400/401/403/404/409/422/429/500)
 */

import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import type { ApiErrorCode } from "@/lib/api/errors";
import { logger } from "@/lib/logger";

// -----------------------------------------------------------------------------
// Tipos públicos
// -----------------------------------------------------------------------------

export type CursorMeta = {
  cursor?: string | null;
  has_more?: boolean;
  total?: number | null;
};

export type ApiSuccess<T> = {
  data: T;
  meta?: CursorMeta & Record<string, unknown>;
};

export type ApiError = {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
};

export type ApiResponse<T> = ApiSuccess<T> | ApiError;

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

type OkOptions = {
  status?: 200 | 201 | 204;
  meta?: ApiSuccess<unknown>["meta"];
  requestId?: string;
  headers?: HeadersInit;
};

export function ok<T>(data: T, opts: OkOptions = {}): NextResponse<ApiSuccess<T>> {
  const { status = 200, meta, requestId, headers } = opts;
  const body: ApiSuccess<T> = meta ? { data, meta } : { data };

  const res = NextResponse.json(body, { status, headers });
  res.headers.set("X-Request-Id", requestId ?? randomUUID());
  return res;
}

type FailOptions = {
  details?: unknown;
  requestId?: string;
  headers?: HeadersInit;
};

export function fail(
  code: ApiErrorCode | (string & {}),
  message: string,
  status: number,
  opts: FailOptions = {},
): NextResponse<ApiError> {
  const body: ApiError = {
    error: {
      code,
      message,
      ...(opts.details !== undefined ? { details: opts.details } : {}),
    },
  };

  const res = NextResponse.json(body, { status, headers: opts.headers });
  res.headers.set("X-Request-Id", opts.requestId ?? randomUUID());
  return res;
}

/** O que o cliente lê quando o servidor falhou por dentro: nada do erro, só o que fazer. */
export const MENSAGEM_DE_FALHA_INTERNA = "Não foi possível concluir agora. Tente novamente em instantes.";

function causaDaFalha(erro: unknown): string {
  if (erro instanceof Error) return erro.message;
  if (typeof erro === "string") return erro;
  if (erro && typeof erro === "object" && typeof (erro as { message?: unknown }).message === "string") {
    return (erro as { message: string }).message;
  }
  return "desconhecido";
}

/**
 * 500 de uma falha interna (banco, driver, serviço de apoio) sem repassar o erro (D-135).
 *
 * A mensagem do Postgres traz nome de tabela, de coluna, de constraint e o VALOR da chave duplicada;
 * devolvida ao cliente, vira um mapa do banco e um vazamento de dado. O cliente recebe o código
 * estável (quem já tinha um próprio, como `read_failed`, o mantém) e uma frase fixa; o erro de verdade
 * vai só para o log, com o `request_id` que também sai no cabeçalho da resposta.
 */
export function falhaInterna(
  code: ApiErrorCode | (string & {}),
  erro: unknown,
  opts: FailOptions = {},
): NextResponse<ApiError> {
  logger.error("api.falha_interna", { code, request_id: opts.requestId, causa: causaDaFalha(erro) });
  return fail(code, MENSAGEM_DE_FALHA_INTERNA, 500, opts);
}

// -----------------------------------------------------------------------------
// Atalhos comuns
// -----------------------------------------------------------------------------

export const noContent = (requestId?: string) => {
  const res = new NextResponse(null, { status: 204 });
  res.headers.set("X-Request-Id", requestId ?? randomUUID());
  return res;
};
