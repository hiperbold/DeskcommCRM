// @vitest-environment node
/**
 * D-178: com o módulo `marca_por_organizacao` DESLIGADO, a tela de Marca da
 * empresa devolve 404 e a action de gravar recusa (esconder a tela não basta:
 * a action é invocável por POST direto). Ligado, as duas voltam a funcionar, o
 * que prova que é a flag, e não um defeito, quem decide.
 *
 * O banco é um dado (`platform_config`) lido pelo código real de
 * `lib/instalacao/modulos.ts`; só a borda do Next e da autenticação é simulada.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "22222222-2222-4222-8222-222222222222";
const USUARIO = "11111111-1111-4111-8111-111111111111";

const deps = vi.hoisted(() => ({
  ligado: false,
  rpc: vi.fn(),
  audit: vi.fn(),
}));

class NaoEncontrado extends Error {}

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new NaoEncontrado("NEXT_NOT_FOUND");
  },
  redirect: (destino: string) => {
    throw new Error(`REDIRECT ${destino}`);
  },
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/audit", () => ({ audit: deps.audit }));
vi.mock("@/lib/impersonate/support", () => ({ supportWriteError: () => null }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: async () => ({ id: USUARIO, is_platform_admin: false, support: null, idioma: "pt-BR" }),
  requireAuth: async () => ({ id: USUARIO, is_platform_admin: false, support: null, idioma: "pt-BR" }),
  resolveActiveOrg: async () => ({ orgId: ORG, role: "admin" }),
}));
vi.mock("@/lib/auth/portao-de-escrita", () => ({
  portaoDeAdminDaOrganizacao: async () => ({ ok: true }),
}));
vi.mock("@/lib/branding/instalacao", () => ({ marcaDaInstalacao: async () => null }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: { settings: {} }, error: null }) }),
      }),
    }),
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: deps.rpc,
    from: () => ({
      select: () => ({
        in: async () => ({
          data: deps.ligado ? [{ chave: "MODULO_MARCA_POR_ORGANIZACAO", valor: "ligado" }] : [],
          error: null,
        }),
      }),
    }),
  }),
}));
// O formulário é cliente e não interessa aqui: a página só precisa devolvê-lo.
vi.mock("@/app/app/settings/marca/_form", () => ({
  FormularioDaMarcaDaOrganizacao: () => null,
}));

import { updateMarcaDaOrganizacao } from "@/app/actions/settings/updateMarcaDaOrganizacao";
import MarcaDaOrganizacaoPage from "@/app/app/settings/marca/page";

beforeEach(() => {
  vi.clearAllMocks();
  deps.ligado = false;
  deps.rpc.mockResolvedValue({ data: 1, error: null });
  deps.audit.mockResolvedValue(undefined);
});

describe("/app/settings/marca", () => {
  it("DESLIGADO: responde 404 (notFound), antes de qualquer outra coisa", async () => {
    await expect(MarcaDaOrganizacaoPage()).rejects.toBeInstanceOf(NaoEncontrado);
  });

  it("LIGADO: a tela abre para o admin da empresa", async () => {
    deps.ligado = true;
    await expect(MarcaDaOrganizacaoPage()).resolves.toBeTruthy();
  });
});

describe("updateMarcaDaOrganizacao", () => {
  const entrada = { app_name: "Clínica da Ana", accent_hex: "#b3261e" };

  it("DESLIGADO: recusa, não chama o banco de marca e não audita", async () => {
    const r = await updateMarcaDaOrganizacao(entrada);
    expect(r).toEqual({ ok: false, error: "modulo_desligado" });
    expect(deps.rpc).not.toHaveBeenCalled();
    expect(deps.audit).not.toHaveBeenCalled();
  });

  it("DESLIGADO: limpar a marca também é recusado", async () => {
    const r = await updateMarcaDaOrganizacao({ app_name: null, accent_hex: null });
    expect(r).toEqual({ ok: false, error: "modulo_desligado" });
    expect(deps.rpc).not.toHaveBeenCalled();
  });

  it("LIGADO: grava pela função do banco e audita", async () => {
    deps.ligado = true;
    const r = await updateMarcaDaOrganizacao(entrada);
    expect(r).toEqual({ ok: true });
    expect(deps.rpc).toHaveBeenCalledWith(
      "fn_definir_marca_da_organizacao",
      expect.objectContaining({ p_org: ORG, p_actor: USUARIO }),
    );
    expect(deps.audit).toHaveBeenCalledTimes(1);
  });
});
