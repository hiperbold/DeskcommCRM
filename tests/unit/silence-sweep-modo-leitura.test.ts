/**
 * Tarefa 7, fase F4: `runSilenceSweep` pula o pointer inteiro (nenhum
 * enrollment novo) quando a organização está em modo leitura, e não consulta
 * nada a mais quando o modo (cacheado) não é 'bloquear'. Molde de
 * `automacao-modo-leitura.test.ts`/`campanha-modo-leitura.test.ts`, mas
 * usando a dependência REAL `contaEmModoLeitura` (não um mock burro): assim
 * o "zero consulta a mais no modo avisar" fica provado de ponta a ponta, não
 * só suposto.
 */
import { describe, expect, it } from "vitest";

import { runSilenceSweep, type SilenceSweepDb, type SilencePointer } from "@/lib/followup/silence-sweep";
import type { FollowupGateDb } from "@/lib/followup/agent-followup-gate";
import { contaEmModoLeitura } from "@/lib/billing/assinatura/modo-leitura";

const ORG = "22222222-2222-4222-8222-222222222222";

function fakeBillingAdmin(opts: { modo: string | null; modoLeitura: boolean }) {
  let chamadasRpc = 0;
  const admin = {
    from: (tabela: string) => {
      if (tabela === "billing_settings") {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: { modo: opts.modo }, error: null }) }),
          }),
        };
      }
      throw new Error(`tabela não esperada no teste: ${tabela}`);
    },
    rpc: async (nome: string) => {
      if (nome === "fn_billing_modo_leitura") {
        chamadasRpc += 1;
        return { data: opts.modoLeitura, error: null };
      }
      throw new Error(`rpc não esperada no teste: ${nome}`);
    },
  };
  return { admin: admin as never, contarRpc: () => chamadasRpc };
}

function fakeSweepDb(opts: {
  pointers: SilencePointer[];
  silentContactIds: string[];
}): SilenceSweepDb & { chamadasDeContatoSilencioso: string[] } {
  const chamadasDeContatoSilencioso: string[] = [];
  return {
    chamadasDeContatoSilencioso,
    async loadActiveSilencePointers() {
      return opts.pointers;
    },
    async loadSilentContactIds(orgId) {
      chamadasDeContatoSilencioso.push(orgId);
      return opts.silentContactIds;
    },
    async loadContatosComRetornoVivo() {
      return new Set<string>();
    },
    async loadTriggerNode() {
      return { id: "trigger-node", pedeAgente: false };
    },
    async insertEnrollment() {
      return { inserted: true };
    },
  };
}

const gateDb: FollowupGateDb = {
  async loadEnabledPublishedFollowupAgents() {
    return [{ agentId: "agent-1", pointerIds: ["pointer-1"] }];
  },
};

const pointer: SilencePointer = {
  id: "pointer-1",
  organization_id: ORG,
  active_version_id: "version-1",
  threshold_minutes: 60,
  segments: [],
};

describe("runSilenceSweep × modo leitura (Tarefa 7)", () => {
  it("organização em modo leitura: pula o pointer inteiro, sem consultar contato silencioso", async () => {
    const { admin, contarRpc } = fakeBillingAdmin({ modo: "bloquear", modoLeitura: true });
    const db = fakeSweepDb({ pointers: [pointer], silentContactIds: ["contact-1"] });

    const summary = await runSilenceSweep({
      db,
      gateDb,
      clock: () => new Date(),
      contaEmModoLeitura: (orgId) => contaEmModoLeitura(admin, orgId),
    });

    expect(summary.enrolled).toBe(0);
    expect(summary.pointers_modo_leitura).toBe(1);
    expect(db.chamadasDeContatoSilencioso).toEqual([]);
    expect(contarRpc()).toBe(1);
  });

  it("modo avisar: NENHUMA consulta a mais, a RPC de modo leitura nunca é chamada, sweep segue normal", async () => {
    const { admin, contarRpc } = fakeBillingAdmin({ modo: "avisar", modoLeitura: true });
    const db = fakeSweepDb({ pointers: [pointer], silentContactIds: ["contact-1"] });

    const summary = await runSilenceSweep({
      db,
      gateDb,
      clock: () => new Date(),
      contaEmModoLeitura: (orgId) => contaEmModoLeitura(admin, orgId),
    });

    expect(summary.pointers_modo_leitura).toBe(0);
    expect(summary.enrolled).toBe(1);
    expect(contarRpc()).toBe(0);
  });

  it("modo bloquear + RPC false (carência não vencida, ou status ativo): sweep segue normalmente", async () => {
    const { admin } = fakeBillingAdmin({ modo: "bloquear", modoLeitura: false });
    const db = fakeSweepDb({ pointers: [pointer], silentContactIds: ["contact-1"] });

    const summary = await runSilenceSweep({
      db,
      gateDb,
      clock: () => new Date(),
      contaEmModoLeitura: (orgId) => contaEmModoLeitura(admin, orgId),
    });

    expect(summary.enrolled).toBe(1);
    expect(summary.pointers_modo_leitura).toBe(0);
  });

  it("sem a dependência contaEmModoLeitura (omitida): sweep de sempre, sem gate nenhum", async () => {
    const db = fakeSweepDb({ pointers: [pointer], silentContactIds: ["contact-1"] });

    const summary = await runSilenceSweep({ db, gateDb, clock: () => new Date() });

    expect(summary.enrolled).toBe(1);
    expect(summary.pointers_modo_leitura).toBe(0);
  });
});
