import { describe, expect, it } from "vitest";
import { descreverErroDeValidacao } from "./erro-de-validacao";

describe("descreverErroDeValidacao", () => {
  it("401/403 é chave recusada, e aponta para onde pegar outra", () => {
    const r = descreverErroDeValidacao("auth_failed_401");
    expect(r.chaveErrada).toBe(true);
    expect(r.frase).toBe("O provedor recusou a chave. Confira se copiou inteira ou gere uma nova.");
  });

  it("429 é limite do provedor", () => {
    expect(descreverErroDeValidacao("provider_status_429").frase).toBe(
      "O provedor limitou as chamadas desta chave. Tente de novo em alguns minutos.",
    );
  });

  it("outro 4xx (402, 404…) é recusa com frase, não código cru", () => {
    const r = descreverErroDeValidacao("provider_status_402");
    expect(r.generico).toBe(false);
    expect(r.chaveErrada).toBe(true);
    expect(r.frase).toBe(
      "O provedor recusou a chave. Confira se ela está inteira e se a conta no provedor tem crédito.",
    );
    // O 429 continua com a frase própria.
    expect(descreverErroDeValidacao("provider_status_429").frase).toMatch(/limitou/);
  });

  it("5xx é provedor fora", () => {
    expect(descreverErroDeValidacao("provider_status_503").frase).toBe(
      "O provedor está fora do ar. A chave pode estar certa; revalide mais tarde.",
    );
  });

  it("timeout e rede são a mesma frase", () => {
    const esperado = "Não foi possível falar com o provedor a partir deste servidor. Revalide mais tarde.";
    expect(descreverErroDeValidacao("AbortError").frase).toBe(esperado);
    expect(descreverErroDeValidacao("TimeoutError").frase).toBe(esperado);
    expect(descreverErroDeValidacao("network_error").frase).toBe(esperado);
    // `fetch` do Node lança TypeError p/ falha de rede/DNS (undici não nomeia
    // isso `network_error`). Achado rodando a spec de e2e contra o provedor
    // real: sem este caso, o card mostrava "Falha na validação (TypeError)."
    expect(descreverErroDeValidacao("TypeError").frase).toBe(esperado);
  });

  it("código desconhecido não some: vira frase genérica COM o código", () => {
    const r = descreverErroDeValidacao("unknown_provider:foo");
    expect(r.chaveErrada).toBe(false);
    expect(r.frase).toBe("Falha na validação (unknown_provider:foo).");
  });

  it("chave do Jev: diz QUEM recusou, e os outros provedores seguem com a frase comum", () => {
    expect(descreverErroDeValidacao("auth_failed_401", "typesafe")).toEqual({
      frase: "A TypeSafe recusou a chave. Confira se copiou inteira ou gere uma nova.",
      chaveErrada: true,
      generico: false,
    });
    expect(descreverErroDeValidacao("provider_status_402", "typesafe").frase).toBe(
      "A TypeSafe recusou a chave. Confira se ela está inteira e se a conta na TypeSafe tem crédito.",
    );
    expect(descreverErroDeValidacao("auth_failed_401", "anthropic").frase).toMatch(/^O provedor recusou/);
    // Fora do ar não é recusa: a frase comum serve.
    expect(descreverErroDeValidacao("provider_status_503", "typesafe").frase).toMatch(/^O provedor está fora/);
  });

  describe("endereço recusado pela régua de destino", () => {
    const NOME_NAO_RESOLVE = "unsafe_url:dns_failed";
    const NOME_VAZIO = "unsafe_url:dns_empty";
    const IP_INTERNO = "unsafe_url:private_ip";

    it("origem ORGANIZAÇÃO: a mesma frase para nome que não resolve e nome que resolve para IP interno", () => {
      // Frases diferentes viravam oráculo: o admin de uma empresa descobria, por
      // tentativa, quais nomes existem na rede interna do compose.
      const frases = [NOME_NAO_RESOLVE, NOME_VAZIO, IP_INTERNO].map(
        (c) => descreverErroDeValidacao(c, "custom", "organizacao").frase,
      );
      expect(new Set(frases).size).toBe(1);
      expect(frases[0]).toMatch(/rede interna/);
      // O padrão de quem não diz a origem é o lado que fecha.
      expect(descreverErroDeValidacao(NOME_NAO_RESOLVE, "custom").frase).toBe(frases[0]);
      expect(descreverErroDeValidacao(IP_INTERNO, "custom").frase).toBe(frases[0]);
      const r = descreverErroDeValidacao(NOME_NAO_RESOLVE, "custom", "organizacao");
      expect(r.generico).toBe(false);
      expect(r.chaveErrada).toBe(false);
    });

    it("origem INSTALAÇÃO: as frases continuam distintas, como eram", () => {
      const naoResolve = descreverErroDeValidacao(NOME_NAO_RESOLVE, undefined, "instalacao").frase;
      const interno = descreverErroDeValidacao(IP_INTERNO, undefined, "instalacao").frase;
      expect(naoResolve).toBe("Este servidor não encontrou o endereço: o nome não resolve. Confira a base URL.");
      expect(interno).toBe(
        "Este endereço não é aceito: um endereço cadastrado pela empresa não pode apontar para a rede interna do servidor (localhost, IP privado ou serviço interno).",
      );
    });

    it("os outros códigos de endereço não mudam na origem organização", () => {
      expect(descreverErroDeValidacao("unsafe_url:https_required", "custom", "organizacao").frase).toMatch(/https/);
      expect(descreverErroDeValidacao("unsafe_url:redirect_not_followed", "custom", "organizacao").frase).toMatch(
        /redirecionamento/,
      );
    });
  });

  it("null é string vazia", () => {
    expect(descreverErroDeValidacao(null).frase).toBe("");
  });
});
