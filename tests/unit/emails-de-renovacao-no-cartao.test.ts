import { describe, expect, it, vi } from "vitest";

import type { MarcaDeSaida } from "@/lib/branding/saida";
import type { DesfechoDoEnfileiramento, EmailParaEnfileirar } from "@/lib/email/conta-e-cobranca/fila";
import { montarEmailDeConta, type ContextoDoEmail } from "@/lib/email/conta-e-cobranca/montar";
import {
  avisarRenovacoesNoCartao,
  type ContratoNoCartao,
} from "@/lib/email/conta-e-cobranca/renovacao-no-cartao";

import { clienteFalso, criarBancoFalso, type BancoFalso } from "./helpers/banco-de-emails-falso";

/**
 * COB-04, renovação no cartão chegando: quem entra, quando (1 a 3 dias antes da cobrança, que vence no último dia
 * de acesso), com que valor, que chave e que texto (sem os dígitos do cartão, que o CRM não guarda). A rodada só
 * ENFILEIRA: o enfileiramento real é trocado por um espião (a borda), o texto sai da mesma `montarEmailDeConta`
 * do envio, e a lista de contratos vem de um banco em memória.
 */

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const ORG = "0952d000-0000-4000-8000-00000000000a";
const MARCA: MarcaDeSaida = {
  nome: "HiperCRM",
  logoUrl: null,
  accent: "#0139B0",
  accentFg: "#ffffff",
  origens: { nome: "padrao", cor: "padrao" },
};
/** 00h de São Paulo de 12/11/2026: o último dia de acesso (e a cobrança do cartão) é 11/11. */
const FIM_DO_PERIODO = "2026-11-12T03:00:00+00:00";
/** 08h05 em São Paulo de 08/11/2026: faltam 3 dias para a cobrança de 11/11. */
const HOJE_D3 = new Date("2026-11-08T11:05:00Z");

function mundo(): BancoFalso {
  return criarBancoFalso({
    tabelas: {
      organizations: [
        { id: ORG, status: "active" },
        { id: "org-suspensa", status: "suspended" },
      ],
      billing_plans: [
        {
          id: "plano-pro",
          name: "Pro",
          price_monthly_cents: 34966,
          price_semiannual_cents: 189900,
          price_yearly_cents: 349900,
        },
        { id: "plano-sem-preco", name: "Sem preço", price_monthly_cents: null, price_semiannual_cents: null, price_yearly_cents: null },
      ],
    },
  });
}

function contrato(extra: Partial<ContratoNoCartao> = {}): ContratoNoCartao {
  return {
    id: "c-1",
    organization_id: ORG,
    plan_id: "plano-pro",
    cycle: "monthly",
    current_period_end: FIM_DO_PERIODO,
    ...extra,
  };
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
  contratos: ContratoNoCartao[],
  agora: Date = HOJE_D3,
  desfecho: DesfechoDoEnfileiramento = "enfileirado",
  banco: BancoFalso = mundo(),
  extra: { orcamentoMs?: number; relogio?: () => Date } = {},
) {
  const enviadas: EmailParaEnfileirar[] = [];
  const janelas: Array<[Date, Date]> = [];
  const resultado = avisarRenovacoesNoCartao(clienteFalso(banco), {
    agora: extra.relogio ?? (() => agora),
    ...(extra.orcamentoMs !== undefined ? { orcamentoMs: extra.orcamentoMs } : {}),
    listar: async (_admin, de, ate) => {
      janelas.push([de, ate]);
      return contratos;
    },
    enfileirar: async (e) => {
      enviadas.push(e);
      return desfecho;
    },
  });
  return { resultado, enviadas, janelas };
}

const montar = (e: EmailParaEnfileirar, idioma: "pt-BR" | "es" = "pt-BR") =>
  montarEmailDeConta(e.emailId, e.dados, ctx(idioma));

describe("COB-04 renovação no cartão chegando", () => {
  it("3 dias antes: manda aos admins, sem cópia ao operador, chave pelo contrato e pela data da cobrança", async () => {
    const r = rodar([contrato()]);
    const resumo = await r.resultado;

    expect(r.enviadas).toHaveLength(1);
    const e = r.enviadas[0]!;
    expect([e.organizationId, e.emailId, e.chave, e.destino, e.copiaParaOperador]).toEqual([
      ORG,
      "COB-04",
      "renovacao:c-1:2026-11-11",
      "admins",
      false,
    ]);
    expect(resumo).toMatchObject({ avaliados: 1, enfileirados: 1, foraDaJanela: 0, pulados: 0, falhas: 0, restantes: 0 });
  });

  it("o texto fala do cartão cadastrado, sem dígitos e sem a linha Cartão, com valor, data, plano e botão", async () => {
    const r = rodar([contrato()]);
    await r.resultado;
    const m = montar(r.enviadas[0]!);

    expect(m.subject).toBe("Seu plano renova em 3 dias");
    expect(m.text).toContain("No dia 11/11/2026 vamos cobrar R$ 349,66 no cartão cadastrado para renovar o plano Pro");
    expect(m.text).not.toMatch(/final \d/);
    expect(m.text).not.toContain("Cartão:");
    expect(m.text).toContain("Data da cobrança: 11/11/2026");
    expect(m.text).toContain("https://crm.exemplo.com.br/app/settings/plano");
    // O espanhol traduz a frase nova (não cai em português).
    expect(montar(r.enviadas[0]!, "es").text).toContain("tarjeta registrada");
  });

  it("o valor segue o ciclo do contrato: semestral e anual usam a própria coluna de preço", async () => {
    const semestral = rodar([contrato({ cycle: "semiannual" })]);
    await semestral.resultado;
    expect(montar(semestral.enviadas[0]!).text).toContain("R$ 1.899,00");

    const anual = rodar([contrato({ cycle: "yearly" })]);
    await anual.resultado;
    expect(montar(anual.enviadas[0]!).text).toContain("R$ 3.499,00");
  });

  it("2 e 1 dia antes (job que perdeu um dia) ainda avisam, com a MESMA chave, e 1 dia sai no singular", async () => {
    const d2 = rodar([contrato()], new Date("2026-11-09T11:05:00Z"));
    await d2.resultado;
    const d1 = rodar([contrato()], new Date("2026-11-10T11:05:00Z"));
    await d1.resultado;
    const d3 = rodar([contrato()]);
    await d3.resultado;

    expect(montar(d2.enviadas[0]!).subject).toBe("Seu plano renova em 2 dias");
    expect(montar(d1.enviadas[0]!).subject).toBe("Seu plano renova em 1 dia");
    expect(new Set([d3, d2, d1].map((x) => x.enviadas[0]!.chave))).toEqual(new Set(["renovacao:c-1:2026-11-11"]));
  });

  it("4 dias antes e no próprio dia da cobrança não avisam (fora da janela)", async () => {
    const longe = rodar([contrato()], new Date("2026-11-07T11:05:00Z"));
    const resumoLonge = await longe.resultado;
    const hoje = rodar([contrato()], new Date("2026-11-11T11:05:00Z"));
    const resumoHoje = await hoje.resultado;

    expect(longe.enviadas).toEqual([]);
    expect(hoje.enviadas).toEqual([]);
    expect(resumoLonge.foraDaJanela).toBe(1);
    expect(resumoHoje.foraDaJanela).toBe(1);
  });

  it("a data da cobrança é do dia em São Paulo, não do UTC: 22h de 10/11 em SP ainda é 1 dia antes", async () => {
    const r = rodar([contrato()], new Date("2026-11-11T01:00:00Z"));
    await r.resultado;
    expect(r.enviadas).toHaveLength(1);
    expect(montar(r.enviadas[0]!).subject).toBe("Seu plano renova em 1 dia");
  });

  it("organização que não está ativa e contrato sem preço do ciclo ficam de fora", async () => {
    const r = rodar([
      contrato({ id: "c-susp", organization_id: "org-suspensa" }),
      contrato({ id: "c-sem-preco", plan_id: "plano-sem-preco" }),
      contrato({ id: "c-sem-plano", plan_id: "plano-que-nao-existe" }),
      contrato({ id: "c-sem-ciclo", cycle: null }),
    ]);
    const resumo = await r.resultado;
    expect(r.enviadas).toEqual([]);
    expect(resumo.pulados).toBe(4);
  });

  it("conta o desfecho de cada enfileiramento: já estava na fila, falha", async () => {
    const casos: Array<[DesfechoDoEnfileiramento, string]> = [
      ["ja_existia", "jaAvisados"],
      ["falhou", "falhas"],
    ];
    for (const [desfecho, campo] of casos) {
      const resumo = await rodar([contrato()], HOJE_D3, desfecho).resultado;
      expect(resumo, desfecho).toMatchObject({ [campo]: 1, enfileirados: 0 });
    }
  });

  it("um contrato que lança não derruba os demais da rodada", async () => {
    const banco = mundo();
    banco.tabelas.organizations!.push({ id: "org-b", status: "active" });
    const enviadas: string[] = [];
    const resumo = await avisarRenovacoesNoCartao(clienteFalso(banco), {
      agora: () => HOJE_D3,
      listar: async () => [contrato({ id: "c-1" }), contrato({ id: "c-2", organization_id: "org-b" })],
      enfileirar: async (e) => {
        if (e.chave.includes("c-1")) throw new Error("banco caiu");
        enviadas.push(e.chave);
        return "enfileirado";
      },
    });
    expect(enviadas).toEqual(["renovacao:c-2:2026-11-11"]);
    expect(resumo).toMatchObject({ enfileirados: 1, falhas: 1 });
  });

  it("os dados enfileirados são os do momento e não levam endereço de e-mail", async () => {
    const r = rodar([contrato()]);
    await r.resultado;
    expect(r.enviadas[0]!.dados).toEqual({ plano: "Pro", valor: 34966, cobrancaEm: "2026-11-11", dias: 3 });
    expect(JSON.stringify(r.enviadas)).not.toContain("@");
  });

  it("orçamento de tempo: estourado, a rodada para, conta quantos contratos ficaram e não perde o que já enfileirou", async () => {
    const banco = mundo();
    for (const org of ["org-b", "org-c", "org-d"]) banco.tabelas.organizations!.push({ id: org, status: "active" });
    // cada leitura do relógio passa 100 ms; o orçamento é de 250 ms
    let t = HOJE_D3.getTime();
    const relogio = () => new Date((t += 100));
    const r = rodar(
      [
        contrato({ id: "c-1" }),
        contrato({ id: "c-2", organization_id: "org-b" }),
        contrato({ id: "c-3", organization_id: "org-c" }),
        contrato({ id: "c-4", organization_id: "org-d" }),
      ],
      HOJE_D3,
      "enfileirado",
      banco,
      { orcamentoMs: 250, relogio },
    );
    const resumo = await r.resultado;
    expect(resumo.enfileirados).toBeGreaterThan(0);
    expect(resumo.restantes).toBeGreaterThan(0);
    expect(resumo.enfileirados + resumo.restantes).toBe(4);
  });

  it("a janela pedida ao banco cobre 5 dias a partir de agora; erro ao listar sobe", async () => {
    const r = rodar([]);
    await r.resultado;
    const [de, ate] = r.janelas[0]!;
    expect(de).toEqual(HOJE_D3);
    expect(ate.getTime() - de.getTime()).toBe(5 * 24 * 60 * 60 * 1000);

    await expect(
      avisarRenovacoesNoCartao(clienteFalso(mundo()), {
        listar: async () => {
          throw new Error("billing_contracts: sem conexão");
        },
      }),
    ).rejects.toThrow("billing_contracts");
  });
});
