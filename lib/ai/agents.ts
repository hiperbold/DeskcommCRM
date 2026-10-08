/**
 * Busca o ai_agent configurado como agente de VOZ pra uma org
 * (ai_agents.channel = 'voice', coluna aditiva da migration 0347).
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { AGENT_CONFIG_DEFAULTS, agentConfigSchema } from "@/lib/ai/guardrails-schema";
import { decifrarColunasDaCredencial } from "@/lib/ai/credenciais/cifra";
import { logger } from "@/lib/logger";

export interface VoiceAgentConfig {
  id: string;
  systemPrompt: string;
  /** Voz e velocidade da fala (session.audio.output) e parâmetros de RAG —
   *  configuráveis por Configurações > Agente > aba Voz, com fallback pros
   *  defaults quando a organização nunca mexeu nisso. */
  voice: string;
  voiceSpeed: number;
  ragTopK: number;
  ragSimilarityThreshold: number;
  voiceModel: string;
  /**
   * Chave da OpenAI pra abrir a sessão Realtime (WebSocket cru, não passa
   * pelo AI Gateway). Vem, em ordem: credencial cadastrada em IA >
   * Credenciais pra esta org, ou env OPENAI_API_KEY do servidor.
   */
  apiKey: string;
  /**
   * De quem é a chave acima: da organização (cadastrada em IA > Credenciais) ou
   * da INSTALAÇÃO (o `OPENAI_API_KEY` do servidor, que a Hiperbold paga). É o que
   * decide se a ligação entra na carteira e no teto diário (D-117).
   */
  origemDaChave: "chave_da_instalacao" | "credencial_da_organizacao";
}

/**
 * A chave OpenAI ativa e validada desta org, cadastrada em IA > Credenciais --
 * mesma tabela/decrypt que o resto do produto usa (ver lib/ai/embeddings/chave.ts,
 * que resolve o mesmo tipo de chave pra embeddings). Sem credencial de org, cai
 * na chave do .env do servidor -- nunca deixa a ligação sem chave nenhuma.
 *
 * Desempate determinístico pela mais antiga (não "a mais recente"): com duas
 * chaves cadastradas e nenhuma escolha explícita, variar sozinho no dia em que
 * alguém cadastra uma segunda é pior que sempre usar a mesma.
 */
async function resolverChaveOpenAiDaVoz(
  organizationId: string,
): Promise<{ apiKey: string; origemDaChave: VoiceAgentConfig["origemDaChave"] }> {
  try {
    const admin = createAdminClient();
    const { data } = await admin
      .from("ai_provider_credentials")
      .select("id, api_key_encrypted, api_key_iv, api_key_tag")
      .eq("organization_id", organizationId)
      .eq("provider", "openai")
      .eq("is_active", true)
      .not("validated_at", "is", null)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (data) {
      return {
        apiKey: decifrarColunasDaCredencial(data, organizationId),
        origemDaChave: "credencial_da_organizacao",
      };
    }
  } catch {
    // Decrypt falhou ou a query deu erro -- cai pro .env abaixo. Não se ecoa
    // detalhe de credencial no log do worker, mas a QUEDA em si é registrada
    // abaixo: cair para a chave da instalação em silêncio faz a Hiperbold pagar
    // a ligação de quem tinha chave própria (D-117, agrava o D-080).
    logger.warn("[voice-agent] credencial da organização falhou: usando a chave da instalação", {
      organization_id: organizationId,
    });
  }
  return { apiKey: process.env.OPENAI_API_KEY ?? "", origemDaChave: "chave_da_instalacao" };
}

export async function getActiveVoiceAgent(organizationId: string): Promise<VoiceAgentConfig | null> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("ai_agents")
    .select("id, system_prompt, config")
    .eq("organization_id", organizationId)
    .eq("channel", "voice")
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();

  if (error || !data) return null;

  const cfgParsed = agentConfigSchema.safeParse({
    ...AGENT_CONFIG_DEFAULTS,
    ...((data.config ?? {}) as Record<string, unknown>),
  });
  const cfg = cfgParsed.success ? cfgParsed.data : AGENT_CONFIG_DEFAULTS;

  return {
    id: data.id,
    systemPrompt: data.system_prompt,
    voice: cfg.voice,
    voiceSpeed: cfg.voice_speed,
    voiceModel: cfg.voice_model,
    ragTopK: cfg.rag_top_k,
    ragSimilarityThreshold: cfg.rag_similarity_threshold,
    ...(await resolverChaveOpenAiDaVoz(organizationId)),
  };
}
