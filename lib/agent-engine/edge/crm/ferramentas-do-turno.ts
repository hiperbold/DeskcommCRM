/**
 * O montador ÚNICO das capacidades do turno: catálogo do CRM (ponte interna,
 * `buildMcpTurnTools`) + ferramentas de servidores MCP externos
 * (`buildExternalMcpTools`). Conversador e Operador chamam esta função, então
 * a regra de separar as duas famílias existe num lugar só. A ponte interna
 * nunca vê um id `mcp_*` (ela não os conhece), e as externas nunca passam
 * pela ponte.
 */
import type { Tool } from "ai";

import { separarFerramentas } from "@/lib/ai/mcp-externo/ids";

import type { Logger } from "../../obs/logger";
import type { PublishedAgentConfig } from "../../agent/agent-config";
import type { CrmEdgeConfig } from "./mcp-client";
import { buildMcpTurnTools, type McpTurnTools } from "./mcp-tools";
import { buildExternalMcpTools, type MotivoDaPulada } from "./mcp-externo-tools";

/** `MotivoDaPulada` (de `mcp-externo-tools.ts`) + os motivos que só existem NESTE montador. */
export type MotivoDaPuladaNoTurno = MotivoDaPulada | "entregue_ao_operador";

export async function montarFerramentasDoTurno(
  cfg: CrmEdgeConfig,
  ids: { organizationId: string; jobId: string },
  agentConfig: PublishedAgentConfig,
  log: Logger,
  options?: { readOnly: boolean },
  deps: { interno?: typeof buildMcpTurnTools; externo?: typeof buildExternalMcpTools } = {},
  /**
   * (F) Presente só quando ESTA chamada é a do CONVERSADOR e o Operador está
   * ligado — nunca passado pela chamada do próprio Operador (ele precisa de
   * TODAS as suas ferramentas, inclusive as de escrita: é ele quem escreve).
   * Ver o comentário no bloco de filtragem abaixo para a regra e o porquê do
   * ponto escolhido.
   */
  entregaAoOperador?: { operadorLigado: boolean; ferramentasDoOperador: readonly string[] },
): Promise<
  | (McpTurnTools & {
      toolIdsExternos: string[];
      puladas: Array<{ id: string; motivo: MotivoDaPuladaNoTurno }>;
      /** ids externos com `somente_leitura_confirmado === true` — o que a prévia (H) pode liberar. */
      externasDeConsulta: Set<string>;
    })
  | null
> {
  const { catalogo, externas } = separarFerramentas(agentConfig.toolIds);
  const interno = deps.interno ?? buildMcpTurnTools;
  const externo = deps.externo ?? buildExternalMcpTools;

  const doCatalogo = catalogo.length
    ? await interno(cfg, ids, { ...agentConfig, toolIds: catalogo }, log, options)
    : null;

  // A montagem externa é UM PASSO A MAIS sobre o catálogo, nunca uma
  // pré-condição dele: banco fora do ar, cifra indisponível ou qualquer
  // outra exceção na montagem externa não pode derrubar as capacidades do
  // catálogo, cujo token já foi mintado e será fechado pelo `cleanup` de
  // `doCatalogo` normalmente. Todo id externo pedido vira órfão avisado
  // (`conexao_indisponivel`), igual ao caso de uma conexão desativada.
  let deFora: Awaited<ReturnType<typeof buildExternalMcpTools>> | null = null;
  if (externas.length) {
    try {
      deFora = await externo(cfg.supabase, ids.organizationId, externas, log, {
        readOnly: options?.readOnly,
        // (G) quem chamou uma ferramenta de escrita, pra a linha de auditoria
        // dela — threaded aqui, um lugar só, então nem inbound-turn.ts nem
        // operator-turn.ts precisam saber que a auditoria existe.
        contexto: { agentId: agentConfig.agentId, jobId: ids.jobId },
      });
    } catch (err) {
      log.warn("montagem das ferramentas MCP externas falhou; turno segue só com o catálogo", {
        error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
      });
      deFora = {
        tools: {},
        toolIds: [],
        puladas: externas.map((id) => ({ id, motivo: "conexao_indisponivel" as const })),
        externasDeConsulta: new Set<string>(),
        cleanup: async () => {},
      };
    }
  }

  /**
   * (F) A MESMA regra de `catalogoEntregueAoOperador`
   * (`lib/agent-engine/agent/entrega-de-capacidade.ts`): uma capacidade não
   * fica com os dois papéis ao mesmo tempo quando um deles é dono da
   * OPERAÇÃO. Para o catálogo isso é decidido por uma lista fixa
   * (`CAPACIDADES_DE_OPERACAO`), porque a ferramenta nativa não carrega risco
   * algum sozinha. A externa carrega — `somente_leitura_confirmado` é o dado
   * que decide, e ele só existe DEPOIS que `buildExternalMcpTools` já leu o
   * cache da conexão (é o "onde a decisão mora" citado no briefing). Por
   * isso o ponto mais simples não é ANTES da montagem (como o catálogo faz,
   * puramente por id), e sim um filtro DEPOIS dela, aqui: `deFora` já trouxe
   * `externasDeConsulta` (os ids com `=== true`) de graça, então não é
   * preciso ler o cache de novo nem estender `buildExternalMcpTools`.
   *
   * A regra: um id que o Operador também tem marcado (`ferramentasDoOperador`)
   * só continua com o Conversador se for CONSULTA confirmada; o resto
   * (escrita, ou sem confirmação — que já nem chegou a montar) é do Operador.
   * Em prévia (`options.readOnly`) isto nunca remove nada a mais: só ids com
   * `=== true` chegam a montar de qualquer forma, e são sempre consulta.
   */
  // Larguras próprias (não o tipo estreito de `FerramentasExternas`, que só
  // conhece `MotivoDaPulada`): `entregue_ao_operador` só existe NESTE
  // montador, então o resultado final é composto aqui, sem reatribuir
  // `deFora` — ele continua servindo o `cleanup` e o `externasDeConsulta`
  // originais intocados.
  let toolsExternos: Record<string, Tool> = deFora?.tools ?? {};
  let toolIdsExternos: string[] = deFora?.toolIds ?? [];
  let puladasExternas: Array<{ id: string; motivo: MotivoDaPuladaNoTurno }> = deFora?.puladas ?? [];

  if (deFora && entregaAoOperador?.operadorLigado) {
    const candidatos = new Set(
      externas.filter((id) => entregaAoOperador.ferramentasDoOperador.includes(id)),
    );
    if (candidatos.size > 0) {
      const toolsQueFicam: Record<string, Tool> = {};
      const toolIdsQueFicam: string[] = [];
      const puladasComEntrega: Array<{ id: string; motivo: MotivoDaPuladaNoTurno }> = [...deFora.puladas];
      for (const id of deFora.toolIds) {
        if (candidatos.has(id) && !deFora.externasDeConsulta.has(id)) {
          puladasComEntrega.push({ id, motivo: "entregue_ao_operador" });
          continue;
        }
        toolsQueFicam[id] = deFora.tools[id]!;
        toolIdsQueFicam.push(id);
      }
      toolsExternos = toolsQueFicam;
      toolIdsExternos = toolIdsQueFicam;
      puladasExternas = puladasComEntrega;
    }
  }

  if (!doCatalogo && !deFora) return null;
  return {
    tools: { ...(doCatalogo?.tools ?? {}), ...toolsExternos },
    // SÓ os ids do catálogo (D16). O turno empurra esta lista em
    // `mcpToolIdsDoTurno`, e `turnoProjeta()` só liga o filtro que tira ids
    // internos (lead_id, conversation_id) do contexto quando ela está vazia.
    // Um agente só com ferramentas MCP externas precisa desse filtro ligado:
    // senão ele vê os ids internos e pode repassá-los ao servidor de
    // terceiro. Por isso as externas vão à parte, em `toolIdsExternos`.
    toolIds: doCatalogo?.toolIds ?? [],
    toolIdsExternos,
    puladas: puladasExternas,
    externasDeConsulta: deFora?.externasDeConsulta ?? new Set<string>(),
    cleanup: async () => {
      await Promise.allSettled([doCatalogo?.cleanup(), deFora?.cleanup()]);
    },
  };
}
