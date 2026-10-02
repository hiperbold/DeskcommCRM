/**
 * D-115: lembrete de agenda sem duplicar e pelo canal certo.
 *
 * O banco aqui é um dublê em memória que APLICA os filtros (eq, is, in) de
 * verdade, inclusive a igualdade de array do compare-and-swap: o que se prova é
 * o comportamento de duas rodadas disputando a mesma linha, não a forma da
 * chamada.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import {
  canalDoLembrete,
  fusoDoLembrete,
  liberarReserva,
  organizacaoPodeReceberLembrete,
  reservarDegraus,
} from "@/lib/agenda/lembrete-guardas";

type Linha = Record<string, unknown>;

/** `{1440,180}` do PostgREST vira `[1440, 180]` para comparar com o valor gravado. */
function comoValor(v: unknown): unknown {
  if (typeof v === "string" && /^\{.*\}$/.test(v)) {
    const miolo = v.slice(1, -1);
    return miolo === "" ? [] : miolo.split(",").map(Number);
  }
  return v;
}

function bancoEmMemoria(tabelas: Record<string, Linha[]>, opts: { falharUpdate?: boolean } = {}) {
  return {
    from(nome: string) {
      const linhas = tabelas[nome];
      if (!linhas) throw new Error(`tabela inesperada: ${nome}`);
      const filtros: Array<(l: Linha) => boolean> = [];
      let patch: Linha | null = null;
      let ordem: { col: string; asc: boolean } | null = null;
      let teto = Infinity;
      const q = {
        select: () => q,
        update: (p: Linha) => {
          patch = p;
          return q;
        },
        eq: (col: string, v: unknown) => {
          filtros.push((l) => JSON.stringify(l[col]) === JSON.stringify(comoValor(v)));
          return q;
        },
        is: (col: string, v: null) => {
          filtros.push((l) => (l[col] ?? null) === v);
          return q;
        },
        in: (col: string, vs: unknown[]) => {
          filtros.push((l) => vs.includes(l[col]));
          return q;
        },
        order: (col: string, o: { ascending: boolean }) => {
          ordem = { col, asc: o.ascending };
          return q;
        },
        limit: (n: number) => {
          teto = n;
          return q;
        },
        then: (res: (v: unknown) => unknown) => {
          if (patch && opts.falharUpdate) return res({ data: null, error: { message: "falhou" } });
          let achadas = linhas.filter((l) => filtros.every((f) => f(l)));
          if (patch) {
            for (const l of achadas) Object.assign(l, patch);
            return res({ data: achadas.map((l) => ({ id: l.id })), error: null });
          }
          if (ordem) {
            const { col, asc } = ordem;
            achadas = [...achadas].sort((a, b) => {
              const x = String(a[col] ?? "");
              const y = String(b[col] ?? "");
              return asc ? x.localeCompare(y) : y.localeCompare(x);
            });
          }
          return res({ data: achadas.slice(0, teto), error: null });
        },
      };
      return q;
    },
  } as never;
}

const ORG = "org-1";

describe("D-115: reserva do degrau antes do envio", () => {
  it("duas rodadas que leram a mesma linha: só uma reserva, a outra não envia", async () => {
    const compromissos = [{ id: "a1", organization_id: ORG, reminder_sent_offsets_minutes: null, reminder_sent_at: null }];
    const admin = bancoEmMemoria({ calendar_appointments: compromissos });
    const reserva = { appointmentId: "a1", organizationId: ORG, lidos: null, pendentes: [60] };

    const primeira = await reservarDegraus(admin, reserva);
    const segunda = await reservarDegraus(admin, reserva);

    expect(primeira.reservado).toBe(true);
    expect(segunda.reservado).toBe(false);
    expect(compromissos[0]!.reminder_sent_offsets_minutes).toEqual([60]);
    expect(compromissos[0]!.reminder_sent_at).not.toBeNull();
  });

  it("com degrau já enviado: o compare-and-swap vale sobre o array lido", async () => {
    const compromissos = [{ id: "a1", organization_id: ORG, reminder_sent_offsets_minutes: [1440], reminder_sent_at: "x" }];
    const admin = bancoEmMemoria({ calendar_appointments: compromissos });
    const reserva = { appointmentId: "a1", organizationId: ORG, lidos: [1440], pendentes: [180] };

    expect((await reservarDegraus(admin, reserva)).reservado).toBe(true);
    expect(compromissos[0]!.reminder_sent_offsets_minutes).toEqual([1440, 180]);
    expect((await reservarDegraus(admin, reserva)).reservado).toBe(false);
  });

  it("outra organização com o mesmo id de compromisso não é tocada", async () => {
    const compromissos = [{ id: "a1", organization_id: "outra", reminder_sent_offsets_minutes: null }];
    const admin = bancoEmMemoria({ calendar_appointments: compromissos });
    const r = await reservarDegraus(admin, { appointmentId: "a1", organizationId: ORG, lidos: null, pendentes: [60] });
    expect(r.reservado).toBe(false);
    expect(compromissos[0]!.reminder_sent_offsets_minutes).toBeNull();
  });

  it("erro no update NÃO libera o envio (falha fechada)", async () => {
    const admin = bancoEmMemoria(
      { calendar_appointments: [{ id: "a1", organization_id: ORG, reminder_sent_offsets_minutes: null }] },
      { falharUpdate: true },
    );
    const r = await reservarDegraus(admin, { appointmentId: "a1", organizationId: ORG, lidos: null, pendentes: [60] });
    expect(r.reservado).toBe(false);
  });

  it("liberar devolve o degrau para a próxima rodada, mas não pisa em rodada que veio depois", async () => {
    const compromissos = [{ id: "a1", organization_id: ORG, reminder_sent_offsets_minutes: null, reminder_sent_at: null }];
    const admin = bancoEmMemoria({ calendar_appointments: compromissos });
    const reserva = { appointmentId: "a1", organizationId: ORG, lidos: null, pendentes: [60] };

    const { gravados } = await reservarDegraus(admin, reserva);
    await liberarReserva(admin, reserva, gravados);
    expect(compromissos[0]!.reminder_sent_offsets_minutes).toBeNull();

    // Outra rodada reservou depois: a liberação da primeira não desfaz a dela.
    compromissos[0]!.reminder_sent_offsets_minutes = [60, 30] as never;
    await liberarReserva(admin, reserva, gravados);
    expect(compromissos[0]!.reminder_sent_offsets_minutes).toEqual([60, 30]);
  });
});

describe("D-115: o canal do lembrete", () => {
  const sessoes = [
    { id: "voz", organization_id: ORG, provider: "wacalls", status: "WORKING", created_at: "2026-01-01" },
    { id: "zap-a", organization_id: ORG, provider: "uazapi", status: "WORKING", created_at: "2026-01-02" },
    { id: "zap-b", organization_id: ORG, provider: "uazapi", status: "WORKING", created_at: "2026-01-03" },
    { id: "zap-off", organization_id: ORG, provider: "uazapi", status: "STOPPED", created_at: "2026-01-04" },
  ];

  it("sai pelo número em que o contato já conversa, não pelo primeiro da organização", async () => {
    const admin = bancoEmMemoria({
      conversations: [{ organization_id: ORG, contact_id: "c1", channel_session_id: "zap-b", last_message_at: "2026-02-01" }],
      channel_sessions: sessoes.map((s) => ({ ...s })),
    });
    expect(await canalDoLembrete(admin, ORG, "c1")).toBe("zap-b");
  });

  it("nunca escolhe linha de voz, mesmo que seja a conversa mais recente", async () => {
    const admin = bancoEmMemoria({
      conversations: [{ organization_id: ORG, contact_id: "c1", channel_session_id: "voz", last_message_at: "2026-03-01" }],
      channel_sessions: sessoes.map((s) => ({ ...s })),
    });
    expect(await canalDoLembrete(admin, ORG, "c1")).not.toBe("voz");
  });

  it("canal da conversa fora do ar: cai para outro canal vivo de mensagem", async () => {
    const admin = bancoEmMemoria({
      conversations: [{ organization_id: ORG, contact_id: "c1", channel_session_id: "zap-off", last_message_at: "2026-03-01" }],
      channel_sessions: sessoes.map((s) => ({ ...s })),
    });
    expect(await canalDoLembrete(admin, ORG, "c1")).toBe("zap-a");
  });

  it("sem conversa, usa a sessão pronta da organização", async () => {
    const admin = bancoEmMemoria({
      conversations: [],
      channel_sessions: sessoes.map((s) => ({ ...s })),
    });
    expect(await canalDoLembrete(admin, ORG, "c1")).toBe("zap-a");
  });

  it("sem nenhum canal de mensagem vivo: nulo, e a rodada pula", async () => {
    const admin = bancoEmMemoria({
      conversations: [],
      channel_sessions: [sessoes[0], sessoes[3]].map((s) => ({ ...s })),
    });
    expect(await canalDoLembrete(admin, ORG, "c1")).toBeNull();
  });

  it("conversa de outra organização não decide o canal", async () => {
    const admin = bancoEmMemoria({
      conversations: [{ organization_id: "outra", contact_id: "c1", channel_session_id: "zap-b", last_message_at: "2026-03-01" }],
      channel_sessions: sessoes.map((s) => ({ ...s })),
    });
    expect(await canalDoLembrete(admin, ORG, "c1")).toBe("zap-a");
  });
});

describe("D-115: fuso e portões", () => {
  it("a hora do lembrete usa o fuso do compromisso, não o da organização", () => {
    expect(fusoDoLembrete("America/Manaus", "America/Sao_Paulo")).toBe("America/Manaus");
  });

  it("sem fuso no compromisso (ou inválido), cai no da organização, e por fim no padrão", () => {
    expect(fusoDoLembrete(null, "America/Cuiaba")).toBe("America/Cuiaba");
    expect(fusoDoLembrete("Marte/Olympus", "America/Cuiaba")).toBe("America/Cuiaba");
    expect(fusoDoLembrete(undefined, undefined)).toBe("America/Sao_Paulo");
  });

  it("só organização ativa recebe lembrete", () => {
    expect(organizacaoPodeReceberLembrete("active")).toBe(true);
    for (const s of ["suspended", "redacted", "archived", null, undefined]) {
      expect(organizacaoPodeReceberLembrete(s)).toBe(false);
    }
  });

  it("a rota reserva ANTES de enviar e confere modo leitura e status da organização", () => {
    const fonte = readFileSync(
      join(__dirname, "../../app/api/v1/cron/agenda-reminder/route.ts"),
      "utf8",
    ).replace(/\/\/[^\n]*/g, "");
    expect(fonte.indexOf("reservarDegraus(")).toBeGreaterThan(0);
    expect(fonte.indexOf("reservarDegraus(")).toBeLessThan(fonte.indexOf("sendMessageHandler("));
    expect(fonte).toContain("contaEmModoLeitura(");
    expect(fonte).toContain("organizacaoPodeReceberLembrete(");
    expect(fonte).toContain("fusoDoLembrete(linha.time_zone");
    expect(fonte).toMatch(/starts_at, time_zone,/);
  });
});
