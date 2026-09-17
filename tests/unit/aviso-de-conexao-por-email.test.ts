/**
 * A queda que acontece com o time FORA do navegador.
 *
 * ─── O buraco que estes casos prendem ───────────────────────────────────────
 *
 * A Central e a faixa vermelha resolvem quem está com o CRM aberto. A queda
 * cara é a outra: 19h, ninguém olhando, número parado a noite inteira, e a
 * descoberta acontece pelo cliente reclamando no dia seguinte. O e-mail é o
 * único dos três avisos que chega até lá.
 *
 * Os casos cobrem o que faz esse aviso ser lido em vez de virar ruído:
 * quem recebe, que sai UMA vez por queda, que a volta também avisa, e que
 * nenhuma falha de envio derruba o vigia — que é o mesmo laço de todos os
 * tenants.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const enviados: { to: string | string[]; subject: string; text?: string }[] = [];
let respostaDoEnvio: { ok: boolean; error?: string } = { ok: true };

vi.mock("@/lib/email/resend", () => ({
  sendEmail: vi.fn(async (args: { to: string | string[]; subject: string; text?: string }) => {
    enviados.push(args);
    return respostaDoEnvio;
  }),
}));

vi.mock("@/lib/branding/saida", async (original) => {
  const real = (await original()) as Record<string, unknown>;
  return {
    ...real,
    marcaDaSaida: vi.fn(async () => ({
      nome: "Hiperbold CRM",
      logoUrl: null,
      accent: "#2563eb",
      accentFg: "#ffffff",
      origens: { nome: "instalacao", cor: "instalacao" },
    })),
  };
});

import { avisarConexaoPorEmail } from "@/lib/channels/aviso-por-email";
import { sincronizarSaudeDaConexao } from "@/lib/channels/health";

/** Vínculos da organização, na forma em que o banco os devolve. */
let membros: { user_id: string; role: string }[] = [];
let emailPorUsuario: Record<string, string | null> = {};
let escalado: string | null = null;

/**
 * Um Supabase de mentira que responde por TABELA — e que sabe filtrar por
 * papel, porque é justamente o filtro que este aviso não pode errar: mandar
 * "sua conexão caiu" para quem não pode reconectar é o ruído que ensina a
 * ignorar o alarme.
 */
function fakeAdmin() {
  const chain = (tabela: string) => {
    const filtros: Record<string, unknown> = {};
    const proxy: Record<string, unknown> = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "maybeSingle") {
            return async () => ({
              data:
                tabela === "channel_session_health"
                  ? { escalated_status: escalado }
                  : { display_name: "Hiperbold" },
              error: null,
            });
          }
          if (prop === "then") {
            return (ok: (v: unknown) => unknown) => {
              const linhas =
                tabela === "user_organizations"
                  ? membros.filter((m) => m.role === filtros["role"]).map((m) => ({ user_id: m.user_id }))
                  : [{ id: "x" }];
              return ok({ data: linhas, error: null });
            };
          }
          return (...args: unknown[]) => {
            if (prop === "eq") filtros[String(args[0])] = args[1];
            return proxy;
          };
        },
      },
    ) as Record<string, unknown>;
    return proxy;
  };

  return {
    from: (t: string) => ({
      select: () => chain(t),
      insert: () => chain(t),
      update: () => chain(t),
      upsert: () => chain(t),
    }),
    auth: {
      admin: {
        getUserById: async (id: string) => ({
          data: { user: { email: emailPorUsuario[id] ?? null } },
        }),
      },
    },
  } as never;
}

beforeEach(() => {
  enviados.length = 0;
  respostaDoEnvio = { ok: true };
  escalado = null;
  membros = [
    { user_id: "u-admin", role: "admin" },
    { user_id: "u-atendente", role: "agent" },
  ];
  emailPorUsuario = { "u-admin": "dono@empresa.com", "u-atendente": "atendente@empresa.com" };
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("quem recebe o aviso", () => {
  it("vai para o admin, e NÃO para quem não pode reconectar", async () => {
    const desfecho = await avisarConexaoPorEmail(fakeAdmin(), {
      organizationId: "org-1",
      apelido: "Comercial",
      evento: { tipo: "caiu", titulo: 'WhatsApp "Comercial" fora do ar', corpo: null },
    });

    expect(desfecho).toBe("enviado");
    expect(enviados).toHaveLength(1);
    expect(enviados[0]?.to).toEqual(["dono@empresa.com"]);
  });

  it("sem nenhum admin, não inventa destinatário", async () => {
    membros = [{ user_id: "u-atendente", role: "agent" }];

    expect(
      await avisarConexaoPorEmail(fakeAdmin(), {
        organizationId: "org-1",
        apelido: "Comercial",
        evento: { tipo: "caiu" },
      }),
    ).toBe("sem_destinatario");
    expect(enviados).toHaveLength(0);
  });

  it("o assunto diz QUAL número caiu — com dois ligados, 'caiu' obriga a adivinhar", async () => {
    await avisarConexaoPorEmail(fakeAdmin(), {
      organizationId: "org-1",
      apelido: "Comercial",
      evento: { tipo: "caiu" },
    });

    expect(enviados[0]?.subject).toContain("Comercial");
  });

  it("e-mail não configurado é estado normal, não falha", async () => {
    respostaDoEnvio = { ok: false, error: "not_configured" };

    expect(
      await avisarConexaoPorEmail(fakeAdmin(), {
        organizationId: "org-1",
        apelido: "Comercial",
        evento: { tipo: "caiu" },
      }),
    ).toBe("email_nao_configurado");
  });
});

describe("o aviso sai uma vez por queda, e a volta também avisa", () => {
  const sessao = { id: "sess-1", organization_id: "org-1", status: "FAILED" };
  const caiu = { reachable: true, status: "FAILED", detail: null };
  const viva = { reachable: true, status: "WORKING", detail: null };

  it("cai → sai um e-mail", async () => {
    expect(await sincronizarSaudeDaConexao(fakeAdmin(), sessao, caiu, "Comercial")).toBe("avisado");
    expect(enviados).toHaveLength(1);
    expect(enviados[0]?.subject).toMatch(/desconectado/i);
  });

  it("segue caída → NENHUM e-mail novo", async () => {
    // Um alarme a cada 5 minutos é um alarme que se aprende a apagar sem ler.
    escalado = "FAILED";
    expect(await sincronizarSaudeDaConexao(fakeAdmin(), sessao, caiu, "Comercial")).toBe("ja_avisado");
    expect(enviados).toHaveLength(0);
  });

  it("voltou → avisa o desfecho, senão o alarme fica sem fim", async () => {
    escalado = "FAILED";
    expect(await sincronizarSaudeDaConexao(fakeAdmin(), sessao, viva, "Comercial")).toBe("resolvido");
    expect(enviados).toHaveLength(1);
    expect(enviados[0]?.subject).toMatch(/voltou/i);
  });

  it("nunca esteve caída → nada de e-mail", async () => {
    expect(await sincronizarSaudeDaConexao(fakeAdmin(), sessao, viva, "Comercial")).toBe("sem_mudanca");
    expect(enviados).toHaveLength(0);
  });
});

describe("o envio não pode derrubar o vigia", () => {
  it("falha de e-mail não interrompe a sincronização da saúde", async () => {
    // O vigia roda de 5 em 5 minutos para TODAS as sessões de TODOS os tenants:
    // uma exceção aqui deixaria as conexões seguintes sem vigia nenhuma.
    const { sendEmail } = await import("@/lib/email/resend");
    vi.mocked(sendEmail).mockRejectedValueOnce(new Error("rede caiu"));

    expect(
      await sincronizarSaudeDaConexao(
        fakeAdmin(),
        { id: "sess-1", organization_id: "org-1", status: "FAILED" },
        { reachable: true, status: "FAILED", detail: null },
        "Comercial",
      ),
    ).toBe("avisado");
  });
});
