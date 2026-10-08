import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MarcaDeSaida } from "@/lib/branding/saida";
import type { DesfechoDoEnfileiramento, EmailParaEnfileirar } from "@/lib/email/conta-e-cobranca/fila";
import { montarEmailDeConta, type ContextoDoEmail } from "@/lib/email/conta-e-cobranca/montar";
import {
  avisarTokensAcabando,
  cicloAtual,
  proximoCiclo,
  type LimiarCruzado,
} from "@/lib/email/conta-e-cobranca/tokens-acabando";
import type { ModoDaFranquiaDeTokens } from "@/lib/email/templates/tokens-de-ia-acabando";

import { clienteFalso, criarBancoFalso, type BancoFalso } from "./helpers/banco-de-emails-falso";

/**
 * IA-02, tokens de IA acabando. O banco já detecta o cruzamento (`fn_billing_avisar_carteira` grava
 * `limiar:<ciclo>:<80|100>` em `billing_token_avisos_emitidos`); o job lê essas linhas e ENFILEIRA o e-mail (o
 * texto sai da mesma `montarEmailDeConta` do envio, a partir dos `dados`). Provas:
 * o nível certo, a chave estável por organização e ciclo, o 100 que vale mais que o 80, o ciclo que já virou, a
 * organização que já foi avisada (sem refazer a conta do saldo), o saldo ilimitado ou com leitura falhando, e
 * a data de renovação (dia 1 do mês seguinte).
 */

const rpc = vi.fn();
/** O `lib/env` com a chave de emergência que o job lê (`PLANOS_BLOQUEIO`); o resto do `env` o job não usa. */
const estadoEnv = vi.hoisted(() => ({ PLANOS_BLOQUEIO: "on" as string }));
vi.mock("@/lib/env", () => ({ env: estadoEnv }));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const ORG = "0952e000-0000-4000-8000-00000000000a";
const OUTRA = "0952e000-0000-4000-8000-00000000000b";
const MARCA: MarcaDeSaida = {
  nome: "HiperCRM",
  logoUrl: null,
  accent: "#0139B0",
  accentFg: "#ffffff",
  origens: { nome: "padrao", cor: "padrao" },
};
/** 12h em São Paulo de 15/10/2026. */
const AGORA = new Date("2026-10-15T15:00:00Z");

/** A resposta de `fn_billing_saldo_da_carteira` (o formato do esquema de `saldo-da-organizacao.ts`). */
function saldo(consumido: number, disponivel: number, semLimite = false) {
  const fonte = (creditado: number, usado: number) => ({ creditado, consumido: usado, saldo: creditado - usado });
  return {
    ciclo: "2026-10-01",
    por_fonte: { plano: fonte(disponivel, consumido), adicional: fonte(0, 0), avulso: fonte(0, 0) },
    sem_limite: semLimite,
    total_disponivel: disponivel,
    total_consumido: consumido,
    concessao_pendente: false,
  };
}

function clienteComRpc(banco: BancoFalso) {
  const base = clienteFalso(banco) as unknown as Record<string, unknown>;
  return { ...base, rpc: (nome: string, args: unknown) => rpc(nome, args) } as never;
}

function ctx(idioma: "pt-BR" | "es" = "pt-BR"): ContextoDoEmail {
  return {
    organizationId: ORG,
    empresa: "Empresa A",
    idioma,
    marca: MARCA,
    appUrl: "https://crm.exemplo.com.br",
    nome: "Diego",
    base: (url) => ({ marca: MARCA, idioma, empresa: "Empresa A", url }),
  };
}

function rodar(
  limiares: LimiarCruzado[],
  opcoes: {
    banco?: BancoFalso;
    agora?: Date;
    desfecho?: DesfechoDoEnfileiramento;
    modo?: ModoDaFranquiaDeTokens;
  } = {},
) {
  const enviadas: EmailParaEnfileirar[] = [];
  const janelas: Date[] = [];
  const banco = opcoes.banco ?? criarBancoFalso();
  const resultado = avisarTokensAcabando(clienteComRpc(banco), {
    agora: () => opcoes.agora ?? AGORA,
    // Os textos de "a IA para" são os do modo bloquear; os do modo avisar têm bloco próprio abaixo.
    modo: async () => opcoes.modo ?? "bloquear",
    listar: async (_admin, desde) => {
      janelas.push(desde);
      return limiares;
    },
    enfileirar: async (e) => {
      enviadas.push(e);
      const desfecho = opcoes.desfecho ?? "enfileirado";
      // Como o enfileiramento real: a chave passa a existir em billing_emails_enviados.
      if (desfecho === "enfileirado") {
        banco.tabelas.billing_emails_enviados!.push({ organization_id: e.organizationId, email_id: e.emailId, chave: e.chave });
      }
      return desfecho;
    },
  });
  return { resultado, enviadas, janelas, banco };
}

const montar = (e: EmailParaEnfileirar, idioma: "pt-BR" | "es" = "pt-BR") =>
  montarEmailDeConta(e.emailId, e.dados, ctx(idioma));

const l80 = (org = ORG, ciclo = "2026-10-01"): LimiarCruzado => ({ organization_id: org, chave: `limiar:${ciclo}:80` });
const l100 = (org = ORG, ciclo = "2026-10-01"): LimiarCruzado => ({ organization_id: org, chave: `limiar:${ciclo}:100` });

beforeEach(() => {
  rpc.mockReset();
  rpc.mockResolvedValue({ data: saldo(400_000, 500_000), error: null });
});

describe("IA-02 tokens de IA acabando", () => {
  it("80%: manda aos admins, sem cópia ao operador, chave por organização, ciclo e nível, com os números do saldo", async () => {
    const r = rodar([l80()]);
    const resumo = await r.resultado;

    expect(r.enviadas).toHaveLength(1);
    const e = r.enviadas[0]!;
    expect([e.organizationId, e.emailId, e.chave, e.destino, e.copiaParaOperador]).toEqual([
      ORG,
      "IA-02",
      `tokens:${ORG}:2026-10-01:80`,
      "admins",
      false,
    ]);
    const m = montar(e);
    expect(m.subject).toBe("Seus tokens de IA estão acabando");
    expect(m.text).toContain("já usou 80% dos tokens de IA do mês");
    expect(m.text).toContain("400.000 de 500.000");
    expect(m.text).toContain("01/11/2026");
    expect(m.text).toContain("https://crm.exemplo.com.br/app/settings/plano");
    expect(resumo).toMatchObject({ lidos: 1, enfileirados: 1, falhas: 0 });
    expect(rpc).toHaveBeenCalledWith("fn_billing_saldo_da_carteira", { p_org: ORG });
  });

  it("a barra mostra o limiar que cruzou (80 ou 100), e usados/total são os da hora em que a rodada enfileira", async () => {
    // o saldo de agora (60%) difere do limiar gravado pelo banco (80): a barra e o texto seguem o limiar
    rpc.mockResolvedValue({ data: saldo(300_000, 500_000), error: null });
    const r80 = rodar([l80()]);
    await r80.resultado;
    expect(r80.enviadas[0]!.dados).toMatchObject({ nivel: 80, usados: 300_000, total: 500_000, modo: "bloquear" });
    const m80 = montar(r80.enviadas[0]!);
    expect(m80.text).toContain("Tokens usados no mês: 80%");
    expect(m80.text).toContain("300.000 de 500.000");

    // 90% no saldo de agora, mas o limiar que cruzou foi o de 100
    rpc.mockResolvedValue({ data: saldo(450_000, 500_000), error: null });
    const r100 = rodar([l100()]);
    await r100.resultado;
    expect(montar(r100.enviadas[0]!).text).toContain("Tokens usados no mês: 100%");

    // consumo acima do total no momento da leitura: a barra continua no limiar
    rpc.mockResolvedValue({ data: saldo(10, 1), error: null });
    const r1 = rodar([l80()]);
    await r1.resultado;
    expect(montar(r1.enviadas[0]!).text).toContain("Tokens usados no mês: 80%");
  });

  it("100%: título de esgotado e chave do nível 100", async () => {
    rpc.mockResolvedValue({ data: saldo(500_000, 500_000), error: null });
    const r = rodar([l100()]);
    await r.resultado;

    expect(r.enviadas[0]!.chave).toBe(`tokens:${ORG}:2026-10-01:100`);
    const m = montar(r.enviadas[0]!);
    expect(m.subject).toBe("Seus tokens de IA acabaram");
    expect(m.text).toContain("já usou 100% dos tokens de IA do mês");
  });

  it("80 e 100 juntos da mesma organização: só o 100 sai (qualquer que seja a ordem das linhas)", async () => {
    for (const linhas of [[l80(), l100()], [l100(), l80()]]) {
      rpc.mockClear();
      const r = rodar(linhas);
      const resumo = await r.resultado;
      expect(r.enviadas.map((e) => e.chave)).toEqual([`tokens:${ORG}:2026-10-01:100`]);
      expect(resumo.descartados).toBe(1);
      expect(rpc).toHaveBeenCalledTimes(1);
    }
  });

  it("organizações diferentes são avisadas cada uma no seu nível", async () => {
    const r = rodar([l80(ORG), l100(OUTRA)]);
    await r.resultado;
    expect(r.enviadas.map((e) => e.chave).sort()).toEqual([`tokens:${ORG}:2026-10-01:80`, `tokens:${OUTRA}:2026-10-01:100`].sort());
  });

  it("linha de ciclo anterior ou de outro limiar (50) não avisa", async () => {
    const r = rodar([l80(ORG, "2026-09-01"), { organization_id: OUTRA, chave: "limiar:2026-10-01:50" }]);
    const resumo = await r.resultado;
    expect(r.enviadas).toEqual([]);
    expect(resumo.descartados).toBe(2);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("quem já recebeu esse nível no ciclo não refaz a conta do saldo nem manda de novo", async () => {
    const banco = criarBancoFalso();
    banco.tabelas.billing_emails_enviados!.push({ organization_id: ORG, email_id: "IA-02", chave: `tokens:${ORG}:2026-10-01:80` });
    const r = rodar([l80()], { banco });
    const resumo = await r.resultado;

    expect(r.enviadas).toEqual([]);
    expect(resumo.jaAvisados).toBe(1);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("quem recebeu o 80 recebe o 100 depois (nível novo, chave nova)", async () => {
    const banco = criarBancoFalso();
    banco.tabelas.billing_emails_enviados!.push({ organization_id: ORG, email_id: "IA-02", chave: `tokens:${ORG}:2026-10-01:80` });
    const r = rodar([l80(), l100()], { banco });
    await r.resultado;
    expect(r.enviadas.map((e) => e.chave)).toEqual([`tokens:${ORG}:2026-10-01:100`]);
  });

  it("rodada seguinte, depois de enviado, não repete (a reserva do envio já existe)", async () => {
    const primeira = rodar([l80()]);
    await primeira.resultado;
    const segunda = rodar([l80()], { banco: primeira.banco });
    const resumo = await segunda.resultado;
    expect(segunda.enviadas).toEqual([]);
    expect(resumo.jaAvisados).toBe(1);
  });

  it("saldo ilimitado ou leitura que falhou: nada sai agora e a próxima rodada tenta de novo", async () => {
    rpc.mockResolvedValue({ data: saldo(0, 0, true), error: null });
    const ilimitado = rodar([l80()]);
    expect((await ilimitado.resultado).semSaldo).toBe(1);
    expect(ilimitado.enviadas).toEqual([]);

    rpc.mockResolvedValue({ data: null, error: { message: "timeout" } });
    const falhou = rodar([l80()]);
    expect((await falhou.resultado).semSaldo).toBe(1);
    expect(falhou.enviadas).toEqual([]);
  });

  it("conta o desfecho do enfileiramento: já estava na fila, falha", async () => {
    const casos: Array<[DesfechoDoEnfileiramento, string]> = [
      ["ja_existia", "jaAvisados"],
      ["falhou", "falhas"],
    ];
    for (const [desfecho, campo] of casos) {
      const resumo = await rodar([l80()], { desfecho }).resultado;
      expect(resumo, desfecho).toMatchObject({ [campo]: 1, enfileirados: 0 });
    }
  });

  it("uma organização que lança não derruba as outras", async () => {
    const enviadas: string[] = [];
    const resumo = await avisarTokensAcabando(clienteComRpc(criarBancoFalso()), {
      agora: () => AGORA,
      modo: async () => "bloquear",
      listar: async () => [l80(ORG), l80(OUTRA)],
      enfileirar: async (e) => {
        if (e.organizationId === ORG) throw new Error("banco caiu");
        enviadas.push(e.chave);
        return "enfileirado";
      },
    });
    expect(enviadas).toEqual([`tokens:${OUTRA}:2026-10-01:80`]);
    expect(resumo).toMatchObject({ enfileirados: 1, falhas: 1 });
  });

  it("lê só as linhas das últimas 48 horas; erro ao listar sobe", async () => {
    const r = rodar([]);
    await r.resultado;
    expect(AGORA.getTime() - r.janelas[0]!.getTime()).toBe(2 * 24 * 60 * 60 * 1000);

    await expect(
      avisarTokensAcabando(clienteComRpc(criarBancoFalso()), {
        listar: async () => {
          throw new Error("billing_token_avisos_emitidos: sem conexão");
        },
      }),
    ).rejects.toThrow("billing_token_avisos_emitidos");
  });
});

describe("IA-02: o texto acompanha o modo do sistema", () => {
  const AVISAR_80 =
    "A Empresa A já usou 80% dos tokens de IA do mês. Para manter o uso dentro do plano, compre um pacote extra.";
  const AVISAR_100 =
    "A Empresa A já usou 100% dos tokens de IA do mês. Para manter o uso dentro do plano, compre um pacote extra.";

  it("modo avisar, nível 80: pede o pacote extra e não fala de parada nem de data de volta", async () => {
    const r = rodar([l80()], { modo: "avisar" });
    await r.resultado;
    const m = montar(r.enviadas[0]!);
    expect(m.subject).toBe("Seus tokens de IA estão acabando");
    expect(m.text).toContain(AVISAR_80);
    expect(m.text).not.toMatch(/para de responder|parou/);
    expect(m.html).toContain("compre um pacote extra");
  });

  it("modo avisar, nível 100: assunto 'do mês acabaram' e texto sem afirmar que a IA parou", async () => {
    rpc.mockResolvedValue({ data: saldo(500_000, 500_000), error: null });
    const r = rodar([l100()], { modo: "avisar" });
    await r.resultado;
    const m = montar(r.enviadas[0]!);
    expect(m.subject).toBe("Seus tokens de IA do mês acabaram");
    expect(m.text).toContain(AVISAR_100);
    expect(m.text).not.toMatch(/para de responder|parou/);
  });

  it("modo bloquear mantém os textos em que a IA para", async () => {
    rpc.mockResolvedValue({ data: saldo(500_000, 500_000), error: null });
    const r = rodar([l100()], { modo: "bloquear" });
    await r.resultado;
    const m = montar(r.enviadas[0]!);
    expect(m.subject).toBe("Seus tokens de IA acabaram");
    expect(m.text).toContain("A IA parou de responder");
  });

  it("o texto novo existe em espanhol", async () => {
    const r = rodar([l80()], { modo: "avisar" });
    await r.resultado;
    const m = montar(r.enviadas[0]!, "es");
    expect(m.text).toContain("ya usó el 80% de los tokens de IA del mes");
    expect(m.text).toContain("compra un paquete extra");
    expect(m.text).not.toContain("compre um pacote extra");
  });

  describe("o gatilho lê o modo do banco (billing_settings.modo)", () => {
    beforeEach(() => {
      estadoEnv.PLANOS_BLOQUEIO = "on";
    });
    afterEach(() => {
      estadoEnv.PLANOS_BLOQUEIO = "on";
    });

    function rodarLendoOModo(modo: string | null, falhaNaLeitura = false) {
      const banco = criarBancoFalso({ tabelas: { billing_settings: modo === null ? [] : [{ id: 1, modo }] } });
      if (falhaNaLeitura) banco.falhar.billing_settings = { code: "08006", message: "conexão perdida" };
      const enviadas: EmailParaEnfileirar[] = [];
      const resultado = avisarTokensAcabando(clienteComRpc(banco), {
        agora: () => AGORA,
        listar: async () => [l80()],
        enfileirar: async (e) => {
          enviadas.push(e);
          return "enfileirado";
        },
      });
      return { resultado, enviadas };
    }

    it("modo bloquear no banco: texto de parada", async () => {
      estadoEnv.PLANOS_BLOQUEIO = "on";
      const r = rodarLendoOModo("bloquear");
      await r.resultado;
      expect(montar(r.enviadas[0]!).text).toContain("a IA para de responder");
    });

    it.each(["avisar", "desligado", null])("modo %s no banco: texto de só avisar", async (modo) => {
      const r = rodarLendoOModo(modo);
      await r.resultado;
      const m = montar(r.enviadas[0]!);
      expect(m.text).toContain(AVISAR_80);
      expect(m.text).not.toMatch(/para de responder|parou/);
    });

    it("bloquear no banco mas a chave de emergência PLANOS_BLOQUEIO rebaixa (avisar ou off): texto de só avisar", async () => {
      for (const chave of ["avisar", "off"]) {
        estadoEnv.PLANOS_BLOQUEIO = chave;
        const r = rodarLendoOModo("bloquear");
        await r.resultado;
        expect(montar(r.enviadas[0]!).text, chave).toContain(AVISAR_80);
      }
    });

    it("leitura do modo falhando: cai em só avisar (nunca afirma uma parada que pode não existir)", async () => {
      estadoEnv.PLANOS_BLOQUEIO = "on";
      const r = rodarLendoOModo("bloquear", true);
      await r.resultado;
      expect(montar(r.enviadas[0]!).text).toContain(AVISAR_80);
    });
  });
});

describe("a leitura padrão dos limiares (consulta real ao banco, com o banco em memória)", () => {
  interface Linha {
    organization_id: string;
    chave: string;
    created_at: string;
  }

  /** Um PostgREST em memória só para `billing_token_avisos_emitidos`: in, gte, order e range como o servidor faz. */
  function bancoDeAvisos(linhas: Linha[]) {
    const paginas: Array<[number, number]> = [];
    const admin = {
      from(tabela: string) {
        expect(tabela).toBe("billing_token_avisos_emitidos");
        let chaves: string[] | null = null;
        let desde = "";
        let decrescente = false;
        const consulta = {
          select: () => consulta,
          in: (coluna: string, valores: string[]) => {
            expect(coluna).toBe("chave");
            chaves = valores;
            return consulta;
          },
          like: () => {
            throw new Error("a leitura não pode usar like 'limiar:%' (traz o 50)");
          },
          gte: (_coluna: string, valor: string) => {
            desde = valor;
            return consulta;
          },
          order: (_coluna: string, opcoes: { ascending: boolean }) => {
            decrescente = !opcoes.ascending;
            return consulta;
          },
          range: async (de: number, ate: number) => {
            paginas.push([de, ate]);
            const lista = linhas
              .filter((l) => (chaves ? chaves.includes(l.chave) : true) && l.created_at >= desde)
              .sort((a, b) => (decrescente ? -1 : 1) * a.created_at.localeCompare(b.created_at));
            return { data: lista.slice(de, ate + 1).map(({ organization_id, chave }) => ({ organization_id, chave })), error: null };
          },
        };
        return consulta;
      },
    } as unknown as SupabaseClient;
    return { admin, paginas };
  }

  const hora = (n: number) => new Date(Date.UTC(2026, 9, 14, 0, 0, 0) + n * 1000).toISOString();

  function rodarPadrao(linhas: Linha[]) {
    const { admin, paginas } = bancoDeAvisos(linhas);
    const banco = criarBancoFalso();
    const base = clienteFalso(banco) as unknown as Record<string, unknown>;
    const composto = { ...base, from: (t: string) => (t === "billing_token_avisos_emitidos" ? admin.from(t) : (base.from as (x: string) => unknown)(t)), rpc: (n: string, a: unknown) => rpc(n, a) } as never;
    const enviadas: string[] = [];
    const resultado = avisarTokensAcabando(composto, {
      agora: () => AGORA,
      modo: async () => "avisar",
      enfileirar: async (e) => {
        enviadas.push(e.chave);
        return "enfileirado";
      },
    });
    return { resultado, enviadas, paginas };
  }

  it("lê só 80 e 100 do ciclo atual: o limiar 50 e o ciclo anterior nem chegam ao job", async () => {
    const r = rodarPadrao([
      { organization_id: ORG, chave: "limiar:2026-10-01:50", created_at: hora(10) },
      { organization_id: OUTRA, chave: "limiar:2026-09-01:80", created_at: hora(11) },
      { organization_id: ORG, chave: "limiar:2026-10-01:80", created_at: hora(12) },
    ]);
    const resumo = await r.resultado;
    expect(resumo.lidos).toBe(1);
    expect(r.enviadas).toEqual([`tokens:${ORG}:2026-10-01:80`]);
  });

  it("muitas linhas antigas não bloqueiam as novas: lê das mais novas para as mais antigas e continua pela próxima página", async () => {
    // 1200 organizações já avisadas (as mais antigas) e uma organização nova, a mais recente de todas.
    const antigas: Linha[] = Array.from({ length: 1200 }, (_, i) => ({
      organization_id: `org-antiga-${i}`,
      chave: "limiar:2026-10-01:80",
      created_at: hora(i),
    }));
    const nova: Linha = { organization_id: ORG, chave: "limiar:2026-10-01:100", created_at: hora(5000) };
    const r = rodarPadrao([...antigas, nova]);
    // as antigas já têm a reserva; só a nova precisa de e-mail
    // (o espião de envio aceita tudo, então conferimos que a nova foi vista e que a leitura paginou)
    const resumo = await r.resultado;
    expect(r.paginas.length).toBeGreaterThan(1);
    expect(r.paginas[0]).toEqual([0, 499]);
    expect(resumo.lidos).toBe(1201);
    expect(r.enviadas).toContain(`tokens:${ORG}:2026-10-01:100`);
  });
});

describe("o ciclo", () => {
  it("é o mês civil de São Paulo, não o do UTC", () => {
    expect(cicloAtual(new Date("2026-10-15T15:00:00Z"))).toBe("2026-10-01");
    // 01/11 00:30 UTC ainda é 31/10 21:30 em São Paulo.
    expect(cicloAtual(new Date("2026-11-01T00:30:00Z"))).toBe("2026-10-01");
    expect(cicloAtual(new Date("2026-11-01T03:00:00Z"))).toBe("2026-11-01");
  });

  it("a renovação é o dia 1 do mês seguinte, inclusive na virada do ano", () => {
    expect(proximoCiclo("2026-10-01")).toBe("2026-11-01");
    expect(proximoCiclo("2026-12-01")).toBe("2027-01-01");
  });
});
