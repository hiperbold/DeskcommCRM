/**
 * Tarefa 7, fase F4: `enviarTextoFixoPendente` não envia o texto fixo de um
 * job cuja organização está em modo leitura. O job é consumido (settled
 * done=true pela RPC `fn_followup_inline_settle`, NÃO volta para `pending`),
 * e nenhum efeito de envio (`sendMessageHandler`/`sendWithLedger`) roda.
 *
 * Achado 3 da revisão (F4): o enrollment do job também é ENCERRADO
 * (cancelled/assinatura_suspensa em `followup_enrollments`), não só o job
 * settled. Antes disto o enrollment ficava parado no nó esperando um turno
 * que nunca mais chegaria até o dead-man de MAX_ACTION_RECHECKS decretar
 * `dead` sozinho ~11h depois, com um aviso falso `followup_dead` na Central.
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
  const enrollmentUpdates: Array<Record<string, unknown>> = [];
  const admin = {
    from: (tabela: string) => {
      if (tabela === "followup_enrollments") {
        return {
          update: (payload: Record<string, unknown>) => ({
            eq: () => ({
              eq: () => ({
                not: async () => {
                  enrollmentUpdates.push(payload);
                  return { data: null, error: null };
                },
              }),
            }),
          }),
        };
      }
      if (tabela === "job_queue") {
        return {
          // `enviar-texto-fixo.ts` filtra `run_after` com `.lt(...,
          // fimDoMilissegundoCorrente())`, não `.lte(...)` (achado da junção,
          // 2026-09-27: o autor trocou para `.lt` com o fim do milissegundo
          // corrente, ver o comentário de `fimDoMilissegundoCorrente` no
          // módulo, o dublê tinha que casar o mesmo método, senão a cadeia
          // quebra em runtime com "... .lt is not a function").
          select: () => ({
            eq: () => ({
              eq: () => ({
                lt: () => ({
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
                  lt: () => ({
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
  return { admin: admin as never, chamadasRpc: () => chamadasRpc, enrollmentUpdates };
}

describe("enviarTextoFixoPendente × modo leitura (Tarefa 7)", () => {
  it("organização em modo leitura: não envia, consome o job (settle done), sem chamar sendMessageHandler", async () => {
    const { admin, chamadasRpc } = fakeAdmin({ modo: "bloquear", modoLeitura: true });

    const enviados = await enviarTextoFixoPendente(admin);

    expect(enviados).toBe(0);
    expect(mocks.send).not.toHaveBeenCalled();
    expect(chamadasRpc()).toContain("fn_followup_inline_settle");
  });

  it("organização em modo leitura: encerra o enrollment (cancelled/assinatura_suspensa), sem esperar o dead-man", async () => {
    const { admin, enrollmentUpdates } = fakeAdmin({ modo: "bloquear", modoLeitura: true });

    await enviarTextoFixoPendente(admin);

    expect(enrollmentUpdates).toHaveLength(1);
    expect(enrollmentUpdates[0]).toMatchObject({
      status: "cancelled",
      cancel_reason: "assinatura_suspensa",
      next_eval_at: null,
      claimed_until: null,
    });
  });

  it("modo avisar: nenhuma consulta a mais, a RPC de modo leitura nunca é chamada", async () => {
    const { admin, chamadasRpc } = fakeAdmin({ modo: "avisar", modoLeitura: true });

    await enviarTextoFixoPendente(admin).catch(() => {});

    expect(chamadasRpc()).not.toContain("fn_billing_modo_leitura");
  });
});
