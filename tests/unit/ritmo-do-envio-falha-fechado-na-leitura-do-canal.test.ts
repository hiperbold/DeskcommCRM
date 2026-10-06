/**
 * D-167: erro ao ler o canal NÃO libera o envio sem espaçamento.
 *
 * Antes, o erro do banco virava `data = null`, o canal saía como inexistente e
 * `reservarEnvioPorToken` devolvia `null` (nada a frear): o envio seguia sem o
 * freio num número que pode ser banido.
 */
import { describe, expect, it } from "vitest";

import { depsDoRitmo, reservarEnvioPorToken } from "@/lib/messaging/ritmo-do-envio-por-token";

const ORG = "22222222-2222-4222-8222-222222222222";
const CONVERSA = "33333333-3333-4333-8333-333333333333";

function adminComErro() {
  const q: Record<string, unknown> = {
    select: () => q,
    eq: () => q,
    maybeSingle: async () => ({ data: null, error: { message: "connection reset" } }),
    then: (r: (v: unknown) => unknown) => r({ data: null, error: { message: "connection reset" } }),
  };
  return { from: () => q, rpc: async () => ({ data: null, error: null }) };
}

describe("freio de envio por token: leitura do canal que falha", () => {
  it("vira recusa 503, e não 'sem freio'", async () => {
    const deps = await depsDoRitmo(adminComErro() as never);
    await expect(
      reservarEnvioPorToken(deps, { organizationId: ORG, conversationId: CONVERSA, requestId: "r" }),
    ).rejects.toMatchObject({ status: 503 });
  });
});
