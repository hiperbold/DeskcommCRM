/**
 * Credenciais da instância UAZAPI — **só por sessão**, sem fallback de ambiente.
 *
 * ─── Por que não há env aqui, ao contrário do canal intermediado ────────────
 *
 * Lá existe UMA conta de instalação possível e o `.env` faz sentido como piso.
 * Aqui cada conexão é um aparelho pareado num servidor que pode ser de outra
 * empresa: a agência tem o dela, cada cliente pode ter o seu. Um token no
 * `.env` seria de UM número, e o fallback faria mensagem de uma organização
 * sair pelo número de outra no dia em que a credencial da sessão faltasse.
 * Sem credencial na sessão, o canal não envia — e diz por quê.
 *
 * ─── Por que a busca leva a ORGANIZAÇÃO junto (issue #236) ──────────────────
 *
 * `uazapi_instance_id` é identificador do SERVIDOR, não nosso. A trava da
 * migration 0261 garante unicidade entre ativos pelo par servidor + instância,
 * mas quem busca credencial por um client de service role bypassa RLS: sem o
 * `organization_id` à mão, uma colisão devolveria `data: null` com `PGRST116`,
 * e descartar esse erro é exatamente o defeito medido no canal oficial. Aqui a
 * consulta que falha LANÇA.
 *
 * A cifra é a do resto do repo (`fn_encrypt_oauth` / `fn_decrypt_oauth`, ver
 * `lib/webhooks/secrets.ts`): um segundo caminho de cifra seria mais um lugar
 * por onde o token vaza.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { ARCHIVED_AT, queryTolerantToMissingArchived } from "../archived";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";

export interface UazapiCredentials {
  /** `channel_sessions.uazapi_instance_id` — o sessionRef deste canal. */
  instanceId: string;
  /** Servidor da conexão, sem barra no fim. */
  baseUrl: string;
  /** Token da instância, já decifrado. Nunca vai para log nem para a tela. */
  token: string;
}

export interface UazapiCredsLookup {
  /** Resolvido de fonte confiável (sessão, linha já escopada, token do webhook). */
  organizationId: string;
  instanceId: string;
}

/**
 * Normaliza o endereço do servidor como o operador o cola.
 *
 * `null` quando não é um endereço http(s) utilizável. Descarta caminho, busca e
 * fragmento: quem cola `https://empresa.uazapi.com/docs` quer o servidor, e
 * montar `/docs/send/text` responderia 404 sem dizer que o erro foi a colagem.
 */
export function normalizarServidorUazapi(bruto: string): string | null {
  const texto = bruto.trim();
  if (!texto) return null;
  // Esquema explícito que não é http(s) recusa AQUI. Sem isto, `ftp://x` virava
  // `https://ftp://x`, que o `URL` aceita com host `ftp`, e o processo saía
  // buscando um endereço que ninguém digitou.
  const temEsquema = /^[a-z][a-z0-9+.-]*:\/\//i.test(texto);
  if (temEsquema && !/^https?:\/\//i.test(texto)) return null;
  let url: URL;
  try {
    url = new URL(temEsquema ? texto : `https://${texto}`);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  return `${url.protocol}//${url.host}`;
}

/**
 * Credencial gravada na sessão DESTA ORGANIZAÇÃO para esta instância.
 *
 * `null` significa "não há credencial utilizável": linha inexistente, token
 * ausente ou decifra que falhou (a chave mestra pode não estar configurada).
 * **LANÇA quando a consulta falha** — ver o cabeçalho.
 */
export async function resolveUazapiCreds(
  admin: SupabaseClient,
  lookup: UazapiCredsLookup,
): Promise<UazapiCredentials | null> {
  const { organizationId, instanceId } = lookup;
  if (!organizationId || !instanceId) return null;

  // `organization_id` À MÃO (service role bypassa RLS) e `archived_at is null`
  // pelo MESMO recorte do índice único da 0261: fora dele a trava do banco não
  // alcança, e a busca deixaria de ser exata onde ninguém a garante.
  const base = () =>
    admin
      .from("channel_sessions")
      .select("uazapi_instance_id, uazapi_base_url, uazapi_token_encrypted")
      .eq("organization_id", organizationId)
      .eq("uazapi_instance_id", instanceId);
  const { data, error } = await queryTolerantToMissingArchived(
    () => base().is(ARCHIVED_AT, null).maybeSingle(),
    () => base().maybeSingle(),
  );
  if (error) {
    throw new Error(
      `uazapi_creds_lookup_failed: ${error.code ?? "sem_codigo"} ${error.message ?? ""}`.trim(),
    );
  }

  const linha = data as {
    uazapi_instance_id: string | null;
    uazapi_base_url: string | null;
    uazapi_token_encrypted: unknown;
  } | null;
  if (!linha?.uazapi_token_encrypted || !linha.uazapi_base_url || !linha.uazapi_instance_id) {
    return null;
  }

  const baseUrl = normalizarServidorUazapi(linha.uazapi_base_url);
  if (!baseUrl) return null;

  const token = await decryptWebhookSecret(admin, linha.uazapi_token_encrypted as string);
  if (!token) return null;

  return { instanceId: linha.uazapi_instance_id, baseUrl, token };
}
