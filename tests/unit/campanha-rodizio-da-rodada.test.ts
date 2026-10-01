/**
 * D-098: uma organização com muitas campanhas `running` esperando não trava a
 * rodada das outras. O defeito: o dreno lia só as 30 mais antigas por `started_at`
 * e ficava nelas para sempre quando elas esperavam (ritmo, teto, número sem vaga).
 *
 * `rodarUmaRodadaDeCampanha` roda de verdade. O banco é falso, mas guarda estado
 * (`last_tick_at` de cada campanha) e responde à ordenação e ao limite da consulta
 * como o PostgREST; o que se mede é QUAIS campanhas a rodada avaliou, rodada após
 * rodada. Cada campanha avaliada aqui cai no ramo "aguardando" (tem destinatário em
 * voo, nenhum elegível agora), que é exatamente o de uma campanha que espera.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({
  getRequestPool: () => ({ query: async () => ({ rows: [] }) }),
}));

import { reconciliarEnviando, rodarUmaRodadaDeCampanha } from "@/lib/campanhas/rodada";

interface Campanha {
  id: string;
  organization_id: string;
  channel_session_id: string;
  name: string;
  message_body: string;
  content_version: number;
  intervalo_segundos: null;
  janela_inicio_hora: null;
  janela_fim_hora: null;
  teto_diario: null;
  teto_horario: null;
  started_at: string;
  last_tick_at: string | null;
}

function campanha(id: string, org: string, numero: string, minuto: number): Campanha {
  return {
    id,
    organization_id: org,
    channel_session_id: numero,
    name: id,
    message_body: "oi",
    content_version: 1,
    intervalo_segundos: null,
    janela_inicio_hora: null,
    janela_fim_hora: null,
    teto_diario: null,
    teto_horario: null,
    started_at: new Date(Date.UTC(2026, 8, 1, 0, minuto)).toISOString(),
    last_tick_at: null,
  };
}

function banco(campanhas: Campanha[]) {
  const avaliadas: string[] = [];
  /** O que foi avaliado desde a última chamada (sem repetir: cada avaliação consulta mais de uma vez). */
  const daRodada = () => {
    const unicas = [...new Set(avaliadas)];
    avaliadas.length = 0;
    return unicas;
  };
  const builder = (tabela: string) => {
    const e: {
      op: "select" | "update";
      payload?: Record<string, unknown>;
      eqs: Record<string, unknown>;
      ins: Record<string, string[]>;
      orders: Array<{ col: string; nullsFirst: boolean }>;
      limite: number;
      head: boolean;
      isNull?: boolean;
    } = { op: "select", eqs: {}, ins: {}, orders: [], limite: Infinity, head: false };
    const b: Record<string, unknown> = {
      select: (_c?: string, o?: { head?: boolean }) => {
        e.head = !!o?.head;
        return b;
      },
      update: (payload: Record<string, unknown>) => {
        e.op = "update";
        e.payload = payload;
        return b;
      },
      eq: (c: string, v: unknown) => {
        e.eqs[c] = v;
        return b;
      },
      in: (c: string, v: string[]) => {
        e.ins[c] = v;
        return b;
      },
      is: (c: string, v: unknown) => {
        e.isNull = c === "last_tick_at" && v === null;
        return b;
      },
      lt: () => b,
      lte: () => b,
      or: () => b,
      not: () => b,
      order: (col: string, o?: { nullsFirst?: boolean }) => {
        e.orders.push({ col, nullsFirst: !!o?.nullsFirst });
        return b;
      },
      limit: (n: number) => {
        e.limite = n;
        return b;
      },
      maybeSingle: async () => ({ data: tabela === "billing_settings" ? { modo: "avisar" } : null, error: null }),
      then: (resolve: (v: unknown) => unknown) => {
        let resposta: { data: unknown; error: null; count?: number };
        if (tabela === "campaigns" && e.op === "update" && e.payload && "last_tick_at" in e.payload) {
          for (const c of campanhas) {
            if (e.ins.id?.includes(c.id) && (!e.isNull || c.last_tick_at === null)) c.last_tick_at = e.payload.last_tick_at as string;
          }
          resposta = { data: null, error: null };
        } else if (tabela === "campaigns" && e.op === "select") {
          const ordenadas = campanhas
            .filter((c) => c.started_at)
            .sort((x, y) => {
              if (x.last_tick_at !== y.last_tick_at) {
                if (x.last_tick_at === null) return -1;
                if (y.last_tick_at === null) return 1;
                return x.last_tick_at < y.last_tick_at ? -1 : 1;
              }
              return x.started_at < y.started_at ? -1 : 1;
            });
          resposta = { data: ordenadas.slice(0, e.limite), error: null };
        } else if (tabela === "campaign_recipients" && e.op === "select") {
          if (e.eqs.campaign_id) avaliadas.push(e.eqs.campaign_id as string);
          resposta = e.head ? { data: null, error: null, count: 2 } : { data: [], error: null };
        } else {
          resposta = { data: [], error: null };
        }
        return Promise.resolve(resposta).then(resolve);
      },
    };
    return b;
  };
  return { admin: { from: builder } as never, daRodada };
}

const MIN = 60_000;

describe("rodízio da rodada de campanhas (D-098)", () => {
  const inicio = Date.UTC(2026, 9, 1, 12, 0);

  it("⭐ 35 campanhas antigas de uma organização não impedem a de outra de ser avaliada", async () => {
    const todas = [
      ...Array.from({ length: 35 }, (_, i) => campanha(`a${i + 1}`, "org-a", `num-a${i + 1}`, i)),
      campanha("b1", "org-b", "num-b1", 100),
    ];
    const { admin, daRodada } = banco(todas);
    const vistas = new Set<string>();
    for (let rodada = 0; rodada < 4; rodada++) {
      await rodarUmaRodadaDeCampanha(admin, new Date(inicio + rodada * MIN));
      for (const id of daRodada()) vistas.add(id);
    }
    expect(vistas, "a campanha de outra organização nunca foi avaliada").toContain("b1");
    expect(vistas.size).toBe(36);
  });

  it("toda campanha running é avaliada em poucas rodadas, mesmo com mais campanhas que a janela", async () => {
    const todas = Array.from({ length: 70 }, (_, i) => campanha(`c${i + 1}`, `org-${i % 7}`, `num-${i + 1}`, i));
    const { admin, daRodada } = banco(todas);
    const vistas = new Set<string>();
    for (let rodada = 0; rodada < 8; rodada++) {
      await rodarUmaRodadaDeCampanha(admin, new Date(inicio + rodada * MIN));
      const daVez = daRodada();
      expect(daVez.length).toBeLessThanOrEqual(10);
      for (const id of daVez) vistas.add(id);
    }
    expect(vistas.size).toBe(70);
  });

  it("campanhas do mesmo número se revezam: nenhuma fica de fora e a avaliada vai para o fim da fila", async () => {
    const todas = [campanha("x1", "org-a", "mesmo-numero", 0), campanha("x2", "org-a", "mesmo-numero", 1), campanha("x3", "org-a", "mesmo-numero", 2)];
    const { admin, daRodada } = banco(todas);
    const ordem: string[] = [];
    for (let rodada = 0; rodada < 6; rodada++) {
      await rodarUmaRodadaDeCampanha(admin, new Date(inicio + rodada * MIN));
      ordem.push(...daRodada());
    }
    // Rodízio exato: cada uma tem a vez antes de a primeira repetir.
    expect(ordem).toEqual(["x1", "x2", "x3", "x1", "x2", "x3"]);
  });
});

describe("reconciliação do destinatário preso em sending (D-098)", () => {
  function bancoDeReconciliacao(mensagem: { id: string; status: string; sent_at: string | null } | null) {
    const atualizacoes: Array<Record<string, unknown>> = [];
    const builder = (tabela: string) => {
      let op: "select" | "update" = "select";
      let payload: Record<string, unknown> | undefined;
      const b: Record<string, unknown> = {
        select: () => b,
        update: (p: Record<string, unknown>) => {
          op = "update";
          payload = p;
          return b;
        },
        eq: () => b,
        lt: () => b,
        order: () => b,
        limit: () => b,
        then: (resolve: (v: unknown) => unknown) => {
          let data: unknown = [];
          if (tabela === "campaign_recipients" && op === "select") data = [{ id: "r1" }];
          if (tabela === "messages") data = mensagem ? [mensagem] : [];
          if (tabela === "campaign_recipients" && op === "update") {
            atualizacoes.push(payload!);
            data = [{ id: "r1" }];
          }
          return Promise.resolve({ data, error: null }).then(resolve);
        },
      };
      return b;
    };
    return { admin: { from: builder } as never, atualizacoes };
  }
  const agora = new Date(Date.UTC(2026, 9, 1, 12, 0));
  const camp = { id: "c1", organization_id: "org-a" };

  it("mensagem que saiu fecha o destinatário como sent, com o id da mensagem", async () => {
    const { admin, atualizacoes } = bancoDeReconciliacao({ id: "m1", status: "delivered", sent_at: "2026-10-01T11:00:00Z" });
    expect(await reconciliarEnviando(admin, camp, agora)).toBe(1);
    expect(atualizacoes[0]).toMatchObject({ status: "sent", message_id: "m1", sent_at: "2026-10-01T11:00:00Z" });
  });

  it("mensagem failed fecha como failed; sem desfecho ou sem mensagem NÃO reenvia, vira failed com o código", async () => {
    const falha = bancoDeReconciliacao({ id: "m2", status: "failed", sent_at: null });
    await reconciliarEnviando(falha.admin, camp, agora);
    expect(falha.atualizacoes[0]).toMatchObject({ status: "failed", last_error_code: "send_failed" });

    const fila = bancoDeReconciliacao({ id: "m3", status: "queued", sent_at: null });
    await reconciliarEnviando(fila.admin, camp, agora);
    expect(fila.atualizacoes[0]).toMatchObject({ status: "failed", last_error_code: "send_indeterminado" });

    const nada = bancoDeReconciliacao(null);
    await reconciliarEnviando(nada.admin, camp, agora);
    expect(nada.atualizacoes[0]).toMatchObject({ status: "failed", last_error_code: "send_perdido" });
    expect(nada.atualizacoes[0]).not.toHaveProperty("message_id");
  });
});
