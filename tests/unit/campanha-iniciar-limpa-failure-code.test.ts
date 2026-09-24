/**
 * `iniciarAcao` (lib/campanhas/acoes.ts) × retomar uma campanha PAUSADA por
 * assinatura suspensa (lib/campanhas/rodada.ts grava failure_code=
 * 'assinatura_suspensa'). Sem limpar `failure_code` ao retomar, a tela
 * (app/app/campaigns/[id]/_client.tsx) continuava mostrando "a conta está
 * suspensa" mesmo depois de a assinatura ter sido regularizada e a campanha
 * voltar a rodar. Correção segunda rodada F4, item 5.
 */
import { describe, expect, it } from "vitest";

import { iniciarAcao, type CampanhaCarregada } from "@/lib/campanhas/acoes";

function campanhaPausada(): CampanhaCarregada {
  return {
    id: "campanha-1",
    organization_id: "org-1",
    name: "Campanha de teste",
    status: "paused",
    channel_session_id: "canal-1",
    message_body: "Olá {{nome}}",
    base_legal: "consent",
    lia_ref: null,
    audience_filter: null,
    audience_version: 1,
    content_version: 1,
    scheduled_at: null,
    intervalo_segundos: null,
    janela_inicio_hora: null,
    janela_fim_hora: null,
    teto_diario: null,
    teto_horario: null,
    description: null,
  };
}

function fakeAdmin(updatePayloads: Record<string, unknown>[]) {
  return {
    from: (tabela: string) => {
      if (tabela === "campaign_recipients") {
        return {
          select: () => ({
            eq: () => ({
              eq: async () => ({ count: 3, data: null, error: null }),
            }),
          }),
        };
      }
      if (tabela === "campaigns") {
        return {
          update: (payload: Record<string, unknown>) => {
            updatePayloads.push(payload);
            return {
              eq: () => ({
                eq: () => ({
                  select: async () => ({ data: [{ id: "campanha-1" }], error: null }),
                }),
              }),
            };
          },
        };
      }
      throw new Error(`tabela não esperada no teste: ${tabela}`);
    },
  };
}

describe("iniciarAcao × failure_code (correção segunda rodada F4, item 5)", () => {
  it("retomar de 'paused' limpa failure_code (null) no mesmo UPDATE que volta para 'running'", async () => {
    const updatePayloads: Record<string, unknown>[] = [];
    const admin = fakeAdmin(updatePayloads);

    const resultado = await iniciarAcao(admin as never, campanhaPausada(), new Date());

    expect(resultado).toMatchObject({ ok: true, retomada: true });
    expect(updatePayloads).toHaveLength(1);
    expect(updatePayloads[0]).toMatchObject({ status: "running", failure_code: null });
  });
});
