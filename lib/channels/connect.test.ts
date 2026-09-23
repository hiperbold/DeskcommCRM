/**
 * Fase F3, tarefa 5 (hiperbold/planos/fase-F3-tarefas.md): `savePartnerSession`
 * precisa devolver o erro CRU do banco (`errorRaw`), não só a mensagem — é o
 * que permite a rota reconhecer o PT402 pelo `code` (decisão 9).
 */
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { savePartnerSession } from "./connect";

const ORG = "20000000-0000-4000-8000-000000000001";

/** Dublê mínimo: só `channel_sessions`, só `insert`/`update`, erro configurável. */
function dbComErro(erro: { code: string; message: string; details?: string } | null): SupabaseClient {
  const builder = {
    insert: () => builder,
    update: () => builder,
    eq: () => builder,
    then: (res: (v: unknown) => unknown) => res({ data: null, error: erro }),
  };
  return { from: () => builder } as unknown as SupabaseClient;
}

const INPUT_BASE = {
  organizationId: ORG,
  existingId: null,
  accountId: "conta-1",
  apiKeyEncrypted: "cifrado",
  webhookPathToken: "token",
  webhookSecretEncrypted: "cifrado-2",
  phoneNumber: null,
  displayName: "Zernio",
};

describe("savePartnerSession", () => {
  it("devolve o erro CRU (errorRaw) além da mensagem, com code e details intactos", async () => {
    const db = dbComErro({ code: "PT402", message: "Limite do plano atingido", details: "conexoes" });
    const { error, errorRaw } = await savePartnerSession(db, INPUT_BASE);

    expect(error).toBe("Limite do plano atingido");
    expect(errorRaw).toEqual({ code: "PT402", message: "Limite do plano atingido", details: "conexoes" });
  });

  it("sem erro, errorRaw é null", async () => {
    const db = dbComErro(null);
    const { error, errorRaw } = await savePartnerSession(db, INPUT_BASE);
    expect(error).toBeNull();
    expect(errorRaw).toBeNull();
  });
});
