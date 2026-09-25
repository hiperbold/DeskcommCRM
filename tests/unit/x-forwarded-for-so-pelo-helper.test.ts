import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * D-036: o repositório lia `x-forwarded-for` inline em vários lugares
 * (`headers.get("x-forwarded-for")?.split(",")[0]?.trim()`), e esse é
 * exatamente o defeito, o PRIMEIRO salto é o que o CLIENTE escreve, e
 * qualquer um pode forjar `curl -H "X-Forwarded-For: 1.2.3.4"`. Atrás do
 * proxy desta instalação, o valor bom é o ÚLTIMO salto (ou o
 * `TRUSTED_PROXY_COUNT`-ésimo a partir do fim), que é o que `ipDoCliente`/
 * `ipDoClienteParaInet` calculam, ver `lib/http/ip-do-cliente.ts`.
 *
 * Esta cerca varre o código que a imagem embarca e falha se QUALQUER arquivo
 * fora do próprio helper voltar a ler o cabeçalho na mão: é o jeito de o
 * defeito não voltar arquivo por arquivo.
 */

const RAIZ = process.cwd();

/** Só o helper pode ler o cabeçalho cru, é o próprio código que o implementa. */
const PERMITIDOS = new Set(["lib/http/ip-do-cliente.ts"]);

/** Raízes que a imagem de produção embarca (mesmo universo de `docker/`, ver Dockerfile). */
const RAIZES_VARRIDAS = ["app", "lib", "workers"];

const LEITURA_CRUA = /\.get\(\s*["']x-forwarded-for["']\s*\)/i;

function arquivosVarridos(dir: string): string[] {
  const absoluto = path.join(RAIZ, dir);
  if (!fs.existsSync(absoluto)) return [];
  const alvos: string[] = [];
  for (const entrada of fs.readdirSync(absoluto, { withFileTypes: true })) {
    const rel = path.posix.join(dir, entrada.name);
    if (entrada.isDirectory()) {
      if (entrada.name === "node_modules" || entrada.name === ".next") continue;
      alvos.push(...arquivosVarridos(rel));
      continue;
    }
    if (!rel.endsWith(".ts") && !rel.endsWith(".tsx")) continue;
    alvos.push(rel);
  }
  return alvos;
}

describe("x-forwarded-for só pelo helper", () => {
  const porRaiz = new Map(RAIZES_VARRIDAS.map((r) => [r, arquivosVarridos(r)]));
  const alvos = [...porRaiz.values()].flat();

  it("a varredura alcança as raízes, senão o resto não prova nada", () => {
    for (const [raiz, arquivos] of porRaiz) {
      expect(arquivos.length, `${raiz}/ não devolveu arquivo nenhum`).toBeGreaterThan(0);
    }
    expect(alvos.length).toBeGreaterThan(500);
  });

  it("nenhum arquivo fora de lib/http/ip-do-cliente.ts lê x-forwarded-for na mão", () => {
    const achados: string[] = [];
    for (const arquivo of alvos) {
      if (PERMITIDOS.has(arquivo)) continue;
      const conteudo = fs.readFileSync(path.join(RAIZ, arquivo), "utf8");
      if (LEITURA_CRUA.test(conteudo)) achados.push(arquivo);
    }
    expect(
      achados,
      "Leia o IP por `ipDoCliente`/`ipDoClienteParaInet` de `lib/http/ip-do-cliente.ts` " +
        "(D-036): o primeiro salto do x-forwarded-for é forjável pelo cliente.",
    ).toEqual([]);
  });
});
