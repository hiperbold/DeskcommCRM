/**
 * D-174, achado 3: `POST /api/v1/channels/official` aceitava QUALQUER texto de cinco caracteres ou mais como
 * `phone_number_id` e `waba_id`, e esses valores viram caminho da Graph API. Os ids da Meta são numéricos:
 * o cadastro só aceita dígitos, e a recusa vem ANTES de falar com a Meta ou com o banco.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const validar = vi.fn();

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async () => ({
    ok: true,
    user: { id: "u1", idioma: "pt-BR", support: null, is_platform_admin: false },
    org: { orgId: "o1", role: "admin" },
  }),
}));
vi.mock("@/lib/channels/meta/validate-credentials", () => ({
  validateMetaCredentials: (...a: unknown[]) => validar(...a),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

import { POST } from "@/app/api/v1/channels/official/route";

const TOKEN = "EAAG".padEnd(40, "x");

const post = (corpo: Record<string, unknown>) =>
  POST(
    new NextRequest("http://localhost/api/v1/channels/official", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(corpo),
    }),
  );

beforeEach(() => {
  validar.mockReset();
  // Recusa a credencial: o que interessa aqui é só se o cadastro CHEGOU até a validação na Meta.
  validar.mockResolvedValue({ ok: false, motivo: "credencial recusada no teste" });
});

describe("POST /api/v1/channels/official: ids só com dígitos", () => {
  it.each([
    ["phone_number_id com barra e ..", { phone_number_id: "12345/../me", waba_id: "987654321" }],
    ["phone_number_id com interrogação", { phone_number_id: "12345?fields=x", waba_id: "987654321" }],
    ["phone_number_id com letras", { phone_number_id: "abcdefgh", waba_id: "987654321" }],
    ["phone_number_id com espaço", { phone_number_id: "12345 67", waba_id: "987654321" }],
    ["waba_id com barra", { phone_number_id: "123456789", waba_id: "98765/4321" }],
    ["waba_id com letras", { phone_number_id: "123456789", waba_id: "waba-9876" }],
  ])("⭐ %s: 422 e a Meta nem é consultada", async (_nome, ids) => {
    const res = await post({ ...ids, token: TOKEN });
    expect(res.status).toBe(422);
    expect(validar).not.toHaveBeenCalled();
  });

  it("ids numéricos passam do schema e chegam à validação na Meta", async () => {
    const res = await post({ phone_number_id: "111222333444555", waba_id: "999888777666555", token: TOKEN });
    expect(validar).toHaveBeenCalledTimes(1);
    expect(validar).toHaveBeenCalledWith(
      expect.objectContaining({ phoneNumberId: "111222333444555", wabaId: "999888777666555" }),
    );
    // A validação fake recusou: a rota responde 422 por OUTRO motivo, depois de passar pelo schema.
    expect(res.status).toBe(422);
  });
});
