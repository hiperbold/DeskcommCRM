/**
 * O freio anti-ban de quem envia pela API com TOKEN — REST (`Bearer dsk_...`) e MCP.
 *
 * ## Por que existe
 *
 * `POST /api/v1/messages` e as ferramentas MCP de envio chamam
 * `sendMessageHandler` direto, sem a cadeia `before_send` (`runBeforeSend`). Pela
 * tela isso é certo: um atendente não digita rápido o bastante para queimar o
 * número. Por token não é: um script ou um agente externo em laço mandava
 * centenas de mensagens seguidas pelo mesmo número, sem espaçamento, sem teto de
 * warm-up — e sem contar no `pacing_ledger`, então o agente do próprio CRM seguia
 * achando que o número estava folgado.
 *
 * ## O que NÃO é
 *
 * Não é uma segunda REGRA. A decisão é `criarPacingDoCanal` (`ledger-supabase.ts`),
 * a mesma que o aviso ao suporte usa: espaçamento + teto diário (warm-up e
 * `daily_message_limit`). Os vetos de CONTEÚDO (promessa, vocabulário interno,
 * disclosure) ficam de fora de propósito — são para texto escrito pela IA do
 * CRM, e quem chama por token responde pelo que escreve.
 *
 * A janela de horário (7h-22h) também fica de fora: integração legítima manda
 * confirmação de pedido às 23h, e represá-la até as 7h quebraria o caso de uso.
 *
 * ## Atomicidade (D-167)
 *
 * Decidir e registrar eram dois passos (ler o ledger, enviar, gravar depois): duas chamadas
 * concorrentes no mesmo número liam o mesmo estado e passavam juntas. Agora `reservarEnvioPorToken`
 * pede ao banco uma VAGA (`fn_pacing_reservar_vaga`, migration 0944): sob advisory lock do canal, a
 * mesma chave do agente, o banco confere o teto do dia e o espaçamento e grava a linha no ledger na
 * mesma transação. Espaçamento curto reserva a vaga para o instante em que o número libera e quem
 * chamou espera até lá, então a rajada vira fila. Se o envio falha, `concluirEnvioPorToken` devolve
 * a vaga (`fn_pacing_liberar_vaga`). Erro ao reservar é RECUSA (503), nunca "sem freio".
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { criarPacingDoCanal, type ResultadoDaReserva } from "@/lib/agent-engine/pacing/ledger-supabase";
import { ApiError } from "@/lib/api/types";
import { capabilitiesOf, DEFAULT_CHANNEL_PROVIDER } from "@/lib/channels/capabilities";
import type { ChannelProvider } from "@/lib/channels/types";

/**
 * Espaçamento curto é ESPERADO dentro da requisição (o throttle é ~1,2s + jitter);
 * acima disto a requisição devolve 429 em vez de segurar a conexão aberta.
 */
export const ESPERA_MAXIMA_MS = 5_000;

export interface CanalDaConversa {
  channelSessionId: string;
  provider: string | null;
}

export interface DepsDoRitmo {
  lerCanalDaConversa(organizationId: string, conversationId: string): Promise<CanalDaConversa | null>;
  lerCanalDaSessao?(organizationId: string, channelSessionId: string): Promise<CanalDaConversa | null>;
  pacing: {
    reserva(
      organizationId: string,
      channelSessionId: string,
      agora: Date,
      esperaMaximaMs: number,
    ): Promise<ResultadoDaReserva>;
    libera(organizationId: string, channelSessionId: string, vagaId: string): Promise<void>;
  };
  sleep(ms: number): Promise<void>;
  agora(): Date;
}

/** Entrada aceita por `reservarEnvioPorToken`: por conversa existente ou direto pela sessão do canal. */
export type EntradaDoFreio =
  | { organizationId: string; conversationId: string; requestId: string }
  | { organizationId: string; channelSessionId: string; requestId: string };

/** O que `reservarEnvioPorToken` devolve e `concluirEnvioPorToken` consome: a vaga reservada no ledger. */
export type EnvioSegurado = { channelSessionId: string; vagaId: string } | null;

function temRiscoDeBan(provider: string | null): boolean {
  try {
    return capabilitiesOf((provider ?? DEFAULT_CHANNEL_PROVIDER) as ChannelProvider).banRisk;
  } catch {
    // Provider fora da matriz: falha FECHADA. Errar para "sem risco" desarmaria
    // o freio num número que pode ser banido.
    return true;
  }
}

/**
 * Reserva a vaga do envio, esperando o espaçamento curto dentro da requisição, ou recusa com 429.
 *
 * Devolve `null` quando não há o que frear (canal sem risco de ban, ou conversa que não é desta
 * organização: aí quem responde é o handler, com o 404 dele).
 */
export async function reservarEnvioPorToken(
  deps: DepsDoRitmo,
  entrada: EntradaDoFreio,
): Promise<EnvioSegurado> {
  const canal =
    "channelSessionId" in entrada
      ? await (deps.lerCanalDaSessao
          ? deps.lerCanalDaSessao(entrada.organizationId, entrada.channelSessionId)
          : null)
      : await deps.lerCanalDaConversa(entrada.organizationId, entrada.conversationId);
  if (!canal || !temRiscoDeBan(canal.provider)) return null;

  const agora = deps.agora();
  let reserva: ResultadoDaReserva;
  try {
    reserva = await deps.pacing.reserva(entrada.organizationId, canal.channelSessionId, agora, ESPERA_MAXIMA_MS);
  } catch {
    // Falha ao reservar (banco, trava) é recusa: o envio nunca sai sem o freio.
    throw falhaDeLeituraDoCanal();
  }

  if (reserva.liberado) {
    const esperaMs = Math.max(0, reserva.liberaEm.getTime() - agora.getTime());
    if (esperaMs > 0) await deps.sleep(esperaMs);
    return { channelSessionId: canal.channelSessionId, vagaId: reserva.vagaId };
  }

  const esperaMs = Math.max(0, reserva.liberaEm.getTime() - agora.getTime());
  const retryAfterSeconds = Math.max(1, Math.ceil(esperaMs / 1000));
  const liberaEm = reserva.liberaEm.toISOString();
  // O valor vai no texto, não só em `details`: o servidor MCP devolve ao cliente apenas a
  // mensagem do erro (lib/mcp/server.ts), e um modelo sem o horário não sabe quando voltar.
  throw new ApiError(
    429,
    "rate_limited",
    { motivo: reserva.motivo, libera_em: liberaEm, retry_after_seconds: retryAfterSeconds },
    entrada.requestId,
    reserva.motivo === "teto_diario"
      ? `Este número atingiu o limite de envios de hoje. Tente de novo depois de ${liberaEm} (em ${retryAfterSeconds}s).`
      : `Envios rápidos demais para este número. Tente de novo em ${retryAfterSeconds}s.`,
  );
}

/**
 * Fecha o envio que passou pelo freio: a vaga já está no `pacing_ledger` (reservada antes), então
 * envio que saiu não faz nada; envio que FALHOU (status `failed` ou exceção do handler) devolve a
 * vaga. Nunca lança.
 */
export async function concluirEnvioPorToken(
  deps: Pick<DepsDoRitmo, "pacing">,
  organizationId: string,
  segurado: EnvioSegurado,
  status: string,
): Promise<void> {
  if (!segurado || status !== "failed") return;
  try {
    await deps.pacing.libera(organizationId, segurado.channelSessionId, segurado.vagaId);
  } catch {
    // A devolução da vaga é melhor esforço: vaga não devolvida só deixa o número um envio mais
    // conservador, nunca menos.
  }
}

/**
 * D-167: erro na leitura do canal é RECUSA, não "sem freio". Antes o erro virava
 * `data = null`, o canal saía como inexistente e o envio seguia sem espaçamento
 * num número que pode ser banido. Quem chama já trata `ApiError`.
 */
function falhaDeLeituraDoCanal(): ApiError {
  return new ApiError(
    503,
    "upstream_unavailable",
    undefined,
    "",
    "Não foi possível conferir o ritmo de envio deste número agora. Tente de novo em instantes.",
  );
}

/** As dependências reais. `admin` é service role: toda leitura filtra `organization_id`. */
export async function depsDoRitmo(admin: SupabaseClient): Promise<DepsDoRitmo> {
  return {
    async lerCanalDaConversa(organizationId, conversationId) {
      const { data, error } = await admin
        .from("conversations")
        .select("channel_session_id, channel_sessions:channel_session_id(provider)")
        .eq("organization_id", organizationId)
        .eq("id", conversationId)
        .maybeSingle();
      if (error) throw falhaDeLeituraDoCanal();
      const linha = data as {
        channel_session_id: string | null;
        channel_sessions: { provider: string | null } | null;
      } | null;
      if (!linha?.channel_session_id) return null;
      return {
        channelSessionId: linha.channel_session_id,
        provider: linha.channel_sessions?.provider ?? null,
      };
    },
    async lerCanalDaSessao(organizationId, channelSessionId) {
      const { data, error } = await admin
        .from("channel_sessions")
        .select("id, provider")
        .eq("organization_id", organizationId)
        .eq("id", channelSessionId)
        .maybeSingle();
      if (error) throw falhaDeLeituraDoCanal();
      const linha = data as { id: string; provider: string | null } | null;
      if (!linha?.id) return null;
      return {
        channelSessionId: linha.id,
        provider: linha.provider ?? null,
      };
    },
    pacing: await criarPacingDoCanal(admin),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    agora: () => new Date(),
  };
}
