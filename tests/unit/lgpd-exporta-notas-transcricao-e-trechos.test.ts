/**
 * A exportação (Art. 18 II) entrega o que a anonimização passou a apagar (D-142, item 5):
 * a transcrição de mídia das mensagens, as notas do agente e da equipe, e os trechos da
 * base de conhecimento nascidos das conversas do titular. Nada de outro contato nem de
 * outra organização.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { criarBancoEmMemoria, type BancoEmMemoria } from "../helpers/banco-em-memoria";

let banco: BancoEmMemoria;
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => banco }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import { collectExportData } from "@/lib/lgpd/export-collector";

const ORG = "org-a";
const OUTRA = "org-b";
const CONTATO = "contato-a";
const OUTRO = "contato-b";

beforeEach(() => {
  banco = criarBancoEmMemoria({
    organizations: [{ id: ORG, legal_name: "Empresa", display_name: "Empresa", dpo_email: null }],
    contacts: [
      { id: CONTATO, organization_id: ORG, name: "Titular", created_at: "2026-09-01T00:00:00Z" },
      { id: OUTRO, organization_id: ORG, name: "Outro", created_at: "2026-09-01T00:00:00Z" },
    ],
    conversations: [
      { id: "conv-a", organization_id: ORG, contact_id: CONTATO },
      { id: "conv-b", organization_id: ORG, contact_id: OUTRO },
    ],
    messages: [
      { id: "m1", organization_id: ORG, contact_id: CONTATO, conversation_id: "conv-a", direction: "inbound", type: "audio", status: "received", body: "audio", media_url: "x", media_derived_text: "moro na Rua das Flores", sent_at: null, created_at: "2026-09-02T00:00:00Z" },
      { id: "m2", organization_id: ORG, contact_id: OUTRO, conversation_id: "conv-b", direction: "inbound", type: "audio", status: "received", body: "audio", media_url: "x", media_derived_text: "segredo do outro", sent_at: null, created_at: "2026-09-02T00:00:00Z" },
    ],
    lead_notes: [
      { id: "n1", organization_id: ORG, contact_id: CONTATO, headline: "CPF final 123", body: "mora na Rua X", created_at: "2026-09-03T00:00:00Z" },
      { id: "n2", organization_id: ORG, contact_id: OUTRO, headline: "nota do outro", body: "x", created_at: "2026-09-03T00:00:00Z" },
      { id: "n3", organization_id: OUTRA, contact_id: CONTATO, headline: "outra org", body: "x", created_at: "2026-09-03T00:00:00Z" },
    ],
    conversation_notes: [
      { id: "cn1", organization_id: ORG, conversation_id: "conv-a", body: "pediu desconto", created_by_name: "Ana", created_at: "2026-09-03T00:00:00Z" },
      { id: "cn2", organization_id: ORG, conversation_id: "conv-b", body: "nota do outro", created_by_name: "Ana", created_at: "2026-09-03T00:00:00Z" },
    ],
    ai_chunks: [
      { id: "k1", organization_id: ORG, content: "trecho da conversa do titular", metadata: { conversation_id: "conv-a" }, created_at: "2026-09-04T00:00:00Z" },
      { id: "k2", organization_id: ORG, content: "trecho do outro", metadata: { conversation_id: "conv-b" }, created_at: "2026-09-04T00:00:00Z" },
    ],
  });
});

describe("D-142: export completo", () => {
  it("entrega transcrição, notas e trechos do titular, e só dele", async () => {
    const payload = await collectExportData({
      organizationId: ORG,
      requestId: "r1",
      contactId: CONTATO,
      externalCustomerId: null,
    });

    expect(payload.messages_recent.map((m) => [m.id, m.media_derived_text])).toEqual([
      ["m1", "moro na Rua das Flores"],
    ]);
    expect(payload.lead_notes?.map((n) => n.id)).toEqual(["n1"]);
    expect(payload.conversation_notes?.map((n) => n.id)).toEqual(["cn1"]);
    expect(payload.knowledge_chunks).toEqual([
      expect.objectContaining({ id: "k1", conversation_id: "conv-a", content: "trecho da conversa do titular" }),
    ]);
    expect(JSON.stringify(payload)).not.toMatch(/segredo do outro|nota do outro|trecho do outro|outra org/);
  });
});
