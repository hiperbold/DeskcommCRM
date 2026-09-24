/**
 * `lib/billing/asaas/erros.ts`: `ErroAsaas` discriminado por `tipo` e o
 * `inconclusivo` que acompanha toda variante (fase F5, Tarefa 10, decisão 14).
 */
import { describe, expect, it } from "vitest";

import {
  ErroAsaasException,
  erroAutenticacao,
  erroConfiguracao,
  erroIndisponivel,
  erroLimite,
  erroNaoEncontrado,
  erroRespostaInvalida,
  erroTempoEsgotado,
  erroValidacao,
} from "@/lib/billing/asaas/erros";

describe("ErroAsaas: discriminante por tipo", () => {
  it("configuracao carrega a mensagem e nunca é inconclusivo", () => {
    const e = erroConfiguracao("ASAAS_API_KEY errada");
    expect(e).toBeInstanceOf(ErroAsaasException);
    expect(e.erro.tipo).toBe("configuracao");
    expect(e.erro.inconclusivo).toBe(false);
    if (e.erro.tipo === "configuracao") expect(e.erro.mensagem).toBe("ASAAS_API_KEY errada");
  });

  it("autenticacao carrega o status e nunca é inconclusivo", () => {
    const e = erroAutenticacao(401);
    expect(e.erro.tipo).toBe("autenticacao");
    if (e.erro.tipo === "autenticacao") expect(e.erro.status).toBe(401);
    expect(e.erro.inconclusivo).toBe(false);
  });

  it("validacao carrega status e códigos, nunca é inconclusivo", () => {
    const e = erroValidacao(400, ["invalid_cpfCnpj"]);
    expect(e.erro.tipo).toBe("validacao");
    if (e.erro.tipo === "validacao") {
      expect(e.erro.status).toBe(400);
      expect(e.erro.codigos).toEqual(["invalid_cpfCnpj"]);
    }
    expect(e.erro.inconclusivo).toBe(false);
  });

  it("nao_encontrado carrega o status e nunca é inconclusivo", () => {
    const e = erroNaoEncontrado(404);
    expect(e.erro.tipo).toBe("nao_encontrado");
    expect(e.erro.inconclusivo).toBe(false);
  });

  it("limite carrega reiniciaEm; inconclusivo depende do chamador (POST)", () => {
    const semEspera = erroLimite(null);
    expect(semEspera.erro.tipo).toBe("limite");
    if (semEspera.erro.tipo === "limite") expect(semEspera.erro.reiniciaEm).toBeNull();
    expect(semEspera.erro.inconclusivo).toBe(false);

    const emPost = erroLimite(30, true);
    if (emPost.erro.tipo === "limite") expect(emPost.erro.reiniciaEm).toBe(30);
    expect(emPost.erro.inconclusivo).toBe(true);
  });

  it("indisponivel e tempo_esgotado aceitam inconclusivo explícito", () => {
    expect(erroIndisponivel(503, true).erro.inconclusivo).toBe(true);
    expect(erroIndisponivel(503, false).erro.inconclusivo).toBe(false);
    expect(erroTempoEsgotado(true).erro.inconclusivo).toBe(true);
    expect(erroTempoEsgotado(false).erro.inconclusivo).toBe(false);
  });

  it("resposta_invalida carrega o detalhe do schema e nunca é inconclusivo", () => {
    const e = erroRespostaInvalida("id");
    expect(e.erro.tipo).toBe("resposta_invalida");
    if (e.erro.tipo === "resposta_invalida") expect(e.erro.detalhe).toBe("id");
    expect(e.erro.inconclusivo).toBe(false);
  });

  it("Error.message só traz o tipo, nunca detalhe sensível", () => {
    const e = erroAutenticacao(401);
    expect(e.message).toBe("asaas_autenticacao");
  });
});
