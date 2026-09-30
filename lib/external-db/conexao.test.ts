import dns from "node:dns";
import net from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import { fecharPool, fecharTodosOsPools, obterPool, testarConexao } from "./conexao";
import type { ConexaoExterna } from "./types";

function conexao(over: Partial<ConexaoExterna> = {}): ConexaoExterna {
  return {
    id: "conn-1",
    organizationId: "org-1",
    label: "X",
    host: "localhost",
    port: 5432,
    database: "db",
    username: "u",
    password: "p",
    sslMode: "disable",
    maxRows: 200,
    maxFilters: 20,
    maxResponseBytes: 30_000,
    versao: "2026-09-11T00:00:00.000Z",
    ...over,
  };
}

const IP = "8.8.8.8";

afterEach(async () => {
  await fecharTodosOsPools();
  vi.restoreAllMocks();
});

describe("obterPool — cache e invalidação", () => {
  it("reusa o MESMO pool para a mesma conexão", () => {
    expect(obterPool(conexao(), IP)).toBe(obterPool(conexao(), IP));
  });

  it("recria o pool quando o updated_at muda (credencial editada)", () => {
    const antes = obterPool(conexao(), IP);
    const depois = obterPool(conexao({ versao: "2026-09-12T00:00:00.000Z" }), IP);
    expect(depois).not.toBe(antes);
  });

  it("recria o pool quando o host muda na mesma conexão", () => {
    const antes = obterPool(conexao(), IP);
    const depois = obterPool(conexao({ host: "outro.exemplo.com" }), IP);
    expect(depois).not.toBe(antes);
  });

  it("`fecharPool` descarta o cache — o próximo uso abre outro pool", async () => {
    const antes = obterPool(conexao(), IP);
    await fecharPool("conn-1");
    expect(obterPool(conexao(), IP)).not.toBe(antes);
  });

  it("conexões diferentes têm pools diferentes", () => {
    const a = obterPool(conexao({ id: "a" }), IP);
    const b = obterPool(conexao({ id: "b" }), IP);
    expect(a).not.toBe(b);
  });
});

describe("obterPool: conecta pelo IP validado, nunca pelo nome (D-084, M2)", () => {
  it("o pg recebe host = IP validado; o nome cadastrado não vai para o socket", () => {
    const pool = obterPool(conexao({ host: "banco.exemplo.com" }), IP);
    expect(pool.options.host).toBe(IP);
  });

  it("recria o pool quando o IP validado muda para o mesmo nome (o DNS legítimo mudou)", () => {
    const antes = obterPool(conexao({ host: "banco.exemplo.com" }), "8.8.8.8");
    const depois = obterPool(conexao({ host: "banco.exemplo.com" }), "1.1.1.1");
    expect(depois).not.toBe(antes);
    expect(depois.options.host).toBe("1.1.1.1");
  });

  it.each(["require", "prefer", "verify-ca", "verify-full"] as const)(
    "com TLS (%s) o nome original vai em ssl.servername, para o certificado continuar valendo",
    (sslMode) => {
      const pool = obterPool(conexao({ host: "banco.exemplo.com", sslMode }), IP);
      expect(pool.options.ssl).toMatchObject({ servername: "banco.exemplo.com" });
    },
  );

  it("verify-full continua verificando o certificado", () => {
    const pool = obterPool(conexao({ host: "banco.exemplo.com", sslMode: "verify-full" }), IP);
    expect(pool.options.ssl).toMatchObject({ rejectUnauthorized: true });
  });

  it("sem TLS não há ssl; com host já em IP literal não há servername (Node recusa IP como SNI)", () => {
    expect(obterPool(conexao({ host: "banco.exemplo.com", sslMode: "disable" }), IP).options.ssl).toBe(false);
    const literal = obterPool(conexao({ id: "lit", host: "[2606:4700::1111]", sslMode: "require" }), "2606:4700::1111");
    expect(literal.options.ssl).toEqual({ rejectUnauthorized: false });
  });

  it("o socket vai para o IP validado e nenhuma reconexão do pool resolve o nome de novo", async () => {
    // Um servidor TCP local faz o papel do banco. O nome cadastrado nem existe no
    // DNS (`.invalid`): se o pg tentasse resolvê-lo, a conexão nunca chegaria aqui.
    const chegadas: string[] = [];
    const servidor = net.createServer((socket) => {
      chegadas.push(socket.remoteAddress ?? "");
      socket.destroy();
    });
    await new Promise<void>((resolve) => servidor.listen(0, "127.0.0.1", resolve));
    const porta = (servidor.address() as net.AddressInfo).port;
    const lookup = vi.spyOn(dns, "lookup");

    try {
      const pool = obterPool(conexao({ host: "banco-rebind.invalid", port: porta, sslMode: "disable" }), "127.0.0.1");
      // Cada tentativa abre uma conexão NOVA do pool (o servidor derruba a anterior).
      for (let i = 0; i < 3; i += 1) {
        await expect(pool.query("select 1")).rejects.toBeDefined();
      }
    } finally {
      await new Promise<void>((resolve) => servidor.close(() => resolve()));
    }

    expect(chegadas.length).toBe(3);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("testarConexao também conecta pelo IP validado, sem resolver o nome", async () => {
    let chegou = false;
    const servidor = net.createServer((socket) => {
      chegou = true;
      socket.destroy();
    });
    await new Promise<void>((resolve) => servidor.listen(0, "127.0.0.1", resolve));
    const porta = (servidor.address() as net.AddressInfo).port;
    const lookup = vi.spyOn(dns, "lookup");

    try {
      const r = await testarConexao(conexao({ host: "banco-rebind.invalid", port: porta, sslMode: "disable" }), "127.0.0.1");
      expect(r.ok).toBe(false); // o servidor de mentira derruba o socket
    } finally {
      await new Promise<void>((resolve) => servidor.close(() => resolve()));
    }

    expect(chegou).toBe(true);
    expect(lookup).not.toHaveBeenCalled();
  });
});
