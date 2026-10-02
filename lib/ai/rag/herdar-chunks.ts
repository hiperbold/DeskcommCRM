/**
 * A base "Conversas anteriores" ACUMULA (D-159).
 *
 * Cada rodada do `kb-conversations-batch` cria uma versão nova só com as conversas
 * das últimas 24 h e a ativa, e `activateVersion` desativa todas as outras da
 * fonte. As conversas de ontem já estão `ingested` (irreversível) e nunca voltam
 * ao lote: o agente perdia o acervo inteiro a cada dia. Antes de ativar a versão
 * nova, os trechos da versão que está ativa são copiados para ela.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

const PAGINA = 200;

export interface HerdarChunksArgs {
  organizationId: string;
  knowledgeSourceId: string;
  /** A versão que acabou de receber os trechos novos e vai ser ativada. */
  versaoNovaId: string;
}

/**
 * Copia os trechos da versão hoje ativa da fonte para a versão nova. Devolve
 * quantos copiou. Lança em qualquer erro: quem chama NÃO ativa a versão nova,
 * porque ativar sem a cópia seria apagar o acervo.
 */
export async function herdarChunksDaVersaoAtiva(
  admin: SupabaseClient,
  args: HerdarChunksArgs,
): Promise<number> {
  const { organizationId, knowledgeSourceId, versaoNovaId } = args;

  const { data: ativas, error: erroAtiva } = await admin
    .from("ai_knowledge_versions")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("knowledge_source_id", knowledgeSourceId)
    .eq("is_active", true)
    .neq("id", versaoNovaId);
  if (erroAtiva) throw new Error(`herdarChunks: ler versão ativa falhou: ${erroAtiva.message}`);
  const anteriores = (ativas ?? []) as Array<{ id: string }>;
  if (anteriores.length === 0) return 0;

  // As posições são únicas por (fonte, versão): os trechos copiados começam
  // depois da MAIOR posição que a versão nova já usa (falhas de gravação no lote
  // podem deixar buracos, então contar trechos não serve).
  const { data: ultima, error: erroDaPosicao } = await admin
    .from("ai_chunks")
    .select("position")
    .eq("organization_id", organizationId)
    .eq("knowledge_source_id", knowledgeSourceId)
    .eq("kb_version_id", versaoNovaId)
    .order("position", { ascending: false })
    .limit(1);
  if (erroDaPosicao) throw new Error(`herdarChunks: ler posição falhou: ${erroDaPosicao.message}`);
  const maior = ((ultima ?? []) as Array<{ position: number }>)[0]?.position;
  let posicao = maior === undefined ? 0 : maior + 1;

  let copiados = 0;
  for (const anterior of anteriores) {
    for (let de = 0; ; de += PAGINA) {
      const { data, error } = await admin
        .from("ai_chunks")
        .select("content, content_hash, token_count, embedding, metadata")
        .eq("organization_id", organizationId)
        .eq("knowledge_source_id", knowledgeSourceId)
        .eq("kb_version_id", anterior.id)
        .order("position", { ascending: true })
        .range(de, de + PAGINA - 1);
      if (error) throw new Error(`herdarChunks: ler trechos falhou: ${error.message}`);
      const pagina = (data ?? []) as Array<Record<string, unknown>>;
      if (pagina.length === 0) break;

      const { error: erroDeGravar } = await admin.from("ai_chunks").insert(
        pagina.map((c) => ({
          organization_id: organizationId,
          knowledge_source_id: knowledgeSourceId,
          kb_version_id: versaoNovaId,
          position: posicao++,
          content: c.content,
          content_hash: c.content_hash,
          token_count: c.token_count,
          embedding: c.embedding,
          metadata: c.metadata ?? {},
        })),
      );
      if (erroDeGravar) throw new Error(`herdarChunks: gravar trechos falhou: ${erroDeGravar.message}`);
      copiados += pagina.length;
      if (pagina.length < PAGINA) break;
    }
  }
  return copiados;
}
