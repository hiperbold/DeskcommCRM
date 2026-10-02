/**
 * Leitura de dado de cliente por admin da plataforma só com acompanhamento ativo
 * (D-152).
 *
 * As rotas `admin/inbox/*` leem conversas, telefone e e-mail de contato com o
 * cliente service role. Antes, qualquer admin da plataforma (inclusive
 * `support_readonly` com `mfa_required=false`) lia a caixa de entrada de TODAS as
 * organizações, sem motivo, sem prazo e sem o aal2 que `fn_start_support` exige.
 *
 * O acompanhamento (`platform_support_sessions`) é o único caminho que carrega
 * essas três coisas: o banco só o abre com sessão real, TTL de até 1 h e MFA, e
 * `fn_support_context()` já devolve `revoked` quando o aal2 se perde. Esta guarda
 * pergunta a ele, com o cliente DO USUÁRIO (a RPC resolve `auth.uid()` e a sessão
 * pelo JWT, nunca por cookie nem por corpo), e só libera a organização do
 * acompanhamento ativo.
 */
import { fail } from "@/lib/api/wrappers";
import { createClient } from "@/lib/supabase/server";
import { readSupportContext, type SupportContext } from "./support";

export type AcompanhamentoParaLeitura =
  | { ok: true; support: SupportContext }
  | { ok: false; response: Response };

/**
 * O acompanhamento ativo da sessão atual, e só se for da organização pedida
 * (quando `organizationId` vem). `null` em `organizationId` aceita a do próprio
 * acompanhamento: é o caso da listagem sem filtro, que mostra a organização que
 * se está acompanhando.
 */
export async function exigeAcompanhamentoAtivo(
  organizationId: string | null,
  requestId: string,
): Promise<AcompanhamentoParaLeitura> {
  let support: SupportContext | null;
  try {
    support = await readSupportContext(await createClient());
  } catch {
    return {
      ok: false,
      response: fail(
        "upstream_unavailable",
        "Não foi possível confirmar o acompanhamento administrativo.",
        503,
        { requestId },
      ),
    };
  }
  if (!support || support.status !== "active") {
    return {
      ok: false,
      response: fail(
        "support_session_required",
        "Abra um acompanhamento (impersonate) desta organização para ler as conversas dela.",
        403,
        { requestId },
      ),
    };
  }
  if (organizationId && organizationId !== support.organization_id) {
    return {
      ok: false,
      response: fail(
        "support_session_required",
        "O acompanhamento ativo é de outra organização.",
        403,
        { requestId },
      ),
    };
  }
  return { ok: true, support };
}
