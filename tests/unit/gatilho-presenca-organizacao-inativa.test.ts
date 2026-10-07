/**
 * D-091 (sobra do lote 16b): `gatilho-presenca.handler` chamava `fn_appointment_recover` direto,
 * sem o portão dos outros gatilhos de follow-up. Organização suspensa pelo admin da plataforma (ou
 * com a cobrança em modo leitura) não pode ganhar recuperação de presença.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  admin: { current: null as unknown },
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mocks.admin.current }));

import { limparCacheDoStatusDaOrganizacao } from "@/lib/billing/assinatura/status-da-organizacao";
import { followupGatilhoPresencaHandler } from "@/lib/followup/gatilho-presenca.handler";

const ORG = "33333333-3333-4333-8333-333333333333";
const ROW = { id: "ev-1", organization_id: ORG } as never;

function adminCom(statusDaOrg: string, modo = "avisar") {
  const rpc = vi.fn(async () => ({ data: { result: "recovered" }, error: null }));
  const admin = {
    from: (tabela: string) => {
      if (tabela === "organizations") {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { status: statusDaOrg }, error: null }) }) }) };
      }
      if (tabela === "billing_settings") {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { modo }, error: null }) }) }) };
      }
      throw new Error(`tabela não esperada no teste: ${tabela}`);
    },
    rpc,
  };
  return { admin, rpc };
}

beforeEach(() => {
  limparCacheDoStatusDaOrganizacao();
});

describe("gatilho de presença × portão de produção", () => {
  it("organização suspensa: não chama fn_appointment_recover e devolve skipped", async () => {
    const { admin, rpc } = adminCom("suspended");
    mocks.admin.current = admin;
    const r = await followupGatilhoPresencaHandler.handle(ROW);
    expect(rpc).not.toHaveBeenCalled();
    expect(r.status).toBe("skipped");
    expect(r.detail).toBe("organizacao_inativa");
  });

  it("organização ativa: chama fn_appointment_recover como antes", async () => {
    const { admin, rpc } = adminCom("active");
    mocks.admin.current = admin;
    const r = await followupGatilhoPresencaHandler.handle(ROW);
    expect(rpc).toHaveBeenCalledWith("fn_appointment_recover", { p_org: ORG, p_event: "ev-1" });
    expect(r.status).toBe("ok");
    expect(r.detail).toBe("recovered");
  });
});
