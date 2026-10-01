import type { OwnerKind } from "@/lib/types/leads";

/** O que o chamador quer mudar no dono. `undefined` = não mencionou. */
export interface OwnerPatchInput {
  owner_user_id?: string | null;
  owner_agent_id?: string | null;
}

/** O trio que vai para o banco — sempre coerente com a constraint. */
export interface OwnerPatch {
  owner_user_id: string | null;
  owner_agent_id: string | null;
  owner_kind: OwnerKind;
}

export type OwnerPatchResult =
  /** `patch: null` = o chamador não mencionou dono; não mexa nas colunas. */
  | { ok: true; patch: OwnerPatch | null }
  | { ok: false; reason: "two_owners" };

/**
 * Fonte ÚNICA da regra de posse de um negócio (migration 0070).
 *
 * Um lead tem um dono: humano OU agente, nunca os dois, e `owner_kind` sempre
 * concorda com a coluna preenchida. Quem escreve dono — create, patch, bulk,
 * MCP — passa por aqui.
 *
 * Por que um helper e não um guarda em cada chamador: o CHECK do banco aceita
 * `owner_kind = null` (para não quebrar escrita legada), então um escritor
 * distraído não estoura — ele grava um lead **com dono e sem kind**, some do
 * filtro e das métricas, e ninguém vê. Guarda espalhado protege os quatro
 * escritores de hoje; guarda aqui protege também o quinto, que ainda não foi
 * escrito.
 *
 * Puro de propósito: quem valida se o agente é da mesma org é o chamador que
 * tem o cliente do banco na mão.
 */
export function resolveOwnerPatch(input: OwnerPatchInput): OwnerPatchResult {
  const { owner_user_id: user, owner_agent_id: agent } = input;

  if (user === undefined && agent === undefined) {
    return { ok: true, patch: null };
  }

  if (user != null && agent != null) {
    return { ok: false, reason: "two_owners" };
  }

  if (user != null) {
    return {
      ok: true,
      patch: { owner_user_id: user, owner_agent_id: null, owner_kind: "user" },
    };
  }

  if (agent != null) {
    return {
      ok: true,
      patch: { owner_user_id: null, owner_agent_id: agent, owner_kind: "ai" },
    };
  }

  // Algum dos dois veio explicitamente null: tirar o dono limpa os três campos —
  // deixar `owner_kind` para trás é justamente o drift que este helper existe
  // para impedir.
  return { ok: true, patch: { owner_user_id: null, owner_agent_id: null, owner_kind: null } };
}

/**
 * Passar o negócio para OUTRA pessoa (ou agente) exige gerente (D-148).
 *
 * O `bulk` com `assign` já exigia gerente, mas o PATCH individual deixava um
 * atendente (ou um token `role:agent`, que no caminho do token roda com o cliente
 * admin e passa por cima da RLS) mandar o próprio `owner_user_id` e tomar o
 * negócio de um colega. O que continua livre para o papel abaixo de gerente:
 * pegar o negócio para si (`owner_user_id` = o próprio id) e soltar o que já é
 * seu. Repetir o dono atual não é troca.
 *
 * Só avalia quem traz `role` no ator: sessão e token de servidor trazem (o
 * `resolveAuthDual` e o MCP preenchem); agente de IA e regra de automação seguem
 * governados pelo `requiresRole` da própria ferramenta e pelo orquestrador, e um
 * chamador interno sem papel declarado já se autorizou na própria borda.
 */
export function trocaDeDonoExigeGerente(
  actor: { type: string; id: string; role?: string },
  existente: { owner_user_id?: string | null; owner_agent_id?: string | null },
  patch: OwnerPatch | null,
): boolean {
  if (!patch) return false;
  if (actor.type !== "user" && actor.type !== "api_token") return false;
  if (!actor.role) return false;
  if (actor.role === "manager" || actor.role === "admin") return false;

  const donoAtualUsuario = existente.owner_user_id ?? null;
  const donoAtualAgente = existente.owner_agent_id ?? null;
  if (patch.owner_user_id === donoAtualUsuario && patch.owner_agent_id === donoAtualAgente) {
    return false;
  }
  if (actor.type === "user") {
    if (patch.owner_user_id === actor.id) return false;
    const soltandoOProprio =
      patch.owner_user_id === null && patch.owner_agent_id === null && donoAtualUsuario === actor.id;
    if (soltandoOProprio) return false;
  }
  return true;
}
