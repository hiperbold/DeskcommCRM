/**
 * Tarefas 5 e 6 da fase F3 (hiperbold/planos/fase-F3-tarefas.md, decisões 3,
 * 4 e 9): `recusaDoPlano` reconhece o erro PT402 nos dois formatos que o
 * Node recebe (supabase-js e pg) e nunca vaza o texto cru do Postgres.
 */
import { describe, expect, it } from "vitest";

import {
  ITENS_RECUSADOS_PELO_PLANO,
  recusaDoPlano,
  STATUS_RECUSA_DO_PLANO,
} from "@/lib/billing/planos/recusa-do-plano";

const TEXTO_CRU_DO_BANCO = "Limite do plano atingido";

describe("recusaDoPlano", () => {
  it("reconhece o formato do supabase-js (code + details, com 's')", () => {
    const erro = { code: "PT402", message: TEXTO_CRU_DO_BANCO, details: "funis", hint: "" };
    const recusa = recusaDoPlano(erro);
    expect(recusa).not.toBeNull();
    expect(recusa?.item).toBe("funis");
    expect(recusa?.mensagem).toBe(
      "O plano desta organização chegou ao limite de funis. Fale com o suporte para ampliar.",
    );
  });

  it("reconhece o formato do pg (code + detail, sem 's')", () => {
    const erro = { code: "PT402", message: TEXTO_CRU_DO_BANCO, detail: "membros" };
    const recusa = recusaDoPlano(erro);
    expect(recusa).not.toBeNull();
    expect(recusa?.item).toBe("membros");
    expect(recusa?.mensagem).toBe(
      "O plano desta organização chegou ao limite de membros. Fale com o suporte para ampliar.",
    );
  });

  it("cobre os cinco itens desta fase, cada um com frase própria", () => {
    const mensagens = new Set<string>();
    for (const item of ITENS_RECUSADOS_PELO_PLANO) {
      const recusa = recusaDoPlano({ code: "PT402", detail: item });
      expect(recusa?.item).toBe(item);
      expect(recusa?.mensagem).toContain(item === "etapas_por_funil" ? "etapas por funil" : "");
      mensagens.add(recusa!.mensagem);
    }
    // cinco frases DIFERENTES — ninguém compartilha a mesma mensagem genérica.
    expect(mensagens.size).toBe(ITENS_RECUSADOS_PELO_PLANO.length);
  });

  it("detail desconhecido (ex.: 'leads', fora desta tarefa) cai na mensagem genérica, sem lançar", () => {
    const recusa = recusaDoPlano({ code: "PT402", detail: "leads" });
    expect(recusa).not.toBeNull();
    expect(recusa?.item).toBeNull();
    expect(recusa?.mensagem).toMatch(/limite contratado/);
  });

  it("nunca repassa o texto cru do Postgres na mensagem", () => {
    const erro = { code: "PT402", message: TEXTO_CRU_DO_BANCO, details: "conexoes" };
    const recusa = recusaDoPlano(erro);
    expect(recusa?.mensagem).not.toContain(TEXTO_CRU_DO_BANCO);
  });

  it("outro código de erro passa adiante (devolve null)", () => {
    expect(recusaDoPlano({ code: "23505", message: "duplicate key" })).toBeNull();
    expect(recusaDoPlano({ code: "PGRST301", message: "outra coisa" })).toBeNull();
  });

  it("erro sem code, null, string ou undefined também devolvem null", () => {
    expect(recusaDoPlano({ message: "sem code nenhum" })).toBeNull();
    expect(recusaDoPlano(null)).toBeNull();
    expect(recusaDoPlano(undefined)).toBeNull();
    expect(recusaDoPlano("PT402")).toBeNull();
    expect(recusaDoPlano(new Error("qualquer coisa"))).toBeNull();
  });

  it("status fixo é 402", () => {
    expect(STATUS_RECUSA_DO_PLANO).toBe(402);
  });
});
