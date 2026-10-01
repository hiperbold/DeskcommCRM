/**
 * A base de conhecimento por conversas ignora contato anonimizado (D-142, item 3).
 *
 * O anonimizador de regex deixa passar o que não reconhece (nome fora da lista de
 * primeiros nomes, apelido). Conversa de quem pediu para ser esquecido não deve
 * virar trecho recuperável pelo agente para outros clientes. O gatilho do banco
 * apaga o que já estava indexado (`tests/invariants/lgpd-anonimizacao-alcanca-o-que-
 * sobrava.test.ts`); aqui se prova que o lote não indexa o que ainda não estava, e
 * que a conversa sai da fila em vez de voltar em todo lote.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { criarBancoEmMemoria, type BancoEmMemoria } from "../helpers/banco-em-memoria";

const ORG = "22222222-2222-4222-8222-222222222222";
const CONTATO_ANONIMO = "aaaaaaaa-0000-4000-8000-000000000001";
const CONTATO_NORMAL = "aaaaaaaa-0000-4000-8000-000000000002";
const CONVERSA_ANONIMA = "bbbbbbbb-0000-4000-8000-000000000001";
const CONVERSA_NORMAL = "bbbbbbbb-0000-4000-8000-000000000002";

let banco: BancoEmMemoria;

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => banco }));
vi.mock("@/lib/ai/embed", () => ({
  embedText: vi.fn(async () => ({ embedding: [0.1, 0.2] })),
}));
vi.mock("@/lib/ai/embeddings/chave", () => ({
  resolverChaveDeEmbedding: vi.fn(async () => ({ chave: "x" })),
}));
vi.mock("@/lib/legal/perfil-do-pais", () => ({
  perfilDaOrganizacao: vi.fn(async () => ({})),
}));
vi.mock("@/lib/ai/anonymize", () => ({
  padroesDePii: vi.fn(() => []),
  anonymize: vi.fn((t: string) => ({ anonymized: t, hits: ["x"] })),
  detectResidualPii: vi.fn(() => null),
}));
vi.mock("@/lib/ai/rag/version", () => ({
  createKnowledgeVersion: vi.fn(async () => ({ versionId: "v1" })),
  markVersionReady: vi.fn(async () => undefined),
  markVersionFailed: vi.fn(async () => undefined),
  activateVersion: vi.fn(async () => undefined),
}));

import { ingestConversationsBatch } from "@/lib/ai/rag/ingest/conversations";

beforeEach(() => {
  const conversa = (id: string, contato: string) => ({
    id,
    organization_id: ORG,
    contact_id: contato,
    usable_for_rag: true,
    status: "resolved",
    usable_for_rag_marked_at: "2026-09-30T12:00:00Z",
    rag_review_status: null,
  });
  banco = criarBancoEmMemoria({
    contacts: [
      { id: CONTATO_ANONIMO, organization_id: ORG, is_anonymized: true },
      { id: CONTATO_NORMAL, organization_id: ORG, is_anonymized: false },
    ],
    conversations: [
      conversa(CONVERSA_ANONIMA, CONTATO_ANONIMO),
      conversa(CONVERSA_NORMAL, CONTATO_NORMAL),
    ],
    messages: [
      { organization_id: ORG, conversation_id: CONVERSA_ANONIMA, body: "oi, sou a Zuleide", direction: "inbound", sent_at: "2026-09-30T10:00:00Z" },
      { organization_id: ORG, conversation_id: CONVERSA_NORMAL, body: "qual o horario de funcionamento", direction: "inbound", sent_at: "2026-09-30T10:00:00Z" },
    ],
    ai_knowledge_sources: [
      { id: "src-1", organization_id: ORG, source_type: "conversas", is_active: true, created_at: "2026-09-01" },
    ],
    ai_chunks: [],
  });
});

describe("D-142: lote de conversas para a base de conhecimento", () => {
  it("só a conversa de contato NÃO anonimizado vira trecho", async () => {
    const r = await ingestConversationsBatch({
      organizationId: ORG,
      agentId: "agente-1",
      sinceTs: new Date("2026-09-01T00:00:00Z"),
    });

    const chunks = banco.tabelas["ai_chunks"]!;
    expect(chunks).toHaveLength(1);
    expect((chunks[0]!["metadata"] as Record<string, unknown>)["conversation_id"]).toBe(CONVERSA_NORMAL);
    expect(chunks[0]!["content"]).not.toContain("Zuleide");
    expect(r.processed).toBe(1);
    expect(r.skipped).toBe(1);
  });

  it("a conversa do anonimizado sai da fila (skipped), a outra fica ingested", async () => {
    await ingestConversationsBatch({
      organizationId: ORG,
      agentId: "agente-1",
      sinceTs: new Date("2026-09-01T00:00:00Z"),
    });

    const status = Object.fromEntries(
      banco.tabelas["conversations"]!.map((c) => [c["id"], c["rag_review_status"]]),
    );
    expect(status[CONVERSA_ANONIMA]).toBe("skipped");
    expect(status[CONVERSA_NORMAL]).toBe("ingested");
  });

  it("lote só com conversa de anonimizado não cria versão nem chunk", async () => {
    banco.tabelas["conversations"] = banco.tabelas["conversations"]!.filter((c) => c["id"] === CONVERSA_ANONIMA);

    const r = await ingestConversationsBatch({
      organizationId: ORG,
      agentId: "agente-1",
      sinceTs: new Date("2026-09-01T00:00:00Z"),
    });

    expect(r).toMatchObject({ processed: 0, skipped: 1 });
    expect(banco.tabelas["ai_chunks"]).toHaveLength(0);
  });
});
