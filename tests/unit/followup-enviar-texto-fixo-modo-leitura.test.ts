/**
 * Tarefa 7, fase F4: `enviarTextoFixoPendente` não envia o texto fixo de um
 * job cuja organização está em modo leitura. O job é consumido (settled
 * done=true pela RPC `fn_followup_inline_settle`, NÃO volta para `pending`),
 * e nenhum efeito de envio (`sendMessageHandler`/`sendWithLedger`) roda.
 */
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@/app/api/v1/messages/_handler", () => ({ sendMessageHandler: mocks.send }));

import { enviarTextoFixoPendente } from "@/lib/followup/enviar-texto-fixo";

const ORG = "55555555-5555-4555-8555-555555555555";
const JOB = {
  id: "job-1",
  organization_id: ORG,
  contact_id: "contact-1",
  payload: {
    fixed_body: "Oi, tudo bem?",
    followup_enrollment_id: "enrollment-1",
    node_id: "node-1",
    purpose: "send_message",
    service_boundary: { conversation_id: "conv-1" },
  },
  attempts: 0,
  max_attempts: 3,
};

function fakeAdmin(opts: { modo: string | null; modoLeitura: boolean }) {
  const chamadasRpc: string[] = [];
  const admin = {
    from: (tabela: string) => {
      if (tabela === "job_queue") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                lte: () => ({
                  order: () => ({
                    limit: async () => ({ data: [JOB], error: null }),
                  }),
                }),
              }),
            }),
          }),
          update: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  lte: () => ({
                    select: () => ({
                      maybeSingle: async () => ({
                        data: { id: JOB.id, locked_by: "worker-x", locked_at: new Date().toISOString() },
                        error: null,
                      }),
                    }),
                  }),
                }),
              }),
            }),
          }),
        };
      }
      if (tabela === "billing_settings") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: { modo: opts.modo }, error: null }),
            }),
          }),
        };
      }
      throw new Error(`tabela não esperada no teste: ${tabela}`);
    },
    rpc: async (nome: string) => {
      chamadasRpc.push(nome);
      if (nome === "fn_billing_modo_leitura") return { data: opts.modoLeitura, error: null };
      if (nome === "fn_followup_inline_settle") return { data: true, error: null };
      throw new Error(`rpc não esperada: ${nome}`);
    },
  };
  return { admin: admin as never, chamadasRpc: () => chamadasRpc };
}

describe("enviarTextoFixoPendente × modo leitura (Tarefa 7)", () => {
  it("organização em modo leitura: não envia, consome o job (settle done), sem chamar sendMessageHandler", async () => {
    const { admin, chamadasRpc } = fakeAdmin({ modo: "bloquear", modoLeitura: true });

    const enviados = await enviarTextoFixoPendente(admin);

    expect(enviados).toBe(0);
    expect(mocks.send).not.toHaveBeenCalled();
    expect(chamadasRpc()).toContain("fn_followup_inline_settle");
  });

  it("modo avisar: nenhuma consulta a mais, a RPC de modo leitura nunca é chamada", async () => {
    const { admin, chamadasRpc } = fakeAdmin({ modo: "avisar", modoLeitura: true });

    await enviarTextoFixoPendente(admin).catch(() => {});

    expect(chamadasRpc()).not.toContain("fn_billing_modo_leitura");
  });
});
