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

/** A lista de destinos internos da instalação, já no formato que a guarda recebe. */
const faixa = (base: number[], prefixo: number) => ({
  base: base.reduce((acc, o) => acc * 256 + o, 0),
  mascara: prefixo === 0 ? 0 : (0xffffffff << (32 - prefixo)) >>> 0,
});
const LISTA_10_1 = [faixa([10, 1, 0, 0], 16)];

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
    // RFC1918: bloqueada para destino de organização, salvo lista autorizada.
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

  it("recusa IP de LAN (10.x, 172.16.x, 192.168.x) quando a instalação não autorizou nada", async () => {
    for (const ip of ["10.0.0.7", "172.16.5.5", "192.168.0.10"]) {
      await expect(validarHostDeBanco(ip)).resolves.toEqual({ ok: false, motivo: "ip_especial" });
    }
    // Lista vazia é o mesmo que ausente.
    await expect(validarHostDeBanco("10.0.0.7", [])).resolves.toEqual({ ok: false, motivo: "ip_especial" });
  });

  it("aceita o IP de LAN que a lista da instalação cobre, e só ele", async () => {
    await expect(validarHostDeBanco("10.1.2.3", LISTA_10_1)).resolves.toEqual({
      ok: true,
      enderecos: ["10.1.2.3"],
    });
    // Fora da faixa autorizada segue recusado, inclusive dentro de 10/8.
    await expect(validarHostDeBanco("10.2.0.1", LISTA_10_1)).resolves.toEqual({
      ok: false,
      motivo: "ip_especial",
    });
    await expect(validarHostDeBanco("172.16.5.5", LISTA_10_1)).resolves.toEqual({
      ok: false,
      motivo: "ip_especial",
    });
  });

  it("a lista NÃO abre o que nunca é banco: metadata de nuvem, loopback e CGNAT seguem bloqueados", async () => {
    const tudo = [faixa([0, 0, 0, 0], 0)];
    for (const ip of ["169.254.169.254", "127.0.0.1", "100.64.0.1", "::1"]) {
      await expect(validarHostDeBanco(ip, tudo)).resolves.toEqual({ ok: false, motivo: "ip_especial" });
    }
  });

  it("IPv4 privado escondido em IPv6 mapeado também depende da lista", async () => {
    await expect(validarHostDeBanco("[::ffff:10.1.2.3]")).resolves.toEqual({
      ok: false,
      motivo: "ip_especial",
    });
    await expect(validarHostDeBanco("[::ffff:10.1.2.3]", LISTA_10_1)).resolves.toMatchObject({ ok: true });
    await expect(validarHostDeBanco("[::ffff:10.9.9.9]", LISTA_10_1)).resolves.toEqual({
      ok: false,
      motivo: "ip_especial",
    });
  });

  it("nome que resolve para IP privado: recusa sem lista, passa com a faixa cobrindo o IP resolvido", async () => {
    await expect(validarHostDeBanco("banco.lan.exemplo")).resolves.toEqual({
      ok: false,
      motivo: "ip_especial",
    });
    await expect(validarHostDeBanco("banco.lan.exemplo", LISTA_10_1)).resolves.toEqual({
      ok: true,
      enderecos: ["10.1.2.3"],
    });
    // Meia resolução (um IP coberto, outro não) é a assinatura do rebinding.
    dns.mapa["banco.lan.exemplo"] = ["10.1.2.3", "10.9.9.9"];
    try {
      await expect(validarHostDeBanco("banco.lan.exemplo", LISTA_10_1)).resolves.toEqual({
        ok: false,
        motivo: "ip_especial",
      });
    } finally {
      dns.mapa["banco.lan.exemplo"] = ["10.1.2.3"];
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
