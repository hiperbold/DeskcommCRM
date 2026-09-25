/**
 * D-036: o IP do audit e do rate limit vinha do PRIMEIRO salto do
 * `x-forwarded-for`, que quem faz a requisição escreve e pode forjar. Atrás do
 * proxy desta stack (Caddy/Traefik, sempre um salto, ver o cabeçalho do
 * arquivo), o valor confiável é o ÚLTIMO: o que o proxy acrescentou por conta
 * própria ao ver a conexão direta do cliente.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ipDoCliente, ipDoClienteParaInet } from "./ip-do-cliente";

function comHeaders(valores: Record<string, string>): Headers {
  return new Headers(valores);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("ipDoCliente: salto confiável, não o primeiro escrito pelo cliente", () => {
  // A leitura de trás só liga com a conta de saltos declarada (ver o
  // cabeçalho de `ip-do-cliente.ts`); cada caso que muda a conta sobrescreve.
  beforeEach(() => {
    vi.stubEnv("TRUSTED_PROXY_COUNT", "1");
  });

  it("um único IP no header (sem proxy no meio) continua funcionando", () => {
    expect(ipDoCliente(comHeaders({ "x-forwarded-for": "203.0.113.10" }))).toBe("203.0.113.10");
  });

  it("cliente forja um IP na frente: o proxy acrescenta o real DEPOIS, e o último vale", () => {
    // `1.2.3.4` é o que um `curl -H "X-Forwarded-For: 1.2.3.4"` hostil manda; o
    // Caddy/Traefik da stack acrescenta o endereço REAL de quem se conectou a
    // ele, ao final da lista.
    const forjado = comHeaders({ "x-forwarded-for": "1.2.3.4, 198.51.100.77" });
    expect(ipDoCliente(forjado)).toBe("198.51.100.77");
    expect(ipDoCliente(forjado)).not.toBe("1.2.3.4");
  });

  it("cliente forja uma lista inteira de saltos falsos: só o último (nosso proxy) vale", () => {
    const forjado = comHeaders({
      "x-forwarded-for": "6.6.6.6, 7.7.7.7, 8.8.8.8, 203.0.113.99",
    });
    expect(ipDoCliente(forjado)).toBe("203.0.113.99");
  });

  it("espaços em volta da vírgula não atrapalham", () => {
    expect(ipDoCliente(comHeaders({ "x-forwarded-for": "1.2.3.4 ,  198.51.100.5  " }))).toBe(
      "198.51.100.5",
    );
  });

  it("sem x-forwarded-for, usa x-real-ip (Nginx simples só seta esse)", () => {
    expect(ipDoCliente(comHeaders({ "x-real-ip": "203.0.113.77" }))).toBe("203.0.113.77");
  });

  it("sem nenhum dos dois headers, null, nunca um sentinela que vira balde global", () => {
    expect(ipDoCliente(comHeaders({}))).toBeNull();
  });

  it("TRUSTED_PROXY_COUNT=2: o penúltimo item vale (CDN/WAF + proxy da stack)", () => {
    vi.stubEnv("TRUSTED_PROXY_COUNT", "2");
    // saltos[real, cdn_edge, proxy_da_stack]: quem chega ao app é o proxy da
    // stack; o penúltimo (cdn_edge) é o outro salto confiável configurado.
    const cabecalho = comHeaders({ "x-forwarded-for": "9.9.9.9, 8.8.8.8, 7.7.7.7" });
    expect(ipDoCliente(cabecalho)).toBe("8.8.8.8");
  });

  it("TRUSTED_PROXY_COUNT maior que os saltos presentes: null, nunca adivinha um índice", () => {
    vi.stubEnv("TRUSTED_PROXY_COUNT", "3");
    expect(ipDoCliente(comHeaders({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" }))).toBeNull();
  });

  it("TRUSTED_PROXY_COUNT=0: ignora os dois headers (app sem proxy nenhum na frente)", () => {
    vi.stubEnv("TRUSTED_PROXY_COUNT", "0");
    expect(ipDoCliente(comHeaders({ "x-forwarded-for": "203.0.113.10" }))).toBeNull();
    expect(ipDoCliente(comHeaders({ "x-real-ip": "203.0.113.10" }))).toBeNull();
  });

  it("TRUSTED_PROXY_COUNT inválido volta ao comportamento antigo (primeiro salto)", () => {
    vi.stubEnv("TRUSTED_PROXY_COUNT", "não-é-número");
    expect(ipDoCliente(comHeaders({ "x-forwarded-for": "1.2.3.4, 198.51.100.5" }))).toBe("1.2.3.4");
  });

  it("TRUSTED_PROXY_COUNT negativo volta ao comportamento antigo (primeiro salto)", () => {
    vi.stubEnv("TRUSTED_PROXY_COUNT", "-1");
    expect(ipDoCliente(comHeaders({ "x-forwarded-for": "1.2.3.4, 198.51.100.5" }))).toBe("1.2.3.4");
  });
});

describe("ipDoCliente sem TRUSTED_PROXY_COUNT: comportamento antigo até a instalação declarar os saltos", () => {
  // Produção roda atrás de Cloudflare mais o Traefik da hospedagem: ler o
  // último salto sem saber a conta poria todo mundo no mesmo balde de rate
  // limit (o endereço de borda). Sem a variável, nada muda em relação a antes.
  it("primeiro salto do x-forwarded-for", () => {
    vi.stubEnv("TRUSTED_PROXY_COUNT", "");
    expect(ipDoCliente(comHeaders({ "x-forwarded-for": "203.0.113.4, 198.51.100.5" }))).toBe(
      "203.0.113.4",
    );
  });

  it("sem x-forwarded-for, x-real-ip; sem nenhum, null", () => {
    vi.stubEnv("TRUSTED_PROXY_COUNT", "");
    expect(ipDoCliente(comHeaders({ "x-real-ip": "203.0.113.77" }))).toBe("203.0.113.77");
    expect(ipDoCliente(comHeaders({}))).toBeNull();
  });
});

describe("ipDoClienteParaInet: mesmo salto confiável, com a validação de forma do `inet`", () => {
  beforeEach(() => {
    vi.stubEnv("TRUSTED_PROXY_COUNT", "1");
  });

  it("pega o mesmo salto de trás, não o primeiro forjável", () => {
    const forjado = comHeaders({ "x-forwarded-for": "1.2.3.4, 198.51.100.77" });
    expect(ipDoClienteParaInet(forjado)).toBe("198.51.100.77");
  });

  it("valor inválido para `inet` vira null mesmo vindo do salto confiável", () => {
    const forjado = comHeaders({ "x-forwarded-for": "1.2.3.4, lixo-nao-e-ip" });
    expect(ipDoClienteParaInet(forjado)).toBeNull();
  });
});
