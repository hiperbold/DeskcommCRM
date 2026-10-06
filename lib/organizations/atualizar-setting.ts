/**
 * Grava UMA chave de `organizations.settings` pelo banco (D-132).
 *
 * `settings` é um jsonb compartilhado por vários escritores. Ler o objeto
 * inteiro, espalhar em memória e regravá-lo inteiro (o que cada um fazia) perde
 * a atualização do outro quando os dois salvam quase juntos: o último apaga, em
 * silêncio, o que o primeiro gravou (a política de MFA, por exemplo). A função
 * `fn_atualizar_setting_da_organizacao` (0936) trava a linha e troca só o
 * caminho pedido, sem nunca devolver o objeto ao Node.
 *
 * Quem chama continua dono do gate de papel e do `organization_id` (vem de
 * fonte confiável, nunca do corpo): isto só substitui o read-modify-write.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type ResultadoDoSetting =
  | { ok: true }
  | { ok: false; motivo: "organizacao_nao_encontrada" | "banco"; detalhe?: string };

/** `valor` nulo remove a chave do caminho. */
export async function atualizarSettingDaOrganizacao(
  admin: SupabaseClient,
  organizationId: string,
  caminho: string[],
  valor: unknown,
): Promise<ResultadoDoSetting> {
  const { data, error } = await admin.rpc("fn_atualizar_setting_da_organizacao", {
    p_org: organizationId,
    p_caminho: caminho,
    p_valor: valor ?? null,
  });
  if (error) return { ok: false, motivo: "banco", detalhe: error.message };
  // 0 linhas = a organização não existe (o PostgREST não dá erro nesse caso).
  if (Number(data ?? 0) < 1) return { ok: false, motivo: "organizacao_nao_encontrada" };
  return { ok: true };
}
