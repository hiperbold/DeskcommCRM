import { destinosInternosAutorizados, faixasDeclaradas } from "@/lib/automation/destinos-internos-autorizados";

import type { FaixaAutorizada } from "./guardas";

/**
 * As faixas privadas que o dono da instalação autorizou, prontas para
 * `validarHostDeBanco`. A conexão de banco externo é sempre cadastrada por uma
 * ORGANIZAÇÃO, então só a lista da instalação abre a rede interna para ela.
 * `destinosInternosAutorizados` nunca lança; entrada mal formada é ignorada, e
 * ignorar é recusar.
 */
export async function faixasAutorizadasParaBanco(): Promise<FaixaAutorizada[]> {
  return faixasDeclaradas(await destinosInternosAutorizados());
}
