import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * D-096: o agente que conversa com UM cliente só lê e altera dado DESSE cliente.
 *
 * A asserção é sobre a CADEIA: monta a ferramenta como o turno monta
 * (`pickToolsFromMcp` com `contatoDoTurno`), executa com o id de um recurso de
 * OUTRA pessoa e lê o que chegou (ou não) ao handler. O handler é espiado: o
 * que se prova é se a chamada alcança o handler, não o que ele faz.
 */

vi.mock("@/lib/mcp/audit", () => ({ auditMcpToolCall: vi.fn().mockResolvedValue(undefined) }));

const { pickToolsFromMcp } = await import("@/lib/ai/runtime/tools");
const { getToolByName } = await import("@/lib/mcp/tools");
const { aplicarEscopoDoTurno } = await import("@/lib/mcp/escopo-do-turno");

const ORG = "11111111-1111-4111-8111-111111111111";
const EU = "22222222-2222-4222-8222-222222222222"; // contato do turno
const OUTRO = "33333333-3333-4333-8333-333333333333"; // outro cliente da loja
const CONVERSA_MINHA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONVERSA_ALHEIA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const COMPROMISSO_ALHEIO = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const COMPROMISSO_MEU = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const CASO_ALHEIO = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const NEGOCIO_ALHEIO = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const RETORNO_ALHEIO = "99999999-9999-4999-8999-999999999999";
const FUNIL = "44444444-4444-4444-8444-444444444444";

/** `tabela -> id -> linha`. Só o que a ponte pergunta: `contact_id` por id. */
const LINHAS: Record<string, Record<string, Record<string, unknown>>> = {
  conversations: {
    [CONVERSA_MINHA]: { contact_id: EU },
    [CONVERSA_ALHEIA]: { contact_id: OUTRO },
  },
  calendar_appointments: {
    [COMPROMISSO_MEU]: { contact_id: EU },
    [COMPROMISSO_ALHEIO]: { contact_id: OUTRO },
  },
  agent_cases: { [CASO_ALHEIO]: { conversation_id: CONVERSA_ALHEIA } },
  crm_leads: { [NEGOCIO_ALHEIO]: { contact_id: OUTRO, pipeline_id: FUNIL } },
  cron_jobs: { [RETORNO_ALHEIO]: { contact_id: OUTRO } },
};

function banco(opts: { falhaEm?: string } = {}) {
  return {
    from(tabela: string) {
      const filtros: Record<string, unknown> = {};
      const q = {
        select: () => q,
        eq: (coluna: string, valor: unknown) => {
          filtros[coluna] = valor;
          return q;
        },
        maybeSingle: async () => {
          if (opts.falhaEm === tabela) return { data: null, error: { message: "timeout" } };
          // Sempre filtrado por organização: o teste confere que a ponte pergunta assim.
          if (filtros.organization_id !== ORG) return { data: null, error: null };
          return { data: LINHAS[tabela]?.[String(filtros.id)] ?? null, error: null };
        },
      };
      return q;
    },
  };
}

function montar(
  toolIds: string[],
  extra: { papelDoTurno?: "conversador" | "operador"; contatoDoTurno?: string | null; supabase?: unknown } = {},
) {
  const supabase = extra.supabase ?? banco();
  const ator = { type: "ai_agent", id: "ag-1", role: "ai_operator" };
  return pickToolsFromMcp({
    toolIds,
    auth: { organizationId: ORG, role: "ai_operator", scopes: ["mcp:read", "mcp:write"], actor: ator, apiTokenId: "tok-1" },
    ctx: { organizationId: ORG, role: "ai_operator", actor: ator, apiTokenId: "tok-1", requestId: "req-1", supabase },
    supabase,
    pipelineIds: [FUNIL],
    handoffToolEnabled: false,
    handoffSignal: { triggered: false },
    ...(extra.contatoDoTurno === null ? {} : { contatoDoTurno: extra.contatoDoTurno ?? EU }),
    ...(extra.papelDoTurno ? { papelDoTurno: extra.papelDoTurno } : {}),
  } as never);
}

async function chamar(tools: ReturnType<typeof montar>, nome: string, args: Record<string, unknown>) {
  return tools[nome]!.execute!(args, { toolCallId: "c1", messages: [] } as never);
}

const handlers: Array<ReturnType<typeof vi.spyOn>> = [];
function espiar(nome: string) {
  const def = getToolByName(nome)!;
  const espia = (vi.spyOn(def as unknown as Record<string, unknown>, "handler" as never) as unknown as ReturnType<typeof vi.fn>)
    .mockResolvedValue({ ok: true });
  handlers.push(espia as never);
  return espia as unknown as ReturnType<typeof vi.fn>;
}

beforeEach(() => {
  handlers.length = 0;
});
afterEach(() => {
  for (const h of handlers) h.mockRestore();
});

describe("recurso de OUTRO contato é recusado antes do handler", () => {
  it("histórico de conversa alheia", async () => {
    const h = espiar("crm_get_conversation_history");
    const r = await chamar(montar(["crm_get_conversation_history"]), "crm_get_conversation_history", {
      conversation_id: CONVERSA_ALHEIA,
    });
    expect(r).toMatchObject({ permitido: false, motivo: "fora_do_contato_do_turno" });
    expect(h).not.toHaveBeenCalled();
  });

  it("a conversa do próprio contato passa", async () => {
    const h = espiar("crm_get_conversation_history");
    await chamar(montar(["crm_get_conversation_history"]), "crm_get_conversation_history", {
      conversation_id: CONVERSA_MINHA,
    });
    expect(h).toHaveBeenCalledTimes(1);
  });

  it("ficha de outro cliente", async () => {
    const h = espiar("crm_get_contact");
    const r = await chamar(montar(["crm_get_contact"]), "crm_get_contact", { contact_id: OUTRO });
    expect(r).toMatchObject({ permitido: false });
    expect(h).not.toHaveBeenCalled();
  });

  it("remarcar, confirmar e cancelar o compromisso de outra pessoa", async () => {
    for (const nome of ["crm_reschedule_appointment", "crm_confirm_appointment", "crm_cancel_appointment"]) {
      const h = espiar(nome);
      const r = await chamar(montar([nome]), nome, { appointment_id: COMPROMISSO_ALHEIO, para: "2026-10-02T10:00:00Z" });
      expect(r, nome).toMatchObject({ permitido: false, motivo: "fora_do_contato_do_turno" });
      expect(h, nome).not.toHaveBeenCalled();
    }
  });

  it("o compromisso do próprio contato continua alcançável", async () => {
    const h = espiar("crm_confirm_appointment");
    await chamar(montar(["crm_confirm_appointment"]), "crm_confirm_appointment", { appointment_id: COMPROMISSO_MEU });
    expect(h).toHaveBeenCalledTimes(1);
  });

  it("caso humano, negócio e retorno de outra pessoa", async () => {
    const casos: Array<[string, Record<string, unknown>]> = [
      ["crm_close_human_case", { case_id: CASO_ALHEIO, outcome: "resolvido", note: "x" }],
      ["crm_add_case_note", { case_id: CASO_ALHEIO, note: "x" }],
      ["crm_get_human_case", { case_id: CASO_ALHEIO }],
      ["crm_move_lead_stage", { lead_id: NEGOCIO_ALHEIO, to_stage_id: FUNIL }],
      ["crm_update_lead", { lead_id: NEGOCIO_ALHEIO, value_cents: 1 }],
      ["crm_cancel_followup", { followup_id: RETORNO_ALHEIO, reason: "x" }],
    ];
    for (const [nome, args] of casos) {
      const h = espiar(nome);
      const r = await chamar(montar([nome]), nome, args);
      expect(r, nome).toMatchObject({ permitido: false, motivo: "fora_do_contato_do_turno" });
      expect(h, nome).not.toHaveBeenCalled();
    }
  });

  it("marcador em alvo de outro cliente, por qualquer tipo de alvo", async () => {
    const h = espiar("crm_manage_tags");
    const tools = montar(["crm_manage_tags"]);
    for (const alvo of [
      { target_kind: "contact", target_id: OUTRO },
      { target_kind: "conversation", target_id: CONVERSA_ALHEIA },
      { target_kind: "lead", target_id: NEGOCIO_ALHEIO },
    ]) {
      const r = await chamar(tools, "crm_manage_tags", { ...alvo, add: ["vip"] });
      expect(r, JSON.stringify(alvo)).toMatchObject({ permitido: false });
    }
    expect(h).not.toHaveBeenCalled();
  });

  it("recurso inexistente tem a mesma resposta que o de outra pessoa (não confirma o id)", async () => {
    const h = espiar("crm_get_conversation");
    const r = await chamar(montar(["crm_get_conversation"]), "crm_get_conversation", {
      conversation_id: "12121212-1212-4212-8212-121212121212",
    });
    expect(r).toMatchObject({ permitido: false, motivo: "fora_do_contato_do_turno" });
    expect(h).not.toHaveBeenCalled();
  });

  it("falha de leitura não vira liberação nem 'é de outro': é indisponível", async () => {
    const h = espiar("crm_get_conversation");
    const r = await chamar(
      montar(["crm_get_conversation"], { supabase: banco({ falhaEm: "conversations" }) }),
      "crm_get_conversation",
      { conversation_id: CONVERSA_MINHA },
    );
    expect(r).toMatchObject({ permitido: false, motivo: "indisponivel" });
    expect(h).not.toHaveBeenCalled();
  });
});

describe("listagem sem recorte ganha o contato do turno", () => {
  it("crm_list_conversations sem contact_id chega ao handler filtrada pelo contato do turno", async () => {
    const h = espiar("crm_list_conversations");
    await chamar(montar(["crm_list_conversations"]), "crm_list_conversations", {});
    expect(h.mock.calls[0]![0]).toMatchObject({ contact_id: EU });
  });

  it("agenda por período, sem contato, deixa de ser a agenda inteira", async () => {
    const h = espiar("crm_list_appointments");
    await chamar(montar(["crm_list_appointments"]), "crm_list_appointments", {
      de: "2026-10-02",
      ate: "2026-10-03",
    });
    expect(h.mock.calls[0]![0]).toMatchObject({ contact_id: EU });
  });

  it("pedir a listagem de OUTRO contato é recusado", async () => {
    const h = espiar("crm_list_appointments");
    const r = await chamar(montar(["crm_list_appointments"]), "crm_list_appointments", { contact_id: OUTRO });
    expect(r).toMatchObject({ permitido: false });
    expect(h).not.toHaveBeenCalled();
  });
});

describe("busca ampla não existe no turno do Conversador", () => {
  const AMPLAS = ["crm_search_contacts", "crm_list_human_cases", "crm_list_leads", "crm_list_at_risk_leads"];

  it("não é montada", () => {
    const montadas = montar([...AMPLAS, "crm_get_contact"]);
    for (const nome of AMPLAS) expect(montadas, nome).not.toHaveProperty(nome);
    expect(montadas).toHaveProperty("crm_get_contact");
  });

  it("o Operador as mantém", () => {
    const montadas = montar(AMPLAS, { papelDoTurno: "operador" });
    for (const nome of AMPLAS) expect(montadas, nome).toHaveProperty(nome);
  });

  it("sem papel declarado vale Conversador (o lado seguro)", () => {
    expect(montar(["crm_search_contacts"])).not.toHaveProperty("crm_search_contacts");
  });

  it("mesmo que alguém a monte, a execução do Conversador é recusada", async () => {
    const r = await aplicarEscopoDoTurno({
      ferramenta: "crm_search_contacts",
      argumentos: { query: "a" },
      contatoDoTurno: EU,
      papel: "conversador",
      donoDoRecurso: async () => null,
    });
    expect(r.veredito).toMatchObject({ permitido: false, motivo: "ferramenta_ampla" });
  });

  it("sem contato do turno (teste fora de uma conversa) nada é retirado", () => {
    expect(montar(["crm_search_contacts"], { contatoDoTurno: null })).toHaveProperty("crm_search_contacts");
  });
});

describe("o Operador também fica preso ao contato nas escritas por recurso", () => {
  it("compromisso de outra pessoa é recusado também para ele", async () => {
    const h = espiar("crm_cancel_appointment");
    const r = await chamar(
      montar(["crm_cancel_appointment"], { papelDoTurno: "operador" }),
      "crm_cancel_appointment",
      { appointment_id: COMPROMISSO_ALHEIO },
    );
    expect(r).toMatchObject({ permitido: false });
    expect(h).not.toHaveBeenCalled();
  });
});

describe("o contexto das ferramentas carrega o cliente do turno (D-146)", () => {
  it("o handler recebe o contato do turno em `escopoDoTurno`, igual para todas as ferramentas do turno", async () => {
    const h = espiar("crm_query_external_data");
    const g = espiar("crm_describe_external_data");
    const tools = montar(["crm_query_external_data", "crm_describe_external_data"]);
    await chamar(tools, "crm_query_external_data", { tabela: "produtos" });
    await chamar(tools, "crm_describe_external_data", {});
    const ctxA = h.mock.calls[0]![1] as { escopoDoTurno?: { contatoId: string } };
    const ctxB = g.mock.calls[0]![1] as { escopoDoTurno?: { contatoId: string } };
    expect(ctxA.escopoDoTurno?.contatoId).toBe(EU);
    expect(ctxB.escopoDoTurno).toBe(ctxA.escopoDoTurno);
  });

  it("sem contato do turno, não há escopo no contexto", async () => {
    const h = espiar("crm_query_external_data");
    await chamar(montar(["crm_query_external_data"], { contatoDoTurno: null }), "crm_query_external_data", {
      tabela: "produtos",
    });
    expect((h.mock.calls[0]![1] as { escopoDoTurno?: unknown }).escopoDoTurno).toBeUndefined();
  });
});
