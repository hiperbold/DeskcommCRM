/**
 * D-148: o PATCH individual do negócio deixava um atendente (ou uma chave
 * `role:agent`) passar o negócio de um colega para si ou para qualquer outro.
 * O `assign` do bulk já exigia gerente.
 *
 * Prova a regra pura (`trocaDeDonoExigeGerente`) e o encaixe no
 * `updateLeadHandler`: a recusa é 403 e acontece antes de qualquer gravação.
 */
import { describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/types";
import { trocaDeDonoExigeGerente, type OwnerPatch } from "@/lib/leads/owner-patch";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));

const EU = "11111111-1111-4111-8111-111111111111";
const COLEGA = "22222222-2222-4222-8222-222222222222";
const OUTRO = "33333333-3333-4333-8333-333333333333";
const ORG = "44444444-4444-4444-8444-444444444444";

const para = (id: string | null): OwnerPatch => ({
  owner_user_id: id,
  owner_agent_id: null,
  owner_kind: id ? "user" : null,
});
const doColega = { owner_user_id: COLEGA, owner_agent_id: null };
const semDono = { owner_user_id: null, owner_agent_id: null };

describe("D-148 trocaDeDonoExigeGerente", () => {
  it("token agent não toma o negócio do colega", () => {
    const token = { type: "api_token", id: "tok", role: "agent" };
    expect(trocaDeDonoExigeGerente(token, doColega, para(EU))).toBe(true);
    expect(trocaDeDonoExigeGerente(token, semDono, para(EU))).toBe(true);
  });

  it("atendente por sessão: pegar para si e soltar o próprio são livres; passar a outro exige gerente", () => {
    const eu = { type: "user", id: EU, role: "agent" };
    expect(trocaDeDonoExigeGerente(eu, semDono, para(EU))).toBe(false);
    expect(trocaDeDonoExigeGerente(eu, { owner_user_id: EU, owner_agent_id: null }, para(null))).toBe(false);
    expect(trocaDeDonoExigeGerente(eu, { owner_user_id: EU, owner_agent_id: null }, para(OUTRO))).toBe(true);
    expect(trocaDeDonoExigeGerente(eu, doColega, para(null))).toBe(true);
  });

  it("repetir o dono atual não é troca", () => {
    const eu = { type: "user", id: EU, role: "agent" };
    expect(trocaDeDonoExigeGerente(eu, doColega, para(COLEGA))).toBe(false);
  });

  it("gerente e admin trocam livremente", () => {
    for (const role of ["manager", "admin"]) {
      expect(trocaDeDonoExigeGerente({ type: "user", id: EU, role }, doColega, para(OUTRO))).toBe(false);
      expect(trocaDeDonoExigeGerente({ type: "api_token", id: "t", role }, doColega, para(OUTRO))).toBe(false);
    }
  });

  it("sem dono mencionado, ou ator sem papel declarado, ou agente de IA: não avalia", () => {
    expect(trocaDeDonoExigeGerente({ type: "api_token", id: "t", role: "agent" }, doColega, null)).toBe(false);
    expect(trocaDeDonoExigeGerente({ type: "user", id: EU }, doColega, para(OUTRO))).toBe(false);
    expect(
      trocaDeDonoExigeGerente({ type: "ai_agent", id: "run", role: "ai_operator" }, doColega, para(OUTRO)),
    ).toBe(false);
  });
});

describe("D-148 updateLeadHandler", () => {
  function banco() {
    const gravacoes: string[] = [];
    const leitura = {
      select: () => leitura,
      eq: () => leitura,
      maybeSingle: async () => ({
        data: { id: "l1", organization_id: ORG, owner_user_id: COLEGA, owner_agent_id: null, contact_id: null },
        error: null,
      }),
      update: () => {
        gravacoes.push("update");
        return leitura;
      },
    };
    return { gravacoes, client: { from: () => leitura } as never };
  }

  it("token agent tentando tomar o negócio do colega leva 403 e nada é gravado", async () => {
    const { updateLeadHandler } = await import("@/app/api/v1/leads/_handler");
    const b = banco();
    const erro = await updateLeadHandler(
      b.client,
      {
        organization_id: ORG,
        actor: { type: "api_token", id: "tok", role: "agent" },
        requestId: "r1",
      },
      "l1",
      { owner_user_id: EU } as never,
    ).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(ApiError);
    expect((erro as ApiError).status).toBe(403);
    expect(b.gravacoes).toEqual([]);
  });
});
