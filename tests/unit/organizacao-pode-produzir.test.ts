/**
 * M1 (auditoria do lote 16): o follow-up (texto fixo, matrícula, enfileiramento) só conferia
 * `contaEmModoLeitura` (cobrança). Organização suspensa por spam pelo admin da plataforma, com a
 * cobrança em dia, seguia mandando WhatsApp. O helper único `organizacaoPodeProduzir` junta os dois
 * motivos (status diferente de `active` OU modo leitura) e os pontos que produzem passam por ele.
 *
 * O que se mede é COMPORTAMENTO, contra o helper e o produtor real com o banco dublado só na
 * borda (o `admin` do Supabase).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@/app/api/v1/messages/_handler", () => ({ sendMessageHandler: mocks.send }));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { limparCacheDoStatusDaOrganizacao } from "@/lib/billing/assinatura/status-da-organizacao";
import {
  contaBloqueadaParaProduzir,
  motivoDeNaoProduzir,
  organizacaoPodeProduzir,
} from "@/lib/billing/assinatura/pode-produzir";
import { enviarTextoFixoPendente } from "@/lib/followup/enviar-texto-fixo";

const ORG = "55555555-5555-4555-8555-555555555555";

beforeEach(() => {
  vi.clearAllMocks();
  limparCacheDoStatusDaOrganizacao();
});

interface Cenario {
  /** `organizations.status`; 'erro' simula a leitura falhando. */
  status: string;
  /** `billing_settings.modo`. */
  modo?: string;
  /** O que `fn_billing_modo_leitura` devolve. */
  leitura?: boolean;
}

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

function adminDoCenario(c: Cenario) {
  const leiturasDeStatus: string[] = [];
  const rpcs: string[] = [];
  const enrollmentUpdates: Array<Record<string, unknown>> = [];
  const admin = {
    from: (tabela: string) => {
      if (tabela === "organizations") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => {
                leiturasDeStatus.push(ORG);
                if (c.status === "erro") return { data: null, error: { message: "banco fora" } };
                return { data: { status: c.status }, error: null };
              },
            }),
          }),
        };
      }
      if (tabela === "billing_settings") {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: { modo: c.modo ?? "avisar" }, error: null }) }),
          }),
        };
      }
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
          select: () => ({
            eq: () => ({
              eq: () => ({ lt: () => ({ order: () => ({ limit: async () => ({ data: [JOB], error: null }) }) }) }),
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
      throw new Error(`tabela não esperada no teste: ${tabela}`);
    },
    rpc: async (nome: string) => {
      rpcs.push(nome);
      if (nome === "fn_billing_modo_leitura") return { data: c.leitura ?? false, error: null };
      if (nome === "fn_followup_inline_settle") return { data: true, error: null };
      throw new Error(`rpc não esperada: ${nome}`);
    },
  };
  return { admin: admin as never, leiturasDeStatus, rpcs, enrollmentUpdates };
}

describe("organizacaoPodeProduzir: status ativo E fora do modo leitura", () => {
  it("organização suspensa com a cobrança em dia (modo avisar): NÃO pode produzir, e o motivo é organizacao_inativa", async () => {
    const { admin, rpcs } = adminDoCenario({ status: "suspended", modo: "avisar" });
    await expect(organizacaoPodeProduzir(admin, ORG)).resolves.toBe(false);
    await expect(motivoDeNaoProduzir(admin, ORG)).resolves.toBe("organizacao_inativa");
    await expect(contaBloqueadaParaProduzir(admin, ORG)).resolves.toBe(true);
    expect(rpcs).not.toContain("fn_billing_modo_leitura");
  });

  it("organização arquivada também não produz", async () => {
    const { admin } = adminDoCenario({ status: "archived" });
    await expect(organizacaoPodeProduzir(admin, ORG)).resolves.toBe(false);
  });

  it("organização ativa em modo leitura: não produz, motivo assinatura_suspensa", async () => {
    const { admin } = adminDoCenario({ status: "active", modo: "bloquear", leitura: true });
    await expect(motivoDeNaoProduzir(admin, ORG)).resolves.toBe("assinatura_suspensa");
  });

  it("organização ativa e em dia: produz (controle positivo)", async () => {
    const { admin } = adminDoCenario({ status: "active", modo: "bloquear", leitura: false });
    await expect(organizacaoPodeProduzir(admin, ORG)).resolves.toBe(true);
    await expect(contaBloqueadaParaProduzir(admin, ORG)).resolves.toBe(false);
  });

  it("a leitura do status é cacheada: várias consultas da mesma organização leem a linha uma vez só", async () => {
    const { admin, leiturasDeStatus } = adminDoCenario({ status: "active" });
    for (let i = 0; i < 5; i++) await organizacaoPodeProduzir(admin, ORG);
    expect(leiturasDeStatus).toHaveLength(1);
  });

  it("leitura do status falhou: segue (mesma doutrina do modo leitura), sem derrubar o produtor", async () => {
    const { admin } = adminDoCenario({ status: "erro" });
    await expect(organizacaoPodeProduzir(admin, ORG)).resolves.toBe(true);
  });
});

describe("texto fixo do follow-up × organização suspensa com a cobrança em dia", () => {
  it("não envia, consome o job e encerra o enrollment com organizacao_inativa", async () => {
    const { admin, rpcs, enrollmentUpdates } = adminDoCenario({ status: "suspended", modo: "avisar" });

    const enviados = await enviarTextoFixoPendente(admin);

    expect(enviados).toBe(0);
    expect(mocks.send).not.toHaveBeenCalled();
    expect(rpcs).toContain("fn_followup_inline_settle");
    expect(enrollmentUpdates).toHaveLength(1);
    expect(enrollmentUpdates[0]).toMatchObject({ status: "cancelled", cancel_reason: "organizacao_inativa" });
  });
});
