import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MarcaDeSaida } from "@/lib/branding/saida";
import {
  adminsDaOrganizacao,
  ESPERA_ENTRE_TENTATIVAS_EM_MINUTOS,
  enviarFilaDeEmails,
  mascararEmail,
  MAXIMO_DE_TENTATIVAS,
  type DepsDoEnvio,
} from "@/lib/email/conta-e-cobranca/enviar";
import { enfileirarEmailDeConta, type EmailParaEnfileirar } from "@/lib/email/conta-e-cobranca/fila";

import { clienteFalso, criarBancoFalso, type BancoFalso } from "./helpers/banco-de-emails-falso";

/**
 * O envio dos e-mails de conta e de cobrança (`lib/email/conta-e-cobranca/enviar.ts`): o lado de quem esvazia a
 * fila `billing_emails_enviados`. Doubles só nas bordas: o roteador de e-mail (SMTP/Resend), o banco (em
 * memória, com a unicidade e o claim da fila) e a marca. O que se prova é comportamento: enfileira uma vez,
 * envia e marca enviado, falha total volta à fila com espera e acaba em `falhou` na 6ª tentativa, sem
 * configuração nada é queimado, idioma de cada destinatário, cópia do operador e isolamento entre organizações.
 * O claim concorrente de verdade (`for update skip locked`) é provado em Postgres por
 * `tests/invariants/emails-de-conta-e-cobranca-banco.test.ts`.
 */

const logs = vi.hoisted(() => ({ linhas: [] as string[] }));
vi.mock("@/lib/logger", () => {
  const registra = (nivel: string) => (msg: string, ctx?: unknown) => {
    logs.linhas.push(`${nivel} ${msg} ${JSON.stringify(ctx ?? {})}`);
  };
  return {
    logger: { info: registra("info"), warn: registra("warn"), error: registra("error"), debug: registra("debug") },
  };
});

const ORG_A = "0952a000-0000-4000-8000-00000000000a";
const ORG_B = "0952a000-0000-4000-8000-00000000000b";
const MARCA: MarcaDeSaida = {
  nome: "HiperCRM",
  logoUrl: null,
  accent: "#0139B0",
  accentFg: "#ffffff",
  origens: { nome: "padrao", cor: "padrao" },
};
const MINUTO = 60_000;

function mundo(): BancoFalso {
  return criarBancoFalso({
    tabelas: {
      organizations: [
        { id: ORG_A, display_name: "Empresa A", locale: "pt-BR" },
        { id: ORG_B, display_name: "Empresa B", locale: "pt-BR" },
      ],
      user_organizations: [
        { user_id: "a1", organization_id: ORG_A, role: "admin", revoked_at: null, created_at: "1" },
        { user_id: "a2", organization_id: ORG_A, role: "admin", revoked_at: null, created_at: "2" },
        { user_id: "a3", organization_id: ORG_A, role: "agent", revoked_at: null, created_at: "3" },
        { user_id: "a4", organization_id: ORG_A, role: "admin", revoked_at: "2026-01-01", created_at: "4" },
        { user_id: "b1", organization_id: ORG_B, role: "admin", revoked_at: null, created_at: "1" },
      ],
      platform_admins: [
        { user_id: "p1", scope: "full", revoked_at: null },
        { user_id: "p2", scope: "support_readonly", revoked_at: null },
        { user_id: "p3", scope: "full", revoked_at: "2026-01-01" },
      ],
    },
    usuarios: {
      a1: { id: "a1", email: "dono@empresa-a.com.br", user_metadata: { full_name: "Diego Souza" } },
      a2: { id: "a2", email: "socio@empresa-a.com.br", user_metadata: { locale: "es", full_name: "Marta Gil" } },
      a3: { id: "a3", email: "agente@empresa-a.com.br" },
      a4: { id: "a4", email: "ex-admin@empresa-a.com.br" },
      b1: { id: "b1", email: "dono@empresa-b.com.br" },
      p1: { id: "p1", email: "operador@hiperbold.com.br" },
      p2: { id: "p2", email: "suporte-leitura@hiperbold.com.br" },
      p3: { id: "p3", email: "ex-operador@hiperbold.com.br" },
    },
  });
}

interface Cenario {
  banco: BancoFalso;
  enviado: ReturnType<typeof vi.fn>;
  deps: DepsDoEnvio;
  copia: { valor: string | null };
  configurado: { valor: boolean };
  /** O relógio do banco e do código sob teste, o mesmo. */
  relogio: { agora: Date };
  avancar(ms: number): void;
}

function cenario(banco: BancoFalso = mundo()): Cenario {
  const relogio = { agora: new Date("2026-10-08T12:00:00Z") };
  banco.agora = () => relogio.agora;
  const enviado = vi.fn(async (_args: { to: string | string[] }) => ({ ok: true, id: "msg", via: "smtp" as const }));
  const copia = { valor: null as string | null };
  const configurado = { valor: true };
  const deps: DepsDoEnvio = {
    admin: clienteFalso(banco),
    sendEmail: enviado as never,
    emailConfigurado: async () => configurado.valor,
    marcaDaSaida: async () => MARCA,
    appUrl: "https://crm.exemplo.com.br",
    configuracaoDaCopia: async () => copia.valor,
    agora: () => relogio.agora,
  };
  return {
    banco,
    enviado,
    deps,
    copia,
    configurado,
    relogio,
    avancar: (ms) => {
      relogio.agora = new Date(relogio.agora.getTime() + ms);
    },
  };
}

function entrada(extra: Record<string, unknown> = {}): EmailParaEnfileirar {
  return {
    organizationId: ORG_A,
    emailId: "COB-02",
    chave: "pedido:p-1",
    destino: "admins",
    copiaParaOperador: false,
    dados: { plano: "Pro", ciclo: "monthly", forma: { tipo: "cartao" }, acessoAte: "2026-11-30" },
    ...extra,
  } as EmailParaEnfileirar;
}

function enfileirar(c: Cenario, extra: Record<string, unknown> = {}) {
  return enfileirarEmailDeConta(entrada(extra), c.deps.admin);
}

function linhas(c: Cenario) {
  return c.banco.tabelas.billing_emails_enviados!;
}

function destinos(c: Cenario): string[] {
  return c.enviado.mock.calls.map((chamada) => String((chamada[0] as { to: string }).to));
}

beforeEach(() => {
  logs.linhas.length = 0;
});

describe("quem recebe, e em que idioma", () => {
  it("manda aos admins ativos da organização, um e-mail para cada, cada um no idioma dele", async () => {
    const c = cenario();
    await enfileirar(c);
    const r = await enviarFilaDeEmails(c.deps);

    expect(r).toMatchObject({ reservados: 1, enviados: 1, repetir: 0, falhados: 0 });
    expect(destinos(c)).toEqual(["dono@empresa-a.com.br", "socio@empresa-a.com.br"]);
    const [pt, es] = c.enviado.mock.calls.map((x) => x[0] as { subject: string; fromName: string; tags: unknown[] });
    expect(pt?.subject).toBe("Seu plano Pro está ativo");
    expect(es?.subject).toBe("Tu plan Pro está activo");
    expect(pt?.fromName).toBe("HiperCRM");
    expect(pt?.tags).toContainEqual({ name: "tipo", value: "COB-02" });
  });

  it("não manda a agente, a admin revogado nem a admin de outra organização", async () => {
    const c = cenario();
    await enfileirar(c);
    await enviarFilaDeEmails(c.deps);
    const todos = destinos(c).join(" ");
    expect(todos).not.toContain("agente@");
    expect(todos).not.toContain("ex-admin@");
    expect(todos).not.toContain("empresa-b");
  });

  it("com destino criador, só o criador recebe, e o nome dele entra no e-mail", async () => {
    const c = cenario();
    await enfileirarEmailDeConta(
      { organizationId: ORG_A, emailId: "CONTA-06", chave: `organizacao:${ORG_A}`, destino: "criador", criadorUserId: "a1", copiaParaOperador: false, dados: {} },
      c.deps.admin,
    );
    const r = await enviarFilaDeEmails(c.deps);
    expect(r.enviados).toBe(1);
    expect(destinos(c)).toEqual(["dono@empresa-a.com.br"]);
    expect((c.enviado.mock.calls[0]![0] as { subject: string }).subject).toContain("Diego");
  });

  it("o endereço é resolvido na hora do envio: admin que entrou depois de enfileirar também recebe", async () => {
    const c = cenario();
    await enfileirar(c);
    c.banco.tabelas.user_organizations!.push({ user_id: "a5", organization_id: ORG_A, role: "admin", revoked_at: null, created_at: "5" });
    c.banco.usuarios.a5 = { id: "a5", email: "novo@empresa-a.com.br" };
    await enviarFilaDeEmails(c.deps);
    expect(destinos(c)).toContain("novo@empresa-a.com.br");
  });

  it("adminsDaOrganizacao devolve só admins ativos com endereço, no máximo 10", async () => {
    const banco = mundo();
    for (let i = 0; i < 15; i += 1) {
      banco.tabelas.user_organizations!.push({
        user_id: `x${i}`,
        organization_id: ORG_A,
        role: "admin",
        revoked_at: null,
        created_at: `9${i}`,
      });
      banco.usuarios[`x${i}`] = { id: `x${i}`, email: `x${i}@empresa-a.com.br` };
    }
    const lista = await adminsDaOrganizacao(ORG_A, clienteFalso(banco));
    expect(lista.length).toBeLessThanOrEqual(10);
    expect(lista.map((d) => d.email)).toContain("dono@empresa-a.com.br");
    expect(lista.map((d) => d.email)).not.toContain("agente@empresa-a.com.br");
  });
});

describe("a fila: uma vez só por fato", () => {
  it("enfileira uma vez; o replay do mesmo fato não duplica", async () => {
    const c = cenario();
    expect(await enfileirar(c)).toBe("enfileirado");
    expect(await enfileirar(c)).toBe("ja_existia");
    expect(await enfileirar(c)).toBe("ja_existia");
    expect(linhas(c)).toHaveLength(1);
    expect(linhas(c)[0]).toMatchObject({ status: "pendente", tentativas: 0, destino: "admins", copia_para_operador: false });
  });

  it("o envio marca enviado (com a hora) e a rodada seguinte não envia de novo", async () => {
    const c = cenario();
    await enfileirar(c);
    await enviarFilaDeEmails(c.deps);
    expect(linhas(c)[0]).toMatchObject({
      status: "enviado",
      tentativas: 1,
      enviado_em: c.relogio.agora.toISOString(),
      ultimo_erro: null,
    });

    c.enviado.mockClear();
    c.avancar(10 * MINUTO);
    const segunda = await enviarFilaDeEmails(c.deps);
    expect(segunda.reservados).toBe(0);
    expect(c.enviado).not.toHaveBeenCalled();
  });

  it("chave diferente é outro fato, e a mesma chave em outra organização também", async () => {
    const c = cenario();
    await enfileirar(c);
    expect(await enfileirar(c, { chave: "pedido:p-2" })).toBe("enfileirado");
    expect(await enfileirar(c, { organizationId: ORG_B })).toBe("enfileirado");
    expect(linhas(c)).toHaveLength(3);
    const r = await enviarFilaDeEmails(c.deps);
    expect(r).toMatchObject({ reservados: 3, enviados: 3 });
  });

  it("duas rodadas ao mesmo tempo não enviam em dobro (o claim entrega cada linha a uma só)", async () => {
    const c = cenario();
    await enfileirar(c);
    const [a, b] = await Promise.all([enviarFilaDeEmails(c.deps), enviarFilaDeEmails(c.deps)]);
    expect(a.reservados + b.reservados).toBe(1);
    expect(c.enviado).toHaveBeenCalledTimes(2); // os 2 admins, uma vez
  });

  it("grava o resultado por destinatário, com o endereço mascarado", async () => {
    const c = cenario();
    await enfileirar(c);
    await enviarFilaDeEmails(c.deps);
    const resultado = JSON.stringify(linhas(c)[0]!.resultado);
    expect(resultado).toContain("d***@empresa-a.com.br");
    expect(resultado).not.toContain("dono@empresa-a.com.br");
    expect(linhas(c)[0]!.resultado).toMatchObject({ enviados: 2, falhas: 0 });
  });

  it("a fila só guarda dados do fato, nunca o endereço de e-mail de ninguém", async () => {
    const c = cenario();
    await enfileirar(c);
    expect(JSON.stringify(linhas(c))).not.toMatch(/@/);
  });

  it("reserva que venceu (o processo morreu no meio) volta ao lote; reserva viva não", async () => {
    const c = cenario();
    await enfileirar(c);
    // um cron que reservou e morreu: a linha fica enviando por 5 minutos
    await (c.deps.admin as unknown as { rpc: (n: string, a: unknown) => Promise<unknown> }).rpc("fn_billing_emails_reservar_lote", { p_limite: 20 });
    expect(linhas(c)[0]).toMatchObject({ status: "enviando", tentativas: 1 });

    c.avancar(2 * MINUTO);
    expect((await enviarFilaDeEmails(c.deps)).reservados).toBe(0);
    expect(c.enviado).not.toHaveBeenCalled();

    c.avancar(4 * MINUTO);
    const r = await enviarFilaDeEmails(c.deps);
    expect(r).toMatchObject({ reservados: 1, enviados: 1 });
    expect(linhas(c)[0]).toMatchObject({ status: "enviado", tentativas: 2 });
  });

  it("lote pequeno: pega no máximo `limite` linhas por rodada", async () => {
    const c = cenario();
    for (let i = 0; i < 5; i += 1) await enfileirar(c, { chave: `pedido:p-${i}` });
    const r = await enviarFilaDeEmails(c.deps, { limite: 3 });
    expect(r.reservados).toBe(3);
    expect(linhas(c).filter((l) => l.status === "pendente")).toHaveLength(2);
  });
});

describe("falha total: nova tentativa com espera, e no fim `falhou`", () => {
  it("falha total volta a pendente com a espera de 1 minuto e o código do erro; não reenvia antes da hora", async () => {
    const c = cenario();
    await enfileirar(c);
    c.enviado.mockResolvedValue({ ok: false, error: "send_failed", via: "smtp" } as never);
    const r = await enviarFilaDeEmails(c.deps);

    expect(r).toMatchObject({ reservados: 1, enviados: 0, repetir: 1, falhados: 0 });
    expect(linhas(c)[0]).toMatchObject({
      status: "pendente",
      tentativas: 1,
      ultimo_erro: "send_failed",
      proxima_tentativa_em: new Date(c.relogio.agora.getTime() + 1 * MINUTO).toISOString(),
    });

    c.enviado.mockClear();
    c.avancar(30_000);
    expect((await enviarFilaDeEmails(c.deps)).reservados).toBe(0);
    expect(c.enviado).not.toHaveBeenCalled();
  });

  it("na hora marcada tenta de novo e, saindo, fecha como enviado", async () => {
    const c = cenario();
    await enfileirar(c);
    c.enviado.mockResolvedValue({ ok: false, error: "send_failed", via: "smtp" } as never);
    await enviarFilaDeEmails(c.deps);

    c.enviado.mockResolvedValue({ ok: true, id: "m", via: "smtp" } as never);
    c.avancar(1 * MINUTO);
    const r = await enviarFilaDeEmails(c.deps);
    expect(r).toMatchObject({ reservados: 1, enviados: 1 });
    expect(linhas(c)[0]).toMatchObject({ status: "enviado", tentativas: 2, ultimo_erro: null });
  });

  it("a espera cresce (1, 5, 15, 60 e 240 minutos) e a 6ª falha encerra em `falhou`", async () => {
    expect([...ESPERA_ENTRE_TENTATIVAS_EM_MINUTOS]).toEqual([1, 5, 15, 60, 240]);
    expect(MAXIMO_DE_TENTATIVAS).toBe(6);
    const c = cenario();
    await enfileirar(c);
    c.enviado.mockResolvedValue({ ok: false, error: "rate_limited", via: "smtp" } as never);

    for (const espera of ESPERA_ENTRE_TENTATIVAS_EM_MINUTOS) {
      const antes = c.relogio.agora.getTime();
      const r = await enviarFilaDeEmails(c.deps);
      expect(r.repetir).toBe(1);
      expect(Date.parse(String(linhas(c)[0]!.proxima_tentativa_em)) - antes).toBe(espera * MINUTO);
      c.avancar(espera * MINUTO);
    }
    const ultima = await enviarFilaDeEmails(c.deps);
    expect(ultima).toMatchObject({ reservados: 1, falhados: 1, repetir: 0 });
    expect(linhas(c)[0]).toMatchObject({ status: "falhou", tentativas: 6, ultimo_erro: "rate_limited" });

    // `falhou` não volta à fila
    c.enviado.mockClear();
    c.avancar(24 * 60 * MINUTO);
    expect((await enviarFilaDeEmails(c.deps)).reservados).toBe(0);
    expect(c.enviado).not.toHaveBeenCalled();
  });

  it("roteador que lança conta como falha, sem lançar, com log sem o e-mail completo", async () => {
    const c = cenario();
    await enfileirar(c);
    c.enviado.mockRejectedValue(new Error("ECONNRESET dono@empresa-a.com.br"));
    const r = await enviarFilaDeEmails(c.deps);
    expect(r).toMatchObject({ repetir: 1, enviados: 0 });
    expect(linhas(c)[0]).toMatchObject({ status: "pendente", ultimo_erro: "excecao" });
    const log = logs.linhas.join("\n");
    expect(log).not.toContain("dono@empresa-a.com.br");
    expect(log).not.toContain("socio@empresa-a.com.br");
    expect(JSON.stringify(linhas(c))).not.toContain("ECONNRESET");
  });

  it("um destinatário que falha não impede o outro: saiu para alguém, fica enviado (parcial no resultado)", async () => {
    const c = cenario();
    await enfileirar(c);
    c.enviado
      .mockResolvedValueOnce({ ok: false, error: "sender_rejected", via: "smtp" } as never)
      .mockResolvedValueOnce({ ok: true, id: "m", via: "smtp" } as never);
    const r = await enviarFilaDeEmails(c.deps);
    expect(r.enviados).toBe(1);
    expect(linhas(c)[0]).toMatchObject({ status: "enviado" });
    expect(linhas(c)[0]!.resultado).toMatchObject({ enviados: 1, falhas: 1 });
  });

  it("banco que não responde na leitura de destinatários: volta à fila com `excecao`, sem lançar", async () => {
    const c = cenario();
    await enfileirar(c);
    c.banco.falhar.user_organizations = { code: "XX000", message: "boom" };
    const r = await enviarFilaDeEmails(c.deps);
    expect(r.repetir).toBe(1);
    expect(c.enviado).not.toHaveBeenCalled();
    expect(linhas(c)[0]).toMatchObject({ status: "pendente", ultimo_erro: "excecao" });
  });

  it("banco que não responde no claim: lança (a rota responde erro com frase fixa) e nada é enviado", async () => {
    const c = cenario();
    await enfileirar(c);
    c.banco.falharRpc = { code: "42883", message: "function does not exist" };
    await expect(enviarFilaDeEmails(c.deps)).rejects.toThrow("fn_billing_emails_reservar_lote");
    expect(c.enviado).not.toHaveBeenCalled();
  });

  it("e-mail que não monta (dados fora do formato) vira `falhou` na hora, sem tentar de novo", async () => {
    const c = cenario();
    await enfileirar(c);
    linhas(c)[0]!.dados = { plano: "Pro" }; // faltam ciclo, forma e acessoAte
    const r = await enviarFilaDeEmails(c.deps);
    expect(r).toMatchObject({ falhados: 1, repetir: 0 });
    expect(linhas(c)[0]).toMatchObject({ status: "falhou", ultimo_erro: "montagem" });
    expect(c.enviado).not.toHaveBeenCalled();
  });

  it("código de e-mail desconhecido vira `falhou` na hora", async () => {
    const c = cenario();
    await enfileirar(c);
    linhas(c)[0]!.email_id = "ZZZ-99";
    await enviarFilaDeEmails(c.deps);
    expect(linhas(c)[0]).toMatchObject({ status: "falhou", ultimo_erro: "montagem" });
  });
});

describe("sem configuração de e-mail nada é queimado", () => {
  it("sem SMTP nem Resend a rodada não reserva nada: status, tentativas e hora ficam como estavam", async () => {
    const c = cenario();
    await enfileirar(c);
    const antes = JSON.stringify(linhas(c));
    c.configurado.valor = false;
    const r = await enviarFilaDeEmails(c.deps);
    expect(r).toMatchObject({ naoConfigurado: true, reservados: 0 });
    expect(JSON.stringify(linhas(c))).toBe(antes);

    c.configurado.valor = true;
    expect((await enviarFilaDeEmails(c.deps)).enviados).toBe(1);
  });

  it("configuração que some no meio da rodada (o roteador diz not_configured) devolve a linha sem gastar tentativa", async () => {
    const c = cenario();
    await enfileirar(c);
    c.enviado.mockResolvedValue({ ok: false, error: "not_configured" } as never);
    const r = await enviarFilaDeEmails(c.deps);
    expect(r).toMatchObject({ naoConfigurado: true, devolvidos: 1, repetir: 0 });
    expect(linhas(c)[0]).toMatchObject({ status: "pendente", tentativas: 0, ultimo_erro: "nao_configurado" });
  });
});

describe("sem destinatário", () => {
  it("organização sem admin com e-mail: `sem_destinatario`, sem enviar e sem voltar à fila", async () => {
    const banco = mundo();
    banco.tabelas.user_organizations = [];
    const c = cenario(banco);
    await enfileirar(c);
    const r = await enviarFilaDeEmails(c.deps);
    expect(r).toMatchObject({ semDestinatario: 1, enviados: 0 });
    expect(linhas(c)[0]).toMatchObject({ status: "sem_destinatario" });
    expect(c.enviado).not.toHaveBeenCalled();
    c.avancar(24 * 60 * MINUTO);
    expect((await enviarFilaDeEmails(c.deps)).reservados).toBe(0);
  });
});

describe("orçamento de tempo da rodada", () => {
  it("estourado o orçamento, as linhas que não começaram voltam à fila sem gastar tentativa", async () => {
    const c = cenario();
    for (const n of [1, 2, 3]) {
      await enfileirarEmailDeConta(
        { organizationId: ORG_A, emailId: "CONTA-06", chave: `organizacao:${n}`, destino: "criador", criadorUserId: "a1", copiaParaOperador: false, dados: {} },
        c.deps.admin,
      );
    }
    // cada envio leva 25 s; o orçamento é de 40 s: a 3ª linha já não começa
    c.enviado.mockImplementation(async () => {
      c.avancar(25_000);
      return { ok: true, id: "m", via: "smtp" as const };
    });
    const r = await enviarFilaDeEmails(c.deps, { orcamentoMs: 40_000 });

    expect(r).toMatchObject({ reservados: 3, enviados: 2, devolvidos: 1 });
    const pendente = linhas(c).filter((l) => l.status === "pendente");
    expect(pendente).toHaveLength(1);
    expect(pendente[0]).toMatchObject({ tentativas: 0 });

    // a rodada seguinte termina o serviço
    c.enviado.mockImplementation(async () => ({ ok: true, id: "m", via: "smtp" as const }));
    expect((await enviarFilaDeEmails(c.deps)).enviados).toBe(1);
    expect(linhas(c).every((l) => l.status === "enviado")).toBe(true);
  });
});

describe("cópia para o operador", () => {
  it("vai para o e-mail configurado, com a faixa no topo e o assunto prefixado; o cliente não vê a faixa", async () => {
    const c = cenario();
    c.copia.valor = "dono-da-instalacao@hiperbold.com.br";
    await enfileirar(c, { copiaParaOperador: true });
    await enviarFilaDeEmails(c.deps);

    const chamadas = c.enviado.mock.calls.map((x) => x[0] as { to: string; subject: string; html: string; text: string });
    const doCliente = chamadas.filter((x) => x.to.endsWith("@empresa-a.com.br"));
    const doOperador = chamadas.filter((x) => x.to === "dono-da-instalacao@hiperbold.com.br");

    expect(doOperador).toHaveLength(1);
    expect(doOperador[0]?.subject).toBe("[Cópia] Seu plano Pro está ativo");
    expect(doOperador[0]?.html).toContain("Cópia para o operador: enviado aos admins da Empresa A");
    expect(doOperador[0]?.text).toContain("Cópia para o operador: enviado aos admins da Empresa A");
    expect(doCliente).toHaveLength(2);
    for (const m of doCliente) {
      expect(m.subject.startsWith("[Cópia]")).toBe(false);
      expect(m.html).not.toContain("Cópia para o operador");
    }
  });

  it("aceita vários endereços e ignora o que não é endereço", async () => {
    const c = cenario();
    c.copia.valor = "um@hiperbold.com.br, nao-e-email; dois@hiperbold.com.br";
    await enfileirar(c, { copiaParaOperador: true });
    await enviarFilaDeEmails(c.deps);
    const para = destinos(c);
    expect(para).toContain("um@hiperbold.com.br");
    expect(para).toContain("dois@hiperbold.com.br");
    expect(para.join(" ")).not.toContain("nao-e-email");
  });

  it("com a configuração vazia, cai nos admins da plataforma (escopo full, não revogados)", async () => {
    const c = cenario();
    c.copia.valor = "   ";
    await enfileirar(c, { copiaParaOperador: true });
    await enviarFilaDeEmails(c.deps);
    const para = destinos(c);
    expect(para).toContain("operador@hiperbold.com.br");
    expect(para).not.toContain("suporte-leitura@hiperbold.com.br");
    expect(para).not.toContain("ex-operador@hiperbold.com.br");
  });

  it("sem cópia pedida, o operador não recebe nada", async () => {
    const c = cenario();
    c.copia.valor = "dono-da-instalacao@hiperbold.com.br";
    await enfileirar(c, { copiaParaOperador: false });
    await enviarFilaDeEmails(c.deps);
    expect(destinos(c)).not.toContain("dono-da-instalacao@hiperbold.com.br");
    expect(destinos(c)).toHaveLength(2);
  });

  it("a cópia sai em português e um envio por endereço (um não vê o endereço do outro)", async () => {
    const c = cenario();
    c.copia.valor = "um@hiperbold.com.br,dois@hiperbold.com.br";
    await enfileirar(c, { copiaParaOperador: true });
    await enviarFilaDeEmails(c.deps);
    const copias = c.enviado.mock.calls
      .map((x) => x[0] as { to: string | string[]; subject: string })
      .filter((x) => x.subject.startsWith("[Cópia]"));
    expect(copias).toHaveLength(2);
    for (const m of copias) {
      expect(typeof m.to).toBe("string");
      expect(m.subject).toBe("[Cópia] Seu plano Pro está ativo");
    }
  });

  it("quem já recebeu o original (o operador é admin do cliente) não recebe a cópia também", async () => {
    const c = cenario();
    c.copia.valor = "DONO@empresa-a.com.br";
    await enfileirar(c, { copiaParaOperador: true });
    await enviarFilaDeEmails(c.deps);
    expect(destinos(c)).toHaveLength(2);
  });

  it("a cópia só sai quando o e-mail saiu para o cliente: a nova tentativa de uma falha total não repete a cópia", async () => {
    const c = cenario();
    c.copia.valor = "operador@hiperbold.com.br";
    await enfileirar(c, { copiaParaOperador: true });
    c.enviado.mockResolvedValue({ ok: false, error: "send_failed", via: "smtp" } as never);
    await enviarFilaDeEmails(c.deps);
    expect(destinos(c)).not.toContain("operador@hiperbold.com.br");

    c.enviado.mockClear();
    c.enviado.mockResolvedValue({ ok: true, id: "m", via: "smtp" } as never);
    c.avancar(1 * MINUTO);
    await enviarFilaDeEmails(c.deps);
    expect(destinos(c).filter((d) => d === "operador@hiperbold.com.br")).toHaveLength(1);
  });

  it("não vaza uma organização para a outra: a cópia da A não cita nada da B, nem o endereço dos admins", async () => {
    const c = cenario();
    c.copia.valor = "operador@hiperbold.com.br";
    await enfileirar(c, { copiaParaOperador: true });
    await enfileirar(c, { organizationId: ORG_B, copiaParaOperador: true });
    await enviarFilaDeEmails(c.deps);

    const mensagens = c.enviado.mock.calls.map((x) => x[0] as { to: string; subject: string; html: string; text: string });
    const paraB = mensagens.filter((m) => m.to === "dono@empresa-b.com.br");
    expect(paraB).toHaveLength(1);
    const copiaDaA = mensagens.filter((m) => m.to === "operador@hiperbold.com.br" && m.html.includes("Empresa A"))[0]!;
    expect(copiaDaA.html).toContain("Empresa A");
    expect(copiaDaA.html).not.toContain("Empresa B");
    for (const endereco of ["dono@empresa-a", "socio@empresa-a", "dono@empresa-b"]) {
      expect(copiaDaA.html).not.toContain(endereco);
      expect(copiaDaA.text).not.toContain(endereco);
    }
    const doCliente = (org: string) => mensagens.filter((m) => m.to.endsWith(`@${org}.com.br`));
    expect(doCliente("empresa-a").every((m) => !m.html.includes("Empresa B"))).toBe(true);
    expect(doCliente("empresa-b").every((m) => !m.html.includes("Empresa A"))).toBe(true);
  });

  it("falha na cópia não derruba o envio ao cliente", async () => {
    const c = cenario();
    c.copia.valor = null;
    c.banco.falhar.platform_admins = { code: "XX000", message: "boom" };
    await enfileirar(c, { copiaParaOperador: true });
    const r = await enviarFilaDeEmails(c.deps);
    expect(r).toMatchObject({ enviados: 1, repetir: 0 });
    expect(linhas(c)[0]).toMatchObject({ status: "enviado" });
  });
});

describe("a marca da cópia ao operador é a da instalação", () => {
  it("o cliente recebe com a marca da organização; a cópia sai com a marca da instalação (nome do remetente e corpo)", async () => {
    const c = cenario();
    c.copia.valor = "operador@hiperbold.com.br";
    const pedidas: Array<string | null> = [];
    c.deps.marcaDaSaida = async (organizationId) => {
      pedidas.push(organizationId);
      return organizationId === null
        ? { ...MARCA, nome: "Marca da Instalacao" }
        : { ...MARCA, nome: "Marca do Cliente Revendedor" };
    };
    await enfileirar(c, { copiaParaOperador: true });
    await enviarFilaDeEmails(c.deps);

    const mensagens = c.enviado.mock.calls.map(
      (x) => x[0] as { to: string; fromName: string; html: string; text: string },
    );
    const doCliente = mensagens.filter((m) => m.to.endsWith("@empresa-a.com.br"));
    const copia = mensagens.filter((m) => m.to === "operador@hiperbold.com.br");
    expect(doCliente).toHaveLength(2);
    expect(copia).toHaveLength(1);
    for (const m of doCliente) {
      expect(m.fromName).toBe("Marca do Cliente Revendedor");
      expect(m.html).toContain("Marca do Cliente Revendedor");
      expect(m.html).not.toContain("Marca da Instalacao");
    }
    expect(copia[0]?.fromName).toBe("Marca da Instalacao");
    expect(copia[0]?.html).toContain("Marca da Instalacao");
    expect(copia[0]?.html).not.toContain("Marca do Cliente Revendedor");
    expect(copia[0]?.text).not.toContain("Marca do Cliente Revendedor");
    expect(pedidas).toContain(null);
    expect(pedidas).toContain(ORG_A);
  });
});

describe("conta banida ou apagada não recebe e-mail", () => {
  const FUTURO = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
  const PASSADO = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();

  it("admin da organização com banned_until no futuro ou deleted_at preenchido fica de fora", async () => {
    const banco = mundo();
    banco.usuarios.a1 = { ...banco.usuarios.a1!, banned_until: FUTURO };
    banco.usuarios.a2 = { ...banco.usuarios.a2!, deleted_at: "2026-09-01T00:00:00Z" };
    const c = cenario(banco);
    await enfileirar(c);
    const r = await enviarFilaDeEmails(c.deps);
    expect(r.semDestinatario).toBe(1);
    expect(destinos(c)).toEqual([]);
    expect(linhas(c)[0]).toMatchObject({ status: "sem_destinatario" });
  });

  it("ban que já terminou (banned_until no passado) não impede o envio", async () => {
    const banco = mundo();
    banco.usuarios.a1 = { ...banco.usuarios.a1!, banned_until: PASSADO };
    const c = cenario(banco);
    await enfileirar(c);
    await enviarFilaDeEmails(c.deps);
    expect(destinos(c)).toContain("dono@empresa-a.com.br");
  });

  it("destino criador: criador banido não recebe", async () => {
    const banco = mundo();
    banco.usuarios.a1 = { ...banco.usuarios.a1!, banned_until: FUTURO };
    const c = cenario(banco);
    await enfileirar(c, { destino: "criador", criadorUserId: "a1" });
    const r = await enviarFilaDeEmails(c.deps);
    expect(r.semDestinatario).toBe(1);
    expect(destinos(c)).toEqual([]);
  });

  it("fallback dos admins da plataforma: operador banido ou apagado não recebe a cópia", async () => {
    const banco = mundo();
    banco.usuarios.p1 = { ...banco.usuarios.p1!, banned_until: FUTURO };
    const c = cenario(banco);
    c.copia.valor = null;
    await enfileirar(c, { copiaParaOperador: true });
    await enviarFilaDeEmails(c.deps);
    expect(destinos(c)).not.toContain("operador@hiperbold.com.br");

    const banco2 = mundo();
    banco2.usuarios.p1 = { ...banco2.usuarios.p1!, deleted_at: "2026-09-01T00:00:00Z" };
    const c2 = cenario(banco2);
    c2.copia.valor = null;
    await enfileirar(c2, { copiaParaOperador: true });
    await enviarFilaDeEmails(c2.deps);
    expect(destinos(c2)).not.toContain("operador@hiperbold.com.br");
  });

  it("adminsDaOrganizacao pula a conta banida e mantém as demais", async () => {
    const banco = mundo();
    banco.usuarios.a1 = { ...banco.usuarios.a1!, banned_until: FUTURO };
    const lista = await adminsDaOrganizacao(ORG_A, clienteFalso(banco));
    expect(lista.map((d) => d.email)).toEqual(["socio@empresa-a.com.br"]);
  });
});

describe("enfileirar nunca derruba quem chamou", () => {
  it("banco que erra ao gravar: devolve `falhou`, sem lançar", async () => {
    const c = cenario();
    c.banco.falhar.billing_emails_enviados = { code: "42P01", message: "relation does not exist" };
    expect(await enfileirar(c)).toBe("falhou");
  });

  it("cliente que lança: devolve `falhou`, sem lançar", async () => {
    const quebrado = {
      from: () => {
        throw new Error("sem conexão");
      },
    } as never;
    expect(await enfileirarEmailDeConta(entrada(), quebrado)).toBe("falhou");
  });

  it("dados fora do formato, destino criador sem criador e código desconhecido não entram na fila", async () => {
    const c = cenario();
    expect(await enfileirar(c, { dados: { plano: "Pro" } })).toBe("falhou");
    expect(await enfileirar(c, { destino: "criador" })).toBe("falhou");
    expect(await enfileirar(c, { emailId: "ZZZ-99" })).toBe("falhou");
    expect(linhas(c)).toHaveLength(0);
  });
});

describe("uma linha nunca passa do tempo da reserva", () => {
  function mundoComTresAdmins(): BancoFalso {
    const banco = mundo();
    banco.tabelas.user_organizations!.push({ user_id: "a6", organization_id: ORG_A, role: "admin", revoked_at: null, created_at: "6" });
    banco.usuarios.a6 = { id: "a6", email: "terceiro@empresa-a.com.br" };
    return banco;
  }

  it("o orçamento acaba entre dois destinatários: grava quem recebeu, devolve a linha e a próxima rodada só envia ao que falta", async () => {
    const c = cenario(mundoComTresAdmins());
    await enfileirar(c);
    // cada envio leva 25 s e o orçamento é de 40 s: o 3º destinatário já não começa nesta rodada
    c.enviado.mockImplementation(async () => {
      c.avancar(25_000);
      return { ok: true, id: "m", via: "smtp" as const };
    });
    const r1 = await enviarFilaDeEmails(c.deps, { orcamentoMs: 40_000 });

    expect(destinos(c)).toEqual(["dono@empresa-a.com.br", "socio@empresa-a.com.br"]);
    expect(r1).toMatchObject({ reservados: 1, enviados: 0, devolvidos: 1 });
    expect(linhas(c)[0]).toMatchObject({ status: "pendente", tentativas: 0 });
    expect(linhas(c)[0]!.resultado).toMatchObject({ enviados: 2, falhas: 0 });
    expect(JSON.stringify(linhas(c))).not.toMatch(/(dono|socio|terceiro)@/);

    c.enviado.mockClear();
    c.enviado.mockImplementation(async () => ({ ok: true, id: "m", via: "smtp" as const }));
    const r2 = await enviarFilaDeEmails(c.deps, { orcamentoMs: 40_000 });

    // quem já recebeu não recebe de novo
    expect(destinos(c)).toEqual(["terceiro@empresa-a.com.br"]);
    expect(r2).toMatchObject({ reservados: 1, enviados: 1 });
    expect(linhas(c)[0]).toMatchObject({ status: "enviado" });
    expect(linhas(c)[0]!.resultado).toMatchObject({ enviados: 3, falhas: 0 });
  });

  it("endereços que mascaram igual (j***@dominio) não se confundem: quem falta ainda recebe", async () => {
    const banco = mundoComTresAdmins();
    banco.usuarios.a1 = { id: "a1", email: "joao@empresa-a.com.br" };
    banco.usuarios.a2 = { id: "a2", email: "jose@empresa-a.com.br" };
    const c = cenario(banco);
    await enfileirar(c);
    c.enviado.mockImplementation(async () => {
      c.avancar(25_000);
      return { ok: true, id: "m", via: "smtp" as const };
    });
    await enviarFilaDeEmails(c.deps, { orcamentoMs: 20_000 });
    expect(destinos(c)).toEqual(["joao@empresa-a.com.br"]);

    c.enviado.mockClear();
    c.enviado.mockImplementation(async () => ({ ok: true, id: "m", via: "smtp" as const }));
    await enviarFilaDeEmails(c.deps);
    expect(destinos(c).sort()).toEqual(["jose@empresa-a.com.br", "terceiro@empresa-a.com.br"]);
  });

  it("o primeiro destinatário da rodada sempre sai, mesmo com orçamento curto: a linha avança", async () => {
    const c = cenario();
    await enfileirar(c);
    c.enviado.mockImplementation(async () => {
      c.avancar(60_000);
      return { ok: true, id: "m", via: "smtp" as const };
    });
    await enviarFilaDeEmails(c.deps, { orcamentoMs: 1_000 });
    expect(destinos(c)).toEqual(["dono@empresa-a.com.br"]);
    expect(linhas(c)[0]).toMatchObject({ status: "pendente" });
  });

  it("a gravação atrasada de uma rodada antiga não sobrescreve a da rodada que pegou a linha depois", async () => {
    const c = cenario();
    await enfileirar(c);
    // durante o envio da rodada 1, outra rodada pega a linha (a reserva venceu)
    c.enviado.mockImplementationOnce(async () => {
      const l = linhas(c)[0]!;
      Object.assign(l, { status: "enviando", tentativas: 2, resultado: { dona: "rodada-2" } });
      return { ok: true, id: "m", via: "smtp" as const };
    });
    await enviarFilaDeEmails(c.deps);

    // a gravação "enviado" da rodada 1 (tentativas = 1) não casa com a linha da rodada 2 (tentativas = 2)
    expect(linhas(c)[0]).toMatchObject({ status: "enviando", tentativas: 2, resultado: { dona: "rodada-2" } });
  });
});

describe("destino criador exige vínculo ativo com a organização do fato", () => {
  async function pedirAoCriador(c: Cenario, criadorUserId: string) {
    await enfileirarEmailDeConta(
      { organizationId: ORG_A, emailId: "CONTA-06", chave: `organizacao:${criadorUserId}`, destino: "criador", criadorUserId, copiaParaOperador: false, dados: {} },
      c.deps.admin,
    );
    return enviarFilaDeEmails(c.deps);
  }

  it("vínculo ativo na organização: recebe", async () => {
    const c = cenario();
    expect(await pedirAoCriador(c, "a1")).toMatchObject({ enviados: 1, semDestinatario: 0 });
    expect(destinos(c)).toEqual(["dono@empresa-a.com.br"]);
  });

  it("vínculo revogado: sem_destinatario, nada enviado", async () => {
    const c = cenario();
    expect(await pedirAoCriador(c, "a4")).toMatchObject({ enviados: 0, semDestinatario: 1 });
    expect(linhas(c)[0]).toMatchObject({ status: "sem_destinatario" });
    expect(c.enviado).not.toHaveBeenCalled();
  });

  it("usuário de outra organização ou sem nenhum vínculo: sem_destinatario", async () => {
    const c = cenario();
    expect(await pedirAoCriador(c, "b1")).toMatchObject({ semDestinatario: 1 });
    c.banco.usuarios.solto = { id: "solto", email: "solto@fora.com.br" };
    expect(await pedirAoCriador(c, "solto")).toMatchObject({ semDestinatario: 1 });
    expect(c.enviado).not.toHaveBeenCalled();
  });

  it("banco que recusa a leitura do vínculo: volta à fila com `excecao`, sem enviar", async () => {
    const c = cenario();
    c.banco.falhar.user_organizations = { code: "XX000", message: "banco fora" };
    expect(await pedirAoCriador(c, "a1")).toMatchObject({ repetir: 1, enviados: 0 });
    expect(linhas(c)[0]).toMatchObject({ status: "pendente", ultimo_erro: "excecao" });
    expect(c.enviado).not.toHaveBeenCalled();
  });
});

describe("endereço sem confirmação não recebe e-mail", () => {
  it("admins com e-mail não confirmado ficam de fora; os confirmados recebem", async () => {
    const banco = mundo();
    banco.usuarios.a1 = { ...banco.usuarios.a1!, email_confirmed_at: null };
    const c = cenario(banco);
    await enfileirar(c);
    await enviarFilaDeEmails(c.deps);
    expect(destinos(c)).toEqual(["socio@empresa-a.com.br"]);
  });

  it("nenhum admin com endereço confirmado: sem_destinatario", async () => {
    const banco = mundo();
    banco.usuarios.a1 = { ...banco.usuarios.a1!, email_confirmed_at: null };
    banco.usuarios.a2 = { ...banco.usuarios.a2!, email_confirmed_at: null };
    const c = cenario(banco);
    await enfileirar(c);
    const r = await enviarFilaDeEmails(c.deps);
    expect(r).toMatchObject({ semDestinatario: 1, enviados: 0 });
    expect(linhas(c)[0]).toMatchObject({ status: "sem_destinatario" });
    expect(c.enviado).not.toHaveBeenCalled();
  });

  it("destino criador com e-mail não confirmado: sem_destinatario", async () => {
    const banco = mundo();
    banco.usuarios.a1 = { ...banco.usuarios.a1!, email_confirmed_at: null };
    const c = cenario(banco);
    await enfileirar(c, { destino: "criador", criadorUserId: "a1", emailId: "CONTA-06", chave: "organizacao:x", dados: {} });
    expect(await enviarFilaDeEmails(c.deps)).toMatchObject({ semDestinatario: 1 });
    expect(c.enviado).not.toHaveBeenCalled();
  });

  it("fallback dos admins da plataforma: operador com e-mail não confirmado não recebe a cópia", async () => {
    const banco = mundo();
    banco.usuarios.p1 = { ...banco.usuarios.p1!, email_confirmed_at: null };
    const c = cenario(banco);
    c.copia.valor = null;
    await enfileirar(c, { copiaParaOperador: true });
    await enviarFilaDeEmails(c.deps);
    expect(destinos(c)).not.toContain("operador@hiperbold.com.br");
    expect(destinos(c)).toContain("dono@empresa-a.com.br");
  });
});

describe("o botão do COB-05 só aceita a fatura do Asaas", () => {
  function corpoDoPrimeiroEnvio(c: Cenario): string {
    const m = c.enviado.mock.calls[0]![0] as unknown as { text: string; html: string };
    return `${m.text}\n${m.html}`;
  }
  const dados = (faturaUrl: string | null) => ({ plano: "Pro", valor: 34900, acessoAte: "2026-11-07", faturaUrl });

  it("fatura em https no domínio do Asaas vira o botão", async () => {
    const c = cenario();
    await enfileirar(c, { emailId: "COB-05", chave: "pagamento:ok", dados: dados("https://www.asaas.com/i/abc123") });
    await enviarFilaDeEmails(c.deps);
    expect(corpoDoPrimeiroEnvio(c)).toContain("https://www.asaas.com/i/abc123");
  });

  it("dados antigos ou mexidos (http, outro host, host parecido): o botão leva à tela do plano", async () => {
    for (const [i, ruim] of ["http://www.asaas.com/i/1", "https://phishing.example.com/i/1", "https://asaas.com.evil.example/i/1", "javascript:alert(1)"].entries()) {
      const c = cenario();
      await enfileirar(c, { emailId: "COB-05", chave: `pagamento:ruim${i}`, dados: dados(ruim) });
      await enviarFilaDeEmails(c.deps);
      const corpo = corpoDoPrimeiroEnvio(c);
      expect(corpo).not.toContain(ruim);
      expect(corpo).toContain("https://crm.exemplo.com.br/app/settings/plano");
    }
  });
});

describe("mascararEmail", () => {
  it("guarda a primeira letra e o domínio", () => {
    expect(mascararEmail("diego@empresa.com.br")).toBe("d***@empresa.com.br");
  });
});
