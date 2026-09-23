/**
 * O CORPO CRU DO QUE O PROVEDOR MANDOU.
 *
 * ─── Por que isto precisa existir ───────────────────────────────────────────
 *
 * `webhook_events_log` é o único lugar onde o payload original fica guardado. A
 * rota do canal por QR grava lá desde sempre; a rota genérica de canal — por
 * onde entram os canais oficiais — não gravava nada. Barrido antes desta peça:
 * zero escritores naquele caminho.
 *
 * Não é lacuna abstrata. O comentário de `lib/waha/ingest.ts` mostra que a
 * decisão sobre identidades opacas (`@lid`) só foi possível porque esse arquivo
 * existia em produção — "76 de 76", contados no banco. O instrumento que
 * respondeu aquela pergunta faltava justamente no canal NOVO, que é onde ainda
 * há pergunta aberta: se mensagem de grupo chega, e de qual host vem o anexo.
 *
 * ─── Duas escritas, e não uma ───────────────────────────────────────────────
 *
 * A linha nasce ANTES do processamento, com `received`. Se o processo morrer no
 * meio — exceção, OOM, deploy no instante errado — o corpo cru continua lá, que
 * é justamente quando alguém vai querer lê-lo. Gravar só no fim perderia
 * exatamente os casos que motivam o arquivo.
 *
 * ─── O que este módulo NÃO faz ──────────────────────────────────────────────
 *
 * Não interpreta o payload. `event_type` e `external_id` ficam nulos de
 * propósito: lê-los exigiria saber o formato de cada canal, e essa é a decisão
 * que o seam existe para manter longe da rota. O `payload_parsed` guarda o JSON
 * inteiro — quem investigar lê `payload_parsed->>'event'` e tem a mesma
 * resposta, sem que ninguém precise ensinar o formato a este arquivo.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

/** Cabeçalhos que NUNCA entram no arquivo, por menor que seja a chance. */
const PROIBIDOS = ["authorization", "cookie", "x-api-key"];

/**
 * ACHADO 1: chaves de CORPO que nunca podem ficar em claro no arquivo.
 *
 * A UAZAPI repete o token da instância dentro do próprio corpo do webhook
 * (`token`, ver `uazapi/envelope.ts`), e a policy de leitura de
 * `webhook_events_log` (antes do conserto da migration 0902) abria SELECT
 * para qualquer membro ativo da organização, sem olhar papel. Gravar o corpo
 * cru sem redigir vazava a credencial da instância para quem só tinha o
 * privilégio mínimo. A lista cobre o vocabulário genérico de credencial, não
 * só o que a UAZAPI usa hoje, porque o próximo canal que gravar aqui herda a
 * mesma proteção sem precisar lembrar de pedir.
 */
const CHAVES_SENSIVEIS = new Set([
  "token",
  "apikey",
  "api_key",
  "authorization",
  "secret",
  "password",
  "admintoken",
  "admin_token",
]);

const VALOR_REDIGIDO = "[redigido]";

/**
 * Troca o VALOR de chaves sensíveis por `[redigido]`, em qualquer
 * profundidade do objeto (o token pode vir aninhado num evento futuro).
 * A CHAVE fica visível de propósito: é ela que ajuda a entender o payload na
 * hora de investigar, e ela não abre nada sozinha.
 */
function redigirValoresSensiveis(valor: unknown): unknown {
  if (Array.isArray(valor)) return valor.map(redigirValoresSensiveis);
  if (valor && typeof valor === "object") {
    const out: Record<string, unknown> = {};
    for (const [chave, v] of Object.entries(valor as Record<string, unknown>)) {
      out[chave] = CHAVES_SENSIVEIS.has(chave.toLowerCase()) ? VALOR_REDIGIDO : redigirValoresSensiveis(v);
    }
    return out;
  }
  return valor;
}

/**
 * Mesma redação, mas no TEXTO cru: cobre o corpo que não é JSON válido
 * (proxy devolvendo HTML de erro, por exemplo), onde a redação por objeto não
 * tem o que percorrer. Troca só o valor de `"chave":"valor"` (aspas simples
 * ou duplas, com ou sem espaço depois dos dois-pontos); a chave permanece,
 * pelo mesmo motivo da função acima.
 */
function redigirTextoCru(raw: string): string {
  const chaves = [...CHAVES_SENSIVEIS].join("|");
  const padrao = new RegExp(`(["'](?:${chaves})["']\\s*:\\s*)["'][^"']*["']`, "gi");
  return raw.replace(padrao, `$1"${VALOR_REDIGIDO}"`);
}

/**
 * Cabeçalhos sanitizados.
 *
 * A assinatura FICA: ela é o que permite reconferir depois se um payload
 * recusado tinha mesmo assinatura errada, ou se o segredo é que estava errado —
 * e é assinatura, não credencial: não abre nada sozinha.
 */
function cabecalhosSeguros(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((valor, chave) => {
    if (PROIBIDOS.includes(chave.toLowerCase())) return;
    out[chave] = valor;
  });
  return out;
}

/**
 * Abre a linha do arquivo. Devolve o id para o fechamento, ou `null` quando não
 * deu — e "não deu" nunca interrompe a ingestão: perder o arquivo é ruim, perder
 * a mensagem do cliente é pior.
 */
export async function abrirArquivoDoWebhook(
  admin: SupabaseClient,
  entrada: {
    organizationId: string;
    channelSessionId: string;
    provider: string;
    rawBody: string;
    headers: Headers;
  },
): Promise<string | null> {
  let parsed: Record<string, unknown> | null = null;
  try {
    const v = JSON.parse(entrada.rawBody) as unknown;
    // Só objeto vai para a coluna `jsonb`: um payload que seja lista ou escalar
    // é legítimo em JSON e não cabe no formato desta coluna.
    parsed = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    // Corpo que não é JSON é EXATAMENTE o que se quer arquivar: é o caso que
    // ninguém consegue reproduzir depois. `raw_body` guarda ele inteiro.
    parsed = null;
  }

  // ACHADO 1: redige ANTES de gravar, nas duas colunas. `payload_parsed` pela
  // árvore (alcança qualquer profundidade); `raw_body` por regex, porque o
  // corpo cru também precisa ficar sem o token quando não é JSON válido, e
  // a mesma regex funciona igual quando é.
  const parsedRedigido = parsed ? (redigirValoresSensiveis(parsed) as Record<string, unknown>) : null;
  const rawBodyRedigido = redigirTextoCru(entrada.rawBody);

  try {
    const { data, error } = await admin
      .from("webhook_events_log")
      .insert({
        organization_id: entrada.organizationId,
        channel_session_id: entrada.channelSessionId,
        // Vem da SESSÃO, nunca de um literal: a rota não pode nomear canal, e
        // o `lint:channels` reprova quem tenta.
        provider: entrada.provider,
        http_method: "POST",
        headers: cabecalhosSeguros(entrada.headers),
        raw_body: rawBodyRedigido,
        payload_parsed: parsedRedigido,
        status: "received",
        attempts: 0,
      })
      .select("id")
      .maybeSingle();

    if (error) {
      logger.warn("[arquivo-webhook] não consegui abrir a linha", {
        detail: error.message.slice(0, 160),
      });
      return null;
    }
    return (data as { id: string } | null)?.id ?? null;
  } catch (err) {
    logger.warn("[arquivo-webhook] não consegui abrir a linha", {
      detail: err instanceof Error ? err.message.slice(0, 160) : "desconhecido",
    });
    return null;
  }
}

/**
 * Fecha a linha com o desfecho.
 *
 * `valid_signature` só é `false` quando a recusa foi POR assinatura. Um payload
 * bem assinado que o parser ignorou não é assinatura inválida, e marcar como se
 * fosse mandaria quem investigar procurar um problema de segredo que não existe.
 */
export async function fecharArquivoDoWebhook(
  admin: SupabaseClient,
  id: string | null,
  desfecho: { status: "processed" | "error"; validSignature: boolean | null; erro?: string | null },
): Promise<void> {
  if (!id) return;
  try {
    await admin
      .from("webhook_events_log")
      .update({
        status: desfecho.status,
        valid_signature: desfecho.validSignature,
        error_message: desfecho.erro ?? null,
        processed_at: new Date().toISOString(),
      })
      .eq("id", id);
  } catch {
    // A linha `received` já está gravada com o corpo cru, que é o que importa.
    // Falhar aqui não pode derrubar a resposta ao provedor.
  }
}
