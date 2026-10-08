// @vitest-environment node
/**
 * D-178: o CRM mostra SEMPRE a marca da instalação (HiperCRM, na Hiperbold). A
 * personalização de nome, cor e logo por organização virou um módulo opcional da
 * instalação, `marca_por_organizacao`, DESLIGADO por padrão.
 *
 * Esta suíte prova os dois lados do interruptor, para a flag não ser decorativa:
 *   - desligado: a organização não entra na pilha de marca (interface e saídas
 *     sem DOM), e a porta "Marca" some do menu/hub/⌘K;
 *   - ligado: o comportamento de antes volta intacto, com o dado que ficou guardado.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({
  modulosGravados: [] as Array<{ chave: string; valor: string }>,
  tabelasLidas: [] as string[],
  settings: null as unknown,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      deps.tabelasLidas.push(tabela);
      const builder = {
        select: () => builder,
        eq: () => builder,
        in: async () => ({ data: deps.modulosGravados, error: null }),
        maybeSingle: async () => ({ data: { settings: deps.settings }, error: null }),
      };
      return builder;
    },
  }),
}));
vi.mock("@/lib/branding/instalacao", () => ({
  marcaDaInstalacao: async () => ({
    app_name: "HiperCRM",
    logo_url: null,
    logo_path: null,
    accent_hex: "#2563eb",
  }),
}));

import { resolverMarcaDaOrganizacao } from "@/lib/branding/organizacao";
import { marcaDaSaida } from "@/lib/branding/saida";
import {
  CHAVE_DO_MODULO,
  MODULOS_OPCIONAIS,
  modulosLigados,
  type ModuloOpcional,
} from "@/lib/instalacao/modulos";
import { NAV_CATALOG } from "@/lib/navigation/catalogo";
import { permitidos } from "@/lib/navigation/interface";

const INSTALACAO = { app_name: "HiperCRM", logo_url: null, accent_hex: "#2563eb" };
const AMBIENTE = { APP_NAME: "Do env" };
const DA_EMPRESA = {
  branding: { app_name: "Clínica da Ana", accent_hex: "#b3261e", logo_path: "org/logo.png" },
};

beforeEach(() => {
  deps.modulosGravados = [];
  deps.tabelasLidas = [];
  deps.settings = DA_EMPRESA;
});

function dbDe(linhas: Array<{ chave: string; valor: string }>): SupabaseClient {
  return {
    from: () => ({ select: () => ({ in: async () => ({ data: linhas, error: null }) }) }),
  } as unknown as SupabaseClient;
}

describe("o módulo existe e nasce desligado", () => {
  it("é um módulo opcional com a própria chave em platform_config", () => {
    expect(MODULOS_OPCIONAIS).toContain("marca_por_organizacao");
    expect(CHAVE_DO_MODULO.marca_por_organizacao).toBe("MODULO_MARCA_POR_ORGANIZACAO");
  });

  it("sem linha no banco, está desligado; só o valor `ligado` liga", async () => {
    const chave = "MODULO_MARCA_POR_ORGANIZACAO";
    expect(await modulosLigados(dbDe([]))).not.toContain("marca_por_organizacao");
    expect(await modulosLigados(dbDe([{ chave, valor: "desligado" }]))).not.toContain(
      "marca_por_organizacao",
    );
    expect(await modulosLigados(dbDe([{ chave, valor: "ligado" }]))).toContain(
      "marca_por_organizacao",
    );
  });
});

describe("resolverMarcaDaOrganizacao (a interface do tenant)", () => {
  it("DESLIGADO: ignora o que a empresa gravou e resolve só a instalação", () => {
    const marca = resolverMarcaDaOrganizacao(DA_EMPRESA, INSTALACAO, AMBIENTE, false);
    expect(marca.name).toBe("HiperCRM");
    expect(marca.cor?.semente).toBe("#2563eb");
    expect(marca.origens.nome).toBe("banco");
    expect(marca.origens.cor).toBe("banco");
    expect(marca.origens.logoUrl).not.toBe("organizacao");
    expect(marca.motivos.filter((m) => m.origem === "organizacao")).toEqual([]);
  });

  it("DESLIGADO: nem uma cor inválida da empresa gera aviso, porque a camada não entra", () => {
    const marca = resolverMarcaDaOrganizacao(
      { branding: { accent_hex: "vermelho" } },
      INSTALACAO,
      AMBIENTE,
      false,
    );
    expect(marca.motivos).toEqual([]);
  });

  it("LIGADO: a mesma entrada devolve a marca da empresa (prova que a flag decide)", () => {
    const marca = resolverMarcaDaOrganizacao(DA_EMPRESA, INSTALACAO, AMBIENTE, true);
    expect(marca.name).toBe("Clínica da Ana");
    expect(marca.cor?.semente).toBe("#b3261e");
    expect(marca.origens.nome).toBe("organizacao");
    expect(marca.origens.cor).toBe("organizacao");
    expect(marca.origens.logoUrl).toBe("organizacao");
  });

  it("DESLIGADO sem instalação cai no .env, como uma empresa sem marca", () => {
    const marca = resolverMarcaDaOrganizacao(DA_EMPRESA, null, AMBIENTE, false);
    expect(marca.name).toBe("Do env");
    expect(marca.origens.nome).toBe("env");
  });
});

describe("marcaDaSaida (e-mail e PDF da organização)", () => {
  it("DESLIGADO: sai com a marca da instalação e nem consulta a organização", async () => {
    const marca = await marcaDaSaida("22222222-2222-4222-8222-222222222222");
    expect(marca.nome).toBe("HiperCRM");
    expect(marca.origens.nome).toBe("banco");
    expect(deps.tabelasLidas).not.toContain("organizations");
  });

  it("LIGADO: sai com a marca da empresa", async () => {
    deps.modulosGravados = [{ chave: "MODULO_MARCA_POR_ORGANIZACAO", valor: "ligado" }];
    const marca = await marcaDaSaida("22222222-2222-4222-8222-222222222222");
    expect(marca.nome).toBe("Clínica da Ana");
    expect(marca.origens.nome).toBe("organizacao");
    expect(deps.tabelasLidas).toContain("organizations");
  });

  it("sem organização (login, e-mail de auth) a marca é a da instalação nos dois estados", async () => {
    expect((await marcaDaSaida(null)).nome).toBe("HiperCRM");
    deps.modulosGravados = [{ chave: "MODULO_MARCA_POR_ORGANIZACAO", valor: "ligado" }];
    expect((await marcaDaSaida(null)).nome).toBe("HiperCRM");
  });
});

describe("a porta Marca no menu, no hub e no ⌘K", () => {
  const href = "/app/settings/marca";
  const hrefs = (modulos: readonly ModuloOpcional[]) =>
    permitidos(false, "admin", modulos).map((d) => d.href);

  it("o catálogo amarra a porta ao módulo", () => {
    const porta = NAV_CATALOG.find((d) => d.href === href);
    expect(porta).toBeDefined();
    expect((porta as { modulo?: string }).modulo).toBe("marca_por_organizacao");
  });

  it("DESLIGADO: some para o admin da empresa", () => {
    expect(hrefs([])).not.toContain(href);
    expect(hrefs(["banco_externo", "fluxos_atendimento"])).not.toContain(href);
  });

  it("DESLIGADO: some também para o dono do servidor dentro do tenant", () => {
    expect(permitidos(true, "admin", []).map((d) => d.href)).not.toContain(href);
  });

  it("LIGADO: volta para o admin", () => {
    expect(hrefs(["marca_por_organizacao"])).toContain(href);
  });
});
