import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// DNS simulado e controlado: o teste não pode depender da rede de quem roda.
const dns = vi.hoisted(() => ({
  respostas: [] as string[][],
  chamadas: 0,
}));
vi.mock("node:dns/promises", () => {
  const lookup = vi.fn(async () => {
    const ips = dns.respostas[Math.min(dns.chamadas, dns.respostas.length - 1)];
    dns.chamadas += 1;
    if (!ips) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
    return ips.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  });
  return { lookup, default: { lookup } };
});

const estado = vi.hoisted(() => ({ host: "banco.cliente.exemplo", sslMode: "require" as string }));
vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: vi.fn(async () => true) }));
vi.mock("./credenciais", () => ({
  carregarConexao: vi.fn(async () => ({
    ok: true,
    conexao: {
      id: "conn-1",
      organizationId: "org-1",
      label: "X",
      host: estado.host,
      port: 5432,
      database: "db",
      username: "u",
      password: "p",
      sslMode: estado.sslMode,
      maxRows: 200,
      maxFilters: 20,
      maxResponseBytes: 30_000,
      versao: "2026-09-11T00:00:00.000Z",
    },
  })),
}));

import { abrirAcesso } from "./acesso";
import { fecharTodosOsPools } from "./conexao";

const admin = {} as SupabaseClient;

beforeEach(() => {
  dns.respostas = [];
  dns.chamadas = 0;
  estado.host = "banco.cliente.exemplo";
  estado.sslMode = "require";
});

afterEach(async () => {
  await fecharTodosOsPools();
});

describe("abrirAcesso: o pool conecta pelo IP que a guarda validou (D-084, M2)", () => {
  it("DNS que muda entre a guarda e o connect: o pool fica preso ao IP validado, e o nome só vai no SNI", async () => {
    // 1ª resolução (a da guarda): público. Da 2ª em diante (a que o pg faria no
    // connect, ou numa reconexão do pool): a rede interna.
    dns.respostas = [["8.8.8.8"], ["10.0.0.5"]];

    const acesso = await abrirAcesso(admin, "org-1", "conn-1");

    expect(acesso.ok).toBe(true);
    if (!acesso.ok) return;
    expect(acesso.pool.options.host).toBe("8.8.8.8");
    expect(acesso.pool.options.ssl).toMatchObject({ servername: "banco.cliente.exemplo" });
    // Uma resolução só: nada depois da guarda resolve o nome outra vez.
    expect(dns.chamadas).toBe(1);
  });

  it("a abertura seguinte revalida: DNS que virou rede interna é recusado", async () => {
    dns.respostas = [["8.8.8.8"], ["10.0.0.5"]];

    const primeira = await abrirAcesso(admin, "org-1", "conn-1");
    expect(primeira.ok).toBe(true);
    const segunda = await abrirAcesso(admin, "org-1", "conn-1");

    expect(segunda).toEqual({ ok: false, motivo: "host_bloqueado" });
  });

  it("DNS legítimo que muda para outro IP público: a próxima abertura usa o IP novo, não o do pool antigo", async () => {
    dns.respostas = [["8.8.8.8"], ["1.1.1.1"]];

    const primeira = await abrirAcesso(admin, "org-1", "conn-1");
    const segunda = await abrirAcesso(admin, "org-1", "conn-1");

    expect(primeira.ok && primeira.pool.options.host).toBe("8.8.8.8");
    expect(segunda.ok && segunda.pool.options.host).toBe("1.1.1.1");
  });
});

describe("abrirAcesso: recusa igual para o cliente, motivo real só no log (D-084, M3)", () => {
  it("nome que não resolve e nome que resolve para a rede interna dão a MESMA resposta", async () => {
    dns.respostas = []; // ENOTFOUND
    const naoResolve = await abrirAcesso(admin, "org-1", "conn-1");

    dns.chamadas = 0;
    dns.respostas = [["10.1.2.3"]];
    const redeInterna = await abrirAcesso(admin, "org-1", "conn-1");

    expect(naoResolve).toEqual({ ok: false, motivo: "host_bloqueado" });
    expect(redeInterna).toEqual(naoResolve);
  });
});

describe("abrirAcesso: rede privada (RFC1918) nunca abre para o banco da organização (D-084, M1)", () => {
  it.each(["10.0.0.7", "10.1.2.3", "172.16.5.5", "192.168.0.10"])("IP literal %s é recusado", async (ip) => {
    estado.host = ip;
    expect(await abrirAcesso(admin, "org-1", "conn-1")).toEqual({ ok: false, motivo: "host_bloqueado" });
  });

  it("nada em lib/external-db nem nas rotas do banco externo importa a lista de destinos internos da instalação", () => {
    const raiz = process.cwd();
    const arquivos: string[] = [];
    const varre = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const caminho = join(dir, e.name);
        if (e.isDirectory()) varre(caminho);
        else if (/\.tsx?$/.test(e.name) && !e.name.endsWith(".test.ts")) arquivos.push(caminho);
      }
    };
    varre(join(raiz, "lib/external-db"));
    varre(join(raiz, "app/api/v1/external-db"));

    const usam = arquivos.filter((a) => /destinos-internos-autorizados/.test(readFileSync(a, "utf8")));
    // Só o comentário de guardas.ts, que cita a regra 2, pode nomear o arquivo.
    expect(usam.map((a) => a.replace(raiz, "")).filter((a) => !a.endsWith("guardas.ts"))).toEqual([]);
    for (const a of usam) {
      expect(readFileSync(a, "utf8")).not.toMatch(/from ["'][^"']*destinos-internos-autorizados["']/);
    }
  });
});
