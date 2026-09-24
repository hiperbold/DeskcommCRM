/**
 * Tarefa 7, fase F4: a rodada de campanha não dispara para organização em
 * modo leitura. A campanha fica exatamente como está (não chama
 * `rodarUmaCampanha`, não marca destinatário, não ocupa o número).
 *
 * Molde de `suspensao-nao-dispara-campanha.test.ts` (Supabase falso que
 * registra as chamadas), com `.rpc()` a mais para `fn_billing_modo_leitura`.
 */
import { describe, expect, it, vi } from "vitest";

import { rodarUmaRodadaDeCampanha } from "@/lib/campanhas/rodada";

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
  const builder = (tabela: string) => {
    const estado: { operacao: "select" | "update" } = { operacao: "select" };
    const b: Record<string, unknown> = {
      select: () => b,
      update: () => {
        estado.operacao = "update";
        return b;
      },
      eq: () => b,
      lte: () => b,
      or: () => b,
      order: () => b,
      limit: () => b,
      not: () => b,
      maybeSingle: async () => {
        if (tabela === "billing_settings") return { data: { modo: opts.modo }, error: null };
        return { data: null, error: null };
      },
      then: (resolve: (v: unknown) => unknown) => {
        const data =
          tabela === "organizations"
            ? []
            : tabela === "campaigns"
              ? estado.operacao === "update"
                ? []
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
  return { admin: admin as never, contarRpc: () => chamadasRpc };
}

describe("campanha × modo leitura (Tarefa 7)", () => {
  it("organização em modo leitura: a rodada não envia (0 enviadas, detalhe modo_leitura)", async () => {
    const { admin } = fakeAdmin({ modo: "bloquear", modoLeitura: true });
    const r = await rodarUmaRodadaDeCampanha(admin);
    expect(r.enviadas).toBe(0);
    expect(r.detalhe).toContain("modo_leitura");
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
