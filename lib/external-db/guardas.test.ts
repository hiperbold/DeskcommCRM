import { describe, expect, it, vi } from "vitest";

import { ipDeBancoProibido, validarHostDeBanco } from "./guardas";

// O DNS é controlado aqui: o teste não pode depender da rede de quem roda.
// `localhost` é loopback, `.invalid` nunca resolve (RFC 2606) e o resto vem do
// mapa (`banco.lan.exemplo` é um nome público que resolve para IP privado).
const dns = vi.hoisted(() => ({
  mapa: { localhost: ["127.0.0.1"], "banco.lan.exemplo": ["10.1.2.3"] } as Record<string, string[]>,
}));
vi.mock("node:dns/promises", () => {
  const lookup = vi.fn(async (nome: string) => {
    const ips = dns.mapa[nome];
    if (!ips) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
    return ips.map((address) => ({ address, family: 4 }));
  });
  return { lookup, default: { lookup } };
});

describe("ipDeBancoProibido", () => {
  it.each([
    "169.254.169.254", // metadata de nuvem
    "127.0.0.1",
    "127.10.20.30",
    "0.0.0.0",
    "100.64.0.1", // CGNAT
    "192.0.2.10", // TEST-NET
    "198.18.0.5", // benchmark
    "203.0.113.9", // TEST-NET
    "224.0.0.1", // multicast
    "240.0.0.1", // reservada
    "::1",
    "::",
    "fe80::1",
    "fc00::1",
    "ff02::1",
    "2001:db8::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1", // IPv4-mapeado em hex — MESMO loopback que 127.0.0.1
    "::127.0.0.1", // IPv4-compatível (legado)
    "0:0:0:0:0:0:0:1", // loopback expandido
    "0000:0000:0000:0000:0000:0000:0000:0001", // loopback expandido
    "0:0:0:0:0:0:0:0", // :: expandido
    "64:ff9b::192.168.1.1", // NAT64 apontando para LAN
    // RFC1918: sempre bloqueada para destino de organização (D-084, M1).
    "10.1.2.3",
    "10.255.255.255",
    "172.16.5.5",
    "172.31.0.1",
    "192.168.0.10",
    "::ffff:10.1.2.3", // IPv4-mapeado que esconde 10/8
    "::10.1.2.3", // IPv4-compatível que esconde 10/8
  ])("bloqueia %s", (ip) => {
    expect(ipDeBancoProibido(ip)).toBe(true);
  });

  it.each([
    "8.8.8.8",
    "1.1.1.1",
    "172.15.255.255", // logo abaixo de 172.16/12: público
    "172.32.0.1", // logo acima de 172.16/12: público
    "2606:4700:4700::1111",
    "::ffff:8.8.8.8", // IPv4-mapeado público não é bloqueado por tabela
  ])("permite %s", (ip) => {
    expect(ipDeBancoProibido(ip)).toBe(false);
  });

  it("recusa o que não se sabe julgar", () => {
    expect(ipDeBancoProibido("nao-e-ip")).toBe(true);
    expect(ipDeBancoProibido("999.1.1.1")).toBe(true);
  });
});

describe("validarHostDeBanco", () => {
  it("recusa host vazio, com barra ou com espaço", async () => {
    await expect(validarHostDeBanco("")).resolves.toEqual({ ok: false, motivo: "host_invalido" });
    await expect(validarHostDeBanco("db.local/path")).resolves.toEqual({
      ok: false,
      motivo: "host_invalido",
    });
    await expect(validarHostDeBanco("db local")).resolves.toEqual({
      ok: false,
      motivo: "host_invalido",
    });
  });

  it("recusa literal de IP proibido", async () => {
    await expect(validarHostDeBanco("169.254.169.254")).resolves.toEqual({
      ok: false,
      motivo: "ip_especial",
    });
  });

  it("aceita literal de IP público", async () => {
    await expect(validarHostDeBanco("8.8.8.8")).resolves.toEqual({ ok: true, enderecos: ["8.8.8.8"] });
  });

  it("recusa IP de LAN (10.x, 172.16.x, 192.168.x), sempre", async () => {
    for (const ip of ["10.0.0.7", "10.1.2.3", "172.16.5.5", "192.168.0.10"]) {
      await expect(validarHostDeBanco(ip)).resolves.toEqual({ ok: false, motivo: "ip_especial" });
    }
  });

  it("a guarda não tem porta de entrada para lista de destinos internos da instalação", async () => {
    // A lista só vale para destino da INSTALAÇÃO; o banco externo é escolhido por
    // organização. Mesmo que alguém passe um segundo argumento (JS, cast), o IP
    // privado segue recusado: a assinatura ignora qualquer lista.
    const tudo = { base: 0, mascara: 0 };
    const comLista = validarHostDeBanco as unknown as (h: string, lista: unknown[]) => ReturnType<typeof validarHostDeBanco>;
    await expect(comLista("10.1.2.3", [tudo])).resolves.toEqual({ ok: false, motivo: "ip_especial" });
    const ipComLista = ipDeBancoProibido as unknown as (ip: string, lista: unknown[]) => boolean;
    expect(ipComLista("10.1.2.3", [tudo])).toBe(true);
    expect(validarHostDeBanco.length).toBe(1);
    expect(ipDeBancoProibido.length).toBe(1);
  });

  it("metadata de nuvem, loopback e CGNAT seguem bloqueados", async () => {
    for (const ip of ["169.254.169.254", "127.0.0.1", "100.64.0.1", "::1"]) {
      await expect(validarHostDeBanco(ip)).resolves.toEqual({ ok: false, motivo: "ip_especial" });
    }
  });

  it("IPv4 privado escondido em IPv6 mapeado também é recusado", async () => {
    for (const ip of ["[::ffff:10.1.2.3]", "[::ffff:10.9.9.9]", "[::ffff:192.168.0.1]"]) {
      await expect(validarHostDeBanco(ip)).resolves.toEqual({ ok: false, motivo: "ip_especial" });
    }
  });

  it("nome que resolve para IP privado é recusado, inclusive com meia resolução (assinatura do rebinding)", async () => {
    await expect(validarHostDeBanco("banco.lan.exemplo")).resolves.toEqual({
      ok: false,
      motivo: "ip_especial",
    });
    dns.mapa["banco.lan.exemplo"] = ["8.8.8.8", "10.9.9.9"];
    try {
      await expect(validarHostDeBanco("banco.lan.exemplo")).resolves.toEqual({
        ok: false,
        motivo: "ip_especial",
      });
    } finally {
      dns.mapa["banco.lan.exemplo"] = ["10.1.2.3"];
    }
  });

  it("nome público devolve os endereços validados, que é onde quem conecta deve se prender", async () => {
    dns.mapa["banco.publico.exemplo"] = ["8.8.8.8", "1.1.1.1"];
    try {
      await expect(validarHostDeBanco("banco.publico.exemplo")).resolves.toEqual({
        ok: true,
        enderecos: ["8.8.8.8", "1.1.1.1"],
      });
    } finally {
      delete dns.mapa["banco.publico.exemplo"];
    }
  });

  it("aceita IPv6 literal entre colchetes", async () => {
    await expect(validarHostDeBanco("[2606:4700::1111]")).resolves.toEqual({
      ok: true,
      enderecos: ["2606:4700::1111"],
    });
  });

  it("resolve hostname e recusa quando cai em IP proibido (localhost)", async () => {
    const r = await validarHostDeBanco("localhost");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toBe("ip_especial");
  });

  it("falha fechado quando o DNS não resolve", async () => {
    // `.invalid` é reservado por RFC 2606 e nunca resolve (e o mock também não).
    await expect(validarHostDeBanco("db.invalid")).resolves.toEqual({
      ok: false,
      motivo: "dns_falhou",
    });
  });
});
