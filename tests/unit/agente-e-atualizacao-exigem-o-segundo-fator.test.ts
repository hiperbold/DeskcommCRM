/**
 * D-092: as server actions do agente de IA e a rota de atualização do sistema escreviam com a sessão
 * aal1 (só senha) de quem tem fator cadastrado. Elas usam o cliente de servidor (service role), então a
 * RLS não as alcança: a única barreira é o portão da própria action/rota. Aqui se prova que, com a
 * MFA em dívida, nada chega ao banco, e que com a MFA em dia o portão passa.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const estado = { emDivida: true, tocouNoBanco: 0 };
const UUID = "11111111-1111-4111-8111-111111111111";

vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: async () => ({ id: "u1", is_platform_admin: true, idioma: "pt-BR", organizations: [] }),
  resolveActiveOrg: async () => ({ orgId: "o1", role: "admin" }),
  mfaEmDivida: async () => estado.emDivida,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    estado.tocouNoBanco++;
    throw new Error("BANCO_TOCADO");
  },
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/audit", () => ({ audit: async () => undefined }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

beforeEach(() => {
  estado.emDivida = true;
  estado.tocouNoBanco = 0;
});

describe("actions do agente de IA", () => {
  it("⭐ com a MFA em dívida, nenhuma action chega ao banco", async () => {
    const lista = await import("@/app/app/ai/agents/_actions");
    const detalhe = await import("@/app/app/ai/agents/[id]/_actions");
    const resultados = [
      await lista.pauseAgentAction(UUID),
      await lista.unpauseAgentAction(UUID),
      await lista.archiveAgentAction(UUID),
      await lista.renameAgentAction(UUID, "Novo nome"),
      await lista.duplicateAgentAction(UUID),
      await detalhe.createMcpAgentAction({}),
    ];
    for (const r of resultados) expect(r).toMatchObject({ ok: false, error: "mfa_required" });
    expect(estado.tocouNoBanco).toBe(0);
  });

  it("CONTROLE: com a MFA em dia o portão passa e a action segue até o banco", async () => {
    estado.emDivida = false;
    const lista = await import("@/app/app/ai/agents/_actions");
    await expect(lista.pauseAgentAction(UUID)).rejects.toThrow("BANCO_TOCADO");
    expect(estado.tocouNoBanco).toBe(1);
  });
});

describe("POST /api/v1/system/update", () => {
  it("⭐ com a MFA em dívida responde 403 mfa_required e não lê nem grava a atualização", async () => {
    const { POST } = await import("@/app/api/v1/system/update/route");
    const res = await POST(new NextRequest("http://localhost/api/v1/system/update", { method: "POST" }));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("mfa_required");
    expect(estado.tocouNoBanco).toBe(0);
  });

  it("CONTROLE: com a MFA em dia o portão passa e a rota segue até o banco", async () => {
    estado.emDivida = false;
    const { POST } = await import("@/app/api/v1/system/update/route");
    await expect(
      POST(new NextRequest("http://localhost/api/v1/system/update", { method: "POST" })),
    ).rejects.toThrow("BANCO_TOCADO");
  });
});
