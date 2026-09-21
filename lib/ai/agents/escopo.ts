/**
 * O ESCOPO DE UMA VERSÃO APONTA PARA COISAS QUE EXISTEM.
 *
 * `pipeline_ids` e `knowledge_source_ids` são arrays de uuid no corpo da versão,
 * e o Zod que os valida é COMPARTILHADO COM O BROWSER — ele confere formato, não
 * existência, porque um schema que roda no cliente não faz consulta cross-row.
 * O cabeçalho de `validation.ts` diz isso desde a 0125 e promete que "a
 * validação de que o funil existe mora no servidor". Ela nunca foi escrita.
 *
 * `tool_ids` e `operator_tool_ids` têm a MESMA lacuna para a ferramenta externa
 * (`mcp_<apelido>__<nome>`): o Zod compartilhado (`capacidadeConhecida`, D17)
 * só confere a FORMA do id, porque não consulta o banco. Se a conexão foi
 * desligada ou a ferramenta sumiu do cache depois que a versão foi salva, o
 * id continua "bem formado" e passaria direto sem esta checagem.
 *
 * O que a ausência produz não é um erro: é uma configuração muda. Um id de outra
 * organização (ou de um material apagado) entra no array, a versão é publicada,
 * e o assistente simplesmente não acha nada — sem erro, sem aviso, com a tela
 * mostrando a marcação como se estivesse valendo.
 *
 * Falha FECHADA na ação (recusa a publicação) e ABERTA na informação (diz qual
 * id não existe): o operador tem de conseguir consertar sem adivinhar.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { lerIdDaFerramenta, separarFerramentas } from "@/lib/ai/mcp-externo/ids";
import type { FerramentaEmCache } from "@/lib/ai/mcp-externo/tipos";

export interface EscopoDaVersao {
  pipeline_ids?: string[];
  knowledge_source_ids?: string[];
  tool_ids?: string[];
  operator_tool_ids?: string[];
}

export type ResultadoDoEscopo =
  | { ok: true }
  | {
      ok: false;
      campo: "pipeline_ids" | "knowledge_source_ids" | "tool_ids" | "operator_tool_ids";
      ausentes: string[];
    };

/**
 * Confere que todo id do escopo existe NESTA organização.
 *
 * Recebe o client do CHAMADOR de propósito: com o client do usuário a RLS já
 * filtra por organização, e com o admin o filtro programático abaixo faz o mesmo
 * trabalho. Os dois caminhos chegam à mesma resposta.
 */
export async function validarEscopoDaVersao(
  supabase: SupabaseClient,
  organizationId: string,
  escopo: EscopoDaVersao,
): Promise<ResultadoDoEscopo> {
  const funis = escopo.pipeline_ids ?? [];
  if (funis.length > 0) {
    const { data } = await supabase
      .from("crm_pipelines")
      .select("id")
      .eq("organization_id", organizationId)
      .in("id", funis);
    const achados = new Set(((data ?? []) as Array<{ id: string }>).map((r) => r.id));
    const ausentes = funis.filter((id) => !achados.has(id));
    if (ausentes.length > 0) return { ok: false, campo: "pipeline_ids", ausentes };
  }

  const materiais = escopo.knowledge_source_ids ?? [];
  if (materiais.length > 0) {
    // `is_active` entra na conferência: marcar material ARQUIVADO é a mesma
    // configuração muda de marcar um que não existe — o agente não acha nada
    // nele, porque a busca filtra fonte inativa.
    const { data } = await supabase
      .from("ai_knowledge_sources")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("is_active", true)
      .in("id", materiais);
    const achados = new Set(((data ?? []) as Array<{ id: string }>).map((r) => r.id));
    const ausentes = materiais.filter((id) => !achados.has(id));
    if (ausentes.length > 0) return { ok: false, campo: "knowledge_source_ids", ausentes };
  }

  // `tool_ids` e `operator_tool_ids`: só os ids EXTERNOS entram na consulta —
  // um id do catálogo é constante em código, já conferido pelo Zod, e não tem
  // linha nenhuma pra buscar aqui.
  for (const campo of ["tool_ids", "operator_tool_ids"] as const) {
    const externas = separarFerramentas(escopo[campo] ?? []).externas;
    if (externas.length === 0) continue;
    const apelidos = [...new Set(externas.map((id) => lerIdDaFerramenta(id)!.apelido))];
    const { data } = await supabase
      .from("ai_mcp_connections")
      .select("slug, tools_cache")
      .eq("organization_id", organizationId)
      .eq("is_active", true)
      .in("slug", apelidos);
    const disponiveis = new Set(
      ((data ?? []) as Array<{ tools_cache: FerramentaEmCache[] }>).flatMap((c) =>
        c.tools_cache.map((f) => f.id).filter((id): id is string => id !== null),
      ),
    );
    const ausentes = externas.filter((id) => !disponiveis.has(id));
    if (ausentes.length > 0) return { ok: false, campo, ausentes };
  }

  return { ok: true };
}

/** Frase para quem lê na tela — nunca o id cru sem contexto. */
export function mensagemDoEscopo(r: Extract<ResultadoDoEscopo, { ok: false }>): string {
  if (r.campo === "pipeline_ids")
    return `Um dos funis marcados não existe mais nesta organização (${r.ausentes.length}). Recarregue a página e marque de novo.`;
  if (r.campo === "knowledge_source_ids")
    return `Um dos materiais marcados não existe mais, ou foi arquivado (${r.ausentes.length}). Recarregue a página e marque de novo.`;
  return `Uma das ferramentas de conexão MCP marcadas não existe mais ou a conexão foi desligada (${r.ausentes.length}). Abra IA › Conexões MCP, atualize as ferramentas e marque de novo.`;
}
