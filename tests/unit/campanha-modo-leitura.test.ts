/**
 * Tarefa 7, fase F4: a rodada de campanha não dispara para organização em
 * modo leitura. A campanha fica exatamente como está (não chama
 * `rodarUmaCampanha`, não marca destinatário, não ocupa o número).
 *
 * Achado 4 da revisão (F4): a campanha é PAUSADA (status='paused',
 * failure_code='assinatura_suspensa'), não só represada, para não voltar a
 * enviar sozinha com mensagem atrasada quando a conta reativar.
 *
 * Molde de `suspensao-nao-dispara-campanha.test.ts` (Supabase falso que
 * registra as chamadas), com `.rpc()` a mais para `fn_billing_modo_leitura`.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

import { rodarUmaRodadaDeCampanha } from "@/lib/campanhas/rodada";
import { audit } from "@/lib/audit";

const ORG = "22222222-2222-4222-8222-222222222222";
const CAMPANHA = {
  id: "33333333-3333-4333-8333-333333333333",
  organization_id: ORG,
  channel_session_id: "44444444-4444-4444-8444-444444444444",
  name: "Campanha de teste",
  message_body: "Olá",
  content_version: 1,
  intervalo_segundos: null,
  janela_inicio_hora: null,
  janela_fim_hora: null,
  teto_diario: null,
  teto_horario: null,
};

/** Supabase falso: `organizations`/`campaigns` no molde do irmão de suspensão,
 *  mais `billing_settings` (modo) e `.rpc` (fn_billing_modo_leitura). */
function fakeAdmin(opts: { modo: string | null; modoLeitura: boolean }) {
  let chamadasRpc = 0;
  const updatesDeCampanha: Array<Record<string, unknown>> = [];
  const builder = (tabela: string) => {
    const estado: { operacao: "select" | "update"; payload?: Record<string, unknown> } = {
      operacao: "select",
    };
    const b: Record<string, unknown> = {
      select: () => b,
      update: (payload: Record<string, unknown>) => {
        estado.operacao = "update";
        estado.payload = payload;
        return b;
      },
      eq: () => b,
      lte: () => b,
      or: () => b,
      order: () => b,
      limit: () => b,
      in: () => b,
      not: () => b,
      maybeSingle: async () => {
        if (tabela === "billing_settings") return { data: { modo: opts.modo }, error: null };
        return { data: null, error: null };
      },
      then: (resolve: (v: unknown) => unknown) => {
        if (tabela === "campaigns" && estado.operacao === "update" && estado.payload) {
          updatesDeCampanha.push(estado.payload);
        }
        const data =
          tabela === "organizations"
            ? []
            : tabela === "campaigns"
              ? estado.operacao === "update"
                ? [{ id: CAMPANHA.id }]
                : [CAMPANHA]
              : [];
        return Promise.resolve({ data, error: null }).then(resolve);
      },
    };
    return b;
  };
  const admin = {
    from: (t: string) => builder(t),
    rpc: async (nome: string) => {
      if (nome === "fn_billing_modo_leitura") {
        chamadasRpc += 1;
        return { data: opts.modoLeitura, error: null };
      }
      throw new Error(`rpc não esperada: ${nome}`);
    },
  };
  return { admin: admin as never, contarRpc: () => chamadasRpc, updatesDeCampanha };
}

describe("campanha × modo leitura (Tarefa 7)", () => {
  it("organização em modo leitura: a rodada não envia (0 enviadas, detalhe modo_leitura)", async () => {
    const { admin } = fakeAdmin({ modo: "bloquear", modoLeitura: true });
    const r = await rodarUmaRodadaDeCampanha(admin);
    expect(r.enviadas).toBe(0);
    expect(r.detalhe).toContain("modo_leitura");
  });

  it("organização em modo leitura: a campanha é PAUSADA (achado 4), com o motivo registrado e auditada", async () => {
    vi.mocked(audit).mockClear();
    const { admin, updatesDeCampanha } = fakeAdmin({ modo: "bloquear", modoLeitura: true });

    await rodarUmaRodadaDeCampanha(admin);

    // Filtra pela atualização de PAUSA: a rodada também roda
    // `promoverAgendadas` (scheduled -> running) todo tique, que é outro
    // update na mesma tabela e não tem relação com o modo leitura.
    const pausas = updatesDeCampanha.filter((u) => u.status === "paused");
    expect(pausas).toHaveLength(1);
    expect(pausas[0]).toMatchObject({ status: "paused", failure_code: "assinatura_suspensa" });
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "campaign.paused",
        resourceId: CAMPANHA.id,
        metadata: expect.objectContaining({ reason: "assinatura_suspensa" }),
      }),
    );
  });

  it("modo avisar: nenhuma consulta a mais, a RPC de modo leitura nunca é chamada", async () => {
    const { admin, contarRpc } = fakeAdmin({ modo: "avisar", modoLeitura: true });
    await rodarUmaRodadaDeCampanha(admin);
    expect(contarRpc()).toBe(0);
  });
});

vi.mock("@/lib/agent-engine/db/request-pool", () => ({
  getRequestPool: () => ({ query: async () => ({ rows: [] }) }),
}));
