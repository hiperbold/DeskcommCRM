import { beforeEach, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({ audit: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: deps.audit }));

/** A grade e a ocupação são dado aqui: o objeto do teste é o que o handler faz com o 23P01 do banco. */
const consulta = vi.hoisted(() => ({
  horarios: vi.fn(),
  ocupacao: vi.fn(),
}));
vi.mock("@/lib/agenda/consulta", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  horariosLivresDaOrg: consulta.horarios,
  coletaOQueOcupa: consulta.ocupacao,
}));

import { alterarAgendamentoHandler, marcarAgendamentoHandler } from "@/app/api/v1/agenda/agendamentos/_handler";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * A CORRIDA QUE A CONFERÊNCIA DA ROTA NÃO VÊ (D-160, migration 0937).
 *
 * Dois pedidos leem a mesma grade livre; o gatilho do banco recusa o segundo com 23P01. A rota tem
 * de devolver o mesmo 422 `agenda_horario_indisponivel` da conferência normal, e não um 500
 * `internal_error` (criação) nem o genérico `validation_failed` (remarcação). O SQLSTATE real é
 * provado no banco por `tests/invariants/lote13a-banco.test.ts`; aqui se prova o mapeamento.
 */

const ORG = "00000000-0000-4000-8000-000000000001";
const DONO = "00000000-0000-4000-8000-0000000000aa";
const TIPO = "00000000-0000-4000-8000-0000000000dd";
const AGENDAMENTO = "00000000-0000-4000-8000-0000000000ee";
const INICIO = "2026-09-21T13:00:00.000Z";
const NOVO_INICIO = "2026-09-21T15:00:00.000Z";

const tipo = {
  id: TIPO,
  name: "Consulta",
  is_active: true,
  duration_minutes: 30,
  default_owner_user_id: DONO,
  requires_confirmation: false,
  location_kind: "none",
  location_details: null,
};

const ctxDaIA = (): HandlerCtx =>
  ({
    organization_id: ORG,
    requestId: "req-160",
    actor: { type: "ai_agent", id: "run-1", role: "agent" },
  }) as unknown as HandlerCtx;

/** `erroNoInsert` e `erroNaRpc` simulam o que o PostgREST devolve quando o gatilho recusa. */
function sbDeTeste(opcoes: { erroNoInsert?: { code: string; message: string }; erroNaRpc?: { code: string; message: string } }) {
  const atual = {
    id: AGENDAMENTO,
    revision: 1,
    event_type_id: TIPO,
    owner_user_id: DONO,
    contact_id: null,
    starts_at: INICIO,
    status: "confirmed",
    time_zone: "America/Sao_Paulo",
  };
  const api = {
    from(tabela: string) {
      const q = {
        select: () => q,
        eq: () => q,
        is: () => q,
        order: () => q,
        limit: () => q,
        maybeSingle: async () => ({ data: tabela === "calendar_event_types" ? tipo : atual, error: null }),
        single: async () => ({ data: null, error: opcoes.erroNoInsert ?? null }),
        insert: () => q,
        update: () => q,
        delete: () => q,
      };
      return q;
    },
    async rpc(nome: string) {
      if (nome === "fn_appointment_change") return { data: null, error: opcoes.erroNaRpc ?? null };
      return { data: null, error: null };
    },
  };
  return api as unknown as SupabaseClient;
}

const GATILHO = { code: "23P01", message: "Horário indisponível: o responsável já tem um compromisso nesse período." };

beforeEach(() => {
  vi.resetAllMocks();
  consulta.horarios.mockImplementation(async (_sb: unknown, _org: string, args: { de: Date }) => ({
    ok: true,
    publicouHorarios: true,
    fusoDaRegra: "America/Sao_Paulo",
    slots: [{ inicio: args.de, fim: new Date(args.de.getTime() + 30 * 60_000) }],
  }));
  consulta.ocupacao.mockResolvedValue({ ok: true, ocupados: [] });
});

it("criação: o 23P01 do gatilho vira 422 agenda_horario_indisponivel, não 500", async () => {
  const sb = sbDeTeste({ erroNoInsert: GATILHO });
  await expect(
    marcarAgendamentoHandler(sb, ctxDaIA(), { event_type_id: TIPO, starts_at: INICIO, owner_user_id: DONO }),
  ).rejects.toMatchObject({ status: 422, code: "agenda_horario_indisponivel" });
  expect(deps.audit).not.toHaveBeenCalled();
});

it("criação: outro erro do banco continua 500 (o mapeamento é só do 23P01)", async () => {
  const sb = sbDeTeste({ erroNoInsert: { code: "XX000", message: "falha qualquer" } });
  await expect(
    marcarAgendamentoHandler(sb, ctxDaIA(), { event_type_id: TIPO, starts_at: INICIO, owner_user_id: DONO }),
  ).rejects.toMatchObject({ status: 500, code: "internal_error" });
});

it("remarcação: o 23P01 vindo da função de alteração vira 422 agenda_horario_indisponivel", async () => {
  const sb = sbDeTeste({ erroNaRpc: GATILHO });
  await expect(
    alterarAgendamentoHandler(sb, ctxDaIA(), { id: AGENDAMENTO, starts_at: NOVO_INICIO }),
  ).rejects.toMatchObject({ status: 422, code: "agenda_horario_indisponivel" });
});

it("remarcação: os outros códigos seguem o mapa de antes (40001 conflito, 42501 proibido)", async () => {
  await expect(
    alterarAgendamentoHandler(sbDeTeste({ erroNaRpc: { code: "40001", message: "stale" } }), ctxDaIA(), { id: AGENDAMENTO, starts_at: NOVO_INICIO }),
  ).rejects.toMatchObject({ status: 409, code: "conflict" });
  await expect(
    alterarAgendamentoHandler(sbDeTeste({ erroNaRpc: { code: "42501", message: "x" } }), ctxDaIA(), { id: AGENDAMENTO, starts_at: NOVO_INICIO }),
  ).rejects.toMatchObject({ status: 403, code: "forbidden" });
});
