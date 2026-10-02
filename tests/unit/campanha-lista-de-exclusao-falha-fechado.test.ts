/**
 * D-131: erro na consulta da lista de exclusão (`campaign_suppressions`) NÃO
 * libera o envio. O destinatário é adiado (`next_attempt_at`) e nada é enviado.
 * Controle positivo: o endereço que está na lista continua sendo pulado.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({
  getRequestPool: () => ({ query: async () => ({ rows: [] }) }),
}));

import { rodarUmaRodadaDeCampanha } from "@/lib/campanhas/rodada";

const CAMPANHA = {
  id: "c1",
  organization_id: "org-a",
  channel_session_id: "num-1",
  name: "c1",
  message_body: "oi",
  content_version: 1,
  intervalo_segundos: null,
  janela_inicio_hora: null,
  janela_fim_hora: null,
  teto_diario: null,
  teto_horario: null,
  started_at: "2026-09-01T00:00:00Z",
  last_tick_at: null,
};
const ALVO = {
  id: "r1",
  contact_id: "ct1",
  recipient_address: "+5511999990000",
  rendered_body: "oi",
  contacts: {
    id: "ct1",
    name: "Ana",
    display_name: "Ana",
    phone_number: "+5511999990000",
    is_blocked: false,
    is_anonymized: false,
    consent: {},
  },
};

function banco(lista: { data: unknown[] | null; error: { message: string } | null }) {
  const atualizacoes: Array<{ tabela: string; payload: Record<string, unknown> }> = [];
  const rpcs: string[] = [];
  const from = (tabela: string) => {
    let op: "select" | "update" = "select";
    let payload: Record<string, unknown> = {};
    const b: Record<string, unknown> = {
      select: () => b,
      update: (p: Record<string, unknown>) => {
        op = "update";
        payload = p;
        atualizacoes.push({ tabela, payload: p });
        return b;
      },
      eq: () => b,
      in: () => b,
      is: () => b,
      lt: () => b,
      lte: () => b,
      or: () => b,
      not: () => b,
      order: () => b,
      limit: () => b,
      maybeSingle: async () => ({ data: tabela === "billing_settings" ? { modo: "avisar" } : null, error: null }),
      then: (resolve: (v: unknown) => unknown) => {
        void op;
        void payload;
        let r: { data: unknown; error: unknown };
        if (tabela === "campaigns" && op === "select") r = { data: [CAMPANHA], error: null };
        else if (tabela === "campaign_recipients" && op === "select") r = { data: [ALVO], error: null };
        else if (tabela === "campaign_suppressions") r = lista;
        else r = { data: [], error: null };
        return Promise.resolve(r).then(resolve);
      },
    };
    return b;
  };
  return { admin: { from, rpc: async (n: string) => (rpcs.push(n), { data: null, error: null }) } as never, atualizacoes, rpcs };
}

describe("lista de exclusão da campanha na hora de enviar", () => {
  it("erro na consulta: adia o destinatário, não marca nada como enviado nem pulado", async () => {
    const { admin, atualizacoes, rpcs } = banco({ data: null, error: { message: "connection reset" } });
    const r = await rodarUmaRodadaDeCampanha(admin, new Date("2026-10-01T12:00:00Z"));

    const adiado = atualizacoes.find((a) => a.tabela === "campaign_recipients" && "next_attempt_at" in a.payload);
    expect(adiado, "o destinatário tinha de ser adiado").toBeDefined();
    expect(Date.parse(adiado!.payload.next_attempt_at as string)).toBeGreaterThan(Date.parse("2026-10-01T12:00:00Z"));
    // Nada de "skipped"/"sending": quem decide é a próxima rodada, com a lista lida.
    expect(atualizacoes.some((a) => a.payload.status === "skipped" || a.payload.status === "sending")).toBe(false);
    expect(rpcs).not.toContain("fn_reservar_destinatario");
    expect(JSON.stringify(r)).toContain("adiado");
  });

  it("endereço na lista: segue sendo pulado como suprimido", async () => {
    const { admin, atualizacoes } = banco({ data: [{ id: "s1" }], error: null });
    await rodarUmaRodadaDeCampanha(admin, new Date("2026-10-01T12:00:00Z"));
    expect(
      atualizacoes.some((a) => a.payload.exclusion_reason === "suprimido" && a.payload.status === "skipped"),
    ).toBe(true);
  });
});
