import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A ORDEM DAS CHAMADAS DA RÉGUA DE RENOVAÇÃO (D-177, parte 2). As regras de data e de estado (marcos em São
 * Paulo, job atrasado, renovou, cancelou, organização suspensa, assinatura viva) são do banco e estão
 * provadas em `tests/invariants/regua-de-renovacao-banco.test.ts`. Aqui se prova o que é do código:
 *
 *   - e-mail e aviso na Central são cumpridos pelo que a reserva manda, e o resultado de cada canal é gravado;
 *   - e-mail não configurado: registra e segue para o aviso na Central;
 *   - falha de e-mail não derruba o aviso, e vice-versa; falha de uma organização não derruba as outras;
 *   - o idioma do aviso é o da organização; a severidade segue o marco;
 *   - a reserva recusada não envia nada; orçamento de tempo deixa o resto para amanhã.
 */

const warn = vi.fn();
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: (...a: unknown[]) => warn(...a), error: vi.fn(), debug: vi.fn() },
}));

import {
  avisarRenovacoes,
  type AvisadorDeRenovacaoDb,
  type AvisadorDeRenovacaoServicos,
  type PendenteDeRenovacao,
  type ReservaDeRenovacao,
} from "@/lib/billing/assinatura/avisar-renovacao";

function pendente(parte: Partial<PendenteDeRenovacao> = {}): PendenteDeRenovacao {
  return {
    organizationId: "org-1",
    contractId: "c-1",
    fimDoPeriodo: "2026-11-07T03:00:00+00:00",
    ultimoDia: "2026-11-06",
    diasRestantes: 30,
    marco: 30,
    planoNome: "Pro",
    ciclo: "semiannual",
    orgNome: "Acme",
    orgLocale: "pt-BR",
    ...parte,
  };
}

interface Estado {
  pendentes: PendenteDeRenovacao[];
  reservas: Record<string, ReservaDeRenovacao | null | Error>;
  emails: Array<{ reserva: string; resultado: string; enviados: number; falhas: number }>;
  avisos: Array<{ reserva: string; titulo: string; corpo: string; severidade: string }>;
  avisosFalhos: string[];
  erroAoCriarAviso: Set<string>;
}

function montarDb(e: Estado): AvisadorDeRenovacaoDb {
  return {
    encerrarAvisosDeQuemRenovou: async () => ({ data: 2, error: null }),
    listarPendentes: async () => ({ data: e.pendentes, error: null }),
    reservar: async (p) => {
      const r = e.reservas[p.organizationId];
      if (r instanceof Error) throw r;
      return { data: r ?? null, error: null };
    },
    gravarEmail: async (reserva, resultado, enviados, falhas) => {
      e.emails.push({ reserva, resultado, enviados, falhas });
      return { error: null };
    },
    criarAviso: async (reserva, titulo, corpo, severidade) => {
      if (e.erroAoCriarAviso.has(reserva)) return { data: null, error: { message: "boom do banco" } };
      e.avisos.push({ reserva, titulo, corpo, severidade });
      return { data: `item-${reserva}`, error: null };
    },
    marcarAvisoFalhou: async (reserva) => {
      e.avisosFalhos.push(reserva);
      return { error: null };
    },
  };
}

function montarServicos(parte: Partial<AvisadorDeRenovacaoServicos> = {}): AvisadorDeRenovacaoServicos & { enviados: string[] } {
  const enviados: string[] = [];
  return {
    enviados,
    emailConfigurado: async () => true,
    destinatarios: async () => [
      { email: "a@x.com", locale: null },
      { email: "b@x.com", locale: "es" },
    ],
    enviarEmail: async (_p, para) => {
      enviados.push(para.email);
      return { ok: true };
    },
    ...parte,
  };
}

let estado: Estado;
beforeEach(() => {
  warn.mockReset();
  estado = {
    pendentes: [],
    reservas: {},
    emails: [],
    avisos: [],
    avisosFalhos: [],
    erroAoCriarAviso: new Set(),
  };
});

describe("avisarRenovacoes: os dois canais", () => {
  it("reserva nova: manda o e-mail a cada admin e cria o aviso, gravando o resultado de cada canal", async () => {
    estado.pendentes = [pendente()];
    estado.reservas["org-1"] = { reservaId: "r1", enviarEmail: true, criarAviso: true };
    const servicos = montarServicos();
    const resumo = await avisarRenovacoes({ db: montarDb(estado), servicos });

    expect(servicos.enviados).toEqual(["a@x.com", "b@x.com"]);
    expect(estado.emails).toEqual([{ reserva: "r1", resultado: "enviado", enviados: 2, falhas: 0 }]);
    expect(estado.avisos).toHaveLength(1);
    expect(estado.avisos[0]).toMatchObject({ reserva: "r1", severidade: "info", titulo: "Faltam 30 dias para o fim do seu plano Pro" });
    expect(estado.avisos[0]!.corpo).toContain("06/11/2026");
    expect(resumo).toMatchObject({ avaliados: 1, emailsEnviados: 1, avisosCriados: 1, avisosEncerrados: 2, organizacoesQueFalharam: 0 });
    expect(resumo.avisadosPorMarco).toEqual({ d30: 1, d15: 0, d7: 0, d1: 0, d0: 0 });
  });

  it("a severidade segue o marco: 30 e 15 são info; 7, 1 e o dia são warn", async () => {
    const porMarco: Array<[PendenteDeRenovacao["marco"], string]> = [[30, "info"], [15, "info"], [7, "warn"], [1, "warn"], [0, "warn"]];
    for (const [marco, severidade] of porMarco) {
      estado.avisos = [];
      estado.pendentes = [pendente({ marco })];
      estado.reservas["org-1"] = { reservaId: `r${marco}`, enviarEmail: false, criarAviso: true };
      await avisarRenovacoes({ db: montarDb(estado), servicos: montarServicos() });
      expect(estado.avisos[0]!.severidade, `marco ${marco}`).toBe(severidade);
    }
  });

  it("o título diz os dias REAIS e o dia 1 e o dia 0 têm frase própria", async () => {
    const casos: Array<[number, string]> = [
      [27, "Faltam 27 dias para o fim do seu plano Pro"],
      [1, "Falta 1 dia para o fim do seu plano Pro"],
      [0, "Hoje é o último dia do seu plano Pro"],
    ];
    for (const [dias, titulo] of casos) {
      estado.avisos = [];
      estado.pendentes = [pendente({ diasRestantes: dias, marco: dias === 0 ? 0 : dias === 1 ? 1 : 30 })];
      estado.reservas["org-1"] = { reservaId: "r", enviarEmail: false, criarAviso: true };
      await avisarRenovacoes({ db: montarDb(estado), servicos: montarServicos() });
      expect(estado.avisos[0]!.titulo).toBe(titulo);
    }
  });

  it("o aviso na Central sai no idioma da organização (es)", async () => {
    estado.pendentes = [pendente({ orgLocale: "es", diasRestantes: 7, marco: 7 })];
    estado.reservas["org-1"] = { reservaId: "r", enviarEmail: false, criarAviso: true };
    await avisarRenovacoes({ db: montarDb(estado), servicos: montarServicos() });
    expect(estado.avisos[0]!.titulo).toBe("Faltan 7 días para el fin de tu plan Pro");
    expect(estado.avisos[0]!.corpo).toContain("no se renueva solo");
  });

  it("o texto não inventa preço", async () => {
    estado.pendentes = [pendente()];
    estado.reservas["org-1"] = { reservaId: "r", enviarEmail: false, criarAviso: true };
    await avisarRenovacoes({ db: montarDb(estado), servicos: montarServicos() });
    expect(estado.avisos[0]!.corpo).not.toMatch(/R\$|\d+,\d{2}/);
  });

  it("a reserva só manda cumprir o canal que ainda precisa: só e-mail, ou só aviso", async () => {
    estado.pendentes = [pendente({ organizationId: "org-a" }), pendente({ organizationId: "org-b" })];
    estado.reservas["org-a"] = { reservaId: "ra", enviarEmail: true, criarAviso: false };
    estado.reservas["org-b"] = { reservaId: "rb", enviarEmail: false, criarAviso: true };
    const servicos = montarServicos();
    await avisarRenovacoes({ db: montarDb(estado), servicos });
    expect(estado.emails.map((e) => e.reserva)).toEqual(["ra"]);
    expect(estado.avisos.map((a) => a.reserva)).toEqual(["rb"]);
  });

  it("reserva recusada (o contrato mudou) não envia nada e conta como ignorada", async () => {
    estado.pendentes = [pendente()];
    estado.reservas["org-1"] = null;
    const servicos = montarServicos();
    const resumo = await avisarRenovacoes({ db: montarDb(estado), servicos });
    expect(servicos.enviados).toEqual([]);
    expect(estado.avisos).toEqual([]);
    expect(resumo.ignorados).toBe(1);
  });
});

describe("avisarRenovacoes: e-mail", () => {
  it("e-mail não configurado: registra nao_configurado, não procura destinatário e segue para o aviso", async () => {
    estado.pendentes = [pendente()];
    estado.reservas["org-1"] = { reservaId: "r1", enviarEmail: true, criarAviso: true };
    const destinatarios = vi.fn(async () => []);
    const resumo = await avisarRenovacoes({
      db: montarDb(estado),
      servicos: montarServicos({ emailConfigurado: async () => false, destinatarios }),
    });
    expect(destinatarios).not.toHaveBeenCalled();
    expect(estado.emails).toEqual([{ reserva: "r1", resultado: "nao_configurado", enviados: 0, falhas: 0 }]);
    expect(estado.avisos).toHaveLength(1);
    expect(resumo).toMatchObject({ emailsNaoConfigurados: 1, avisosCriados: 1 });
    expect(resumo.avisadosPorMarco.d30).toBe(1);
  });

  it("sem admin com e-mail: registra sem_destinatario e o aviso na Central sai mesmo assim", async () => {
    estado.pendentes = [pendente()];
    estado.reservas["org-1"] = { reservaId: "r1", enviarEmail: true, criarAviso: true };
    const resumo = await avisarRenovacoes({ db: montarDb(estado), servicos: montarServicos({ destinatarios: async () => [] }) });
    expect(estado.emails[0]).toMatchObject({ resultado: "sem_destinatario", enviados: 0 });
    expect(resumo.emailsSemDestinatario).toBe(1);
    expect(estado.avisos).toHaveLength(1);
  });

  it("um destinatário falha e outro recebe: resultado parcial, contado como enviado", async () => {
    estado.pendentes = [pendente()];
    estado.reservas["org-1"] = { reservaId: "r1", enviarEmail: true, criarAviso: false };
    const resumo = await avisarRenovacoes({
      db: montarDb(estado),
      servicos: montarServicos({ enviarEmail: async (_p, para) => ({ ok: para.email === "a@x.com" }) }),
    });
    expect(estado.emails[0]).toMatchObject({ resultado: "parcial", enviados: 1, falhas: 1 });
    expect(resumo.emailsEnviados).toBe(1);
  });

  it("todos falham ou o envio lança: resultado falhou (a rodada seguinte repete), sem derrubar o aviso", async () => {
    estado.pendentes = [pendente()];
    estado.reservas["org-1"] = { reservaId: "r1", enviarEmail: true, criarAviso: true };
    const resumo = await avisarRenovacoes({
      db: montarDb(estado),
      servicos: montarServicos({
        enviarEmail: async () => {
          throw new Error("smtp caiu");
        },
      }),
    });
    expect(estado.emails[0]).toMatchObject({ resultado: "falhou", enviados: 0, falhas: 2 });
    expect(resumo.emailsQueFalharam).toBe(1);
    expect(estado.avisos).toHaveLength(1);
    expect(resumo.avisadosPorMarco.d30).toBe(1);
  });

  it("falha ao ler os destinatários: nada saiu, resultado falhou, rodada segue", async () => {
    estado.pendentes = [pendente()];
    estado.reservas["org-1"] = { reservaId: "r1", enviarEmail: true, criarAviso: true };
    await avisarRenovacoes({
      db: montarDb(estado),
      servicos: montarServicos({
        destinatarios: async () => {
          throw new Error("auth fora do ar");
        },
      }),
    });
    expect(estado.emails[0]).toMatchObject({ resultado: "falhou", enviados: 0, falhas: 0 });
    expect(estado.avisos).toHaveLength(1);
  });

  it("falha ao gravar o resultado do e-mail não derruba nada e não reenvia", async () => {
    estado.pendentes = [pendente()];
    estado.reservas["org-1"] = { reservaId: "r1", enviarEmail: true, criarAviso: true };
    const db = { ...montarDb(estado), gravarEmail: async () => ({ error: { message: "sem conexão" } }) };
    const servicos = montarServicos();
    await avisarRenovacoes({ db, servicos });
    expect(servicos.enviados).toEqual(["a@x.com", "b@x.com"]);
    expect(estado.avisos).toHaveLength(1);
    expect(warn).toHaveBeenCalled();
  });
});

describe("avisarRenovacoes: isolamento entre organizações", () => {
  it("o aviso que falha vira falhou na linha e não impede o e-mail nem as outras organizações", async () => {
    estado.pendentes = [pendente({ organizationId: "org-a" }), pendente({ organizationId: "org-b" })];
    estado.reservas["org-a"] = { reservaId: "ra", enviarEmail: true, criarAviso: true };
    estado.reservas["org-b"] = { reservaId: "rb", enviarEmail: true, criarAviso: true };
    estado.erroAoCriarAviso.add("ra");
    const resumo = await avisarRenovacoes({ db: montarDb(estado), servicos: montarServicos() });
    expect(estado.avisosFalhos).toEqual(["ra"]);
    expect(estado.emails.map((e) => e.reserva)).toEqual(["ra", "rb"]);
    expect(estado.avisos.map((a) => a.reserva)).toEqual(["rb"]);
    expect(resumo).toMatchObject({ avisosQueFalharam: 1, avisosCriados: 1 });
  });

  it("exceção na reserva de uma organização: conta como falha e a rodada segue", async () => {
    estado.pendentes = [pendente({ organizationId: "org-a" }), pendente({ organizationId: "org-b" })];
    estado.reservas["org-a"] = new Error("lock_timeout");
    estado.reservas["org-b"] = { reservaId: "rb", enviarEmail: false, criarAviso: true };
    const resumo = await avisarRenovacoes({ db: montarDb(estado), servicos: montarServicos() });
    expect(resumo.organizacoesQueFalharam).toBe(1);
    expect(estado.avisos.map((a) => a.reserva)).toEqual(["rb"]);
  });

  it("erro ao listar sobe (sem lista não há rodada), com o texto do banco só na exceção", async () => {
    const db = { ...montarDb(estado), listarPendentes: async () => ({ data: null, error: { message: "relation x" } }) };
    await expect(avisarRenovacoes({ db, servicos: montarServicos() })).rejects.toThrow(/relation x/);
  });

  it("falha ao encerrar avisos antigos não impede os avisos novos", async () => {
    estado.pendentes = [pendente()];
    estado.reservas["org-1"] = { reservaId: "r1", enviarEmail: false, criarAviso: true };
    const db = { ...montarDb(estado), encerrarAvisosDeQuemRenovou: async () => ({ data: null, error: { message: "x" } }) };
    const resumo = await avisarRenovacoes({ db, servicos: montarServicos() });
    expect(resumo.avisosEncerrados).toBe(0);
    expect(estado.avisos).toHaveLength(1);
  });

  it("o tempo da rodada acaba: o que sobrou fica para a próxima, sem reservar", async () => {
    estado.pendentes = [pendente({ organizationId: "org-a" }), pendente({ organizationId: "org-b" }), pendente({ organizationId: "org-c" })];
    estado.reservas["org-a"] = { reservaId: "ra", enviarEmail: false, criarAviso: true };
    let relogio = 0;
    const agora = () => new Date((relogio += 100_000));
    const reservar = vi.fn(async (p: PendenteDeRenovacao) => ({ data: estado.reservas[p.organizationId] as ReservaDeRenovacao | null, error: null }));
    const db = { ...montarDb(estado), reservar };
    const resumo = await avisarRenovacoes({ db, servicos: montarServicos(), agora, orcamentoMs: 250_000 });
    expect(reservar.mock.calls.length).toBeLessThan(3);
    expect(resumo.restantes).toBeGreaterThan(0);
  });
});
