/**
 * D-164 — tags e objetos livres de lead e contato têm teto.
 *
 * Sem teto, um agente ou token gravava milhares de tags longas ou um jsonb de
 * vários MB em 50 leads por chamada (a linha incha, o quadro do funil seleciona
 * tudo, `emit_event` leva as tags inteiras para a timeline e os webhooks).
 */
import { describe, expect, it } from "vitest";

import {
  bulkLeadActionSchema,
  contactCreateSchema,
  createLeadSchema,
  moveLeadSchema,
  updateLeadSchema,
} from "@/lib/schemas";
import { TETO_DE_BYTES_DO_OBJETO, TETO_DE_TAGS } from "@/lib/schemas/tetos";

const UUID = "11111111-1111-4111-8111-111111111111";
const tags = (n: number, tamanho = 5) => Array.from({ length: n }, (_, i) => `${i}`.padEnd(tamanho, "x"));
const objetoGrande = () => ({ lixo: "x".repeat(TETO_DE_BYTES_DO_OBJETO + 1) });

describe("lead: tags", () => {
  const base = { pipeline_id: UUID, stage_id: UUID, title: "Negócio" };

  it("criação recusa mais tags que o teto e aceita o teto exato", () => {
    expect(createLeadSchema.safeParse({ ...base, tags: tags(TETO_DE_TAGS + 1) }).success).toBe(false);
    expect(createLeadSchema.safeParse({ ...base, tags: tags(TETO_DE_TAGS) }).success).toBe(true);
  });

  it("criação recusa marcador gigante", () => {
    expect(createLeadSchema.safeParse({ ...base, tags: ["x".repeat(61)] }).success).toBe(false);
  });

  it("PATCH recusa tags demais", () => {
    expect(updateLeadSchema.safeParse({ tags: tags(TETO_DE_TAGS + 1) }).success).toBe(false);
    expect(updateLeadSchema.safeParse({ tags: ["vip"] }).success).toBe(true);
  });

  it("lote de etiquetas recusa add e remove acima do teto", () => {
    const corpo = (params: unknown) => ({ action: "tag", lead_ids: [UUID], params });
    expect(bulkLeadActionSchema.safeParse(corpo({ add: tags(TETO_DE_TAGS + 1) })).success).toBe(false);
    expect(bulkLeadActionSchema.safeParse(corpo({ remove: tags(TETO_DE_TAGS + 1) })).success).toBe(false);
    expect(bulkLeadActionSchema.safeParse(corpo({ add: ["quente"], remove: ["frio"] })).success).toBe(true);
  });
});

describe("lead: custom_fields", () => {
  it("PATCH recusa o objeto acima de 32 KB e aceita o normal", () => {
    expect(updateLeadSchema.safeParse({ custom_fields: objetoGrande() }).success).toBe(false);
    expect(updateLeadSchema.safeParse({ custom_fields: { segmento: "varejo" } }).success).toBe(true);
  });

  it("o mover (que também grava campos) recusa o mesmo excesso", () => {
    const base = {
      stage_id: UUID,
      position_in_stage: 1,
      expected_updated_at: "2026-09-30T10:00:00.000Z",
    };
    expect(moveLeadSchema.safeParse({ ...base, custom_fields: objetoGrande() }).success).toBe(false);
    expect(moveLeadSchema.safeParse({ ...base, custom_fields: { a: 1 } }).success).toBe(true);
  });

  it("chave gigante é recusada", () => {
    expect(updateLeadSchema.safeParse({ custom_fields: { ["k".repeat(81)]: 1 } }).success).toBe(false);
  });
});

describe("contato: tags, origem e consentimento", () => {
  it("tags acima do teto são recusadas antes de normalizar", () => {
    expect(contactCreateSchema.safeParse({ tags: tags(TETO_DE_TAGS + 1) }).success).toBe(false);
    expect(contactCreateSchema.safeParse({ tags: ["VIP", "vip"] }).data?.tags).toEqual(["vip"]);
  });

  it("source_metadata e consent acima de 32 KB são recusados na criação", () => {
    expect(contactCreateSchema.safeParse({ source_metadata: objetoGrande() }).success).toBe(false);
    expect(contactCreateSchema.safeParse({ consent: objetoGrande() }).success).toBe(false);
    expect(
      contactCreateSchema.safeParse({ source_metadata: { ad_id: "1" }, consent: { marketing: {} } }).success,
    ).toBe(true);
  });
});
