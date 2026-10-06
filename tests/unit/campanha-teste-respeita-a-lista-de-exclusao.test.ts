/**
 * D-131: o envio de TESTE da campanha respeita a lista de exclusão da operação,
 * como a rodada oficial. Antes só os vetos por pessoa (opt-out, anonimizado,
 * recusa de marketing) valiam no teste; quem a operação pôs na lista recebia.
 *
 * Os módulos de envio são os dublês: o que se prova aqui é se o envio é CHAMADO.
 */
import { describe, expect, it, vi } from "vitest";

const envio = vi.hoisted(() => ({
  enviar: vi.fn(async () => ({ status: "sent" })),
  origem: vi.fn(async () => ({ conversation_id: "conv-1" })),
}));
vi.mock("@/app/api/v1/messages/_handler", () => ({ sendMessageHandler: envio.enviar }));
vi.mock("@/lib/atendimento/origem", () => ({ beginServiceAtOrigin: envio.origem }));

import { testarAcao, type CampanhaCarregada } from "@/lib/campanhas/acoes";
import { hashDoEndereco } from "@/lib/campanhas/exclusoes";

const CAMPANHA = {
  id: "c1",
  organization_id: "org-a",
  name: "Black Friday",
  status: "draft",
  channel_session_id: "num-1",
  message_body: "Oi {{nome}}, tudo bem?",
  base_legal: "consent",
  lia_ref: null,
} as unknown as CampanhaCarregada;

const CONTATO = {
  id: "ct1",
  name: "Ana",
  display_name: "Ana",
  phone_number: "+5511999990000",
  is_blocked: false,
  is_anonymized: false,
  consent: {},
};

/** Dublê do supabase-js: contato + a lista de exclusão. */
function banco(lista: { data: unknown[] | null; error: { message: string } | null }) {
  const hashesConsultados: unknown[] = [];
  const from = (tabela: string) => {
    const b: Record<string, unknown> = {
      select: () => b,
      eq: (coluna: string, valor: unknown) => {
        if (coluna === "recipient_address_hash") hashesConsultados.push(valor);
        return b;
      },
      limit: () => b,
      maybeSingle: async () => ({ data: tabela === "contacts" ? CONTATO : null, error: null }),
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve(tabela === "campaign_suppressions" ? lista : { data: [], error: null }).then(resolve),
    };
    return b;
  };
  return { admin: { from } as never, hashesConsultados };
}

const AGORA = new Date("2026-10-06T15:00:00Z");

describe("envio de teste da campanha x lista de exclusão", () => {
  it("contato na lista: recusa com 422 e NADA é enviado", async () => {
    envio.enviar.mockClear();
    const { admin, hashesConsultados } = banco({ data: [{ id: "s1" }], error: null });
    const r = await testarAcao(admin, CAMPANHA, "ct1", AGORA, "America/Sao_Paulo");
    expect(r).toMatchObject({ ok: false, status: 422, codigo: "campanha_conteudo_invalido" });
    expect((r as { mensagem: string }).mensagem).toMatch(/lista de exclusão/);
    expect(envio.enviar).not.toHaveBeenCalled();
    // A consulta é pelo hash do endereço do contato, o mesmo da rodada oficial.
    expect(hashesConsultados).toEqual([hashDoEndereco("+5511999990000")]);
  });

  it("erro na consulta da lista: recusa com 503 e NADA é enviado (não saber não libera)", async () => {
    envio.enviar.mockClear();
    const { admin } = banco({ data: null, error: { message: "connection reset" } });
    const r = await testarAcao(admin, CAMPANHA, "ct1", AGORA, "America/Sao_Paulo");
    expect(r).toMatchObject({ ok: false, status: 503, codigo: "unavailable" });
    expect(envio.enviar).not.toHaveBeenCalled();
  });

  it("controle positivo: contato fora da lista recebe o teste", async () => {
    envio.enviar.mockClear();
    const { admin } = banco({ data: [], error: null });
    const r = await testarAcao(admin, CAMPANHA, "ct1", AGORA, "America/Sao_Paulo");
    expect(r).toEqual({ ok: true, status: "sent" });
    expect(envio.enviar).toHaveBeenCalledTimes(1);
  });
});
