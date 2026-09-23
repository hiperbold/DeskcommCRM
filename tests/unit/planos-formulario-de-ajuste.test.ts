/**
 * Tarefa 5 da fase F1 (hiperbold/planos/fase-F1-tarefas.md): a conversão do
 * formulário de ajuste de limites, a única parte da aba "Plano" que o
 * critério de pronto pede como função pura testada. O resto da tela fica
 * para a conferência manual do Filipe.
 */
import { describe, expect, it } from "vitest";

import { TETO_DE_LIMITE } from "@/lib/billing/planos/limites";
import {
  ajusteDoFormulario,
  estadoInicialDoAjuste,
  type EstadoDoFormularioDeAjuste,
} from "@/lib/billing/planos/formulario-de-ajuste";

/** Todas as chaves em "herdar": o estado de quem nunca tocou no formulário. */
function estadoTodoHerdar(): EstadoDoFormularioDeAjuste {
  return estadoInicialDoAjuste(null);
}

describe("estadoInicialDoAjuste", () => {
  it("a partir de ajuste nulo: toda chave em herdar", () => {
    const estado = estadoInicialDoAjuste(null);
    expect(Object.values(estado).every((campo) => campo.modo === "herdar")).toBe(true);
  });

  it("a partir de { leads: 100, membros: null }: leads em valor, membros em sem_limite, o resto herdar", () => {
    const estado = estadoInicialDoAjuste({ leads: 100, membros: null });

    expect(estado.leads).toEqual({ modo: "valor", valor: "100" });
    expect(estado.membros).toEqual({ modo: "sem_limite" });
    expect(estado.funis).toEqual({ modo: "herdar" });
    expect(estado.etapas_por_funil).toEqual({ modo: "herdar" });
    expect(estado.conexoes).toEqual({ modo: "herdar" });
    expect(estado.integracoes_webhook).toEqual({ modo: "herdar" });
    expect(estado.tokens_ia_mes).toEqual({ modo: "herdar" });
  });
});

describe("ajusteDoFormulario", () => {
  it("herdar em todas as chaves produz objeto vazio (remove o ajuste)", () => {
    const r = ajusteDoFormulario(estadoTodoHerdar());
    expect(r).toEqual({ ok: true, limites: {} });
  });

  it("sem_limite produz null naquela chave", () => {
    const estado = estadoTodoHerdar();
    estado.leads = { modo: "sem_limite" };
    const r = ajusteDoFormulario(estado);
    expect(r).toEqual({ ok: true, limites: { leads: null } });
  });

  it('valor "5000" produz o número 5000', () => {
    const estado = estadoTodoHerdar();
    estado.leads = { modo: "valor", valor: "5000" };
    const r = ajusteDoFormulario(estado);
    expect(r).toEqual({ ok: true, limites: { leads: 5000 } });
  });

  it.each([
    ["vazio", ""],
    ["só espaço", "  "],
    ["negativo", "-1"],
    ["quebrado", "2.5"],
    ["não numérico", "abc"],
    ["acima do teto", String(TETO_DE_LIMITE + 1)],
  ])("valor %s produz erro naquela chave, e nunca vira null", (_nome, entrada) => {
    const estado = estadoTodoHerdar();
    estado.leads = { modo: "valor", valor: entrada };
    const r = ajusteDoFormulario(estado);

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.chave).toBe("leads");
      // A chave nunca vira "sem limite" (null) nem "herdar" (ausente) por causa
      // de um valor mal digitado: as duas têm efeito real sobre a organização.
    }
  });

  it("ida e volta: ajusteDoFormulario(estadoInicialDoAjuste(x)) devolve x", () => {
    const x = { funis: 5, leads: 0, membros: null, tokens_ia_mes: TETO_DE_LIMITE };
    const r = ajusteDoFormulario(estadoInicialDoAjuste(x));
    expect(r).toEqual({ ok: true, limites: x });
  });

  it("ida e volta com ajuste vazio", () => {
    const x = {};
    const r = ajusteDoFormulario(estadoInicialDoAjuste(x));
    expect(r).toEqual({ ok: true, limites: x });
  });
});
