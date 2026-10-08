/**
 * Liga e desliga um MÓDULO OPCIONAL da instalação direto no banco do e2e
 * (`platform_config`), sem passar pela tela de `/admin/sistema`.
 *
 * Existe para as specs cuja tela só existe com o módulo ligado: a marca própria
 * de cada empresa (D-178) nasce DESLIGADA, então `marca-logo.spec.ts` e
 * `logo-moldura-no-tema-escuro.spec.ts` ligam o módulo antes de abrir
 * `/app/settings/marca` e o devolvem ao padrão no fim. O caminho de escrita é o
 * mesmo do produto (`gravarModulo`), para a spec medir a chave real e não uma cópia.
 */
import { createClient } from "@supabase/supabase-js";

import { credenciaisSupabaseDeTeste } from "../../../scripts/lib/env-de-teste";
import { CHAVE_DO_MODULO, gravarModulo, type ModuloOpcional } from "../../../lib/instalacao/modulos";

function bancoDoE2e() {
  const credenciais = credenciaisSupabaseDeTeste();
  return createClient(credenciais.url, credenciais.serviceRole, { auth: { persistSession: false } });
}

/** Liga o módulo. `ator` é o id de quem "liga" (aparece em `updated_by`). */
export async function ligarModuloNoE2e(modulo: ModuloOpcional, ator: string): Promise<void> {
  if (!(await gravarModulo(bancoDoE2e(), modulo, true, ator))) {
    throw new Error(`não consegui ligar o módulo ${modulo} no banco do e2e`);
  }
}

/** Devolve o módulo ao padrão de fábrica: linha ausente = desligado. */
export async function desligarModuloNoE2e(modulo: ModuloOpcional): Promise<void> {
  const { error } = await bancoDoE2e()
    .from("platform_config")
    .delete()
    .eq("chave", CHAVE_DO_MODULO[modulo]);
  if (error) throw new Error(`não consegui desligar o módulo ${modulo}: ${error.message}`);
}
