/**
 * De QUEM é a chave que o resolvedor de modelo escolheu, no vocabulário de
 * `llm_calls.origem_da_chave` (0906, carteira de tokens; D-057).
 *
 * É o que leva a origem até `logInvocation` nos dois workers antigos
 * (`ai-sentiment-worker`, `ai-response-worker`), que resolvem o modelo por
 * `resolverModeloDoPonto` (`./gateway-binding`) e não por `resolveOrgLlmConfig`.
 * A resposta sai do degrau que ESCOLHEU a chave, o único que sabe:
 *
 *  - `binding` e `credencial_da_organizacao`: a chave é uma linha de
 *    `ai_provider_credentials` DA PRÓPRIA organização (as duas leituras filtram
 *    `organization_id`), a que o cliente cadastrou. Nunca debita a carteira.
 *  - `padrao`: caiu no `.env` da instalação (`resolveLanguageModel`: gateway,
 *    OpenRouter, Anthropic ou OpenAI da instalação). É a chave que a Hiperbold
 *    paga, e a única que debita.
 *
 * Fica em arquivo próprio, e não dentro de `gateway-binding.ts`, porque vários
 * testes mockam aquele módulo inteiro só com `resolverModeloDoPonto`. Um valor
 * novo em `ModeloResolvido["origem"]` quebra a compilação aqui (o `switch` é
 * exaustivo) em vez de cair em silêncio numa das duas origens.
 */
import type { OrigemDaChaveLlm } from "@/lib/agent-engine/edge/llm/credentials";
import type { ModeloResolvido } from "@/lib/ai/gateway-binding";

export function origemDaChaveDoModelo(origem: ModeloResolvido["origem"]): OrigemDaChaveLlm {
  switch (origem) {
    case "binding":
    case "credencial_da_organizacao":
      return "credencial_da_organizacao";
    case "padrao":
      return "chave_da_instalacao";
  }
}
